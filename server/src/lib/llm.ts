import Anthropic from "@anthropic-ai/sdk";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { env } from "../env";
import { log } from "../log";
import { recordFailure } from "./failures";
import { priceFor } from "./prices";
import { sanitizeSchema } from "./schema";
import { NO_KEY_REASON } from "./skipReason";
import { tgAlertOnce, escapeHtml, userLabel } from "./telegram";

/** Sonnet-class carries every job. Move a job to a larger model only with an eval result that
 *  justifies it. `deep` and `fast` are older names for `default` and `cheap`; the job call sites
 *  still use `deep`. */
export const MODELS = {
  default: "claude-sonnet-5-5", // briefings, extraction, distill
  cheap: "claude-haiku-4-5", // digest, the memory backfill's map pass, soft-cap downgrades
  deep: "claude-sonnet-5-5",
  fast: "claude-haiku-4-5",
} as const;

/** USD per 1M tokens [input, output], for the local spend ledger and the budget caps. These are
 *  list prices typed in by hand, so check them against Anthropic's pricing page when you change
 *  the model. A model missing from this table is billed at the default model's rate. */
const PRICES: Record<string, [number, number]> = {
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};

/** Models that reject `output_config.effort` and `thinking: {type:"adaptive"}` with a 400.
 *  Haiku 4.5 predates both: it only accepts the older {type:"enabled", budget_tokens} thinking form
 *  and has no effort dial at all. Kept as a set because `model` is resolved at call time, not from
 *  the job's requested model (the soft cap downgrades to haiku mid-flight). */
const NO_TUNING_MODELS: ReadonlySet<string> = new Set([MODELS.cheap, MODELS.fast]);

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Prompt-cache multipliers on the INPUT rate. A cache write costs a premium; a read is ~a tenth
 *  of normal input, which is the entire point. Pricing them as plain input would overstate a
 *  cached call by roughly 10x on the cached portion, tripping budget caps early and corrupting
 *  the cost-per-brief figure. */
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

export function costOf(
  model: string,
  tokensIn: number,
  tokensOut: number,
  cacheWriteTokens = 0,
  cacheReadTokens = 0,
): number {
  const [pin, pout] = priceFor(model, PRICES, MODELS.default);
  return (
    (tokensIn / 1e6) * pin +
    (tokensOut / 1e6) * pout +
    (cacheWriteTokens / 1e6) * pin * CACHE_WRITE_MULT +
    (cacheReadTokens / 1e6) * pin * CACHE_READ_MULT
  );
}

/** The key is read from the environment (server/.env locally) and nowhere else. It is never
 *  stored in the database and never sent to the browser. */
export async function apiKey(): Promise<string | null> {
  return env.ANTHROPIC_API_KEY || null;
}

/** "api" means an Anthropic API key is set and calls are billed to it per token. "none" means
 *  there is no key yet: LLM jobs skip cleanly and the app says Claude is not configured, instead
 *  of failing in a way that looks like an outage. */
export async function llmMode(): Promise<"api" | "none"> {
  return (await apiKey()) ? "api" : "none";
}

export { NO_KEY_REASON, NO_KEY_MESSAGE } from "./skipReason";

export async function todaySpend(): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${schema.llmLedger.costUsd}), 0)` })
    .from(schema.llmLedger)
    .where(eq(schema.llmLedger.day, today()));
  return Number(rows[0]?.total ?? 0);
}

export async function userSpendToday(userId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${schema.llmLedger.costUsd}), 0)` })
    .from(schema.llmLedger)
    .where(sql`${schema.llmLedger.day} = ${today()} and ${schema.llmLedger.userId} = ${userId}`);
  return Number(rows[0]?.total ?? 0);
}

export async function instanceMonthSpend(): Promise<number> {
  const month = today().slice(0, 7);
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${schema.llmLedger.costUsd}), 0)` })
    .from(schema.llmLedger)
    .where(sql`${schema.llmLedger.day} like ${month + "-%"}`);
  return Number(rows[0]?.total ?? 0);
}

/** instanceMonthSpend, scoped to one user. Admin overview per-user spend. */
export async function userSpendMonth(userId: string): Promise<number> {
  const month = today().slice(0, 7);
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${schema.llmLedger.costUsd}), 0)` })
    .from(schema.llmLedger)
    .where(sql`${schema.llmLedger.day} like ${month + "-%"} and ${schema.llmLedger.userId} = ${userId}`);
  return Number(rows[0]?.total ?? 0);
}

