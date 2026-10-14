/** Tests for the rule that decides what may become a durable memory (lib/distill.ts).
 *
 *  The section that matters is the third one: a burst of decisions inside a SINGLE day must never
 *  qualify, however many there are. That is not a hypothetical. One afternoon of testing the
 *  dismiss flow produced a burst of real dismissals with real reasons. Counting events alone
 *  would learn a preference from an afternoon of QA, into a store that reaches every future
 *  extraction and briefing and persists until a human deletes it.
 *
 *  Pure: no database, no model, no clock. `npm test` */
import { buildPatterns, qualifying, editField, MIN_EVENTS, MIN_DAYS, MIN_SPAN_HOURS } from "./distill";
import type { FeedbackEvent } from "./distill";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, String(got) === String(want), `got ${got}, want ${want}`);

const IST = "Europe/Istanbul";
const LA = "America/Los_Angeles";

/** A dismissal at a fixed instant. */
function dismiss(day: string, reason: string, type = "create_calendar_event", title = "a card"): FeedbackEvent {
  return { kind: "card", actionType: type, decision: "dismissed", reason, editFields: [], title, at: new Date(day) };
}

console.log("\n--- editField ---");
eq("field before the colon", editField("channel: #general -> #product"), "channel");
eq("lowercased and trimmed", editField("  Channel : x"), "channel");
eq("no colon is no field", editField("just some prose"), "");
eq("a leading colon is no field", editField(":x"), "");

console.log("\n--- a genuine pattern across several days qualifies ---");
const spread: FeedbackEvent[] = [
  dismiss("2026-07-01T09:00:00Z", "not_mine", "create_calendar_event", "Book the platform sync"),
  dismiss("2026-07-03T09:00:00Z", "not_mine", "create_calendar_event", "Book the vendor call"),
  dismiss("2026-07-05T09:00:00Z", "not_mine"),
  dismiss("2026-07-08T09:00:00Z", "not_mine"),
];
const spreadPatterns = buildPatterns(spread, IST);
// Two patterns: the per-type pattern and its cross-type twin. Dismissals used to be keyed
// per action type only, which divided the taste-bearing half of the corpus across up to 25 keys so
// none of them ever reached the guard. Both are emitted, so a preference specific to one card type
// still surfaces on its own.
eq("a per-type pattern and a cross-type one", spreadPatterns.length, 2);
check("the per-type key is still there", spreadPatterns.some((p) => p.key === "dismiss:create_calendar_event:not_mine"));
check("and the cross-type key too", spreadPatterns.some((p) => p.key === "dismiss-any:not_mine"));
eq("counted every event", spreadPatterns[0].n, 4);
eq("counted four distinct days", spreadPatterns[0].days, 4);
eq("both qualify", qualifying(spreadPatterns).length, 2);
eq("and clears the span floor too, a week apart", spreadPatterns[0].spanHours >= MIN_SPAN_HOURS, true);
check(
  "carries at most two grounding examples",
  spreadPatterns[0].examples.length === 2,
  JSON.stringify(spreadPatterns[0].examples),
);

console.log("\n--- THE guard: a single day of testing must never teach anything ---");
// Eight dismissals, same reason, all inside one working day. This is the shape of that afternoon.
const oneDay: FeedbackEvent[] = Array.from({ length: 8 }, (_, i) =>
  dismiss(`2026-07-30T0${i}:30:00Z`, "wrong"),
);
const burst = buildPatterns(oneDay, IST);
eq("the pattern is counted", burst[0].n, 8);
eq("but it spans one day", burst[0].days, 1);
eq("so it does NOT qualify", qualifying(burst).length, 0);
check(
  "and events alone would have been more than enough",
  burst[0].n >= MIN_EVENTS,
  "proves the day count is what rejected it, not the volume",
);

console.log("\n--- the thresholds bite at the boundary ---");
const threeDays: FeedbackEvent[] = [
  dismiss("2026-07-01T09:00:00Z", "wrong"),
  dismiss("2026-07-02T09:00:00Z", "wrong"),
  dismiss("2026-07-03T09:00:00Z", "wrong"),
];
eq(`three events across three days is under MIN_EVENTS=${MIN_EVENTS}`, qualifying(buildPatterns(threeDays, IST)).length, 0);
const fourOverTwo: FeedbackEvent[] = [
  dismiss("2026-07-01T09:00:00Z", "wrong"),
  dismiss("2026-07-01T11:00:00Z", "wrong"),
  dismiss("2026-07-02T09:00:00Z", "wrong"),
  dismiss("2026-07-02T11:00:00Z", "wrong"),
];
eq(`four events across two days is under MIN_DAYS=${MIN_DAYS}`, qualifying(buildPatterns(fourOverTwo, IST)).length, 0);

