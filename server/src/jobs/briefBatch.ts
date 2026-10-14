import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { db, schema } from "../db";
import { log } from "../log";
import { apiKey, budgetGate, MODELS } from "../lib/llm";
import { sanitizeSchema } from "../lib/schema";
import { listMemories, formatMemories } from "../lib/memory";
import { isBriefWorthy } from "../lib/meeting";
import { userTz, isValidTz, dayBoundsInTz, dayKeyInTz, localMinutesInTz } from "../lib/tz";
import { briefCustomId } from "../lib/batch";
import { buildBriefingRequest } from "./briefing";
import { BRIEFING_SCHEMA } from "../prompts/briefing.v005";

/** Local 04:00-04:09 on a WEEKDAY, and this user has no brief-batch for their local day yet.
 *  Same shape as the digest's morning gate: the scheduler ticks every 10 minutes and this decides
 *  per user, so the ~140 daily non-window ticks never reach runJob or pollute job_runs.
 *
 *  Weekends are excluded deliberately: a Saturday with calendar entries is far more likely to be
 *  personal than a workday, and pre-generating briefs nobody reads is the one way this job can
 *  cost more than doing nothing. */
export async function isBriefBatchWindow(userId: string): Promise<boolean> {
  const urows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  // Same refusal as isMorningWindow, without a second alert (that one already names the user).
  // No push at stake here, just money: under the UTC fallback this fires at 21:00 Pacific and
  // pre-writes briefs for a "today" that, in the user's actual zone, is already over.
  if (!isValidTz(urows[0]?.tz)) return false;
  const tz = userTz(urows[0]?.tz);
  const lm = localMinutesInTz(tz);
  if (lm < 240 || lm >= 250) return false; // 04:00-04:09 local
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date());
  if (weekday === "Sat" || weekday === "Sun") return false;
  const day = dayKeyInTz(tz);
  const existing = await db
    .select({ id: schema.llmBatches.id })
    .from(schema.llmBatches)
    .where(and(eq(schema.llmBatches.userId, userId), eq(schema.llmBatches.kind, `brief:${day}`)));
  return existing.length === 0;
}

/** Pre-generate today's meeting briefs through the Message Batches API at 50% off, so they are
 *  already waiting when the user opens the app instead of being written at T-10.
 *
 *  Safety model, in order of importance:
 *  • This is a BONUS, never a dependency. Any meeting without a brief still gets one from the
 *    normal T-10 scan, which skips meetings that already have one. So a slow, failed or expired
 *    batch degrades to exactly today's behaviour, never to a missing brief.
 *  • Only meetings starting more than 30 minutes out are batched. Anything sooner belongs to the
 *    sync path, where latency actually matters.
 *  • One batch per user per local day, guarded by a conditional insert on kind = brief:<day>, so
 *    a restart or a double tick cannot submit twice.
 *  • Weekdays only (see isBriefBatchWindow). */
export async function briefBatch(userId: string): Promise<string> {
  const key = await apiKey();
  if (!key) return "skipped: no api key";

  const gateReason = await budgetGate(userId, "briefing_batch");
  if (gateReason) return `skipped: ${gateReason}`;

  const urows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  const user = urows[0];
  const tz = userTz(user?.tz);
  const day = dayKeyInTz(tz);

  // Claim the day BEFORE submitting, so a crash between submit and insert cannot leave the guard
  // open for a second batch. A duplicate claim means another runner won; bail without spending.
  const claimed = await db
    .insert(schema.llmBatches)
    .values({ userId, kind: `brief:${day}`, status: "claiming" })
    .returning({ id: schema.llmBatches.id });
  if (!claimed.length) return "skipped: already claimed for today";
  const rowId = claimed[0].id;

  try {
    const { start, end } = dayBoundsInTz(tz);
    const cutoff = new Date(Date.now() + 30 * 60_000);
    const from = start.getTime() > cutoff.getTime() ? start : cutoff;
    const todays = await db
      .select()
      .from(schema.meetings)
      .where(
        and(
          eq(schema.meetings.userId, userId),
          gte(schema.meetings.startsAt, from),
          lte(schema.meetings.startsAt, end),
        ),
      );

    // Positionally paired: requests[i] is the brief for meetingIds[i]. The API caps custom_id at
    // 64 chars and a meeting id can exceed that, which rejected the WHOLE batch and cost that user
    // every pre-generated brief for the day. See lib/batch.ts for the arithmetic.
    const requests: { custom_id: string; params: Record<string, unknown> }[] = [];
    const meetingIds: string[] = [];
    for (const m of todays) {
      if (!isBriefWorthy(m)) continue;
      const already = await db
        .select({ id: schema.briefings.id })
        .from(schema.briefings)
        .where(and(eq(schema.briefings.userId, userId), eq(schema.briefings.meetingId, m.id)));
      if (already.length) continue;

      const req = await buildBriefingRequest(userId, m, user, tz);
      if (!req) continue; // no context at all: the sync path writes a deterministic brief for free
      meetingIds.push(m.id);
      requests.push({
        custom_id: briefCustomId(meetingIds.length - 1),
        params: {
          model: MODELS.deep,
          // Same shape as the sync path in jobs/briefing.ts: low effort instead of a disabled
          // thinking config (the current Sonnet rejects that), with room for both in the budget.
          max_tokens: 4096,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          output_config: {
            effort: "low",
            format: { type: "json_schema", schema: sanitizeSchema(BRIEFING_SCHEMA) },
          },
          thinking: { type: "adaptive" },
        },
      });
    }

    if (!requests.length) {
      await db.update(schema.llmBatches).set({ status: "ended" }).where(eq(schema.llmBatches.id, rowId));
      return "skipped: nothing to pre-brief today";
    }

    const batch = await new Anthropic({ apiKey: key }).messages.batches.create({ requests } as any);
    await db
      .update(schema.llmBatches)
      .set({ providerBatchId: batch.id, status: batch.processing_status ?? "in_progress", customIds: meetingIds })
      .where(eq(schema.llmBatches.id, rowId));
    log.info({ userId, n: requests.length, batch: batch.id }, "brief batch submitted");
    return `batched ${requests.length} briefs for ${day} (${batch.id})`;
  } catch (e: any) {
    // Release the day claim: a failed submission must not block tomorrow's attempt, and the T-10
    // scan will brief these meetings normally anyway.
    await db.update(schema.llmBatches).set({ status: "failed" }).where(eq(schema.llmBatches.id, rowId));
    throw e;
  }
}
