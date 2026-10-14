import cron from "node-cron";
import { and, eq } from "drizzle-orm";
import { db, schema, OWNER } from "../db";
import { log } from "../log";
import { runJob } from "./run";
import { pollGmail } from "../connectors/gmail";
import { pollCalendar } from "../connectors/gcal";
import { pollDrive } from "../connectors/drive";
import { pollJira } from "../connectors/jira";
import { pollConfluence } from "../connectors/confluence";
import { pollFireflies } from "../connectors/fireflies";
import { pollFathom } from "../connectors/fathom";
import { pollOtter } from "../connectors/otter";
import { pollLinear, pollAsana } from "../connectors/trackers";
import { pollSlack } from "../connectors/slack";
import { briefingScan, hasBriefingWindow } from "./briefing";
import { runDigest, sweepExpiredCards, isMorningWindow } from "./digest";
import { batchPoll, extractPending } from "./extract";
import { briefBatch, isBriefBatchWindow } from "./briefBatch";
import { opsDigest, isOpsDigestWindow } from "./opsDigest";
import { slackListen } from "./slackListen";
import { distillMemories } from "./distill";
import { followUpSweep } from "./followUp";
import { isValidTz, userTz, localMinutesInTz } from "../lib/tz";

/** The self-wake nudge fires in the user's LOCAL late afternoon, deliberately not their morning.
 *
 *  The morning digest already lists due follow-ups at 07:30 local, so nudging then would be two
 *  notifications about the same commitments in the same minute, and one of them would be noise.
 *  17:00 is also the better question: "you said you would do this today, did it happen" lands while
 *  there is still some day left to act on the answer.
 *
 *  Refuses to fire without a real timezone, for the reason isMorningWindow spells out at length:
 *  this ends in a phone lighting up, and 17:00 UTC is 09:00 in California. Sending nothing is the
 *  correct failure for a product whose whole point is that it respects your attention. */
async function isFollowUpWindow(userId: string): Promise<boolean> {
  const urows = await db.select({ tz: schema.users.tz }).from(schema.users).where(eq(schema.users.id, userId));
  if (!isValidTz(urows[0]?.tz)) return false;
  const lm = localMinutesInTz(userTz(urows[0]?.tz));
  return lm >= 1020 && lm < 1030;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Users with a live connector (currently: a connected Google account) plus the local owner,
 *  always. This keeps the per-tick loop below correct when more than one user exists. */
export async function activeUsers(): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.connections.userId })
    .from(schema.connections)
    .where(and(eq(schema.connections.id, "google"), eq(schema.connections.status, "connected")));
  const ids = new Set(rows.map((r) => r.userId));
  ids.add(OWNER);
  return [...ids];
}

