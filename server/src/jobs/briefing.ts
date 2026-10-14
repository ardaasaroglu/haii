import { and, desc, eq, gte, lte, lt, or, ilike, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { env } from "../env";
import { log } from "../log";
import { llmJson, MODELS } from "../lib/llm";
import { tgSend, escapeHtml } from "../lib/telegram";
import { userTz, dateTimeInTz, hhmmForUser } from "../lib/tz";
import { listMemories, formatMemories } from "../lib/memory";
import { isBriefWorthy, wholeWordPattern } from "../lib/meeting";
import { fetchAttachmentContent } from "../connectors/drive";
import { buildManifest, src } from "../lib/manifest";
import {
  BRIEFING_PROMPT_VERSION,
  BRIEFING_SCHEMA,
  briefingSystem,
  briefingUser,
} from "../prompts/briefing.v005";

/** Invite attachments fetched (content, not just title) per brief. Google rarely puts more than
 *  one or two real documents on an invite (see lib/invite.ts's MAX_ATTACHMENTS, the storage-side
 *  cap); this is the separate BRIEF-time cap on how many of those stored attachments are actually
 *  read, kept low because each one is a real Drive fetch on the hot path of a brief. */
const MAX_ATTACHMENTS_TO_FETCH = 2;

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function firstNames(attendees: Array<{ email?: string; name?: string }>): string[] {
  return attendees
    .map((a) => (a.name || a.email?.split("@")[0] || "").split(/[\s.]/)[0])
    .filter((n) => n.length > 2);
}

/** Brief retrieval: attendees + title tokens, ILIKE, recency, top 6.
 *  selfFirstName is the user's own first name, lowercased, so the People section skips them.
 *  Also reads the invite's own description and (at most MAX_ATTACHMENTS_TO_FETCH) attachment
 *  content, both EXTERNAL-AUTHOR context; see prompts/briefing.v005 for why those render as
 *  explicitly untrusted material rather than plain context like everything else here. */
async function retrieve(userId: string, meeting: typeof schema.meetings.$inferSelect, selfFirstName: string, tz = "UTC") {
  const names = firstNames((meeting.attendees as any[]) ?? []);
  const titleTokens = meeting.title
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 3 && !["sync", "weekly", "meeting", "call"].includes(t));
  // Split, because names and title words want different matching. A NAME must match as a whole
  // word: "Ben" as a substring hits "bench" and "benefit", and those items then arrive
  // as relevant context for a meeting they have nothing to do with. A title TOKEN is better off
  // loose, because "pricing" should still find "priced" and "prices".
  const nameNeedles = names.slice(0, 6);
  const tokenNeedles = titleTokens.filter((t) => !names.includes(t)).slice(0, 6);
  const needles = [...new Set([...nameNeedles, ...tokenNeedles])].slice(0, 8);
  const rxOf = wholeWordPattern;

  // THE MANIFEST, accumulated as each query runs rather than reconstructed afterwards.
  //
  // This function once returned only strings, which meant that once a brief was
  // assembled there was no record of which rows produced it: provenance was unrecoverable, not
  // merely unrecorded. A brief reads across every connected stream, so it is the assembler where
  // the data boundary will bite hardest, and the executor gate can only refuse an outbound draft
  // whose sources include internal-only material if something wrote the sources down here.
  //
  // Pushed at each query on purpose. Rebuilding the list at the end would mean a second set of
  // queries that could drift from the first, and a manifest that disagrees with the prompt is
  // worse than none: it would be a gate reading the wrong list while looking correct.
  const sources: Array<ReturnType<typeof src>> = [src("meeting", meeting.id)];

  const since = new Date(Date.now() - 7 * 24 * 3600_000);
  let rows: (typeof schema.items.$inferSelect)[] = [];
  if (needles.length) {
    rows = await db
      .select()
      .from(schema.items)
      .where(
        and(
          eq(schema.items.userId, userId),
          gte(schema.items.ts, since),
          or(
            ...nameNeedles.flatMap((n) => [
              sql`${schema.items.title} ~* ${rxOf(n)}`,
              sql`${schema.items.bodyText} ~* ${rxOf(n)}`,
            ]),
            ...tokenNeedles.flatMap((n) => [
              ilike(schema.items.title, `%${n}%`),
              ilike(schema.items.bodyText, `%${n}%`),
            ]),
          ),
        ),
      )
      .orderBy(desc(schema.items.ts))
      .limit(12);
  }
  // THE RECENCY PADDING IS GONE. It used to top a thin result up to six with the most RECENT
  // items, filtered on nothing but the user and a seven-day window: no needle, no entity, no
  // relevance test of any kind.
  //
  // So a brief for a meeting with one person could discuss Slack DMs with someone else, on
  // unrelated topics. Nothing had matched, so the query padded with whatever was newest, and the
  // model was handed it as context for the meeting and used it, exactly as instructed.
  //
  // The intent was that a thin brief is worse than no brief. It is the other way round. A brief
  // that says little is honest and takes ten seconds to skim; a brief that confidently discusses
  // the wrong conversation costs the trust the whole product runs on, and the reader cannot tell
  // which parts to believe. Empty sections already collapse to nothing by design.
  //
  // It also makes an old cost saving reachable: with no padding, a
  // meeting with genuinely no related context now returns zero snippets, which is the signal for
  // rendering "no new context since last time" instead of paying a model to say it.
  // .slice(0, 6) matters: rows beyond the sixth are fetched and never shown to the model, so
  // recording them would claim the brief saw context it did not. The manifest lists what was SENT.
  const used = rows.slice(0, 6);
  sources.push(...used.map((r) => src("item", r.id, r.connector)));
  const snippets = used
    .map(
      (r) =>
        `[${r.connector} · ${dateTimeInTz(tz, r.ts)} · ${r.author}] ${r.title}\n${r.bodyText.slice(0, 600)}`,
    )
    .join("\n---\n");

  // Last meeting with attendee overlap, plus its transcript if any.
  const prior = await db
    .select()
    .from(schema.meetings)
    .where(and(eq(schema.meetings.userId, userId), lt(schema.meetings.startsAt, meeting.startsAt)))
    .orderBy(desc(schema.meetings.startsAt))
    .limit(20);
  const mineNames = new Set(names.map((n) => n.toLowerCase()));
  const last = prior.find((m) =>
    firstNames((m.attendees as any[]) ?? []).some((n) => mineNames.has(n.toLowerCase())),
  );
  let lastMeeting = "";
  if (last) {
    lastMeeting = `${last.title} · ${dateTimeInTz(tz, last.startsAt)}`;
    sources.push(src("meeting", last.id));
    const tr = await db
      .select()
      .from(schema.transcripts)
      .where(and(eq(schema.transcripts.userId, userId), eq(schema.transcripts.meetingId, last.id)))
      .limit(1);
    if (tr[0]) {
      lastMeeting += `\nTranscript excerpt:\n${tr[0].contentMd.slice(0, 1200)}`;
      // Someone else's meeting words, and the largest single block of other people's content in a
      // brief. If any entry ever needs a visibility class that is not `internal`, it is this one.
      sources.push(src("transcript", tr[0].id, tr[0].source ?? undefined));
    }
  }

  const openCards = await db
    .select()
    .from(schema.cards)
    .where(and(eq(schema.cards.userId, userId), inArray(schema.cards.status, ["proposed", "approved"])))
    .limit(10);
  const openTodos = await db
    .select()
    .from(schema.todos)
    .where(and(eq(schema.todos.userId, userId), eq(schema.todos.status, "open")))
    .limit(10);
  sources.push(...openCards.map((c) => src("card", c.id)), ...openTodos.map((t) => src("todo", t.id)));
  const openWork = [
    ...openCards.map((c) => `card(${c.actionType}, ${c.status}): ${c.title}`),
    ...openTodos.map((t) => `todo: ${t.title}${t.due ? ` (due ${t.due})` : ""}`),
  ].join("\n");

  // Per-attendee history: the People section's raw material. "none" marks a new face.
  const attendeeLines: string[] = [];
  const roster = ((meeting.attendees as any[]) ?? []).slice(0, 6);
  for (const a of roster) {
    const label = a.name || a.email || "";
    if (!label) continue;
    const first = (a.name || a.email?.split("@")[0] || "").split(/[\s.]/)[0];
    if (!first || first.length < 3 || first.toLowerCase() === selfFirstName) continue;
    // WHOLE WORD, not a substring. This was `ilike('%' || first || '%')`, so a three-letter first
    // name matched inside ordinary words: Ben hit "bench" and "benefit", Ana hit
    // "analysis", Sam hit "same". The guard above only refuses names under three characters, which
    // is precisely where the substring match is most promiscuous.
    //
    // \m and \M are Postgres word boundaries and ~* is its case-insensitive regex operator; PGlite
    // is real Postgres so this behaves identically in local dev. The name is escaped because a
    // person called "J." would otherwise be a regex.
    const rx = wholeWordPattern(first);
    const hits = await db
      .select()
      .from(schema.items)
      .where(
        and(
          eq(schema.items.userId, userId),
          or(
            sql`${schema.items.author} ~* ${rx}`,
            sql`${schema.items.title} ~* ${rx}`,
            sql`${schema.items.bodyText} ~* ${rx}`,
          ),
        ),
      )
      .orderBy(desc(schema.items.ts))
      .limit(2);
    if (!hits.length) {
      attendeeLines.push(`${label}: none`);
    } else {
      sources.push(...hits.map((h) => src("item", h.id, h.connector)));
      const parts = hits.map(
        (h) => `[${h.connector} · ${h.ts.toISOString().slice(0, 10)}] ${h.title || ""} ${h.bodyText.slice(0, 160)}`.trim(),
      );
      attendeeLines.push(`${label}: ${parts.join(" | ")}`);
    }
  }
  const attendeeContext = attendeeLines.join("\n");

  // Invite description + attachment content. Gathered HERE, at brief time, never at sync time:
  // connectors/gcal.ts stores only the description text and the attachments' metadata, because
  // fetching every attachment of every event for every user on every 5-minute poll would be a
  // large, mostly wasted spend against a feature that only ever reads a handful of meetings a day.
  const inviteDescription = meeting.description || "";
  const attachments = ((meeting.attachments as any[]) ?? []).slice(0, MAX_ATTACHMENTS_TO_FETCH);
  const attachmentParts: string[] = [];
  for (const a of attachments) {
    const title = (a?.title as string) || "(untitled attachment)";
    let content: string | null = null;
    try {
      content = await fetchAttachmentContent(userId, { fileId: a?.fileId ?? "", mimeType: a?.mimeType ?? "" });
    } catch (e) {
      // Belt and suspenders: fetchAttachmentContent already catches every failure internally and
      // returns null rather than throwing. This exists so a brief still cannot fail on an
      // attachment fetch even if that internal guarantee ever regresses.
      log.warn(
        { userId, fileId: a?.fileId, err: String(e) },
        "attachment fetch threw unexpectedly; brief continues without it",
      );
    }
    attachmentParts.push(content ? `${title}:\n${content}` : `${title} (content unavailable)`);
    // Only when the fetch succeeded: an attachment whose content was unavailable contributed a
    // filename and nothing else, and listing it would overstate what the model read.
    if (content) sources.push(src("attachment", a?.fileId, "drive"));
  }
  const attachmentContent = attachmentParts.join("\n---\n");

  return {
    snippets,
    lastMeeting,
    openWork,
    attendeeContext,
    inviteDescription,
    attachmentContent,
    manifest: buildManifest(sources),
  };
}

