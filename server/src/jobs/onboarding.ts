/** First run: the backfill that turns an empty deck into "here is what you already promised".
 *
 *  The fetching is not new. connectors/drive.ts already looks back seven days on first connect
 *  (a null cursor falls back to now-7d), and gcal does a windowed full sync, so a brand new user's
 *  meetings and Gemini notes already arrive on their own. What was missing is the three things a
 *  first run actually needs: it has to happen NOW rather than whenever the ten-minute cron next
 *  fires, it has to be BOUNDED, and it has to be VISIBLE so a progress bar has something true to
 *  draw.
 *
 *  Bounded by MEETINGS, not by days. Cost scales with meetings read, not with calendar span: a
 *  heavy week can put twenty meetings inside three days and spend real model time before the user
 *  has tapped anything. A day window cannot promise that will not happen; a count can.
 */
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { log } from "../log";
import { pollCalendar } from "../connectors/gcal";
import { pollDrive } from "../connectors/drive";
import { runExtract } from "./extract";

/** How many meetings the first run is allowed to read. Enough to fill a first deck without a long
 *  wait or a surprising model bill before the user has tapped anything. */
export const BACKFILL_MEETINGS = 6;
/** How far back to look. Matches the seven days connectors/drive.ts already uses for a first
 *  connect, so the window the user is shown is the window we actually read. */
export const BACKFILL_DAYS = 7;

export function backfillSince(now: Date = new Date()): Date {
  return new Date(now.getTime() - BACKFILL_DAYS * 24 * 3600_000);
}

export interface BackfillMeeting {
  id: string;
  title: string;
  startsAt: Date;
  /** A transcript exists, so this meeting can produce cards. */
  readable: boolean;
  /** We have finished reading it. */
  read: boolean;
}

export interface BackfillProgress {
  state: string;
  meetings: BackfillMeeting[];
  total: number;
  readable: number;
  read: number;
  /** Meetings with no notes at all. Named out loud rather than hidden: many meetings produce no
   *  transcript, and a user who is not told that concludes we are broken. */
  unreadable: number;
  done: boolean;
}

/** What the reading screen draws. Pure read, safe to poll. */
export async function backfillProgress(userId: string): Promise<BackfillProgress> {
  const since = backfillSince();
  const rows = await db
    .select({
      id: schema.meetings.id,
      title: schema.meetings.title,
      startsAt: schema.meetings.startsAt,
      transcriptId: schema.transcripts.id,
      extractedAt: schema.transcripts.extractedAt,
    })
    .from(schema.meetings)
    .leftJoin(schema.transcripts, eq(schema.transcripts.meetingId, schema.meetings.id))
    .where(
      and(
        eq(schema.meetings.userId, userId),
        gte(schema.meetings.startsAt, since),
        // Only meetings that have already happened. A backfill promising to read Thursday's
        // meeting on Tuesday is a promise it cannot keep.
        sql`${schema.meetings.startsAt} <= now()`,
      ),
    )
    .orderBy(desc(schema.meetings.startsAt))
    // 200, not 40. `total` is what the reading screen subtracts from to say "and N more from the
    // same week", so a cap here silently understated a busy week: with a cap of 40, a week of 60
    // meetings rendered as "and 28 more" when it was 48. The screen still only NAMES the first twelve (OB_ROWS); this
    // bound exists so the count it quotes is true, and 200 in a seven-day window is nobody.
    .limit(200);

  const urows = await db
    .select({ state: schema.users.onboardingState })
    .from(schema.users)
    .where(eq(schema.users.id, userId));

  const meetings: BackfillMeeting[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    startsAt: r.startsAt,
    readable: Boolean(r.transcriptId),
    read: Boolean(r.extractedAt),
  }));
  const readable = meetings.filter((m) => m.readable).length;
  const read = meetings.filter((m) => m.read).length;
  return {
    state: urows[0]?.state ?? "new",
    meetings,
    total: meetings.length,
    readable,
    read,
    unreadable: meetings.length - readable,
    // Done when every readable meeting has been read, or when the cap has been spent. Never
    // waits on the unreadable ones, which is the bug that would hang the screen forever.
    done: read >= Math.min(readable, BACKFILL_MEETINGS),
  };
}

/** Pull the last seven days in, then read at most BACKFILL_MEETINGS of them.
 *
 *  Sequential on purpose. Calendar first because a transcript with no meeting to attach to is
 *  harder to make sense of, then Drive for the notes, then extraction. Each step is already
 *  idempotent and cursor-driven, so running this when the cron has already been through is a
 *  cheap no-op rather than a double read. */
export async function runBackfill(userId: string): Promise<string> {
  const notes: string[] = [];
  for (const [name, fn] of [
    ["calendar", pollCalendar],
    ["drive", pollDrive],
  ] as const) {
    try {
      notes.push(`${name}: ${await fn(userId)}`);
    } catch (e) {
      // One dead connector must not stop the other, and must not stop extraction of whatever
      // already arrived. The user sees progress either way.
      log.warn({ userId, connector: name, err: String(e) }, "backfill connector failed");
      notes.push(`${name}: failed`);
    }
  }

  const since = backfillSince();
  const pending = await db
    .select({ id: schema.transcripts.id })
    .from(schema.transcripts)
    .where(
      and(
        eq(schema.transcripts.userId, userId),
        isNull(schema.transcripts.extractedAt),
        gte(schema.transcripts.ingestedAt, since),
      ),
    )
    .orderBy(desc(schema.transcripts.ingestedAt))
    .limit(BACKFILL_MEETINGS);

  let read = 0;
  for (const t of pending) {
    // runExtract applies the spend caps itself, so a run that hits a cap simply stops here
    // rather than overspending.
    const r = await runExtract(userId, t.id);
    if (!r.startsWith("skipped")) read++;
  }
  notes.push(`read ${read} of ${pending.length}`);
  log.info({ userId, read, found: pending.length }, "first-run backfill complete");
  return notes.join(" · ");
}
