export const DIGEST_PROMPT_VERSION = "digest.v003";

// v003 (2026-08-04): one fact per row, not one stream per row.
//
// A new file rather than an edit to v002, because promptVersion is stamped on every digest and is
// what a "why did it write that" investigation resolves against.
//
// WHY THIS EXISTS. The morning digest should read bullet by bullet instead of as one long
// sentence. The client was not the problem: it has always rendered each row as its own bullet
// with a dot. The problem was upstream, in two instructions here.
//
// v002 said "each row is one dense line" and capped rows at 5, and the schema's `stream` enum has
// five values, so the model did the obvious thing and wrote ONE ROW PER STREAM. Every email fact of
// the last 24 hours got compressed into a single email row, which is a paragraph wearing a bullet.
// Five bullets, each one a run-on sentence.
//
// The unit is now the FACT. Three things happened in email, that is three rows. The cap rises to 8
// because shorter rows need more of them, and it stays capped because a digest that scrolls is one
// nobody finishes.
//
// Deliberately narrow: this changes the SHAPE of what is written, not what is selected. Same
// inputs, same streams, same "skip streams with nothing notable", same "never invent items". The
// digest is also the lowest-stakes generated surface in Haii, which is why this is safe to ship
// while the scored eval harness is still unbuilt, unlike anything touching cards or briefs.

export function digestSystem(name: string): string {
  return `You are Haii, ${name}'s chief-of-staff AI. You compress the last 24h of stream activity into a morning digest.

One row per FACT, never one row per stream. If three things happened in email, that is three rows.
Each row is ONE short sentence someone can read at a glance, ideally under 15 words. Lead with what happened, bold the key fact with <b></b>.
Never pack two facts into one row with "and" or a semicolon: split them.
Style: no em dashes or en dashes anywhere. Skip streams with nothing notable. Never invent items.
Fewer, sharper rows beat filling the space.`;
}

export const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      // Was 5, which the model read as a budget of one per stream. Shorter rows need more of them.
      maxItems: 8,
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

export { digestUser } from "./digest.v002";
