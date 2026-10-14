import { and, desc, eq, gte, isNotNull, max, ne, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { env } from "../env";
import { log } from "../log";
import { tgAdmin, escapeHtml } from "../lib/telegram";
import { todaySpend, userSpendToday } from "../lib/llm";
import { userTz, dayBoundsInTz, localMinutesInTz } from "../lib/tz";
import { classifyCard, notSimulated } from "../lib/metrics";

/** Local hour (in the admin's timezone) the operator digest is sent at, as minutes past midnight.
 *  Evening on purpose: it reports the day that just happened, not the one about to. */
const SEND_AT_MIN = 20 * 60; // 20:00
const WINDOW_MIN = 10; // must be >= the scheduler tick

/** Who still counts as signal. Without these, a report meant to make silence meaningful
 *  fills up with users who are not really using it: leftover test rows that will read "nothing yet"
 *  every night forever, and people who tried it once months ago. Both train the eye to skip the
 *  message, which defeats the entire point of sending it on quiet days.
 *  A brand-new account that has done nothing is NOT noise, it is the most important line in the
 *  report, so the dead-row rule only applies once the account has had a week to be used. */
const DEAD_ACCOUNT_DAYS = 7;
const DORMANT_DAYS = 14;

/** The number that decides whether a quiet day is quiet or broken. */
interface UserActivity {
  userId: string;
  who: string;
  cardsCreated: number;
  approved: number;
  edited: number;
  dismissed: number;
  executed: number;
  failed: number;
  blocked: number;
  spendUsd: number;
  /** Most recent moment this user did or received ANYTHING, across cards and sessions. */
  lastSignal: Date | null;
  accountAgeDays: number;
}

function daysSince(d: Date | null): number | null {
  if (!d) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

async function activityFor(userId: string, who: string, createdAt: Date, since: Date): Promise<UserActivity> {
  const [created, decided, executedRows, spend, lastCard, lastSession] = await Promise.all([
    // notSimulated on created/decided/executedRows: this is the per-user line an operator reads
    // to judge whether a user is real, and the practice card would otherwise show up as
    // "1 card, 1 approved" on someone's very first, still-empty day.
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.cards)
      .where(and(eq(schema.cards.userId, userId), gte(schema.cards.createdAt, since), notSimulated)),
    db
      .select({ feedback: schema.cards.feedback })
      .from(schema.cards)
      .where(
        and(
          eq(schema.cards.userId, userId),
          isNotNull(schema.cards.decidedAt),
          gte(schema.cards.decidedAt, since),
          notSimulated,
        ),
      ),
    // status carries the outcome; executedAt is only stamped on the success path, so a failed card
    // has to be found by its decision time or it never appears in any window.
    db
      .select({ status: schema.cards.status, feedback: schema.cards.feedback })
      .from(schema.cards)
      .where(
        and(
          eq(schema.cards.userId, userId),
          isNotNull(schema.cards.decidedAt),
          gte(schema.cards.decidedAt, since),
          ne(schema.cards.status, "proposed"),
          notSimulated,
        ),
      ),
    // NOT a rolling 24h window like the activity counts above. This figure is printed next to the
    // cap, so it has to be measured the way the cap measures: llm_ledger.day = the server's UTC
    // calendar date. A rolling window spans two of those days and would disagree with the number
    // that actually decides whether a user gets paused, which is the one thing this line must not do.
    userSpendToday(userId),
    // lastCard deliberately does NOT exclude simulated: this feeds lastSignal, "did this user do
    // or receive ANYTHING", which is an activity/dormancy check, not a performance metric. The
    // practice card being created is genuine evidence someone opened the app.
    db
      .select({ at: max(schema.cards.createdAt) })
      .from(schema.cards)
      .where(eq(schema.cards.userId, userId)),
    // users.lastSeenAt exists but is never written; sessions.lastSeenAt is the one the session
    // middleware actually touches, so it is the only real "they opened the app" signal we have.
    db
      .select({ at: schema.sessions.lastSeenAt })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.userId, userId), isNotNull(schema.sessions.lastSeenAt)))
      .orderBy(desc(schema.sessions.lastSeenAt))
      .limit(1),
  ]);

  let approved = 0;
  let edited = 0;
  let dismissed = 0;
  for (const d of decided) {
    const fb = d.feedback as any;
    if (fb?.decision === "approved") approved++;
    else if (fb?.decision === "edited") edited++;
    else if (fb?.decision === "dismissed") dismissed++;
  }

  let executed = 0;
  let failed = 0;
  let blocked = 0;
  for (const r of executedRows) {
    if (r.status === "failed") failed++;
    else if (r.status === "executed") {
      executed++;
      // A blocked action was still marked executed (it becomes a follow-up todo instead). Counting
      // it as done is the same inflation that makes /api/v1/stats unusable; keep it separate here.
      if ((r.feedback as any)?.executed?.mode === "blocked") blocked++;
    }
  }

  const candidates = [lastCard[0]?.at ?? null, lastSession[0]?.at ?? null].filter(Boolean) as Date[];
  const lastSignal = candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null;

  return {
    userId,
    who,
    cardsCreated: Number(created[0]?.n ?? 0),
    approved,
    edited,
    dismissed,
    executed,
    failed,
    blocked,
    spendUsd: spend,
    lastSignal,
    accountAgeDays: daysSince(createdAt) ?? 0,
  };
}

