export const EXTRACT_PROMPT_VERSION = "extract.v002";

// v002 (2026-07-16): multi-tenant. EXTRACT_SYSTEM becomes extractSystem(name, role) so
// extraction reads naturally for any user (a gendered "himself" was dropped along the way, since
// it no longer generalizes). EXTRACT_SCHEMA is byte-identical to v001.

export function extractSystem(name: string, role: string): string {
  return `You are Haii, ${name}'s chief-of-staff AI. You read meeting transcripts and propose action cards.
${name} is ${role || "a busy operator"}.

Hard rules:
• Propose ONLY commitments attributable to ${name} personally (things ${name} said they would do, or was directly asked to do and accepted). If a commitment belongs to someone else, do not propose it; if attribution is genuinely ambiguous, you may propose it with confidence <= 0.55 and a caveat naming the likely owner.
• Every card carries 1 or 2 VERBATIM quotes from the transcript as evidence. Never paraphrase inside quotes.
• At most 7 cards per transcript. Fewer, higher-quality cards beat many weak ones.
• confidence reflects how certain you are ${name} committed to exactly this action.
• Style: no em dashes or en dashes anywhere. Draft payloads ready to send: short, direct, signed "${name}" for emails.
• For a Jira issue, "project" is the project key that was said out loud, or an empty string when none was. Calendar events default to 25 minutes unless stated.`;
}

export const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    cards: {
      type: "array",
      maxItems: 7,
      items: {
        type: "object",
        properties: {
          action_type: {
            type: "string",
            enum: [
              "create_calendar_event",
              "send_email",
              "create_todo",
              "send_slack_message",
              "create_jira_issue",
            ],
          },
          title: { type: "string", description: "Short imperative card title" },
          summary: { type: "string", description: "1-2 sentences of context for the card owner" },
          confidence: { type: "number" },
          priority: { type: "string", enum: ["high", "normal", "low"] },
          payload: {
            anyOf: [
              {
                type: "object",
                properties: {
                  to: { type: "string" },
                  subject: { type: "string" },
                  body: { type: "string" },
                },
                required: ["to", "subject", "body"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  title: { type: "string" },
                  date: { type: "string" },
                  time: { type: "string" },
                  duration_min: { type: "integer" },
                  attendees: { type: "string" },
                },
                required: ["title", "date", "time", "duration_min", "attendees"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  title: { type: "string" },
                  due: { type: "string" },
                  notes: { type: "string" },
                },
                required: ["title", "due", "notes"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  channel: { type: "string" },
                  message: { type: "string" },
                },
                required: ["channel", "message"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  project: { type: "string" },
                  issue_type: { type: "string" },
                  summary: { type: "string" },
                  description: { type: "string" },
                  labels: { type: "string" },
                },
                required: ["project", "issue_type", "summary", "description", "labels"],
                additionalProperties: false,
              },
            ],
          },
          evidence: {
            type: "array",
            minItems: 1,
            maxItems: 2,
            items: {
              type: "object",
              properties: {
                who: { type: "string" },
                text: { type: "string", description: "VERBATIM transcript quote" },
              },
              required: ["who", "text"],
              additionalProperties: false,
            },
          },
          entities: { type: "array", items: { type: "string" } },
          caveat: { type: "string", description: "Only when attribution or details are uncertain" },
        },
        required: [
          "action_type",
          "title",
          "summary",
          "confidence",
          "priority",
          "payload",
          "evidence",
          "entities",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["cards"],
  additionalProperties: false,
} as const;

export function extractUser(ctx: {
  selfName: string;
  transcriptTitle: string;
  transcript: string;
  meeting: string;
  openCards: string;
  exemplars: string;
  suppression: string;
}): string {
  return `Extract ${ctx.selfName}'s action cards from this transcript.

TRANSCRIPT: ${ctx.transcriptTitle}
MEETING: ${ctx.meeting || "(not linked to a calendar meeting)"}

${ctx.suppression ? `FEEDBACK SIGNALS (respect these):\n${ctx.suppression}\n` : ""}${ctx.exemplars ? `RECENT DECISIONS (${ctx.selfName}'s taste; approved means more like this, dismissed means fewer):\n${ctx.exemplars}\n` : ""}ALREADY OPEN (do not duplicate):
${ctx.openCards || "(none)"}

TRANSCRIPT CONTENT:
${ctx.transcript}`;
}
