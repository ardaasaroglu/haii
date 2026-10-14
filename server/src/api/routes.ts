import { Hono } from "hono";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { validateDraft } from "@haii/schema";
import { db, schema } from "../db";
import { env } from "../env";
import { log } from "../log";
import { ensureConnections, getConnection, getMeta, mergeMeta, setCreds, setStatus, type ConnectorId } from "../lib/connections";
import { apiKey, llmMode, NO_KEY_MESSAGE, todaySpend, instanceMonthSpend, userSpendToday, userSpendMonth } from "../lib/llm";
import { userTz, isValidTz, isValidLocale, dayKeyInTz, dayBoundsInTz, hhmmForUser, dateTimeInTz } from "../lib/tz";
import { classifyCard, isoWeek, emptyTally, tallyCard, approvalRate, approvalSignal, quoteFidelity, quoteVerdict, LEAVES_HAII, notSimulated, type WeekTally } from "../lib/metrics";
import { backfillProgress, runBackfill } from "../jobs/onboarding";
import { buildPracticeCard } from "../lib/practice";
import { encrypt } from "../lib/crypto";
import { upsertItems, type RawItem } from "../connectors/normalize";
import { telegramConfigured, tgSend, escapeHtml, opsNotify } from "../lib/telegram";
import { jiraTest } from "../connectors/jira";
import { confluenceTest } from "../connectors/confluence";
import { firefliesTest } from "../connectors/fireflies";
import { fathomTest } from "../connectors/fathom";
import { otterTest } from "../connectors/otter";
import { hubspotTest, salesforceTest } from "../connectors/crm";
import { linearTest, asanaTest } from "../connectors/trackers";
import { slackTest, slackCapabilities } from "../connectors/slack";
import { linkMeeting } from "../connectors/drive";
import { isBriefWorthy } from "../lib/meeting";
import { cleanTranscript, MIN_TRANSCRIPT_CHARS } from "../lib/transcript";
import { unseenFailures, markFailuresSeen } from "../lib/failures";
import { listMemories } from "../lib/memory";
import { backfillBrainForUser } from "../lib/brainBackfill";
import { explainSkip } from "../lib/skipReason";
import { distillMemories } from "../jobs/distill";
import { runExtract, approvalStats } from "../jobs/extract";
import { briefNext, generateBriefing } from "../jobs/briefing";
import { MANUAL_JOBS } from "../jobs/scheduler";
import { runJob } from "../jobs/run";
import { scheduleExecution, cancelExecution, UNDO_GRACE_MS } from "../jobs/executor";
import { wakeSnoozed } from "../jobs/wake";
import { nextReturn, isSnoozeExhausted } from "../lib/snooze";
import { requireUser, requireAdmin, type AppEnv } from "../lib/session";
import { rateLimit } from "../lib/ratelimit";

/* Rate limits on the paths that SPEND. The onboarding backfill reads at most 6 meetings and a
 * person pastes a few transcripts an hour at most, so 12/hour is well clear of any honest user and
 * far below what a loop would need to matter. The budget ladder stays as the backstop; this is the
 * thing that fires first, before the money is gone rather than after. */
const LIMIT_INGEST = rateLimit({ name: "ingest", limit: 12, windowMs: 3600_000 });
const LIMIT_BRIEF = rateLimit({ name: "brief", limit: 20, windowMs: 3600_000 });
const LIMIT_RETRY = rateLimit({ name: "retry", limit: 30, windowMs: 3600_000 });

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export const api = new Hono<AppEnv>();

// mode lets an external check distinguish a real cloud deploy from a local-mode process that
// ended up publicly reachable (see the exposure guard in env.ts); coarse by design, no secrets.
api.get("/healthz", (c) =>
  c.json({
    ok: true,
    mode: env.DATABASE_URL ? "cloud" : "local",
    // The deploy fingerprint. A build can inject COMMIT_SHA, so comparing this to git confirms
    // which commit is running (see CLAUDE.md). "dev" locally, where the question never arises.
    commit: (process.env.COMMIT_SHA || "").slice(0, 7) || "dev",
    ts: new Date().toISOString(),
  }),
);

// Session-gated even though the fields are config trivia: nothing about the deployment needs
// to be readable anonymously (was public pre-cloud as a route-ordering convenience).
api.get("/api/v1/settings", requireUser, (c) =>
  c.json({
    host: env.HOST,
  }),
);

/* ---------------- admin-gated routes ----------------
 * Registered ahead of the requireUser blanket below on purpose: Hono composes every matched
 * handler for a path in registration order, and a terminal handler that never calls next()
 * stops the chain there. Putting these here (before api.use) mirrors the /api/v1/settings
 * trick above: requireAdmin's own ADMIN_TOKEN branch gets to run for a caller with no session
 * cookie at all, instead of requireUser 401-ing first. */

/** Put an account back to first run, so onboarding can be walked again on real data.
 *
 *  Admin-only and deliberately NOT reachable through /onboarding/state, which is forward-only:
 *  going backwards is a bug or a tampered request when a normal client asks for it, and a test
 *  tool when an operator does. Those are different callers and they get different doors.
 *
 *  What it does NOT do is delete anything. Transcripts already extracted stay extracted, so a
 *  replay shows meetings as already read rather than reading them again. */
api.post("/api/v1/admin/onboarding/reset", requireAdmin, async (c) => {
  const body = await c.req.json<{ user_id?: string }>().catch(() => ({}) as { user_id?: string });
  const target = String(body.user_id || (c.get("userId") as string));
  const rows = await db
    .update(schema.users)
    .set({ onboardingState: "new" })
    .where(eq(schema.users.id, target))
    .returning({ id: schema.users.id });
  if (!rows.length) return c.json({ error: `no such user: ${target}` }, 404);
  log.info({ target }, "onboarding reset to first run");
  return c.json({ ok: true, user_id: target, onboarding: "new" });
});

/* ---------------- operator import routes ----------------
 * Three admin-only routes for an operator script that did the reading somewhere else and posts
 * the result here: proposed cards, a finished brief, and meetings or items. Nothing in the app
 * calls them. Each one writes into the caller's own account. */

/** Cards drafted outside this server, proposed into the caller's own deck.
 *
 *  The cards must name a transcript the caller owns, and each draft must pass validateDraft. Every
 *  quote is then checked against that transcript the way extraction checks it (quoteVerdict on the
 *  cleaned text, see jobs/extract.ts). A quote that is not in the transcript is stripped, and a
 *  draft with no quote left is rejected, not stored. Nothing else extraction does runs here. */
api.post("/api/v1/cards/propose", requireAdmin, async (c) => {
  const uid = c.get("userId") as string;
  const body = await c.req.json<{ transcript_id?: string; cards: unknown[] }>();
  if (!Array.isArray(body.cards)) return c.json({ error: "cards array required" }, 400);

  // A transcript_id the caller does not own is treated as absent, never trusted as a raw foreign key.
  const trs = body.transcript_id
    ? await db
        .select()
        .from(schema.transcripts)
        .where(and(eq(schema.transcripts.id, body.transcript_id), eq(schema.transcripts.userId, uid)))
    : [];
  const ownedTranscript = trs[0];
  if (!ownedTranscript) {
    return c.json({ error: "transcript_id required: a transcript you own, so every quote can be checked against it" }, 400);
  }
  const src: Record<string, string> = {
    kind: "meeting",
    title: ownedTranscript.title,
    when: ownedTranscript.ingestedAt.toISOString(),
  };
  const meetingId = ownedTranscript.meetingId;
  // The same text extraction reads, so a quote is judged the same way on both paths.
  const source = cleanTranscript(ownedTranscript.contentMd);

  let inserted = 0;
  const titles: string[] = [];
  const rejected: string[] = [];
  for (const raw of body.cards.slice(0, 7)) {
    const v = validateDraft(raw);
    if (!v.ok) {
      rejected.push(v.error);
      continue;
    }
    const d = v.draft;
    const kept = (d.evidence ?? []).filter((e) => quoteVerdict(e.text, source) !== "missing");
    if (!kept.length) {
      rejected.push(`${d.title}: no quote was found in the transcript`);
      continue;
    }
    await db.insert(schema.cards).values({
      id: id("card"),
      userId: uid,
      schemaVersion: 1,
      type: "action",
      actionType: d.action_type,
      status: "proposed",
      title: d.title,
      summary: d.summary,
      confidence: Math.max(0, Math.min(1, d.confidence)),
      priority: d.priority,
      sourceJson: src,
      payload: d.payload,
      context: {
        why: kept.map((e) => ({ who: e.who, text: e.text })),
        entities: d.entities,
        links: d.links ?? [src.title],
        ...(d.caveat ? { caveat: d.caveat } : {}),
      },
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000), // match extraction's 7-day card TTL
      simulated: false,
      transcriptId: ownedTranscript.id,
      meetingId,
      // Drafted outside this server, so the server cannot know which model or prompt wrote it.
      model: "external",
      promptVersion: "external",
    });
    inserted++;
    titles.push(d.title);
  }
  if (inserted > 0) {
    await db
      .update(schema.transcripts)
      .set({ extractedAt: new Date() })
      .where(eq(schema.transcripts.id, ownedTranscript.id));
    // The practice card's whole point is to disappear the moment real work shows up; a user still
    // looking at "Give Haii a few minutes" next to an actual commitment is a confusing product.
    // It was never counted by anything (lib/metrics.notSimulated), so expiring it here only ever
    // changes what the deck shows, never a number already reported.
    await db
      .update(schema.cards)
      .set({ status: "expired" })
      .where(and(eq(schema.cards.userId, uid), eq(schema.cards.simulated, true), eq(schema.cards.status, "proposed")));
    await tgSend(
      uid,
      `🃏 <b>${inserted} card${inserted === 1 ? "" : "s"}</b> proposed from "${escapeHtml(src.title)}"\n${titles.map((t) => `• ${escapeHtml(t)}`).join("\n")}\n\nDecide: ${env.APP_URL}`,
    );
  }
  return c.json({ ok: true, inserted, rejected });
});

/** A finished brief for one of the caller's meetings, written outside this server. Stored as
 *  given. With `push`, the TL;DR also goes to the caller's Telegram. */
api.post("/api/v1/briefings", requireAdmin, async (c) => {
  const uid = c.get("userId") as string;
  const body = await c.req.json<{ meeting_id: string; content: any; push?: boolean }>();
  if (!body.meeting_id || !body.content?.tldr) {
    return c.json({ error: "meeting_id and content.tldr required" }, 400);
  }
  const ms = await db
    .select()
    .from(schema.meetings)
    .where(and(eq(schema.meetings.id, body.meeting_id), eq(schema.meetings.userId, uid)));
  if (!ms[0]) return c.json({ error: "meeting not found" }, 404);
  const bid = id("brf");
  await db.insert(schema.briefings).values({
    id: bid,
    userId: uid,
    meetingId: body.meeting_id,
    model: "external",
    promptVersion: "external",
    contentJson: body.content,
    deliveredAt: body.push ? new Date() : null,
  });
  if (body.push) {
    const tzRows = await db.select().from(schema.users).where(eq(schema.users.id, uid));
    // Telegram push: written for a person, so it follows their locale, not en-GB.
    const hhmm = hhmmForUser(userTz(tzRows[0]?.tz), tzRows[0]?.locale, ms[0].startsAt);
    await tgSend(
      uid,
      `🧠 <b>${escapeHtml(ms[0].title)}</b> at ${hhmm}\n\n${escapeHtml(body.content.tldr)}\n\nFull brief: ${env.APP_URL}/#brief-${bid}`,
    );
  }
  return c.json({ ok: true, briefing_id: bid });
});

/** Meetings and items for the caller's own account, from outside the connectors. Meetings are
 *  upserted by external_id. Items go through upsertItems, the same path the connector polls use. */
api.post("/api/v1/ingest", requireAdmin, async (c) => {
  const uid = c.get("userId") as string;
  const body = await c.req.json<{
    meetings?: Array<{
      external_id?: string;
      title: string;
      starts_at: string;
      ends_at?: string;
      attendees?: Array<{ email?: string; name?: string }>;
      location?: string;
    }>;
    items?: Array<{
      connector: string;
      external_id: string;
      kind: string;
      author?: string;
      title?: string;
      body_text?: string;
      url?: string;
      ts: string;
    }>;
  }>();

  let meetings = 0;
  for (const m of body.meetings ?? []) {
    if (!m.title || !m.starts_at) continue;
    // Meeting ids are per-user (mtg_${uid}_${extId}), matching gcal.ts: a global mtg_${extId}
    // would collide when two users ingest the same event. An existing row is found via
    // (user_id, external_id) and updated in place, whatever format its id has.
    let mid = m.external_id ? `mtg_${uid}_${m.external_id}` : id("mtg");
    if (m.external_id) {
      const existing = await db
        .select({ id: schema.meetings.id })
        .from(schema.meetings)
        .where(and(eq(schema.meetings.userId, uid), eq(schema.meetings.externalId, m.external_id)));
      if (existing[0]) mid = existing[0].id;
    }
    const values = {
      id: mid,
      userId: uid,
      source: "bridge",
      externalId: m.external_id ?? null,
      title: m.title,
      startsAt: new Date(m.starts_at),
      endsAt: m.ends_at ? new Date(m.ends_at) : null,
      attendees: m.attendees ?? [],
      location: m.location ?? "",
    };
    await db
      .insert(schema.meetings)
      .values(values)
      .onConflictDoUpdate({
        target: schema.meetings.id,
        set: {
          title: values.title,
          startsAt: values.startsAt,
          endsAt: values.endsAt,
          attendees: values.attendees,
          location: values.location,
        },
      });
    meetings++;
  }

  const CMAP: Record<string, ConnectorId> = {
    gmail: "google",
    gcal: "google",
    drive: "google",
    slack: "slack",
    jira: "jira",
  };
  const groups = new Map<ConnectorId, RawItem[]>();
  for (const it of body.items ?? []) {
    if (!it.external_id || !it.ts) continue;
    const meta = CMAP[it.connector] ?? "google";
    const arr = groups.get(meta) ?? [];
    arr.push({
      connector: it.connector,
      external_id: it.external_id,
      kind: it.kind || "note",
      author: it.author,
      title: it.title,
      body_text: it.body_text,
      url: it.url,
      ts: new Date(it.ts),
    });
    groups.set(meta, arr);
  }
  let items = 0;
  for (const [conn, arr] of groups) items += await upsertItems(conn, arr, uid);
  return c.json({ ok: true, meetings, items });
});

/** The north star, computed honestly, per user per ISO week.
 *
 *  Exists because this number was defined on paper long before anything
 *  computed it. /stats is the user's learning strip and /admin/overview counts decisions, not
 *  outcomes. So the one number that matters had no instrument at all.
 *
 *  `executed` here means the artifact was created in a system outside Haii. A todo, which lives in
 *  Haii's own table, and a card blocked on a missing connector are each reported separately rather
 *  than folded in, because the first question anyone serious will ask is what the number includes.
 *  See lib/metrics.ts.
 *
 *  Weeks are the USER's weeks (their timezone), because a decision at 00:30 Monday at UTC+3
 *  belongs to the new week even though UTC still says Sunday. Spend is bucketed by the ledger's own
 *  UTC day and so can straddle a week edge by a few hours; immaterial at this volume, and flagged
 *  rather than silently reconciled. */
