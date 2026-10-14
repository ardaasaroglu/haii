/** Build a user's long-term memory from the transcripts we already read.
 *
 *  WHY THIS IS A LIBRARY AND NOT JUST A SCRIPT: the CLI version had never once
 *  completed. It ran in a hosting console, hit the per-user daily cap partway through the map
 *  pass, and then produced NOTHING, because once the cap binds every remaining llmJson call fails
 *  and the reduce pass at the end fails with them. Money was spent and the corpus stayed empty. It
 *  read as "the backfill is slow" when what it actually was is "the backfill cannot survive its own
 *  budget".
 *
 *  Two changes make it finishable without raising a single cap:
 *
 *  • IT STOPS ON PURPOSE. Before every map call it checks the user's spend against their own daily
 *    hard cap, keeping a reserve for the reduce. When the reserve is all that is left it stops
 *    mapping, reduces what it has, and WRITES. A partial corpus that exists beats a perfect one
 *    that does not. Run it again tomorrow and it goes further.
 *  • IT READS THE NEWEST FIRST. The old `--limit` sliced the OLDEST transcripts, which for memory
 *    is exactly backwards: the durable facts about how someone works are in what they did recently.
 *    Selection is newest-N, then the batch is processed oldest-first, because the reduce prompt
 *    relies on candidate order to resolve contradictions toward the most recent.
 *
 *  MAP then REDUCE, unchanged and still forced by MEMORY_LIMIT rather than chosen: the cap is 40
 *  per user and a straight pass would mint hundreds of facts and keep whichever forty came last.
 *
 *  DRY RUN BY DEFAULT everywhere it is exposed. This writes to the long-term memory of real people
 *  and those lines are then read before every brief and every extraction.
 */
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { db, schema } from "../db";
import { llmJson, MODELS, userSpendToday } from "./llm";
import { cleanTranscript } from "./transcript";
import { listMemories, formatMemories, MEMORY_LIMIT } from "./memory";
import { env } from "../env";
import { log } from "../log";
import {
  BACKFILL_PROMPT_VERSION,
  MAP_SCHEMA,
  REDUCE_SCHEMA,
  mapSystem,
  mapUser,
  reduceSystem,
  reduceUser,
} from "../prompts/backfill.v001";

/** Transcripts are capped the same way extraction caps them. */
const MAX_CHARS = 40_000;

/** Left unspent for the reduce pass, which runs on the deep model and is the ONLY call whose
 *  failure loses the whole run. Generous on purpose: mapping one more transcript is worth far less
 *  than reducing the ones already mapped. */
const REDUCE_RESERVE_USD = 0.3;

export interface BackfillOptions {
  /** Write. Without it nothing touches the memories table. */
  apply?: boolean;
  /** Read at most this many transcripts, NEWEST first. 0 means as many as the budget allows. */
  limit?: number;
  /** Called with each line of progress, so a CLI can print and a job can log. */
  onLine?: (line: string) => void;
}

export interface BackfillResult {
  userId: string;
  name: string;
  transcriptsAvailable: number;
  mapped: number;
  skipped: number;
  candidates: number;
  memories: string[];
  written: boolean;
  /** Set when the run stopped early because the user's daily budget was nearly spent. */
  stoppedForBudget: boolean;
  spendBefore: number;
  spendAfter: number;
}

