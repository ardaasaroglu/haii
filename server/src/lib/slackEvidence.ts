/** THE security boundary for cards minted from the user's own Slack messages (jobs/slackListen.ts).
 *
 *  The threat: a hostile DM sitting one message above a real commitment, in the BACKGROUND context
 *  slackListen fetches for pronoun resolution. Prompt wording alone ("never quote this section")
 *  is persuasion, not a guarantee, and this product's whole premise is that persuasion is not
 *  enough. This file is the guarantee. A card survives only if at least one of its evidence quotes
 *  is verifiably a substring of a message the user actually wrote, checked here in code, after the
 *  model has already run and cannot argue with the answer.
 *
 *  Pure and dependency-free on purpose: no db, no Slack client, no other lib import. A function
 *  that decides what a hostile message can and cannot do should be auditable by reading this one
 *  file, and should not be able to drift because someone changed normalisation logic somewhere
 *  else for an unrelated reason (lib/metrics.ts has its own normalizeForQuoteMatch for a retrospective
 *  fidelity metric across ALL transcript text; reusing it here would couple a security gate to a
 *  metrics helper, and that helper's "skip quotes under 12 chars" leniency is correct for a metric
 *  and wrong for a gate). `npm test -w @haii/server` runs slackEvidence.test.ts with no database. */

/** Collapse whitespace runs to one space, trim, casefold. Slack's stored text and a model's
 *  rendering of a quote from it differ in whitespace far more often than in words (a soft-wrapped
 *  line, a doubled space, a trailing newline), so comparing raw strings would reject as many real
 *  quotes as it caught fabricated ones. Deliberately minimal: no fuzzy matching, no punctuation
 *  stripping. Exact-after-normalisation, or it fails. */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Below this a quote cannot carry a commitment by itself, whoever typed it. See quoteIsOwn. */
const MIN_QUOTE_CHARS = 12;
const MIN_QUOTE_WORDS = 3;

/** True only when `quote` is verifiably a substring of one of the user's OWN messages, AND says
 *  enough to be evidence of anything.
 *
 *  Checked per message, never against a joined blob of every own-message concatenated together:
 *  joining first would let a quote that spans the tail of one message and the head of the next
 *  pass as if it were one continuous, real thing said. It was not; nobody said that sentence.
 *  Empty or whitespace-only always fails, so a model that emits a blank "quote" for a fabricated
 *  card gets no benefit of the doubt.
 *
 *  THE SUBSTANCE FLOOR, and why authorship alone is not enough: a hostile background line says
 *  what to do, the user replies "ok", and "ok" is a genuine substring of a genuine own message. A
 *  check that only asks "did they type these characters" passes that card, and the commitment came
 *  entirely from the attacker. So the quote must also be long enough to say something: three words
 *  and twelve characters, which keeps "I'll do that" and rejects "ok", "sure", "will do", "on it".
 *  The cost of the floor is the honest one to state: a real card whose only evidence is a two-word
 *  agreement is dropped, and the user acts on it in Slack like they would have anyway. The cost of
 *  not having it is a fabricated action with a laundered quote, which is the whole threat. */
export function quoteIsOwn(quote: string, ownMessages: string[]): boolean {
  const q = normalize(quote);
  if (!q) return false;
  if (q.length < MIN_QUOTE_CHARS || q.split(" ").length < MIN_QUOTE_WORDS) return false;
  return ownMessages.some((m) => normalize(m).includes(q));
}