function lineFor(a: UserActivity): string {
  const name = `<b>${escapeHtml(a.who)}</b>`;
  const touched = a.approved + a.edited + a.dismissed;
  if (!a.cardsCreated && !touched) {
    const d = daysSince(a.lastSignal);
    if (d === null) {
      return a.accountAgeDays === 0
        ? `${name}: signed up today, nothing yet.`
        : `${name}: signed up ${a.accountAgeDays} day${a.accountAgeDays === 1 ? "" : "s"} ago, never used it.`;
    }
    if (d === 0) return `${name}: no cards, no swipes today (was here earlier).`;
    return `${name}: silent for ${d} day${d === 1 ? "" : "s"}.`;
  }
  const parts: string[] = [];
  parts.push(`${a.cardsCreated} card${a.cardsCreated === 1 ? "" : "s"}`);
  if (touched) {
    const bits = [
      a.approved ? `${a.approved} approved` : "",
      a.edited ? `${a.edited} edited` : "",
      a.dismissed ? `${a.dismissed} shaken off` : "",
    ].filter(Boolean);
    parts.push(bits.join(", "));
  } else {
    parts.push("none decided");
  }
  if (a.executed) parts.push(`${a.executed} ran${a.blocked ? ` (${a.blocked} blocked)` : ""}`);
  if (a.failed) parts.push(`⚠️ ${a.failed} failed`);
  return `${name}: ${parts.join(" · ")} · $${a.spendUsd.toFixed(2)}`;
}

/** One operator message a day covering every user, so silence stops being ambiguous.
 *
 *  The problem this solves is not "something broke" (failures already alert). It is that a day
 *  where the product did nothing looks exactly like a day nobody checked their phone. A line that
 *  arrives whether or not anything happened turns that into a fact.
 *
 *  Content-free, same rule as opsNotify: counts and kinds, never a card title, a recipient or a
 *  quote. Those belong to the user whose meetings they came from.
 *
 *  Admins are excluded from the per-user lines (an operator does not need their own swipes reported) but
 *  their spend still lands in the shared total, which is the number that trips the global cap. */