api.get("/api/v1/admin/metrics", requireAdmin, async (c) => {
  const weeks = Math.min(Math.max(Number(c.req.query("weeks") ?? 6), 1), 52);
  const since = new Date(Date.now() - weeks * 7 * 24 * 3600_000);

  const allUsers = await db.select().from(schema.users).orderBy(schema.users.createdAt);
  const rows: Record<string, Record<string, WeekTally & { spend: number }>> = {};
  const bucket = (uid: string, wk: string) => {
    const forUser = (rows[uid] ??= {});
    return (forUser[wk] ??= { ...emptyTally(), spend: 0 });
  };

  for (const u of allUsers) {
    const tz = userTz(u.tz);
    const cards = await db
      .select({
        status: schema.cards.status,
        actionType: schema.cards.actionType,
        feedback: schema.cards.feedback,
        createdAt: schema.cards.createdAt,
        decidedAt: schema.cards.decidedAt,
        expiresAt: schema.cards.expiresAt,
      })
      .from(schema.cards)
      .where(and(eq(schema.cards.userId, u.id), gte(schema.cards.createdAt, since), notSimulated));

    for (const card of cards) {
      bucket(u.id, isoWeek(dayKeyInTz(tz, card.createdAt))).proposed++;
      // An outcome belongs to the week the user ACTED, not the week the card was proposed. Expired
      // cards were never acted on, so they belong to the week they died.
      const at = card.decidedAt ?? (card.status === "expired" ? card.expiresAt : null);
      if (!at) continue;
      const t = bucket(u.id, isoWeek(dayKeyInTz(tz, at)));
      // Folding lives in lib/metrics.tallyCard so it is unit-testable without a database. See the
      // note there: a blanket t[outcome]++ used to count every shake twice.
      tallyCard(t, card);
    }

    const ledger = await db
      .select({ day: schema.llmLedger.day, cost: schema.llmLedger.costUsd })
      .from(schema.llmLedger)
      .where(and(eq(schema.llmLedger.userId, u.id), gte(schema.llmLedger.createdAt, since)));
    for (const l of ledger) bucket(u.id, isoWeek(l.day)).spend += l.cost;
  }

  const weekKeys = [...new Set(Object.values(rows).flatMap((r) => Object.keys(r)))].sort();
  const byName = new Map(allUsers.map((u) => [u.id, u.name || u.email || u.id]));

  const out = weekKeys.map((wk) => {
    const users = allUsers
      .filter((u) => rows[u.id]?.[wk])
      .map((u) => {
        const t = rows[u.id][wk];
        return {
          user: byName.get(u.id),
          ...t,
          spend_usd: Number(t.spend.toFixed(4)),
          approval_rate: approvalRate(t),
          cost_per_executed: t.executed ? Number((t.spend / t.executed).toFixed(3)) : null,
        };
      });
    const sum = (k: keyof WeekTally) => users.reduce((a, u) => a + (u[k] as number), 0);
    const spend = users.reduce((a, u) => a + u.spend_usd, 0);
    const executed = sum("executed");
    // "Active": at least one card decision in the week.
    const active = users.filter((u) => u.decided > 0).length;
    return {
      week: wk,
      users,
      totals: {
        active_users: active,
        proposed: sum("proposed"),
        decided: sum("decided"),
        executed,
        captured: sum("captured"),
        blocked: sum("blocked"),
        failed: sum("failed"),
        expired: sum("expired"),
        spend_usd: Number(spend.toFixed(4)),
        north_star_executed_per_active_user: active ? Number((executed / active).toFixed(2)) : null,
        cost_per_executed: executed ? Number((spend / executed).toFixed(3)) : null,
      },
    };
  });

  // ---- Instance-wide, all time. The weekly rows above answer "is it working"; this answers "what
  // has it done in total". Deliberately a separate cut: totals since day one and a rolling window
  // are different numbers, and mixing them produces a figure nobody can rebuild.
  const [allCards, allMeetings, allBriefs, allTranscripts, allConns] = await Promise.all([
    db
      .select({
        userId: schema.cards.userId, status: schema.cards.status, actionType: schema.cards.actionType,
        feedback: schema.cards.feedback, context: schema.cards.context, meetingId: schema.cards.meetingId,
        transcriptId: schema.cards.transcriptId, undoCount: schema.cards.undoCount,
      })
      // Every figure below (outcomes, by_action_type, right-swipe rate, ever_decided, undos,
      // evidence fidelity) is built from this one query, so notSimulated here is what keeps the
      // whole instance-wide report free of tutorial decisions, not just the weekly tally above.
      .from(schema.cards)
      .where(notSimulated),
    db.select().from(schema.meetings),
    db.select({ meetingId: schema.briefings.meetingId }).from(schema.briefings),
    db
      .select({ id: schema.transcripts.id, source: schema.transcripts.source,
        meetingId: schema.transcripts.meetingId, contentMd: schema.transcripts.contentMd })
      .from(schema.transcripts),
    db.select({ id: schema.connections.id, status: schema.connections.status }).from(schema.connections),
  ]);

  const byType: Record<string, { created: number; executed: number; captured: number; blocked: number; failed: number }> = {};
  const o = { executed: 0, captured: 0, blocked: 0, failed: 0, dismissed: 0, expired: 0, pending: 0 };
  let approved = 0, edited = 0, dismissed = 0, undos = 0;
  const via: Record<string, number> = {};
  let quotesChecked = 0, quotesFound = 0;
  // Grade the model on the text it was actually given, not the raw file.
  //
  // Extraction reads `cleanTranscript(contentMd)`, not `contentMd`: timestamp-only lines removed,
  // leading inline timestamps stripped, runs of blank lines collapsed. A quote spanning a removed
  // line is verbatim in what the model read and absent from the raw text, so checking the raw text
  // counts it as unfindable. Whitespace differences are not the problem (normalizeForQuoteMatch
  // folds those); a DELETED line is, because the two sides of the join were never adjacent in the
  // original.
  //
  // Marking a model wrong for quoting exactly what we handed it is the worst kind of metric error:
  // it is invisible, it points at the wrong fix, and the fix it points at is a prompt change that
  // would have made real quotes vaguer to satisfy a broken test.
  const transcriptText = new Map(allTranscripts.map((t) => [t.id, cleanTranscript(t.contentMd)]));
  // Which transcripts arrived on their own vs which a human pasted in. Cards inherit the
  // distinction, and it is the difference between "the product worked" and "someone fed it by hand".
  // Every source except "paste" arrives without a person: Drive, the notetakers and Slack.
  const autoTranscripts = new Set(allTranscripts.filter((t) => t.source !== "paste").map((t) => t.id));
  const origin = { automatic: 0, pasted: 0, unlinked: 0 };
  const executedOrigin = { automatic: 0, pasted: 0, unlinked: 0 };
  const perUser: Record<string, { right: number; decided: number }> = {};
  const deciders = new Set<string>();
  const cardMeetings = new Set<string>();
  const cardTranscripts = new Set<string>();
  for (const card of allCards) {
    undos += card.undoCount ?? 0;
    const src = card.transcriptId ? transcriptText.get(card.transcriptId) : null;
    if (src) {
      const quotes = ((card.context as { why?: { text?: string }[] } | null)?.why ?? [])
        .map((q) => q?.text ?? "")
        .filter(Boolean);
      const f = quoteFidelity(quotes, src);
      quotesChecked += f.checked;
      quotesFound += f.found;
    }
    const t = (byType[card.actionType] ??= { created: 0, executed: 0, captured: 0, blocked: 0, failed: 0 });
    t.created++;
    if (card.meetingId) cardMeetings.add(card.meetingId);
    if (card.transcriptId) cardTranscripts.add(card.transcriptId);
    const outcome = classifyCard(card);
    o[outcome]++;
    if (outcome === "executed" || outcome === "captured" || outcome === "blocked" || outcome === "failed") t[outcome]++;
    const src2 = card.transcriptId ? (autoTranscripts.has(card.transcriptId) ? "automatic" : "pasted") : "unlinked";
    origin[src2]++;
    if (outcome === "executed") executedOrigin[src2]++;

    const fb = card.feedback as { decision?: string; via?: string } | null;
    const decision = fb?.decision;
    if (decision === "approved" || decision === "edited" || decision === "dismissed") {
      const p = (perUser[card.userId] ??= { right: 0, decided: 0 });
      p.decided++;
      if (decision !== "dismissed") p.right++;
    }
    if (decision === "approved") { approved++; deciders.add(card.userId); }
    else if (decision === "edited") { edited++; deciders.add(card.userId); }
    else if (decision === "dismissed") { dismissed++; deciders.add(card.userId); }
    // A decision with no `via` is counted as unknown rather than dropped, so the denominator stays
    // honest instead of quietly excluding it.
    if (decision) via[fb?.via ?? "unknown"] = (via[fb?.via ?? "unknown"] ?? 0) + 1;
  }
  const swiped = approved + edited + dismissed;
  const briefedMeetings = new Set(allBriefs.map((b) => b.meetingId).filter(Boolean) as string[]);

  const instance = {
    users: { total: allUsers.length, ever_decided: deciders.size },
    meetings: (() => {
      // Coverage is measured against meetings that (a) SHOULD have been briefed, so "Lunch",
      // "Focus time" and declined invites are excluded because counting them would invent a failure
      // rate, and (b) have actually HAPPENED inside the reporting window.
      //
      // (b) is not a detail. Measuring against every meeting ever synced counts events scheduled
      // months ahead, which cannot have a transcript yet, so coverage would fall as the calendar
      // filled up and read like a regression. A synced calendar is mostly future recurring
      // instances, so that count dwarfs the meetings that have actually happened and the coverage
      // figure becomes meaningless.
      const now = Date.now();
      // A meeting that happened before its owner signed up could never have had a Haii transcript,
      // so counting it as a miss is not a measurement, it is a guaranteed understatement. Worse, it
      // gets WORSE with every new user: onboarding someone drags in their pre-Haii calendar and
      // coverage falls, which is exactly backwards. The floor is therefore per user, not global.
      //
      // users.created_at is a proxy for "when Haii started watching". The honest instrument is the
      // connector's first-connected timestamp, which is not recorded yet; until it is, this
      // slightly UNDER-counts (someone who connected Google days after signing up). Erring toward a
      // pessimistic coverage figure is the safer direction.
      const joined = new Map(allUsers.map((u) => [u.id, u.createdAt.getTime()]));
      const happened = allMeetings.filter((m) => {
        if (!isBriefWorthy(m)) return false;
        if ((m.endsAt ?? m.startsAt).getTime() >= now) return false;
        const floor = Math.max(since.getTime(), joined.get(m.userId) ?? since.getTime());
        return m.startsAt.getTime() >= floor;
      });
      const withTranscript = new Set(allTranscripts.map((t) => t.meetingId).filter(Boolean) as string[]);
      const covered = happened.filter((m) => withTranscript.has(m.id)).length;
      const briefed = happened.filter((m) => briefedMeetings.has(m.id)).length;
      return {
        total_synced: allMeetings.length,
        // The denominator for both rates below: brief-worthy, in-window, already over.
        happened_in_window: happened.length,
        briefed,
        brief_coverage: happened.length ? Number((briefed / happened.length).toFixed(3)) : null,
        // The hidden ceiling on the whole product: no transcript, no cards, however good extraction
        // gets. This is the measured figure, not a guess.
        with_transcript: covered,
        transcript_coverage: happened.length ? Number((covered / happened.length).toFixed(3)) : null,
      };
    })(),
    transcripts: {
      total: allTranscripts.length,
      // The honest split. A pasted transcript is a human doing the ingestion by hand. Everything
      // else arrived on its own.
      automatic: allTranscripts.filter((t) => t.source !== "paste").length,
      pasted: allTranscripts.filter((t) => t.source === "paste").length,
    },
    cards: {
      created: allCards.length,
      from_meetings: cardMeetings.size,
      from_transcripts: cardTranscripts.size,
      swiped,
      approved, edited, dismissed,
      // A right swipe is approve OR edit-then-approve; only a shake is a left swipe.
      right_swipe_rate: swiped ? Number(((approved + edited) / swiped).toFixed(3)) : null,
      // The pooled rate above is a volume-weighted average, so whoever decides most cards sets it.
      // Two users can sit far apart behind one pooled figure, and the single number hides that
      // entirely. Read the spread to judge the product.
      right_swipe_rate_by_user: Object.fromEntries(
        allUsers
          .filter((u) => perUser[u.id]?.decided)
          .map((u) => [u.name || u.email || u.id,
            { rate: Number((perUser[u.id].right / perUser[u.id].decided).toFixed(3)), decided: perUser[u.id].decided }]),
      ),
      // "It works automatically" is only true of the automatic half. A pasted transcript is a human
      // doing the ingestion, and cards born from one are not evidence the loop closes unattended.
      origin,
      executed_by_origin: executedOrigin,
      still_pending: o.pending,
      expired_undecided: o.expired,
      // Approve-then-take-it-back within the 5s window. Precision that only shows up after a swipe.
      undos,
      // How each decision was made: swipe, button, key, sheet or timeout. Older rows read "unknown".
      decided_via: via,
    },
    evidence: {
      // Deterministic substring check of each card's quotes against its own transcript. No model.
      quotes_checked: quotesChecked,
      quotes_found: quotesFound,
      fidelity: quotesChecked ? Number((quotesFound / quotesChecked).toFixed(3)) : null,
    },
    outcomes: {
      // The combined figure, and the split underneath it. Completed includes to-dos kept in Haii.
      // Executed is the strict one.
      completed: o.executed + o.captured,
      executed: o.executed,
      captured: o.captured,
      blocked: o.blocked,
      failed: o.failed,
    },
    by_action_type: byType,
    tools: {
      // Two different counts. Connected streams are not card sources, so do not read one as the other.
      streams_connected: new Set(allConns.filter((x) => x.status === "connected").map((x) => x.id)).size,
      // Cards currently originate from transcripts only, whatever else is connected.
      card_sources: ["meeting transcripts"],
      executed_into: [...new Set(
        allCards.filter((x) => classifyCard(x) === "executed").map((x) => x.actionType),
      )],
    },
  };

  return c.json({
    instance,
    definition: {
      north_star: "executed = the artifact was created in a system OUTSIDE Haii, so the work is done rather than remembered. A todo lives in Haii's own table; a Gmail draft, a calendar event and a Slack post do not",
      counts_as_executed: Object.keys(LEAVES_HAII).filter((k) => LEAVES_HAII[k]),
      reported_separately: {
        captured: "approved and completed, but the artifact never left Haii's own database (today: todos only)",
        blocked: "approved, but the connector was missing, so it became a follow-up instead",
        failed: "approved, and the attempt threw",
      },
      caveat: "weeks are each user's local ISO week; spend is bucketed by the ledger's UTC day and can straddle a week edge",
    },
    weeks: out,
  });
});