/** The chips a brief can be marked down with, in the vocabulary briefing.v005's header explains
 *  (introduced in v004, carried forward unchanged). */
const BRIEF_REASON_LABEL: Record<string, string> = {
  too_long: "too long",
  wrong_people: "wrong people",
  missed_the_point: "missed the point",
};

/** How this user rated their recent briefs, as a correction block for the prompt.
 *
 *  Ratings have been written since v002 and read by nothing, so a brief the user marked down was
 *  rewritten the same way the next day. Newest first and capped at 8: this is a style correction,
 *  and a longer history would only make the oldest complaint the loudest.
 *
 *  Titles come from the meetings the briefs were for, because "too long" attached to a name is a
 *  concrete example the model can compare against, where a bare count is a scolding. Briefs whose
 *  meeting has since been deleted still render, without a title, rather than being dropped: the
 *  rating is the signal and the title is only decoration. */
async function briefFeedback(userId: string): Promise<string> {
  const rows = await db
    .select({
      rating: schema.briefings.rating,
      reason: schema.briefings.feedbackReason,
      meetingId: schema.briefings.meetingId,
    })
    .from(schema.briefings)
    .where(and(eq(schema.briefings.userId, userId), isNotNull(schema.briefings.rating)))
    .orderBy(desc(schema.briefings.createdAt))
    .limit(8);
  if (!rows.length) return "";

  const ids = [...new Set(rows.map((r) => r.meetingId).filter(Boolean))] as string[];
  const titles = new Map<string, string>();
  if (ids.length) {
    const ms = await db
      .select({ id: schema.meetings.id, title: schema.meetings.title })
      .from(schema.meetings)
      .where(and(eq(schema.meetings.userId, userId), inArray(schema.meetings.id, ids)));
    for (const m of ms) titles.set(m.id, m.title);
  }

  return rows
    .map((r) => {
      const verdict = r.rating === "up" ? "thumbs up" : "thumbs down";
      const label = BRIEF_REASON_LABEL[String(r.reason ?? "")];
      const why = r.rating === "down" && label ? ` (${label})` : "";
      const title = titles.get(String(r.meetingId ?? ""));
      return `${verdict}${why}${title ? ` · "${title}"` : ""}`;
    })
    .join("\n");
}

