/** The prompt-injection defence, tested without a database or a model.
 *
 *  Every case below is either an attack this has to surface or a normal day it must not nag about.
 *  The second half matters as much as the first: a warning that fires on ordinary work gets learned
 *  away in a week and then protects nobody.
 */
import { recipientsOf, unexpectedRecipients, domainOf } from "./recipients";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "ok" : "FAIL"} · ${name}`);
  if (!ok) failures++;
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) console.log(`   got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  check(name, ok);
}

const SELF = "alex@acme.example";
const ROOM = ["dana@northwind.example", "marcus@northwind.example"];

console.log("\n--- which fields are even a destination ---");
eq("email to", recipientsOf("send_email", { to: "a@b.com" }), ["a@b.com"]);
eq("share_file emails", recipientsOf("share_file", { emails: "a@b.com, c@d.com" }), ["a@b.com", "c@d.com"]);
eq("document share_with", recipientsOf("create_document", { share_with: "a@b.com" }), ["a@b.com"]);
eq("calendar attendees", recipientsOf("create_calendar_event", { attendees: "a@b.com" }), ["a@b.com"]);
// A Slack channel is not an address: it is inside a workspace the user already controls, so
// flagging it would be noise on the one action type that posts internally by definition.
eq("a slack channel is not a recipient", recipientsOf("send_slack_message", { channel: "#product" }), []);
eq("a to-do sends to nobody", recipientsOf("create_todo", { title: "x" }), []);

console.log("\n--- the attacks ---");
// THE ONE THAT MATTERS. An injected line in a transcript reads as a normal commitment: its quote
// verifies (the text really is in the source) and attribution passes (it is phrased as the user's
// own promise). Neither existing defence catches it. Seeing the address does.
eq("a file shared with an outsider is surfaced",
  unexpectedRecipients({
    actionType: "share_file",
    payload: { emails: "billing@northwind-invoices.example", role: "reader" },
    selfEmail: SELF, attendeeEmails: ROOM,
  }),
  ["billing@northwind-invoices.example"]);
eq("an outsider hidden among expected people is still surfaced",
  unexpectedRecipients({
    actionType: "send_email",
    payload: { to: "dana@northwind.example, exfil@evil.test" },
    selfEmail: SELF, attendeeEmails: ROOM,
  }),
  ["exfil@evil.test"]);
eq("a free mail account is never treated as a colleague",
  unexpectedRecipients({
    actionType: "share_file",
    payload: { emails: "someone@gmail.com" },
    selfEmail: SELF, attendeeEmails: ROOM,
  }),
  ["someone@gmail.com"]);
// A personal-account user must not accidentally trust every other personal account.
eq("gmail user does not trust all of gmail",
  unexpectedRecipients({
    actionType: "send_email",
    payload: { to: "stranger@gmail.com" },
    selfEmail: "alex@gmail.com", attendeeEmails: [],
  }),
  ["stranger@gmail.com"]);

console.log("\n--- the ordinary days it must stay quiet on ---");
// Sending to the client who was on the call is MOST OF WORK. If this fires there, it gets ignored.
eq("someone who was in the room is expected",
  unexpectedRecipients({
    actionType: "send_email",
    payload: { to: "dana@northwind.example" },
    selfEmail: SELF, attendeeEmails: ROOM,
  }),
  []);
eq("a colleague on your own domain is expected",
  unexpectedRecipients({
    actionType: "share_file",
    payload: { emails: "lee@acme.example" },
    selfEmail: SELF, attendeeEmails: ROOM,
  }),
  []);
eq("yourself is expected",
  unexpectedRecipients({ actionType: "send_email", payload: { to: SELF }, selfEmail: SELF }),
  []);
eq("case and spacing do not create a false alarm",
  unexpectedRecipients({
    actionType: "send_email",
    payload: { to: "  DANA@Northwind.example  " },
    selfEmail: SELF, attendeeEmails: ROOM,
  }),
  []);
eq("the same outsider twice is reported once",
  unexpectedRecipients({
    actionType: "share_file",
    payload: { emails: "x@evil.test, x@evil.test" },
    selfEmail: SELF, attendeeEmails: ROOM,
  }),
  ["x@evil.test"]);
eq("no recipients, nothing to say",
  unexpectedRecipients({ actionType: "create_todo", payload: { title: "chase Samantha" }, selfEmail: SELF }),
  []);
// A user with no email on file must not have every recipient flagged: that is the noisy failure.
eq("an unknown self domain only trusts the room",
  unexpectedRecipients({
    actionType: "send_email",
    payload: { to: "dana@northwind.example" },
    selfEmail: "", attendeeEmails: ROOM,
  }),
  []);

console.log("\n--- helpers ---");
eq("domain", domainOf("a@b.co.uk"), "b.co.uk");
eq("no domain in garbage", domainOf("nope"), "");

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
