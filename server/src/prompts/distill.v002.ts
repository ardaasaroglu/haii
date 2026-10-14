import { DISTILL_SCHEMA as V1_SCHEMA, distillSystem } from "./distill.v001";

export const DISTILL_PROMPT_VERSION = "distill.v002";

// v002 (2026-07-31): the user's own words reach distillation.
//
// v001 learned only from BEHAVIOUR: patterns in what was dismissed, edited and rated, gated behind
// a multi-day rule so a single session could not teach anything. That rule is right for inference.
// It is wrong for a sentence the user deliberately sat down and typed.
//
// THE DISTINCTION, because it decides why notes skip the guard: an inferred pattern is a GUESS at
// a preference from behaviour, and a burst of behaviour in one afternoon, such as a session of
// testing, is not evidence of one. A note is the user STATING a preference on purpose. There is
// nothing to corroborate, and demanding they write the same note on three separate days before
// Haii listens would be absurd. So notes arrive as their own section,
// unguarded, and the prompt is told plainly that they outrank anything inferred.
//
// A note is still not automatically a memory. "It missed the attachment on the invite" is a
// capability gap, something Haii cannot do yet, not a standing preference, and turning it into a
// memory would write a permanent complaint into the prompt of every future brief. The system
// prompt already draws that line for behaviour; this file draws it again for notes, explicitly,
// because it is the mistake this section makes likely.

export { distillSystem };

/** Unchanged from v001. */
export const DISTILL_SCHEMA = V1_SCHEMA;

export function distillUser(ctx: {
  selfName: string;
  patterns: string;
  notes: string;
  memories: string;
  windowDays: number;
}): string {
  return `Decide what, if anything, Haii should durably learn about ${ctx.selfName}.

PATTERNS over the last ${ctx.windowDays} days. Every one below already passed a threshold: it happened several times, across several different days. A pattern confined to one day was filtered out before you saw it, because a single session of testing or a single bad afternoon is not a preference.

${ctx.patterns}
${
  ctx.notes
    ? `
WHAT ${ctx.selfName.toUpperCase()} WROTE, in their own words, about recent briefs. These are not inferred from behaviour, they were typed deliberately, so they carry MORE weight than any pattern above and are not filtered by frequency.

${ctx.notes}

Two of these are worth telling apart, and getting it wrong is the likely mistake here:
• A stated PREFERENCE ("keep these shorter", "I do not care about the attendee list") is exactly what a memory is for.
• A CAPABILITY GAP ("it missed the file attached to the invite", "it did not know about the Jira ticket") is something Haii cannot do yet. That is a bug report, not a preference, and writing it into memory would put a permanent complaint into every future prompt without fixing anything. Do not record those.
`
    : ""
}
ALREADY KNOWN (revise these by id rather than restating them; ids are shown as [#N]):
${ctx.memories || "(nothing learned yet)"}

Write only what changes Haii's future behaviour. Zero writes is the right answer unless something here clearly means something.`;
}
