import { z } from "zod";

/**
 * The card contract: the action types, the payload shape for each, and the validator the server
 * runs on every drafted card (validateDraft).
 *
 * The list of action types is CLOSED. It started at five and grows by product decision, never by
 * refactor. The rule for adding one: an action type executes in proportion to whether the user
 * ALREADY has the destination connected. A calendar card lands for anyone with Google connected;
 * a Jira card lands only for someone who connected Jira. So the newer types are the ones whose
 * destination most users already hold: two ride Google Drive, one routes to a CRM the user
 * connects deliberately because it is where their pipeline lives, and send_text needs no
 * connection at all.
 */
/** The value every card carries in schema_version. Matches Card below. */
export const SCHEMA_VERSION = 1;

export const ActionType = z.enum([
  "create_calendar_event",
  "send_email",
  "create_todo",
  "send_slack_message",
  "create_jira_issue",
  "create_document",
  "share_file",
  "create_crm_note",
  "create_task",
  "send_text",
]);
export type ActionType = z.infer<typeof ActionType>;

export const CardStatus = z.enum([
  "proposed",
  "approved",
  "executing",
  "executed",
  "dismissed",
  "failed",
  "expired",
  /** Put off with Later. Not a decision about the card, so it never reaches Feedback. */
  "snoozed",
]);
export type CardStatus = z.infer<typeof CardStatus>;

export const Priority = z.enum(["high", "normal", "low"]);

/* ---------------- payloads (the editable part) ---------------- */

export const EmailPayload = z.object({
  to: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
});

/** date and time may be EMPTY, and that is the point of this shape.
 *
 *  They were both .min(1) once, which meant a meeting nobody put a clock time on could not become
 *  a calendar card at all: the draft failed validation, was discarded, and the model fell back to
 *  a to-do. To-dos piled up without executing, while calendar cards did execute. The commonest
 *  thing anyone says in a meeting is "let's sync next week", and that sentence could not produce
 *  the one card type that works.
 *
 *  It was also self-defeating: jobs/extract.ts runs findOpenSlot on every calendar card and
 *  OVERWRITES whatever time the model guessed with a real open slot from everyone's free/busy. So
 *  the rule demanded a value that was then thrown away, and killed the cards that could not invent
 *  one.
 *
 *  Empty means "no time was stated, propose one". The executor then finds the next open slot, so
 *  nothing reaches Google half-specified. */
export const CalendarPayload = z.object({
  title: z.string().min(1),
  date: z.string(),
  time: z.string(),
  duration_min: z.number().int().positive(),
  attendees: z.string(),
});

export const TodoPayload = z.object({
  title: z.string().min(1),
  due: z.string(),
  notes: z.string(),
});

/** `thread_ts` is optional and usually absent.
 *
 *  A reply is not a different ACT from a post, it is a post with a location, so this is a field
 *  rather than a ninth action type. It can only ever be filled for a card that came FROM Slack
 *  (jobs/slackListen), because that is the only path that knows a thread exists; a commitment made
 *  in a meeting has no thread to reply into. Empty means post normally. */
export const SlackPayload = z.object({
  channel: z.string().min(1),
  message: z.string().min(1),
  thread_ts: z.string().optional(),
});

export const JiraPayload = z.object({
  /** The project key that was said out loud, or EMPTY. Haii ships no default project: the executor
   *  falls back to JIRA_PROJECT, and when both are empty it fails the card with a sentence saying
   *  what to set, so an unnamed project must not drop the card here. */
  project: z.string(),
  issue_type: z.string().min(1),
  summary: z.string().min(1),
  description: z.string(),
  labels: z.string(),
});

/** A document Haii writes for you, in your own Drive.
 *
 *  `content` is markdown-ish plain text, because the executor writes it through the Docs API as a
 *  single insert and anything richer would be a formatting engine nobody asked for. `share_with` is
 *  optional and comma-separated: the commonest version of "send Dana the pricing" is one document
 *  and one reader, and splitting that into two cards would make the user nod twice for one promise. */
export const DocumentPayload = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  share_with: z.string(),
});

/** Give named people access to a file that already exists.
 *
 *  `file_name` rather than an id, because the model is reading a transcript where someone said "the
 *  proposal template", not a Drive file id. The executor resolves the name and REFUSES on an ambiguous
 *  match rather than guessing which file to hand out, which is the one mistake here that cannot be
 *  undone by the user. */
export const ShareFilePayload = z.object({
  file_name: z.string().min(1),
  emails: z.string().min(1),
  /** reader | commenter | writer. Defaults to reader at the executor, never above what was said. */
  role: z.string(),
});

/** A note logged against a person or company in the CRM.
 *
 *  Deliberately a NOTE and not a deal update or a stage change: a note is additive and reversible,
 *  and it is the thing people actually promise ("I'll log this"). Moving a deal stage from a
 *  transcript is a different risk class and is not in this type. */
export const CrmNotePayload = z.object({
  /** An email address or a company/person name. The executor resolves it and blocks if it cannot. */
  contact: z.string().min(1),
  note: z.string().min(1),
});

/** A ticket in the team's tracker.
 *
 *  NOT a to-do. That distinction is the whole reason this type exists rather than a routing
 *  setting: Haii is the one place a user's to-dos live, captured and tracked there or executed
 *  directly.
 *
 *  So a to-do stays a to-do and lives in Haii's own list, always, and is never scattered across
 *  other tools. `create_task` is for the DIFFERENT promise: "I'll raise a ticket for that", where
 *  the deliverable is an issue in the tracker where the team works. One is where you track your own
 *  commitments; the other is an artifact you owe a team.
 *
 *  `destination` is on the payload rather than in settings because it is a property of THIS promise.
 *  "Raise it in Linear" names the tracker out loud; a preference could not know that. It is also
 *  editable on the card, so a wrong guess is one tap to fix before it executes. */
