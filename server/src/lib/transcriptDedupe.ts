/** One EXTRACTED transcript per meeting.
 *
 *  Until a notetaker connector existed, every meeting had at most one transcript (a Gemini doc from
 *  Drive) and this question could not arise. The moment a second source lands, the same conversation
 *  can arrive twice, and CARDS COME FROM TRANSCRIPTS. Two transcripts of one meeting is two sets of
 *  cards for one meeting: the user is asked to nod the same promise twice, the north star counts it
 *  twice, and the duplicate is indistinguishable from a real second commitment.
 *
 *  So the rule is not "dedupe transcripts", it is "only one of them may ever be a card source".
 *
 *  WHY PREFERENCE AND NOT FIRST-WINS. Which arrives first is a race between two pollers on different
 *  cadences, so first-wins would make card quality depend on scheduling luck. The sources are not
 *  equal: a notetaker records what was SAID, Gemini writes a summary of it. Evidence fidelity is the
 *  product's whole trust claim and it is checked by finding the card's quote verbatim in its source,
 *  so a real transcript supports it and a summary strains it. The notetaker wins where both exist.
 *
 *  WHY EXTRACTION IS THE POINT OF NO RETURN. Once a transcript has been extracted, cards exist and
 *  a user may already have nodded them. Swapping the source then would either strand those cards or
 *  duplicate them. So preference only applies while nothing has been read yet; after that the
 *  incoming transcript is kept for reference and permanently barred from extraction.
 *
 *  Pure and separated from the connector so it can be tested without a database or an API key,
 *  which matters because this is the piece whose failure is silent and expensive.
 */

/** How good a card source is this? Higher wins. */
export const SOURCE_RANK: Record<string, number> = {
  // Verbatim speech, speaker-attributed. The best evidence a quote can be checked against, and
  // all three notetakers are equal on that: they record the same room the same way, so ranking one
  // vendor above another would be taste, not evidence. Equal rank also means whichever arrived
  // first keeps the slot, which is the right answer when neither is better.
  fireflies: 3,
  fathom: 3,
  otter: 3,
  // What the user pasted in themselves. Deliberately above Drive: pasting is a deliberate act and
  // is usually the real transcript, and it is the path that needs no connector at all.
  paste: 2,
  // Gemini's notes. A summary, and the source every existing card was built from.
  drive: 1,
};

export function sourceRank(source: string): number {
  return SOURCE_RANK[source] ?? 0;
}

export interface ExistingTranscript {
  id: string;
  source: string;
  /** Null means nothing has been read from it yet, so it is still safe to replace. */
  extractedAt: Date | null;
  /** Already stood down in favour of another transcript; it is not the incumbent. */
  supersededBy: string | null;
}

export type DedupeDecision =
  /** Nothing else covers this meeting. Ingest and let it extract. */
  | { action: "ingest"; reason: string }
  /** Ingest, and stand the named transcripts down so they never mint cards. */
  | { action: "supersede"; supersede: string[]; reason: string }
  /** Ingest for reference only: something already covers this meeting. Never extract. */
  | { action: "keep_superseded"; supersededBy: string; reason: string };

/** Decide what to do with an incoming transcript for a meeting that may already have one.
 *
 *  `existing` is every transcript already attached to the same meeting for the same user. */
export function dedupeTranscript(
  incoming: { source: string },
  existing: ExistingTranscript[],
): DedupeDecision {
  // A transcript that was itself stood down is not competing for the slot.
  const live = existing.filter((t) => !t.supersededBy);
  if (!live.length) return { action: "ingest", reason: "no other transcript covers this meeting" };

  // THE POINT OF NO RETURN. Cards may already exist and may already have been nodded.
  const read = live.find((t) => t.extractedAt);
  if (read) {
    return {
      action: "keep_superseded",
      supersededBy: read.id,
      reason: `${read.source} was already read for this meeting, so cards exist; kept for reference only`,
    };
  }

  // Nothing read yet, so the better source may still take the slot.
  const best = live.reduce((a, b) => (sourceRank(b.source) > sourceRank(a.source) ? b : a));
  if (sourceRank(incoming.source) > sourceRank(best.source)) {
    return {
      action: "supersede",
      supersede: live.map((t) => t.id),
      reason: `${incoming.source} is a better source than ${best.source} and nothing has been read yet`,
    };
  }
  return {
    action: "keep_superseded",
    supersededBy: best.id,
    reason: `${best.source} already covers this meeting and is no worse than ${incoming.source}`,
  };
}
