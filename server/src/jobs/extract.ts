import { and, desc, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { validateDraft } from "@haii/schema";
import { db, schema } from "../db";
import { env } from "../env";
import { log } from "../log";
import { apiKey, budgetGate, costOf, llmJson, MODELS, recordLedger } from "../lib/llm";
import { tgSend, escapeHtml, opsNotify } from "../lib/telegram";
import { userTz, dateTimeInTz, dayKeyInTz, hhmmInTz } from "../lib/tz";
import { nextWorkdayStart, earliestProposalMs, startHasPassed } from "../lib/slot";
import { approvalSignal, notSimulated, quoteVerdict } from "../lib/metrics";
import { resolveAttendeeEmails, findOpenSlot } from "../lib/schedule";
import { resolveBriefMeetingId } from "../lib/batch";
import { listMemories, formatMemories, applyMemoryWrites } from "../lib/memory";
import { selectMemories } from "../lib/memorySelect";
import { unexpectedRecipients } from "../lib/recipients";
import { buildManifest, src, type ManifestEntry } from "../lib/manifest";
import { runJob } from "./run";
// The same version jobs/briefing.ts stamps, because briefBatch builds its requests through
// buildBriefingRequest there. A batch brief is written by that prompt and must say so.
import { BRIEFING_PROMPT_VERSION as BRIEFING_PROMPT_VERSION_FOR_BATCH } from "../prompts/briefing.v005";
import { cleanTranscript, cleanTranscriptDetailed, MIN_TRANSCRIPT_CHARS } from "../lib/transcript";
import {
  EXTRACT_PROMPT_VERSION,
  EXTRACT_SCHEMA,
  EXTRACT_STABLE,
  extractVariable,
  extractUser,
} from "../prompts/extract.v011";

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Trailing-20 approval rate per action_type, from this user's decided cards' feedback. */
export async function approvalStats(userId: string): Promise<Record<string, { rate: number; n: number }>> {
  const decided = await db
    .select({ actionType: schema.cards.actionType, feedback: schema.cards.feedback })
    .from(schema.cards)
    // notSimulated: a tutorial decision must never trip the suppression rule below.
    .where(and(eq(schema.cards.userId, userId), isNotNull(schema.cards.feedback), notSimulated))
    .orderBy(desc(schema.cards.decidedAt))
    .limit(120);
  const byType: Record<string, { approved: number; n: number }> = {};
  for (const c of decided) {
    // "Later" leaves the denominator entirely: it means the card was right and the timing was not,
    // so counting it against the type taught the model to stop proposing things the user wanted.
    // See approvalSignal in lib/metrics.ts.
    const signal = approvalSignal(c.feedback);
    if (signal === "ignore") continue;
    const t = (byType[c.actionType] ??= { approved: 0, n: 0 });
    if (t.n >= 20) continue;
    t.n++;
    if (signal === "approved") t.approved++;
  }
  const out: Record<string, { rate: number; n: number }> = {};
  for (const [k, v] of Object.entries(byType)) out[k] = { rate: v.n ? v.approved / v.n : 1, n: v.n };
  return out;
}

/** The dismiss chips, in the vocabulary the prompt explains. `later` is deliberately absent: it is
 *  dropped entirely rather than labelled, see below. */
const DISMISS_LABEL: Record<string, string> = {
  not_committed: "nobody committed to this",
  not_mine: "not mine",
  already_done: "already handled",
  too_small: "not worth an action",
  // A free-text dismissal. Terse on purpose: the note itself is not rendered into this line, so
  // anything more specific here would tell the model something the user did not actually say.
  other: "other",
  // No longer offered by the UI, kept because cards dismissed under it may still be in the
  // exemplar window and an unmapped key renders as no reason at all.
  wrong: "wrong",
};

/** Exemplar block: this user's last 10 decided cards with decisions, dismiss reasons and edit diffs.
 *
 *  The reason is the point of this function. It used to render "dismissed · create_todo · title" and
 *  throw the reason away, so the model saw a rejection and could not tell which of three unrelated
 *  mistakes it had made. They need opposite corrections: `wrong` means this kind of card should not
 *  have been proposed, while `not_mine` means the action was real and the attribution rule was
 *  misapplied, so the fix is whose commitment it is, not whether to propose it at all. Collapsing
 *  them taught "propose fewer" for both.
 *
 *  `later` is excluded rather than shown. It is not taste, it is timing: the card was right and the
 *  moment was not. lib/metrics.ts already drops it from the approval rate for exactly this reason,
 *  and showing it here as a rejection would reintroduce that same bug one layer up, teaching the
 *  model to stop proposing things the user actually wanted. approvalSignal is reused rather than
 *  re-tested against `reason` so the two places cannot drift apart.
 *
 *  Over-fetches because the filter runs after the query: a run of deferrals would otherwise eat the
 *  window and leave the model with two exemplars. */
async function exemplars(userId: string): Promise<string> {
  const decided = await db
    .select()
    .from(schema.cards)
    // notSimulated: a tutorial decision must never teach the model a taste exemplar.
    .where(and(eq(schema.cards.userId, userId), isNotNull(schema.cards.feedback), notSimulated))
    .orderBy(desc(schema.cards.decidedAt))
    .limit(30);
  const lines: string[] = [];
  for (const c of decided) {
    if (lines.length >= 10) break;
    const fb = c.feedback as any;
    if (approvalSignal(fb) === "ignore") continue;
    const diff = fb?.edit_diff?.length ? ` (edited: ${fb.edit_diff.join(", ")})` : "";
    const label = DISMISS_LABEL[String(fb?.reason ?? "")];
    const why = fb?.decision === "dismissed" && label ? ` (${label})` : "";
    lines.push(`${fb?.decision ?? "?"}${why} · ${c.actionType} · "${c.title}"${diff}`);
  }
  return lines.join("\n");
}

/** Assembles everything the LLM call needs from a users row and a transcripts row: meeting line,
 *  open cards, approval stats, exemplars, suppression block, then the system/user prompt pair.
 *  Shared by the sync path (runExtract) and the batch submission path (extractPending) so
 *  both build the identical request. `user` can be undefined (defensive: a transcript row could
 *  in principle outlive its users row); tr.userId is always the correct scoping id either way,
 *  since transcripts are only ever fetched already scoped to the caller's userId. */
export async function buildExtractRequest(
  user: typeof schema.users.$inferSelect | undefined,
  tr: typeof schema.transcripts.$inferSelect,
  cleaned: string,
): Promise<{
  /** Split so the stable half can be cached across every user. See prompts/extract.v009. */
  system: { stable: string; variable: string };
  user: string;
  maxTokens: number;
  manifest: ManifestEntry[];
}> {
  const userId = user?.id ?? tr.userId;
  const name = user?.name || userId;
  // The two onboarding answers reach the model through the EXISTING role slot rather than a new
  // prompt parameter. The versioned template is untouched, so this needs no version bump, and the
  // prompt harness still shows the assembled difference. Without this the questions were writing
  // to columns nothing ever read: we asked the user what they own and then threw it away.
  const persona = [
    user?.role || "",
    user?.owns ? `Owns ${user.owns}.` : "",
    Array.isArray(user?.catches) && user.catches.length
      ? `Most wants caught: ${(user.catches as string[]).join("; ")}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const role = persona;

  let meetingLine = "";
  // Kept separately from the rendered line because memory retrieval scores against the PEOPLE in
  // the room, and re-parsing them back out of a formatted sentence would be the kind of thing that
  // breaks silently the next time the sentence changes.
  let attendeeNames: string[] = [];
  if (tr.meetingId) {
    const m = await db
      .select()
      .from(schema.meetings)
      .where(and(eq(schema.meetings.id, tr.meetingId), eq(schema.meetings.userId, userId)));
    if (m[0]) {
      attendeeNames = ((m[0].attendees as any[]) ?? []).map((a) => a.name || a.email).filter(Boolean);
      const att = attendeeNames.join(", ");
      meetingLine = `${m[0].title} · ${dateTimeInTz(userTz(user?.tz), m[0].startsAt)} · attendees: ${att}`;
    }
  }

  const open = await db
    // id joins the select for the manifest, not for the prompt: the model still only sees the type
    // and the title, and a card title is content that could reach a draft, so it is provenance.
    .select({ id: schema.cards.id, title: schema.cards.title, actionType: schema.cards.actionType })
    .from(schema.cards)
    .where(and(eq(schema.cards.userId, userId), inArray(schema.cards.status, ["proposed", "approved", "executing"])))
    .limit(15);
  const stats = await approvalStats(userId);
  const suppression = Object.entries(stats)
    .filter(([, s]) => s.n >= 5 && s.rate < 0.2)
    .map(
      ([t, s]) =>
        `${name} approves only ${(s.rate * 100).toFixed(0)}% of ${t} cards. Propose one only when confidence >= 0.8.`,
    )
    .join("\n");

  const userPrompt = extractUser({
    selfName: name,
    transcriptTitle: tr.title,
    transcript: cleaned,
    meeting: meetingLine,
    openCards: open.map((c) => `${c.actionType}: ${c.title}`).join("\n"),
    exemplars: await exemplars(userId),
    suppression,
    // In the USER's zone, not the server's. The server runs UTC by design, so a transcript
    // extracted at 01:00 for a user at UTC+3 (22:00 the previous evening in UTC) would otherwise be
    // told it is still yesterday, and every relative date in it would land a day early.
    today: dayKeyInTz(userTz(user?.tz)),
  });

  // Memory rides in the VARIABLE half of the system prompt, not the cacheable prefix. It used to
  // sit in the cached block, which is a large part of why the cache never read: forty facts unique
  // to one person made every user's prefix different. See extract.v009.
  const all = await listMemories(userId);
  // RETRIEVAL. Every fact used to go into every prompt, so a call about pricing carried the user's
  // preferences about unrelated topics. Twelve relevant facts beat
  // forty indiscriminate ones, and it is also the only thing that lets the corpus grow past what
  // fits in one prompt. Standing preferences (naming nobody) always survive; see lib/memorySelect.
  const memories = selectMemories(all, {
    title: tr.title,
    attendees: attendeeNames,
    transcript: cleaned,
  });
  const memoryBlock = formatMemories(memories);
  // THE MANIFEST. What went into this prompt, in the order it carries weight.
  //
  // This function once returned only strings, so the moment a prompt was assembled there was
  // no record of which rows produced it and provenance was unrecoverable rather than merely
  // unrecorded. This is the keystone: the executor gate, provenance
  // chips and connector privacy filters are all blocked on there being one list to read.
  //
  // The transcript is first because it is the substance; everything after it is metadata the model
  // also saw, and a card title or a memory is content that could reach a draft, so it counts.
  const manifest = buildManifest([
    src("transcript", tr.id, tr.source ?? undefined),
    src("meeting", tr.meetingId),
    ...open.map((c) => src("card", c.id)),
    // The SELECTED memories, never the whole corpus. The manifest is the record of what the model
    // actually saw, so listing facts that were filtered out would make every downstream question
    // ("did memory change this card") unanswerable in the wrong direction.
    ...memories.map((m) => src("memory", String(m.id))),
  ]);
  // SPLIT, so every user shares one cached prefix. The stable half is a module constant and never
  // varies; the variable half is the only place a name appears.
  return {
    system: { stable: EXTRACT_STABLE, variable: extractVariable(name, role, memoryBlock) },
    user: userPrompt,
    maxTokens: 6000,
    manifest,
  };
}

/** Card-insertion side effects shared by the sync and batch extraction paths: validates each
 *  draft (up to 7), applies the approval-rate suppression rule, inserts cards, marks the
 *  transcript extracted, pushes a Telegram nudge. Deliberately has NO "already extracted" guard
 *  (runExtract's guard covers the sync path; the batch path sets extracted_at at submission time,
 *  before results ever arrive, so refusing here would silently drop every batched result) and
 *  writes NO ledger row (sync billing happens inside llmJson; batch billing is the poller's job,
 *  at the 0.5x batch discount). */
async function applyExtractResult(
  userId: string,
  tr: typeof schema.transcripts.$inferSelect,
  data: any,
  servedModel: string,
  extraCaveat?: string,
  /** What the model was shown, from buildExtractRequest. Optional because the BATCH path applies
   *  results long after the request was built and does not carry it; that path falls back to the
   *  transcript and meeting below, which is the substance of what any extraction sees. Marked as
   *  reconstructed rather than silently passed off as the real thing. */
  manifest?: ManifestEntry[],
): Promise<{ inserted: number; titles: string[]; dropped: number; strippedQuotes: number }> {
  // Recomputed here rather than threaded through from buildExtractRequest: approval stats can
  // shift in the gap between batch submission and result apply, and the fresher read is correct.
  const stats = await approvalStats(userId);
  const urow = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
  // Who was in the room. Being on the call is the strongest signal that a recipient is EXPECTED,
  // and it is what stops the injection warning below firing on the ordinary case of emailing the
  // client you just spoke to. A warning that cries wolf on normal work is learned away in a week.
  let roomEmails: string[] = [];
  if (tr.meetingId) {
    const mrow = (await db
      .select({ attendees: schema.meetings.attendees })
      .from(schema.meetings)
      .where(and(eq(schema.meetings.id, tr.meetingId), eq(schema.meetings.userId, userId))))[0];
    roomEmails = ((mrow?.attendees as any[]) ?? []).map((a) => a?.email).filter(Boolean);
  }
  // Every card from this extraction carries the same manifest, because they came from the same
  // prompt. Stored on the card rather than beside it so the executor gate has it at approval time
  // without a second lookup, and so a card that is exported or inspected carries its own provenance.
  const cardManifest = manifest ?? buildManifest([
    src("transcript", tr.id, tr.source ?? undefined),
    src("meeting", tr.meetingId),
  ]);
  // Memory writes ride along with the cards in the same structured response, so they cost no extra
  // API call. Applied before the cards so a fact learned here is available to the next extraction
  // even if card insertion below hits a validation problem.
  //
  // Slack transcripts carry other people's messages as background. The evidence guard in
  // jobs/slackListen.ts only protects cards, so memory is not written from them.
  if (tr.source !== "slack") {
    try {
      const n = await applyMemoryWrites(userId, data?.memory_writes);
      if (n) log.info({ userId, n }, "memory writes applied");
    } catch (e: any) {
      log.warn({ err: String(e?.message ?? e) }, "memory writes failed");
    }
  }
  const drafts: unknown[] = Array.isArray(data?.cards) ? data.cards : [];
  let inserted = 0;
  let dropped = 0;
  let strippedQuotes = 0;
  const titles: string[] = [];
  // The text the model was given, which is the only fair thing to check its quotes against.
  const source = cleanTranscript(tr.contentMd);
  for (const raw of drafts.slice(0, 7)) {
    const v = validateDraft(raw);
    if (!v.ok) {
      log.warn({ err: v.error }, "extraction draft rejected");
      continue;
    }
    const d = v.draft;
    const stat = stats[d.action_type];
    if (stat && stat.n >= 5 && stat.rate < 0.2 && d.confidence < 0.8) {
      log.info({ type: d.action_type }, "draft suppressed by approval-rate rule");
      continue;
    }
    // THE EVIDENCE GUARD. It once existed only on the Slack path, so every card from a meeting
    // transcript, which is almost all of them, was inserted with whatever quote the model returned
    // and nothing checked it. That let quotes that were not in the source reach the user. Not a
    // measurement artefact, just an unguarded door.
    //
    // The whole trust claim is that every card carries a verbatim quote. A card whose evidence was
    // invented is worse than a wrong card, because the thing that makes the product believable is
    // the thing that lied. So a draft whose quotes are not in the transcript does not get softened
    // or flagged, it does not get made.
    //
    // Reuses quoteFidelity so the guard and the metric cannot drift: one definition of "found",
    // one normalisation, one 12-character floor. `checked` excludes fragments too short to verify,
    // and a draft with only such fragments is let through rather than judged on nothing.
    // Strip the bad QUOTE, keep the card. Dropping the whole card was the first version of this
    // and it was too blunt: a card-level rule would have discarded output where the action was
    // right and only the quote had drifted. Extraction is the core of this product, and
    // provenance is not worth paying for with it.
    //
    // The guarantee is identical either way: no quote a user can see is unverifiable. The card
    // only dies when NOTHING survives, because a card with no evidence violates the promise the
    // card exists to make (and evidence.min(1) in the draft schema says the same).
    //
    // Deliberately unlike the Slack guard, which drops the whole card. That one defends against
    // prompt injection from other people's messages, where the card itself is the hostile artifact.
    // A meeting transcript is the user's own meeting: a loose quote is a quality problem, not an
    // attack.
    const kept = (d.evidence ?? []).filter((e) => quoteVerdict(e.text, source) !== "missing");
    const lost = (d.evidence ?? []).length - kept.length;
    if (!kept.length) {
      dropped++;
      log.warn({ type: d.action_type, title: d.title }, "draft dropped: no evidence survived the check");
      continue;
    }
    if (lost) {
      strippedQuotes += lost;
      log.info({ type: d.action_type, title: d.title, lost }, "quote stripped: not verbatim in the transcript");
    }
    d.evidence = kept;
    // v2 scheduling: for a calendar card, resolve attendee names to real emails and propose an
    // open slot across everyone's free/busy, so the card shows a real invitee list and a real
    // open time BEFORE the swipe. Best-effort: any failure (no scope, API down) leaves the
    // model's guessed time and attendee names intact rather than dropping the card.
    let scheduling: Record<string, unknown> | null = null;
    if (d.action_type === "create_calendar_event") {
      // Stamp the zone BEFORE the best-effort block, and never inside it. The payload carries a
      // bare wall clock, so without a zone the executor has to resolve it against users.tz at
      // APPROVAL time, and cards live 7 days: a user who sets a meeting at "Thu 14:00" in one time
      // zone and approves it after flying to another gets 14:00 in the NEW zone from Google. As many
      // hours out as the two zones are apart, silently, with the card reading the same both
      // times. The live zone is right for display and wrong for a commitment already made.
      //
      // This is correctness, not enrichment, which is why it sits outside the try. Everything the
      // try adds is optional; the zone is not, and a thrown resolveAttendeeEmails must not be able
      // to produce an unstamped card.
      const tz = userTz(urow?.tz);
      scheduling = { tz };
      const pay = d.payload as Record<string, any>;
      const askedFor = `${pay.date ?? ""} ${pay.time ?? ""}`.trim();
      // WHERE THE SEARCH STARTS, which is the whole of what the model's date is now for.
      //
      // Date and time may be empty, because demanding them killed every card for a meeting
      // nobody put a clock time on. What survives of the model's date is a HINT: "next
      // Tuesday" pins the earliest day worth proposing, and findOpenSlot picks the actual hour from
      // free/busy, as it always did.
      //
      // With no hint at all the search starts TOMORROW, not now. The rule: a commitment nobody
      // timed should not land in ninety minutes, and same-day is the one
      // outcome the user cannot rescue by editing the card, because by the time they read it the
      // slot may have passed.
      // The floor lives in lib/slot.ts so the rule is testable; this function is not. The first
      // version of it was inlined here and had two bugs that only review caught: a past date fed
      // straight through (proposing a meeting last month) and, through findOpenSlot's own
      // now+10min clamp, silently collapsing to today. Both are asserted there now.
      //
      // timeWasStated carries the qualifier in that rule: no same day IF THERE IS NO CLUE ABOUT
      // TIME. "Let's talk at 4 today" is two people agreeing out loud and is not dragged forward.
      const notBefore = earliestProposalMs(tz, String(pay.date ?? ""), {
        timeWasStated: /^\d{1,2}:\d{2}$/.test(String(pay.time ?? "").trim()),
      });
      let slot: { date: string; time: string } | null = null;
      try {
        const { emails, unresolved } = await resolveAttendeeEmails(
          userId,
          String(pay.attendees ?? ""),
          tr.meetingId,
        );
        if (emails.length) pay.attendees = emails.join(", ");
        const selfEmail = urow?.email ?? "";
        if (selfEmail) {
          slot = await findOpenSlot(userId, {
            tz,
            durationMin: Number(pay.duration_min) || 30,
            selfEmail,
            attendeeEmails: emails,
            notBefore,
          });
          if (slot) {
            pay.date = slot.date;
            pay.time = slot.time;
          }
        }
        // Provenance so the card can be honest about WHERE the time came from: a slot verified
        // open across everyone's calendars, or the model's reading of the transcript when
        // free/busy was unavailable (no scope, API error) or found no gap. Also records names we
        // could not turn into emails, since the executor silently drops those.
        scheduling = {
          ...scheduling,
          verified: Boolean(slot),
          checked: emails.length + (selfEmail ? 1 : 0),
          ...(slot && askedFor && askedFor !== `${slot.date} ${slot.time}` ? { moved_from: askedFor } : {}),
          ...(unresolved.length ? { unresolved } : {}),
        };
      } catch (e: any) {
        log.warn({ err: String(e?.message ?? e) }, "calendar card scheduling enrich failed");
      }
      // THE FALLBACK, and it is required rather than tidy. Outside the try on purpose: whatever
      // went wrong above, a calendar card must still be approvable.
      //
      // A card with an empty date and time shows the user no time to agree to, and before the
      // schema allowed them to be empty that commitment would at least have survived as a to-do.
      // Making the schema permissive without this would have traded a useless to-do for a
      // useless calendar card. So when free/busy could not answer (no scope, API error, no gap in
      // a fortnight) we propose the next weekday at 10:00, respecting the same not-today rule.
      //
      // `verified: false` is already what the block above records in that case, and the card shows
      // it: this is a suggestion that says it is a suggestion, not a fact that is wrong.
      const haveDate = /^\d{4}-\d{2}-\d{2}$/.test(String(pay.date ?? "").trim());
      const haveTime = /^\d{1,2}:\d{2}$/.test(String(pay.time ?? "").trim());
      // A time that has ALREADY GONE BY counts as no time at all. Without this the fallback below
      // is skipped whenever the model stated both fields, so a transcript read at 18:00 saying
      // "let's meet at 9" mints a card for 09:00 today: already past at the moment of creation,
      // and it survives untouched because findOpenSlot only overwrites when it succeeds.
      const past = startHasPassed(tz, String(pay.date ?? ""), String(pay.time ?? ""));
      if (!haveDate || !haveTime || past) {
        const at = new Date(nextWorkdayStart(tz, notBefore, 10));
        pay.date = dayKeyInTz(tz, at);
        pay.time = hhmmInTz(tz, at);
        scheduling = { ...scheduling, verified: false, proposed: "next open weekday, not checked against calendars" };
      }
    }
    await db.insert(schema.cards).values({
      id: id("card"),
      userId,
      schemaVersion: 1,
      type: "action",
      actionType: d.action_type,
      status: "proposed",
      title: d.title,
      summary: d.summary,
      confidence: Math.max(0, Math.min(1, d.confidence)),
      priority: d.priority,
      sourceJson: { kind: "meeting", title: tr.title, when: tr.ingestedAt.toISOString() },
      payload: d.payload,
      context: {
        why: d.evidence.map((e) => ({ who: e.who, text: e.text })),
        entities: d.entities,
        links: d.links ?? [`Transcript · ${tr.title}`],
        ...(d.caveat || extraCaveat
          ? { caveat: [d.caveat, extraCaveat].filter(Boolean).join(" ") }
          : {}),
        ...(scheduling ? { scheduling } : {}),
        // INDIRECT PROMPT INJECTION, surfaced rather than blocked. The transcript is
        // attacker-reachable: anyone in the room, or anyone who can get text into a Gemini doc, a
        // notetaker recording or a Slack thread, can put a sentence in front of the extractor. The
        // two defences we already have BOTH pass for an injected line: its quote verifies (the
        // words really are in the source) and attribution passes (it can be phrased as the user's
        // own promise). Quote fidelity proves something was said, not that it should be done.
        //
        // The blast radius grew when share_file and create_crm_note shipped: the worst an injection
        // could previously do was draft an email the user would read. Now it can propose sending a
        // file to an address the user has never seen.
        //
        // Not blocked, because refusing would break the swipe invariant and because sending things
        // to people outside your company is most of what work is. Named, so the card can say it at
        // the one moment that matters, before the nod.
        ...(() => {
          const unexpected = unexpectedRecipients({
            actionType: d.action_type,
            payload: d.payload ?? {},
            selfEmail: urow?.email,
            attendeeEmails: roomEmails,
          });
          return unexpected.length ? { unexpected_recipients: unexpected } : {};
        })(),
        manifest: cardManifest,
      },
      // 7 days, not 24h: a commitment made out loud in a meeting should survive a weekend or a
      // few days off. The sweep now also notifies the user before dropping one (jobs/digest.ts).
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
      simulated: false,
      transcriptId: tr.id,
      meetingId: tr.meetingId,
      model: servedModel,
      promptVersion: EXTRACT_PROMPT_VERSION,
    });
    inserted++;
    titles.push(d.title);
  }

  await db
    .update(schema.transcripts)
    .set({ extractedAt: new Date() })
    .where(eq(schema.transcripts.id, tr.id));

  if (inserted > 0) {
    // Same rule as POST /api/v1/cards/propose in api/routes.ts: the practice card leaves the moment
    // real work arrives. It was never counted by anything (lib/metrics.notSimulated), so expiring it
    // here only ever changes what the deck shows, never a number already reported.
    await db
      .update(schema.cards)
      .set({ status: "expired" })
      .where(and(eq(schema.cards.userId, userId), eq(schema.cards.simulated, true), eq(schema.cards.status, "proposed")));
    // Slack-derived batches are pushed by jobs/slackListen instead, AFTER its evidence guard has
    // run. Pushing here would put the title of a card that is about to be deleted onto the user's
    // phone, and the titles most likely to be deleted are exactly the ones a hostile background
    // message shaped: the guard would still stop the card, but the attacker's words would already
    // have arrived over Haii's own trusted channel. This is the one source where the push has to
    // wait for the check. Keyed on the transcript source so both the sync and batch paths inherit
    // it without threading an option through either.
    if (tr.source !== "slack") {
      await tgSend(
        userId,
        `🃏 <b>${inserted} card${inserted === 1 ? "" : "s"}</b> proposed from "${escapeHtml(tr.title)}"\n${titles.map((t) => `• ${escapeHtml(t)}`).join("\n")}\n\nDecide: ${env.APP_URL}`,
      );
    }
  }
  // Operator signal. Count only, no titles and no meeting name: the line above already sends those
  // to the person they belong to. "Nothing came out of that transcript" is worth knowing too,
  // because a silent extraction is otherwise indistinguishable from a broken one.
  //
  // Skipped for Slack for the same reason the push above is: this count is taken before
  // slackListen's evidence guard has deleted anything, so it would report cards that are about to
  // stop existing. slackListen sends the real one once the check has run.
  if (tr.source !== "slack") {
    void opsNotify(userId, inserted > 0 ? `got ${inserted} new card${inserted === 1 ? "" : "s"}` : "had a transcript produce no cards");
  }
  return { inserted, titles, dropped, strippedQuotes };
}

/** The batch submission below does not work, so BATCH_EXTRACT is ignored until it is rebuilt.
 *
 *  The request it builds cannot be accepted by the Messages API: `system` is the split
 *  { stable, variable } object from buildExtractRequest, which only lib/llm.ts turns into text
 *  blocks, and EXTRACT_SCHEMA goes out with minItems and maxItems, which the structured-output
 *  dialect rejects (lib/schema.ts strips them on the sync path). Nothing batched this way can
 *  succeed, so the flag falls back to the normal path, the same as when it is unset. The code
 *  below stays as a starting point for that rebuild. */
const BATCH_EXTRACT_PATH_WORKS: boolean = false;
let warnedBatchExtractOff = false;

/** Retry path: extract every transcript for this user that has not been processed yet.
 *  BATCH_EXTRACT would send this background sweep through the Message Batches API, but see
 *  BATCH_EXTRACT_PATH_WORKS above: today the flag changes nothing. Nothing can batch without
 *  ANTHROPIC_API_KEY either. runExtract (paste endpoint, drive-inline ingest) is never touched
 *  by this flag. */
export async function extractPending(userId: string): Promise<string> {
  if (env.BATCH_EXTRACT && !BATCH_EXTRACT_PATH_WORKS && !warnedBatchExtractOff) {
    warnedBatchExtractOff = true;
    log.warn("BATCH_EXTRACT is set but the batch path is disabled; using the normal extraction path");
  }
  if (!BATCH_EXTRACT_PATH_WORKS || !env.BATCH_EXTRACT || !(await apiKey())) {
    const pending = await db
      .select({ id: schema.transcripts.id })
      .from(schema.transcripts)
      .where(and(eq(schema.transcripts.userId, userId), isNull(schema.transcripts.extractedAt)))
      .limit(5);
    if (!pending.length) return "skipped: nothing pending";
    const out: string[] = [];
    for (const t of pending) out.push(await runExtract(userId, t.id));
    return out.join("; ");
  }

  const gateReason = await budgetGate(userId, "action_extract");
  if (gateReason) return `skipped: ${gateReason}`;

  const pending = await db
    .select()
    .from(schema.transcripts)
    .where(and(eq(schema.transcripts.userId, userId), isNull(schema.transcripts.extractedAt)))
    .limit(5);
  if (!pending.length) return "skipped: nothing pending";

  const urows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  const user = urows[0];

  const batched: (typeof schema.transcripts.$inferSelect)[] = [];
  const requests: { custom_id: string; params: Record<string, unknown> }[] = [];
  let tooShort = 0;
  for (const tr of pending) {
    const cleaned = cleanTranscript(tr.contentMd);
    if (cleaned.length < MIN_TRANSCRIPT_CHARS) {
      await db.update(schema.transcripts).set({ extractedAt: new Date() }).where(eq(schema.transcripts.id, tr.id));
      tooShort++;
      continue;
    }
    const req = await buildExtractRequest(user, tr, cleaned);
    batched.push(tr);
    // custom_id must match ^[a-zA-Z0-9_-]{1,64}$; transcript ids (tr_<base36rand> for paste,
    // tr_<userId>_<driveFileId> with userId like u_<10hex> for drive) always satisfy this.
    requests.push({
      custom_id: tr.id,
      params: {
        model: MODELS.deep,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: { format: { type: "json_schema", schema: EXTRACT_SCHEMA } },
      },
    });
  }
  if (!requests.length) return `skipped: ${tooShort} too short, nothing to batch`;

  const key = await apiKey();
  const client = new Anthropic({ apiKey: key! });
  // Submission order is deliberate crash-safety: (1) submit to the provider, (2) record it
  // locally, (3) mark the transcripts in-flight, in that order, never reordered.
  // Crash between 1-2: orphan provider batch nobody ever reads; transcripts stay NULL and are
  // resubmitted next sweep; wasted spend only, no duplicate cards (the poller's cards-exist guard
  // blocks that). Crash between 2-3: transcripts get resubmitted AND the first batch is still
  // polled; the cards-exist guard again blocks the duplicate apply.
  const batch = await client.messages.batches.create({ requests: requests as any });
  await db.insert(schema.llmBatches).values({ providerBatchId: batch.id, status: "submitted" });
  await db
    .update(schema.transcripts)
    .set({ extractedAt: new Date() })
    .where(inArray(schema.transcripts.id, batched.map((t) => t.id)));

  return `batched ${batched.length} transcripts (${batch.id})`;
}

export async function runExtract(userId: string, transcriptId: string): Promise<string> {
  return runJob("action_extract", userId, async () => {
    const trs = await db
      .select()
      .from(schema.transcripts)
      .where(and(eq(schema.transcripts.id, transcriptId), eq(schema.transcripts.userId, userId)));
    const tr = trs[0];
    if (!tr) return "skipped: transcript not found";
    if (tr.extractedAt) return "skipped: already extracted";

    // Cost lever: strip Gemini boilerplate and timestamps before spending tokens on them.
    const clean = cleanTranscriptDetailed(tr.contentMd);
    const cleaned = clean.text;
    if (cleaned.length < MIN_TRANSCRIPT_CHARS) {
      await db
        .update(schema.transcripts)
        .set({ extractedAt: new Date() })
        .where(eq(schema.transcripts.id, tr.id));
      return `skipped: too short after cleaning (${cleaned.length} chars)`;
    }

    // Claim the transcript BEFORE the 30-60s LLM call. extracted_at used to be written only after
    // the call returned, so the every-10-min extract_pending cron could re-select a transcript the
    // paste route was still processing and extract it a second time: up to 14 cards for 7
    // commitments, two pushes, and double spend against the user's cap. A conditional update is
    // the atomic claim; 0 rows back means another runner got there first. (The batch path already
    // did this at submission time; the sync path did not.)
    const claimed = await db
      .update(schema.transcripts)
      .set({ extractedAt: new Date() })
      .where(and(eq(schema.transcripts.id, tr.id), isNull(schema.transcripts.extractedAt)))
      .returning({ id: schema.transcripts.id });
    if (!claimed.length) return "skipped: already claimed by another run";

    const urows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    const req = await buildExtractRequest(urows[0], tr, cleaned);

    const result = await llmJson({
      userId,
      job: "action_extract",
      model: MODELS.deep,
      system: req.system,
      user: req.user,
      jsonSchema: EXTRACT_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: req.maxTokens,
    });
    if (!result.ok) {
      // Release the claim so the retry sweep can pick it up again; a failed call must not leave
      // the transcript permanently marked as extracted.
      await db
        .update(schema.transcripts)
        .set({ extractedAt: null })
        .where(eq(schema.transcripts.id, tr.id));
      return `skipped: ${result.reason}`;
    }

    const { inserted, dropped, strippedQuotes } = await applyExtractResult(userId, tr, result.data, result.model, clean.truncated
      ? `Haii read the first ${Math.round(cleaned.length / 1000)}k of ${Math.round(clean.fullLength / 1000)}k characters of this transcript, so anything committed near the end may be missing.`
      : undefined, req.manifest);
    // Truncation must reach the user: the transcript modal shows the FULL text, so without this
    // the evidence looks like it covers a document the model only partly read.
    const trunc = clean.truncated
      ? ` · read first ${Math.round(cleaned.length / 1000)}k of ${Math.round(clean.fullLength / 1000)}k chars, commitments near the end may be missing`
      : "";
    // A guard that drops cards silently reads as "the model found nothing". Say what it took.
    const guard = [
      strippedQuotes ? `${strippedQuotes} quote${strippedQuotes === 1 ? "" : "s"} stripped` : "",
      dropped ? `${dropped} dropped with no evidence left` : "",
    ].filter(Boolean).join(", ");
    return `${inserted} cards from "${tr.title}" ($${result.costUsd.toFixed(3)})${guard ? " · " + guard : ""}${trunc}`;
  });
}

/** Apply a finished brief batch: each result's custom_id resolves to a meeting id, and the payload
 *  becomes a briefings row at the 0.5x batch rate. Skips any meeting that already has a brief, because the
 *  T-10 scan may have beaten the batch to it; writing a second one would leave two briefs for the
 *  same meeting and make "which did I read" ambiguous. A failed or malformed result is simply left
 *  alone: the T-10 scan will generate it synchronously, which is the whole safety model. */
async function applyBriefBatch(
  client: Anthropic,
  providerBatchId: string,
  userId: string,
  orderedMeetingIds: unknown,
): Promise<number> {
  let applied = 0;
  for await (const r of await client.messages.batches.results(providerBatchId)) {
    if (r.result.type !== "succeeded") continue;
    // custom_id is the request's position, not the meeting id: the meeting id can exceed the
    // API's 64-char cap and rejects the whole batch. Batches submitted before that change are
    // still in flight for up to 24h and carry the raw id, which resolveBriefMeetingId handles.
    const meetingId = resolveBriefMeetingId(r.custom_id, orderedMeetingIds);
    if (!meetingId) continue;
    const existing = await db
      .select({ id: schema.briefings.id })
      .from(schema.briefings)
      .where(and(eq(schema.briefings.userId, userId), eq(schema.briefings.meetingId, meetingId)));
    if (existing.length) continue;

    const textBlock = r.result.message.content.find((b: any) => b.type === "text") as { text: string } | undefined;
    if (!textBlock) continue;
    let data: any;
    try {
      data = JSON.parse(textBlock.text);
    } catch {
      continue; // T-10 will generate this one synchronously
    }
    const usage: any = r.result.message.usage ?? {};
    const tokensIn = usage.input_tokens ?? 0;
    const tokensOut = usage.output_tokens ?? 0;
    const servedModel = (r.result.message as any).model ?? MODELS.deep;
    const costUsd = costOf(servedModel, tokensIn, tokensOut) * 0.5; // batch discount
    await db.insert(schema.briefings).values({
      id: id("brf"),
      userId,
      meetingId,
      model: servedModel,
      promptVersion: BRIEFING_PROMPT_VERSION_FOR_BATCH,
      contentJson: data,
      tokensIn,
      tokensOut,
      costUsd,
      deliveredAt: null, // pre-generated overnight; the T-10 push still announces it
    });
    await recordLedger(userId, "briefing_batch", servedModel, tokensIn, tokensOut, costUsd);
    applied++;
  }
  return applied;
}

/** Global job, no per-user fan-out (llm_batches rows aren't scoped to a user). Collects the 4am
 *  brief batches, and must run regardless of BATCH_EXTRACT: an extraction batch already in flight
 *  needs to drain, or it would sit unpolled forever. */
export async function batchPoll(): Promise<string> {
  const open = await db
    .select()
    .from(schema.llmBatches)
    .where(notInArray(schema.llmBatches.status, ["ended", "failed"]));
  if (!open.length) return "skipped: no open batches";

  const key = await apiKey();
  if (!key) return "skipped: no api key";
  const client = new Anthropic({ apiKey: key });

  let batchesEnded = 0;
  let applied = 0;
  let syncRetried = 0;

  for (const row of open) {
    if (!row.providerBatchId) continue; // schema allows null; submission never leaves it unset

    let batch;
    try {
      batch = await client.messages.batches.retrieve(row.providerBatchId);
    } catch (e: any) {
      log.warn({ err: String(e?.message ?? e), providerBatchId: row.providerBatchId }, "batch retrieve failed");
      await db.update(schema.llmBatches).set({ status: "failed" }).where(eq(schema.llmBatches.id, row.id));
      continue;
    }

    // Brief batches (4am pre-generation) reuse this table and poller but have a different applier:
    // custom_id resolves to a meeting id and the result becomes a briefings row, not cards.
    if (String(row.kind ?? "extract").startsWith("brief")) {
      if (batch.processing_status !== "ended") continue;
      try {
        const n = await applyBriefBatch(client, row.providerBatchId, row.userId, row.customIds);
        applied += n;
        batchesEnded++;
        await db.update(schema.llmBatches).set({ status: "ended" }).where(eq(schema.llmBatches.id, row.id));
      } catch (e: any) {
        log.warn({ err: String(e?.message ?? e) }, "brief batch apply failed");
        await db.update(schema.llmBatches).set({ status: "failed" }).where(eq(schema.llmBatches.id, row.id));
      }
      continue;
    }

    if (batch.processing_status === "ended") {
      try {
        // Results arrive unordered; custom_id (the transcript id) is the only reliable key.
        for await (const r of await client.messages.batches.results(row.providerBatchId)) {
          const trs = await db.select().from(schema.transcripts).where(eq(schema.transcripts.id, r.custom_id));
          const tr = trs[0];
          if (!tr) continue; // transcript row gone; nothing to apply to

          if (r.result.type === "succeeded") {
            // Duplicate-batch guard: a prior poll (or a sync retry that beat this poll to it) may
            // already have applied this transcript. Re-applying would double-propose the same
            // commitments.
            const existing = await db
              .select({ id: schema.cards.id })
              .from(schema.cards)
              .where(eq(schema.cards.transcriptId, tr.id))
              .limit(1);
            if (existing.length) continue;

            const textBlock = r.result.message.content.find((b: any) => b.type === "text") as
              | { text: string }
              | undefined;
            let data: any;
            try {
              if (!textBlock) throw new Error("empty_response");
              data = JSON.parse(textBlock.text);
            } catch {
              // Same recovery as the errored/expired/canceled branch below: back to NULL, then a
              // synchronous full-price retry.
              await db.update(schema.transcripts).set({ extractedAt: null }).where(eq(schema.transcripts.id, tr.id));
              await runExtract(tr.userId, tr.id);
              syncRetried++;
              continue;
            }
            const servedModel = r.result.message.model;
            const usage = r.result.message.usage;
            const tokensIn = usage?.input_tokens ?? 0;
            const tokensOut = usage?.output_tokens ?? 0;
            // Batch discount: 50% off the standard per-token ledger rate.
            await recordLedger(
              tr.userId,
              "action_extract",
              servedModel,
              tokensIn,
              tokensOut,
              costOf(servedModel, tokensIn, tokensOut) * 0.5,
            );
            await applyExtractResult(tr.userId, tr, data, servedModel);
            applied++;
          } else {
            // errored | expired | canceled: back to NULL so it looks pending again, then retry
            // synchronously through the normal, budget-gated, full-price path.
            await db.update(schema.transcripts).set({ extractedAt: null }).where(eq(schema.transcripts.id, tr.id));
            await runExtract(tr.userId, tr.id);
            syncRetried++;
          }
        }
        await db.update(schema.llmBatches).set({ status: "ended" }).where(eq(schema.llmBatches.id, row.id));
        batchesEnded++;
      } catch (e: any) {
        log.warn({ err: String(e?.message ?? e), providerBatchId: row.providerBatchId }, "batch results failed");
        await db.update(schema.llmBatches).set({ status: "failed" }).where(eq(schema.llmBatches.id, row.id));
      }
    } else if (Date.now() - row.createdAt.getTime() > 3 * 3600_000) {
      // Stuck past 3h: cancel now, let a later tick drain it once cancellation reaches ended.
      await client.messages.batches.cancel(row.providerBatchId);
      await db.update(schema.llmBatches).set({ status: "canceling" }).where(eq(schema.llmBatches.id, row.id));
    }
    // else: not ended, still under 3h old; leave untouched, next tick checks again.
  }

  return `${batchesEnded} batches: ${applied} applied, ${syncRetried} sync-retried`;
}
