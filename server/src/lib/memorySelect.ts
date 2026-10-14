/** Which memories are worth putting in THIS prompt.
 *
 *  Before this there was no retrieval at all: all forty facts went into every extraction, so a
 *  pricing call carried "Adds test cases in Gherkin format" and "Evaluates mobile designs at 430px
 *  viewport width". Three costs, and the third is the one that caps the whole feature:
 *
 *    NOISE     forty facts where three matter means the three are diluted.
 *    COST      they sit in the system prompt. Even split out of the cached half (extract.v009),
 *              they are ~1,000 tokens on every single call.
 *    A CEILING The cap is 40 not because 40 is the right amount to know about a person, but
 *              because more would make the noise worse. A second brain that cannot retrieve can
 *              never hold more than fits in one prompt, which is not a second brain.
 *
 *  NO EMBEDDINGS, DELIBERATELY. This is lexical and deterministic: it needs no vector store, no
 *  extra API call, no migration, and it is testable without a database. Embeddings are the right
 *  answer at ten thousand facts. At forty they would be a dependency bought to solve a problem we
 *  do not have yet, and the failure mode of a bad lexical match is one irrelevant line in a prompt.
 *
 *  THE RULE THAT MATTERS MOST is the last one: a fact that names nobody is a STANDING preference
 *  ("prefers usability over pixel-perfect UI"), and those apply to every meeting. Only facts that
 *  name a person or a thing have to earn their place by matching. Getting this backwards would drop
 *  exactly the facts that generalise and keep the ones that do not.
 */

export interface MemoryLike {
  id: number;
  content: string;
}

/** Words too common to mean anything as a match. Kept short on purpose: an aggressive stop list
 *  starts removing the words that carry the meeting (`pricing`, `review`, `design`). */
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "they", "them", "their", "you", "your",
  "are", "was", "were", "has", "have", "had", "will", "would", "should", "can", "could",
  "when", "what", "which", "who", "whom", "how", "why", "into", "over", "under", "about",
  "before", "after", "than", "then", "there", "here", "not", "but", "all", "any", "one",
  "meeting", "call", "sync", "weekly", "daily", "team", "haii",
]);

export function tokenise(s: string): Set<string> {
  return new Set(
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w)),
  );
}

/** Does this fact name anybody or anything specific?
 *
 *  A capitalised word that is not the sentence's first word is the cheap, reliable signal for a
 *  proper noun in these facts, which are all written as sentences by the same prompt. */
export function isSpecific(content: string): boolean {
  const words = String(content ?? "").trim().split(/\s+/).slice(1);
  return words.some((w) => /^[A-Z][a-z]{2,}/.test(w));
}

export interface SelectContext {
  /** Meeting title, attendee names, and anything else naming who and what this is about. */
  title?: string;
  attendees?: string[];
  /** The transcript. Only the opening is used: enough to catch the subject, cheap to tokenise. */
  transcript?: string;
}

/** How many facts reach the prompt. Twelve rather than forty: enough for the standing preferences
 *  plus whatever this meeting actually touches, small enough that each one still carries weight. */
export const MEMORY_PROMPT_LIMIT = 12;

/** Is this proposed fact already covered by one we hold?
 *
 *  THIS EXISTS BECAUSE RETRIEVAL BROKE AN ASSUMPTION. The extract prompt tells the model to check
 *  the known list and UPDATE an entry rather than add a near-duplicate. That instruction was safe
 *  while all forty facts were in the prompt. Now that only twelve are, the model cannot see the
 *  other twenty-eight, so it will honestly propose things it already knows, and `applyMemoryWrites`
 *  trims the OLDEST past the cap: the corpus would slowly fill with restatements of itself while
 *  quietly dropping older, still-true facts.
 *
 *  So the guard belongs on the server, where the whole corpus is visible, not in a prompt that can
 *  only ever see a slice. Jaccard overlap on content words: cheap, deterministic, no model call.
 *
 *  0.6 rather than something tighter. These facts are written by one prompt in one register, so
 *  genuine near-duplicates share most of their content words, and the cost of a false positive
 *  (one fact not recorded, which the next meeting can propose again) is far lower than the cost of
 *  a false negative (a permanent duplicate that also evicts something true). */
export function isDuplicateFact(candidate: string, existing: string[], threshold = 0.6): boolean {
  const a = tokenise(candidate);
  if (!a.size) return false;
  for (const e of existing) {
    const b = tokenise(e);
    if (!b.size) continue;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    const union = a.size + b.size - shared;
    if (union > 0 && shared / union >= threshold) return true;
  }
  return false;
}

/** Pick the memories worth sending, newest-first order preserved.
 *
 *  Order in equals order out, because `listMemories` already returns newest first and recency is
 *  the only quality signal available until per-fact outcomes exist. */
export function selectMemories<T extends MemoryLike>(
  memories: T[],
  ctx: SelectContext,
  limit = MEMORY_PROMPT_LIMIT,
): T[] {
  if (memories.length <= limit) return memories;

  const haystack = tokenise(
    [ctx.title ?? "", ...(ctx.attendees ?? []), String(ctx.transcript ?? "").slice(0, 4000)].join(" "),
  );
  const attendeeWords = tokenise((ctx.attendees ?? []).join(" "));

  const scored = memories.map((m, i) => {
    const words = tokenise(m.content);
    let score = 0;
    for (const w of words) {
      if (attendeeWords.has(w)) score += 3; // naming someone in the room is the strongest signal
      else if (haystack.has(w)) score += 1;
    }
    // A standing preference names nobody, so it can never match, and it applies to everything.
    // Without this floor the selector would keep only the facts about specific people and drop
    // every general rule about how this person works, which is the opposite of useful.
    if (!isSpecific(m.content)) score += 2;
    return { m, score, i };
  });

  return scored
    .sort((a, b) => (b.score - a.score) || (a.i - b.i)) // ties break toward the newer fact
    .slice(0, limit)
    .sort((a, b) => a.i - b.i) // restore newest-first
    .map((x) => x.m);
}
