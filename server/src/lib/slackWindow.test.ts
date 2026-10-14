/** Tests for the Slack listening window (lib/slackWindow.ts).
 *
 *  The first section is a regression test for a bug that reached a real user: with no cursor the
 *  search had no lower bound, and `sort_dir: asc` made that "the oldest messages you have ever
 *  written". Cards were minted from conversations months dead. If the no-cursor case ever stops
 *  being floored again, that assertion is what says so.
 *
 *  Pure: no database, no network, no clock of its own. `npm test` */
import { searchFloorTs, afterDateParam, MAX_LOOKBACK_HOURS } from "./slackWindow";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, String(got) === String(want), `got ${got}, want ${want}`);

const NOW = new Date("2026-07-31T12:00:00.000Z");
const NOW_TS = NOW.getTime() / 1000;
const DAY = 86400;
const HOUR = 3600;

console.log("\n--- THE regression: no cursor must NOT mean no lower bound ---");
const noCursor = searchFloorTs(undefined, NOW);
eq("no cursor floors at exactly MAX_LOOKBACK_HOURS ago", noCursor, NOW_TS - MAX_LOOKBACK_HOURS * HOUR);
check(
  "and that is nowhere near the beginning of history, which is what shipped",
  noCursor > 0 && NOW_TS - noCursor === MAX_LOOKBACK_HOURS * HOUR,
  `floor was ${noCursor}, ${(NOW_TS - noCursor) / HOUR} hours back`,
);
// The bound is stated in HOURS because the reasoning is about missed four-hourly cycles, not
// calendar days. Asserted here so a future edit cannot quietly turn 24 hours into 24 days, which is
// exactly what a careless rename of this constant did while it was being written.
eq("the floor is one day, not one day per cycle", MAX_LOOKBACK_HOURS, 24);
eq("which is six missed four-hourly runs", MAX_LOOKBACK_HOURS / 4, 6);

console.log("\n--- a stale cursor cannot drag the window backwards either ---");
// The exact state the bug left behind: the cursor advanced only as far as the newest of a batch of
// very old messages, so it sat months in the past. Honouring it would keep crawling history.
const monthsAgo = String(NOW_TS - 90 * DAY);
eq("a 90-day-old cursor loses to the floor", searchFloorTs(monthsAgo, NOW), NOW_TS - MAX_LOOKBACK_HOURS * HOUR);
const yesterday = String(NOW_TS - 1 * DAY);
eq("a recent cursor wins, because it is newer than the floor", searchFloorTs(yesterday, NOW), NOW_TS - DAY);

console.log("\n--- the boundary ---");
const exactlyAtFloor = String(NOW_TS - MAX_LOOKBACK_HOURS * HOUR);
eq("a cursor exactly at the floor is a no-op", searchFloorTs(exactlyAtFloor, NOW), NOW_TS - MAX_LOOKBACK_HOURS * HOUR);
const oneSecondNewer = String(NOW_TS - MAX_LOOKBACK_HOURS * HOUR + 1);
eq("one second newer than the floor wins", searchFloorTs(oneSecondNewer, NOW), NOW_TS - MAX_LOOKBACK_HOURS * HOUR + 1);

console.log("\n--- garbage in cannot silently remove the floor ---");
// Math.max(NaN, x) is NaN, so an unparseable cursor would otherwise return NaN and every downstream
// `ts <= NaN` comparison would be false: no message filtered, the whole history back in scope.
eq("a non-numeric cursor falls back to the floor", searchFloorTs("not-a-ts", NOW), NOW_TS - MAX_LOOKBACK_HOURS * HOUR);
eq("an empty cursor falls back to the floor", searchFloorTs("", NOW), NOW_TS - MAX_LOOKBACK_HOURS * HOUR);
check("the fallback is a real number, never NaN", Number.isFinite(searchFloorTs("not-a-ts", NOW)));

console.log("\n--- afterDateParam ---");
eq("renders the day before the floor, so the coarse filter never excludes a kept message", afterDateParam(NOW_TS), "2026-07-30");
eq("a floor three days back renders three days plus one back", afterDateParam(NOW_TS - 3 * DAY), "2026-07-27");
check("always a bare YYYY-MM-DD, which is all Slack search accepts", /^\d{4}-\d{2}-\d{2}$/.test(afterDateParam(NOW_TS)));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
