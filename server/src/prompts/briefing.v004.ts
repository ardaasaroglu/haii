import { BRIEFING_SCHEMA as V3_SCHEMA, briefingSystem } from "./briefing.v003";

export const BRIEFING_PROMPT_VERSION = "briefing.v004";

// v004 (2026-07-30): the user's own brief ratings reach the model.
//
// A new file rather than an edit to v003, for the same reason every other version is: promptVersion
// is stamped onto every briefings row, and two different prompts both claiming to be v003 would make
// the quality numbers unreadable.
//
// Ratings have been collected since v002 and consumed by nothing. A thumbs down told the model
// nothing at all, so a brief the user had rejected was written the same way the next time.
//
// The chips are corrections, not scores, and they pull in different directions on purpose:
// "too long" is about length, "wrong people" is about the People section picking the wrong faces,
// and "missed the point" is about the tldr leading with the wrong thing. A single "bad" signal
// collapses all three into "try harder", which is not actionable. The block is omitted entirely
// when there is no feedback, rather than rendered empty, so a new user's prompt is unchanged.
//
// The system prompt and the schema are v003 unchanged.

export { briefingSystem };

/** Unchanged from v003. */
export const BRIEFING_SCHEMA = V3_SCHEMA;

export function briefingUser(ctx: {
  selfName: string;
  meetingTitle: string;
  startsAt: string;
  attendees: string;
  attendeeContext: string;
  snippets: string;
  lastMeeting: string;
  openWork: string;
  briefFeedback: string;
}): string {
  return `Brief ${ctx.selfName} for this meeting.

MEETING: ${ctx.meetingTitle}
STARTS: ${ctx.startsAt}
ATTENDEES: ${ctx.attendees}
${
  ctx.briefFeedback
    ? `
HOW ${ctx.selfName.toUpperCase()} RATED RECENT BRIEFS (newest first; apply these corrections):
"too long" means cut length, not detail: lead with the decision on the table and drop the throat-clearing.
"wrong people" means the People section covered the wrong attendees or said nothing useful about them.
"missed the point" means the tldr led with the wrong thing, not that the facts were wrong.
A thumbs up means keep doing what that brief did.
${ctx.briefFeedback}
`
    : ""
}
ATTENDEE CONTEXT (per person, from ${ctx.selfName}'s own history; "none" means a new face):
${ctx.attendeeContext || "(no attendee context)"}

RECENT STREAM CONTEXT (emails, Slack, Jira; newest first):
${ctx.snippets || "(nothing relevant found)"}

LAST MEETING WITH OVERLAPPING ATTENDEES:
${ctx.lastMeeting || "(none found)"}

OPEN WORK (proposed cards and todos):
${ctx.openWork || "(none)"}`;
}
