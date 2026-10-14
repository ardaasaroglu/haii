import { DISTILL_SCHEMA, distillSystem as v2System } from "./distill.v002";

export { DISTILL_SCHEMA };

export const DISTILL_PROMPT_VERSION = "distill.v003";

// v003 (2026-08-10): a third kind of note, because the taxonomy had a hole a real note fell through.
//
// A new file rather than an edit to v002, because promptVersion is stamped on what this writes.
//
// THE EVIDENCE, and this change is made from it rather than from a hunch. Distillation runs were
// writing nothing. The obvious diagnosis was that the qualifying threshold was too strict, and it
// was wrong: the gate passes fine. A run that wrote nothing recorded what it was offered:
//
//   patterns: only approvals ("approved a create_todo card", "approved a create_calendar_event card")
//   note:     "This is a recurring standup meeting with devs"
//
// On the PATTERNS the model was right to refuse, and loosening anything would have made it worse.
// How often someone approves a card type is a fact about what Haii PROPOSES, not about the person.
// "The user approves to-dos" in every future prompt is noise that crowds out something true.
//
// On the NOTE it was wrong, and the prompt is why. v002 tells it to sort notes into exactly two
// bins: a stated PREFERENCE, which is worth keeping, or a CAPABILITY GAP, which is a bug report and
// must not be kept. "This is a recurring standup meeting with devs" is neither. It is a plain fact
// about the user's world, deliberately typed, durable for months, and precisely the sort of thing a
// second brain exists to hold: it tells the briefing prompt what kind of meeting this is.
//
// With no bin to put it in, the model dropped it and reported nothing worth writing. A taxonomy
// that is missing a category does not produce an error, it produces silence.
//
// So: a third category. Nothing else changes, and the capability-gap exclusion stays exactly as
// strict, because that one is still a bug report and still does not belong in a prompt forever.

const THIRD_CATEGORY = `
• A stated FACT about how their world is arranged ("this is a recurring standup with the devs", "Dana is the one who signs", "Samantha owns the integrations") is ALSO worth keeping. It is not a preference and it is not a bug, and it is the most useful thing a note can contain: it tells Haii what a meeting IS and who the people in it are, which changes every future brief about them. Record these.`;

export function distillSystem(selfName: string, role: string): string {
  return `${v2System(selfName, role)}${THIRD_CATEGORY}`;
}

/** The user half is unchanged from v002 and re-exported so callers move version in one place. */
export { distillUser } from "./distill.v002";
