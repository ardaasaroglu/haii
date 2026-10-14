/** How a brief batch identifies its requests.
 *
 *  The Message Batches API caps `custom_id` at 64 characters. Brief batches used the meeting id,
 *  which is built as `mtg_<userId>_<googleEventId>` (connectors/gcal.ts), and that overflows:
 *
 *    mtg_owner_<43 char recurring instance>           53   fits
 *    mtg_u_0123456789_<43 char recurring instance>    60   fits, 4 to spare
 *    mtg_u_0123456789_<imported invite id>            64+  REJECTED
 *
 *  `owner` is the local owner id; every signed-in account gets `u_` plus 10 hex, so the
 *  prefix is 17 and only 47 characters remain for Google's id. Native events fit, imported invites
 *  from Outlook/Teams/Zoom interop routinely do not. And the API validates the whole create call,
 *  so ONE oversized id rejects the entire batch: that user loses every pre-generated brief that
 *  day and gets a raw 400 on their home screen.
 *
 *  So the id sent to the API is now the request's position, and the meeting ids ride on the
 *  llm_batches row instead. Position is bounded by the number of meetings in a day, so this cannot
 *  regress no matter how long an event id gets or how long user ids become.
 *
 *  Deliberately NOT hashing: applyBriefBatch would have to guess which meetings to hash against to
 *  invert it, and guessing wrong drops briefs silently.
 */

/** The id sent to the API for the request at `index`. Prefixed so a bare integer in a log is
 *  recognisable as ours, and so the legacy branch below can tell the two schemes apart. */
export function briefCustomId(index: number): string {
  return `b${index}`;
}

/** Map a returned `custom_id` back to a meeting id.
 *
 *  Handles both schemes on purpose. A batch submitted before this shipped is still in flight for up
 *  to 24h and carries a raw meeting id; refusing it would throw away exactly the briefs the change
 *  is meant to protect. Anything unrecognised falls through to the legacy reading rather than
 *  being dropped, because a wrong-but-checkable meeting id fails the existence check downstream,
 *  while a dropped result is silent. */
export function resolveBriefMeetingId(customId: unknown, orderedMeetingIds: unknown): string | null {
  const raw = typeof customId === "string" ? customId : "";
  const ordered = Array.isArray(orderedMeetingIds) ? orderedMeetingIds : null;
  if (!ordered || !ordered.length) return raw || null;
  const m = /^b(\d+)$/.exec(raw);
  if (!m) return raw || null;
  const hit = ordered[Number(m[1])];
  return typeof hit === "string" && hit ? hit : null;
}
