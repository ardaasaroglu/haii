/** Tests for when a deferred card comes back.
 *
 *  Four rules that pull against each other, so the edges are where the product decision actually
 *  lives. Every case below came up while testing the prototype.
 *
 *  Pure: no database, no wall clock. `npm test -w @haii/server`
 */
import {
  nextReturn, resolveWake, selectWakes, isSnoozeExhausted,
  SNOOZE_FLOOR_MIN, MAX_SNOOZES, DECK_TARGET,
} from "./snooze";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, String(got) === String(want), `got ${got}, want ${want}`);

const IST = "Europe/Istanbul"; // UTC+3, no DST
const LA = "America/Los_Angeles";

console.log("\n--- the normal case: back next morning ---");
// 15:30 Istanbul on 29 Jul = 12:30Z. Next local 08:00 = 05:00Z on the 30th.
const afternoon = new Date("2026-07-29T12:30:00.000Z");
const r1 = nextReturn(afternoon, IST);
eq("rule", r1.rule, "next morning");
eq("comes back at local 08:00", r1.at.toISOString(), "2026-07-30T05:00:00.000Z");
eq("wake day is the local day of `at`", r1.wakeDay, "2026-07-30");

console.log("\n--- the floor beats the morning rule ---");
// 07:00 Istanbul = 04:00Z. Next morning is 08:00 local, only ONE hour away, so the floor wins.
const earlyMorning = new Date("2026-07-29T04:00:00.000Z");
const r2 = nextReturn(earlyMorning, IST);
eq("rule", r2.rule, "floor");
eq("pushed to now + 2h", r2.at.toISOString(), "2026-07-29T06:00:00.000Z");
eq("floor rule has no wake day", r2.wakeDay, "null");
check("never returns inside the floor", r2.at.getTime() - earlyMorning.getTime() >= SNOOZE_FLOOR_MIN * 60_000);
// 05:59 Istanbul: morning is just over 2h away, so the normal rule holds.
const justBefore = nextReturn(new Date("2026-07-29T02:59:00.000Z"), IST);
eq("just outside the floor keeps the morning rule", justBefore.rule, "next morning");
eq("and still gets a wake day", justBefore.wakeDay, "2026-07-29");

console.log("\n--- zones and calendar edges ---");
// The same instant is a different time of day depending on where you are, and the rule follows the
// user, not the server. 12:30Z is mid-afternoon in Istanbul, so that card waits until tomorrow; it
// is 05:30 in California, so today's 08:00 is still ahead and clears the floor. Same rule, same
// moment, two answers, both right.
const rLA = nextReturn(afternoon, LA);
eq("California gets this morning", rLA.at.toISOString(), "2026-07-29T15:00:00.000Z");
eq("Istanbul gets tomorrow morning", r1.at.toISOString(), "2026-07-30T05:00:00.000Z");
check("both land on local 08:00", rLA.rule === "next morning" && r1.rule === "next morning");
eq("wake day is LOCAL to LA, not Istanbul's calendar date", rLA.wakeDay, "2026-07-29");
// Month end must roll over, not produce the 32nd.
const monthEnd = nextReturn(new Date("2026-07-31T12:30:00.000Z"), IST);
eq("end of month", monthEnd.at.toISOString(), "2026-08-01T05:00:00.000Z");
// The regression this guards: reusing the pre-rollover y/m/d instead of reading `at` back through
// dayKeyInTz would report the wake day as the 31st, one day behind where the card actually lands.
eq("wake day rolls into the new month too", monthEnd.wakeDay, "2026-08-01");
// Year end likewise.
const yearEnd = nextReturn(new Date("2026-12-31T12:30:00.000Z"), IST);
eq("end of year", yearEnd.at.toISOString(), "2027-01-01T05:00:00.000Z");
eq("wake day rolls into the new year too", yearEnd.wakeDay, "2027-01-01");

console.log("\n--- resolveWake: the wall-clock intention follows the user, the floor instant never moves ---");
// THE case resolveWake exists for: deferred in Istanbul at 14:00, `at` is fixed to the Istanbul instant.
// Resolved against that stored instant after a flight to Los Angeles it would land at 22:00 the evening
// before, local to LA. Resolved through the wake day instead, it lands at 08:00 LA local, the same
// answer anyone who stayed in Istanbul would get.
const deferredInIst = nextReturn(new Date("2026-07-29T11:00:00.000Z"), IST); // 14:00 Istanbul
eq("still the Istanbul-fixed instant in `at`", deferredInIst.at.toISOString(), "2026-07-30T05:00:00.000Z");
eq("wake day travels alongside it", deferredInIst.wakeDay, "2026-07-30");
const wokenInLA = resolveWake(deferredInIst.wakeDay, deferredInIst.at, LA);
eq("resolves to 08:00 LOCAL LA, not the Istanbul instant", wokenInLA.toISOString(), "2026-07-30T15:00:00.000Z");
check(
  "genuinely a different instant than the one stored",
  wokenInLA.getTime() !== deferredInIst.at.getTime(),
  `stored ${deferredInIst.at.toISOString()}, resolved ${wokenInLA.toISOString()}`,
);

