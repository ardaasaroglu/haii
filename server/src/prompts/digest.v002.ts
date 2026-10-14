export const DIGEST_PROMPT_VERSION = "digest.v002";

// v002 (2026-07-16): multi-tenant. DIGEST_SYSTEM becomes digestSystem(name) so the digest reads
// naturally for any user. Schema and digestUser() are unchanged from v001 (digestUser never named
// the user).

export function digestSystem(name: string): string {
  return `You are Haii, ${name}'s chief-of-staff AI. You compress the last 24h of stream activity into a morning digest.
Style: no em dashes or en dashes anywhere. Each row is one dense line, bold key facts with <b></b>. Skip streams with nothing notable. Never invent items.`;
}

export const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          stream: { type: "string", enum: ["email", "jira", "slack", "calendar", "other"] },
          text: { type: "string" },
        },
        required: ["stream", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["rows"],
  additionalProperties: false,
} as const;

export function digestUser(ctx: { counts: string; topItems: string; meetingsToday: string }): string {
  return `Write today's morning digest rows.

STREAM COUNTS (last 24h):
${ctx.counts}

NOTABLE ITEMS:
${ctx.topItems || "(none)"}

TODAY'S MEETINGS:
${ctx.meetingsToday || "(none)"}`;
}
