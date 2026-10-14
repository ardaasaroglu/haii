/** Does `mergeCursor` actually merge, and does it actually leave the other job's keys alone?
 *
 *  Separate from `npm test` for the same reason snoozeCheck.ts is: that suite is pure and needs no
 *  database, and this cannot be. It exists because `mergeCursor` is a raw SQL jsonb `||`
 *  expression, which `tsc` type-checks as a string and therefore cannot verify at all. A typo in
 *  it compiles perfectly and then throws on every slack_listen run in production, four hours at a
 *  time, where the only symptom is a job_runs row nobody is reading. That is precisely the class of
 *  bug the house pattern exists to catch before it ships.
 *
 *  The scenario is the real one: slack_poll owns `slack` (per-channel marks), slack_listen owns
 *  `slack_search_ts`, both write the same jsonb column, and neither may clobber the other.
 *
 *  House pattern from CLAUDE.md: seed known rows, act, assert the deltas, clean up.
 *
 *  Run from server/, with the dev server STOPPED, or against a scratch database:
 *    DATA_DIR=.data-cursorcheck npx tsx src/tools/cursorCheck.ts
 */
import { and, eq } from "drizzle-orm";
import { db, schema, initDb } from "../db";
import { getCursor, mergeCursor, setCursor } from "../lib/connections";

const UID = "curschk_user";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}

async function cleanup() {
  await db
    .delete(schema.connections)
    .where(and(eq(schema.connections.userId, UID), eq(schema.connections.id, "slack")));
}

async function main() {
  await initDb();
  await cleanup(); // idempotent: a killed run must not poison the next one

  await db.insert(schema.connections).values({ userId: UID, id: "slack", status: "connected", cursor: {} });

  // slack_poll writes its per-channel marks.
  await setCursor(UID, "slack", { slack: { C1: "111.0001", C2: "222.0002" } });

  // slack_listen merges ITS key. The whole point: this must not be a read-modify-write.
  await mergeCursor(UID, "slack", { slack_search_ts: "333.0003" });

  const after = await getCursor<{ slack?: Record<string, string>; slack_search_ts?: string }>(UID, "slack");
  check("the merged key landed", after.slack_search_ts === "333.0003", `got ${after.slack_search_ts}`);
  check("the other job's marks survived", after.slack?.C1 === "111.0001" && after.slack?.C2 === "222.0002", JSON.stringify(after.slack));

  // Now the race this replaced. slack_poll advances a mark AFTER slack_listen read the cursor, and
  // slack_listen then writes. With a whole-object write the new mark is reverted; with a merge it
  // survives, which is the entire reason mergeCursor exists.
  const staleSnapshot = await getCursor<Record<string, unknown>>(UID, "slack");
  await setCursor(UID, "slack", { ...staleSnapshot, slack: { C1: "999.9999", C2: "222.0002" } });
  await mergeCursor(UID, "slack", { slack_search_ts: "444.0004" });

  const final = await getCursor<{ slack?: Record<string, string>; slack_search_ts?: string }>(UID, "slack");
  check("a concurrent mark advance is NOT reverted", final.slack?.C1 === "999.9999", `got ${final.slack?.C1}`);
  check("and the merged key still updated", final.slack_search_ts === "444.0004", `got ${final.slack_search_ts}`);

  // Merging a key that is already present must replace it, not nest or duplicate it.
  await mergeCursor(UID, "slack", { slack_search_ts: "555.0005" });
  const replaced = await getCursor<{ slack_search_ts?: string }>(UID, "slack");
  check("merging an existing key replaces it", replaced.slack_search_ts === "555.0005", `got ${replaced.slack_search_ts}`);

  await cleanup();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  await cleanup().catch(() => {});
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
