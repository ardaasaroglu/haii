/** CLI wrapper around lib/brainBackfill.ts.
 *
 *  The logic lives in the library so the same code path can also run from an admin endpoint. A run
 *  that hits the per-user daily cap partway through would otherwise produce nothing, so the library
 *  stops on purpose before the cap binds, curates what it has, and writes. Read the header there
 *  before changing anything about the cost shape.
 *
 *      npx tsx server/src/tools/backfillBrain.ts                 # dry run, every user
 *      npx tsx server/src/tools/backfillBrain.ts --apply         # writes
 *      npx tsx server/src/tools/backfillBrain.ts --user owner    # one user
 *      npx tsx server/src/tools/backfillBrain.ts --limit 20      # newest N transcripts per user
 *
 *  NOTE: --limit takes the NEWEST N, not the oldest. For memory the recent transcripts are the
 *  valuable ones, so a cheap probe should read them first.
 */
import { db, schema } from "../db";
import { backfillBrainForUser } from "../lib/brainBackfill";
import { BACKFILL_PROMPT_VERSION } from "../prompts/backfill.v001";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const argOf = (flag: string): string => {
  const i = args.indexOf(flag);
  return i >= 0 ? String(args[i + 1] ?? "") : "";
};
const ONLY_USER = argOf("--user");
const LIMIT = Number(argOf("--limit")) || 0;

async function run() {
  const users = await db.select().from(schema.users);
  const targets = ONLY_USER ? users.filter((u) => u.id === ONLY_USER) : users;
  if (!targets.length) {
    console.log(ONLY_USER ? `no user "${ONLY_USER}"` : "no users");
    return;
  }
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} · ${BACKFILL_PROMPT_VERSION} · ${targets.length} user(s)\n`);
  for (const u of targets) {
    const r = await backfillBrainForUser(u.id, {
      apply: APPLY,
      limit: LIMIT,
      onLine: (l) => console.log(l),
    });
    if (r.stoppedForBudget) {
      console.log(`  (stopped early on ${u.name || u.id}'s daily budget; run again tomorrow to go further)`);
    }
    console.log("");
  }
  console.log("done");
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