console.log("\n--- days are the USER'S days, not the server's ---");
// 2026-07-02T04:00Z is the 2nd in Istanbul (07:00) and still the 1st in Los Angeles (21:00). The
// same two events are therefore two days apart for one user and one day for the other, and the
// whole guard turns on that number.
const straddle: FeedbackEvent[] = [
  dismiss("2026-07-01T20:00:00Z", "wrong"),
  dismiss("2026-07-02T04:00:00Z", "wrong"),
];
eq("two distinct days in Istanbul", buildPatterns(straddle, IST)[0].days, 2);
eq("one day in Los Angeles", buildPatterns(straddle, LA)[0].days, 1);

console.log("\n--- THE SPAN guard: touching three calendar dates is not the same as three days of use ---");
// dayKeyInTz buckets by LOCAL midnight, so a contiguous run that happens to straddle two local
// midnights (late one night, all through the next day, just after midnight the day after that)
// touches three calendar-date STRINGS while being about one day of continuous elapsed time. A true
// few-hour burst can never do this (two midnights are always ~24h apart in a fixed-offset zone), but
// this shape, roughly a day and unluckily positioned, both can and did (that incident was one bad
// afternoon; this is the same failure mode one clock-position away from where days=1 alone would
// have caught it). Elapsed time is what still catches it.
const straddlesMidnightTwice: FeedbackEvent[] = [
  dismiss("2026-07-20T20:00:00Z", "wrong"), // 23:00 Istanbul, day 1
  dismiss("2026-07-21T07:00:00Z", "wrong"), // 10:00 Istanbul, day 2
  dismiss("2026-07-21T17:00:00Z", "wrong"), // 20:00 Istanbul, day 2 (same day, adds no new bucket)
  dismiss("2026-07-21T22:00:00Z", "wrong"), // 01:00 Istanbul, day 3
];
const midnightBurst = buildPatterns(straddlesMidnightTwice, IST);
eq("four events", midnightBurst[0].n, 4);
eq("three distinct local days -- the OLD gate alone would have let this through", midnightBurst[0].days, 3);
check(
  "but only 26 elapsed hours, well under the 48h span floor",
  midnightBurst[0].spanHours < MIN_SPAN_HOURS,
  `spanHours was ${midnightBurst[0].spanHours}`,
);
eq("so it does NOT qualify, despite both n and days clearing their own floors", qualifying(midnightBurst).length, 0);

console.log("\n--- THE STARVATION this fixes: the same taste, split across card types ---");
{
  // Found on a real month of history: the only qualifying patterns were approvals. The model
  // wrote nothing from them and was right to, because approving what we proposed describes OUR
  // output and not the user's taste. Every dismissal, which is where taste actually lives, had
  // been divided across its own action type until nothing cleared the guard.
  const scattered: FeedbackEvent[] = [
    dismiss("2026-07-01T09:00:00Z", "not_mine", "create_todo", "Chase the invoice"),
    dismiss("2026-07-03T09:00:00Z", "not_mine", "send_email", "Reply to Dana"),
    dismiss("2026-07-05T09:00:00Z", "not_mine", "create_calendar_event", "Book the vendor call"),
    dismiss("2026-07-08T09:00:00Z", "not_mine", "send_slack_message", "Post the update"),
  ];
  const p = buildPatterns(scattered, IST);
  const perType = qualifying(p).filter((x) => x.key.startsWith("dismiss:"));
  const crossType = qualifying(p).filter((x) => x.key.startsWith("dismiss-any:"));
  eq("no single card type reaches the floor on its own", perType.length, 0);
  eq("but the preference does, across them", crossType.length, 1);
  eq("and it carries the full weight", crossType[0]?.n, 4);
  eq("across four distinct days", crossType[0]?.days, 4);
  // Four identical dismissals in four card types is exactly the shape that used to vanish. It is a
  // real instruction about attribution and the model never got to see it.
}

