/** Pure decision logic for the self-wake follow-up nudge: which open to-dos are due for a
 *  "did this happen" check-in, given the user's own timezone. No database, no Telegram, no wall
 *  clock read here; jobs/followUp.ts is the thin database-and-Telegram shell around this file.
 *
 *  The gap this exists to close: Haii extracts a commitment at the moment of the meeting and then
 *  goes silent. "I'll get back to you Thursday" becomes a to-do that sits there, and nothing ever
 *  asks on Thursday whether it happened. This file answers exactly one question, is this due, and
 *  nothing else: it is a NUDGE plus a digest line, never a new card or a new action type. Adding
 *  an action type is a product decision made in packages/schema, not here.
 *
 *  todos.due is free text written by the model. The extraction prompt asks for YYYY-MM-DD dates,
 *  but the create_todo payload types `due` as a bare string, so nothing enforces that, and rows
 *  written by older prompt versions predate the instruction. Treat it as untrusted input: only the
 *  exact YYYY-MM-DD shape this codebase already uses for every other machine-read date (the
 *  calendar-event date check in jobs/executor.ts, the wakeDay check in lib/snooze.ts) is accepted.
 *  Ordinary relative language like "Thursday" or "next week" is a guess about what the model meant
 *  relative to WHEN, and guessing is exactly what this file must never do. */
import { dayKeyInTz } from "./tz";

export interface FollowUpTodo {
  id: string;
  title: string;
  /** Raw todos.due. Untrusted model output, not yet known to be a real date. */
  due: string;
  /** Null means never nudged. A row that already has this set must not be selected again. */
  notifiedAt: Date | null;
}

export interface FollowUpSelection {
  /** A real date, arrived in the user's zone, never nudged before. Nudge these. */
  due: FollowUpTodo[];
  /** due was non-empty but did not parse to a real calendar date. Never nudged; the job logs
   *  these at debug so a model that has started writing "Thursday" into due is discoverable. */
  unparseable: FollowUpTodo[];
}

/** raw -> the same string back, unchanged, if and only if it is exactly YYYY-MM-DD and names a
 *  real calendar date. null otherwise, and never throws.
 *
 *  Date.UTC silently NORMALISES an overflowing day or month (month 13 rolls into next year, Feb 30
 *  becomes Mar 2), which is exactly the kind of silent guessing this function exists to refuse, so
 *  the round trip back through getUTCFullYear/Month/Date is the real validation. The regex alone
 *  only checks shape and would wave a fictitious date straight through. */
export function parseStrictDueDate(raw: string): string | null {
  const s = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const asUtc = new Date(Date.UTC(y, mo - 1, d));
  if (asUtc.getUTCFullYear() !== y || asUtc.getUTCMonth() !== mo - 1 || asUtc.getUTCDate() !== d) return null;
  return s;
}

/** Is `due` a real calendar date that has arrived (today or earlier) in `tz`, as of `now`?
 *
 *  Deliberately ignorant of notifiedAt: the morning digest (jobs/digest.ts) keeps mentioning an
 *  overdue commitment every morning until it closes, independent of whether the one-shot Telegram
 *  nudge already fired for it. selectFollowUps below is the one that also gates on notifiedAt, for
 *  the sweep job that must fire only once per item. */
export function isDueDateArrived(due: string, now: Date, tz: string): boolean {
  const parsed = parseStrictDueDate(due);
  return parsed !== null && parsed <= dayKeyInTz(tz, now);
}

/** Which open to-dos are due for a nudge right now, in `tz`. `now` and `tz` are explicit
 *  arguments, never read internally, so this stays testable with no wall clock: the same instant
 *  is "today" in one time zone and "yesterday" in another, and it is the user's OWN zone that
 *  decides which applies, never the server's (the server runs UTC by design).
 *
 *  notifiedAt is checked here, not only in the caller's SQL, so this function is the single place
 *  that decides "is this due" and can be trusted on its own in a test with no database: the coarse
 *  SQL WHERE in jobs/followUp.ts is an efficiency filter, not the source of truth. */
export function selectFollowUps(rows: FollowUpTodo[], now: Date, tz: string): FollowUpSelection {
  const todayKey = dayKeyInTz(tz, now);
  const due: FollowUpTodo[] = [];
  const unparseable: FollowUpTodo[] = [];
  for (const row of rows) {
    if (row.notifiedAt) continue; // already nudged once; never again for the same row
    const parsed = parseStrictDueDate(row.due);
    if (!parsed) {
      unparseable.push(row);
      continue;
    }
    if (parsed <= todayKey) due.push(row);
    // else: a real date, just not here yet. Nothing to do, nothing to log.
  }
  return { due, unparseable };
}