/** Where cards come from, and what happened to them. Exists to compare cards from automatic
 *  transcripts with cards from hand-pasted ones. Two explanations for a gap between them need
 *  this exact breakdown: automatic cards skewing to create_todo (which cannot count as executed by
 *  construction, see LEAVES_HAII) versus arriving and sitting undecided. Cards with no transcript
 *  report origin "promoted": in the app, only a follow-up sent on as a card has none. The practice
 *  card is excluded like every other metric surface. Small-scale aggregation in JS on purpose,
 *  same as the overview above. */
api.get("/api/v1/admin/card-origins", requireAdmin, async (c) => {
  const all = await db
    .select({
      actionType: schema.cards.actionType,
      status: schema.cards.status,
      feedback: schema.cards.feedback,
      transcriptId: schema.cards.transcriptId,
    })
    .from(schema.cards)
    .where(notSimulated);
  const trs = await db
    .select({ id: schema.transcripts.id, source: schema.transcripts.source })
    .from(schema.transcripts);
  const srcOf = new Map(trs.map((t) => [t.id, t.source]));

  const origins: Record<string, Record<string, Record<string, number>>> = {};
  for (const card of all) {
    const origin = card.transcriptId ? (srcOf.get(card.transcriptId) ?? "missing") : "promoted";
    const outcome = classifyCard(card);
    const byType = (origins[origin] ??= {});
    const tally = (byType[card.actionType] ??= {});
    tally[outcome] = (tally[outcome] ?? 0) + 1;
  }
  return c.json({
    definition: {
      origin: "transcripts.source of the card's transcript: drive, slack and the notetakers (fireflies, fathom, otter) arrived on their own, paste = hand-pasted; missing = the transcript was deleted; promoted = a follow-up sent on as a card, which has no transcript",
      outcome: "classifyCard: executed means the artifact was created outside Haii, captured means it never left Haii's own database (todos), see /api/v1/admin/metrics definition",
    },
    origins,
  });
});

api.get("/api/v1/jobs", requireAdmin, async (c) => {
  // `job` and `limit` exist because "did distillation run on Monday?" was UNANSWERABLE from here.
  // The list was a flat 60 rows newest-first, and the pollers write dozens an hour, so anything
  // weekly had fallen off the end long before anyone thought to look. Absence of evidence was
  // reading as evidence of absence for every job that does not run constantly.
  const jobFilter = String(c.req.query("job") ?? "").trim();
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 60));
  const runs = await db
    .select()
    .from(schema.jobRuns)
    .where(jobFilter ? eq(schema.jobRuns.job, jobFilter) : undefined)
    .orderBy(desc(schema.jobRuns.startedAt))
    .limit(limit);
  const spend = await todaySpend();
  const ledger = await db
    .select()
    .from(schema.llmLedger)
    .orderBy(desc(schema.llmLedger.createdAt))
    .limit(20);
  return c.json({ runs, spend_today: spend, ledger });
});

api.post("/api/v1/jobs/:name/run", requireAdmin, async (c) => {
  const uid = c.get("userId") as string;
  const name = c.req.param("name");
  if (name === "briefing_next") {
    const detail = await runJob("briefing_generate", uid, () => briefNext(uid));
    return c.json({ ok: true, detail });
  }
  const fn = MANUAL_JOBS[name];
  if (!fn) return c.json({ error: `unknown job. available: ${Object.keys(MANUAL_JOBS).join(", ")}, briefing_next` }, 404);
  const detail = await runJob(name, uid, () => fn(uid));
  return c.json({ ok: true, detail });
});

/** Instance health snapshot: spend, job errors, and a per-user roster for the admin to eyeball
 *  activation/approval/spend without digging through job_runs or the ledger by hand. Queries are
 *  simple and N+1 per user on purpose; the roster is small. */
api.get("/api/v1/admin/overview", requireAdmin, async (c) => {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600_000);
  const dayAgo = new Date(Date.now() - 24 * 3600_000);

  const monthSpend = await instanceMonthSpend();
  const errRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.jobRuns)
    .where(and(eq(schema.jobRuns.status, "error"), gte(schema.jobRuns.startedAt, dayAgo)));

  const allUsers = await db.select().from(schema.users).orderBy(schema.users.createdAt);

  const users: Record<string, unknown>[] = [];
  for (const u of allUsers) {
    const conns = await db.select().from(schema.connections).where(eq(schema.connections.userId, u.id));
    const statusOf = (connId: string) => conns.find((x) => x.id === connId)?.status ?? "disconnected";
    const googleStatus = statusOf("google");

    // notSimulated on all three below: "activated" and the two rates are exactly the numbers a
    // tutorial swipe would inflate for free if left unfiltered, and this endpoint is the one an
    // operator actually reads to judge whether a user is real.
    const decidedAny = await db
      .select({ id: schema.cards.id })
      .from(schema.cards)
      .where(and(eq(schema.cards.userId, u.id), isNotNull(schema.cards.decidedAt), notSimulated))
      .limit(1);

    const dec7Rows = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.cards)
      .where(
        and(
          eq(schema.cards.userId, u.id),
          isNotNull(schema.cards.decidedAt),
          gte(schema.cards.decidedAt, sevenDaysAgo),
          notSimulated,
        ),
      );

    // Trailing-20 approval rate across every action type: same shape as approvalStats in
    // jobs/extract.ts (approved+edited over decided), minus the per-type bucketing. This is a
    // single instance-wide health number per user, not a per-action-type suppression signal.
    const trailing = await db
      .select({ feedback: schema.cards.feedback })
      .from(schema.cards)
      .where(and(eq(schema.cards.userId, u.id), isNotNull(schema.cards.feedback), notSimulated))
      .orderBy(desc(schema.cards.decidedAt))
      .limit(20);
    let approved = 0;
    let decided = 0;
    for (const row of trailing) {
      // Same rule as the suppression stats and the weekly tally: a "later" deferral is neither an
      // approval nor a rejection, so it leaves the denominator. See approvalSignal.
      const signal = approvalSignal(row.feedback);
      if (signal === "ignore") continue;
      decided++;
      if (signal === "approved") approved++;
    }

    const briefs7Rows = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.briefings)
      .where(
        and(
          eq(schema.briefings.userId, u.id),
          isNotNull(schema.briefings.deliveredAt),
          gte(schema.briefings.deliveredAt, sevenDaysAgo),
        ),
      );

    users.push({
      id: u.id,
      name: u.name,
      email: u.email,
      last_seen_at: u.lastSeenAt,
      is_admin: u.isAdmin,
      telegram_linked: Boolean(u.telegramChatId),
      google: googleStatus,
      jira: statusOf("jira"),
      slack: statusOf("slack"),
      activated: googleStatus === "connected" && decidedAny.length > 0,
      decisions_7d: Number(dec7Rows[0]?.n ?? 0),
      approval_rate_trailing20: { rate: decided ? approved / decided : 1, n: decided },
      briefs_delivered_7d: Number(briefs7Rows[0]?.n ?? 0),
      // Are briefs READ at all? Behaviour before opinion: if read_seconds stays near zero, tuning
      // the briefing prompt from ratings would be polishing something nobody opens.
      briefs_read: await (async () => {
        const rows = await db
          .select({ n: sql<number>`count(*)`, avg: sql<number>`coalesce(avg(read_seconds),0)` })
          .from(schema.briefings)
          .where(and(eq(schema.briefings.userId, u.id), isNotNull(schema.briefings.readSeconds)));
        return { with_read_time: Number(rows[0]?.n ?? 0), avg_seconds: Math.round(Number(rows[0]?.avg ?? 0)) };
      })(),
      // Which card types the suppression rule is currently holding back for this user. Without
      // this it fires silently and nothing can say whether it is firing at all.
      suppressed_types: Object.entries(await approvalStats(u.id))
        .filter(([, s]) => s.n >= 5 && s.rate < 0.2)
        .map(([t]) => t),
      // Measures the second-brain loop: distillation should move this off zero, and a user at the
      // 40 cap is a user whose memory is full and being revised.
      memories: (await listMemories(u.id)).length,
      // DOES MEMORY CHANGE ANYTHING? Until now nothing could answer that, so every memory feature
      // was unfalsifiable: the corpus could grow forever and no number would move either way.
      //
      // The extract manifest already records every source that reached the prompt, memory included
      // (jobs/extract.ts builds it, and it is stored on context.manifest of every card that
      // extraction produced). So the cards SPLIT cleanly into ones the model wrote while holding
      // this user's memory and ones it wrote blind, and their approval rates are directly
      // comparable: same extractor, same prompt version, same user, one input different.
      //
      // Read it as a DIRECTION, not a verdict. Nobody randomised which meetings happened after the
      // corpus filled, so a gap here is evidence worth chasing, not proof. The honest version of
      // this question needs a scored eval harness, and this is what can be known before one exists.
      memory_effect: await (async () => {
        const rows = await db
          .select({
            withMem: sql<number>`count(*) filter (where jsonb_path_exists(${schema.cards.context}, '$.manifest[*] ? (@.source == "memory")'))::int`,
            withMemOk: sql<number>`count(*) filter (where jsonb_path_exists(${schema.cards.context}, '$.manifest[*] ? (@.source == "memory")') and feedback->>'decision' in ('approved','edited'))::int`,
            withMemDecided: sql<number>`count(*) filter (where jsonb_path_exists(${schema.cards.context}, '$.manifest[*] ? (@.source == "memory")') and feedback->>'decision' is not null)::int`,
            without: sql<number>`count(*) filter (where not jsonb_path_exists(${schema.cards.context}, '$.manifest[*] ? (@.source == "memory")'))::int`,
            withoutOk: sql<number>`count(*) filter (where not jsonb_path_exists(${schema.cards.context}, '$.manifest[*] ? (@.source == "memory")') and feedback->>'decision' in ('approved','edited'))::int`,
            withoutDecided: sql<number>`count(*) filter (where not jsonb_path_exists(${schema.cards.context}, '$.manifest[*] ? (@.source == "memory")') and feedback->>'decision' is not null)::int`,
          })
          .from(schema.cards)
          .where(and(eq(schema.cards.userId, u.id), notSimulated));
        const r = rows[0];
        const rate = (ok: number, n: number) => (n ? Number((ok / n).toFixed(3)) : null);
        return {
          cards_with_memory: Number(r?.withMem ?? 0),
          cards_without_memory: Number(r?.without ?? 0),
          // Null rather than 1.0 on an empty set, same rule as approvalRate: "nothing decided yet"
          // and "everything approved" are opposite facts and must not render as the same number.
          approval_with_memory: rate(Number(r?.withMemOk ?? 0), Number(r?.withMemDecided ?? 0)),
          approval_without_memory: rate(Number(r?.withoutOk ?? 0), Number(r?.withoutDecided ?? 0)),
        };
      })(),
      spend_today: await userSpendToday(u.id),
      spend_month: await userSpendMonth(u.id),
    });
  }

  return c.json({
    instance: {
      month_spend: monthSpend,
      monthly_cap: env.MONTHLY_CAP_USD,
      jobs_errors_24h: Number(errRows[0]?.n ?? 0),
    },
    users,
  });
});

api.use("/api/v1/*", requireUser);

/* ---------------- feed ---------------- */

