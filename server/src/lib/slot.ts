import { zonedTimeToUtc, dayBoundsInTz, dayKeyInTz } from "./tz";


/** The earliest instant a proposed meeting may start. Pure so the rule is testable; jobs/extract.ts
 *  is not.
 *
 *  The rule, and the qualifier is the whole thing: do not schedule for the same day IF THERE IS NO
 *  CLUE ABOUT TIME. So a stated clock time may land today; a meeting nobody timed may not, because
 *  by the time the user reads that card the slot may already have passed and same-day is the one
 *  outcome editing cannot rescue.
 *
 *  TWO BUGS THIS FIXES, both shipped together and both found by review rather than by anything
 *  failing:
 *
 *  1. A model date in the PAST. extract.ts fed the hint straight through, and the deterministic
 *     fallback (nextWorkdayStart) honours whatever floor it is given, so a hallucinated or
 *     misresolved "2026-07-01" produced a card proposing a meeting last month. The executor would
 *     have created it.
 *  2. The not-today rule silently defeated by the same input. findOpenSlot clamps its floor to
 *     now+10min, so a past hint collapsed to TODAY and proposed a slot this afternoon, which is
 *     precisely what the rule exists to prevent. */
export function earliestProposalMs(
  tz: string,
  hintYmd: string | null | undefined,
  opts: { timeWasStated: boolean; now?: Date },
): number {
  const now = opts.now ?? new Date();
  // dayBoundsInTz().end is one millisecond before local midnight, so +1 is tomorrow at 00:00 in
  // the user's zone. Never hand-rolled: lib/tz.ts owns this arithmetic.
  const tomorrow = dayBoundsInTz(tz, now).end.getTime() + 1;
  const h = String(hintYmd ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(h)) return tomorrow;
  const [Y, Mo, D] = h.split("-").map(Number);
  const hinted = zonedTimeToUtc(tz, Y, Mo, D, 0, 0).getTime();
  // A stated time is a commitment two people made out loud. Respect the day it was made for, even
  // if that day is today, and never drag it forward to tomorrow.
  if (opts.timeWasStated) return Math.max(hinted, now.getTime());
  return Math.max(hinted, tomorrow);
}

/** A busy interval, epoch ms, half-open [start, end). */
export interface Interval {
  start: number;
  end: number;
}

export interface SlotOpts {
  tz: string;
  fromMs: number; // earliest acceptable start (absolute)
  days: number; // how many calendar days to scan starting at fromMs
  workStartHour: number; // wall-clock in tz
  workEndHour: number; // wall-clock in tz (a slot must END by this hour)
  durationMin: number;
  stepMin?: number; // candidate-start granularity, default 30
  skipWeekends?: boolean; // default true
}

/** Has this wall clock already gone by? The whole of "never schedule for the past", in one place.
 *
 *  The bug it fixes: a Slack message said "sync with Omar at 16:30", the card was right when it was
 *  made, the user did not see it until after 16:30, and swiping it put a meeting in their calendar
 *  in the past.
 *
 *  THE REASON NOTHING CAUGHT IT is worth writing down. The executor already re-checks a card's slot
 *  before creating, because cards live 7 days and the slot may have been taken. But the check is
 *  isSlotFree, which asks "is anyone busy in that window". **Nobody is ever busy in the past**, so
 *  a time that had gone by passed the freshness check as free. The staleness guard asked whether
 *  the slot was still OPEN and never whether it was still AHEAD.
 *
 *  Both ends need it, which is why it lives here rather than in either caller. Extraction must not
 *  PROPOSE a past time, and the executor must not CREATE one, and those are different moments up to
 *  seven days apart. */
export function startHasPassed(tz: string, ymd: string, hhmm: string, now: Date = new Date()): boolean {
  const d = String(ymd ?? "").trim();
  const t = String(hhmm ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{1,2}:\d{2}$/.test(t)) return false; // malformed is a different error
  const [Y, Mo, D] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  return zonedTimeToUtc(tz, Y, Mo, D, h, mi).getTime() < now.getTime();
}


/** The deterministic fallback, for when free/busy cannot answer: no calendar scope, an API error,
 *  or genuinely no gap in the next fortnight.
 *
 *  Returns the first WEEKDAY at `hour` wall-clock in `tz` that starts at or after `fromMs`. It
 *  exists because a calendar card with no time at all cannot be approved, and such a commitment
 *  used to at least survive as a to-do. Proposing a plausible slot the user can
 *  edit beats proposing nothing; the card records that the time was not verified against anyone's
 *  calendar, so it is a suggestion that says so rather than a fact that is wrong. */
export function nextWorkdayStart(tz: string, fromMs: number, hour: number): number {
  for (let dayOffset = 0; dayOffset < 10; dayOffset++) {
    const probe = new Date(fromMs + dayOffset * 24 * 3600_000);
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(probe);
    if (wd === "Sat" || wd === "Sun") continue;
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(probe);
    const [Y, Mo, D] = ymd.split("-").map(Number);
    const startMs = zonedTimeToUtc(tz, Y, Mo, D, hour, 0).getTime();
    // A same-day probe whose hour has already passed is not a candidate; the next loop is.
    if (startMs >= fromMs) return startMs;
  }
  // Ten weekday-free days is impossible, but never return a time in the past.
  return fromMs;
}

/** Kept separate from schedule.ts (which pulls in the db + Google clients) so this, the only
 *  fiddly logic, is unit-testable in isolation. Depends on tz.ts (Intl-only) and nothing else.
 *
 *  Returns the earliest working-hours slot of `durationMin` on an allowed weekday that starts
 *  at/after `fromMs`, ends by `workEndHour` (wall-clock in `tz`), and overlaps none of `busy`.
 *  Null if the window holds no such gap. */
export function pickSlot(busy: Interval[], opts: SlotOpts): { startMs: number; endMs: number } | null {
  const stepMin = opts.stepMin ?? 30;
  const skipWeekends = opts.skipWeekends ?? true;
  const durMs = opts.durationMin * 60_000;
  const lastStartMin = opts.workEndHour * 60 - opts.durationMin;
  if (lastStartMin < opts.workStartHour * 60) return null; // duration longer than the working day

  const sorted = [...busy].sort((a, b) => a.start - b.start);
  const isFree = (s: number, e: number) => !sorted.some((b) => s < b.end && e > b.start);

  for (let dayOffset = 0; dayOffset < opts.days; dayOffset++) {
    const probe = new Date(opts.fromMs + dayOffset * 24 * 3600_000);
    if (skipWeekends) {
      const wd = new Intl.DateTimeFormat("en-US", { timeZone: opts.tz, weekday: "short" }).format(probe);
      if (wd === "Sat" || wd === "Sun") continue;
    }
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: opts.tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(probe);
    const [Y, Mo, D] = ymd.split("-").map(Number);

    for (let min = opts.workStartHour * 60; min <= lastStartMin; min += stepMin) {
      const startMs = zonedTimeToUtc(opts.tz, Y, Mo, D, Math.floor(min / 60), min % 60).getTime();
      if (startMs < opts.fromMs) continue; // future only
      const endMs = startMs + durMs;
      if (isFree(startMs, endMs)) return { startMs, endMs };
    }
  }
  return null;
}
