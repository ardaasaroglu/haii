/** When a deferred card comes back.
 *
 *  Swiping left offers Later or Dismiss and nothing else: the value of the gesture is that it is
 *  fast, and a duration picker on a card you are trying to get rid of defeats it. That is the right
 *  call, and it moves the question rather than removing it. The user is no longer saying WHEN, so
 *  these rules decide, and they pull against each other on purpose.
 *
 *    next morning   back at 08:00 local, so it lands with the day's cards rather than mid-afternoon
 *    2h floor       never sooner, or "Later" means nothing (it started at 4h)
 *    thin deck      under 3 live cards the soonest deferral returns early, but never through
 *                   the floor
 *    3 then stop    otherwise "Later" quietly becomes "never" and the card dies anyway, slower
 *
 *  The interesting case is the floor beating the thin-deck rule: defer three cards in one
 *  afternoon and the deck sits at 2 rather than refilling with the things you just pushed away.
 *  That is deliberate. Instant return reads as broken.
 *
 *  Pure, so the rules can be tested without a database or a clock. Validated first as a UI
 *  prototype.
 */
import { dayKeyInTz, zonedTimeToUtc } from "./tz";

/** A card you just pushed away must not reappear within this. */
export const SNOOZE_FLOOR_MIN = 120;
/** Local hour a deferred card comes back on. */
export const SNOOZE_MORNING_HOUR = 8;
/** After this many deferrals the card stops returning and goes to history. */
export const MAX_SNOOZES = 3;
/** The deck renders three (server/public/index.html, S.deck.slice(0,3)). */
export const DECK_TARGET = 3;

export interface SnoozedCard {
  id: string;
  /** When it is due back under the normal rule. */
  snoozedUntil: Date;
  /** When the user deferred it. The floor is measured from here, not from `snoozedUntil`. */
  snoozedAt: Date;
}

/** The instant a card deferred `now` should return, and which rule decided it.
 *
 *  `wakeDay` is the wall-clock INTENTION behind the "next morning" rule: the local day (in `tz`)
 *  that 08:00 belongs to. `at` is only correct in the zone the card was deferred in; travel makes
 *  it wrong, and `wakeDay` is what resolveWake below re-derives the real instant from, in whatever
 *  zone the user is actually in when the card wakes. The floor rule has no such intention, it IS
 *  the instant, so `wakeDay` is null there and resolveWake must leave it alone. */
export function nextReturn(
  now: Date,
  tz: string,
): { at: Date; rule: "next morning" | "floor"; wakeDay: string | null } {
  const floor = new Date(now.getTime() + SNOOZE_FLOOR_MIN * 60_000);
  const [y, m, d] = dayKeyInTz(tz, now).split("-").map(Number);

  // The NEXT 08:00, which is today's when the user defers before it and tomorrow's after.
  // Jumping straight to tomorrow (as the prototype did) makes the floor unreachable: tomorrow is
  // always about 24h away, so the branch below could never fire and a card deferred at 06:00 sat
  // out the whole day for no reason.
  let at = zonedTimeToUtc(tz, y, m, d, SNOOZE_MORNING_HOUR, 0);
  if (at.getTime() <= now.getTime()) {
    // Date.UTC normalises a day overflow (the 32nd becomes the 1st), so month and year ends are free.
    const t = new Date(Date.UTC(y, m - 1, d + 1));
    at = zonedTimeToUtc(tz, t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), SNOOZE_MORNING_HOUR, 0);
  }
  // Deferring at 07:00 would otherwise put the card back an hour later, which is not "later".
  if (at.getTime() < floor.getTime()) return { at: floor, rule: "floor", wakeDay: null };
  // Read the day back through dayKeyInTz rather than reusing y/m/d above: on the rollover branch
  // those still hold YESTERDAY's date. Every bug in this area has been a call site's own date
  // maths standing in for tz.ts instead of asking it.
  return { at, rule: "next morning", wakeDay: dayKeyInTz(tz, at) };
}

/** The real instant a deferred card should wake, re-resolving the "next morning" rule's wall-clock
 *  intention against whatever zone the user is in RIGHT NOW.
 *
 *  `storedUntil` (the persisted `snoozedUntil`) is only trustworthy on its own for the floor rule,
 *  which is a genuine instant. For "next morning" it is fixed to the zone the card was deferred
 *  in, so a card deferred in one zone and woken after a flight to a zone ten hours behind would
 *  otherwise come back at 22:00 the evening before, local to the new zone. `wakeDay` carries the intention instead: null
 *  means the floor rule decided (return the instant untouched), and a malformed value falls back
 *  to `storedUntil` rather than throwing, the same defensive posture jobs/wake.ts already takes
 *  for a card missing snoozedUntil or snoozedAt. A bad string must never strand a card in a status
 *  nothing looks at. */
export function resolveWake(wakeDay: string | null, storedUntil: Date, tz: string): Date {
  if (wakeDay === null) return storedUntil;
  // Same shape check jobs/executor.ts uses for a card's date payload.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(wakeDay)) return storedUntil;
  const [y, m, d] = wakeDay.split("-").map(Number);
  return zonedTimeToUtc(tz, y, m, d, SNOOZE_MORNING_HOUR, 0);
}

/** Has this card been deferred as many times as it is allowed? */
export function isSnoozeExhausted(snoozeCount: number): boolean {
  return snoozeCount >= MAX_SNOOZES;
}

/** Which deferred cards should come back right now.
 *
 *  `due` are simply past their time. `pulledForward` are early because the deck is thin, and only
 *  ever cards that have already served the floor: a deck that refills instantly with what you just
 *  dismissed is worse than a deck that is briefly short.
 */
export function selectWakes(
  snoozed: SnoozedCard[],
  now: Date,
  liveCount: number,
): { due: string[]; pulledForward: string[] } {
  const due: string[] = [];
  const rest: SnoozedCard[] = [];
  for (const c of snoozed) {
    if (c.snoozedUntil.getTime() <= now.getTime()) due.push(c.id);
    else rest.push(c);
  }

  const pulledForward: string[] = [];
  let live = liveCount + due.length;
  if (live >= DECK_TARGET) return { due, pulledForward };

  const eligible = rest
    .filter((c) => now.getTime() - c.snoozedAt.getTime() >= SNOOZE_FLOOR_MIN * 60_000)
    .sort((a, b) => a.snoozedUntil.getTime() - b.snoozedUntil.getTime());
  for (const c of eligible) {
    if (live >= DECK_TARGET) break;
    pulledForward.push(c.id);
    live++;
  }
  return { due, pulledForward };
}
