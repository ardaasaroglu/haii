/** Tests for the north star and the numbers built on it.
 *
 *  These exist because earlier throwaway harnesses caught real bugs and were then deleted, so the
 *  next change started from nothing and could break the definitions silently. Every case below is
 *  a bug that actually happened or one that would have been caught.
 *
 *  Pure functions only: no database, no HTTP, no clock beyond what is passed in. Runs in a second.
 *  `npm test -w @haii/server`
 */
import { SQL } from "drizzle-orm";
import {
  classifyCard, isoWeek, quoteFidelity, normalizeForQuoteMatch,
  tallyCard, approvalRate, approvalSignal, emptyTally, LEAVES_HAII, notSimulated,
  quoteVerdict,
} from "./metrics";
import { cleanTranscript } from "./transcript";
// The schema is the source of truth for which types exist; importing it is what makes the coverage
// check below fail the day someone adds a new one without a verdict.
import { ActionType } from "@haii/schema";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, String(got) === String(want), `got ${got}, want ${want}`);

const card = (status: string, actionType: string, mode?: string, decision = "approved") => ({
  status,
  actionType,
  feedback: mode ? { decision, executed: { mode } } : { decision },
});

console.log("\n--- notSimulated: the predicate every metric query must AND in ---");
{
  check("exported, and a real SQL predicate rather than a stray boolean", notSimulated instanceof SQL);
  // Reaches into drizzle's query-chunk internals on purpose. Existence alone would not catch
  // someone pointing this at the wrong column or flipping the boolean, which is exactly the
  // silent-regression class this file exists to catch (see the file header).
  const chunks = (notSimulated as unknown as { queryChunks: any[] }).queryChunks;
  const col = chunks?.[1];
  eq("targets the simulated column", col?.name, "simulated");
  eq("on the cards table", col?.table?.[Symbol.for("drizzle:Name")], "cards");
  const param = chunks?.[3];
  eq("compares against false, i.e. excludes simulated rows", param?.value, false);
}

console.log("\n--- what counts as executed: it left Haii ---");
eq("slack posted", classifyCard(card("executed", "send_slack_message", "real")), "executed");
eq("jira issue created", classifyCard(card("executed", "create_jira_issue", "real")), "executed");
eq("calendar event created", classifyCard(card("executed", "create_calendar_event", "real")), "executed");

console.log("\n--- the inflation this definition exists to stop ---");
eq("todo is captured, not executed", classifyCard(card("executed", "create_todo", "real")), "captured");
// This asserted "captured" for as long as an email card wrote a to-do about an email; it now
// writes a real Gmail draft, which is an artifact created outside Haii. The flip also corrected a
// wrong description of this table: create_calendar_event is executed regardless of attendees, so
// "somewhere another person can see" was never the rule.
eq("a gmail draft is executed, the work is done not remembered", classifyCard(card("executed", "send_email", "real")), "executed");
eq("blocked slack card", classifyCard(card("executed", "send_slack_message", "blocked")), "blocked");
eq("blocked beats the action type", classifyCard(card("executed", "create_calendar_event", "blocked")), "blocked");
eq("execution threw", classifyCard(card("failed", "send_slack_message", "real")), "failed");

console.log("\n--- states that are not yet an outcome ---");
eq("on the deck", classifyCard(card("proposed", "send_slack_message")), "pending");
eq("inside the 5s undo grace", classifyCard(card("approved", "send_slack_message")), "pending");
eq("mid-flight", classifyCard(card("executing", "send_slack_message")), "pending");
eq("shaken off", classifyCard(card("dismissed", "send_slack_message", undefined, "dismissed")), "dismissed");
eq("died undecided", classifyCard(card("expired", "send_slack_message")), "expired");

console.log("\n--- the table IS the definition: one entry, no code edit ---");
{
  // Was written against send_email and hardcoded "captured" as today's answer, so it broke the
  // moment a Gmail draft became an execution. Worse, it restored the entry to the LITERAL
  // false rather than to whatever it had been, which silently rewrites the definition for anything
  // running after it. Direction-agnostic now, and on create_todo, whose answer is not in flight.
  const was = LEAVES_HAII.create_todo;
  const before = classifyCard(card("executed", "create_todo", "real"));
  LEAVES_HAII.create_todo = true;
  const after = classifyCard(card("executed", "create_todo", "real"));
  LEAVES_HAII.create_todo = was;
  eq("captured while the table says false", before, "captured");
  eq("executed the moment the table says true", after, "executed");
  eq("restored to what it was, not to a literal", LEAVES_HAII.create_todo, String(was));
}

