export const BRIEFING_PROMPT_VERSION = "briefing.v003";

// v003 (2026-07-16): multi-tenant. BRIEFING_SYSTEM becomes briefingSystem(name, role)
// so briefs read naturally for any user; the People section's self-exclusion
// follows the same substitution. Schema and the rest of v002's behavior are unchanged.

export function briefingSystem(name: string, role: string, memoryBlock = ""): string {
  return `You are Haii, ${name}'s chief-of-staff AI. You write 60-second pre-meeting briefs.
${name} is ${role || "a busy operator"}.
Write dense, factual, decision-level briefs grounded ONLY in the provided context. Never invent facts, numbers, or commitments; if the context is thin, say what is missing rather than filling gaps.
Always include one section headed "People": one line per attendee other than ${name}, saying who they are and the most recent thing that happened with them, drawn strictly from ATTENDEE CONTEXT. If an attendee has no history in the context, the line must read exactly: New face: {name}. No history yet, research pending.
Style: no em dashes or en dashes anywhere, use commas or periods. About 220 words total across all fields. Lead with what changed and what decision is on the table.${memoryBlock}`;
}

export const BRIEFING_SCHEMA = {
  type: "object",
  properties: {
    tldr: { type: "string", description: "3-4 sentences. The one thing to know walking in." },
    sections: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          h: { type: "string", description: "Short section header; one section must be People" },
          items: { type: "array", items: { type: "string" }, maxItems: 5 },
        },
        required: ["h", "items"],
        additionalProperties: false,
      },
    },
    last_met: {
      type: "array",
      maxItems: 4,
      description: "Outcomes from the last meeting with these people; empty if unknown",
      items: {
        type: "object",
        properties: {
          st: { type: "string", enum: ["done", "open"] },
          t: { type: "string" },
        },
        required: ["st", "t"],
        additionalProperties: false,
      },
    },
    open_threads: { type: "array", items: { type: "string" }, maxItems: 4 },
  },
  required: ["tldr", "sections", "last_met", "open_threads"],
  additionalProperties: false,
} as const;

export function briefingUser(ctx: {
  selfName: string;
  meetingTitle: string;
  startsAt: string;
  attendees: string;
  attendeeContext: string;
  snippets: string;
  lastMeeting: string;
  openWork: string;
}): string {
  return `Brief ${ctx.selfName} for this meeting.

MEETING: ${ctx.meetingTitle}
STARTS: ${ctx.startsAt}
ATTENDEES: ${ctx.attendees}

ATTENDEE CONTEXT (per person, from ${ctx.selfName}'s own history; "none" means a new face):
${ctx.attendeeContext || "(no attendee context)"}

RECENT STREAM CONTEXT (emails, Slack, Jira; newest first):
${ctx.snippets || "(nothing relevant found)"}

LAST MEETING WITH OVERLAPPING ATTENDEES:
${ctx.lastMeeting || "(none found)"}

OPEN WORK (proposed cards and todos):
${ctx.openWork || "(none)"}`;
}