api.get("/api/v1/feed", async (c) => {
  const uid = c.get("userId") as string;
  const now = new Date();
  // fetched up front: the user's timezone drives every "today" below (day strip, digest key)
  const urows = await db.select().from(schema.users).where(eq(schema.users.id, uid));
  const u = urows[0];
  const tz = userTz(u?.tz);
  // "Up next" = the earliest meeting that has not ENDED yet, so a meeting in progress stays in the
  // hero (Happening now) instead of the hero jumping to the next future meeting. A start-based
  // window dropped an ongoing meeting 30 min after it started and showed a later meeting while one
  // was live. Ongoing wins because it sorts earliest by startsAt. Events with no endsAt fall back
  // to a start-based window.
  const graceStart = new Date(now.getTime() - 30 * 60_000);
  const next = await db
    .select()
    .from(schema.meetings)
    .where(
      and(
        eq(schema.meetings.userId, uid),
        or(
          gt(schema.meetings.endsAt, now),
          and(isNull(schema.meetings.endsAt), gte(schema.meetings.startsAt, graceStart)),
        ),
      ),
    )
    .orderBy(schema.meetings.startsAt)
    .limit(1);
  let briefing: any = null;
  if (next[0]) {
    const b = await db
      .select()
      .from(schema.briefings)
      .where(and(eq(schema.briefings.userId, uid), eq(schema.briefings.meetingId, next[0].id)))
      .orderBy(desc(schema.briefings.createdAt))
      .limit(1);
    briefing = b[0] ?? null;
  }
  // Deferred cards come back here rather than on a timer, because the thin-deck rule needs to know
  // the deck is thin and this is the only moment that is true. Writes on a read, deliberately: the
  // alternative is a 10-minute job that leaves someone staring at an empty deck for nine of them.
  await wakeSnoozed(uid);

  // The practice card (lib/practice.ts): a brand-new user's deck is otherwise empty until their
  // first meeting WITH notes produces a real card, which can take days, and the first-run swipe
  // coach never fires without a card to fire it on. Guarded on ZERO cards ever, of ANY status
  // (including a prior practice card), so this can only ever insert once per user and never
  // returns once the real product has shown up. Runs before the `proposed` query below on
  // purpose, so a first-ever load sees it immediately instead of one refresh later.
  const everAny = await db
    .select({ id: schema.cards.id })
    .from(schema.cards)
    .where(eq(schema.cards.userId, uid))
    .limit(1);
  let hasRealCards = false;
  if (!everAny.length) {
    // Deterministic id, so the primary key is what enforces "once per user" rather than the timing
    // of the read above. The guard is check-then-insert and not atomic: two simultaneous first-ever
    // loads both saw zero cards and both inserted, which was harmless (two decidable tutorials, no
    // model spend) but made once-per-user a description of what usually happens instead of a rule.
    // A collision here means another request already won, which IS the desired end state, so it is
    // logged and swallowed: failing a feed load over a tutorial card would be the worse outcome.
    try {
      await db.insert(schema.cards).values(buildPracticeCard(uid, `card_practice_${uid}`, now));
    } catch (e: any) {
      log.info({ userId: uid, err: String(e?.message ?? e) }, "practice card already present, skipping");
    }
  } else {
    // Only worth asking once we know at least one card exists at all; the zero case above already
    // answers it (no cards means no REAL cards either). Feeds the empty-deck copy: "all clear, you
    // decided everything" is a different, truer sentence than "your first card has not arrived",
    // and only a user who has actually seen a real card gets the former.
    const realRows = await db
      .select({ id: schema.cards.id })
      .from(schema.cards)
      .where(and(eq(schema.cards.userId, uid), notSimulated))
      .limit(1);
    hasRealCards = realRows.length > 0;
  }
  // Cheap count for the same empty-deck copy: read AFTER wakeSnoozed so it reflects what is still
  // actually deferred, not cards that just returned to the live deck above.
  const snoozedCountRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.cards)
    .where(and(eq(schema.cards.userId, uid), eq(schema.cards.status, "snoozed")));
  const snoozedCount = Number(snoozedCountRows[0]?.n ?? 0);

  const proposed = await db
    .select()
    .from(schema.cards)
    .where(and(eq(schema.cards.userId, uid), eq(schema.cards.status, "proposed")))
    .orderBy(
      // The practice card sorts ahead of everything for as long as it exists. Its whole job is to
      // be the first thing swiped, and priority plus confidence left that to chance: a real
      // high-priority card arriving in the same load would have buried the tutorial underneath it.
      sql`case when ${schema.cards.simulated} then 0 else 1 end`,
      sql`case ${schema.cards.priority} when 'high' then 0 when 'normal' then 1 else 2 end`,
      desc(schema.cards.confidence),
    );
  const day = dayKeyInTz(tz, now);
  const digest = await db
    .select()
    .from(schema.digests)
    .where(and(eq(schema.digests.userId, uid), eq(schema.digests.day, day)));
  const since = new Date(now.getTime() - 24 * 3600_000);
  const itemCount = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.items)
    .where(and(eq(schema.items.userId, uid), gte(schema.items.ts, since)));

  // The whole day, not just the next meeting: strip fodder for the PWA. Bounds are the USER'S
  // local day (setHours here would be the server's UTC day; on a UTC host that showed yesterday's
  // meetings until 03:00 for a user at UTC+3).
  const { start: dayStart, end: dayEnd } = dayBoundsInTz(tz, now);
  const todays = await db
    .select()
    .from(schema.meetings)
    .where(
      and(
        eq(schema.meetings.userId, uid),
        gte(schema.meetings.startsAt, dayStart),
        lte(schema.meetings.startsAt, dayEnd),
      ),
    )
    .orderBy(schema.meetings.startsAt);
  const briefBy = new Map<string, string>();
  if (todays.length) {
    const briefRows = await db
      .select({ id: schema.briefings.id, meetingId: schema.briefings.meetingId, createdAt: schema.briefings.createdAt })
      .from(schema.briefings)
      .where(and(eq(schema.briefings.userId, uid), inArray(schema.briefings.meetingId, todays.map((t) => t.id))));
    for (const b of briefRows.sort((a, b2) => a.createdAt.getTime() - b2.createdAt.getTime())) {
      if (b.meetingId) briefBy.set(b.meetingId, b.id);
    }
  }

  const conns = await db.select().from(schema.connections).where(eq(schema.connections.userId, uid));
  // Dead-letter: things that failed while nobody was watching. Without this the UI cannot tell a
  // quiet week from a broken one.
  //
  // Shown to admins only for now. The banner copy is not ready for every user.
  //
  // What this costs: a non-admin whose approved action fails gets no in-app notice. The Telegram
  // message the executor sends the card's owner is the only thing that tells them, so keep that
  // path while this check stands. A user with no linked Telegram hears nothing.
  //
  // Gated on the server on purpose. Hiding it in the client would still send the failure text to
  // every browser.
  //
  // To show it to everyone, delete the isAdmin check.
  const isAdmin = Boolean(u?.isAdmin);
  const failures = isAdmin
    ? await unseenFailures(uid)
    : { total: 0, items: [] as Awaited<ReturnType<typeof unseenFailures>>["items"] };
  return c.json({
    failures: {
      total: failures.total,
      items: failures.items.map((f) => ({
        id: f.id,
        kind: f.kind,
        title: f.title,
        detail: f.detail,
        at: f.createdAt,
      })),
    },
    user: {
      id: uid,
      name: u?.name ?? uid,
      role: u?.role ?? "",
      is_admin: u?.isAdmin ?? false,
      telegram_linked: Boolean(u?.telegramChatId),
      tz,
      tz_pinned: u?.tzPinned ?? false,
      email: u?.email ?? "",
      created_at: u?.createdAt ?? null,
      owns: u?.owns ?? "",
      catches: (u?.catches as string[] | null) ?? [],
      // A local install has no sign-in to learn a name from. Extraction needs the name people say
      // in a meeting to know which speaker is the user, so first run asks while this is true.
      needs_name: !u?.name || u.name === uid,
    },
    now: now.toISOString(),
    today_meetings: todays.map((m) => ({
      id: m.id,
      title: m.title,
      starts_at: m.startsAt,
      ends_at: m.endsAt,
      brief_id: briefBy.get(m.id) ?? null,
    })),
    next_meeting: next[0]
      ? {
          ...next[0],
          briefing: briefing
            // written_at so the UI can show a pre-generated brief's age: a 4am batch brief read at
            // 5pm is up to 13 hours old, and that should be visible rather than implied.
            ? { id: briefing.id, content: briefing.contentJson, rating: briefing.rating, note: briefing.feedbackNote, model: briefing.model, prompt_version: briefing.promptVersion, written_at: briefing.createdAt }
            : null,
        }
      : null,
    cards: proposed,
    digest: digest[0]?.contentJson ?? null,
    signals_24h: Number(itemCount[0]?.n ?? 0),
    connections: conns.map((x) => ({ id: x.id, status: x.status })),
    undo_grace_ms: UNDO_GRACE_MS,
    // Both for the empty-deck copy (index.html renderDeck): has_real_cards distinguishes "all
    // clear, you decided everything" from "your first card has not arrived", and snoozed_count
    // lets that first message add "one comes back tomorrow" when true.
    has_real_cards: hasRealCards,
    snoozed_count: snoozedCount,
    // Resumable first run: the client renders whichever step this names, so closing the tab
    // mid-backfill returns you where you were rather than to the start or past it.
    onboarding: u?.onboardingState ?? "new",
  });
});

/* ---------------- first run ----------------
 *  The flow is resumable, so the SERVER owns which step you are on. A client that kept it would
 *  restart the whole thing on a refresh, and the one thing a first run must never do is make
 *  someone sit through the backfill twice. */

/** new -> reading -> first -> questions -> done. Forward only: a client that asks to go back, or asks for a
 *  step that does not exist, is refused rather than obeyed, because the only way to reach an
 *  earlier step is a bug or a tampered request.
 *
 *  A stored state that is not in this list cannot strand anyone: indexOf returns -1, so every
 *  forward request still wins the comparison below and `done` is reachable from there. */
const ONBOARDING_STEPS = ["new", "reading", "first", "questions", "done"];

api.post("/api/v1/onboarding/start", LIMIT_INGEST, async (c) => {
  const uid = c.get("userId") as string;
  // Only the transition OUT of 'new' starts a backfill, and the condition is inside the UPDATE so
  // two callers cannot both win it. Without this a double tap, a retry, or a re-render that lands
  // while the first request is still in flight fires two concurrent backfills. They would not
  // re-read the same transcript (runExtract claims it before the model call), but each picks its
  // own pending ones, so the first run would read twice as many meetings as it promised.
  const started = await db
    .update(schema.users)
    .set({ onboardingState: "reading" })
    .where(and(eq(schema.users.id, uid), eq(schema.users.onboardingState, "new")))
    .returning({ id: schema.users.id });
  // Deliberately NOT awaited. The backfill takes tens of seconds and the reading screen is the
  // thing that makes the wait bearable, so the request returns immediately and the client polls
  // progress. Errors are logged inside runBackfill; there is nothing the caller could do with one.
  if (started.length) void runBackfill(uid).catch((e) => log.error({ userId: uid, err: String(e) }, "backfill failed"));
  return c.json(await backfillProgress(uid));
});

api.get("/api/v1/onboarding/progress", async (c) => {
  return c.json(await backfillProgress(c.get("userId") as string));
});

api.post("/api/v1/onboarding/answers", async (c) => {
  const uid = c.get("userId") as string;
  const body = await c.req
    .json<{ owns?: string; catches?: string[] }>()
    .catch(() => ({}) as { owns?: string; catches?: string[] });
  // Both questions are skippable by design, so empty is a valid answer and must not 400. Capped
  // because these go straight into a prompt: free text a user typed is untrusted length, not
  // untrusted content, and the length is the part that costs money.
  const owns = String(body.owns ?? "").trim().slice(0, 120);
  const catches = Array.isArray(body.catches)
    ? body.catches.filter((x: unknown) => typeof x === "string").slice(0, 10).map((x: string) => x.trim().slice(0, 80))
    : [];
  await db.update(schema.users).set({ owns, catches }).where(eq(schema.users.id, uid));
  return c.json({ ok: true, owns, catches });
});

api.post("/api/v1/onboarding/state", async (c) => {
  const uid = c.get("userId") as string;
  const body = await c.req.json<{ state?: string }>().catch(() => ({}) as { state?: string });
  const want = String(body.state ?? "");
  if (!ONBOARDING_STEPS.includes(want)) {
    return c.json({ error: `state must be one of: ${ONBOARDING_STEPS.join(", ")}` }, 400);
  }
  const rows = await db
    .select({ state: schema.users.onboardingState })
    .from(schema.users)
    .where(eq(schema.users.id, uid));
  const now = ONBOARDING_STEPS.indexOf(rows[0]?.state ?? "new");
  if (ONBOARDING_STEPS.indexOf(want) < now) {
    return c.json({ ok: true, state: rows[0]?.state, skipped: "already past that step" });
  }
  await db.update(schema.users).set({ onboardingState: want }).where(eq(schema.users.id, uid));
  return c.json({ ok: true, state: want });
});

/* ---------------- the second brain, operator controls ----------------
 *  An admin endpoint makes the memory backfill and distillation runnable, repeatable and
 *  observable, and lands their output in job_runs like everything else.
 *
 *  The backfill is a dry run unless `apply` is true. Distill writes, the same as its weekly run.
 *  Both are scoped to ONE user on purpose: what they write is long-term memory, read before every
 *  brief and every extraction, so "all users" is not a default anyone should be able to reach by
 *  forgetting an argument. */

api.post("/api/v1/admin/brain/backfill", requireAdmin, async (c) => {
  const body = await c.req
    .json<{ user_id?: string; apply?: boolean; limit?: number }>()
    .catch(() => ({}) as { user_id?: string; apply?: boolean; limit?: number });
  const target = String(body.user_id ?? "").trim();
  if (!target) return c.json({ error: "user_id required" }, 400);
  const apply = body.apply === true;
  const limit = Math.max(0, Math.min(500, Number(body.limit) || 0));

  // BACKGROUND, and its outcome goes to job_runs. Awaiting it and returning the log in the
  // response loses everything the moment the caller's connection drops, and leaves no record of
  // where or why the run stopped. A job that takes minutes must not report through the socket that
  // asked for it.
  void runJob("brain_backfill", target, async () => {
    const lines: string[] = [];
    const r = await backfillBrainForUser(target, { apply, limit, onLine: (l) => lines.push(l) });
    log.info({ target, apply, ...r }, "brain backfill run");
    // The detail string is what job_runs keeps, so it has to carry the answer on its own: how far
    // it got, why it stopped, and whether anything was written.
    return [
      `${apply ? "apply" : "dry run"}`,
      `${r.mapped}/${r.transcriptsAvailable} read`,
      `${r.skipped} skipped`,
      `${r.candidates} candidates`,
      `${r.memories.length} curated`,
      r.written ? "WRITTEN" : "not written",
      r.stoppedForBudget ? "stopped on budget" : "",
      `$${r.spendBefore.toFixed(2)}→$${r.spendAfter.toFixed(2)}`,
    ].filter(Boolean).join(" · ");
  }).catch((e) => log.error({ target, err: String(e) }, "brain backfill failed"));

  return c.json({ ok: true, started: true, user_id: target, apply, limit,
    note: "runs in the background; read the outcome from /api/v1/jobs?job=brain_backfill" });
});

/** Run distillation for one user now, rather than waiting for Monday 09:00 server time. The weekly
 *  cadence is right for the product and wrong for finding out whether the job works at all. */
api.post("/api/v1/admin/brain/distill", requireAdmin, async (c) => {
  const body = await c.req.json<{ user_id?: string }>().catch(() => ({}) as { user_id?: string });
  const target = String(body.user_id ?? "").trim();
  if (!target) return c.json({ error: "user_id required" }, 400);
  const detail = await runJob("distill_memories", target, () => distillMemories(target));
  return c.json({ ok: true, user_id: target, detail });
});

/* ---------------- decisions ---------------- */

api.post("/api/v1/cards/:id/decision", async (c) => {
  const uid = c.get("userId") as string;
  const cardId = c.req.param("id");
  const body = await c.req.json<{
    decision: "approved" | "edited" | "dismissed" | "snoozed";
    edited_payload?: Record<string, unknown>;
    edit_diff?: string[];
    latency_ms?: number;
    /** How the decision was made. The first-run goal is that a stranger understands the swipe in 10
     *  seconds, and without this nothing records whether anyone swipes at all, so the question is
     *  answerable only by opinion. Also the only way to tell whether the first-run coach earned
     *  its place. Untrusted like any client field: anything unrecognised is stored as "unknown"
     *  rather than rejected, because a decision must never be lost to a telemetry quibble. */
    via?: string;
  }>();
  // The generic above is compile-time only. Without a runtime check every unrecognized value
  // (missing, misspelled, null, a truncated retry, a stale client build) fell through the
  // `=== "dismissed"` branch into approve + execute. For a product whose entire safety story is
  // "nothing fires without a gesture", the default branch must refuse, not approve.
  if (!["approved", "edited", "dismissed", "snoozed"].includes(body?.decision as string)) {
    return c.json({ error: "invalid decision: expected approved | edited | dismissed | snoozed" }, 400);
  }
  const rows = await db.select().from(schema.cards).where(eq(schema.cards.id, cardId));
  const card = rows[0];
  if (!card || card.userId !== uid) return c.json({ error: "not found" }, 404);
  if (card.status !== "proposed") return c.json({ error: `card is ${card.status}` }, 409);

  const feedback = {
    decision: body.decision,
    edited_payload: body.decision === "edited" ? (body.edited_payload ?? null) : null,
    edit_diff: body.edit_diff ?? [],
    latency_ms: body.latency_ms ?? 0,
    // "sheet" is edit-then-approve from the editor, which is a genuinely different act from a
    // one-second swipe and worth separating rather than folding into "button".
    via: ["swipe", "button", "key", "sheet", "timeout"].includes(String(body.via)) ? String(body.via) : "unknown",
    decided_at: new Date().toISOString(),
    original_payload: body.decision === "edited" ? card.payload : undefined,
  };

  const kind = String(card.actionType).replace(/^(send|create)_/, "").replace(/_/g, " ");

  // Later. Not a decision about the card, a decision about now, so it must not reach `feedback`
  // as a dismissal: that is what taught the model to stop proposing things the user wanted.
  if (body.decision === "snoozed") {
    const urows = await db.select({ tz: schema.users.tz }).from(schema.users).where(eq(schema.users.id, uid));
    const count = (card.snoozeCount ?? 0) + 1;
    const now = new Date();
    if (isSnoozeExhausted(card.snoozeCount ?? 0)) {
      // Deferred its limit. Expire rather than dismiss: the user never rejected it, they ran out
      // of road, and History is where a commitment goes to be found again.
      await db
        .update(schema.cards)
        .set({ status: "expired", snoozeCount: count, decidedAt: now })
        .where(eq(schema.cards.id, cardId));
      return c.json({ ok: true, decision: "snoozed", exhausted: true, snooze_count: count });
    }
    const { at, rule, wakeDay } = nextReturn(now, userTz(urows[0]?.tz));
    await db
      .update(schema.cards)
      .set({
        status: "snoozed",
        snoozedUntil: at,
        // The wall-clock intention behind `at`, so a user who changes zone before the card wakes
        // gets it at 08:00 where they ARE, not 08:00 where they were. Null for the floor rule,
        // which is a real instant and must not be re-resolved. See lib/snooze.ts resolveWake.
        snoozedWakeDay: wakeDay,
        snoozedAt: now,
        snoozeCount: count,
        // A card that returns already dying is a card the sweep eats the same day.
        expiresAt: new Date(Math.max(card.expiresAt.getTime(), at.getTime() + 7 * 24 * 3600_000)),
      })
      .where(eq(schema.cards.id, cardId));
    void opsNotify(uid, `put a ${kind} card off until later`);
    return c.json({ ok: true, decision: "snoozed", returns_at: at.toISOString(), rule, snooze_count: count });
  }

  if (body.decision === "dismissed") {
    await db
      .update(schema.cards)
      .set({ status: "dismissed", feedback, decidedAt: new Date() })
      .where(eq(schema.cards.id, cardId));
    void opsNotify(uid, `shook off a ${kind} card`);
    return c.json({ ok: true, status: "dismissed" });
  }

  await db
    .update(schema.cards)
    .set({
      status: "approved",
      feedback,
      decidedAt: new Date(),
      ...(body.decision === "edited" && body.edited_payload ? { payload: body.edited_payload } : {}),
    })
    .where(eq(schema.cards.id, cardId));
  await scheduleExecution(cardId);
  void opsNotify(uid, body.decision === "edited" ? `edited then approved a ${kind} card` : `approved a ${kind} card`);
  return c.json({
    ok: true,
    status: "approved",
    undo_deadline: new Date(Date.now() + UNDO_GRACE_MS).toISOString(),
  });
});

