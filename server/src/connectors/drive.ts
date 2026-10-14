import { and, gte, lte, isNull, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { log } from "../log";
import { getCursor, setCursor } from "../lib/connections";
import { gFetch, googleReady } from "./google";
import { runExtract } from "../jobs/extract";

const BASE = "https://www.googleapis.com/drive/v3";

/** Title + time-window meeting linker (+-6h, token overlap tiebreak), scoped to the given user. */
export async function linkMeeting(userId: string, title: string, around: Date): Promise<string | null> {
  const lo = new Date(around.getTime() - 6 * 3600_000);
  const hi = new Date(around.getTime() + 6 * 3600_000);
  const candidates = await db
    .select()
    .from(schema.meetings)
    .where(
      and(
        eq(schema.meetings.userId, userId),
        gte(schema.meetings.startsAt, lo),
        lte(schema.meetings.startsAt, hi),
      ),
    );
  if (!candidates.length) return null;
  const tokens = title
    .toLowerCase()
    .replace(/notes by gemini|transcript|[-–·|]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 3);
  let best: { id: string; score: number } | null = null;
  for (const m of candidates) {
    const hay = m.title.toLowerCase();
    const overlap = tokens.filter((t) => hay.includes(t)).length;
    const proximity = 1 - Math.abs(m.startsAt.getTime() - around.getTime()) / (6 * 3600_000);
    const score = overlap * 2 + proximity;
    if (!best || score > best.score) best = { id: m.id, score };
  }
  return best?.id ?? null;
}

async function exportDoc(userId: string, fileId: string): Promise<string | null> {
  for (const mime of ["text/markdown", "text/plain"]) {
    const res = await gFetch(userId, `${BASE}/files/${fileId}/export?mimeType=${encodeURIComponent(mime)}`);
    if (res.ok) return await res.text();
  }
  return null;
}

/** Mime types a brief will read the CONTENT of. `application/vnd.google-apps.document` is a native
 *  Google Doc, exported the same way exportDoc already does for transcripts; `text/plain` is a
 *  plain text file's own mimeType and has no `/export` form, so it is fetched directly instead (see
 *  below). PDFs, images, spreadsheets and slides are deliberately skipped rather than half-read:
 *  a filename alone is still shown on the card, just without a content fetch. */
const READABLE_ATTACHMENT_MIME_TYPES = new Set(["application/vnd.google-apps.document", "text/plain"]);

/** How much of one attachment's content a brief will ever see. Matches the description cap
 *  (lib/invite.ts's MAX_DESCRIPTION_CHARS): a genuinely useful agenda is a page or two, not a
 *  novel, and one huge doc must never crowd out the rest of the briefing prompt. */
const ATTACHMENT_CONTENT_MAX_CHARS = 3000;

/** Fetch an invite attachment's CONTENT for a brief, not just its title. A filename adds almost
 *  nothing; the agenda inside the file is the value (see jobs/briefing.ts).
 *
 *  Called at BRIEF time, one attachment at a time, for a handful of meetings a day, never from the
 *  sync path (connectors/gcal.ts only stores the attachment's metadata). Fetching every
 *  attachment of every event for every user on every poll would be a large, mostly wasted spend
 *  against a feature that only ever reads the attachments of the few meetings actually being
 *  briefed.
 *
 *  Every failure (no permission on the file, the file was deleted, a transient Drive error) is
 *  caught HERE and reported as null: a brief must never fail because one attachment could not be
 *  read. This is a stronger guarantee than exportDoc's own callers get away with (pollDrive can let
 *  a poll fail loudly; a brief cannot), so the try/catch lives inside this function rather than
 *  trusting every call site to add its own. */
export async function fetchAttachmentContent(
  userId: string,
  attachment: { fileId: string; mimeType: string },
): Promise<string | null> {
  if (!READABLE_ATTACHMENT_MIME_TYPES.has(attachment.mimeType)) return null;
  try {
    let content: string | null;
    if (attachment.mimeType === "application/vnd.google-apps.document") {
      content = await exportDoc(userId, attachment.fileId);
    } else {
      // A plain text file is not a Google Workspace format, so it has no `/export` endpoint;
      // `alt=media` is Drive's direct-download form for a file's own bytes.
      const res = await gFetch(userId, `${BASE}/files/${attachment.fileId}?alt=media`);
      content = res.ok ? await res.text() : null;
    }
    if (!content) return null;
    return content.slice(0, ATTACHMENT_CONTENT_MAX_CHARS);
  } catch (e) {
    log.warn(
      { userId, fileId: attachment.fileId, mimeType: attachment.mimeType, err: String(e) },
      "attachment content fetch failed; brief continues with the title alone",
    );
    return null;
  }
}

/** What a meeting-notes doc looks like by name. Matched in JS, never in the Drive query: see the
 *  note in pollDrive about `contains` being prefix-only on `name`. */
export const TRANSCRIPT_NAME = /notes by gemini|gemini notes|transcript|meeting notes/i;

/** Poll Drive for Gemini notes / transcript docs, ingest, link to meetings, trigger extraction.
 *  Every call below is scoped to the polled user.
 *
 *  TRUST BOUNDARY. The name is the only test. Any Google Doc this account can open, changed since
 *  the cursor, whose name matches TRANSCRIPT_NAME is treated as a meeting transcript. Nothing checks
 *  who owns the doc or whether the user was in the meeting, and the query includes shared drives.
 *  So a doc a stranger shares with the user, named "meeting notes", is read like a real one: it
 *  spends an extraction on the user's API key, can produce proposed cards, and can add to the
 *  user's long-term memory. A proposed card still does nothing until the user approves it. */
export async function pollDrive(userId: string): Promise<string> {
  if (!(await googleReady(userId))) return "skipped: google not connected";
  const cursor = await getCursor<{ driveSince?: string }>(userId, "google");
  const since = cursor.driveSince ?? new Date(Date.now() - 7 * 24 * 3600_000).toISOString();

  // The name filter is deliberately NOT in the Drive query any more, and this is the whole reason
  // transcript ingestion never fired. Drive's `contains` operator does PREFIX matching on `name`,
  // not substring: their own docs give `HelloWorld`, where `name contains 'Hello'` matches and
  // `name contains 'World'` does not. Gemini names its docs "<meeting title> ... Notes by Gemini",
  // so the phrase sits at the END and `name contains 'Notes by Gemini'` could never match a single
  // file. Silently: an empty result set is indistinguishable from "no meetings had notes".
  //
  // So Drive narrows on the parts it is reliable at (a Doc, not trashed, touched since the cursor)
  // and the name match happens here, where it is a real substring test. The page is bounded by the
  // cursor window, so this stays a handful of files per poll.
  const q = `mimeType='application/vnd.google-apps.document' and trashed=false and modifiedTime > '${since}'`;
  const params = new URLSearchParams({
    q,
    fields: "files(id,name,modifiedTime,webViewLink)",
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
    pageSize: "100",
    orderBy: "modifiedTime",
  });
  const res = await gFetch(userId, `${BASE}/files?${params}`);
  if (!res.ok) throw new Error(`drive list ${res.status}`);
  const data: any = await res.json();

  let ingested = 0;
  let maxModified = since;
  let looked = 0;
  for (const f of data.files ?? []) {
    looked++;
    // Advance the cursor for EVERY file we saw, matching or not. Skipping non-matches here would
    // make the poll re-read the same non-transcript docs forever.
    if (f.modifiedTime > maxModified) maxModified = f.modifiedTime;
    // Anywhere in the name, any case. Covers "Notes by Gemini", "... - Transcript", and the
    // variants that put the product name first. This is the whole trust test: see TRUST BOUNDARY
    // above pollDrive.
    if (!TRANSCRIPT_NAME.test(f.name || "")) continue;
    const existing = await db
      .select({ id: schema.transcripts.id })
      .from(schema.transcripts)
      .where(and(eq(schema.transcripts.driveFileId, f.id), eq(schema.transcripts.userId, userId)));
    if (existing.length) continue;

    const content = await exportDoc(userId, f.id);
    if (!content || content.trim().length < 100) continue;

    const meetingId = await linkMeeting(userId, f.name, new Date(f.modifiedTime));
    const id = `tr_${userId}_${f.id}`;
    await db
      .insert(schema.transcripts)
      .values({
        id,
        userId,
        driveFileId: f.id,
        meetingId,
        title: f.name,
        contentMd: content.slice(0, 200_000),
        source: "drive",
      })
      .onConflictDoNothing();
    ingested++;
    log.info({ userId, file: f.name, meetingId }, "transcript ingested from drive");
    // fire and forget; extraction logs its own job run.
    runExtract(userId, id).catch((e) => log.error({ err: String(e) }, "extract failed"));
  }
  await setCursor(userId, "google", { ...(await getCursor(userId, "google")), driveSince: maxModified });
  // Say what was actually looked at. "0 transcripts ingested" was true for both "no meetings had
  // notes" and "the query was broken and matched nothing", and those need different reactions.
  return ingested
    ? `${ingested} transcript(s) ingested from ${looked} doc(s)`
    : `no new transcripts (scanned ${looked} doc(s) changed since ${since.slice(0, 16)})`;
}

/** Unlinked transcript detector: a user's transcripts with no meeting yet. Scoped to userId so a
 *  future nudge feature can never surface one tenant's transcript titles to another. */
export async function unlinkedTranscripts(userId: string) {
  return db
    .select({ id: schema.transcripts.id, title: schema.transcripts.title })
    .from(schema.transcripts)
    .where(and(eq(schema.transcripts.userId, userId), isNull(schema.transcripts.meetingId)));
}

