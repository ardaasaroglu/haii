/** Pure predicates about calendar entries. Deliberately dependency-free (no db, no env) so it can
 *  be unit-tested without booting the database, which the PGlite single-writer lock makes awkward
 *  from a file that imports db/index.ts. */

/** Is this calendar entry a meeting with other people, or a personal block?
 *
 *  A brief exists to catch you up on people and threads. An entry with no other attendees has
 *  neither, so "Lunch", "Focus time", "Gym", "Dentist" and personal all-day holds were each paying
 *  for a full model-written brief nobody would read. Also skips anything the user declined: they
 *  are not going, so there is nothing to prepare for.
 *
 *  Deliberately permissive on missing data: an entry whose attendee list failed to sync should
 *  still get briefed rather than silently dropped, so only an explicitly empty/solo attendee list
 *  or an explicit "declined" on the user's own row skips. Being wrong in the direction of an
 *  unnecessary brief is far cheaper than silently missing a real meeting. */
export function isBriefWorthy(m: { attendees: unknown }): boolean {
  const att = Array.isArray(m.attendees) ? (m.attendees as any[]) : [];
  // Google omits the attendees array on solo events and returns >= 2 entries (organizer + invitee)
  // on real ones, so a single entry means the user alone on their own event.
  if (att.length < 2) return false;
  const self = att.find((a) => a?.self === true);
  if (self && String(self.responseStatus ?? "") === "declined") return false;
  return true;
}

/** How far ahead the calendar sync keeps and persists occurrences. It exists because the meetings
 *  table once grew without limit.
 *
 *  jobs/scheduler.ts polls gcal every 5 minutes; connectors/gcal.ts uses this both as its bounded
 *  full-sync `timeMax` and as a hard cap on what an incremental syncToken poll is allowed to
 *  persist. Google rejects timeMin/timeMax combined with a syncToken ("Sync token cannot be used
 *  with timeMin or timeMax"), so nothing on the wire otherwise bounds how far into the future a
 *  changed recurring series expands once singleEvents=true is turning it into one row per
 *  occurrence; that unbounded expansion is what let the table grow without bound.
 *
 *  Nothing downstream reads a meeting further out than today: the feed's day strip renders only
 *  the user's current local day (api/routes.ts, dayBoundsInTz), the briefing scan looks 10-12
 *  minutes ahead (jobs/briefing.ts, hasBriefingWindow), and the brief batch pre-generates only
 *  today's meetings (jobs/briefBatch.ts). findOpenSlot's 14-day scheduling lookahead
 *  (lib/schedule.ts) queries Google's live FreeBusy API directly rather than this table, so it
 *  does not depend on this horizon either. Two weeks is headroom above all of that, not a tight
 *  fit chosen to match any one of them.
 *
 *  Matches the bound the sync already used for its one-time initial full sync, rather than
 *  inventing a new number: the bug was that the bound stopped being applied after the first poll,
 *  not that 14 days was ever the wrong horizon. */
export const SYNC_HORIZON_DAYS = 14;

/** Is `startsAt` inside the sync horizon measured from `now`? Only a forward cap is needed: a
 *  cancelled occurrence is handled unconditionally before this check runs (see gcal.ts's
 *  upsertMeeting), so a row that has already drifted out of horizon still gets cleaned up if
 *  Google reports it cancelled, and past events do not accumulate the way future recurring
 *  instances do, so no lower bound belongs here. */
export function withinSyncHorizon(startsAt: Date, now: Date = new Date()): boolean {
  return startsAt.getTime() - now.getTime() <= SYNC_HORIZON_DAYS * 24 * 3600_000;
}

/** A Postgres regex that matches `name` as a WHOLE WORD, case-insensitively.
 *
 *  Brief retrieval used to match attendee names with `ILIKE '%name%'`, so a short first name
 *  matched inside ordinary words: Ben hit "bench" and "benefit", Ana hit "analysis", Sam hit
 *  "same". Those items were then handed to the model as context for a meeting they had nothing to
 *  do with. A brief for a meeting with Samantha Reyes discussed Slack DMs with Sam Okafor.
 *
 *  `\m` and `\M` are Postgres word boundaries, used with its `~*` operator. Lives here rather than
 *  inline in jobs/briefing.ts so the ESCAPING is testable without a database: a person called "J."
 *  or "O'Neil (Sam)" would otherwise inject regex syntax into a query, which at best matches
 *  nonsense and at worst errors the whole brief.
 *
 *  The boundary SEMANTICS are Postgres's own and are not asserted here; what is asserted is that we
 *  hand it a pattern that means what we think. */
export function wholeWordPattern(name: string): string {
  return `\\m${String(name ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\M`;
}