api.delete("/api/v1/cards/:id/decision", async (c) => {
  const uid = c.get("userId") as string;
  const cardId = c.req.param("id");
  const rows = await db.select().from(schema.cards).where(eq(schema.cards.id, cardId));
  const card = rows[0];
  if (!card || card.userId !== uid) return c.json({ error: "not found" }, 404);
  // `snoozed` is undoable too. Deferring is a decision like any other and the toast that announces
  // it offers to take it back; without this that button could only ever return 409. Not `expired`:
  // that is the sweep or an exhausted deferral, never a decision the user just made and might
  // regret in the next five seconds.
  if (!["approved", "dismissed", "snoozed"].includes(card.status)) {
    return c.json({ error: `cannot undo: card is ${card.status}` }, 409);
  }
  if (card.status === "approved") {
    // The poller claims queued rows atomically; if nothing was still queued, the action is
    // already firing and a "successful" undo here would lie about having stopped it.
    // (Dismissed cards never scheduled anything, so there is nothing to cancel there.)
    const cancelled = await cancelExecution(cardId);
    if (!cancelled) return c.json({ error: "too late: execution already started" }, 409);
  }
  const fb = card.feedback as any;
  await db
    .update(schema.cards)
    .set({
      status: "proposed",
      decidedAt: null,
      feedback: null,
      // The decision has to go: the card returns to the deck and /stats reads a non-null feedback
      // as "decided". But the FACT of the undo is kept, in its own column so this reset cannot
      // erase it. Someone swiping and taking it back within five seconds is the sharpest precision
      // signal we get, and until now it deleted itself.
      undoCount: (card.undoCount ?? 0) + 1,
      ...(fb?.original_payload ? { payload: fb.original_payload } : {}),
      // Undoing a deferral has to hand the deferral back. snoozeCount gates isSnoozeExhausted, so
      // leaving it incremented would let three defer-then-undo taps silently burn every deferral
      // the card had. expiresAt is deliberately NOT restored: the snooze pushed it out and the
      // original was never stored, and a card living longer than it would have is harmless.
      ...(card.status === "snoozed"
        ? {
            snoozedUntil: null,
            snoozedWakeDay: null,
            snoozedAt: null,
            snoozeCount: Math.max(0, (card.snoozeCount ?? 1) - 1),
          }
        : {}),
    })
    .where(eq(schema.cards.id, cardId));

  // A promoted capture undoes as ONE thing, not two. Without this the card returns to the deck
  // while its to-do stays marked done and still points at it, which is a state no surface can
  // describe: Follow-ups says "Sent to Jira" about a card that is now sitting undecided in the
  // deck, and the capture can never be promoted again because the column that guards that is
  // still set. Scoped by user and matched on this exact card, so it can only ever touch the row
  // this promotion claimed.
  const released = await db
    .update(schema.todos)
    .set({ promotedCardId: null, status: "open" })
    .where(and(eq(schema.todos.userId, uid), eq(schema.todos.promotedCardId, cardId)))
    .returning({ id: schema.todos.id });
  if (released.length) log.info({ userId: uid, card: cardId, todo: released[0].id }, "promotion undone with its card");

  return c.json({ ok: true, status: "proposed", promotion_released: released.length > 0 });
});

/* ---------------- history ---------------- */

// The default page size, and also the cap on `limit`: a caller that sends neither param gets
// byte-for-byte today's first page, and one that asks for more than this is clamped rather than
// allowed to pull the whole table in one shot.
/** First page. Sized from what someone opening History actually wants, which is the last handful
 *  of decisions, or today and yesterday: at this volume that is comfortably inside 20. The old
 *  value was 80, inherited from the pre-pagination hard cap rather than chosen, and fetching 80 to
 *  show you ten is the cost paid on every single tab open, by every user, forever. Load more is
 *  what older decisions are for, and it costs one tap only for the people who want them. */
const HISTORY_PAGE_SIZE = 20;
/** Ceiling for an explicit ?limit=. Only a bound against a client asking for everything at once;
 *  no caller sets it today. */
const HISTORY_MAX_PAGE = 100;

api.get("/api/v1/history", async (c) => {
  const uid = c.get("userId") as string;
  // Falls back rather than clamping, because Math.max(NaN, 1) is NaN and so is Math.min(NaN, 80):
  // a clamp does not tame a non-number, it launders it. "?limit=abc" would have reached the driver
  // as LIMIT NaN and 500'd on a query string a user can type. Floored too, so "?limit=5.7" is a
  // number Postgres will accept rather than one it rejects.
  const intParam = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.floor(n) : fallback;
  };
  const limit = Math.min(Math.max(intParam(c.req.query("limit"), HISTORY_PAGE_SIZE), 1), HISTORY_MAX_PAGE);
  const offset = Math.max(intParam(c.req.query("offset"), 0), 0);

  // Offset, not a decided_at cursor, and deliberately so. decided_at is nullable: sweepExpiredCards
  // (jobs/digest.ts) expires a proposed card straight to "expired" with decided_at left null, and
  // tells the user "They are in History if you still want to act on them." A null decided_at
  // reaching this endpoint is therefore a named, intended case, not a corner case. Under desc() it
  // sorts NULLS FIRST, ahead of every real timestamp, so a "before = last shown row's decided_at"
  // cursor would have to reimplement that NULLS-FIRST (decided_at, created_at) tuple comparison by
  // hand to avoid quietly dropping exactly those rows past page 1, which reintroduces this
  // endpoint's original bug, old rows going permanently unreachable, for undecided-expired cards
  // specifically. Offset re-runs the same ORDER BY Postgres already sorts correctly, nulls
  // included, so every row stays reachable no matter how many pages deep. The known offset
  // trade-off, a new decision landing at the top mid-scroll shifting the window and re-returning an
  // already-shown row, is a narrow single-user race (it needs a decision made in another tab while
  // this one is mid-scroll), and the client dedupes appended rows by card id, so a shifted row is a
  // no-op re-append rather than a visible duplicate.
  const decided = await db
    // Exactly the seven fields a history row renders (index.html histRow, stTxt, stCls), and not
    // the whole card. A select() here shipped every column: payload, which holds full email bodies
    // and Slack message text, context, which holds the evidence quotes, plus sourceJson and summary.
    // A page of 80 of those is a large response assembled to draw a title, a date and a status
    // chip. Nothing on this screen can open a card, so none of it was ever read.
    //
    // Slim rows and a small page are the same argument from two directions: send only what is
    // drawn, and only as much of it as someone actually reads on opening the tab.
    .select({
      id: schema.cards.id,
      actionType: schema.cards.actionType,
      title: schema.cards.title,
      status: schema.cards.status,
      decidedAt: schema.cards.decidedAt,
      createdAt: schema.cards.createdAt,
      // Only .executed.mode and .executed.detail are read, but this is a small object and picking
      // inside jsonb here would put the client's rendering rules into a SQL projection.
      feedback: schema.cards.feedback,
    })
    .from(schema.cards)
    .where(
      and(
        eq(schema.cards.userId, uid),
        inArray(schema.cards.status, ["approved", "executing", "executed", "dismissed", "failed", "expired"]),
      ),
    )
    .orderBy(desc(schema.cards.decidedAt), desc(schema.cards.createdAt))
    .limit(limit + 1) // one extra row, never returned, just answers has_more for free
    .offset(offset);
  const hasMore = decided.length > limit;

  // Kept for shape compatibility only. The to-do list moved to Follow-ups and nothing on the
  // history screen reads this any more, so it is capped small and never paginated.
  const todos = await db
    .select({ id: schema.todos.id, title: schema.todos.title, status: schema.todos.status })
    .from(schema.todos)
    .where(eq(schema.todos.userId, uid))
    .orderBy(desc(schema.todos.createdAt))
    .limit(40);
  return c.json({ cards: decided.slice(0, limit), todos, has_more: hasMore });
});

/** Follow-ups: every commitment that has not closed yet, grouped by WHO closes it.
 *
 *  History answers "what did I decide". Nothing answered "what did I promise that still has not
 *  happened", so open loops were appended to the bottom of the decision log, which is a record of
 *  things already dealt with. This is that missing surface.
 *
 *  Two groups, not three. An approved action executes within the undo grace, so a "Haii is doing
 *  this" group would be empty almost always and would just be History arriving a few seconds early.
 *  What is left is the split that matters: yours to do, versus ours to unblock.
 *
 *  The group is derived from the source card rather than a new column, so there is no migration
 *  and no second source of truth: create_todo means the work was always yours; anything else in
 *  here only exists because Haii could not act. */
const BLOCKED_CONNECTOR: Record<string, { id: string; label: string }> = {
  create_jira_issue: { id: "jira", label: "Jira" },
  send_slack_message: { id: "slack", label: "Slack" },
  create_calendar_event: { id: "google", label: "Google Calendar" },
  send_email: { id: "google", label: "Gmail" },
  // The two Drive types name Google, because that is the connection the user repairs. The scope
  // they actually need (drive.file) is additive, so the connection reads healthy while these
  // return blocked; the executor's message is what explains the difference.
  create_document: { id: "google", label: "Google Drive" },
  share_file: { id: "google", label: "Google Drive" },
  // A CRM card is blocked on EITHER CRM, so it names the one most people mean. crm.ts picks
  // whichever is actually connected at execution time.
  create_crm_note: { id: "hubspot", label: "your CRM" },
  // send_text HAS NO ENTRY, and the absence is the decision rather than an omission.
  //
  // Every other action type can be blocked by something the user has not connected, which is what
  // this map exists to name. A text has no connector: no OAuth, no pasted key, no vendor. The
  // message is handed to the Messages app already on the phone, and there is nothing that can be
  // in a disconnected state. Adding a row here would invent a repair the user cannot perform.
  //
  // Written down because whoever adds the next type will check this map, find every other
  // connector-backed type here, and reasonably assume this one was forgotten. It was not.
};

/** Where a create_task card is blocked, by the tracker its payload names. */
const TASK_CONNECTOR: Record<string, { id: string; label: string }> = {
  jira: { id: "jira", label: "Jira" },
  linear: { id: "linear", label: "Linear" },
  asana: { id: "asana", label: "Asana" },
};

/** Where a capture can be routed to: Jira only. send_email is deliberately absent: a capture has
 *  no recipient, and the executor refuses an email card without one (see executor.ts). Google
 *  Tasks is absent too: it is a new OAuth scope, which would force every connected user to
 *  reconnect just for this. */
//
// create_calendar_event is absent on purpose. "A to-do can never count as executed, so convert it"
// is a METRIC rationale: it moves the north star without the user getting anything. Jira is
// routing: this commitment belongs in the tracker where the team's work lives. A calendar block is
// time-blocking, reserving thirty minutes to do the thing, which is a DIFFERENT action from the
// commitment and deserves its own design (how long, when, does it repeat) rather than being
// smuggled in here. A button whose purpose a user cannot infer has not earned its row.
const PROMOTE_TARGETS = ["create_jira_issue"] as const;
type PromoteTarget = (typeof PROMOTE_TARGETS)[number];

