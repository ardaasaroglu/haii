export const BACKFILL_PROMPT_VERSION = "backfill.v001";

// v001 (2026-08-04): bootstrap the brain from history instead of waiting months for it to fill.
//
// WHY THIS EXISTS. What Haii learns about a person is the one part of it that cannot be
// cold-started, and live use alone fills that memory slowly.
//
// Two structural reasons, and this prompt attacks the second. Haii only learns when it is WRONG,
// because approving a card teaches nothing it did not already propose, so a delighted user
// generates silence. And the richest source is thrown away: every transcript has been read and
// everything except the cards discarded.
//
// MAP AND REDUCE, and the split is not architectural taste. MEMORY_LIMIT is 40 per user and the
// trim keeps the newest, so a naive pass over a long history would mint several hundred facts and
// then discard all but an arbitrary 40, keeping whatever happened to come last. The map pass reads
// one transcript at a time and proposes candidates; the reduce pass sees ALL of a user's candidates
// at once and chooses the set, which is the only point at which "is this the same fact twice" and
// "is this worth one of forty slots" can be answered.

/* ---------------- map: one transcript, candidate facts ---------------- */

export function mapSystem(name: string): string {
  return `You are reading one of ${name}'s past meeting transcripts to learn durable facts for their assistant's long-term memory.

You are NOT extracting tasks. Ignore action items entirely; those were captured at the time.

Record only what will STILL BE TRUE NEXT MONTH:
• People: who they are, role, company, and their relationship to ${name}. "Dana Reyes signs contracts at Northwind" is durable. "Dana asked about pricing" is not.
• Projects and accounts: what they are, who owns them, what they depend on.
• How ${name} works: standing preferences, recurring meetings, how they want things phrased, what they consistently care about.
• Anything ${name} has said twice, or stated as a rule.

Never record: what happened in this one meeting, decisions that are already actioned, dates and numbers that will be stale next month, or anything that reads as news rather than as background.
Never invent. If the transcript supports nothing durable, return an empty list, which is the common and correct answer.
One fact per entry, one sentence, no em dashes or en dashes. Name people in full where the transcript does.`;
}

export const MAP_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      // Deliberately tight. A transcript yielding eight durable facts is a transcript being
      // summarised, which is what the reduce pass then has to undo.
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["person", "project", "preference", "other"] },
          fact: { type: "string" },
        },
        required: ["kind", "fact"],
        additionalProperties: false,
      },
    },
  },
  required: ["facts"],
  additionalProperties: false,
} as const;

export function mapUser(ctx: { selfName: string; title: string; when: string; transcript: string }): string {
  return `Durable facts about ${ctx.selfName}'s working world from this transcript.

MEETING: ${ctx.title}
WHEN: ${ctx.when}

TRANSCRIPT:
${ctx.transcript}`;
}

/* ---------------- reduce: all candidates, one curated set ---------------- */

export function reduceSystem(name: string, limit: number): string {
  return `You are curating the long-term memory of ${name}'s assistant from candidate facts gathered across their whole meeting history.

You will be given many candidates, most of them overlapping, some contradictory, some too specific to keep.

Produce AT MOST ${limit} final memories. Fewer is better. Rules:
• MERGE duplicates and near-duplicates into one richer sentence. Three candidates about Dana become one line about Dana.
• PREFER what recurs. A fact supported by several meetings is worth a slot; a fact seen once usually is not.
• PREFER people and how ${name} works over project detail, which ages fastest.
• DROP anything already stale, anything about a single meeting, and anything that reads as news.
• RESOLVE contradictions toward the most recent candidate, since the list is given oldest first.
• Each memory is one sentence that would still be useful to someone briefing ${name} next month.
• No em dashes or en dashes. Name people in full.

These will be read before every meeting brief and every extraction, so a wrong or stale line costs more than a missing one.`;
}

export const REDUCE_SCHEMA = {
  type: "object",
  properties: {
    memories: {
      type: "array",
      maxItems: 40,
      items: { type: "string" },
    },
  },
  required: ["memories"],
  additionalProperties: false,
} as const;

export function reduceUser(ctx: { selfName: string; candidates: string; existing: string }): string {
  return `Curate ${ctx.selfName}'s long-term memory.

${ctx.existing ? `ALREADY REMEMBERED (keep what still holds, merge where it overlaps):\n${ctx.existing}\n\n` : ""}CANDIDATE FACTS, oldest first:
${ctx.candidates}`;
}
