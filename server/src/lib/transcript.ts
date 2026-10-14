/** Transcript hygiene before extraction: Gemini notes ship a lot of boilerplate
 *  (headers, attendance blocks, timestamps, disclaimers) that costs input tokens
 *  and adds nothing to commitment extraction. Cleaning cuts 25-30% of input.
 *  A cost lever. */

const DROP_LINE = [
  /^(#+\s*)?\**\s*(📝\s*)?notes by gemini\b/i,
  /^(#+\s*)?\**\s*meeting records?\b/i,
  /^(#+\s*)?\**\s*transcript\s*\**$/i,
  /^(invited|attendees|attachments)\b.{0,200}$/i,
  /^you can ask gemini/i,
  /^this editable transcript/i,
  /computer generated and might contain errors/i,
  /^transcription ended/i,
  /^people can also change the text/i,
  /^(please )?review gemini'?s notes/i,
  /^get tips and learn how gemini/i,
  /^how is the quality of these/i,
  /^take a short survey/i,
];

/** A line that is only a timestamp, e.g. "00:14:31" or "14:31". */
const BARE_TIMESTAMP = /^\d{1,2}:\d{2}(:\d{2})?\s*$/;
/** Leading inline timestamp before a speaker, e.g. "00:05:33 Maya Chen: ...". */
const LEADING_TIMESTAMP = /^\s*\d{1,2}:\d{2}(:\d{2})?\s+/;

export const MIN_TRANSCRIPT_CHARS = 500;
/** Raised from 40k to 120k after a real one-hour weekly came in at 90k characters and the
 *  extraction reported reading 40k of it.
 *
 *  This was never a capability limit; the model's context is far larger. It was a cost lever set
 *  before there was usage. But cost here is OUTPUT-dominated, so capping input was the wrong
 *  lever: the extra 80k characters are ~20k input tokens, a rounding error on a long meeting,
 *  and what it bought was dropping the middle of exactly
 *  the meetings most likely to contain commitments. A weekly's decisions cluster in the discussion,
 *  not only in the wrap-up.
 *
 *  120k covers a full hour comfortably and most of a two-hour session. The head+tail fallback below
 *  still applies beyond that, so nothing regresses for genuinely enormous transcripts. The real
 *  savings are elsewhere: skip solo calendar blocks, no thinking on briefing, skip empty briefs.
 *  None of those cost a commitment. */
export const MAX_TRANSCRIPT_CHARS = 120_000;

/** Cleaned text plus whether the tail was cut. Truncation used to be invisible: the model saw the
 *  first 40k while the "Open transcript" modal rendered the full stored text (up to 200k), so
 *  evidence quotes appeared to cover a document Haii had only read a third of, and commitments in
 *  the last hour of a long meeting were silently absent. Callers surface `truncated` to the user. */
/** Head kept for meeting context (who is here, what this is about); the rest of the budget goes to
 *  the tail. Truncating head-first, which is what this used to do, threw away exactly the
 *  part the product exists to read: commitments cluster in the wrap-up ("ok, I'll send the deck,
 *  you'll loop in Omar, let's reconvene Thursday"), not the agenda. */
const HEAD_KEEP_CHARS = 8_000;

export function cleanTranscriptDetailed(md: string): { text: string; truncated: boolean; fullLength: number } {
  const full = cleanRaw(md);
  if (full.length <= MAX_TRANSCRIPT_CHARS) {
    return { text: full, truncated: false, fullLength: full.length };
  }
  const tailKeep = MAX_TRANSCRIPT_CHARS - HEAD_KEEP_CHARS;
  const head = full.slice(0, HEAD_KEEP_CHARS);
  const tail = full.slice(full.length - tailKeep);
  const omitted = full.length - HEAD_KEEP_CHARS - tailKeep;
  // The marker is deliberately model-visible: without it the model reads a jump-cut as continuous
  // dialogue and can attribute a commitment to the wrong turn.
  const text = `${head}\n\n[... ${omitted.toLocaleString("en-US")} characters omitted from the middle of this transcript ...]\n\n${tail}`;
  return { text, truncated: true, fullLength: full.length };
}

export function cleanTranscript(md: string): string {
  return cleanTranscriptDetailed(md).text;
}

function cleanRaw(md: string): string {
  const lines = md.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    const s = raw.trim();
    if (!s) {
      out.push("");
      continue;
    }
    if (BARE_TIMESTAMP.test(s)) continue;
    if (DROP_LINE.some((re) => re.test(s))) continue;
    out.push(raw.replace(LEADING_TIMESTAMP, ""));
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
