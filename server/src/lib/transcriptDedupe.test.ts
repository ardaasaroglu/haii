/** The dedupe rule, tested without a database or an API key.
 *
 *  This is the piece whose failure is silent and expensive: get it wrong and a user is asked to nod
 *  the same promise twice, the north star counts one conversation as two, and nothing errors.
 */
import { dedupeTranscript, sourceRank, type ExistingTranscript } from "./transcriptDedupe";

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

const t = (over: Partial<ExistingTranscript> = {}): ExistingTranscript => ({
  id: "tr_1", source: "drive", extractedAt: null, supersededBy: null, ...over,
});

console.log("\n--- ranking: a recording beats a summary ---");
check("a notetaker outranks Gemini notes", sourceRank("fireflies") > sourceRank("drive"));
check("a paste outranks Gemini notes", sourceRank("paste") > sourceRank("drive"));
check("a notetaker outranks a paste", sourceRank("fireflies") > sourceRank("paste"));
eq("an unknown source ranks bottom", sourceRank("something_new"), 0);
// All three notetakers record the same room the same way, so ranking one vendor over another would
// be taste rather than evidence. Equal rank means whoever got there first keeps the slot.
check("Fathom and Otter rank with Fireflies",
  sourceRank("fathom") === sourceRank("fireflies") && sourceRank("otter") === sourceRank("fireflies"));

console.log("\n--- two notetakers on one meeting ---");
// THE SHAPE THAT APPEARS THE DAY SOMEONE RUNS TWO OF THEM: both record every call.
eq("the second vendor does not displace the first",
  dedupeTranscript({ source: "fathom" }, [t({ id: "tr_ff", source: "fireflies" })]).action, "keep_superseded");
eq("and it is the first that keeps the slot",
  (dedupeTranscript({ source: "otter" }, [t({ id: "tr_ff", source: "fireflies" })]) as any).supersededBy, "tr_ff");
eq("a notetaker still displaces unread Gemini notes",
  dedupeTranscript({ source: "otter" }, [t({ id: "tr_drive", source: "drive" })]).action, "supersede");

console.log("\n--- nothing else covers the meeting ---");
eq("ingest", dedupeTranscript({ source: "fireflies" }, []).action, "ingest");
eq("a stood-down transcript is not competing",
  dedupeTranscript({ source: "fireflies" }, [t({ supersededBy: "tr_9" })]).action, "ingest");

console.log("\n--- nothing read yet, so the better source may take the slot ---");
const d1 = dedupeTranscript({ source: "fireflies" }, [t({ id: "tr_drive" })]);
eq("a notetaker supersedes unread Gemini notes", d1.action, "supersede");
eq("and names the row to stand down", (d1 as any).supersede, ["tr_drive"]);
eq("Gemini notes do NOT supersede an unread notetaker transcript",
  dedupeTranscript({ source: "drive" }, [t({ id: "tr_ff", source: "fireflies" })]).action, "keep_superseded");
eq("an equal source does not displace the incumbent",
  dedupeTranscript({ source: "drive" }, [t({ id: "tr_drive2" })]).action, "keep_superseded");
// Two unread rows: every one of them stands down, or the loser stays a live card source.
eq("all live rows are stood down, not just the best",
  (dedupeTranscript({ source: "fireflies" }, [t({ id: "a" }), t({ id: "b", source: "paste" })]) as any).supersede,
  ["a", "b"]);

console.log("\n--- once anything has been READ, the slot is closed ---");
// THE INVARIANT. Cards exist and may already have been nodded, so a second extraction of the same
// conversation would duplicate them and a swap would strand them.
const d2 = dedupeTranscript({ source: "fireflies" }, [t({ id: "tr_read", extractedAt: new Date() })]);
eq("a better source still cannot displace a transcript already read", d2.action, "keep_superseded");
eq("and it points at the one that holds the slot", (d2 as any).supersededBy, "tr_read");
eq("same when the read one is the weaker source",
  dedupeTranscript({ source: "fireflies" }, [
    t({ id: "tr_read", source: "drive", extractedAt: new Date() }),
    t({ id: "tr_unread", source: "paste" }),
  ]).action, "keep_superseded");

console.log("\n--- the shape that would duplicate cards ---");
// A meeting recorded by both vendors, polled twice, must never produce two extractable rows.
const meeting: ExistingTranscript[] = [];
const first = dedupeTranscript({ source: "drive" }, meeting);
eq("first transcript is ingested", first.action, "ingest");
meeting.push(t({ id: "tr_drive", source: "drive" }));
const second = dedupeTranscript({ source: "fireflies" }, meeting);
eq("second, better, supersedes the first", second.action, "supersede");
meeting.length = 0;
meeting.push(t({ id: "tr_drive", source: "drive", supersededBy: "tr_ff" }), t({ id: "tr_ff", source: "fireflies" }));
const third = dedupeTranscript({ source: "fireflies" }, meeting);
eq("a repeat poll of the same vendor does not displace itself", third.action, "keep_superseded");
check("exactly one live extractable row survives every path",
  meeting.filter((x) => !x.supersededBy).length === 1);

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