export async function backfillBrainForUser(userId: string, opts: BackfillOptions = {}): Promise<BackfillResult> {
  const say = opts.onLine ?? (() => {});
  const urows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  const u = urows[0];
  if (!u) throw new Error(`no user "${userId}"`);
  const name = u.name || u.id;

  // Newest first for SELECTION, because recent behaviour is what memory is for...
  // Slack transcripts carry other people's messages as background, so memory is never built from
  // them (the same rule as applyExtractResult in jobs/extract.ts).
  const newest = await db
    .select()
    .from(schema.transcripts)
    .where(and(eq(schema.transcripts.userId, userId), ne(schema.transcripts.source, "slack")))
    .orderBy(desc(schema.transcripts.ingestedAt))
    .limit(opts.limit && opts.limit > 0 ? opts.limit : 1000);
  // ...then oldest first for PROCESSING, because the reduce prompt resolves contradictions toward
  // whatever it sees last. Getting this backwards would make the corpus prefer stale facts.
  const transcripts = [...newest].reverse();

  const spendBefore = await userSpendToday(userId);
  const cap = env.USER_DAILY_HARD_USD;
  const result: BackfillResult = {
    userId, name,
    transcriptsAvailable: newest.length,
    mapped: 0, skipped: 0, candidates: 0, memories: [],
    written: false, stoppedForBudget: false,
    spendBefore, spendAfter: spendBefore,
  };
  if (!transcripts.length) {
    say(`• ${name}: no transcripts, skipped`);
    return result;
  }
  say(`• ${name}: ${transcripts.length} transcripts, $${spendBefore.toFixed(2)} of $${cap.toFixed(2)} spent today`);

  const candidates: string[] = [];
  for (const tr of transcripts) {
    // THE GUARD THAT MAKES THIS FINISHABLE. Checked before the call, never after: discovering the
    // cap by being refused is how the previous version lost everything it had already paid for.
    const spend = await userSpendToday(userId);
    if (spend >= cap - REDUCE_RESERVE_USD) {
      result.stoppedForBudget = true;
      say(`  · budget reserve reached at $${spend.toFixed(2)}, stopping the read and curating what is in hand`);
      break;
    }
    const cleaned = cleanTranscript(tr.contentMd).slice(0, MAX_CHARS);
    if (cleaned.trim().length < 200) {
      result.skipped++;
      continue;
    }
    try {
      const res = await llmJson({
        userId,
        job: "backfill_brain",
        model: MODELS.cheap,
        system: mapSystem(name),
        user: mapUser({
          selfName: name,
          title: tr.title,
          when: tr.ingestedAt.toISOString().slice(0, 10),
          transcript: cleaned,
        }),
        jsonSchema: MAP_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 700,
        reasoning: "off",
      });
      if (!res.ok) {
        say(`  ! ${tr.title.slice(0, 50)}: ${res.reason ?? "no result"}`);
        result.skipped++;
        continue;
      }
      const facts: Array<{ kind: string; fact: string }> = (res.data as any)?.facts ?? [];
      for (const f of facts) {
        const text = String(f?.fact ?? "").trim();
        if (text.length > 8) candidates.push(`[${f.kind}] ${text}`);
      }
      result.mapped++;
    } catch (e: any) {
      say(`  ! ${tr.title.slice(0, 50)}: ${String(e?.message ?? e).slice(0, 120)}`);
      result.skipped++;
    }
  }

  result.candidates = candidates.length;
  say(`  ${result.mapped} read, ${result.skipped} skipped, ${candidates.length} candidate facts`);
  if (!candidates.length) {
    result.spendAfter = await userSpendToday(userId);
    say("  nothing durable found");
    return result;
  }

  const existing = await listMemories(userId);
  const reduced = await llmJson({
    userId,
    job: "backfill_brain_reduce",
    model: MODELS.deep,
    system: reduceSystem(name, MEMORY_LIMIT),
    user: reduceUser({
      selfName: name,
      candidates: candidates.slice(0, 400).map((c) => `- ${c}`).join("\n"),
      existing: formatMemories(existing),
    }),
    jsonSchema: REDUCE_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 2000,
    reasoning: "adaptive",
  });
  result.spendAfter = await userSpendToday(userId);
  if (!reduced.ok) {
    say(`  ! reduce failed: ${reduced.reason ?? "no result"} (nothing written, existing memories untouched)`);
    return result;
  }
  const finals: string[] = ((reduced.data as any)?.memories ?? [])
    .map((m: unknown) => String(m ?? "").trim())
    .filter((m: string) => m.length > 8)
    .slice(0, MEMORY_LIMIT);
  result.memories = finals;

  say(`  → ${finals.length} memories after curation`);
  for (const m of finals) say(`     • ${m}`);

  if (!opts.apply) {
    say("  (dry run, nothing written)");
    return result;
  }
  // NEVER wipe on an empty result. The delete-then-insert is only safe because the reduce pass was
  // given the existing memories and told to keep what still holds, so its output is the whole
  // intended set. An empty output is a failed reduce wearing a success, and honouring it would
  // delete a corpus to replace it with nothing.
  if (!finals.length) {
    say("  reduce returned no memories, so nothing was replaced");
    return result;
  }
  await db.delete(schema.memories).where(and(eq(schema.memories.userId, userId)));
  for (const content of finals) {
    await db.insert(schema.memories).values({ userId, content });
  }
  result.written = true;
  log.info({ userId, count: finals.length, version: BACKFILL_PROMPT_VERSION }, "brain backfill written");
  say(`  ✓ written (${finals.length})`);
  return result;
}