/** The system/user prompt pair for one meeting's brief, or null when retrieval found nothing at
 *  all (that case is answered deterministically and free, see generateBriefing).
 *
 *  Shared by the sync path and the 4am batch path so both build byte-identical requests: a brief
 *  that differs depending on which pipeline produced it would be a quiet correctness bug and would
 *  also make the two paths impossible to compare on cost.
 *
 *  That claim was once FALSE: generateBriefing assembled
 *  its own copy and never called this, so the only callers were briefBatch and the prompt-diff
 *  harness. Two copies agreeing is not an invariant, it is a coincidence with an expiry date, and
 *  the harness was watching the copy nobody reads. It is true now, and it is true by construction:
 *  if you are tempted to inline this again, that is what you would be giving up. */
export async function buildBriefingRequest(
  userId: string,
  meeting: typeof schema.meetings.$inferSelect,
  user: typeof schema.users.$inferSelect | undefined,
  tz: string,
): Promise<{ system: string; user: string; manifest: ReturnType<typeof buildManifest> } | null> {
  const name = user?.name || userId;
  const role = user?.role || "";
  const selfFirstName = name.split(/[\s.]/)[0].toLowerCase();
  const ctx = await retrieve(userId, meeting, selfFirstName, tz);
  // A rich invite description or a readable attachment counts as real context on its own: a
  // meeting whose ONLY signal is an agenda the organiser wrote, with nothing yet in the stream and
  // no prior meeting, used to fall through to the deterministic "nothing found" reply below and
  // never get a real brief at all.
  if (!ctx.snippets && !ctx.lastMeeting && !ctx.openWork && !ctx.inviteDescription && !ctx.attachmentContent) return null;
  const attendees = ((meeting.attendees as any[]) ?? [])
    .map((a) => a.name || a.email)
    .filter(Boolean)
    .join(", ");
  // The manifest is destructured OUT rather than spread into the prompt, and that separation is
  // the whole point: one place assembles what the model sees, and the stored form is richer than
  // the sent form. Spreading it would put provenance ids in front of the model, which is both
  // useless to it and exactly the confusion this shape exists to prevent.
  const { manifest, ...promptCtx } = ctx;
  const memories = await listMemories(userId);
  return {
    system: briefingSystem(name, role, formatMemories(memories)),
    user: briefingUser({
      selfName: name,
      meetingTitle: meeting.title,
      startsAt: `${dateTimeInTz(tz, meeting.startsAt)} (${tz})`,
      attendees: attendees || "(unknown)",
      briefFeedback: await briefFeedback(userId),
      ...promptCtx,
    }),
    // Memories reach the SYSTEM prompt, so they are part of what the model saw and belong here
    // with everything else. They are also the entries most likely to carry a durable fact about
    // the user rather than a quotable line, which is precisely what must not leak outbound.
    manifest: buildManifest([...manifest, ...memories.map((m) => src("memory", String(m.id)))]),
  };
}