console.log("\n--- the span floor has its own boundary, independent of the day-count boundary ---");
const spanFloorEvents: FeedbackEvent[] = [
  dismiss("2026-07-01T00:00:00Z", "wrong"),
  dismiss("2026-07-02T00:00:00Z", "wrong"),
  dismiss("2026-07-02T12:00:00Z", "wrong"),
  dismiss("2026-07-03T00:00:00Z", "wrong"),
];
const atFloor = buildPatterns(spanFloorEvents, IST);
eq("exactly 48 hours apart", atFloor[0].spanHours, 48);
eq("the boundary is inclusive: exactly 48h qualifies", qualifying(atFloor).length, 2);
const oneMinuteShort: FeedbackEvent[] = [
  dismiss("2026-07-01T00:01:00Z", "wrong"), // one minute later than the case above; same end instant
  dismiss("2026-07-02T00:00:00Z", "wrong"),
  dismiss("2026-07-02T12:00:00Z", "wrong"),
  dismiss("2026-07-03T00:00:00Z", "wrong"),
];
const underFloor = buildPatterns(oneMinuteShort, IST);
eq("still three days and four events, nothing else changed", underFloor[0].days, 3);
check(
  "47h59m: one minute under the floor",
  underFloor[0].spanHours < MIN_SPAN_HOURS,
  `spanHours was ${underFloor[0].spanHours}`,
);
eq("a single minute is the difference between qualifying and not", qualifying(underFloor).length, 0);

console.log("\n--- 'later' is timing, not taste, and never becomes a pattern ---");
const laters: FeedbackEvent[] = [
  dismiss("2026-07-01T09:00:00Z", "later"),
  dismiss("2026-07-02T09:00:00Z", "later"),
  dismiss("2026-07-03T09:00:00Z", "later"),
  dismiss("2026-07-04T09:00:00Z", "later"),
  dismiss("2026-07-05T09:00:00Z", "later"),
];
eq("five deferrals produce no pattern at all", buildPatterns(laters, IST).length, 0);
// A dismissal with no chip is not evidence of anything either: it says the card was wrong without
// saying in what way, which is precisely the signal the reason chips exist to keep apart.
eq("a dismissal with no reason produces no pattern", buildPatterns([dismiss("2026-07-01T09:00:00Z", "")], IST).length, 0);

console.log("\n--- edits: the field is the signal ---");
const edits: FeedbackEvent[] = ["2026-07-01", "2026-07-03", "2026-07-05", "2026-07-07"].map((d) => ({
  kind: "card",
  actionType: "send_slack_message",
  decision: "edited",
  reason: "",
  editFields: ["channel: #general -> #product"],
  title: "Post the sprint summary",
  at: new Date(`${d}T09:00:00Z`),
}));
const editPatterns = buildPatterns(edits, IST);
const channel = editPatterns.find((p) => p.key === "edit:send_slack_message:channel");
check("the edited field becomes its own pattern", !!channel, JSON.stringify(editPatterns.map((p) => p.key)));
eq("counted across four days", channel?.days, 4);
check(
  "an edit also counts as an approval, because it is one",
  !!editPatterns.find((p) => p.key === "approve:send_slack_message"),
  JSON.stringify(editPatterns.map((p) => p.key)),
);

console.log("\n--- briefs ---");
const briefs: FeedbackEvent[] = ["2026-07-01", "2026-07-03", "2026-07-05", "2026-07-07"].map((d) => ({
  kind: "brief",
  actionType: "",
  decision: "down",
  reason: "too_long",
  editFields: [],
  title: "",
  at: new Date(`${d}T09:00:00Z`),
}));
eq("a repeated brief complaint qualifies", qualifying(buildPatterns(briefs, IST)).length, 1);

console.log("\n--- junk in never throws ---");
const junk: FeedbackEvent[] = [
  { kind: "card", actionType: "create_todo", decision: "dismissed", reason: "wrong", editFields: [], title: "", at: new Date("not a date") },
  { kind: "card", actionType: "create_todo", decision: "", reason: "", editFields: [], title: "", at: new Date("2026-07-01T09:00:00Z") },
];
eq("an unparseable timestamp is skipped, not fatal", buildPatterns(junk, IST).length, 0);
eq("empty input is empty output", buildPatterns([], IST).length, 0);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