/** Cadences: gmail 2m, gcal 5m, drive+jira 10m, slack 15m, briefing scan 60s, digest 07:30. */
export function startScheduler() {
  // Per (job, user) overlap guard: a slow run for one user never blocks another user's tick.
  const running = new Set<string>();

  /** `gate` runs BEFORE runJob and before the overlap guard is claimed, so a job that is idle most
   *  of the time writes no job_runs row on the ticks where it would have done nothing. Cheap,
   *  indexed reads only; anything expensive belongs in the job itself. */
  const guard = (
    name: string,
    fn: (userId: string) => Promise<string>,
    jitter = false,
    gate?: (userId: string) => Promise<boolean>,
  ) => {
    return async () => {
      const users = await activeUsers();
      for (const userId of users) {
        if (gate && !(await gate(userId))) continue;
        const key = `${name}:${userId}`;
        if (running.has(key)) continue;
        running.add(key);
        try {
          await runJob(name, userId, () => fn(userId));
        } finally {
          running.delete(key);
        }
        // LLM-bearing jobs get a small jitter between users so they don't all hit the model at once.
        if (jitter) await sleep(1000 + Math.floor(Math.random() * 2000));
      }
    };
  };

  // Every poller is per-user: each connector touches only the polled user's
  // connection/cursor/item rows, so looping over activeUsers() here does real multi-tenant
  // polling, not just telemetry.
  cron.schedule("*/2 * * * *", guard("gmail_poll", (userId) => pollGmail(userId)));
  cron.schedule("*/5 * * * *", guard("gcal_poll", (userId) => pollCalendar(userId)));
  cron.schedule("*/10 * * * *", guard("drive_poll", (userId) => pollDrive(userId)));
  cron.schedule("*/10 * * * *", guard("jira_poll", (userId) => pollJira(userId)));
  // Same cadence as Jira: same site, same token, same kind of low-cost ingest, and a page edit is
  // no more urgent than an issue update. Skips itself instantly when the user has not opted in.
  cron.schedule("*/10 * * * *", guard("confluence_poll", (userId) => pollConfluence(userId)));
  // Notetaker transcripts are a CARD SOURCE, so this is the one poll on this cadence that can end
  // in an extraction. 10m matches Drive, which is the other transcript source, and the fetch is
  // bounded per tick so a first connect cannot pull a hundred meetings in one go.
  cron.schedule("*/10 * * * *", guard("fireflies_poll", (userId) => pollFireflies(userId), true));
  cron.schedule("*/10 * * * *", guard("fathom_poll", (userId) => pollFathom(userId), true));
  cron.schedule("*/10 * * * *", guard("otter_poll", (userId) => pollOtter(userId), true));
  // Linear and Asana ingest CONTEXT, like Jira, so they sit on Jira's cadence and carry no jitter:
  // neither ends in an LLM call.
  cron.schedule("*/10 * * * *", guard("linear_poll", (userId) => pollLinear(userId)));
  cron.schedule("*/10 * * * *", guard("asana_poll", (userId) => pollAsana(userId)));
  cron.schedule("*/15 * * * *", guard("slack_poll", (userId) => pollSlack(userId)));
  // Cards from the user's OWN Slack messages: every 4h, not on the 15m poll cadence.
  // search.messages covers since-last-run in one call regardless of how many conversations exist,
  // so there is no poll-cost reason to run it often, and every run that finds new messages is an
  // extraction call (real spend), unlike slack_poll's plain ingest.
  // jitter, for the same reason extract_pending has it: this job ends in an LLM call, and "0 */4"
  // is minute 0, which is the one minute where every other cron in this file also fires.
  cron.schedule("0 */4 * * *", guard("slack_listen", (userId) => slackListen(userId), true));
  // Weekly, because the thing it looks for is a pattern across several days and running it daily
  // would only spend a call to be told the same "nothing qualified" seven times. Mondays matches
  // the weekly review, so the memories a human reads are the ones just written.
  cron.schedule("0 9 * * 1", guard("distill_memories", (userId) => distillMemories(userId), true));
  // No jitter: this ends in a database read and a Telegram push, not an LLM call, and the gate
  // already confines it to one ten-minute window a day per user.
  cron.schedule("*/10 * * * *", guard("follow_up_sweep", (userId) => followUpSweep(userId), false, isFollowUpWindow));
  cron.schedule("*/10 * * * *", guard("extract_pending", (userId) => extractPending(userId), true));
  // Gated, same reasoning as the digest below: an idle 60s job must not write a telemetry row every
  // minute per user. See hasBriefingWindow for what that was costing.
  cron.schedule("* * * * *", guard("briefing_scan", (userId) => briefingScan(userId), true, hasBriefingWindow));
  // Morning digest at each user's LOCAL 07:30 (server stays UTC; users.tz is auto-reported by
  // the PWA). A 10-minute tick asks isMorningWindow per user: inside their 07:30-07:39 window
  // and no digest for their local day yet. The gate runs before runJob so the 143 daily
  // non-window ticks per user never pollute job_runs.
  let digesting = false;
  cron.schedule("*/10 * * * *", async () => {
    if (digesting) return;
    digesting = true;
    try {
      for (const userId of await activeUsers()) {
        if (!(await isMorningWindow(userId))) continue;
        await runJob("morning_digest", userId, () => runDigest(userId));
      }
    } finally {
      digesting = false;
    }
  });

  // Brief pre-generation at each user's LOCAL 04:00, weekdays only. Submits today's meetings to the
  // Message Batches API at 50% off so briefs are already waiting when the user opens the app,
  // instead of being written one at a time at T-10. Same gate shape as the digest above.
  // This is a bonus, never a dependency: the 60s briefing_scan still briefs anything without a
  // brief, so a slow, failed or expired batch degrades to exactly today's behaviour.
  let preBriefing = false;
  cron.schedule("*/10 * * * *", async () => {
    if (preBriefing) return;
    preBriefing = true;
    try {
      for (const userId of await activeUsers()) {
        if (!(await isBriefBatchWindow(userId))) continue;
        await runJob("brief_batch", userId, () => briefBatch(userId));
      }
    } finally {
      preBriefing = false;
    }
  });

  // Operator digest at the admin's LOCAL 20:00. Global, not per-user: it is one message about
  // everyone. The window gate runs before runJob for the same reason as the two above, and the
  // job_runs row it writes IS the once-a-day guard, so this must stay inside runJob.
  let opsDigesting = false;
  cron.schedule("*/10 * * * *", async () => {
    if (opsDigesting) return;
    opsDigesting = true;
    try {
      if (await isOpsDigestWindow()) await runJob("ops_digest", "", opsDigest);
    } finally {
      opsDigesting = false;
    }
  });

  // Global sweep: a single WHERE on expires_at. Rolls every 10 minutes now that mornings are
  // per-user (cards expire on time regardless of timezone); logged only when it expired
  // something, so job_runs stays readable.
  let sweeping = false;
  cron.schedule("*/10 * * * *", async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const r = await sweepExpiredCards();
      if (!r.startsWith("0 ")) await runJob("sweep_expired", "", async () => r);
    } finally {
      sweeping = false;
    }
  });

  // Global batch poll: no per-user loop needed, llm_batches rows aren't scoped to a user. It
  // collects the 4am brief batches, and runs regardless of BATCH_EXTRACT so an extraction batch
  // already in flight still drains.
  let polling = false;
  cron.schedule("*/5 * * * *", async () => {
    if (polling) return;
    polling = true;
    try {
      await runJob("batch_poll", "", batchPoll);
    } finally {
      polling = false;
    }
  });

  log.info(
    "scheduler started (gmail 2m, gcal 5m, drive/jira/confluence/notetakers 10m, slack 15m, slack listen 4h, briefing 60s, digest 07:30, ops digest 20:00, sweep 10m, batch poll 5m, distill Mon 09:00)",
  );
}

