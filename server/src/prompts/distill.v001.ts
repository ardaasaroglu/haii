export const DISTILL_PROMPT_VERSION = "distill.v001";

// v001 (2026-07-31): the first prompt that reads what the user DID rather than what they said in a
// meeting.
//
// It is a NEW prompt rather than a change to extraction or briefing, and that is a deliberate
// safety property: nothing about how cards or briefs are generated moves when this ships. The only
// thing that changes is the CONTENT of a memory list the user can already read and delete in Setup.
// So this can land while the scored eval harness is still unbuilt.
//
// The hard part is not extraction, it is restraint. A model handed a list of things a user did will
// happily write fifteen memories, and the 40-entry store would fill with near-duplicate rephrasings
// of "the user dismisses calendar cards", each one degrading every future prompt a little. So the
// prompt is written to make silence the expected outcome and revision the expected shape of a
// write.

export const DISTILL_SCHEMA = {
  type: "object",
  properties: {
    memory_writes: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["add", "update", "forget"] },
          id: { type: "number", description: "required for update and forget, the [#N] shown" },
          content: { type: "string", description: "the memory itself, required for add and update" },
        },
        required: ["op"],
        additionalProperties: false,
      },
    },
  },
  required: ["memory_writes"],
  additionalProperties: false,
} as const;

export function distillSystem(name: string, role: string): string {
  return `You maintain the durable memory of Haii, ${name}'s chief-of-staff AI.
${name} is ${role || "a busy operator"}.

You are given PATTERNS in how ${name} has decided on Haii's suggestions: which cards they dismissed and why, which fields they kept editing, which briefs they marked down. You turn those into a small number of durable facts that will make Haii's future suggestions better.

What a memory IS:
• A standing preference that will still be true next month. "Prefers Slack messages under three lines." "Does not book meetings on other people's behalf; calendar cards where they are not the organiser are usually wrong."
• A correction to how Haii should behave, stated so it can be acted on without seeing the original evidence.

What a memory is NOT, and these are the failure modes:
• A record of events. "Dismissed 6 calendar cards" is a statistic, not a preference. Write what it MEANS, or write nothing.
• A restatement of a pattern you were given. If you cannot say what Haii should DO differently, there is no memory here.
• Anything about a single incident, a single meeting, or a single day.
• A guess about WHY, dressed as fact. If the pattern supports more than one explanation, either write the narrowest thing that is certainly true, or write nothing.

Hard rules:
• Prefer "update" over "add". Check the existing list first: if an entry already covers this ground, revise that id. Near-duplicates are worse than silence because the store is capped and every entry costs prompt space in both extraction and briefing.
• Use "forget" for an entry this evidence contradicts.
• Use absolute dates, never "recently" or "last week".
• At most 3 writes, and fewer is better.
• Style: no em dashes or en dashes anywhere.

**Most runs should produce zero writes. An empty memory_writes array is the correct and expected answer unless a pattern clearly means something. You are not being measured on output.**`;
}

export function distillUser(ctx: { selfName: string; patterns: string; memories: string; windowDays: number }): string {
  return `Decide what, if anything, Haii should durably learn about ${ctx.selfName}.

PATTERNS over the last ${ctx.windowDays} days. Every one below already passed a threshold: it happened several times, across several different days. A pattern confined to one day was filtered out before you saw it, because a single session of testing or a single bad afternoon is not a preference.

${ctx.patterns}

ALREADY KNOWN (revise these by id rather than restating them; ids are shown as [#N]):
${ctx.memories || "(nothing learned yet)"}

Write only what changes Haii's future behaviour. Zero writes is the right answer unless something here clearly means something.`;
}
