/** Tests for the follow-up self-wake decision: which open to-dos are due for a "did this happen"
 *  nudge right now. The gap this closes: Haii extracts a commitment at meeting time and then goes
 *  silent, so "I'll get back to you Thursday" never gets asked about on Thursday.
 *
 *  Pure: no database, no wall clock. `npx tsx src/lib/followUp.test.ts`
 */
import { parseStrictDueDate, isDueDateArrived, selectFollowUps, type FollowUpTodo } from "./followUp";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, String(got) === String(want), `got ${got}, want ${want}`);

const IST = "Europe/Istanbul"; // UTC+3, no DST
const LA = "America/Los_Angeles";

function todo(id: string, due: string, notifiedAt: Date | null = null): FollowUpTodo {
  return { id, title: `Todo ${id}`, due, notifiedAt };
}

console.log("\n--- parseStrictDueDate: strict shape, a real calendar date, never throws ---");
eq("accepts a real ISO date", parseStrictDueDate("2026-07-30"), "2026-07-30");
eq("trims incidental whitespace", parseStrictDueDate("  2026-07-30  "), "2026-07-30");
eq("rejects natural language", parseStrictDueDate("Thursday"), "null");
eq("rejects a relative phrase", parseStrictDueDate("next week"), "null");
eq("rejects empty string", parseStrictDueDate(""), "null");
eq("rejects whitespace-only", parseStrictDueDate("   "), "null");
eq("rejects a non-padded date", parseStrictDueDate("2026-7-6"), "null");
eq("rejects a fictitious day (Feb 30)", parseStrictDueDate("2026-02-30"), "null");
eq("rejects a fictitious month", parseStrictDueDate("2026-13-01"), "null");
eq("accepts Feb 29 in a leap year", parseStrictDueDate("2024-02-29"), "2024-02-29");
eq("rejects Feb 29 in a non-leap year", parseStrictDueDate("2026-02-29"), "null");
check(
  "never throws on garbage",
  (() => {
    try {
      parseStrictDueDate("¯\\_(ツ)_/¯");
      return true;
    } catch {
      return false;
    }
  })(),
);

console.log("\n--- selectFollowUps: the cases the sweep job depends on ---");
// Istanbul is currently 2026-07-30 at this instant (08:00 local).
const arrivedNow = new Date("2026-07-30T05:00:00.000Z");

const r1 = selectFollowUps([todo("a", "2026-07-30")], arrivedNow, IST);
eq("a due date that has arrived is due", r1.due.map((t) => t.id).join(","), "a");
eq("and is not reported as unparseable", r1.unparseable.length, 0);

const r1b = selectFollowUps([todo("a2", "2026-01-01")], arrivedNow, IST);
eq("a date long overdue is due too, not just due-exactly-today", r1b.due.map((t) => t.id).join(","), "a2");

const r2 = selectFollowUps([todo("b", "2026-08-05")], arrivedNow, IST);
eq("a due date that has not arrived is not due", r2.due.length, 0);
eq("and is not unparseable either, it is simply early", r2.unparseable.length, 0);

const r3 = selectFollowUps([todo("c", "Thursday")], arrivedNow, IST);
eq("an unparseable due string is never due", r3.due.length, 0);
eq("and is surfaced separately so the caller can log it", r3.unparseable.map((t) => t.id).join(","), "c");

const r4 = selectFollowUps([todo("d", "")], arrivedNow, IST);
eq("an empty due is skipped, not due", r4.due.length, 0);

const r5 = selectFollowUps(
  [todo("e", "2026-07-29", new Date("2026-07-29T06:00:00.000Z"))],
  arrivedNow,
  IST,
);
eq("notifiedAt already set means not due again", r5.due.length, 0);
eq("and is not miscounted as unparseable, its due string was fine", r5.unparseable.length, 0);

console.log("\n--- a realistic mixed batch ---");
const batch = selectFollowUps(
  [
    todo("overdue1", "2026-01-01"),
    todo("dueToday", "2026-07-30"),
    todo("future", "2026-12-25"),
    todo("garbage", "soon"),
    todo("empty", ""),
    todo("alreadyPinged", "2026-07-20", new Date("2026-07-20T09:00:00.000Z")),
  ],
  arrivedNow,
  IST,
);
eq(
  "due picks exactly the arrived, never-notified, real dates",
  batch.due.map((t) => t.id).sort().join(","),
  "dueToday,overdue1",
);
eq(
  "unparseable picks exactly the bad strings, nothing else",
  batch.unparseable.map((t) => t.id).sort().join(","),
  "empty,garbage",
);

console.log("\n--- the same instant, two zones, two different answers ---");
// 02:00 UTC on the 30th is 05:00 (2026-07-30) in Istanbul, but still 19:00 the evening of the 29th
// in Los Angeles. A to-do due 2026-07-30 has arrived for the Istanbul user and has not for the LA
// one, at the exact same instant, because "today" is a function of the user's own zone, not the
// server's (the server runs UTC by design; see CLAUDE.md).
const splitInstant = new Date("2026-07-30T02:00:00.000Z");
eq("Istanbul's calendar date has reached the due date", isDueDateArrived("2026-07-30", splitInstant, IST), true);
eq("LA's calendar date has not, same instant", isDueDateArrived("2026-07-30", splitInstant, LA), false);

const rIst = selectFollowUps([todo("f", "2026-07-30")], splitInstant, IST);
const rLA = selectFollowUps([todo("f", "2026-07-30")], splitInstant, LA);
eq("Istanbul: due", rIst.due.map((t) => t.id).join(","), "f");
eq("LA: not due yet, same instant, same due date, same to-do", rLA.due.length, 0);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