export async function generateBriefing(
  userId: string,
  meeting: typeof schema.meetings.$inferSelect,
  opts: { push?: boolean } = { push: true },
): Promise<string> {
  const urows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  const user = urows[0];
  const tz = userTz(user?.tz);
  // name, role and selfFirstName used to be derived here to build the prompt. They live inside
  // buildBriefingRequest now, with the assembly they belong to.

  const attendees = ((meeting.attendees as any[]) ?? [])
    .map((a) => a.name || a.email)
    .filter(Boolean)
    .join(", ");

  // ONE assembly, shared with the 4am batch, rather than a second copy of it here.
  //
  // This function used to build the prompt itself, so buildBriefingRequest's own doc comment
  // ("shared by the sync path and the 4am batch path so both build byte-identical requests") was
  // simply untrue: its only callers were briefBatch and the prompt-diff harness. Two consequences,
  // and the second is the bad one. The stated invariant was enforced by two copies happening to
  // agree rather than by construction. And the diff harness, whose entire job is to make a prompt
  // change visible, was watching the batch assembly and NOT the one that produces the brief a user
  // actually reads at T-10. A change to one and not the other would have shipped silently, which is
  // the exact failure that harness exists to prevent.
  //
  // Calling it also gives the no-context case for free: null IS "retrieval found nothing".
  const req = await buildBriefingRequest(userId, meeting, user, tz);

  // Nothing found anywhere: no related messages, no prior meeting with these people, no open work,
  // no invite description, nothing readable attached. Calling the model here buys a paragraph that
  // says nothing, at full price. Say so plainly instead, and say it in a way that makes clear Haii
  // actually looked. "No context" written by code is more honest than a padded brief pretending to
  // have found something.
  if (!req) {
    const briefingId = id("brf");
    await db.insert(schema.briefings).values({
      id: briefingId,
      userId,
      meetingId: meeting.id,
      model: "none (no context found)",
      promptVersion: BRIEFING_PROMPT_VERSION,
      contentJson: {
        tldr: `Haii searched everything you have connected and found nothing about this meeting. No earlier meeting with ${attendees || "these people"}, no related messages, no open work. You are going in cold, so there is nothing for Haii to catch you up on.`,
        sections: [
          {
            h: "Nothing found",
            items: [
              "No messages, documents or tickets mentioning this meeting or its attendees in the last 7 days",
              "No previous meeting with overlapping attendees",
              "No open cards or to-dos related to this",
            ],
          },
        ],
        last_met: [],
        open_threads: [],
      },
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      deliveredAt: opts.push ? new Date() : null,
    });
    log.info({ meeting: meeting.title, briefingId }, "briefing skipped: no context found");
    return `no context found for "${meeting.title}" ($0.000)`;
  }

  const result = await llmJson({
    userId,
    job: "briefing_generate",
    model: MODELS.deep,
    system: req.system,
    user: req.user,
    jsonSchema: BRIEFING_SCHEMA as unknown as Record<string, unknown>,
    // Room for the brief AND the short thinking the model may still do at low effort: the two share
    // this budget, and a brief cut off mid-sentence is worse than a few unused tokens.
    maxTokens: 4096,
    // A brief summarizes context it was handed into a fixed 220-word shape. That is not a judgement
    // task, so private reasoning is pure output-token overhead here (thinking bills at output
    // rates, and output dominates this call's cost). Extraction keeps adaptive thinking: deciding
    // who committed to what, pulling exact quotes and scoring confidence genuinely needs it.
    reasoning: "off",
  });

  if (!result.ok) return `skipped: ${result.reason}`;

  const briefingId = id("brf");
  await db.insert(schema.briefings).values({
    id: briefingId,
    userId,
    meetingId: meeting.id,
    model: result.model,
    promptVersion: BRIEFING_PROMPT_VERSION,
    contentJson: result.data,
    manifest: req.manifest,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: result.costUsd,
    deliveredAt: opts.push ? new Date() : null,
  });

  if (opts.push) {
    // Telegram push, so this is read by a person, not parsed by anything.
    const hhmm = hhmmForUser(tz, user?.locale, meeting.startsAt);
    await tgSend(
      userId,
      `🧠 <b>${escapeHtml(meeting.title)}</b> at ${hhmm}\n\n${escapeHtml(result.data.tldr)}\n\nFull brief: ${env.APP_URL}/#brief-${briefingId}`,
    );
  }
  log.info({ meeting: meeting.title, briefingId, cost: result.costUsd }, "briefing generated");
  return `briefed ${meeting.title} ($${result.costUsd.toFixed(3)})`;
}

