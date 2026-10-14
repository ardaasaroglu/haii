import { db, schema } from "../db";
import { log } from "../log";
import { recordFailure } from "../lib/failures";

/** Job names are internal; the user-facing banner needs plain language. */
const JOB_LABEL: Record<string, string> = {
  action_extract: "Reading a transcript for your commitments",
  briefing_generate: "Writing a meeting brief",
  morning_digest: "Building your morning digest",
  gmail_poll: "Syncing Gmail",
  gcal_poll: "Syncing Calendar",
  drive_poll: "Syncing Drive transcripts",
  jira_poll: "Syncing Jira",
  slack_poll: "Syncing Slack",
  brief_batch: "Preparing tomorrow's briefs",
  briefing_scan: "Checking for meetings to brief",
  extract_pending: "Reading a transcript for your commitments",
  batch_poll: "Collecting finished briefs",
  ops_digest: "Building the operator digest",
  sweep_expired: "Expiring old cards",
};

/** Last resort when a job has no label. Turns "brief_batch" into "Brief batch" rather than showing
 *  someone an internal identifier. Without it, a job missing from the table above put its raw name
 *  on the home screen. */
function jobLabel(name: string): string {
  const l = JOB_LABEL[name];
  if (l) return l;
  const words = name.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the USER is told when a background job fails.
 *
 *  Never the provider's error text. `custom_id: String should have at most 64 characters` is not
 *  something anyone can act on, and reading a raw API error off your own product is a trust event
 *  rather than a cosmetic one. The real string still reaches the operator via operatorNote, which
 *  recordFailure deliberately keeps out of the banner.
 *
 *  Scoped to kind:"job" on purpose. An execution failure is the user's OWN approved action and its
 *  detail is genuinely useful to them ("14:00 is no longer free"), so that path is untouched. */
const USER_SAFE_JOB_DETAIL = "Haii could not finish this in the background. Nothing you approved was lost, and it will try again on the next run.";

/** Jobs whose failure the OPERATOR should hear about and the user should not.
 *
 *  The rule, and it is worth stating because the next person will want to add to this list: show a
 *  user a failure only when something they were promised did not happen AND will not fix itself.
 *
 *  Everything below fixes itself on a timer. Gmail polls every 2 minutes, Calendar every 5, Drive
 *  and Jira every 10, Slack every 15. `briefing_scan` runs every 60 seconds. `brief_batch` failing
 *  costs nothing visible because the T-10 path still writes the brief, just at full price. So the
 *  banner they produced said "it will try again on the next run", which is an alarm that asks the
 *  reader for nothing. In ordinary use it could fill the home screen with red lines while every
 *  connection was healthy.
 *
 *  Deliberately NOT here: action_extract and briefing_generate, where a permanent failure means a
 *  meeting silently produced no cards or no brief, which is the product not doing its job; and
 *  morning_digest, which is once a day. Those stay visible. The better answer for them is an
 *  N-consecutive-failures rule rather than per-tick noise, and that is not built yet.
 *
 *  Executions are untouched and must stay so: kind:"execution" is the user's OWN approved action. */
const OPERATOR_ONLY_JOBS = new Set([
  "gmail_poll", "gcal_poll", "drive_poll", "jira_poll", "slack_poll", "slack_listen",
  "briefing_scan", "batch_poll", "brief_batch", "extract_pending", "follow_up_sweep",
  "sweep_expired", "ops_digest", "distill_memories",
]);

/** Run a job with job_runs telemetry and throttled Telegram alerting on errors.
 *  userId is '' for system-wide/global runs (e.g. the expired-card sweep). */
export async function runJob(name: string, userId: string, fn: () => Promise<string>): Promise<string> {
  const startedAt = new Date();
  try {
    const detail = await fn();
    const finishedAt = new Date();
    // A job that returns "skipped: <reason>" is not always benign. LLM failures and budget stops
    // come back through this same string channel, so classifying every "skipped:" as skipped meant
    // a 100%-dead LLM layer produced ZERO error rows: no alert fired, the admin overview reported
    // 0 errors, and the UI looked like a quiet week. (When every call returned a 400, the only
    // signal was a UI error someone happened to click into.)
    const FAILURE_REASONS =
      /^skipped: (api_error|rate_limited|invalid_json|refusal|empty_response|max_tokens|budget_|user_daily_cap|monthly_cap|budget_hard_cap|budget_soft_cap|no_credit|bad_api_key)/;
    const status = !detail.startsWith("skipped")
      ? "ok"
      : FAILURE_REASONS.test(detail)
        ? "error"
        : "skipped";
    await db.insert(schema.jobRuns).values({
      userId,
      job: name,
      status,
      detail: detail.slice(0, 500),
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    });
    if (status === "ok") log.info({ job: name, userId, detail }, "job ok");
    // Rate limits are already dead-lettered by the LLM layer, with the model and status attached.
    // Recording again here would double the row and the operator ping for one event.
    // Budget caps are the same shape: budgetGate now sends its own operator alert naming the user,
    // the cap and the spend, once per user per day. The generic version of that ping fired once per
    // (job, user) per 6h and read "Job failed ... skipped: user_daily_cap", which buried the real
    // one and told the user their assistant was broken when it had simply run out of budget.
    // Deliberate consequence: no `failures` row, so no in-app banner for a capped user. That banner
    // showed them a raw internal reason string; a proper "paused for today" state is backlog.
    // The job_runs row is still status=error, so the admin overview keeps counting these.
    // Out of credit and a dead key are the same shape again, and the most important case to get
    // right: they fail EVERY job for EVERY user at once, so the generic ping would fan out to one
    // message per (job, user) per 6h and bury the single alert that says what to actually do.
    // The LLM layer sends that one, throttled on the account.
    const CAP_REASONS = /^skipped: (user_daily_cap|monthly_cap|budget_hard_cap|budget_soft_cap)/;
    const ACCOUNT_REASONS = /^skipped: (no_credit|bad_api_key)/;
    const alreadyRecorded =
      detail.startsWith("skipped: rate_limited") || CAP_REASONS.test(detail) || ACCOUNT_REASONS.test(detail);
    if (status === "error" && !alreadyRecorded) {
      log.error({ job: name, userId, detail }, "job failed (returned failure reason)");
      // Dead-letter + operator ping naming the affected user. Throttled per (job, user): a broken
      // key fails every tick and we want one alert, not one per minute.
      await recordFailure({
        userId,
        kind: "job",
        ref: name,
        title: jobLabel(name),
        detail: USER_SAFE_JOB_DETAIL,
        operatorNote: detail,
        throttleKey: `job:${name}:${userId}`,
        operatorOnly: OPERATOR_ONLY_JOBS.has(name),
      });
    }
    return detail;
  } catch (e: any) {
    const finishedAt = new Date();
    const detail = String(e?.message ?? e).slice(0, 500);
    await db.insert(schema.jobRuns).values({
      userId,
      job: name,
      status: "error",
      detail,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    });
    log.error({ job: name, userId, err: detail }, "job error");
    await recordFailure({
      userId,
      kind: "job",
      ref: name,
      title: jobLabel(name),
      detail: USER_SAFE_JOB_DETAIL,
      operatorNote: detail,
      throttleKey: `job:${name}:${userId}`,
      operatorOnly: OPERATOR_ONLY_JOBS.has(name),
    });
    return `error: ${detail}`;
  }
}
