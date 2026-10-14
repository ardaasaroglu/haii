import { EXTRACT_SCHEMA as V10_SCHEMA, extractUser, EXTRACT_STABLE as V10_STABLE, extractVariable } from "./extract.v010";

export { extractUser, extractVariable };

export const EXTRACT_PROMPT_VERSION = "extract.v011";

// v011 (2026-08-12): send_text reaches the extractor. It is the tenth action type.
//
// A new file rather than an edit to v010, because promptVersion is stamped onto every card and two
// prompts both claiming to be v010 would make the quality numbers unreadable.
//
// WHAT THE TYPE IS. Approving builds an `sms:` URL and the client opens the user's Messages app
// with the message already written. The user presses send, from their own number, in the existing
// thread. Haii never sends anything and never holds a phone number.
//
// THE FAILURE MODE THIS PROMPT EXISTS TO PREVENT, and it is the only real risk in the whole type.
// `create_todo` floods the deck because the model reaches for it whenever someone
// promises anything at all. A text card is even easier to over-produce, because almost any
// commitment CAN be phrased as a message to somebody. If "I'll let Dana know" becomes a text, we
// have rebuilt the to-do flood in a new costume and made the deck worse.
//
// So the rule is drawn at the CHANNEL BEING NAMED OUT LOUD, not at the intent to communicate. The
// same shape as v010's to-do versus task line, and for the same reason: the model must not be left
// to decide which channel would be tidier.
//
// THE EMPTY RECIPIENT IS DELIBERATE and the prompt says so twice, because it reads like a gap. An
// unfilled `to` opens Messages with the To field blank and the user picks the person from their own
// contacts. That is what makes texting the wrong person structurally impossible rather than merely
// guarded against, and it is the same stance the CRM note type takes on ambiguous contacts: block
// and let the human resolve it, never guess, because a message sent to the wrong person is
// invisible to the user and cannot be undone by them.
//
// Appended to the STABLE half, where it belongs: these rules name no user and are identical for
// everybody, so they stay inside the shared cached prefix (see v009).

const NEW_RULES = `
• send_text: use ONLY when the transcript names texting or messaging a person as the channel ("I'll text her the address", "I'll shoot him a message", "text me when you land"). An intent merely to tell, let know, update, follow up with or send something to someone is NOT a text: judge those as email, Slack or a to-do on what was actually said. If nobody named the channel out loud, this is not a send_text.
• send_text "to" is a phone number ONLY if a phone number was actually spoken in the transcript. Otherwise leave it as an empty string. Never build a number from a name, a contact you think you know, or anything not said out loud. An empty "to" is the NORMAL and CORRECT case: the user picks the person on their own phone, so an empty recipient costs them one tap and a wrong one cannot be undone.
• send_text "body" is the message itself, written ready to send in the user's own voice, not a description of a message. Keep it to the length someone would actually type on a phone, and to what was actually promised.`;

export const EXTRACT_STABLE = `${V10_STABLE}${NEW_RULES}`;

export function extractSystem(name: string, role: string, memoryBlock = ""): string {
  return `${EXTRACT_STABLE}\n\n${extractVariable(name, role, memoryBlock)}`;
}

/** Schema widened for send_text. Cloned, never mutated: these objects are shared by every earlier
 *  version, and editing in place would retroactively change what v001 through v010 claim to have
 *  sent, on cards that already exist. */
const cloned = JSON.parse(JSON.stringify(V10_SCHEMA));
const cardItems = cloned?.properties?.cards?.items ?? cloned?.items;

if (cardItems?.properties?.action_type?.enum) {
  cardItems.properties.action_type.enum = [...cardItems.properties.action_type.enum, "send_text"];
}
if (Array.isArray(cardItems?.properties?.payload?.anyOf)) {
  // `to` is required but may be the empty string, exactly like create_task's `due`. Required-and-
  // emptyable is what forces the model to make a decision about the field rather than omitting it
  // and leaving us to guess whether it meant "no number" or "forgot".
  //
  // Distinguishable from the email payload despite sharing `to`: this one has no `subject`, and
  // both carry additionalProperties:false, so neither can validate as the other.
  cardItems.properties.payload.anyOf.push({
    type: "object",
    properties: {
      to: { type: "string", description: "phone number ONLY if one was spoken out loud, otherwise empty" },
      body: { type: "string", description: "the message itself, ready to send" },
    },
    required: ["to", "body"],
    additionalProperties: false,
  });
}

export const EXTRACT_SCHEMA = cloned;
