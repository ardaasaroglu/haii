import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { log } from "../log";
import { getCursor, setCursor } from "../lib/connections";
import { gFetch, googleReady } from "./google";
import { isValidTz, userTz, zonedTimeToUtc } from "../lib/tz";
import { SYNC_HORIZON_DAYS, withinSyncHorizon } from "../lib/meeting";
import { stripHtmlToText, mapAttachments } from "../lib/invite";

const BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

interface SelfIdentity {
  email: string;
  name: string;
  /** The user's zone, resolved once per poll. All-day events carry a bare date and have to be
   *  placed somewhere on the clock; without this they were placed on the SERVER's clock. */
  tz: string;
}

/** Where on the clock an all-day event sits. Arbitrary, but it has to be some hour, and morning
 *  is where an all-day thing belongs on a day strip. */
const ALL_DAY_HOUR = 9;

/** Same derivation as jobs/briefing.ts's firstNames(): display name, else email local-part,
 *  split on whitespace/dot. */
function firstName(a: { email: string; name: string }): string {
  return (a.name || a.email.split("@")[0] || "").split(/[\s.]/)[0] ?? "";
}

/** Attendee people-learning: every attendee on a synced meeting becomes a 'person' entity
 *  for this user (skipping the user themself), so briefings can recognize them by first name.
 *  ON CONFLICT DO NOTHING: the first poll to see someone wins the name/aliases; it never clobbers
 *  an entity the user has since hand-edited. */
async function learnAttendees(
  userId: string,
  attendees: Array<{ email: string; name: string }>,
  self: SelfIdentity,
): Promise<void> {
  for (const a of attendees) {
    const email = (a.email || "").trim();
    const name = (a.name || "").trim();
    if (!email && !name) continue;
    if (self.email && email.toLowerCase() === self.email.toLowerCase()) continue;
    if (self.name && name === self.name) continue;
    const first = firstName({ email, name });
    if (first.length <= 2) continue;
    const capitalized = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
    const aliases = [name, email].filter(Boolean).slice(0, 3);
    await db
      .insert(schema.entities)
      .values({ userId, name: capitalized, type: "person", aliases })
      .onConflictDoNothing({ target: [schema.entities.userId, schema.entities.name] });
  }
}

