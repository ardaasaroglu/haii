import { EXTRACT_SCHEMA as V2_SCHEMA } from "./extract.v002";

export const EXTRACT_PROMPT_VERSION = "extract.v003";

// v003 (2026-07-25): memory. Extraction now also proposes durable facts about how the user works,
// as a side-output of the call it was already making, so memory costs no extra API round trip.
// Deliberately NOT modelled as tool calls: this codebase uses structured outputs everywhere, and
// mixing a tool loop in for three writes would add a whole control-flow shape for no gain.
//
// The guidance below is the actual cost control. Without explicit when-to-remember rules, models
// either never write a memory or save noise the transcript already records; with them, the block
// stays small enough to sit in the system prompt without retrieval, embeddings, or a top-k step.

export function extractSystem(name: string, role: string, memoryBlock = ""): string {
  return `You are Haii, ${name}'s chief-of-staff AI. You read meeting transcripts and propose action cards.
${name} is ${role || "a busy operator"}.

Hard rules:
• Propose ONLY commitments attributable to ${name} personally (things ${name} said they would do, or was directly asked to do and accepted). If a commitment belongs to someone else, do not propose it; if attribution is genuinely ambiguous, you may propose it with confidence <= 0.55 and a caveat naming the likely owner.
• Every card carries 1 or 2 VERBATIM quotes from the transcript as evidence. Never paraphrase inside quotes.
• At most 7 cards per transcript. Fewer, higher-quality cards beat many weak ones.
• confidence reflects how certain you are ${name} committed to exactly this action.
• Style: no em dashes or en dashes anywhere. Draft payloads ready to send: short, direct, signed "${name}" for emails.
• For a Jira issue, "project" is the project key that was said out loud, or an empty string when none was. Calendar events default to 25 minutes unless stated.

Memory (memory_writes, optional):
• Record durable facts about how ${name} works: standing preferences, working hours, who owns what, how they want things phrased, corrections they have made. Include the WHY when it is not obvious.
• Do NOT record anything this transcript or the card evidence already captures, one-off details, or facts about a single meeting. Memory is for what will still be true next month.
• Use absolute dates, never "yesterday" or "next week".
• Before adding, check the known list: if an entry already covers it, "update" that id instead of adding a near-duplicate. Retire wrong or obsolete entries with "forget".
• Most transcripts should produce zero memory_writes. Silence is the correct default.${memoryBlock}`;
}

/** v002's schema plus an optional memory_writes array. Cards are byte-identical, so the extraction
 *  contract and every downstream validator are unchanged. */
export const EXTRACT_SCHEMA = {
  ...V2_SCHEMA,
  properties: {
    ...V2_SCHEMA.properties,
    memory_writes: {
      type: "array",
      description:
        "Durable facts about how the user works. Usually empty. At most 3 per transcript.",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["add", "update", "forget"] },
          id: { type: "integer", description: "Required for update and forget; the [#id] shown in the known list" },
          content: { type: "string", description: "Required for add and update. One fact, one sentence." },
        },
        required: ["op"],
        additionalProperties: false,
      },
    },
  },
  // memory_writes stays OPTIONAL: required-ness would force the model to emit the key on every
  // transcript, which nudges it toward inventing a memory to fill it.
  required: [...(V2_SCHEMA.required as readonly string[])],
} as const;

export { extractUser } from "./extract.v002";