console.log("\n--- tally: THE regression. A shake must count once, not twice ---");
{
  const t = emptyTally();
  tallyCard(t, card("dismissed", "send_slack_message", undefined, "dismissed"));
  eq("dismissed counted once", t.dismissed, 1);
  eq("decided counted once", t.decided, 1);
  eq("no execution outcome", t.executed + t.captured + t.blocked + t.failed, 0);
}
{
  // A mixed week: 3 approved, 2 edited, 8 shaken.
  const t = emptyTally();
  for (let i = 0; i < 3; i++) tallyCard(t, card("executed", "send_slack_message", "real"));
  for (let i = 0; i < 2; i++) tallyCard(t, card("executed", "create_todo", "real", "edited"));
  for (let i = 0; i < 8; i++) tallyCard(t, card("dismissed", "send_slack_message", undefined, "dismissed"));
  eq("decided", t.decided, 13);
  eq("dismissed not doubled", t.dismissed, 8);
  eq("approved", t.approved, 3);
  eq("edited", t.edited, 2);
  eq("executed", t.executed, 3);
  eq("captured", t.captured, 2);
  // The bug reported 0.238 here by inflating the denominator to 21.
  eq("approval rate is the real one", approvalRate(t), 0.385);
}
{
  const t = emptyTally();
  tallyCard(t, card("proposed", "send_slack_message"));
  eq("pending touches nothing", t.decided + t.dismissed + t.expired, 0);
  tallyCard(t, card("expired", "send_slack_message"));
  eq("expired is not a decision", t.decided, 0);
  eq("expired counted", t.expired, 1);
}
eq("empty tally has no rate, not 100%", approvalRate(emptyTally()), null);

console.log("\n--- ISO weeks, including the year boundary ---");
eq("Tue 2026-07-28", isoWeek("2026-07-28"), "2026-W31");
eq("the Sunday before", isoWeek("2026-07-26"), "2026-W30");
eq("that Monday", isoWeek("2026-07-27"), "2026-W31");
// 2026-01-01 is a Thursday, and ISO W01 is the week holding the year's first Thursday.
eq("Thu 2026-01-01 stays in 2026", isoWeek("2026-01-01"), "2026-W01");
// 2027-01-01 is a Friday; that week's Thursday is 2026-12-31, so the week belongs to 2026.
eq("Fri 2027-01-01 rolls back", isoWeek("2027-01-01"), "2026-W53");
eq("Mon 2027-01-04", isoWeek("2027-01-04"), "2027-W01");

console.log("\n--- evidence fidelity: exact after normalising, never fuzzy ---");
{
  const quote = "Alex committed to sending Omar the corrected fee calculation before Friday";
  const transcript = `# Notes by Gemini\n\n**Alex:** ok so ${quote}, and Omar asked for it in writing.`;
  eq("real quote found", quoteFidelity([quote], transcript).found, 1);
  eq("markdown around it still found", quoteFidelity([`**${quote}**`], transcript).found, 1);
  eq("smart quotes normalised", normalizeForQuoteMatch("it’s “here”"), `it's "here"`);
  eq("invented quote is a miss", quoteFidelity(["Alex promised to rewrite billing by Tuesday"], transcript).found, 0);
  eq("short fragment not counted at all", quoteFidelity(["ok so"], transcript).checked, 0);
  // Near-enough matching is how a quote drifts far enough to change meaning while still scoring.
  eq("a changed word is a miss", quoteFidelity([quote.replace("before", "after")], transcript).found, 0);
}

console.log("\n--- what counts toward a card type's approval rate ---");
// The bug: the dismiss chips are Wrong / Not mine / Later, and all three were scored the same.
// "Later" means the card was RIGHT and the timing was not, so counting it against the type
// pushed that type toward suppression: telling Haii "right card, wrong week" taught it to stop
// proposing that kind of card entirely.
eq("approved", approvalSignal({ decision: "approved" }), "approved");
eq("edited still counts as approval", approvalSignal({ decision: "edited" }), "approved");
eq("dismissed as Wrong is disapproval", approvalSignal({ decision: "dismissed", reason: "wrong" }), "disapproved");
eq("dismissed as Not mine is disapproval", approvalSignal({ decision: "dismissed", reason: "not_mine" }), "disapproved");
eq("dismissed with no reason is disapproval", approvalSignal({ decision: "dismissed" }), "disapproved");
eq("LATER is neither", approvalSignal({ decision: "dismissed", reason: "later" }), "ignore");
// Neutral, not positive: a deferral says the proposal was legitimate, not that the user wants the
// action. Counting it as approval would be the same mistake pointing the other way.
check("later is not counted as approval", approvalSignal({ decision: "dismissed", reason: "later" }) !== "approved");
eq("no feedback at all", approvalSignal(null), "ignore");
eq("feedback with no decision", approvalSignal({ reason: "later" }), "ignore");
eq("undefined", approvalSignal(undefined), "ignore");