export const TaskPayload = z.object({
  /** jira | linear | asana. The executor blocks on anything else, or on one not connected. */
  destination: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  /** YYYY-MM-DD or empty. Only Asana and Linear carry due dates; Jira ignores it. */
  due: z.string(),
});

/** A text message, composed by Haii and sent by the human from their own phone.
 *
 *  The tenth type. It is the only one with NO connector: nothing to OAuth, nothing to paste, no
 *  vendor. That is why it passes the rule that decides which types earn
 *  their place, that an action type executes in proportion to whether the user already holds the
 *  destination. Everyone holds a phone.
 *
 *  HOW IT WORKS, because it is the only type that does not execute server-side: approving builds an
 *  `sms:` URL and the CLIENT opens it inside the swipe's own gesture, which puts the finished message
 *  in the user's Messages app with the body prefilled. They press send. It goes from THEIR number, in
 *  the existing thread, blue bubbles where iMessage applies, which is the entire reason to text
 *  rather than email. Sending it through a vendor number would arrive from a stranger and destroy
 *  the reason for wanting it, as well as dragging TCPA and A2P 10DLC behind it.
 *
 *  `to` MAY BE EMPTY, and that is a feature rather than a gap. Verified on a real iPhone:
 *  `sms:&body=...` opens Messages with the To field empty and the message filled, so the user picks
 *  the person from their own address book. That means Haii never needs a phone number, needs no
 *  contacts scope, and CANNOT text the wrong person, which was the one failure here that is invisible
 *  to the user and impossible for them to undo. Requiring `to` would have re-introduced exactly the
 *  guessing that the CRM note type refuses. */
export const TextPayload = z.object({
  /** A phone number, or EMPTY when none is known. Never a guess from a partial name match. */
  to: z.string(),
  body: z.string().min(1),
});

export const PAYLOADS: Record<ActionType, z.ZodTypeAny> = {
  send_email: EmailPayload,
  create_calendar_event: CalendarPayload,
  create_todo: TodoPayload,
  send_slack_message: SlackPayload,
  create_jira_issue: JiraPayload,
  create_document: DocumentPayload,
  share_file: ShareFilePayload,
  create_crm_note: CrmNotePayload,
  create_task: TaskPayload,
  send_text: TextPayload,
};

export const Payload = z.union([
  EmailPayload,
  CalendarPayload,
  TodoPayload,
  SlackPayload,
  JiraPayload,
  DocumentPayload,
  ShareFilePayload,
  CrmNotePayload,
  TaskPayload,
  TextPayload,
]);

/* ---------------- context (why Haii proposed this) ---------------- */

export const Evidence = z.object({
  who: z.string(),
  t: z.string().optional(),
  text: z.string().min(1),
});

export const CardContext = z.object({
  why: z.array(Evidence).min(1),
  entities: z.array(z.string()),
  links: z.array(z.string()),
  caveat: z.string().optional(),
});

/* ---------------- feedback (the learning signal) ---------------- */

export const Feedback = z.object({
  decision: z.enum(["approved", "edited", "dismissed"]),
  edited_payload: z.record(z.string(), z.any()).nullable().optional(),
  edit_diff: z.array(z.string()).optional(),
  latency_ms: z.number().int().nonnegative().optional(),
  decided_at: z.string().optional(),
});
export type Feedback = z.infer<typeof Feedback>;

/* ---------------- the card ---------------- */

export const CardSource = z.object({
  kind: z.string(),
  title: z.string(),
  when: z.string().optional(),
});

export const Card = z.object({
  id: z.string().min(1),
  schema_version: z.literal(1),
  type: z.enum(["briefing", "action", "digest"]),
  action_type: ActionType,
  status: CardStatus,
  title: z.string().min(1),
  summary: z.string().min(1),
  confidence: z.number().min(0).max(1),
  priority: Priority,
  source: CardSource,
  payload: Payload,
  context: CardContext,
  feedback: Feedback.nullable().optional(),
  expires_at: z.string(),
  simulated: z.boolean(),
});
export type Card = z.infer<typeof Card>;

/** What extraction produces before the server assigns id/status/expiry. */
export const CardDraft = z.object({
  action_type: ActionType,
  title: z.string().min(1),
  summary: z.string().min(1),
  confidence: z.number().min(0).max(1),
  priority: Priority,
  payload: z.record(z.string(), z.any()),
  evidence: z.array(Evidence).min(1),
  entities: z.array(z.string()),
  links: z.array(z.string()).optional(),
  caveat: z.string().optional(),
});
export type CardDraft = z.infer<typeof CardDraft>;

/** Validate a draft's payload against its action_type-specific schema. */
export function validateDraft(draft: unknown):
  | { ok: true; draft: CardDraft }
  | { ok: false; error: string } {
  const base = CardDraft.safeParse(draft);
  if (!base.success) return { ok: false, error: base.error.issues[0]?.message ?? "invalid draft" };
  const payloadSchema = PAYLOADS[base.data.action_type];
  const payload = payloadSchema.safeParse(base.data.payload);
  if (!payload.success) {
    return {
      ok: false,
      error: `payload for ${base.data.action_type}: ${payload.error.issues[0]?.message}`,
    };
  }
  return { ok: true, draft: { ...base.data, payload: payload.data as Record<string, any> } };
}
