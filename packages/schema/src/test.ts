import { Card, validateDraft } from "./index";

let failures = 0;
function check(name: string, pass: boolean) {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}`);
  if (!pass) failures++;
}

const sampleCard = {
  id: "card_test1",
  schema_version: 1,
  type: "action",
  action_type: "send_email",
  status: "proposed",
  title: "Lock the Northwind launch window",
  summary: "Email the integration team about a cert slot this week.",
  confidence: 0.86,
  priority: "high",
  source: { kind: "meeting", title: "Weekly planning", when: "yesterday 16:30" },
  payload: { to: "partners@northwind.example", subject: "Launch window?", body: "Hi team, ..." },
  context: {
    why: [{ who: "Alex", t: "00:14:22", text: "I'll email their integration team." }],
    entities: ["Northwind"],
    links: ["Transcript 00:14"],
  },
  feedback: null,
  expires_at: new Date().toISOString(),
  simulated: false,
};

check("valid card parses", Card.safeParse(sampleCard).success);
check(
  "invalid payload fails (email without body)",
  !Card.safeParse({ ...sampleCard, payload: { to: "a@b.c", subject: "x" } }).success,
);
check(
  "unknown action_type fails",
  !Card.safeParse({ ...sampleCard, action_type: "send_fax" }).success,
);

const draftOk = validateDraft({
  action_type: "create_todo",
  title: "Review the pricing draft",
  summary: "Omar's draft landed.",
  confidence: 0.9,
  priority: "high",
  payload: { title: "Review draft", due: "Tomorrow", notes: "" },
  evidence: [{ who: "Dana", text: "Lock the draft Friday." }],
  entities: ["Northwind"],
});
check("valid draft passes payload check", draftOk.ok);

const draftBad = validateDraft({
  action_type: "create_jira_issue",
  title: "Spike",
  summary: "Spike webhooks.",
  confidence: 0.7,
  priority: "normal",
  payload: { project: "ENG" },
  evidence: [{ who: "Dana", text: "Spike it." }],
  entities: [],
});
check("draft with incomplete jira payload fails", !draftBad.ok);

// project may be EMPTY when nobody named one out loud. The executor resolves it from JIRA_PROJECT,
// so the card must survive validation rather than be dropped here.
check("a jira draft with no project named still passes", validateDraft({
  action_type: "create_jira_issue",
  title: "File the webhook bug",
  summary: "x",
  confidence: 0.8,
  priority: "normal",
  payload: { project: "", issue_type: "Task", summary: "Webhook retries drop events", description: "", labels: "" },
  evidence: [{ who: "Alex", text: "I'll put it in Jira." }],
  entities: [],
}).ok);

/* ---------------- the types added after the first five ---------------- */

check("a document draft passes", validateDraft({
  action_type: "create_document",
  title: "Write up the pricing",
  summary: "Promised to Dana.",
  confidence: 0.8,
  priority: "normal",
  payload: { title: "Tiered pricing", content: "Here is the pricing.", share_with: "dana@northwind.example" },
  evidence: [{ who: "Alex", text: "I'll write up the pricing." }],
  entities: [],
}).ok);

// share_with is REQUIRED but may be EMPTY. A document written only for yourself is the common case,
// and making the field optional instead would let the model omit it and the executor read undefined.
check("a document with nobody to share it with still passes", validateDraft({
  action_type: "create_document",
  title: "Notes",
  summary: "Just for me.",
  confidence: 0.8,
  priority: "low",
  payload: { title: "Notes", content: "Some notes.", share_with: "" },
  evidence: [{ who: "Alex", text: "I'll write that up." }],
  entities: [],
}).ok);

check("a document with no content fails", !validateDraft({
  action_type: "create_document",
  title: "Empty",
  summary: "x",
  confidence: 0.5,
  priority: "low",
  payload: { title: "Empty", content: "", share_with: "" },
  evidence: [{ who: "Alex", text: "I'll write it." }],
  entities: [],
}).ok);

check("a share draft passes", validateDraft({
  action_type: "share_file",
  title: "Send the deck",
  summary: "Promised in the room.",
  confidence: 0.9,
  priority: "high",
  payload: { file_name: "Q3 roadmap deck", emails: "dana@northwind.example", role: "reader" },
  evidence: [{ who: "Alex", text: "I'll send you the deck." }],
  entities: [],
}).ok);

// Sharing with nobody is not a weaker share, it is a no-op that would execute and report success
// having done nothing at all.
check("sharing with nobody fails", !validateDraft({
  action_type: "share_file",
  title: "Send it",
  summary: "x",
  confidence: 0.5,
  priority: "low",
  payload: { file_name: "deck", emails: "", role: "reader" },
  evidence: [{ who: "Alex", text: "I'll send it." }],
  entities: [],
}).ok);

check("a crm note draft passes", validateDraft({
  action_type: "create_crm_note",
  title: "Log the call",
  summary: "Promised to log it.",
  confidence: 0.8,
  priority: "normal",
  payload: { contact: "dana@northwind.example", note: "Wants tiered pricing before Friday." },
  evidence: [{ who: "Alex", text: "I'll log this against their record." }],
  entities: [],
}).ok);

check("a crm note with no contact fails", !validateDraft({
  action_type: "create_crm_note",
  title: "Log it",
  summary: "x",
  confidence: 0.5,
  priority: "low",
  payload: { contact: "", note: "something" },
  evidence: [{ who: "Alex", text: "I'll log it." }],
  entities: [],
}).ok);

check("a task draft passes", validateDraft({
  action_type: "create_task",
  title: "Raise the webhook ticket",
  summary: "Promised to the team.",
  confidence: 0.85,
  priority: "normal",
  payload: { destination: "linear", title: "Webhook retries drop events", description: "From the standup.", due: "" },
  evidence: [{ who: "Alex", text: "I'll raise a ticket for it." }],
  entities: [],
}).ok);

// A task with no destination is not a weaker task, it is a to-do. The executor would have nowhere
// to file it, so the validator refuses rather than letting it reach a card that can only block.
check("a task with no destination fails", !validateDraft({
  action_type: "create_task",
  title: "Raise a ticket",
  summary: "x",
  confidence: 0.5,
  priority: "low",
  payload: { destination: "", title: "Something", description: "", due: "" },
  evidence: [{ who: "Alex", text: "I'll raise a ticket." }],
  entities: [],
}).ok);

// thread_ts is OPTIONAL, and the ordinary case is a meeting commitment that has no thread at all.
check("a slack card without a thread still passes", validateDraft({
  action_type: "send_slack_message",
  title: "Post the summary",
  summary: "x",
  confidence: 0.8,
  priority: "normal",
  payload: { channel: "#product", message: "Summary below." },
  evidence: [{ who: "Alex", text: "I'll post a summary." }],
  entities: [],
}).ok);

check("a slack card with a thread passes", validateDraft({
  action_type: "send_slack_message",
  title: "Reply in thread",
  summary: "x",
  confidence: 0.8,
  priority: "normal",
  payload: { channel: "#product", message: "Answering here.", thread_ts: "1723200000.001" },
  evidence: [{ who: "Alex", text: "I'll reply in the thread." }],
  entities: [],
}).ok);

// The list is CLOSED. An invented type must not validate.
check("an invented type still fails",
  !Card.safeParse({ ...sampleCard, action_type: "create_notion_page" }).success);

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nschema: all checks pass");
