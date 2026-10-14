/** Tests for the practice card factory.
 *
 *  Pure function only: no database, no clock beyond what is passed in. Exists because the content
 *  here is exact copy shown on every brand-new user's very first swipe, so a rename or a typo here
 *  reaches all of them silently.
 *  `npm test -w @haii/server`
 */
import { buildPracticeCard } from "./practice";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, String(got) === String(want), `got ${got}, want ${want}`);

const NOW = new Date("2026-07-30T12:00:00.000Z");
const card = buildPracticeCard("u_test", "card_test1", NOW);

console.log("\n--- exact product-approved content, do not editorialize ---");
eq("action type", card.actionType, "create_todo");
eq("status", card.status, "proposed");
eq("title", card.title, "Give Haii a few minutes");
eq("priority", card.priority, "normal");
eq("confidence", card.confidence, 0.9);
eq(
  "summary",
  card.summary,
  "A practice card, so you can try the swipe. Nod right and it becomes a real to-do. Shake left and it goes away.",
);

console.log("\n--- the source chip must read Welcome, never a fake transcript name ---");
eq("source kind", card.sourceJson.kind, "welcome");
eq("source title", card.sourceJson.title, "Welcome");
eq("source when is the injected clock, not a real timestamp", card.sourceJson.when, NOW.toISOString());

console.log("\n--- no fabricated evidence: the caveat fills the slot instead ---");
eq("why is empty, never invented", card.context.why.length, 0);
eq("links", JSON.stringify(card.context.links), JSON.stringify(["Welcome to Haii"]));
eq(
  "caveat tells the truth about what has and hasn't happened yet",
  card.context.caveat,
  "Nothing has been read yet. Your first real card arrives when Haii reads a meeting: paste one in Setup, or connect Google.",
);

console.log("\n--- payload matches a real create_todo shape, so approval needs no executor change ---");
eq("payload title", card.payload.title, "Give Haii a few minutes");
eq("payload due", card.payload.due, "");
eq("payload notes", card.payload.notes, "");

console.log("\n--- what marks this as a tutorial, and only this ---");
eq("simulated", card.simulated, true);
eq("model", card.model, "practice");
eq("prompt version", card.promptVersion, "practice.v001");
eq("expires 7 days out, same TTL as a real card", card.expiresAt.getTime(), NOW.getTime() + 7 * 24 * 3600_000);

console.log("\n--- identity is passed in, not generated here: deterministic and testable ---");
eq("id", card.id, "card_test1");
eq("userId", card.userId, "u_test");
eq("schema version", card.schemaVersion, 1);
eq("type", card.type, "action");

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
