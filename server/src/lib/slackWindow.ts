/** How far back Slack listening is allowed to look, and nothing else.
 *
 *  Pure and dependency-free so the rule can be tested without a database, a Slack token or a clock.
 *  jobs/slackListen.ts does the searching; this decides the window it may search.
 *
 *  THE BUG THIS EXISTS TO PREVENT, because it shipped and reached a real user: the
 *  query was `from:<@me> after:<cursor>` when a cursor existed, and a bare `from:<@me>` when one did
 *  not. On a first run there is no cursor, so the search had NO lower bound and covered the user's
 *  entire Slack history. Paired with `sort_dir: asc` that returns the OLDEST messages in the
 *  account, so the very first batch was the oldest 60 messages the user had ever written, and cards
 *  were minted from conversations months dead.
 *
 *  It did not end there. The cursor advanced only to the newest of that batch, still months old, so
 *  each four-hourly run crawled another 60 messages forward through history, manufacturing stale
 *  cards the whole way and never reaching the present.
 *
 *  The fix is a floor that applies ALWAYS, not only when a cursor is missing: `max(cursor, floor)`.
 *  A cursor can be absent, or stale after an outage, and neither may drag the window backwards.
 */

/** The furthest back a run may reach, whatever the cursor says. Expressed in hours because the
 *  reasoning is about missed CYCLES, not calendar days.
 *
 *  24 hours is six missed four-hourly runs. Past that, this jumps to the present and skips what it
 *  missed, which is the correct behaviour and not a compromise.
 *
 *  WHY SKIPPING BEATS CATCHING UP, and this is the whole argument: the two errors are not equal.
 *  A stale card costs the user attention AND pollutes the learning loop, because a dismissal now
 *  teaches the extraction prompt and feeds durable memory, so a card the user shakes off because it
 *  is three days old teaches "propose fewer of these" from a timing problem. A missed commitment
 *  costs one card that, if it still matters, resurfaces in a meeting or another message and is
 *  caught by the transcript path anyway. With many cards already going undecided,
 *  the failure to avoid is clearly the first one.
 *
 *  Worst realistic gap, checked rather than assumed: down from Friday evening to Monday morning,
 *  about 60 hours. Friday's and Saturday's commitments are skipped. By Monday those are two and
 *  three days old, which by the argument above should not be minting fresh cards regardless, so the
 *  bound is consistent with itself rather than merely convenient. slackListen logs whenever the
 *  floor rather than the cursor bounded the window, so the skip is never silent.
 *
 *  Known tradeoff, deliberately not solved here: a brand new user who connects Slack on a quiet day
 *  sees nothing at first. Dredging history to fill that gap is what caused the bug this file exists
 *  to prevent. The right fix is a Slack step in the first-run backfill (jobs/onboarding.ts, which
 *  reads calendar and Drive only today), a considered first-run experience rather than a side
 *  effect of a listening job's lower bound. */
export const MAX_LOOKBACK_HOURS = 24;

/** The oldest instant a run may consider, as a Slack ts (epoch SECONDS, which is what Slack's
 *  `ts` field is; the rest of this codebase works in milliseconds, so the unit is the easy mistake
 *  here). Always the LATER of the cursor and the floor. */
export function searchFloorTs(cursorTs: string | undefined, now: Date): number {
  const floor = (now.getTime() - MAX_LOOKBACK_HOURS * 3600_000) / 1000;
  const fromCursor = cursorTs ? Number(cursorTs) : 0;
  // A non-numeric cursor resolves to NaN, and every comparison against NaN is false, so Math.max
  // would return it and the floor would be lost. slackListen validates the cursor's shape before
  // calling this, but a guard that only works because a caller remembered is not a guard.
  if (!Number.isFinite(fromCursor)) return floor;
  return Math.max(floor, fromCursor);
}

/** Slack's `after:` search modifier is date-granularity, not ts-granularity, so it can only ever be
 *  a coarse pre-filter; the exact cutoff is the `Number(ts) <= floorTs` check in slackListen.
 *  Backing the date off a full day keeps the coarse filter from EVER excluding something the
 *  precise check would have kept: over-including costs a few extra search results that are filtered
 *  out downstream anyway, under-including would silently drop a real commitment. */
export function afterDateParam(ts: number): string {
  return new Date(ts * 1000 - 24 * 3600_000).toISOString().slice(0, 10);
}