api.get("/api/v1/followups", async (c) => {
  const uid = c.get("userId") as string;
  const rows = await db
    .select({
      id: schema.todos.id,
      title: schema.todos.title,
      due: schema.todos.due,
      notes: schema.todos.notes,
      status: schema.todos.status,
      cardId: schema.todos.cardId,
      promotedCardId: schema.todos.promotedCardId,
      sortOrder: schema.todos.sortOrder,
      createdAt: schema.todos.createdAt,
      actionType: schema.cards.actionType,
      // Selected only so a blocked create_task can name its tracker; never rendered to the client.
      cardPayload: schema.cards.payload,
      cardTitle: schema.cards.title,
      cardContext: schema.cards.context,
      cardSource: schema.cards.sourceJson,
    })
    .from(schema.todos)
    .leftJoin(schema.cards, eq(schema.todos.cardId, schema.cards.id))
    .where(eq(schema.todos.userId, uid))
    .orderBy(desc(schema.todos.createdAt))
    .limit(200);

  // Connector status decides whether a blocked item offers "Connect X" or "Haii, do it now", so
  // the user is never told to connect something that already is.
  const conns = await db
    .select({ id: schema.connections.id, status: schema.connections.status })
    .from(schema.connections)
    .where(eq(schema.connections.userId, uid));
  const connected = new Set(conns.filter((x) => x.status === "connected").map((x) => x.id));
  // Same gate performAction itself applies: Jira must be connected. Computed once, not per row,
  // since it does not depend on the item. Never advertise a target performAction would immediately
  // turn around and block; that would just teach the user Haii lies twice instead of once. A
  // missing JIRA_PROJECT is not hidden here: the promote route refuses with a sentence that says
  // what to set, which tells the user more than a button that silently disappears.
  const promoteAvailable: Record<PromoteTarget, boolean> = {
    create_jira_issue: connected.has("jira"),
  };

  // A second, small lookup for what a promotion actually produced. promotedCardId names a
  // DIFFERENT row than the one already left-joined above (that join is the item's ORIGINATING
  // card; this is its DESTINATION), so it cannot reuse the same join without a second alias.
  // Skipped entirely when nothing here has been promoted, which is most loads.
  const promotedIds = rows.map((r) => r.promotedCardId).filter((x): x is string => Boolean(x));
  const promotedCards = promotedIds.length
    ? await db
        .select({
          id: schema.cards.id,
          status: schema.cards.status,
          actionType: schema.cards.actionType,
          feedback: schema.cards.feedback,
        })
        .from(schema.cards)
        .where(inArray(schema.cards.id, promotedIds))
    : [];
  const promotedById = new Map(promotedCards.map((pc) => [pc.id, pc]));

  const items = rows.map((r) => {
    // create_task is the one type whose destination is in the PAYLOAD, not implied by the type, so
    // a type-keyed map cannot answer "which connector do I fix". Resolved per row instead; without
    // this a blocked ticket said nothing about which tracker to go and connect.
    const taskDest = r.actionType === "create_task"
      ? String((r.cardPayload as any)?.destination ?? "").toLowerCase()
      : "";
    const blocked = taskDest
      ? (TASK_CONNECTOR[taskDest] ?? undefined)
      : r.actionType
        ? BLOCKED_CONNECTOR[r.actionType]
        : undefined;
    // A card whose work was always the user's is theirs even if it names a connector type.
    const mine = !r.actionType || r.actionType === "create_todo";
    const why = (r.cardContext as any)?.why?.[0];
    const promotedCard = r.promotedCardId ? promotedById.get(r.promotedCardId) : undefined;
    const exec = (promotedCard?.feedback as any)?.executed as { mode?: string; url?: string } | undefined;
    const promotedOk = promotedCard?.status === "executed" && exec?.mode === "real";
    return {
      id: r.id,
      title: r.title,
      due: r.due || null,
      notes: r.notes,
      done: r.status === "done",
      group: mine ? "yours" : "blocked",
      connector: mine || !blocked ? null : { ...blocked, connected: connected.has(blocked.id) },
      card_id: r.cardId,
      source: (r.cardSource as any)?.title ?? null,
      quote: why ? { text: why.text, who: why.who, t: why.t ?? null } : null,
      created_at: r.createdAt,
      // Routing: which promote targets would actually leave Haii for THIS user right now. A
      // target this item is ALREADY blocked on natively is left out, since "Connect X" / "Haii,
      // do it now" above already covers it; promote_targets is only the OTHER way out. Empty once
      // promoted (a capture is promotable once) or when nothing is connected.
      promote_targets: r.promotedCardId
        ? []
        : PROMOTE_TARGETS.filter((t) => t !== r.actionType && promoteAvailable[t]),
      sort_order: r.sortOrder,
      // Whether the ✓ on a closed item can actually be tapped. The client used to decide this by
      // checking `promoted`, and rendered both cases with the same class, so a promoted item and a
      // reopenable one looked identical and only one of them did anything. The server already owns
      // the rule (POST /todos/:id/toggle 409s on a promoted capture), so it says so here instead of
      // the client inferring it.
      reopenable: !r.promotedCardId,
      promoted: r.promotedCardId
        ? {
            target: promotedCard?.actionType ?? null,
            card_id: r.promotedCardId,
            status: promotedCard?.status ?? "unknown",
            ok: promotedOk,
            // Never surface a URL for a card that has not actually gone through yet; a link that
            // 404s because the issue was never created is worse than no link.
            url: promotedOk ? (exec?.url ?? null) : null,
          }
        : null,
    };
  });
  return c.json({
    items,
    open_yours: items.filter((i) => i.group === "yours" && !i.done).length,
    open_blocked: items.filter((i) => i.group === "blocked" && !i.done).length,
  });
});

/** Re-run a card that did not go through. Two states qualify and both were previously terminal:
 *
 *  • `failed`, it threw. The card sat in History as failed forever and the drafted work was
 *    unrecoverable, so a transient Slack blip meant redoing it by hand.
 *  • `executed` with mode `blocked`, the connector was not connected. This is the one that makes
 *    Follow-ups work: connect the thing, press the button, and the commitment Haii could not keep
 *    actually gets kept, instead of the user having to do it manually.
 *
 *  Any stale follow-up rows for the card are cleared first, because a fresh run writes its own if
 *  it is still blocked; leaving them would show the same item twice. */
api.post("/api/v1/cards/:id/retry", LIMIT_RETRY, async (c) => {
  const uid = c.get("userId") as string;
  const cid = c.req.param("id");
  const rows = await db.select().from(schema.cards).where(eq(schema.cards.id, cid));
  const card = rows[0];
  if (!card || card.userId !== uid) return c.json({ error: "not found" }, 404);
  const wasBlocked = card.status === "executed" && (card.feedback as any)?.executed?.mode === "blocked";
  if (card.status !== "failed" && !wasBlocked) {
    return c.json({ error: `only failed or blocked actions can be re-run (this one is ${card.status})` }, 409);
  }

  await db.delete(schema.todos).where(and(eq(schema.todos.userId, uid), eq(schema.todos.cardId, cid)));
  const fb = (card.feedback as Record<string, unknown>) ?? {};
  delete (fb as any).executed; // the previous FAILED/blocked detail must not outlive the retry
  await db.update(schema.cards).set({ status: "approved", feedback: fb }).where(eq(schema.cards.id, cid));
  // No undo grace: a retry is already a deliberate second decision, so it runs on the next poll.
  await scheduleExecution(cid, 0);
  log.info({ card: cid, userId: uid, wasBlocked }, "card retry queued");
  return c.json({ ok: true, detail: wasBlocked ? "Haii is doing it now" : "Retrying now" });
});

/** Hand-order the "Yours to do" list.
 *
 *  Takes the WHOLE list in its new order rather than an item and a direction. The client already
 *  knows what the user is looking at, and sending the full order makes this idempotent, immune to
 *  gaps and ties, and impossible to corrupt by a double tap: replaying the same request twice is a
 *  no-op instead of shifting something twice.
 *
 *  Ids not belonging to the caller are dropped rather than rejected. A stale client can hold an id
 *  that has since been dismissed or promoted, and failing the whole reorder because one row moved
 *  underneath them would lose the arrangement they just made. */
api.post("/api/v1/todos/reorder", async (c) => {
  const uid = c.get("userId") as string;
  const body = await c.req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body?.ids) ? body.ids.filter((x: unknown) => typeof x === "string") : [];
  if (!ids.length) return c.json({ error: "ids required" }, 400);
  const mine = await db
    .select({ id: schema.todos.id })
    .from(schema.todos)
    .where(and(eq(schema.todos.userId, uid), inArray(schema.todos.id, ids.slice(0, 200))));
  const owned = new Set(mine.map((r) => r.id));
  const ordered = ids.filter((id) => owned.has(id));
  if (!ordered.length) return c.json({ ok: true, ordered: 0 });
  // ONE statement, not one per row. This ran a sequential UPDATE per item, so a thirty-item list
  // was thirty round trips and the list stayed half-ordered for the duration of them. It matters
  // more now that the client reorders locally and writes the settled order once: that write is a
  // single user-visible moment and it should be a single transaction, not a slow ripple.
  //
  // Ownership is still checked above and filtered here, so the CASE can only name rows this user
  // owns; the WHERE repeats the user id anyway rather than trusting the id list alone.
  const whenClauses = sql.join(
    ordered.map((id, n) => sql`WHEN ${id} THEN ${n}`),
    sql` `,
  );
  await db
    .update(schema.todos)
    .set({ sortOrder: sql`CASE ${schema.todos.id} ${whenClauses} ELSE ${schema.todos.sortOrder} END` })
    .where(and(eq(schema.todos.userId, uid), inArray(schema.todos.id, ordered)));
  return c.json({ ok: true, ordered: ordered.length });
});

api.post("/api/v1/todos/:id/toggle", async (c) => {
  const uid = c.get("userId") as string;
  const tid = c.req.param("id");
  const rows = await db.select().from(schema.todos).where(eq(schema.todos.id, tid));
  if (!rows[0] || rows[0].userId !== uid) return c.json({ error: "not found" }, 404);
  // A promoted capture is not a checkbox any more. Its work moved to a real Jira issue that may
  // already exist, so reopening it here would put a row back in "Yours to do" with no sign of that,
  // inviting the user to do the same work twice. The client already renders these as inert, but
  // that was the ONLY thing enforcing it: a fast double tap between promoting and the re-render, or
  // any direct call, walked straight past it. Undo is the way back, and it clears the promotion.
  if (rows[0].promotedCardId) {
    return c.json({ error: "this went to Jira; undo the card to bring it back" }, 409);
  }
  const status = rows[0].status === "open" ? "done" : "open";
  await db.update(schema.todos).set({ status }).where(eq(schema.todos.id, tid));
  return c.json({ ok: true, status });
});

/** Promote a capture into a real system. This is the fix for the thing LEAVES_HAII (lib/metrics.ts)
 *  can never paper over: a create_todo cannot count as executed BY CONSTRUCTION, so a capture
 *  lands in a Haii-only list and stays there. The way out is not a better to-do app, it is
 *  routing: turn the todo into a real Jira issue through the SAME approved-card path a swipe uses
 *  (COPY of the decision endpoint's approve branch above), so it gets the same undo grace,
 *  exactly-once execution and failure recording for free. */
api.post("/api/v1/todos/:id/promote", async (c) => {
  const uid = c.get("userId") as string;
  const tid = c.req.param("id");
  const body = await c.req.json<{ target?: string }>();
  // Refuse anything unrecognised rather than defaulting, the same posture as the decision
  // endpoint's decision field: send_email and Google Tasks are deliberately not valid targets
  // (see the PROMOTE_TARGETS comment above), so asking for either is a bug to surface, not a
  // target to silently substitute.
  if (!PROMOTE_TARGETS.includes(body?.target as PromoteTarget)) {
    return c.json({ error: `invalid target: expected ${PROMOTE_TARGETS.join(" | ")}` }, 400);
  }
  const target = body.target as PromoteTarget;

  const rows = await db.select().from(schema.todos).where(eq(schema.todos.id, tid));
  const todo = rows[0];
  if (!todo || todo.userId !== uid) return c.json({ error: "not found" }, 404);
  // Fast path for the common case. The actual guard against a double promotion is the atomic
  // conditional UPDATE below, not this read, which is why the same check is repeated there.
  if (todo.promotedCardId) return c.json({ error: "already promoted" }, 409);
  // A capture names no Jira project, so the issue goes to JIRA_PROJECT. With none set there is no
  // project to create it in, and guessing one would file it somewhere else. Refused here, before
  // anything is claimed, so the follow-up stays open and the person reads what to set.
  if (!env.JIRA_PROJECT) {
    return c.json({ error: "No Jira project is set. Add JIRA_PROJECT to server/.env and restart Haii, then send this to Jira again." }, 400);
  }

  // Provenance: carry over the ORIGINATING card's evidence quote and source verbatim, so the
  // promoted card can be honest about where it came from. NEVER fabricate a quote: a todo with no
  // card (or a cardId that no longer resolves, which should not happen but is not load-bearing
  // enough to throw over) gets the same minimal, honest shape the practice card uses.
  let context: Record<string, unknown> = { why: [] };
  let sourceJson: Record<string, unknown> = { kind: "capture", title: "Promoted from your follow-ups" };
  if (todo.cardId) {
    const orig = await db.select().from(schema.cards).where(eq(schema.cards.id, todo.cardId));
    if (orig[0]) {
      context = orig[0].context as Record<string, unknown>;
      sourceJson = orig[0].sourceJson as Record<string, unknown>;
    }
  }

  const payload: Record<string, unknown> = {
    summary: todo.title,
    description: todo.notes,
    project: env.JIRA_PROJECT,
  };

  const cardId = id("card");
  // The claim: an atomic conditional UPDATE, not a check-then-write. Two taps racing on the same
  // todo can both pass the reads above; only one can win this WHERE clause, so the column itself
  // is the guard against a double promotion, never the read that happened before it. Claimed
  // BEFORE the card is inserted so a lost race never leaves an orphaned, never-scheduled card behind.
  const claimed = await db
    .update(schema.todos)
    .set({ promotedCardId: cardId, status: "done" })
    .where(and(eq(schema.todos.id, tid), eq(schema.todos.userId, uid), isNull(schema.todos.promotedCardId)))
    .returning({ id: schema.todos.id });
  if (!claimed.length) return c.json({ error: "already promoted" }, 409);

  // Compensating rollback rather than a transaction. The claim above has already committed, so if
  // this insert throws (transient infra, not logic: tsc proves every NOT NULL column is populated)
  // the todo would point at a card that does not exist and read "Sending to X..." forever, with no
  // sweep that can ever fix it. Releasing the claim puts it back exactly where it was, promotable
  // again. A db.transaction() would be tidier, but this codebase uses none anywhere and the dual
  // PGlite/Postgres driver makes that an unverified change; this is verifiable and local.
  try {
    await db.insert(schema.cards).values({
      id: cardId,
      userId: uid,
      schemaVersion: 1,
      type: "action",
      actionType: target,
      status: "approved",
      title: todo.title,
      summary: todo.notes || todo.title,
      confidence: 1,
      priority: "normal",
      sourceJson,
      payload,
      context,
      feedback: { decision: "approved", via: "promote" },
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000), // match every other card's 7-day TTL
      decidedAt: new Date(),
      simulated: false,
      // No model produced this: promotion is a direct user gesture on already-captured text, not an
      // extraction, so a model/prompt_version attribution here would misrepresent a deterministic
      // transform as an LLM output. Left at the schema default ("").
    });
    // INSIDE the try, not after it. scheduleExecution is two more database calls and can fail for
    // exactly the transient reasons this catch was written for. Left outside, its failure produced
    // the worst state available: the to-do committed as promoted and done, the card committed as
    // approved, and no executions row, so nothing would ever run it, no sweep would ever find it,
    // and the 409 guard meant it could never be promoted again. An error the user could not retry
    // past, on work that silently never happened.
    await scheduleExecution(cardId);
  } catch (e: any) {
    // Unwind in reverse. The card is deleted as well as the claim released, because a card left at
    // status "approved" with no executions row is exactly what recoverPending() sweeps up and
    // executes for real on the next boot: a Jira issue created hours later, from a promotion the
    // user was told had failed.
    await db.delete(schema.cards).where(and(eq(schema.cards.id, cardId), eq(schema.cards.userId, uid)));
    await db
      .update(schema.todos)
      .set({ promotedCardId: null, status: "open" })
      .where(and(eq(schema.todos.id, tid), eq(schema.todos.userId, uid), eq(schema.todos.promotedCardId, cardId)));
    log.error({ todo: tid, card: cardId, userId: uid, err: String(e?.message ?? e) }, "promote failed, fully unwound");
    return c.json({ error: "could not promote, please try again" }, 500);
  }
  void opsNotify(uid, "promoted a follow-up to Jira");
  log.info({ todo: tid, card: cardId, userId: uid, target }, "todo promoted");
  return c.json({ ok: true, card_id: cardId, undo_deadline: new Date(Date.now() + UNDO_GRACE_MS).toISOString() });
});

/* ---------------- briefings ---------------- */

