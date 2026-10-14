import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db, schema } from "../db";
import { env } from "../env";
import { log } from "../log";
import { tgSend, escapeHtml } from "../lib/telegram";
import { userTz } from "../lib/tz";
import { selectFollowUps } from "../lib/followUp";

/** A user who has neglected the list for months must not get a single Telegram push that is
 *  mostly to-dos from March. The rest stay due (notifiedAt is untouched) and simply wait for the
 *  next run instead of being dropped. Same shape as executor.ts's EXECUTOR_BATCH_LIMIT: a job-level
 *  cap on one run, not a decision rule, so it lives here rather than in lib/followUp.ts. */
const MAX_NUDGES_PER_RUN = 10;

/** Self-wake: ask about commitments whose due date has arrived and that nobody has been nudged
 *  about yet. This is the gap between "Haii extracts a commitment" and "Haii follows through":
 *  without it, nothing asks on Thursday whether Thursday's promise happened.
 *
 *  A NUDGE plus a digest line, nothing more (see jobs/digest.ts for the second half). This does
 *  not add an action type: it sends a Telegram message and flips a column that already exists,
 *  both surfaces Haii already has.
 *
 *  The SQL below narrows to a coarse, cheap set (this user, open, non-empty due, never nudged);
 *  selectFollowUps in lib/followUp.ts is what actually decides "due", so the decision is identical
 *  whether it runs here or in a test with no database at all. */
export async function followUpSweep(userId: string): Promise<string> {
  const urows = await db.select({ tz: schema.users.tz }).from(schema.users).where(eq(schema.users.id, userId));
  const tz = userTz(urows[0]?.tz);

  const candidates = await db
    .select({
      id: schema.todos.id,
      title: schema.todos.title,
      due: schema.todos.due,
      notifiedAt: schema.todos.notifiedAt,
    })
    .from(schema.todos)
    .where(
      and(
        eq(schema.todos.userId, userId),
        eq(schema.todos.status, "open"),
        ne(schema.todos.due, ""),
        isNull(schema.todos.notifiedAt),
      ),
    );
  if (!candidates.length) return "skipped: nothing due";

  const now = new Date();
  const { due, unparseable } = selectFollowUps(candidates, now, tz);
  // A bad due string is the model's mistake, not the user's business, so this stays at debug:
  // invisible by default, but there the moment anyone goes looking for why a to-do never got
  // nudged.
  for (const row of unparseable) {
    log.debug({ userId, todoId: row.id, due: row.due }, "todos.due did not parse to a real date, skipping");
  }
  if (!due.length) return "skipped: nothing due";

  // Oldest due date first, so if this run truncates, the longest-neglected commitments are the
  // ones actually asked about, rather than whichever happened to come back from the query first.
  due.sort((a, b) => a.due.localeCompare(b.due));
  const truncated = due.length > MAX_NUDGES_PER_RUN;
  const send = due.slice(0, MAX_NUDGES_PER_RUN);
  if (truncated) {
    // A silent cap reads as "there was nothing else". Say so here, and in the message below.
    log.info({ userId, due: due.length, capped: send.length }, "follow-up sweep truncated by the per-run cap");
  }

  // Set notifiedAt before sending, in one update covering every row this run nudges. The failure
  // mode of the opposite order (send, then fail before the write lands) is a nudge that repeats
  // forever, which is worse for the user than this order's rare failure (marked notified, then the
  // send itself fails and never reaches them): the to-do is untouched either way and still visible
  // in Follow-ups, only the push is at risk. jobs/digest.ts's sweepExpiredCards makes the identical
  // tradeoff, for the same reason.
  await db
    .update(schema.todos)
    .set({ notifiedAt: now })
    .where(inArray(schema.todos.id, send.map((t) => t.id)));

  const n = send.length;
  const list = send.map((t) => `• ${escapeHtml(t.title)} (due ${t.due})`).join("\n");
  const more = truncated ? `\n…and ${due.length - n} more due; Haii will nudge you about them soon.` : "";
  await tgSend(
    userId,
    `⏰ <b>${n} follow-up${n === 1 ? "" : "s"} due</b>\n${list}${more}\n\n` +
      `Did ${n === 1 ? "it" : "these"} happen? Open Haii to check ${n === 1 ? "it" : "them"} off.\n\n${env.APP_URL}`,
  );
  log.info({ userId, nudged: n, truncated }, "follow-up sweep nudged");
  return `${n} follow-up${n === 1 ? "" : "s"} nudged${truncated ? ` (${due.length - n} more due, capped at ${MAX_NUDGES_PER_RUN})` : ""}`;
}
