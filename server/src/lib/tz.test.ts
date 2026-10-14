/** Tests for the timezone helpers, and specifically for the rule that decides which zone a
 *  calendar card's wall clock is resolved in.
 *
 *  This exists because of a real bug: a card carries `date` + `time` with no offset and lives 7
 *  days, and the executor resolved it against users.tz at APPROVAL time. Propose "Thu 14:00" in
 *  Istanbul, fly to Los Angeles, nod, and Google gets 14:00 Pacific. Ten hours out, silently, with the
 *  card rendering the same string before and after the flight, so nothing on screen ever changed.
 *
 *  CLAUDE.md: lib/tz.ts owns all timezone maths, and every bug in this area has been a call site
 *  bypassing it. So the decision lives here as a pure function rather than inline in the executor,
 *  and it is tested here.
 *
 *  Pure functions only: no database, no HTTP. `npm test -w @haii/server`
 */
import {
  cardResolutionTz, isValidTz, isValidLocale, userTz,
  zonedTimeToUtc, dayKeyInTz, hhmmInTz, hhmmForUser,
} from "./tz";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, String(got) === String(want), `got ${got}, want ${want}`);

console.log("\n--- which zone resolves a card's wall clock ---");
eq("stamp wins over the live zone", cardResolutionTz("Europe/Istanbul", "America/Los_Angeles"), "Europe/Istanbul");
eq("stamp used when it equals the live zone", cardResolutionTz("Europe/Istanbul", "Europe/Istanbul"), "Europe/Istanbul");
eq("no stamp falls back to the live zone", cardResolutionTz(undefined, "America/Los_Angeles"), "America/Los_Angeles");
eq("null stamp falls back", cardResolutionTz(null, "Europe/Istanbul"), "Europe/Istanbul");
eq("empty-string stamp falls back", cardResolutionTz("", "Europe/Istanbul"), "Europe/Istanbul");
eq("garbage stamp falls back rather than throwing", cardResolutionTz("Mars/Olympus", "Europe/Istanbul"), "Europe/Istanbul");
eq("the 'local' sentinel is not a zone", cardResolutionTz("local", "Europe/Istanbul"), "Europe/Istanbul");
eq("non-string stamp falls back", cardResolutionTz(42, "Europe/Istanbul"), "Europe/Istanbul");
// Both missing is the pre-timezone-capture user. UTC is wrong for them but it is the documented
// fallback everywhere else in this file, and it must not throw.
eq("no stamp and no user zone lands on UTC", cardResolutionTz(undefined, undefined), "UTC");
eq("no stamp and the 'local' sentinel lands on UTC", cardResolutionTz(undefined, "local"), "UTC");

console.log("\n--- the bug this was written for ---");
// Propose Thu 2026-08-06 14:00 in Istanbul. Fly to Los Angeles. Approve.
const PROPOSED = { y: 2026, mo: 8, d: 6, h: 14, mi: 0 };
const stamped = cardResolutionTz("Europe/Istanbul", "America/Los_Angeles");
const unstamped = cardResolutionTz(undefined, "America/Los_Angeles");
const withStamp = zonedTimeToUtc(stamped, PROPOSED.y, PROPOSED.mo, PROPOSED.d, PROPOSED.h, PROPOSED.mi);
const withoutStamp = zonedTimeToUtc(unstamped, PROPOSED.y, PROPOSED.mo, PROPOSED.d, PROPOSED.h, PROPOSED.mi);
eq("stamped card books 14:00 Istanbul", withStamp.toISOString(), "2026-08-06T11:00:00.000Z");
eq("unstamped card books 14:00 Pacific (the old behaviour)", withoutStamp.toISOString(), "2026-08-06T21:00:00.000Z");
eq(
  "the gap the bug produced, in hours",
  (withoutStamp.getTime() - withStamp.getTime()) / 3_600_000,
  10,
);
// The attendees were invited to 14:00 Istanbul. Rendering the stamped instant back in Istanbul
// must return the same wall clock the card showed, or the fix has only moved the error.
eq("stamped instant still reads 14:00 in Istanbul", hhmmInTz("Europe/Istanbul", withStamp), "14:00");
eq("stamped instant is the same calendar day in Istanbul", dayKeyInTz("Europe/Istanbul", withStamp), "2026-08-06");

console.log("\n--- guards the fallback relies on ---");
eq("isValidTz rejects the 'local' sentinel", isValidTz("local"), false);
eq("isValidTz rejects a bogus zone", isValidTz("Mars/Olympus"), false);
eq("isValidTz accepts a real zone", isValidTz("America/New_York"), true);
eq("userTz falls back to UTC", userTz("nonsense"), "UTC");

console.log("\n--- machine time must never move ---");
// findOpenSlot writes this into a card's `time` payload and executor.ts validates it with
// /^\d{1,2}:\d{2}$/ before creating the event. If hhmmInTz ever learns about locale, every
// calendar approval starts failing that regex. These assertions exist to make that break loudly.
const AFTERNOON = new Date("2026-08-06T11:00:00.000Z"); // 14:00 Istanbul
eq("24h in Istanbul", hhmmInTz("Europe/Istanbul", AFTERNOON), "14:00");
eq("24h in New York, no AM/PM", hhmmInTz("America/New_York", AFTERNOON), "07:00");
check("always matches the executor's regex", /^\d{1,2}:\d{2}$/.test(hhmmInTz("America/New_York", AFTERNOON)));

console.log("\n--- human time follows the reader ---");
eq("a US reader gets 2:00 PM", hhmmForUser("Europe/Istanbul", "en-US", AFTERNOON), "2:00 PM");
eq("a Turkish reader gets 14:00", hhmmForUser("Europe/Istanbul", "tr-TR", AFTERNOON), "14:00");
eq("a British reader gets 14:00", hhmmForUser("Europe/Istanbul", "en-GB", AFTERNOON), "14:00");
// Zone and locale are independent: an American in Istanbul wants 2:00 PM in Istanbul time.
eq("US locale, Istanbul zone", hhmmForUser("Europe/Istanbul", "en-US", AFTERNOON), "2:00 PM");
eq("US locale, New York zone", hhmmForUser("America/New_York", "en-US", AFTERNOON), "7:00 AM");
// Falling back to en-GB is what every one of these surfaces did before the column existed.
eq("no locale recorded yet", hhmmForUser("Europe/Istanbul", "", AFTERNOON), "14:00");
eq("null locale", hhmmForUser("Europe/Istanbul", null, AFTERNOON), "14:00");
eq("garbage locale does not throw", hhmmForUser("Europe/Istanbul", "not-a-locale!!", AFTERNOON), "14:00");
eq("midnight in a 12h locale", hhmmForUser("UTC", "en-US", new Date("2026-08-06T00:00:00.000Z")), "12:00 AM");
eq("noon in a 12h locale", hhmmForUser("UTC", "en-US", new Date("2026-08-06T12:00:00.000Z")), "12:00 PM");

console.log("\n--- locale validation ---");
eq("accepts en-US", isValidLocale("en-US"), true);
eq("accepts tr", isValidLocale("tr"), true);
eq("rejects empty", isValidLocale(""), false);
eq("rejects nonsense", isValidLocale("not-a-locale!!"), false);
eq("rejects non-string", isValidLocale(42), false);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