/** Is there anything at all in this user's briefing window right now?
 *
 *  Same bounds as briefingScan's own first query, deliberately: this must never be more selective
 *  than the job it gates, or a tick that would have briefed something gets skipped.
 *
 *  Exists because briefingScan runs every 60s per user and is idle almost always, and runJob writes
 *  a job_runs row for every call. That was ~1440 rows per user per day, virtually all of them
 *  "skipped: no meetings in window": roughly half of all telemetry, describing nothing. It also
 *  made the last-60 view in /api/v1/jobs cover about fifteen minutes, which is precisely the
 *  window you do NOT want when you are trying to work out why a user has no calendar.
 *  The morning digest already gates before runJob for this exact reason; this brings the 60s job
 *  into line. */
export async function hasBriefingWindow(userId: string): Promise<boolean> {
  const lo = new Date(Date.now() + 10 * 60_000);
  const hi = new Date(Date.now() + 12 * 60_000);
  const rows = await db
    .select({ id: schema.meetings.id })
    .from(schema.meetings)
    .where(
      and(eq(schema.meetings.userId, userId), gte(schema.meetings.startsAt, lo), lte(schema.meetings.startsAt, hi)),
    )
    .limit(1);
  return rows.length > 0;
}

/** Scheduler scan: meetings starting in 10-12 minutes without a briefing. */
export async function briefingScan(userId: string): Promise<string> {
  const lo = new Date(Date.now() + 10 * 60_000);
  const hi = new Date(Date.now() + 12 * 60_000);
  const upcoming = await db
    .select()
    .from(schema.meetings)
    .where(
      and(eq(schema.meetings.userId, userId), gte(schema.meetings.startsAt, lo), lte(schema.meetings.startsAt, hi)),
    );
  if (!upcoming.length) return "skipped: no meetings in window";
  const results: string[] = [];
  let skipped = 0;
  for (const m of upcoming) {
    // Only brief things that are actually meetings with other people. The window filter alone
    // briefed every calendar entry, so "Lunch", "Focus time", "Gym" and personal all-day blocks
    // each got a full model-written brief nobody would ever read. Deterministic skip, no LLM call.
    // The entry still shows in the day strip and can be briefed on demand from there.
    if (!isBriefWorthy(m)) {
      skipped++;
      continue;
    }
    const existing = await db
      .select({ id: schema.briefings.id })
      .from(schema.briefings)
      .where(and(eq(schema.briefings.userId, userId), eq(schema.briefings.meetingId, m.id)));
    if (existing.length) continue;
    results.push(await generateBriefing(userId, m));
  }
  if (results.length) return results.join("; ") + (skipped ? ` (${skipped} solo/declined skipped)` : "");
  return skipped ? `skipped: ${skipped} solo or declined entries, nothing to brief` : "skipped: already briefed";
}

/** Manual trigger: brief the next upcoming meeting regardless of window (for testing). */
export async function briefNext(userId: string): Promise<string> {
  const next = await db
    .select()
    .from(schema.meetings)
    .where(and(eq(schema.meetings.userId, userId), gte(schema.meetings.startsAt, new Date())))
    .orderBy(schema.meetings.startsAt)
    .limit(1);
  if (!next[0]) return "skipped: no upcoming meetings";
  return generateBriefing(userId, next[0]);
}
