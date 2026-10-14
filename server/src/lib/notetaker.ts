/** The shared half of every notetaker connector.
 *
 *  Fireflies, Fathom and Otter differ ONLY in how you ask them for a transcript. Everything after
 *  that is identical and is the part that can hurt: matching a transcript to a meeting, applying the
 *  dedupe rule so one conversation cannot mint two sets of cards, and writing the row. Three copies
 *  of that would be three chances to get the dangerous part wrong, and the second vendor is where
 *  the copies start to drift.
 *
 *  So a vendor adapter provides `list` and `fetchOne` and nothing else. This module owns the rest,
 *  which is why adding the third notetaker cost almost nothing.
 *
 *  These are CARD SOURCES. Every other connector becomes rows in `items`, which are context for
 *  briefs. Transcripts mint cards, so this is the most sensitive ingest path in the product. See
 *  lib/transcriptDedupe.ts for the rule and why it is written down separately.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import { mergeMeta, type ConnectorId } from "./connections";
import { linkMeeting } from "../connectors/drive";
import { dedupeTranscript, type ExistingTranscript } from "./transcriptDedupe";
import { log } from "../log";

/** Bounded work per tick. A first connect on a busy account could otherwise pull a hundred
 *  transcripts in one go, and each one is a potential extraction. Nothing is lost: the next poll
 *  takes the next batch. Same stance as the onboarding backfill. */
export const FETCH_PER_POLL = 6;

export interface NotetakerMeeting {
  /** The vendor's own id. Combined with the vendor name to form our row id. */
  id: string;
  title: string;
  /** When the meeting happened. Used to match it to a calendar event. */
  at: Date;
}

export interface NotetakerAdapter {
  /** Which connector row holds this vendor's credentials and status. */
  connector: ConnectorId;
  /** Short id used in transcript ids and the `source` column. Must match SOURCE_RANK. */
  vendor: string;
  /** Recent meetings, newest first. Cheap call: no bodies. */
  list(userId: string): Promise<NotetakerMeeting[]>;
  /** The transcript body as markdown, speaker-attributed. Empty string means nothing usable. */
  fetchOne(userId: string, id: string): Promise<string>;
}

/** Speaker-attributed markdown from a flat sentence list.
 *
 *  Attribution is not decoration: every card carries a verbatim quote WITH a speaker, and the quote
 *  is checked against this text. "Dana: I'll send the pricing" is what lets a card say who promised.
 *  A flat wall of text still extracts, but every quote loses its owner. Shared because all three
 *  vendors return sentences in the same shape. */
export function sentencesToMarkdown(
  sentences: Array<{ speaker?: string | null; text?: string | null }>,
): string {
  const lines: string[] = [];
  let last = "";
  for (const s of sentences ?? []) {
    const text = String(s?.text ?? "").trim();
    if (!text) continue;
    const who = String(s?.speaker ?? "").trim() || "Speaker";
    // Consecutive lines from one speaker become one paragraph, which is how a person reads a
    // transcript and keeps the text close to how the model will emit a quote from it.
    if (who === last) lines[lines.length - 1] += ` ${text}`;
    else { lines.push(`**${who}:** ${text}`); last = who; }
  }
  return lines.join("\n\n");
}

/** Below this a "transcript" is a fragment, not a conversation, and reading it spends model time
 *  for nothing. Matches the floor extraction already applies. */
const MIN_CHARS = 200;

/** Pull new transcripts for one vendor, dedupe them against whatever already covers the meeting,
 *  and write them. Returns a human-readable summary for job_runs. */
export async function pollNotetaker(userId: string, adapter: NotetakerAdapter): Promise<string> {
  const meetings = await adapter.list(userId);
  if (!meetings.length) return "0 new (nothing recent)";

  // Which do we already hold? One query, not one per meeting.
  const rowId = (id: string) => `${adapter.vendor}_${userId}_${id}`;
  const held = await db
    .select({ id: schema.transcripts.id })
    .from(schema.transcripts)
    .where(and(eq(schema.transcripts.userId, userId), inArray(schema.transcripts.id, meetings.map((m) => rowId(m.id)))));
  const have = new Set(held.map((r) => r.id));
  const fresh = meetings.filter((m) => !have.has(rowId(m.id)));
  const batch = fresh.slice(0, FETCH_PER_POLL);
  if (!batch.length) return `0 new (${meetings.length} already held)`;

  let added = 0;
  let deduped = 0;
  let thin = 0;
  for (const m of batch) {
    try {
      const md = await adapter.fetchOne(userId, m.id);
      if (md.trim().length < MIN_CHARS) { thin++; continue; }
      const id = rowId(m.id);

      // The SAME matcher Drive uses, so a recording and a Gemini doc for one meeting land on the
      // same meeting row. Dedupe is meaningless without it: two transcripts that never meet on a
      // meeting id would both look unique.
      const meetingId = await linkMeeting(userId, m.title, m.at);

      let supersededBy: string | null = null;
      if (meetingId) {
        const existing = await db
          .select({
            id: schema.transcripts.id,
            source: schema.transcripts.source,
            extractedAt: schema.transcripts.extractedAt,
            supersededBy: schema.transcripts.supersededBy,
          })
          .from(schema.transcripts)
          .where(and(eq(schema.transcripts.userId, userId), eq(schema.transcripts.meetingId, meetingId)));
        const decision = dedupeTranscript({ source: adapter.vendor }, existing as ExistingTranscript[]);
        if (decision.action === "supersede") {
          await db
            .update(schema.transcripts)
            .set({ supersededBy: id, extractedAt: new Date() })
            .where(inArray(schema.transcripts.id, decision.supersede));
          deduped += decision.supersede.length;
          log.info({ userId, meetingId, stoodDown: decision.supersede, reason: decision.reason }, "transcript superseded");
        } else if (decision.action === "keep_superseded") {
          supersededBy = decision.supersededBy;
          deduped++;
          log.info({ userId, meetingId, supersededBy, reason: decision.reason }, "transcript kept for reference only");
        }
      }

      await db
        .insert(schema.transcripts)
        .values({
          id, userId,
          title: m.title.slice(0, 300),
          contentMd: md,
          source: adapter.vendor,
          meetingId,
          ingestedAt: m.at,
          supersededBy,
          // Stamped only when standing down: extracted_at is what the pending sweep reads, so
          // setting it is how "never a card source" is actually enforced.
          extractedAt: supersededBy ? new Date() : null,
        })
        .onConflictDoNothing();
      added++;
    } catch (e: any) {
      log.warn({ userId, vendor: adapter.vendor, id: m.id, err: String(e?.message ?? e).slice(0, 160) }, "notetaker transcript failed");
    }
  }
  await mergeMeta(userId, adapter.connector, { last_item_at: new Date().toISOString() });
  const queued = fresh.length - batch.length;
  return [
    `${added} transcripts`,
    deduped ? `${deduped} deduped` : "",
    thin ? `${thin} too short` : "",
    queued > 0 ? `${queued} queued for next poll` : "",
  ].filter(Boolean).join(", ");
}