export async function opsDigest(): Promise<string> {
  if (!env.TELEGRAM_ADMIN_CHAT_ID) return "skipped: no admin chat";
  const since = new Date(Date.now() - 24 * 3600_000);

  const users = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      isAdmin: schema.users.isAdmin,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users);
  const members = users.filter((u) => !u.isAdmin);

  const all: UserActivity[] = [];
  for (const u of members) all.push(await activityFor(u.id, u.name || u.email || u.id, u.createdAt, since));

  const rows: UserActivity[] = [];
  const dormant: string[] = [];
  for (const a of all) {
    const idle = daysSince(a.lastSignal);
    if (idle === null) {
      if (a.accountAgeDays > DEAD_ACCOUNT_DAYS) continue; // never used, not new: a dead row
      rows.push(a);
    } else if (idle > DORMANT_DAYS) dormant.push(a.who);
    else rows.push(a);
  }

  // The north star, trailing 7 days, so the weekly check happens on its own instead of depending
  // on someone remembering to pull an endpoint. Right swipes come first, because the live risk is
  // whether Haii spots the right commitments, not whether it can execute them. Executed is shown
  // beside it and never merged into it: a right swipe is not an execution, and an approved
  // create_todo card only writes a to-do inside Haii.
  const week = new Date(Date.now() - 7 * 24 * 3600_000);
  // notSimulated: this line is the north star, sent nightly to the operator's own chat. A
  // tutorial swipe must never move it.
  const weekCards = await db
    .select({ status: schema.cards.status, actionType: schema.cards.actionType, feedback: schema.cards.feedback })
    .from(schema.cards)
    .where(and(isNotNull(schema.cards.decidedAt), gte(schema.cards.decidedAt, week), notSimulated));
  let right = 0, swiped7 = 0, executed7 = 0;
  for (const c of weekCards) {
    const d = (c.feedback as { decision?: string } | null)?.decision;
    if (d === "approved" || d === "edited") { right++; swiped7++; }
    else if (d === "dismissed") swiped7++;
    if (classifyCard(c) === "executed") executed7++;
  }
  const northStar = swiped7
    ? `<b>${right}</b> right swipe${right === 1 ? "" : "s"} of ${swiped7} decided (${Math.round((right / swiped7) * 100)}%) · <b>${executed7}</b> executed`
    : "No decisions in the last 7 days.";

  // Shared spend, everyone included: this is the figure the global caps are measured against, so
  // reporting only users would understate it by exactly the operator's own usage. Same UTC
  // calendar day as the caps, for the same reason as the per-user figure above.
  const total = await todaySpend();

  const body =
    `📊 <b>Haii · last 24h</b>\n\n` +
    (rows.length ? rows.map(lineFor).join("\n") : "No active users.") +
    (dormant.length ? `\n\n<i>${dormant.length} dormant: ${escapeHtml(dormant.join(", "))}</i>` : "") +
    `\n\n<b>7-day north star</b>\n${northStar}` +
    // Spelling out the window because it is NOT the 24h the counts above use, and because the UTC
    // day is genuinely surprising for a US user: their budget resets mid-evening, not at midnight.
    `\n\n$${total.toFixed(2)} spent so far this UTC day (hard cap $${env.BUDGET_HARD_USD.toFixed(2)}). ` +
    `Per-user figures are the same window, which is the one the caps use.`;

  const sent = await tgAdmin(body, { silent: true });
  const summary = `${rows.length} user${rows.length === 1 ? "" : "s"}, $${total.toFixed(2)}`;
  if (!sent) {
    log.warn("ops digest could not be delivered");
    return `skipped: telegram send failed (${summary})`;
  }
  return summary;
}

/** True inside the admin's local send window, and only if today's digest hasn't gone out yet.
 *  Same shape as isMorningWindow: the gate runs BEFORE runJob so the ~143 non-window ticks a day
 *  never land in job_runs. The "already sent" check is the job_runs row itself, which is why this
 *  must be called through runJob("ops_digest", ...) and not directly. */
export async function isOpsDigestWindow(): Promise<boolean> {
  if (!env.TELEGRAM_ADMIN_CHAT_ID) return false;
  // Ordered, because limit(1) on its own is whatever the planner returns. With two admins in
  // different zones that would make the send time flip between them from one day to the next, and
  // a report whose whole job is to be boringly regular cannot have a wandering delivery hour.
  // Oldest admin wins: stable, and it is the operator who set the instance up.
  const admins = await db
    .select({ id: schema.users.id, tz: schema.users.tz })
    .from(schema.users)
    .where(eq(schema.users.isAdmin, true))
    .orderBy(schema.users.createdAt)
    .limit(1);
  const tz = userTz(admins[0]?.tz);
  const lm = localMinutesInTz(tz);
  if (lm < SEND_AT_MIN || lm >= SEND_AT_MIN + WINDOW_MIN) return false;

  // One per local day. Bounded by the admin's LOCAL day start, via dayBoundsInTz rather than a
  // hand-rolled `${dayKey}T00:00:00Z`: that string is midnight UTC, not midnight there, and for any
  // zone behind UTC it lands after 20:00 local, so yesterday's digest would suppress today's.
  const { start: dayStart } = dayBoundsInTz(tz);
  // Only SCHEDULED runs count. The manual trigger goes through runJob with the caller's uid, so
  // matching on job name alone would let one on-demand look at 15:00 cancel that evening's real
  // digest, a report you can accidentally switch off is worse than no report, because its silence
  // still reads as "nothing happened". Scheduled runs use the system userId ('').
  const already = await db
    .select({ id: schema.jobRuns.id })
    .from(schema.jobRuns)
    .where(
      and(
        eq(schema.jobRuns.job, "ops_digest"),
        eq(schema.jobRuns.userId, ""),
        gte(schema.jobRuns.startedAt, dayStart),
      ),
    )
    .limit(1);
  return already.length === 0;
}