/** Manual triggers exposed via the API for testing from the PWA. The pollers here are genuinely
 *  per-user: they touch only the calling user's connector rows. batch_poll and ops_digest are
 *  global. */
export const MANUAL_JOBS: Record<string, (userId: string) => Promise<string>> = {
  gmail_poll: (userId) => pollGmail(userId),
  gcal_poll: (userId) => pollCalendar(userId),
  drive_poll: (userId) => pollDrive(userId),
  jira_poll: (userId) => pollJira(userId),
  confluence_poll: (userId) => pollConfluence(userId),
  fireflies_poll: (userId) => pollFireflies(userId),
  fathom_poll: (userId) => pollFathom(userId),
  otter_poll: (userId) => pollOtter(userId),
  linear_poll: (userId) => pollLinear(userId),
  asana_poll: (userId) => pollAsana(userId),
  slack_poll: (userId) => pollSlack(userId),
  morning_digest: (userId) => runDigest(userId),
  extract_pending: (userId) => extractPending(userId),
  slack_listen: (userId) => slackListen(userId),
  // Bypasses the local-afternoon window, not the once-per-item notifiedAt guard, so clicking it
  // cannot nudge anyone twice about the same commitment.
  follow_up_sweep: (userId) => followUpSweep(userId),
  // DRY RUN by default from the manual trigger, and this is the important part: a distilled memory
  // reaches the system prompt of both extraction and briefing and persists until a human deletes
  // it, so the first time this is pointed at a real account it should PROPOSE and write nothing.
  // The weekly scheduled run applies for real; this button is the one you press to read what it
  // would learn before letting it.
  distill_memories: (userId) => distillMemories(userId, { dryRun: true }),
  distill_memories_apply: (userId) => distillMemories(userId),
  // Manual trigger so the 4am job can be tested without waiting for 4am. Bypasses the window gate
  // but NOT the once-per-day claim, so clicking twice cannot submit two batches.
  brief_batch: (userId) => briefBatch(userId),
  batch_poll: () => batchPoll(),
  // Bypasses the 20:00 window AND the once-a-day guard on purpose: this one is safe to re-run
  // (it only reads and sends a message), and being able to see the line on demand is the whole
  // point of a report you are meant to trust when it says nothing happened.
  ops_digest: () => opsDigest(),
};