api.get("/api/v1/briefings/:id", async (c) => {
  const uid = c.get("userId") as string;
  const rows = await db.select().from(schema.briefings).where(eq(schema.briefings.id, c.req.param("id")));
  if (!rows[0] || rows[0].userId !== uid) return c.json({ error: "not found" }, 404);
  return c.json(rows[0]);
});

/** The chips behind a thumbs down. Closed set, like the card dismiss reasons: free text is
 *  diagnostic for a human, chips are what a prompt can aggregate. jobs/briefing.ts renders these
 *  back to the model, and the briefing prompt explains what each one means. */
const BRIEF_REASONS = new Set(["too_long", "wrong_people", "missed_the_point"]);

api.post("/api/v1/briefings/:id/rating", async (c) => {
  const uid = c.get("userId") as string;
  const body = await c.req.json<{ rating: "up" | "down"; reason?: string }>();
  // Refuse an unrecognised rating rather than storing it. Same posture as the card decision
  // endpoint: a value nothing downstream understands is worse than no value.
  if (body.rating !== "up" && body.rating !== "down") return c.json({ error: "bad rating" }, 400);
  const reason = body.rating === "down" && BRIEF_REASONS.has(String(body.reason)) ? String(body.reason) : null;

  // read_seconds deliberately NOT written here any more, even though the client used to send it.
  // This endpoint wrote `read_seconds ?? null`, so rating a brief erased the duration recorded for
  // it. One writer (POST /read) owns that column now: two writers with different update rules is
  // how it ended up meaning "rated" instead of "read" in the first place.
  await db
    .update(schema.briefings)
    .set({ rating: body.rating, feedbackReason: reason })
    .where(and(eq(schema.briefings.id, c.req.param("id")), eq(schema.briefings.userId, uid)));
  return c.json({ ok: true });
});

/** Free text about a brief, and deliberately NOT behind a thumbs-down.
 *
 *  The case chips cannot reach: "the brief is ok, but there was an attachment in the meeting invite
 *  that should be considered." Nothing was wrong, so there is no rating to give, and no chip in any
 *  vocabulary would carry that sentence. A rating says how good it was; a note says what it missed,
 *  and those are different questions.
 *
 *  Separate endpoint from the rating for the same reason POST /read is separate: one writer per
 *  column. A note must not need a rating, and rating later must not erase the note. */
api.post("/api/v1/briefings/:id/note", async (c) => {
  const uid = c.get("userId") as string;
  const body = await c.req.json<{ note?: string }>().catch(() => ({}) as { note?: string });
  const note = String(body.note ?? "").trim().slice(0, 1000);
  const rows = await db
    .select({ id: schema.briefings.id, meetingId: schema.briefings.meetingId })
    .from(schema.briefings)
    .where(and(eq(schema.briefings.id, c.req.param("id")), eq(schema.briefings.userId, uid)));
  if (!rows[0]) return c.json({ error: "not found" }, 404);

  // Empty clears it, so a note written by accident can be taken back without a second endpoint.
  await db
    .update(schema.briefings)
    .set({ feedbackNote: note || null })
    .where(eq(schema.briefings.id, rows[0].id));

  // Pushed to the operator channel the moment it is written. Notes are rare and every one of them
  // is worth a human reading: "it missed the invite attachment" is a capability gap, not a
  // preference, and no prompt can act on it. A row in a table nobody opens would be collection
  // theatre, which is the exact failure the whole feedback loop was fixing.
  if (note) void opsNotify(uid, `wrote a note on a brief: "${note.slice(0, 200)}"`);
  return c.json({ ok: true, saved: Boolean(note) });
});

/** How long a brief was on screen, recorded on CLOSE and independent of any rating.
 *
 *  While the rating endpoint was the only writer, read_seconds measured "briefs RATED", not briefs
 *  read: a brief opened, read for two minutes and closed without a thumb stored null and was
 *  indistinguishable from one never opened. The briefs_read gauge sits on this column, so it could
 *  not observe opened-and-ignored, which is the exact behaviour it was built to detect, and the
 *  "are briefs worth tuning" decision could not honestly be made from it.
 *
 *  Takes the MAX rather than overwriting: the client reports on close and on visibility change, so
 *  one reading session can report twice and a later, shorter report must not shrink a real read.
 *  Clamped to an hour because a tab left open overnight is not a read. */
api.post("/api/v1/briefings/:id/read", async (c) => {
  const uid = c.get("userId") as string;
  const body = await c.req.json<{ read_seconds?: number }>().catch(() => ({}) as { read_seconds?: number });
  const secs = Math.min(3600, Math.round(Number(body.read_seconds)));
  if (!Number.isFinite(secs) || secs <= 0) return c.json({ ok: true, skipped: "no duration" });
  const rows = await db
    .select({ id: schema.briefings.id, readSeconds: schema.briefings.readSeconds })
    .from(schema.briefings)
    .where(and(eq(schema.briefings.id, c.req.param("id")), eq(schema.briefings.userId, uid)));
  if (!rows[0]) return c.json({ error: "not found" }, 404);
  if ((rows[0].readSeconds ?? 0) >= secs) return c.json({ ok: true, read_seconds: rows[0].readSeconds });
  await db.update(schema.briefings).set({ readSeconds: secs }).where(eq(schema.briefings.id, rows[0].id));
  return c.json({ ok: true, read_seconds: secs });
});

/* ---------------- transcripts (paste fallback, day-one real loop) ---------------- */

api.post("/api/v1/transcripts", LIMIT_INGEST, async (c) => {
  const uid = c.get("userId") as string;
  // Said before anything is stored: without a key the transcript would be saved, read by nothing,
  // and reported back as "ingested".
  if ((await llmMode()) === "none") return c.json({ error: NO_KEY_MESSAGE }, 400);
  const body = await c.req.json<{ title?: string; content: string; meeting_id?: string }>();
  // Gate on the CLEANED length, the same measure extraction uses. The old 80-char raw check let a
  // paste through that extraction then refused at 500 cleaned chars, so the user got a green
  // "Transcript ingested" and no cards, and because that path marked the row extracted there was
  // no way to retry or delete it. Reject up front with the real numbers instead.
  const rawContent = body.content ?? "";
  const cleanedLen = cleanTranscript(rawContent).length;
  if (cleanedLen < MIN_TRANSCRIPT_CHARS) {
    return c.json(
      {
        error: `Not enough to work with: ${cleanedLen} characters after removing timestamps, extra blank lines and Gemini notes boilerplate such as headers, attendee lists and disclaimers (need ${MIN_TRANSCRIPT_CHARS}). Paste more of the transcript.`,
      },
      400,
    );
  }
  const titleRows = await db.select().from(schema.users).where(eq(schema.users.id, uid));
  const title = body.title?.trim() || `Pasted transcript ${dateTimeInTz(userTz(titleRows[0]?.tz), new Date())}`;
  const trId = id("tr");
  // A client-supplied meeting_id counts only if the caller owns that meeting; anything else
  // falls through to the title-based linker.
  let meetingId: string | null = null;
  if (body.meeting_id) {
    const owned = await db
      .select({ id: schema.meetings.id })
      .from(schema.meetings)
      .where(and(eq(schema.meetings.id, body.meeting_id), eq(schema.meetings.userId, uid)));
    meetingId = owned[0]?.id ?? null;
  }
  if (!meetingId) meetingId = await linkMeeting(uid, title, new Date());
  await db.insert(schema.transcripts).values({
    id: trId,
    userId: uid,
    title,
    contentMd: body.content.slice(0, 200_000),
    source: "paste",
    meetingId,
  });
  const detail = await runExtract(uid, trId);
  // A failed model call must not come back as a success with a reason string in small print. The
  // transcript stays stored and unextracted, so the retry sweep reads it once the cause is fixed.
  const failed = explainSkip(detail);
  if (failed) {
    return c.json({ error: `${failed} Your notes are saved, and Haii will read them once this is sorted.`, transcript_id: trId }, 502);
  }
  return c.json({ ok: true, transcript_id: trId, meeting_id: meetingId, extraction: detail });
});

api.post("/api/v1/meetings/:id/brief", LIMIT_BRIEF, async (c) => {
  const uid = c.get("userId") as string;
  const rows = await db.select().from(schema.meetings).where(eq(schema.meetings.id, c.req.param("id")));
  if (!rows[0] || rows[0].userId !== uid) return c.json({ error: "meeting not found" }, 404);
  if ((await llmMode()) === "none") return c.json({ error: NO_KEY_MESSAGE }, 400);
  const detail = await runJob("briefing_generate", uid, () => generateBriefing(uid, rows[0], { push: false }));
  const failed = explainSkip(detail);
  if (failed) return c.json({ error: failed }, 502);
  const b = await db
    .select()
    .from(schema.briefings)
    .where(and(eq(schema.briefings.userId, uid), eq(schema.briefings.meetingId, rows[0].id)))
    .orderBy(desc(schema.briefings.createdAt))
    .limit(1);
  return c.json({ ok: true, detail, briefing_id: b[0]?.id ?? null });
});

api.delete("/api/v1/transcripts/:id", async (c) => {
  const uid = c.get("userId") as string;
  const tid = c.req.param("id");
  const rows = await db.select().from(schema.transcripts).where(eq(schema.transcripts.id, tid));
  if (!rows[0] || rows[0].userId !== uid) return c.json({ error: "not found" }, 404);
  await db.delete(schema.transcripts).where(eq(schema.transcripts.id, tid));
  return c.json({ ok: true, deleted: tid, title: rows[0].title });
});

api.get("/api/v1/transcripts/:id", async (c) => {
  const uid = c.get("userId") as string;
  const rows = await db.select().from(schema.transcripts).where(eq(schema.transcripts.id, c.req.param("id")));
  if (!rows[0] || rows[0].userId !== uid) return c.json({ error: "not found" }, 404);
  return c.json({
    id: rows[0].id,
    title: rows[0].title,
    content_md: rows[0].contentMd,
    source: rows[0].source,
    ingested_at: rows[0].ingestedAt,
  });
});

api.post("/api/v1/cards/:id/dismiss-reason", async (c) => {
  const uid = c.get("userId") as string;
  const cardId = c.req.param("id");
  const { reason, note } = await c.req.json<{ reason: string; note?: string }>();
  // The chip vocabulary for the fork-then-reason negative path. `wrong` is accepted but no longer
  // offered: cards dismissed under it may still exist and their feedback must stay readable.
  // `other` carries a free-text note instead of a chip. `later` is not a reason at all, it
  // converts the card to a deferral below.
  const REASONS = ["not_committed", "not_mine", "already_done", "too_small", "other", "wrong", "later"];
  if (!REASONS.includes(reason)) return c.json({ error: `reason must be one of: ${REASONS.join(", ")}` }, 400);
  const rows = await db.select().from(schema.cards).where(eq(schema.cards.id, cardId));
  const card = rows[0];
  if (!card || card.userId !== uid) return c.json({ error: "not found" }, 404);
  if (card.status !== "dismissed") return c.json({ error: `card is ${card.status}, reason applies to dismissed cards` }, 409);

  // Free text, capped and trimmed. The chips are what feed the prompt because they aggregate; a
  // note is for a human to read, so length is the only thing that needs policing here.
  const trimmed = String(note ?? "").trim().slice(0, 500);
  const feedback = { ...((card.feedback as object) ?? {}), reason, ...(trimmed ? { note: trimmed } : {}) };

  // "Later" is not a reason for a dismissal, it is a different decision that the UI can only offer
  // after the swipe has already dismissed the card. So it converts: the card stops being rejected
  // and becomes deferred, which is the whole point of the change. The swipe path itself is
  // untouched, so nothing regresses for anyone who ignores the chips.
  if (reason === "later") {
    const urows = await db.select({ tz: schema.users.tz }).from(schema.users).where(eq(schema.users.id, uid));
    const count = (card.snoozeCount ?? 0) + 1;
    const now = new Date();
    if (isSnoozeExhausted(card.snoozeCount ?? 0)) {
      // Out of deferrals. Left dismissed, but the reason is recorded so it is not read as a
      // rejection by anything downstream.
      await db.update(schema.cards).set({ feedback, snoozeCount: count }).where(eq(schema.cards.id, cardId));
      return c.json({ ok: true, reason, exhausted: true, snooze_count: count });
    }
    const { at, rule, wakeDay } = nextReturn(now, userTz(urows[0]?.tz));
    await db
      .update(schema.cards)
      .set({
        status: "snoozed",
        feedback,
        snoozedUntil: at,
        snoozedWakeDay: wakeDay, // see the note on the other snooze write above
        snoozedAt: now,
        snoozeCount: count,
        decidedAt: null, // it is pending again, not decided
        expiresAt: new Date(Math.max(card.expiresAt.getTime(), at.getTime() + 7 * 24 * 3600_000)),
      })
      .where(eq(schema.cards.id, cardId));
    return c.json({ ok: true, reason, returns_at: at.toISOString(), rule, snooze_count: count });
  }

  await db.update(schema.cards).set({ feedback }).where(eq(schema.cards.id, cardId));
  return c.json({ ok: true, reason, note: trimmed || undefined });
});

/** Auto-captured device timezone (PWA reports Intl.DateTimeFormat().resolvedOptions().timeZone
 *  on boot). Every user-facing "today" derives from users.tz; invalid values are rejected and
 *  the column's 'local' default falls back to UTC at read time (lib/tz.ts). */
/** Who the user is, in their own words. Extraction looks for what THIS person promised, so it has
 *  to know which speaker they are: the name is the one people say in a meeting, not a login. A
 *  local install has no sign-in to learn it from, so first run asks. Whitespace is collapsed
 *  because both values are written into a prompt and a newline there would start a new line of it. */