export async function recordLedger(
  userId: string,
  job: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
  cache: { write?: number; read?: number } = {},
) {
  await db.insert(schema.llmLedger).values({
    userId,
    day: today(),
    job,
    model,
    tokensIn,
    tokensOut,
    cacheWriteTokens: cache.write ?? 0,
    cacheReadTokens: cache.read ?? 0,
    costUsd,
  });
}

export type LlmResult =
  | { ok: true; data: any; model: string; tokensIn: number; tokensOut: number; costUsd: number }
  | { ok: false; reason: string };

/** Turn a system prompt into Anthropic system blocks, cache breakpoint on the stable prefix only.
 *
 *  A plain string becomes one block with a cache breakpoint. Only extraction passes a split prompt
 *  today; briefing, digest, distill and the memory backfill pass a string and can adopt the split
 *  later on their own merits. */
function systemBlocks(system: string | { stable: string; variable?: string }) {
  if (typeof system === "string") {
    return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  }
  // DEFAULT 5m TTL, DELIBERATELY. Seeing cache_read_tokens at zero makes a longer TTL look like the
  // fix. Read this first.
  //
  // The SDK does support `ttl: "1h"`. It is not free: a 1h write bills at 2x input against 1.25x
  // for 5m. It only pays if extractions are spread out ACROSS hours, and loses badly if they are
  // isolated (one extraction an hour would cost 2x with no read to offset it).
  //
  // Extractions here are not spread out, they are tightly clustered: extract_pending runs every ten
  // minutes and processes the pending transcripts (up to five) in ONE run, back to back within
  // seconds. That is exactly the shape 5m serves best, one write per run and a read for every
  // transcript after it.
  //
  // So the right measurement is a run that processes 2+ transcripts, not a single lonely one. A
  // solitary extraction will always show a write and no read, and that is not evidence of failure.
  const blocks: Array<Record<string, unknown>> = [
    { type: "text", text: system.stable, cache_control: { type: "ephemeral" } },
  ];
  // Empty variable half is skipped rather than sent blank: an empty text block is rejected by the
  // API, and a user with no role and no memories is a real case on day one.
  if (system.variable && system.variable.trim()) {
    blocks.push({ type: "text", text: system.variable });
  }
  return blocks;
}

export interface LlmJsonOpts {
  userId: string;
  job: string;
  model: string;
  /** Either one string, or a SPLIT prompt.
   *
   *  The split exists because the cache was never hitting. Measured on live extractions: 4,862
   *  cache-WRITE tokens and 0 cache-READ tokens, on every single call, forever. Most of the cost of
   *  an extraction was a cache nobody ever read from.
   *
   *  The reason is that the prompt was byte-stable PER USER but not across users. It carries the
   *  user's name, role and up to 40 memories, so every user has a different cache key, and when
   *  extractions are sparse the entry expires before the same user comes back. Per-user stability
   *  is not enough at low volume.
   *
   *  Split into { stable, variable }, the stable half is identical for every user on every call, so
   *  all of them share one cache entry and it is kept warm by the whole platform rather than by one
   *  person. The variable half carries the per-user text and is not cached.
   *
   *  KEEP EVERYTHING VOLATILE OUT OF `stable`. Timestamps, counts, budget state and anything
   *  user-specific belong in `variable` or in the user message. One volatile token in the stable
   *  half and every call writes a fresh entry again, which is exactly the bug this replaced. */
  system: string | { stable: string; variable?: string };
  user: string;
  jsonSchema: Record<string, unknown>;
  /** Per-job reasoning depth. "adaptive" (default) lets the model think before answering, which is
   *  worth paying for when the job has to JUDGE something: extraction has to decide who committed
   *  to what, pull exact quotes, and score confidence. "off" is for jobs that only have to
   *  summarize context they were already handed, where thinking is pure output-token overhead
   *  (thinking bills at output rates). Ignored on haiku, which supports neither knob.
   *
   *  "off" is a request, not a switch. Sonnet 5.5 rejects `thinking: {type: "disabled"}` outright,
   *  so "off" now means LOW EFFORT: the model keeps its thinking short and skips it on most simple
   *  requests. Thinking still shares max_tokens with the reply, so a job that asks for "off" needs
   *  room for both. */
  reasoning?: "adaptive" | "off";
  maxTokens?: number;
}

