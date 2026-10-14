/** Retry policy for outbound provider calls.
 *
 *  Why this exists: there were ZERO retries, so a single transient 429 or 503 from Google became
 *  a failed job, a dead-lettered row, and a red line on a user's home screen. A run of those in
 *  one day, none of them a real problem, made it urgent. The failure was ours for treating a
 *  provider hiccup as an outcome.
 *
 *  Pure and dependency-free so the policy is testable without a network. lib/retry decides WHETHER
 *  and HOW LONG; the connector does the fetching.
 */

/** Statuses worth trying again. 408 request timeout and 425 too early are included because both
 *  mean "nothing was processed"; 4xx otherwise means we asked wrongly and asking again will fail
 *  identically. 401 and 403 are deliberately absent: those need a reconnect, and retrying them
 *  three times just delays the honest answer by a few seconds. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Should this response be retried?
 *
 *  METHOD MATTERS, and getting this wrong is worse than not retrying at all. A 5xx is ambiguous:
 *  the server may have completed the write and failed to tell us. Retrying a POST on 5xx is how
 *  you create the same calendar event twice, or two identical Gmail drafts. So 5xx retries are
 *  limited to methods that are idempotent by definition.
 *
 *  429 is the exception, and it is safe for ANY method: a rate limit is a refusal to process, so
 *  nothing happened and repeating it cannot duplicate anything. 429 is also the case this whole
 *  file exists for. */
export function shouldRetry(status: number, method = "GET"): boolean {
  if (!RETRYABLE.has(status)) return false;
  if (status === 429 || status === 408 || status === 425) return true;
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

/** How long to wait before attempt N (1-indexed).
 *
 *  Honours Retry-After when the provider sends one, because a server telling us when to come back
 *  is better information than any backoff curve we invent. Both forms are accepted: delta-seconds
 *  and an HTTP date. Capped so a hostile or mistaken header cannot park a poll for an hour.
 *
 *  Otherwise exponential with FULL JITTER. The jitter is not decoration: every user's polls are
 *  scheduled on the same cron tick, so a provider blip hits them together and a fixed backoff
 *  would march them all back in lockstep and re-create the spike that caused it. */
export function retryDelayMs(
  attempt: number,
  retryAfter?: string | null,
  opts: { baseMs?: number; maxMs?: number; now?: number; random?: () => number } = {},
): number {
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 8_000;
  const rand = opts.random ?? Math.random;

  if (retryAfter) {
    const raw = String(retryAfter).trim();
    let ms = -1;
    if (/^\d+$/.test(raw)) ms = Number(raw) * 1000;
    else {
      const at = Date.parse(raw);
      if (!Number.isNaN(at)) ms = at - (opts.now ?? Date.now());
    }
    // A past date, or a header we could not read, falls through to the curve rather than
    // retrying instantly or waiting forever.
    if (ms >= 0) return Math.min(ms, maxMs);
  }

  const ceiling = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
  return Math.round(rand() * ceiling);
}

/** Attempts INCLUDING the first. Three means one try and two retries, which covers the blip a
 *  poll actually hits without holding a job open long enough to overlap its own next tick: worst
 *  case here is roughly 8 seconds, against a 2 minute Gmail cycle. */
export const MAX_ATTEMPTS = 3;
