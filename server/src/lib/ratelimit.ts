/** Per-user rate limiting on the endpoints that spend money.
 *
 *  Without this, the only brake on a user pasting transcripts in a loop is the budget ladder, which
 *  is the wrong instrument for two reasons: it trips at the GLOBAL cap, so one account's loop
 *  pauses Haii for everybody, and by the time it fires the money is already gone. A rate limit
 *  stops the tenth call; a budget cap notices after the fiftieth.
 *
 *  IN-MEMORY, AND THAT IS A REAL LIMITATION worth stating rather than discovering. Counters live in
 *  this process, so they reset on every deploy and would not be shared if this ever runs on more
 *  than one instance. On a single container where deploys are rare, this buys most of the
 *  protection for none of the infrastructure. The moment there are two instances this
 *  needs to move to the database or a shared store, and the honest signal for that is the day
 *  someone adds a second replica.
 *
 *  It deliberately does NOT limit reads. Every expensive path is a POST, and rate-limiting the feed
 *  would punish a user for having the app open.
 */
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./session";
import { log } from "../log";

interface Bucket {
  /** Timestamps of the calls still inside the window, oldest first. */
  hits: number[];
}

const buckets = new Map<string, Bucket>();

/** Dropped when the window has fully passed, so an idle user costs no memory. Runs on write rather
 *  than on a timer: a sweeping interval would keep the process awake for nothing. */
function prune(now: number, windowMs: number): void {
  if (buckets.size < 500) return;
  for (const [k, b] of buckets) {
    if (!b.hits.length || now - b.hits[b.hits.length - 1] > windowMs) buckets.delete(k);
  }
}

export interface LimitOpts {
  /** Distinguishes one limiter from another for the same user. */
  name: string;
  limit: number;
  windowMs: number;
}

/** Returns true when the call is allowed, and records it. */
export function allow(key: string, opts: LimitOpts, now = Date.now()): boolean {
  const id = `${opts.name}:${key}`;
  const b = buckets.get(id) ?? { hits: [] };
  // Sliding window rather than a fixed one: a fixed window lets someone spend the whole allowance
  // at 09:59 and the whole next allowance at 10:00, which is double the intended rate at the
  // moment it matters most.
  const cutoff = now - opts.windowMs;
  b.hits = b.hits.filter((t) => t > cutoff);
  if (b.hits.length >= opts.limit) {
    buckets.set(id, b);
    return false;
  }
  b.hits.push(now);
  buckets.set(id, b);
  prune(now, opts.windowMs);
  return true;
}

/** Middleware form. Keyed on the authenticated user, so it must sit AFTER requireUser. */
export function rateLimit(opts: LimitOpts) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const uid = (c.get("userId") as string) || "anon";
    if (!allow(uid, opts)) {
      log.warn({ userId: uid, limiter: opts.name }, "rate limited");
      // 429 with a plain sentence: this reaches a person, and "rate limit exceeded" tells them
      // nothing about what to do. Retry-After is the machine-readable half.
      c.header("Retry-After", String(Math.ceil(opts.windowMs / 1000)));
      return c.json(
        { error: "That is a lot at once. Give it a minute and try again." },
        429,
      );
    }
    await next();
  });
}

/** Reset, for tests only. */
export function __clearLimits(): void {
  buckets.clear();
}