/** Single-shot structured-output call to the Anthropic API, on the key from the environment. */
export async function llmJson(opts: LlmJsonOpts): Promise<LlmResult> {
  const key = await apiKey();
  if (!key) return { ok: false, reason: NO_KEY_REASON };
  return apiJson(key, opts);
}

/* ---------------- Budget caps and the API call ---------------- */

/** The three HARD gates of the budget ladder, checked in blast-radius order: monthly kill
 *  switch, global daily cap, per-user daily cap. Null means clear to proceed; otherwise the
 *  reason string the caller should surface. Exported so a batch submission path such as
 *  jobs/briefBatch.ts can gate before spending on a submit, without duplicating the alerting here.
 *  The soft-cap haiku downgrade below is NOT a gate (it downgrades rather than blocks) and is
 *  applied in apiJson. */
export async function budgetGate(userId: string, job: string): Promise<string | null> {
  // 1. Monthly kill switch: total spend this month.
  const monthSpend = await instanceMonthSpend();
  if (monthSpend >= env.MONTHLY_CAP_USD) {
    await tgAlertOnce(
      `monthly_cap:${today().slice(0, 7)}`,
      `Haii hit the monthly cap ($${env.MONTHLY_CAP_USD}). LLM jobs paused until next month or a cap raise.`,
      24 * 3600_000,
    );
    return "monthly_cap";
  }
  // 2. Global daily cap.
  const spend = await todaySpend();
  if (spend >= env.BUDGET_HARD_USD) {
    await tgAlertOnce(
      `budget_hard:${today()}`,
      `Haii hit the hard budget cap ($${env.BUDGET_HARD_USD}/day). LLM jobs paused until midnight.`,
      24 * 3600_000,
    );
    return "budget_hard_cap";
  }
  // 3. Per-user daily hard cap: pause that user only.
  const userSpend = await userSpendToday(userId);
  if (userSpend >= env.USER_DAILY_HARD_USD) {
    log.warn({ job, userId, userSpend }, "user daily hard cap; job skipped");
    // This is the ONLY cap in the ladder one user can trip on their own, and it is the one whose
    // symptom is indistinguishable from a quiet day: no cards arrive, nothing is on fire, and the
    // person it happened to has no idea their assistant stopped. The generic job-failure ping that
    // used to cover this (run.ts classifies the reason as an error) said "Job failed ... skipped:
    // user_daily_cap" once per job per 6h, which is both unreadable and repeated. One clear line
    // per user per day instead; run.ts now suppresses the duplicate.
    await tgAlertOnce(
      `user_hard_cap:${userId}:${today()}`,
      `<b>${escapeHtml(await userLabel(userId))}</b> hit their daily cap: $${userSpend.toFixed(2)} of $${env.USER_DAILY_HARD_USD.toFixed(2)}.\n` +
        `Their LLM jobs are paused until tomorrow. No cards, no briefs for them until then. Nobody else is affected.\n` +
        `Raise it with USER_DAILY_HARD_USD.`,
      24 * 3600_000,
    );
    return "user_daily_cap";
  }
  return null;
}

/** The SOFT rung of the ladder: nothing is blocked, the model is swapped for a cheaper one for the
 *  rest of the day. Returns the model to actually call with.
 *
 *  Alerts because this is the more insidious of the two caps. The hard cap at least leaves a hole
 *  someone can notice; this one keeps producing briefs and cards, just shallower ones, and neither
 *  the reader nor the operator has any way to tell the difference. A quality regression that
 *  announces itself as normal output is exactly the silent-success pattern that cost this project
 *  most of its debugging time.
 *
 *  Exported alongside budgetGate for the same reason, but no batch path calls it yet: briefBatch
 *  pins MODELS.deep directly, so it still spends sonnet money past the soft cap. Wiring it there
 *  is a cost decision, not a cleanup, so it is left open here. */