api.post("/api/v1/me", async (c) => {
  const uid = c.get("userId") as string;
  const body = await c.req.json<{ name?: string; role?: string }>().catch(() => ({}) as { name?: string; role?: string });
  const name = String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const role = String(body.role ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
  if (!name) return c.json({ error: "A name is needed, so Haii knows which speaker is you." }, 400);
  await db.update(schema.users).set({ name, role }).where(eq(schema.users.id, uid));
  return c.json({ ok: true, name, role });
});

api.post("/api/v1/me/timezone", async (c) => {
  const uid = c.get("userId") as string;
  const body = await c.req
    .json<{ timezone?: string; locale?: string }>()
    .catch(() => ({}) as { timezone?: string; locale?: string });
  if (!isValidTz(body.timezone)) return c.json({ error: "invalid timezone" }, 400);
  // `changed` exists so the PWA knows whether the feed it fetched in parallel was computed in the
  // wrong zone. On a brand-new account the stored value is the 'local' sentinel, which resolves to
  // UTC, so the very first render of "Your day" used UTC day bounds. For a US user that window is
  // shifted most of a day: at 17:00 Pacific it is already tomorrow in UTC, so the strip came back
  // empty on the one render that forms a first impression.
  const before = await db
    .select({ tz: schema.users.tz, locale: schema.users.locale, pinned: schema.users.tzPinned })
    .from(schema.users)
    .where(eq(schema.users.id, uid));
  // A hand-picked zone outranks the device. This call fires on every boot, so without the pin a
  // manual choice would survive exactly until the next page load. The locale still rides along:
  // that is about spelling, not about which instant "today" is, and the device is the authority on
  // it either way.
  const changed = !before[0]?.pinned && before[0]?.tz !== body.timezone;
  // The locale rides along on the same call because it is reported from the same place at the same
  // moment, and a second endpoint would just be another thing to forget. It is deliberately NOT
  // part of `changed`: the zone decides which instant the feed computed, so a re-render is only
  // warranted when the zone moved. A locale change alters spelling, which the next render picks up
  // anyway. An unusable tag is ignored rather than rejected, because the timezone is the part of
  // this request that matters and it must not fail over formatting.
  const localeChanged = isValidLocale(body.locale) && before[0]?.locale !== body.locale;
  if (changed || localeChanged) {
    await db
      .update(schema.users)
      .set({
        ...(changed ? { tz: body.timezone } : {}),
        ...(localeChanged ? { locale: body.locale as string } : {}),
      })
      .where(eq(schema.users.id, uid));
  }
  return c.json({ ok: true, timezone: body.timezone, changed });
});

/** Choose a zone by hand, and stop the device arguing about it.
 *
 *  Worth having because everything time-based hangs off this one value: the brief batch runs at
 *  local 04:00, the digest at local 07:30, every "today" and every due date. When it is wrong all
 *  of that quietly happens at the wrong hour and nothing on screen explains why. A traveller, a
 *  second device, or a machine set to the wrong region all produce it. */
api.post("/api/v1/me/timezone/pin", async (c) => {
  const uid = c.get("userId") as string;
  const body = await c.req
    .json<{ timezone?: string; pinned?: boolean }>()
    .catch(() => ({}) as { timezone?: string; pinned?: boolean });
  // Unpinning hands control back to the device and takes effect on the next boot, so it does not
  // need a zone with it.
  if (body.pinned === false) {
    await db.update(schema.users).set({ tzPinned: false }).where(eq(schema.users.id, uid));
    return c.json({ ok: true, pinned: false });
  }
  if (!isValidTz(body.timezone)) return c.json({ error: "invalid timezone" }, 400);
  await db
    .update(schema.users)
    .set({ tz: body.timezone as string, tzPinned: true })
    .where(eq(schema.users.id, uid));
  return c.json({ ok: true, timezone: body.timezone, pinned: true });
});

/* ---------------- connections ---------------- */

api.get("/api/v1/connections", async (c) => {
  const uid = c.get("userId") as string;
  // Backfill any missing connector rows before reading them. ensureConnections otherwise only runs
  // at sign-in, so the day a NEW connector ships every existing user has no row for it until they
  // next sign out and in. Idempotent (onConflictDoNothing) and a no-op after the first call, which
  // is a fair price for "the connector you just shipped is actually reachable today".
  await ensureConnections(uid);
  const rows = await db.select().from(schema.connections).where(eq(schema.connections.userId, uid));
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const meta = (r.meta as Record<string, unknown>) ?? {};
    out.push({
      id: r.id,
      status: r.status,
      last_item_at: meta.last_item_at ?? null,
      channels: r.id === "slack" ? (meta.channels ?? []) : undefined,
      // Same shape as Slack's channel list, and for the same reason: the Setup panel renders the
      // scope the user chose, so it has to come back with the connection rather than be guessed.
      spaces: r.id === "confluence" ? (meta.spaces ?? []) : undefined,
      // Salesforce is the one connector whose non-secret half (the instance URL) has to render back
      // into its own field, so the user can see which org they wired without re-typing it.
      meta: r.id === "salesforce" ? { instance_url: (meta as any).instance_url ?? "" } : undefined,
    });
  }
  const key = await apiKey();
  return c.json({
    connections: out,
    llm_mode: await llmMode(),
    anthropic_key_present: Boolean(key),
    google_client_configured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    // Drives the Connect Slack button. False falls Setup back to the paste-a-token form, which is
    // deliberately kept: it is the only path that still works if the OAuth app config is wrong.
    slack_client_configured: Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET),
    telegram_configured: await telegramConfigured(),
    // The user's own spend against the user's own daily caps (lib/llm.ts pauses this user at
    // USER_DAILY_HARD_USD). The instance caps measure everyone's spend combined, so they do not
    // belong next to one user's figure.
    budget: { spend_today: await userSpendToday(uid), soft: env.USER_DAILY_SOFT_USD, hard: env.USER_DAILY_HARD_USD },
  });
});

// The Anthropic key is read from the environment only. It is never stored in the database and
// never sent to the browser.

/** Telegram linking: mint a short-lived, encrypted deep-link code for this user. The PWA
 *  opens the returned url; Telegram sends "/start <code>" to the bot's webhook
 *  (api/telegram.ts), which decrypts it and writes users.telegram_chat_id. `configured` tells
 *  the PWA whether the deep link is even wired up yet (both bot username and webhook secret
 *  need to be set; a local install usually has neither). */
api.get("/api/v1/telegram/link", (c) => {
  const uid = c.get("userId") as string;
  const code = encrypt(JSON.stringify({ uid, exp: Date.now() + 15 * 60_000 }));
  return c.json({
    url: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=${encodeURIComponent(code)}`,
    configured: Boolean(env.TELEGRAM_BOT_USERNAME && env.TELEGRAM_WEBHOOK_SECRET),
  });
});

api.post("/api/v1/connections/jira", async (c) => {
  const uid = c.get("userId") as string;
  const { email, api_token, site } = await c.req.json<{ email: string; api_token: string; site: string }>();
  if (!email || !api_token || !site) return c.json({ error: "email, api_token, site required" }, 400);
  await setCreds(uid, "jira", { email, api_token, site: site.replace(/^https?:\/\//, "") }, "connected");
  // jiraTest/slackTest validate the connecting user's own stored creds.
  const test = await jiraTest(uid);
  if (!test.ok) {
    await setStatus(uid, "jira", "error");
    return c.json({ error: `saved but test failed: ${test.detail}` }, 400);
  }
  return c.json({ ok: true, detail: test.detail });
});

/** Confluence collects NO credentials: it reads the Atlassian token Jira already stored. What this
 *  endpoint records is consent and scope. Giving us a Jira board must not silently also give us
 *  every page in the wiki, so the row's own status is the opt-in, and turning it off stops the
 *  poll without touching the Jira connection at all. */
api.post("/api/v1/connections/confluence", async (c) => {
  const uid = c.get("userId") as string;
  const body = await c.req
    .json<{ enabled?: boolean; spaces?: string }>()
    .catch(() => ({}) as { enabled?: boolean; spaces?: string });
  const spaces = String(body.spaces ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 25);
  await mergeMeta(uid, "confluence", { spaces });
  if (body.enabled === false) {
    await setStatus(uid, "confluence", "disconnected");
    return c.json({ ok: true, enabled: false, spaces });
  }
  const test = await confluenceTest(uid);
  if (!test.ok) {
    await setStatus(uid, "confluence", "error");
    return c.json({ error: test.detail }, 400);
  }
  await setStatus(uid, "confluence", "connected");
  return c.json({ ok: true, enabled: true, spaces, detail: test.detail });
});

/** The notetakers, all three through one route.
 *
 *  They differ only in which vendor validates the key, so three endpoints would be three copies of
 *  the same consent, validation and status handling, drifting apart from the second one onward.
 *
 *  Tested BEFORE it is stored as connected, same as Jira, so a typo surfaces here rather than as a
 *  poll that quietly returns nothing for a week. `enabled:false` turns it off WITHOUT discarding the
 *  key: turning a card source off and back on should not mean finding the key again. */
const NOTETAKERS: Record<string, { id: ConnectorId; test: (u: string, k?: string) => Promise<{ ok: boolean; detail: string }> }> = {
  fireflies: { id: "fireflies", test: firefliesTest },
  fathom: { id: "fathom", test: fathomTest },
  otter: { id: "otter", test: otterTest },
};

api.post("/api/v1/connections/notetaker", async (c) => {
  const uid = c.get("userId") as string;
  const body = await c.req
    .json<{ vendor?: string; api_key?: string; enabled?: boolean }>()
    .catch(() => ({}) as { vendor?: string; api_key?: string; enabled?: boolean });
  const v = NOTETAKERS[String(body.vendor ?? "")];
  if (!v) return c.json({ error: `vendor must be one of: ${Object.keys(NOTETAKERS).join(", ")}` }, 400);
  if (body.enabled === false) {
    await setStatus(uid, v.id, "disconnected");
    return c.json({ ok: true, enabled: false });
  }
  const key = String(body.api_key ?? "").trim();
  if (!key) return c.json({ error: "api_key required" }, 400);
  const test = await v.test(uid, key);
  if (!test.ok) return c.json({ error: test.detail }, 400);
  await setCreds(uid, v.id, { api_key: key }, "connected");
  return c.json({ ok: true, detail: test.detail });
});

/** HubSpot, Salesforce, Linear and Asana through one route, for the same reason the notetakers
 *  share one: they differ only in which vendor validates the credential. Salesforce is the odd one
 *  out and takes two fields, because it has no personal API key at all. */
const TOOLS: Record<string, {
  id: ConnectorId;
  fields: "key" | "salesforce";
  test: (u: string, k?: any) => Promise<{ ok: boolean; detail: string }>;
}> = {
  hubspot: { id: "hubspot", fields: "key", test: hubspotTest },
  linear: { id: "linear", fields: "key", test: linearTest },
  asana: { id: "asana", fields: "key", test: asanaTest },
  salesforce: { id: "salesforce", fields: "salesforce", test: salesforceTest },
};

api.post("/api/v1/connections/tool", async (c) => {
  const uid = c.get("userId") as string;
  const body = await c.req
    .json<{ vendor?: string; api_key?: string; instance_url?: string; access_token?: string; enabled?: boolean }>()
    .catch(() => ({}) as Record<string, string>);
  const v = TOOLS[String(body.vendor ?? "")];
  if (!v) return c.json({ error: `vendor must be one of: ${Object.keys(TOOLS).join(", ")}` }, 400);
  if (body.enabled === false) {
    await setStatus(uid, v.id, "disconnected");
    return c.json({ ok: true, enabled: false });
  }
  if (v.fields === "salesforce") {
    const instance_url = String(body.instance_url ?? "").trim();
    const access_token = String(body.access_token ?? "").trim();
    if (!instance_url || !access_token) return c.json({ error: "instance_url and access_token are both required" }, 400);
    const test = await v.test(uid, { instance_url, access_token });
    if (!test.ok) return c.json({ error: test.detail }, 400);
    await setCreds(uid, v.id, { instance_url, access_token }, "connected");
    // The instance URL is not a secret and the panel has to show which org is wired, so it is
    // mirrored into meta. The token stays only in the encrypted credential blob.
    await mergeMeta(uid, v.id, { instance_url });
    return c.json({ ok: true, detail: test.detail });
  }
  const key = String(body.api_key ?? "").trim();
  if (!key) return c.json({ error: "api_key required" }, 400);
  const test = await v.test(uid, key);
  if (!test.ok) return c.json({ error: test.detail }, 400);
  await setCreds(uid, v.id, { api_key: key }, "connected");
  return c.json({ ok: true, detail: test.detail });
});

api.post("/api/v1/connections/slack", async (c) => {
  const uid = c.get("userId") as string;
  const { user_token, channels } = await c.req.json<{ user_token: string; channels?: string }>();
  if (!user_token?.startsWith("xoxp-")) return c.json({ error: "expected a user token (xoxp-...)" }, 400);
  await setCreds(uid, "slack", { user_token }, "connected");
  const list = (channels ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^#/, ""))
    .filter(Boolean);
  await mergeMeta(uid, "slack", { channels: list, channel_cache: null, channel_cache_at: null });
  const test = await slackTest(uid);
  if (!test.ok) {
    await setStatus(uid, "slack", "error");
    return c.json({ error: `saved but test failed: ${test.detail}` }, 400);
  }
  // auth.test requires no scopes, so on its own it green-lights a token that cannot read or post
  // anything. That is how a "connected" Slack sat here until the first card failed with
  // missing_scope. Probe what the token can actually reach and say so at connect time.
  let detail = test.detail;
  try {
    const cap = await slackCapabilities(uid);
    detail += ` · ${cap.conversations} conversations visible`;
    if (cap.denied.length) detail += ` · missing scopes for: ${cap.denied.join(", ")}`;
  } catch (e) {
    detail += ` · could not probe scopes: ${String(e).slice(0, 120)}`;
  }
  return c.json({ ok: true, detail });
});

/** The channel allowlist is Haii's own setting, not part of the Slack grant. Saving it must not
 *  require re-pasting a token or redoing OAuth, and must never touch the stored credential. */
api.post("/api/v1/connections/slack/channels", async (c) => {
  const uid = c.get("userId") as string;
  const { channels } = await c.req.json<{ channels?: string }>();
  const list = (channels ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^#/, ""))
    .filter(Boolean);
  // Cache cleared because the allowlist is exactly what determines which channels it holds.
  await mergeMeta(uid, "slack", { channels: list, channel_cache: null, channel_cache_at: null });
  return c.json({ ok: true, detail: list.length ? `${list.length} channel(s) allowlisted` : "DMs only" });
});

/** What Haii has learned about you. Exposed and deletable on purpose: memory the user cannot see
 *  or correct is the creepy kind, and a wrong entry silently degrades every future extraction. */
api.get("/api/v1/memories", async (c) => {
  const uid = c.get("userId") as string;
  return c.json({ memories: await listMemories(uid) });
});

api.delete("/api/v1/memories/:id", async (c) => {
  const uid = c.get("userId") as string;
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const rows = await db
    .delete(schema.memories)
    .where(and(eq(schema.memories.id, id), eq(schema.memories.userId, uid)))
    .returning({ id: schema.memories.id });
  if (!rows.length) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, deleted: id });
});

/** Dismiss the failure banner. Marks every currently-unseen row so the count is honest rather
 *  than decrementing one at a time while new failures arrive behind it. */
api.post("/api/v1/failures/seen", async (c) => {
  const uid = c.get("userId") as string;
  const n = await markFailuresSeen(uid);
  return c.json({ ok: true, cleared: n });
});

/* ---------------- stats for the learning strip ---------------- */

api.get("/api/v1/stats", async (c) => {
  const uid = c.get("userId") as string;
  const decided = await db
    .select({ actionType: schema.cards.actionType, feedback: schema.cards.feedback })
    .from(schema.cards)
    // notSimulated: this is the user's own "how am I doing" strip, and a tutorial decision is not
    // a fact about how they use the real product.
    .where(and(eq(schema.cards.userId, uid), isNotNull(schema.cards.feedback), notSimulated))
    .orderBy(desc(schema.cards.decidedAt))
    .limit(100);
  const byType: Record<string, { approved: number; dismissed: number; edited: number }> = {};
  for (const d of decided) {
    const fb = d.feedback as any;
    const t = (byType[d.actionType] ??= { approved: 0, dismissed: 0, edited: 0 });
    if (fb?.decision === "approved") t.approved++;
    else if (fb?.decision === "edited") t.edited++;
    else if (fb?.decision === "dismissed") t.dismissed++;
  }
  return c.json({ by_type: byType, decided_total: decided.length });
});
