import { EXTRACT_SCHEMA as V3_SCHEMA, extractSystem as v7System, extractUser } from "./extract.v007";

/** Re-exported unchanged. The user message is where TODAY and the transcript go, and v008 changes
 *  neither; only the system rules and the output schema widen. */
export { extractUser };

export const EXTRACT_PROMPT_VERSION = "extract.v008";

// v008 (2026-08-09): three new action types reach the extractor.
//
// A new file rather than an edit to v007, because promptVersion is stamped onto every card and is
// what a "why did it do that" investigation resolves against.
//
// WHY. The card schema went from five action types to eight: create_document, share_file,
// create_crm_note. The executor can perform all three, but a card type
// the extractor is never told about is a type that never gets proposed, so the schema change is
// inert until this file exists.
//
// THE RULE THE NEW GUIDANCE IS BUILT ON: an action type executes in proportion to whether the
// user ALREADY holds the destination. A calendar card lands for anyone with Google connected. A
// Jira card lands only for someone who connected Jira. So the guidance below pushes the model
// toward the two Drive types, which ride the same Google connection, and keeps the CRM type narrow.
//
// WHAT IS DELIBERATELY NOT HERE:
//
// No "prefer a document over a to-do" instruction. The to-do problem is real (to-dos pile up
// without executing) but the fix for it is a destination, not a prompt that talks the model out of
// the honest classification. A promise to "write up the proposal" IS a document; a promise to "chase Samantha"
// is not, and dressing the second as the first would just move the dead output to a new type.
//
// No deal-stage or amount writes for the CRM. A note is additive and reversible. Changing a number
// someone else reports on, from something half-heard in a transcript, is a different risk class.
//
// Everything else, including every v007 rule, is inherited unchanged.

const NEW_TYPE_RULES = `
• create_document: use when ${"{name}"} promised to WRITE something (a summary, a brief, a one-pager, notes, a proposal). "content" is the actual drafted text, ready to read, not a description of what will be written. Put the recipients in "share_with" when the promise names who gets it, so one nod produces the document AND delivers it.
• share_file: use ONLY when an existing named file is to be sent to named people ("send them the deck", "share the pricing doc with Dana"). "file_name" is what it was called out loud. If no file was actually named, this is not the right type.
• create_crm_note: use when ${"{name}"} promised to LOG or RECORD something about a person or account in the CRM ("I'll note that in HubSpot", "I'll log this against their record"). "contact" is a person's email when one was said, otherwise their name. Never use this to change a deal stage, an amount or an owner; those are not notes.
• When a promise fits BOTH a document and a to-do, choose the document only if the deliverable is the writing itself. "Write up the findings" is a document. "Follow up with Dana" is not.`;

export function extractSystem(name: string, role: string, memoryBlock = ""): string {
  // Built from v007 rather than copied, so any later fix to a shared rule cannot silently apply to
  // one version and not the other. The new rules are inserted before the Memory block, which has to
  // stay last because memoryBlock is appended to the very end.
  const base = v7System(name, role, "");
  const marker = "\n\nMemory (memory_writes, optional):";
  const rules = NEW_TYPE_RULES.replace(/\{name\}/g, name);
  const idx = base.indexOf(marker);
  if (idx < 0) return `${base}${rules}${memoryBlock}`;
  return `${base.slice(0, idx)}${rules}${base.slice(idx)}${memoryBlock}`;
}

/** The structured-output schema, widened for the three new types.
 *
 *  Cloned from v003's rather than mutated: these objects are module-level constants shared by every
 *  earlier version, so editing in place would retroactively change what v001 through v007 claim to
 *  have sent, and those strings are stamped on cards that already exist. */
const base = V3_SCHEMA as any;
const cloned = JSON.parse(JSON.stringify(base));
const cardItems = cloned?.properties?.cards?.items ?? cloned?.items;

if (cardItems?.properties?.action_type?.enum) {
  cardItems.properties.action_type.enum = [
    ...cardItems.properties.action_type.enum,
    "create_document",
    "share_file",
    "create_crm_note",
  ];
}
if (Array.isArray(cardItems?.properties?.payload?.anyOf)) {
  cardItems.properties.payload.anyOf.push(
    {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string", description: "The drafted document text, ready to read" },
        share_with: { type: "string", description: "Comma-separated emails, or empty" },
      },
      required: ["title", "content", "share_with"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        file_name: { type: "string", description: "The file as it was named out loud" },
        emails: { type: "string", description: "Comma-separated recipients" },
        role: { type: "string", description: "reader, commenter or writer" },
      },
      required: ["file_name", "emails", "role"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        contact: { type: "string", description: "Email if one was said, otherwise the person's name" },
        note: { type: "string", description: "The note to log, in full" },
      },
      required: ["contact", "note"],
      additionalProperties: false,
    },
  );
}

export const EXTRACT_SCHEMA = cloned;
