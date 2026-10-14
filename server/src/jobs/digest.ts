import { and, desc, eq, gte, lt, lte, ne, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { env } from "../env";
import { llmJson, MODELS, userSpendToday } from "../lib/llm";
import { tgSend, tgAlertOnce, escapeHtml, userLabel } from "../lib/telegram";
import { DIGEST_PROMPT_VERSION, DIGEST_SCHEMA, digestSystem, digestUser } from "../prompts/digest.v003";
import { userTz, isValidTz, dayKeyInTz, dayBoundsInTz, hhmmForUser, localMinutesInTz } from "../lib/tz";
import { isDueDateArrived } from "../lib/followUp";

/** Per-user local morning gate (the scheduler ticks every 10 minutes; server stays UTC).
 *  True exactly when it's the user's 07:30-07:39 window AND their local day has no digest yet,
 *  so the tick delivers once per local day without spamming job_runs with skips. */
export async function isMorningWindow(userId: string): Promise<boolean> {
  const urows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  // Refuse to guess. userTz() falls back to UTC for the 'local' sentinel, which is silently fine
  // for a European user and actively hostile to an American one: 07:30 UTC is 00:30 in California.
  // The digest ENDS in a Telegram push, so the failure mode is a phone lighting up in the middle of
  // the night with a "good morning", from a product whose whole point is that it respects your
  // attention. Better to send nothing and say so. The PWA reports the zone on every launch, so the
  // only people this holds back are those who have never opened the app, who have nothing to
  // digest anyway. Once per user per day: this resolves the moment they open it.
  if (!isValidTz(urows[0]?.tz)) {
    await tgAlertOnce(
      `no_tz:${userId}:${new Date().toISOString().slice(0, 10)}`,
      `<b>${escapeHtml(await userLabel(userId))}</b> has no timezone yet, so their morning digest is on hold.\n` +
        `The PWA reports it on launch. If this repeats, they have not opened the app since signing in.`,
      24 * 3600_000,
    );
    return false;
  }
  const tz = userTz(urows[0]?.tz);
  const lm = localMinutesInTz(tz);
  if (lm < 450 || lm >= 460) return false;
  const day = dayKeyInTz(tz);
  const existing = await db
    .select({ id: schema.digests.id })
    .from(schema.digests)
    .where(and(eq(schema.digests.userId, userId), eq(schema.digests.day, day)));
  return existing.length === 0;
}

/** Expire proposed cards past their expiry, across every user. Global: no per-user loop needed,
 *  it's a single WHERE on expires_at. Runs as its own job, separate from the digest, because the
 *  digest runs once per active user. */
export async function sweepExpiredCards(): Promise<string> {
  // Tell the owner what is being dropped BEFORE dropping it. A card is a commitment the user made
  // out loud in a meeting; letting it vanish because they were away for a few days is the exact
  // failure this product exists to prevent, and it used to happen with no notice and no way back.
  const doomed = await db
    .select({ id: schema.cards.id, userId: schema.cards.userId, title: schema.cards.title })
    .from(schema.cards)
    .where(and(eq(schema.cards.status, "proposed"), lt(schema.cards.expiresAt, new Date())));
  if (!doomed.length) return "0 cards expired";

  const byUser = new Map<string, string[]>();
  for (const c of doomed) byUser.set(c.userId, [...(byUser.get(c.userId) ?? []), c.title]);

  const res = await db
    .update(schema.cards)
    .set({ status: "expired" })
    .where(and(eq(schema.cards.status, "proposed"), lt(schema.cards.expiresAt, new Date())))
    .returning({ id: schema.cards.id });

  for (const [uid, titles] of byUser) {
    const list = titles.slice(0, 5).map((t) => `• ${escapeHtml(t)}`).join("\n");
    const more = titles.length > 5 ? `\n…and ${titles.length - 5} more` : "";
    await tgSend(
      uid,
      `🕗 <b>${titles.length} commitment${titles.length === 1 ? "" : "s"} expired undecided</b>\n${list}${more}\n\nThey are in History if you still want to act on them.`,
    );
  }
  return `${res.length} cards expired`;
}

export async function runDigest(userId: string): Promise<string> {
  const digestUrows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  const tz = userTz(digestUrows[0]?.tz);
  const since = new Date(Date.now() - 24 * 3600_000);

  const counts = await db
    .select({ connector: schema.items.connector, n: sql<number>`count(*)` })
    .from(schema.items)
    .where(and(eq(schema.items.userId, userId), gte(schema.items.ts, since)))
    .groupBy(schema.items.connector);
  const countsLine =
    counts.map((c) => `${c.connector}: ${c.n}`).join(", ") || "no stream activity";

  const top = await db
    .select()
    .from(schema.items)
    .where(and(eq(schema.items.userId, userId), gte(schema.items.ts, since)))
    .orderBy(desc(schema.items.ts))
    .limit(10);
  const topLines = top
    .map((r) => `[${r.connector} · ${r.author}] ${r.title}: ${r.bodyText.slice(0, 150)}`)
    .join("\n");

  const { start: dayStart, end: dayEnd } = dayBoundsInTz(tz);
  const meetings = await db
    .select()
    .from(schema.meetings)
    .where(
      and(eq(schema.meetings.userId, userId), gte(schema.meetings.startsAt, dayStart), lte(schema.meetings.startsAt, dayEnd)),
    )
    .orderBy(schema.meetings.startsAt);
  const urows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  const name = urows[0]?.name || userId;

  // Read, not parsed: this line lands in a Telegram push. hhmmForUser spells it the way this user
  // spells times, so US users stop being handed 14:00.
  const meetingsLine = meetings
    .map((m) => `${hhmmForUser(tz, urows[0]?.locale, m.startsAt)} ${m.title}`)
    .join("\n");

  // Prose rows via sonnet when a key exists; deterministic fallback otherwise.
  let rows: Array<{ stream: string; text: string }>;
  let model = "";
  let cost = 0;
  const result = await llmJson({
    userId,
    job: "morning_digest",
    model: MODELS.cheap,
    system: digestSystem(name),
    user: digestUser({ counts: countsLine, topItems: topLines, meetingsToday: meetingsLine }),
    jsonSchema: DIGEST_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1024,
  });
  if (result.ok) {
    rows = result.data.rows ?? [];
    model = result.model;
    cost = result.costUsd;
  } else {
    rows = [
      { stream: "other", text: `Last 24h: ${countsLine}` },
      ...(meetingsLine ? [{ stream: "calendar", text: `Today: ${meetingsLine.replace(/\n/g, " · ")}` }] : []),
    ];
    model = `fallback (${result.reason})`;
  }

  const day = dayKeyInTz(tz);
  await db
    .insert(schema.digests)
    .values({
      id: `dg_${userId}_${day}`,
      userId,
      day,
      contentJson: { rows },
      model,
      promptVersion: DIGEST_PROMPT_VERSION,
      costUsd: cost,
    })
    .onConflictDoUpdate({
      target: [schema.digests.userId, schema.digests.day],
      set: { contentJson: { rows }, model, costUsd: cost, createdAt: new Date() },
    });

  // Heartbeat (the digest doubles as the daily health signal), scoped to this user's own jobs
  // so one tenant's digest never leaks another tenant's job activity.
  const dayAgo = new Date(Date.now() - 24 * 3600_000);
  const runs = await db
    .select({ status: schema.jobRuns.status, n: sql<number>`count(*)` })
    .from(schema.jobRuns)
    .where(and(eq(schema.jobRuns.userId, userId), gte(schema.jobRuns.startedAt, dayAgo)))
    .groupBy(schema.jobRuns.status);
  const runsLine = runs.map((r) => `${r.status}: ${r.n}`).join(", ") || "no runs";
  // This user's own spend, not the instance-wide total: the heartbeat goes to every user's chat,
  // and the global number is both confusing and a cross-tenant signal.
  const spend = await userSpendToday(userId);

  // Digest rows are the one place the model is INSTRUCTED to bold with <b></b> (digestSystem),
  // so re-allow exactly that tag pair after escaping; everything else stays inert.
  const digestText = rows
    .map((r) => `• ${escapeHtml(r.text).replace(/&lt;(\/?)b&gt;/gi, "<$1b>")}`)
    .join("\n");

  // Follow-ups due or overdue: appended straight to the outgoing message, never handed to the
  // model. A row here would compete with real stream items for digestSystem's row budget (8 as
  // of digest.v003) and could be paraphrased away; composing it in code guarantees
  // it is mentioned, costs no extra tokens, and needed no prompt change at all. Ignores
  // notifiedAt on purpose, see isDueDateArrived in lib/followUp.ts: this is a standing summary,
  // not the one-shot nudge jobs/followUp.ts sends, so an overdue item keeps showing up here every
  // morning even after that nudge has already fired once.
  const openTodos = await db
    .select({ id: schema.todos.id, title: schema.todos.title, due: schema.todos.due })
    .from(schema.todos)
    .where(and(eq(schema.todos.userId, userId), eq(schema.todos.status, "open"), ne(schema.todos.due, "")));
  const dueFollowUps = openTodos
    .filter((t) => isDueDateArrived(t.due, new Date(), tz))
    .sort((a, b) => a.due.localeCompare(b.due));
  const followUpsBlock = dueFollowUps.length
    ? `\n📌 <b>${dueFollowUps.length} follow-up${dueFollowUps.length === 1 ? "" : "s"} still open</b>\n${dueFollowUps
        .map((t) => `• ${escapeHtml(t.title)} (due ${t.due})`)
        .join("\n")}`
    : "";

  await tgSend(
    userId,
    `☀️ <b>Morning digest</b>\n${digestText}${followUpsBlock}\n\n<i>heartbeat · jobs 24h: ${runsLine} · spend today: $${spend.toFixed(2)}</i>\n${env.APP_URL}`,
  );
  return `digest for ${day}: ${rows.length} rows`;
}