export async function softCapModel(userId: string, job: string, model: string): Promise<string> {
  if (model === MODELS.cheap) return model;
  const spend = await todaySpend();
  const userSpend = await userSpendToday(userId);
  const userTripped = userSpend >= env.USER_DAILY_SOFT_USD;
  if (!userTripped && spend < env.BUDGET_SOFT_USD) return model;

  log.warn({ job, userId, userSpend, spend }, "soft cap reached; downgrading to haiku");
  // Keyed separately per cause: the fixes differ (raise one user's cap vs. raise the shared one),
  // and a global trip must not fan out one alert per user.
  await tgAlertOnce(
    userTripped ? `soft_cap:user:${userId}:${today()}` : `soft_cap:global:${today()}`,
    userTripped
      ? `<b>${escapeHtml(await userLabel(userId))}</b> passed the soft cap: $${userSpend.toFixed(2)} of $${env.USER_DAILY_SOFT_USD.toFixed(2)}.\n` +
        `Their briefs and extraction now run on haiku for the rest of the day, so quality drops without saying so. Hard stop at $${env.USER_DAILY_HARD_USD.toFixed(2)}.`
      : `Shared soft cap passed: $${spend.toFixed(2)} of $${env.BUDGET_SOFT_USD.toFixed(2)} today.\n` +
        `Everyone's briefs and extraction now run on haiku for the rest of the day. Hard stop at $${env.BUDGET_HARD_USD.toFixed(2)}.`,
    24 * 3600_000,
  );
  return MODELS.cheap;
}

