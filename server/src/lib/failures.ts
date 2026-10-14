import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { log } from "../log";
import { tgAdmin, tgAlertOnce, escapeHtml } from "./telegram";

export type FailureKind = "job" | "execution" | "rate_limit";

/** Human labels for the operator ping and the in-app banner. */
const KIND_LABEL: Record<FailureKind, string> = {
  job: "Job failed",
  execution: "Action did not go through",
  rate_limit: "Rate limited",
};

/** Record something that failed with nobody watching, and tell the operator who it happened to.
 *
 *  Haii's core loop is cron-driven: extraction, briefing and execution all run with no user
 *  present, so before this a failure produced silence. The user got no card and never learned a
 *  meeting was skipped, and the operator saw nothing because job_runs only logged it.
 *
 *  Two audiences, deliberately different:
 *  • the USER sees an in-app banner (unseen count on the feed) and, for their own approved
 *    actions, a direct Telegram message. They need to know their action did not happen.
 *  • the OPERATOR gets a ping that always names the affected user, because in a multi-tenant
 *    install the question is never "did something break" but "who is it broken for".
 *
 *  Never throws: a failure in the failure recorder must not take down the job that was already
 *  failing. Worst case we lose the row and log it. */
export async function recordFailure(opts: {
  userId: string;
  kind: FailureKind;
  ref?: string;
  title?: string;
  detail: string;
  /** Throttle key. Rate limits repeat by nature, so they collapse; a card execution never does. */
  throttleKey?: string;
  /** Appended to the OPERATOR ping only, never stored in `detail`, so context meant for whoever
   *  is running the instance cannot leak into the user's own banner. */
  operatorNote?: string;
  /** Ping the operator, write NO user-facing row.
   *
   *  For things that fix themselves. A Gmail poll runs every 2 minutes and a Drive poll every 10,
   *  so one flaky provider response is over before anyone could act on it, and the banner it left
   *  said "it will try again on the next run", which is an alarm that asks for nothing.
   *
   *  These stacked up on a home screen during normal use. Some were the same Drive poll twice:
   *  `throttleKey` only ever throttled the Telegram alert, and the row below was inserted
   *  unconditionally every single time.
   *
   *  The pattern is not new, it just never covered polls. Rate limits, budget caps, a dead API key
   *  and no credit are already operator-only for the same reason, see jobs/run.ts. */
  operatorOnly?: boolean;
}): Promise<void> {
  const { userId, kind, ref = "", title = "", detail } = opts;
  if (!opts.operatorOnly) {
    try {
      await db.insert(schema.failures).values({
        userId,
        kind,
        ref: ref.slice(0, 200),
        title: title.slice(0, 200),
        detail: detail.slice(0, 500),
      });
    } catch (e: any) {
      log.error({ err: String(e?.message ?? e), kind, ref }, "failed to record failure");
    }
  }

  // Resolve a readable identity for the operator ping. Falls back to the raw id.
  let who = userId || "system";
  try {
    if (userId) {
      const u = await db
        .select({ name: schema.users.name, email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
      if (u[0]) who = `${u[0].name || userId}${u[0].email ? ` &lt;${u[0].email}&gt;` : ""}`;
    }
  } catch {
    /* identity is a nicety, never a reason to lose the alert */
  }

  const body =
    `⚠️ <b>${KIND_LABEL[kind]}</b>\n` +
    `user: ${escapeHtml(who)}\n` +
    (title ? `what: ${escapeHtml(title)}\n` : "") +
    (ref ? `ref: ${escapeHtml(ref)}\n` : "") +
    `\n${escapeHtml(detail.slice(0, 400))}` +
    (opts.operatorNote ? `\n\n<i>${escapeHtml(opts.operatorNote)}</i>` : "");

  try {
    if (opts.throttleKey) await tgAlertOnce(opts.throttleKey, body);
    else await tgAdmin(body);
  } catch (e: any) {
    log.error({ err: String(e?.message ?? e) }, "failure alert send failed");
  }
}

/** Unseen failures for the feed banner. Cheap: indexed on (user_id, seen_at, created_at). */
export async function unseenFailures(userId: string, limit = 3) {
  const rows = await db
    .select({
      id: schema.failures.id,
      kind: schema.failures.kind,
      title: schema.failures.title,
      detail: schema.failures.detail,
      createdAt: schema.failures.createdAt,
    })
    .from(schema.failures)
    .where(and(eq(schema.failures.userId, userId), isNull(schema.failures.seenAt)))
    .orderBy(desc(schema.failures.createdAt))
    .limit(limit);
  const counted = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.failures)
    .where(and(eq(schema.failures.userId, userId), isNull(schema.failures.seenAt)));
  return { items: rows, total: Number(counted[0]?.n ?? 0) };
}

/** Dismiss the banner. Marks every currently-unseen row for this user, so the count is honest
 *  rather than decrementing one at a time while new ones arrive. */
export async function markFailuresSeen(userId: string): Promise<number> {
  const rows = await db
    .update(schema.failures)
    .set({ seenAt: new Date() })
    .where(and(eq(schema.failures.userId, userId), isNull(schema.failures.seenAt)))
    .returning({ id: schema.failures.id });
  return rows.length;
}