async function upsertMeeting(userId: string, ev: any, self: SelfIdentity): Promise<{ skippedHorizon: boolean }> {
  if (ev.status === "cancelled") {
    await db
      .delete(schema.meetings)
      .where(and(eq(schema.meetings.userId, userId), eq(schema.meetings.externalId, ev.id)));
    return { skippedHorizon: false };
  }
  // A timed event carries its own offset in `dateTime`, so Date parses it unambiguously. An
  // ALL-DAY event carries only `start.date` ("2026-07-28"), and the old code appended a bare
  // "T09:00:00" with no zone, which `new Date()` reads in the SERVER's zone. The server is UTC by
  // design in cloud, so every all-day event landed at 09:00 UTC: 02:00 for a user in California,
  // 05:00 on the US east coast. It sorted into the wrong end of the day strip and, for anyone far
  // enough west, into the wrong DAY entirely, since 09:00 UTC is still yesterday evening in PT.
  // Resolve it in the calendar's own zone when Google states one, else the user's.
  const startDate: string | null = ev.start?.date ?? null;
  let starts: string | Date | null = ev.start?.dateTime ?? null;
  if (!starts && startDate) {
    const zone = isValidTz(ev.start?.timeZone) ? ev.start.timeZone : self.tz;
    const [Y, Mo, D] = startDate.split("-").map(Number);
    starts = zonedTimeToUtc(zone, Y, Mo, D, ALL_DAY_HOUR, 0);
  }
  if (!starts) return { skippedHorizon: false };
  const startsAt = new Date(starts);
  // The growth guard. singleEvents=true expands a recurring series into one row
  // per occurrence, and once this poll is running off a syncToken (which is true for almost every
  // poll; see pollCalendar below) Google cannot be given a timeMax to bound that expansion. A
  // changed series then hands back every not-yet-seen occurrence, including years out, and each
  // gets its own distinct Google-assigned instance id, so the idempotent upsert below happily
  // persists all of them forever. That is what made the meetings table grow without limit. Nothing
  // downstream reads a meeting this far out anyway (see SYNC_HORIZON_DAYS), so it is simply not
  // persisted. The cancelled-event branch above runs unconditionally, before this check, so a row
  // that has already drifted out of horizon still gets deleted if Google reports it cancelled.
  //
  // Narrowed to RECURRING instances only (`recurringEventId` is set by Google on every instance it
  // expands from a series, and only on those). The bloat is entirely series expansion, so capping
  // one-off events too would buy nothing and would cost something real: the feed's "up next" query
  // is unbounded and takes the earliest future meeting, so a user whose next meeting is three weeks
  // out would have seen an empty hero instead of it. A distant one-off is a meeting someone
  // deliberately put in the calendar; a distant recurring instance is a row Google generated.
  if (ev.recurringEventId && !withinSyncHorizon(startsAt)) return { skippedHorizon: true };
  const ends = ev.end?.dateTime ?? null;
  const attendees = (ev.attendees ?? []).map((a: any) => ({
    email: a.email ?? "",
    name: a.displayName ?? (a.email ? String(a.email).split("@")[0] : ""),
    // Kept so briefingScan can skip meetings the user declined (isBriefWorthy in lib/meeting.ts).
    // Only meaningful on the user's own row; harmless extra data on the others.
    ...(a.self ? { self: true } : {}),
    ...(a.responseStatus ? { responseStatus: a.responseStatus } : {}),
  }));
  // Older rows (bridge-ingested, or synced by an older version) may carry the old global
  // mtg_<extId> id. The upsert conflicts on id, but the (user_id, external_id) unique index would reject a
  // second row for the same event, so reuse the existing row's id whatever its format.
  let mid = `mtg_${userId}_${ev.id}`;
  const existing = await db
    .select({ id: schema.meetings.id })
    .from(schema.meetings)
    .where(and(eq(schema.meetings.userId, userId), eq(schema.meetings.externalId, ev.id)));
  if (existing[0]) mid = existing[0].id;
  // Invite body + attachments: the organiser's agenda and pre-read links live in
  // `description`, and the attached doc is usually the single most brief-worthy thing about a
  // meeting (see jobs/briefing.ts). Both pure helpers degrade to "" / [] on absent or malformed
  // input, matching the column defaults, and never throw: this runs on every event of every sync.
  const values = {
    id: mid,
    userId,
    source: "gcal",
    externalId: ev.id,
    title: ev.summary ?? "(untitled)",
    startsAt,
    endsAt: ends ? new Date(ends) : null,
    attendees,
    location: ev.hangoutLink ?? ev.location ?? "",
    description: stripHtmlToText(ev.description),
    attachments: mapAttachments(ev.attachments),
    raw: { htmlLink: ev.htmlLink },
  };
  await db
    .insert(schema.meetings)
    .values(values)
    .onConflictDoUpdate({
      target: schema.meetings.id,
      set: {
        title: values.title,
        startsAt: values.startsAt,
        endsAt: values.endsAt,
        attendees: values.attendees,
        location: values.location,
        // Both can legitimately change after the row first exists: an organiser edits the agenda,
        // or adds a doc a day later. Left out of `set`, a re-synced event would keep whatever it
        // captured on its FIRST sync forever.
        description: values.description,
        attachments: values.attachments,
      },
    });
  await learnAttendees(userId, attendees, self);
  return { skippedHorizon: false };
}

