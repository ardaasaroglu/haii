/** Tests for lib/slot.ts: the working-hours slot picker, and the deterministic fallback.
 *
 *  This file exists because a calendar card became proposable with no time in it, which
 *  moves real weight onto both functions here: pickSlot now decides the hour for most cards rather
 *  than merely second-guessing the model, and nextWorkdayStart is the only thing standing between a
 *  free/busy failure and a card nobody can approve.
 *
 *  Fixtures use Europe/Istanbul (UTC+3, no DST since 2016) so the arithmetic is checkable by hand.
 *  2026-08-03 is a Monday, 08-07 a Friday, 08-08 a Saturday, 08-10 a Monday.
 *
 *  Pure: no database, no network, no wall clock. `npx tsx src/lib/slot.test.ts`
 */
import { pickSlot, nextWorkdayStart, earliestProposalMs, startHasPassed, type Interval } from "./slot";
import { zonedTimeToUtc, dayKeyInTz, hhmmInTz } from "./tz";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, String(got) === String(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const TZ = "Europe/Istanbul";
/** Local wall clock in TZ to epoch ms. */
const at = (ymd: string, h: number, mi = 0) => {
  const [Y, Mo, D] = ymd.split("-").map(Number);
  return zonedTimeToUtc(TZ, Y, Mo, D, h, mi).getTime();
};
/** How a proposal is rendered onto a card. */
const render = (ms: number) => `${dayKeyInTz(TZ, new Date(ms))} ${hhmmInTz(TZ, new Date(ms))}`;

console.log("\n--- nextWorkdayStart: the fallback when free/busy cannot answer ---");
eq("before the hour on a weekday stays that day", render(nextWorkdayStart(TZ, at("2026-08-04", 8), 10)), "2026-08-04 10:00");
eq("exactly the hour counts as at-or-after", render(nextWorkdayStart(TZ, at("2026-08-04", 10), 10)), "2026-08-04 10:00");
// The one that matters: by the time a user reads a card proposing 10:00 today, 10:00 today may be
// gone. Past the hour, the answer is the next day, never a time that has already happened.
eq("after the hour rolls to the next weekday", render(nextWorkdayStart(TZ, at("2026-08-04", 11), 10)), "2026-08-05 10:00");
eq("Friday afternoon skips the weekend", render(nextWorkdayStart(TZ, at("2026-08-07", 15), 10)), "2026-08-10 10:00");
eq("Saturday skips to Monday", render(nextWorkdayStart(TZ, at("2026-08-08", 9), 10)), "2026-08-10 10:00");
eq("Sunday skips to Monday", render(nextWorkdayStart(TZ, at("2026-08-09", 9), 10)), "2026-08-10 10:00");
check("never returns a time before the floor it was given", nextWorkdayStart(TZ, at("2026-08-07", 15), 10) >= at("2026-08-07", 15));

console.log("\n--- the not-today rule: a meeting nobody timed must not land in ninety minutes ---");
{
  // The not-today rule. jobs/extract.ts passes tomorrow-at-midnight as the floor when the
  // transcript pinned nothing, and BOTH the slot picker and the fallback have to respect it,
  // because a user cannot rescue a same-day proposal by editing a card they have not read yet.
  const tomorrowMidnight = at("2026-08-05", 0);
  const slot = pickSlot([], {
    tz: TZ,
    fromMs: tomorrowMidnight,
    days: 14,
    workStartHour: 9,
    workEndHour: 18,
    durationMin: 30,
  });
  eq("an empty calendar proposes tomorrow at the start of the working day", slot ? render(slot.startMs) : null, "2026-08-05 09:00");
  eq("and the fallback agrees on the day", render(nextWorkdayStart(TZ, tomorrowMidnight, 10)), "2026-08-05 10:00");
}
{
  // A named day is a floor, not a suggestion: "next Tuesday" must not be answered with Monday.
  const hinted = at("2026-08-10", 0);
  const slot = pickSlot([], { tz: TZ, fromMs: hinted, days: 14, workStartHour: 9, workEndHour: 18, durationMin: 30 });
  eq("a date hint moves the search to that day", slot ? render(slot.startMs) : null, "2026-08-10 09:00");
}

console.log("\n--- earliestProposalMs: the floor, and the two bugs review caught in it ---");
{
  // "Now" is Tuesday 2026-08-04 at 14:00 Istanbul throughout.
  const NOW = new Date(at("2026-08-04", 14));
  const floor = (hint: string | null, timeWasStated = false) =>
    render(earliestProposalMs(TZ, hint, { timeWasStated, now: NOW }));

  eq("nothing stated at all lands on tomorrow, not this afternoon", floor(null), "2026-08-05 00:00");
  eq("an unparseable hint is the same as none", floor("next week"), "2026-08-05 00:00");
  eq("a future day is respected as the floor", floor("2026-08-10"), "2026-08-10 00:00");

  // BUG 1, shipped and then caught by review. A hallucinated or misresolved past date fed
  // straight through, and the deterministic fallback honours whatever floor it is handed, so the
  // card proposed a meeting LAST MONTH and the executor would have created it.
  eq("a date in the past cannot pull a proposal backwards", floor("2026-07-01"), "2026-08-05 00:00");

  // BUG 2, same input, different mechanism. findOpenSlot clamps its floor to now+10min, so a past
  // hint collapsed to TODAY and proposed a slot this afternoon: the not-today rule defeated
  // silently by a date the model got wrong.
  eq("and cannot collapse the floor to today either", floor("2026-08-04"), "2026-08-05 00:00");

  // The qualifier in the rule, which is the whole rule: no same day IF THERE IS NO CLUE ABOUT
  // TIME. "Let's talk at 4 today" is two people agreeing out loud and must not be dragged to
  // tomorrow.
  eq("a STATED time may land today", floor("2026-08-04", true), "2026-08-04 14:00");
  eq("a stated time on a future day keeps that day", floor("2026-08-10", true), "2026-08-10 00:00");
  // Even with a stated time, a day that has already gone cannot be proposed.
  eq("a stated time in the past still cannot be proposed", floor("2026-07-01", true), "2026-08-04 14:00");
  eq("a stated time with no day is treated as no clue", floor(null, true), "2026-08-05 00:00");
}

console.log("\n--- startHasPassed: never schedule for the past, at either end ---");
{
  // The bug: a Slack card said "sync with Omar at 16:30", the user did not see it until after
  // 16:30, and swiping it created a meeting earlier that afternoon.
  const NOW = new Date(at("2026-08-04", 17, 30));
  const past = (ymd: string, hhmm: string) => startHasPassed(TZ, ymd, hhmm, NOW);

  check("THE BUG: 16:30 today, swiped at 17:30", past("2026-08-04", "16:30") === true);
  check("a time still ahead today is fine", past("2026-08-04", "18:00") === false);
  check("this minute is not past", past("2026-08-04", "17:30") === false);
  check("yesterday is past whatever the hour", past("2026-08-03", "23:59") === true);
  check("tomorrow is not", past("2026-08-05", "00:01") === false);
  // isSlotFree could never have caught this: nobody is ever busy in the past, so a time that had
  // gone by passed the freshness check as FREE. That check asks whether the slot is still open and
  // never whether it is still ahead.
  check("a single-digit hour parses", past("2026-08-04", "9:00") === true);
  // Malformed is a different error with its own message; this must not swallow it.
  check("a malformed date is not reported as past", past("not-a-date", "16:30") === false);
  check("a malformed time is not reported as past", past("2026-08-04", "half four") === false);
  check("an empty payload is not reported as past", past("", "") === false);
  // The zone is the one the card was PROPOSED in, and it decides the answer near a boundary.
  check(
    "the same wall clock differs by zone",
    startHasPassed("Europe/Istanbul", "2026-08-04", "16:30", NOW) === true &&
      startHasPassed("America/Los_Angeles", "2026-08-04", "16:30", NOW) === false,
  );
}

console.log("\n--- pickSlot: it now decides the hour for most cards, not just second-guesses one ---");
{
  const busy: Interval[] = [
    { start: at("2026-08-05", 9), end: at("2026-08-05", 12) },
    { start: at("2026-08-05", 12, 30), end: at("2026-08-05", 17, 30) },
  ];
  const slot = pickSlot(busy, { tz: TZ, fromMs: at("2026-08-05", 0), days: 3, workStartHour: 9, workEndHour: 18, durationMin: 30 });
  eq("takes the 30 minute gap between two blocks", slot ? render(slot.startMs) : null, "2026-08-05 12:00");
}
{
  // The gap is real but too short. Silently returning it would double-book the user.
  const busy: Interval[] = [
    { start: at("2026-08-05", 9), end: at("2026-08-05", 12) },
    { start: at("2026-08-05", 12, 30), end: at("2026-08-05", 18) },
  ];
  const slot = pickSlot(busy, { tz: TZ, fromMs: at("2026-08-05", 0), days: 2, workStartHour: 9, workEndHour: 18, durationMin: 60 });
  eq("a 30 minute gap cannot hold a 60 minute meeting, so it moves on", slot ? render(slot.startMs) : null, "2026-08-06 09:00");
}
{
  const busy: Interval[] = [{ start: at("2026-08-07", 9), end: at("2026-08-07", 18) }];
  const slot = pickSlot(busy, { tz: TZ, fromMs: at("2026-08-07", 0), days: 4, workStartHour: 9, workEndHour: 18, durationMin: 30 });
  eq("a full Friday skips the weekend, not into it", slot ? render(slot.startMs) : null, "2026-08-10 09:00");
}
{
  const slot = pickSlot([], { tz: TZ, fromMs: at("2026-08-05", 0), days: 5, workStartHour: 9, workEndHour: 18, durationMin: 600 });
  eq("a meeting longer than the working day has no slot at all", slot, "null");
}
{
  // A slot must END by the closing hour, not merely start before it.
  const busy: Interval[] = [{ start: at("2026-08-05", 9), end: at("2026-08-05", 17) }];
  const slot = pickSlot(busy, { tz: TZ, fromMs: at("2026-08-05", 0), days: 2, workStartHour: 9, workEndHour: 18, durationMin: 90 });
  eq("90 minutes will not fit in the last hour, so it takes the next day", slot ? render(slot.startMs) : null, "2026-08-06 09:00");
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
