/** Memory retrieval, tested without a database or an API key. */
import { selectMemories, isSpecific, tokenise, isDuplicateFact, MEMORY_PROMPT_LIMIT } from "./memorySelect";

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

const m = (id: number, content: string) => ({ id, content });

console.log("\n--- specific versus standing ---");
check("a fact naming a person is specific", isSpecific("Alex asks Samantha before taking an integration."));
check("a standing preference names nobody", !isSpecific("Prefers usability over pixel-perfect UI."));
check("a leading capital is not a proper noun", !isSpecific("Prefers short meetings."));

console.log("\n--- tokenising ---");
check("drops filler", !tokenise("the and with that").size);
check("keeps the words a meeting is about", tokenise("Pricing review with Dana").has("pricing"));
check("drops short words", !tokenise("a to be").size);

console.log("\n--- selection ---");
// Under the limit, nothing is dropped and nothing is reordered: the cheap path must stay cheap.
const few = [m(1, "One."), m(2, "Two.")];
eq("under the limit everything passes through", selectMemories(few, { title: "anything" }).map((x) => x.id), [1, 2]);

const many = [
  m(1, "Prefers usability over pixel-perfect UI."),          // standing
  m(2, "Alex asks Samantha before taking an integration."),  // specific, Samantha
  m(3, "Evaluates mobile designs at 430px viewport width."), // standing-ish
  m(4, "Dana signs the Northwind contract."),                // specific, Dana
  m(5, "Adds test cases in Gherkin format."),                // standing
  m(6, "Priya owns the data pipeline."),                     // specific, Priya
  m(7, "Lena runs the security review."),                    // specific, Lena
  m(8, "Prefers product-led strategy."),                     // standing
];

const picked = selectMemories(many, { title: "Northwind pricing", attendees: ["Dana Reyes"] }, 4);
eq("limit is honoured", picked.length, 4);
check("the person in the room is kept", picked.some((x) => x.id === 4));
check("an unrelated person is dropped", !picked.some((x) => x.id === 7));
// THE RULE THAT MATTERS MOST. A standing preference can never match a keyword, so without its floor
// the selector would keep only facts about named people and drop every general rule about how this
// person works. That is the opposite of useful.
check("standing preferences survive even with no keyword match",
  picked.filter((x) => !isSpecific(x.content)).length >= 2);

// Newest-first is the incoming order and the only quality signal we have until per-fact outcomes
// exist, so it must survive scoring and slicing.
const order = selectMemories(many, { title: "Northwind pricing", attendees: ["Dana Reyes"] }, 5).map((x) => x.id);
eq("output stays in newest-first order", order, [...order].sort((a, b) => a - b));

// A meeting that matches nothing must still get a full, useful prompt rather than an empty one.
const blind = selectMemories(many, { title: "zzz qqq" }, 4);
eq("an unmatched meeting still gets a full set", blind.length, 4);

eq("the default limit is the documented one", MEMORY_PROMPT_LIMIT, 12);

console.log("\n--- duplicate guard, for the facts the model can no longer see ---");
// Retrieval means the model sees 12 of 40, so its own "do not add a near-duplicate" instruction can
// only police the slice it was shown. This guard sees the whole corpus.
check("a restatement is caught", isDuplicateFact(
  "Alex prefers usability over pixel-perfect UI design.",
  ["Alex prefers usability over pixel perfect UI."]));
check("an unrelated fact is not caught", !isDuplicateFact(
  "Priya owns the data pipeline.",
  ["Alex prefers usability over pixel perfect UI."]));
check("an empty corpus catches nothing", !isDuplicateFact("Anything at all here.", []));
check("an empty candidate is never a duplicate", !isDuplicateFact("", ["something real here"]));
// Different subjects must BOTH be keepable, or the guard would start discarding corrections, which
// are the most valuable thing memory holds.
check("a different fact about the same person survives", !isDuplicateFact(
  "Alex reviews mobile designs at 430px width.",
  ["Alex prefers product-led strategy over sales-led approaches."]));

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