// The floor rule is a real instant, not an intention: a null wake day must come back completely
// unchanged, even resolved in a zone the card was never deferred in.
const resolvedFloor = resolveWake(r2.wakeDay, r2.at, LA);
eq("floor instant is untouched by a zone change", resolvedFloor.toISOString(), r2.at.toISOString());
check("exactly the same instant, not just equal-looking", resolvedFloor.getTime() === r2.at.getTime());

// A malformed wake day (hand-edited row, truncated write, future schema slip) must fall back to
// the stored instant rather than throw: the same defensive posture wake.ts already takes for a
// card missing snoozedUntil or snoozedAt. A bad string must never strand a card in a status
// nothing looks at.
const stored = new Date("2026-07-30T05:00:00.000Z");
eq("garbage wake day falls back, does not throw", resolveWake("not-a-date", stored, LA).toISOString(), stored.toISOString());
eq("empty string falls back", resolveWake("", stored, LA).toISOString(), stored.toISOString());
eq("truncated wake day falls back", resolveWake("2026-07", stored, LA).toISOString(), stored.toISOString());

console.log("\n--- how many times you can defer ---");
eq("first deferral is fine", isSnoozeExhausted(0), false);
eq("second", isSnoozeExhausted(1), false);
eq("third", isSnoozeExhausted(2), false);
eq(`after ${MAX_SNOOZES} it stops coming back`, isSnoozeExhausted(MAX_SNOOZES), true);
eq("and stays stopped", isSnoozeExhausted(MAX_SNOOZES + 5), true);

console.log("\n--- waking up: what is simply due ---");
const now = new Date("2026-07-30T06:00:00.000Z");
const card = (id: string, untilMinFromNow: number, atMinAgo: number) => ({
  id,
  snoozedUntil: new Date(now.getTime() + untilMinFromNow * 60_000),
  snoozedAt: new Date(now.getTime() - atMinAgo * 60_000),
});
const dueOnly = selectWakes([card("a", -60, 900), card("b", 600, 30)], now, 5);
eq("past its time comes back", dueOnly.due.join(","), "a");
eq("not yet due stays away", dueOnly.pulledForward.join(","), "");

console.log("\n--- waking up: the deck is thin ---");
// Deck empty, two deferrals both well past the floor. Fill up to the target, no further.
const thin = selectWakes([card("x", 600, 300), card("y", 700, 300), card("z", 800, 300)], now, 0);
eq("nothing was due", thin.due.join(","), "");
eq("pulls forward exactly the deck target", thin.pulledForward.length, DECK_TARGET);
// Soonest first: the one closest to its natural return is the least surprising to bring back.
eq("soonest first", thin.pulledForward.join(","), "x,y,z");
const nearlyFull = selectWakes([card("x", 600, 300), card("y", 700, 300)], now, 2);
eq("only tops up to the target", nearlyFull.pulledForward.join(","), "x");

console.log("\n--- the floor beats the thin-deck rule ---");
// THE case that matters: defer three cards this afternoon, deck is now empty. They must NOT come
// straight back, or "Later" means nothing. Deck stays short on purpose.
const justDeferred = selectWakes([card("p", 900, 5), card("q", 900, 5), card("r", 900, 5)], now, 0);
eq("nothing due", justDeferred.due.join(","), "");
eq("and nothing pulled forward", justDeferred.pulledForward.join(","), "");
// Once the floor has passed, the same empty deck does refill.
const later = selectWakes([card("p", 900, SNOOZE_FLOOR_MIN + 1)], now, 0);
eq("after the floor it refills", later.pulledForward.join(","), "p");
// Exactly on the boundary counts as served.
eq("exactly at the floor", selectWakes([card("p", 900, SNOOZE_FLOOR_MIN)], now, 0).pulledForward.join(","), "p");

console.log("\n--- a full deck is left alone ---");
eq("nothing pulled when full", selectWakes([card("x", 600, 300)], now, DECK_TARGET).pulledForward.join(","), "");
// Due cards count toward the target, so they do not trigger extra pulling.
const dueFills = selectWakes([card("a", -10, 900), card("b", 600, 900), card("c", 600, 900)], now, 2);
eq("due card counts toward the deck", dueFills.due.join(","), "a");
eq("so nothing extra is pulled", dueFills.pulledForward.join(","), "");

console.log("\n--- nothing to do ---");
eq("no snoozed cards", selectWakes([], now, 0).due.length + selectWakes([], now, 0).pulledForward.length, 0);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