/** How often the incremental (syncToken) poll steps aside for a fresh windowed full sync, even
 *  when the token is still valid. Google's incremental sync cannot be given a timeMax (see
 *  SYNC_HORIZON_DAYS in lib/meeting.ts), so this is the only mechanism that re-establishes the
 *  bounded window's completeness: a meeting that never triggers a delta (no edit, no RSVP change)
 *  might otherwise be reported by Google only once, at whatever moment it first appeared on a full
 *  sync; if it was beyond the horizon at that moment it would be skipped, and nothing would ever
 *  ask Google about it again until the window catches up with it. Daily re-anchoring is frequent
 *  enough that nothing goes unswept for more than a day, and cheap enough (one extra bounded query
 *  per user per day, replacing what would otherwise be an incremental poll) not to matter next to
 *  the 5-minute cadence. */
const FULL_RESYNC_INTERVAL_MS = 24 * 3600_000;

/** Poll Calendar with an incremental syncToken; windowed full sync on first run, on a 410, or once
 *  a day (FULL_RESYNC_INTERVAL_MS) to re-anchor the bounded window.
 *  Every call below is scoped to the polled user. */
export async function pollCalendar(userId: string): Promise<string> {
  if (!(await googleReady(userId))) return "skipped: google not connected";
  const cursor = await getCursor<{ syncToken?: string; lastFullSyncAt?: string }>(userId, "google");
  const lastFullSyncMs = cursor.lastFullSyncAt ? Date.parse(cursor.lastFullSyncAt) : NaN;
  // An unparseable timestamp counts as "due", not "never due": failing toward an extra harmless
  // resync is safe, failing the other way is a horizon that silently stops re-anchoring forever.
  const dueForFullResync = !Number.isFinite(lastFullSyncMs) || Date.now() - lastFullSyncMs > FULL_RESYNC_INTERVAL_MS;
  const willFullResync = !cursor.syncToken || dueForFullResync;

  // Fetched once per poll (not per event): the self identity that keeps a user out of their own
  // People-learning list.
  const urows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  const self: SelfIdentity = {
    email: urows[0]?.email ?? "",
    name: urows[0]?.name ?? "",
    tz: userTz(urows[0]?.tz),
  };

  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  let count = 0;
  let skippedHorizon = 0;

  do {
    const params = new URLSearchParams({ singleEvents: "true", maxResults: "50" });
    if (pageToken) params.set("pageToken", pageToken);
    if (cursor.syncToken && !pageToken && !willFullResync) params.set("syncToken", cursor.syncToken);
    else if (willFullResync) {
      params.set("timeMin", new Date(Date.now() - 24 * 3600_000).toISOString());
      params.set("timeMax", new Date(Date.now() + SYNC_HORIZON_DAYS * 24 * 3600_000).toISOString());
    }
    const res = await gFetch(userId, `${BASE}?${params}`);
    if (res.status === 410) {
      await setCursor(userId, "google", { ...cursor, syncToken: undefined });
      log.warn({ userId }, "calendar sync token expired; full resync next poll");
      return "sync token expired; full resync next poll";
    }
    if (!res.ok) throw new Error(`calendar list ${res.status}`);
    const data: any = await res.json();
    for (const ev of data.items ?? []) {
      const r = await upsertMeeting(userId, ev, self);
      if (r.skippedHorizon) skippedHorizon++;
      count++;
    }
    pageToken = data.nextPageToken;
    if (data.nextSyncToken) nextSyncToken = data.nextSyncToken;
  } while (pageToken);

  if (nextSyncToken) {
    const fresh = await getCursor<{ syncToken?: string; lastFullSyncAt?: string }>(userId, "google");
    await setCursor(userId, "google", {
      ...fresh,
      syncToken: nextSyncToken,
      // Stamped only when this call actually re-anchored the window, so the daily clock measures
      // from the last CONFIRMED full sync, not from every ordinary incremental poll.
      ...(willFullResync ? { lastFullSyncAt: new Date().toISOString() } : {}),
    });
  }
  return skippedHorizon
    ? `${count} events synced (${skippedHorizon} beyond ${SYNC_HORIZON_DAYS}d horizon skipped)`
    : `${count} events synced`;
}