console.log("\n--- a deferral must not land in the weekly tally's dismissed counter ---");
// approvalRate divides by approved + edited + dismissed, so a deferral counted as dismissed drags
// the reported rate down for a card the user actually wanted.
const deferredTally = emptyTally();
tallyCard(deferredTally, { status: "dismissed", actionType: "create_calendar_event", feedback: { decision: "dismissed", reason: "later" } });
eq("deferral is not counted as dismissed", deferredTally.dismissed, 0);
const rejectedTally = emptyTally();
tallyCard(rejectedTally, { status: "dismissed", actionType: "create_calendar_event", feedback: { decision: "dismissed", reason: "wrong" } });
eq("a real rejection still is", rejectedTally.dismissed, 1);
// One approval and one deferral must read as 100%, not 50%.
const mixed = emptyTally();
tallyCard(mixed, { status: "executed", actionType: "send_slack_message", feedback: { decision: "approved" } });
tallyCard(mixed, { status: "dismissed", actionType: "send_slack_message", feedback: { decision: "dismissed", reason: "later" } });
eq("approval rate ignores the deferral", approvalRate(mixed), 1);

console.log("\n--- fidelity must grade the model on the text it was GIVEN ---");
// A real Gemini transcript puts a bare timestamp on its own line mid-turn. cleanTranscript deletes
// that line before extraction reads it, so the two halves of the sentence become adjacent for the
// model and are not adjacent in the raw file. A quote spanning it is verbatim in what the model
// read and absent from what we used to check against.
const rawWithStamp = "Maya Chen: I'll own the pricing doc\n00:14:31\nand send Dana a draft Friday.";
const spanning = "I'll own the pricing doc and send Dana a draft Friday.";
eq("the quote is NOT in the raw file, which is what made it look invented",
  quoteFidelity([spanning], rawWithStamp).found, 0);
eq("the same quote IS in the text the model was handed",
  quoteFidelity([spanning], cleanTranscript(rawWithStamp)).found, 1);
check("both were counted, so this is a miss becoming a hit and not a skipped check",
  quoteFidelity([spanning], rawWithStamp).checked === 1 && quoteFidelity([spanning], cleanTranscript(rawWithStamp)).checked === 1);
// The guard against the opposite error: cleaning must not turn a genuinely invented quote into a
// pass. Nothing about stripping timestamps can conjure words that were never said.
eq("an invented quote is still a miss against the cleaned text",
  quoteFidelity(["I'll have it done by Tuesday morning."], cleanTranscript(rawWithStamp)).found, 0);

console.log("\n--- the evidence guard: strip the quote, keep the card ---");
const src = "Alex: I'll own the pricing doc and send Dana a draft on Friday. Dana: perfect, thanks.";
const good = "I'll own the pricing doc and send Dana a draft on Friday.";
const invented = "I'll have the whole thing finished by Tuesday.";
// jobs/extract.ts keeps every quote that is not `missing`, and drops the card only when none are.
const keep = (quotes: string[]) => quotes.filter((q) => quoteVerdict(q, src) !== "missing");
eq("a verbatim quote survives", keep([good]).length, 1);
eq("an invented quote is stripped", keep([invented]).length, 0);
// THE case this rule exists for. The card-level version of this guard would have thrown the whole
// card away, and with it an action that was correct. Extraction works; provenance must not be paid
// for with it.
const mixedKept = keep([good, invented]);
eq("a mixed card keeps its good quote", mixedKept.length, 1);
eq("and the surviving quote is the verbatim one", mixedKept[0], good);
// Unverifiable is not the same as false. A card is never killed on evidence nobody could judge.
eq("a fragment too short to verify is kept, not stripped", keep(["thanks"]).length, 1);
eq("verdicts are three-valued", [quoteVerdict(good, src), quoteVerdict(invented, src), quoteVerdict("ok", src)].join(","),
  "found,missing,unverifiable");
// The card only dies when nothing is left, because evidence.min(1) is the promise a card makes.
check("a card whose every quote is invented is left with none, so it dies",
  keep([invented, "None of this was ever said."]).length === 0);

console.log("\n--- every action type has a verdict, so none can be silently 'captured' ---");
// THE REGRESSION THIS EXISTS FOR. Four action types once shipped without entries here.
// A missing key reads as `false`, so every document, share, CRM note and ticket was classified as
// CAPTURED, meaning the work never left Haii. The north star silently undercounted the four newest
// ways the product does something, and nothing failed. Adding a type without a verdict is now a
// test failure rather than a quiet wrong number.
for (const t of ActionType.options) {
  check(`${t} declares whether it leaves Haii`, Object.prototype.hasOwnProperty.call(LEAVES_HAII, t));
}
// The one type that must stay false, so a future "make the number bigger" edit has to argue with a
// test rather than a comment.
check("a to-do still does not leave Haii", LEAVES_HAII.create_todo === false);

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