async function apiJson(key: string, opts: LlmJsonOpts): Promise<LlmResult> {
  const gateReason = await budgetGate(opts.userId, opts.job);
  if (gateReason) return { ok: false, reason: gateReason };

  // 4. Soft cap, per user or shared: calls downgrade to haiku for the rest of the day.
  const model = await softCapModel(opts.userId, opts.job, opts.model);

  const client = new Anthropic({ apiKey: key });

  try {
    // Gate on the RESOLVED model, not opts.model: the soft cap above can swap it to haiku
    // mid-flight, and Haiku 4.5 400s on both of these. Setting them unconditionally would make a
    // soft-capped user's calls fail hard at exactly the point the ladder is meant to degrade.
    // Sonnet 5 and 5.5 also flipped the thinking default: an omitted `thinking` runs adaptive (4.6
    // ran it off), and an omitted effort means "high", so stating both explicitly is what keeps
    // cost predictable.
    const tunable = !NO_TUNING_MODELS.has(model);
    const maxTokens = opts.maxTokens ?? 4096;
    // Prompt caching. systemBlocks puts the cache breakpoint on the stable part of the system
    // prompt. A prefix shorter than the model's minimum cacheable length is simply not cached: the
    // API writes nothing and charges no write premium. costOf prices cache writes and reads at
    // their own rates. The invariant that makes a read possible: the cached part must stay
    // BYTE-STABLE between calls. Anything volatile (timestamps, pending-card counts, budget state)
    // belongs in the variable half or the user message, never in the cached part, or every call
    // writes a fresh cache instead of reading one.
    const params: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      // Two blocks when the caller split the prompt, and cache_control ONLY on the first. A cached
      // prefix has to be a genuine prefix: everything before the breakpoint is the key, so putting
      // the per-user half second is what lets every user share one entry.
      //
      // The variable half is deliberately NOT cached rather than cached separately. It is small,
      // it differs per user, and a second breakpoint would just reinstate the never-read write the
      // split removed, one block further down.
      system: systemBlocks(opts.system),
      messages: [{ role: "user", content: opts.user }],
      output_config: {
        ...(tunable ? { effort: opts.reasoning === "off" ? "low" : env.LLM_EFFORT } : {}),
        format: { type: "json_schema", schema: sanitizeSchema(opts.jsonSchema) },
      },
      // Always adaptive. "off" is expressed through effort above, because the current Sonnet returns
      // a 400 for a disabled thinking config.
      ...(tunable ? { thinking: { type: "adaptive" } } : {}),
    };
    const resp: Anthropic.Message = await client.messages.create(params as any);

    if (resp.stop_reason === "refusal") {
      log.warn({ job: opts.job, model }, "llm refusal");
      return { ok: false, reason: "refusal" };
    }
    // Adaptive thinking shares the max_tokens budget with the JSON body, so a truncation here is a
    // budget problem rather than a malformed reply. Without this the response falls through to
    // JSON.parse and reports as "invalid_json", which sends you debugging the prompt instead of
    // the token ceiling. Raise the job's maxTokens (or drop LLM_EFFORT to low) when this fires.
    if (resp.stop_reason === "max_tokens") {
      log.warn({ job: opts.job, model, maxTokens }, "hit max_tokens; response truncated");
      return { ok: false, reason: "max_tokens" };
    }

    const tokensIn = resp.usage?.input_tokens ?? 0;
    const tokensOut = resp.usage?.output_tokens ?? 0;
    const cacheWrite = (resp.usage as any)?.cache_creation_input_tokens ?? 0;
    const cacheRead = (resp.usage as any)?.cache_read_input_tokens ?? 0;
    const servedModel = (resp as any).model ?? model;
    const costUsd = costOf(servedModel, tokensIn, tokensOut, cacheWrite, cacheRead);
    await recordLedger(opts.userId, opts.job, servedModel, tokensIn, tokensOut, costUsd, {
      write: cacheWrite,
      read: cacheRead,
    });
    // Logged so cache writes and reads show up in the server log without a ledger query. Judge it
    // on a run with several extractions: a lone call always writes and never reads.
    if (cacheWrite || cacheRead) {
      log.info({ job: opts.job, cacheWrite, cacheRead, tokensIn }, "prompt cache active");
    }

    const text = resp.content.find((b: any) => b.type === "text") as { text: string } | undefined;
    if (!text) return { ok: false, reason: "empty_response" };
    let data: any;
    try {
      data = JSON.parse(text.text);
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
    return { ok: true, data, model: servedModel, tokensIn, tokensOut, costUsd };
  } catch (e: any) {
    const status: number | undefined = e?.status;
    const msg = String(e?.message ?? e);
    log.error({ job: opts.job, status, err: msg }, "llm api call failed");
    // 429 = rate limited, 529 = overloaded. Both are transient and both used to surface as a
    // generic api_error, so nobody could tell "we are being throttled" from "the key is wrong".
    // They get their own reason, their own dead-letter kind, and a throttled operator ping that
    // names the user, because the question is which user is hitting the ceiling.
    if (status === 429 || status === 529) {
      const kindLabel = status === 429 ? "rate limited" : "overloaded";
      await recordFailure({
        userId: opts.userId,
        kind: "rate_limit",
        ref: `${model} · ${status}`,
        title: `Anthropic ${kindLabel} while ${opts.job.replace(/_/g, " ")}`,
        detail: msg.slice(0, 300),
        // Rate limits repeat by nature: collapse to one ping per user and status per window
        // (tgAlertOnce's default, 6 hours).
        throttleKey: `ratelimit:${opts.userId}:${status}`,
      });
      return { ok: false, reason: `rate_limited:${status}` };
    }

    // ACCOUNT-LEVEL failures: out of credit, or a key that is revoked/wrong. These are the worst
    // failures we have, and until now they explained themselves the least. A rate limit passes on
    // its own and a budget cap is ours to raise, but these stop EVERY job for EVERY user until a
    // human goes and pays or re-issues a key, and the operator ping said only "api_error:400". The
    // sentence that actually tells you what to do, "Your credit balance is too low", was written to
    // log.error and stayed in the host's logs where nobody was looking.
    //
    // Throttled on the ACCOUNT, not the user or the job: the balance hits zero once, not once per
    // person. Without that, every user times every job is a flood of identical pings per window,
    // which buries the one message that matters.
    //
    // Matched on the message and not the status alone, because a 400 is also what a malformed
    // request returns, and calling that "out of credit" would be its own kind of lie.
    const outOfCredit = status === 400 && /credit balance|purchase credits|plans ?& ?billing|billing/i.test(msg);
    const badKey = status === 401 || status === 403;
    if (outOfCredit || badKey) {
      await tgAlertOnce(
        `anthropic_account:${outOfCredit ? "credit" : "key"}`,
        outOfCredit
          ? `<b>Anthropic is out of credit.</b> Haii has stopped for everyone.\n\n` +
            `No cards, no briefs, no extraction, for any user, until the balance is topped up. ` +
            `Nothing already approved is lost.\n\n` +
            `Top up at platform.claude.com, under Billing. Auto-reload is what prevents this happening again.\n\n` +
            `<i>${escapeHtml(msg.slice(0, 200))}</i>`
          : `<b>Anthropic rejected our API key (${status}).</b> Haii has stopped for everyone.\n\n` +
            `Either the key was revoked or ANTHROPIC_API_KEY is wrong. No cards or briefs ` +
            `for anyone until it is fixed.\n\n<i>${escapeHtml(msg.slice(0, 200))}</i>`,
        6 * 3600_000,
      );
      return { ok: false, reason: outOfCredit ? "no_credit" : "bad_api_key" };
    }

    return { ok: false, reason: `api_error${status ? `:${status}` : ""}` };
  }
}
