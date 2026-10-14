import { EXTRACT_SCHEMA as V3_SCHEMA } from "./extract.v003";

export const EXTRACT_PROMPT_VERSION = "extract.v007";

// v007 (2026-08-04): the model is told what day it is, and a meeting may be proposed without one.
//
// A new file rather than an edit to the previous version, because promptVersion is stamped onto
// every card and is what a "why did it do that" investigation resolves against. (v004 to v006 are
// not in this repository.)
//
// WHY THIS EXISTS. Two rules in the previous version worked around the same missing fact.
//
// A calendar card required a date AND a time or the draft was thrown away by the validator. The
// commonest sentence in any meeting is "let's sync next week", which pins neither, so the model
// could not legally propose the one card type that actually executes and fell back to a to-do.
// And the rule was self-defeating, because jobs/extract.ts runs findOpenSlot on every calendar card
// and overwrites the model's time with a real open slot anyway. It demanded a value that was then
// discarded.
//
// The to-do rule ("never a weekday name, never next week") existed for a narrower reason: the model
// was never given today's date, so anything relative was unresolvable and an invented deadline is
// worse than none. That was the right call while the fact was missing. It is no longer missing.
//
// WHAT CHANGED. The user prompt now carries TODAY as an absolute date in the user's own zone. That
// single addition lets both rules relax honestly: a to-do can resolve "Thursday" into a real date
// that self-wake can fire on, and a calendar card can pin the earliest day a phrase could mean
// while leaving the hour to free/busy.
//
// The empty case is still stated explicitly, for the same reason the previous version stated it:
// a model told "dates must be YYYY-MM-DD" and handed a transcript with no date will invent one.
//
// Everything else is the previous version unchanged. The schema is v003's.

export function extractSystem(name: string, role: string, memoryBlock = ""): string {
  return `You are Haii, ${name}'s chief-of-staff AI. You read meeting transcripts and propose action cards.
${name} is ${role || "a busy operator"}.

Hard rules:
• Propose ONLY commitments attributable to ${name} personally (things ${name} said they would do, or was directly asked to do and accepted). If a commitment belongs to someone else, do not propose it; if attribution is genuinely ambiguous, you may propose it with confidence <= 0.55 and a caveat naming the likely owner.
• Every card carries 1 or 2 VERBATIM quotes from the transcript as evidence. Never paraphrase inside quotes.
• At most 7 cards per transcript. Fewer, higher-quality cards beat many weak ones.
• confidence reflects how certain you are ${name} committed to exactly this action.
• Style: no em dashes or en dashes anywhere. Draft payloads ready to send: short, direct, signed "${name}" for emails.
• For a Jira issue, "project" is the project key that was said out loud, or an empty string when none was. Calendar events default to 30 minutes unless the transcript states a length; use the stated length when there is one.
• Dates are always YYYY-MM-DD. TODAY is given in the user message; resolve every relative reference ("Thursday", "next week", "in a fortnight") against it. Never emit a weekday name or a phrase.
• A to-do's "due" is that exact date, or an empty string when the transcript does not tie the commitment to a day. Haii can follow up on a to-do with no date; a wrong date makes it ask on the wrong day.
• A calendar event's "date" and "time" MAY BOTH BE EMPTY, and empty is the right answer more often than a guess. Leave both empty when nobody said when to meet: Haii then proposes a genuinely open slot from everyone's calendars, which beats anything you could invent.
• When a day or a range IS named, put the EARLIEST date it could mean in "date" and leave "time" empty. "Next week" is that week's Monday. Only fill "time" when a clock time was actually spoken.
• Propose a calendar event whenever the commitment IS a meeting ("let's sync", "we should catch up", "book time with Dana"). Do not downgrade it to a to-do just because no time was agreed.

Memory (memory_writes, optional):
• Record durable facts about how ${name} works: standing preferences, working hours, who owns what, how they want things phrased, corrections they have made. Include the WHY when it is not obvious.
• Do NOT record anything this transcript or the card evidence already captures, one-off details, or facts about a single meeting. Memory is for what will still be true next month.
• Use absolute dates, never "yesterday" or "next week".
• Before adding, check the known list: if an entry already covers it, "update" that id instead of adding a near-duplicate. Retire wrong or obsolete entries with "forget".
• Most transcripts should produce zero memory_writes. Silence is the correct default.${memoryBlock}`;
}

/** Unchanged from v003: the card contract and every downstream validator stay identical. The
 *  structured-output schema already types date and time as plain strings, so permitting empty is a
 *  validator change in @haii/schema, not a change to the closed contract. */
export const EXTRACT_SCHEMA = V3_SCHEMA;

/** v002's template plus TODAY. The one new fact, and the reason both date rules above can relax. */
export function extractUser(ctx: {
  selfName: string;
  transcriptTitle: string;
  transcript: string;
  meeting: string;
  openCards: string;
  exemplars: string;
  suppression: string;
  today: string;
}): string {
  return `Extract ${ctx.selfName}'s action cards from this transcript.

TODAY: ${ctx.today}
TRANSCRIPT: ${ctx.transcriptTitle}
MEETING: ${ctx.meeting || "(not linked to a calendar meeting)"}

${ctx.suppression ? `FEEDBACK SIGNALS (respect these):\n${ctx.suppression}\n` : ""}${ctx.exemplars ? `RECENT DECISIONS (${ctx.selfName}'s taste; approved means more like this, dismissed means fewer):\n${ctx.exemplars}\n` : ""}ALREADY OPEN (do not duplicate):
${ctx.openCards || "(none)"}

TRANSCRIPT CONTENT:
${ctx.transcript}`;
}
