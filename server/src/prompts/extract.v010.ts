import { EXTRACT_SCHEMA as V9_SCHEMA, extractUser, EXTRACT_STABLE as V9_STABLE, extractVariable } from "./extract.v009";

export { extractUser, extractVariable };

export const EXTRACT_PROMPT_VERSION = "extract.v010";

// v010 (2026-08-09): create_task reaches the extractor, and Slack cards may carry a thread.
//
// A new file rather than an edit to v009, because promptVersion is stamped onto every card.
//
// THE DISTINCTION THIS PROMPT HAS TO TEACH, and it is the whole point of the type. Haii is the one
// place a user's to-dos live, captured and tracked there or executed directly, and it should still
// be able to file tasks in Jira, Linear or Asana.
//
// So a TO-DO is where the user tracks their own commitment, it lives in Haii, and it is never
// scattered into other tools. A TASK is a different promise: an artifact owed to a team, in the
// tracker that team works in. "I'll chase Samantha" is a to-do forever. "I'll raise a ticket for the
// webhook bug" is a task. The rules below draw exactly that line and nothing wider, because the
// failure mode here is the model deciding every to-do would be tidier as a ticket and quietly
// emptying the follow-ups list into Jira.
//
// The rules are appended to the STABLE half, which is where they belong: they name no user and are
// identical for everybody, so they stay inside the shared cached prefix (see v009).

const NEW_RULES = `
• create_task: use ONLY when the promise is to file an issue in a team tracker ("I'll raise a ticket", "I'll open a Linear issue", "put it in Jira"). "destination" is one of jira, linear or asana, taken from what was said out loud. If a tracker was not named, do not guess: this is a to-do instead.
• A to-do and a task are NOT interchangeable. A to-do is the user's own commitment, tracked in Haii. A task is an artifact a team is owed, in the team's tracker. "I'll chase Samantha" is a to-do. "I'll raise a ticket for the webhook bug" is a task. When in doubt it is a to-do, because that is the one the user can still route themselves.
• send_slack_message may carry "thread_ts" ONLY when the transcript you are reading is itself a Slack thread and the commitment was made in it. Leave it out entirely for anything said in a meeting.`;

export const EXTRACT_STABLE = `${V9_STABLE}${NEW_RULES}`;

export function extractSystem(name: string, role: string, memoryBlock = ""): string {
  return `${EXTRACT_STABLE}\n\n${extractVariable(name, role, memoryBlock)}`;
}

/** Schema widened for create_task and the optional thread_ts. Cloned, never mutated: these objects
 *  are shared by every earlier version, and editing in place would retroactively change what v001
 *  through v009 claim to have sent, on cards that already exist. */
const cloned = JSON.parse(JSON.stringify(V9_SCHEMA));
const cardItems = cloned?.properties?.cards?.items ?? cloned?.items;

if (cardItems?.properties?.action_type?.enum) {
  cardItems.properties.action_type.enum = [...cardItems.properties.action_type.enum, "create_task"];
}
if (Array.isArray(cardItems?.properties?.payload?.anyOf)) {
  cardItems.properties.payload.anyOf.push({
    type: "object",
    properties: {
      destination: { type: "string", enum: ["jira", "linear", "asana"] },
      title: { type: "string" },
      description: { type: "string" },
      due: { type: "string", description: "YYYY-MM-DD or empty" },
    },
    required: ["destination", "title", "description", "due"],
    additionalProperties: false,
  });
  // The Slack payload gains an optional thread_ts in place. Found by shape rather than index,
  // because an index would silently attach it to the wrong payload the next time one is inserted.
  const slack = cardItems.properties.payload.anyOf.find(
    (p: any) => p?.properties?.channel && p?.properties?.message,
  );
  if (slack) {
    slack.properties.thread_ts = { type: "string", description: "Slack thread ts, or empty" };
    slack.required = [...(slack.required ?? []), "thread_ts"];
  }
}

export const EXTRACT_SCHEMA = cloned;
