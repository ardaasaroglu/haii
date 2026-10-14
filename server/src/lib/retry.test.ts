/** Tests for lib/retry.ts: which provider responses are worth trying again, and how long to wait.
 *
 *  The method rule is the one worth being careful about. Retrying a 5xx on a POST is not a
 *  performance question, it is how you create the same calendar event twice, so these assertions
 *  are guarding correctness rather than politeness.
 *
 *  Pure: no database, no network, no wall clock. `npx tsx src/lib/retry.test.ts`
 */
import { shouldRetry, retryDelayMs, MAX_ATTEMPTS } from "./retry";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, String(got) === String(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log("\n--- what is worth retrying at all ---");
eq("429, the case this exists for", shouldRetry(429), "true");
eq("503, a provider blip", shouldRetry(503), "true");
eq("500", shouldRetry(500), "true");
eq("502", shouldRetry(502), "true");
eq("504", shouldRetry(504), "true");
eq("408 request timeout, nothing was processed", shouldRetry(408), "true");
eq("200 is not a failure", shouldRetry(200), "false");
eq("404 will fail identically forever", shouldRetry(404), "false");
eq("400 means we asked wrongly", shouldRetry(400), "false");
// Retrying these delays the honest answer. The user needs to reconnect, not wait 8 seconds.
eq("401 needs a reconnect, not a retry", shouldRetry(401), "false");
eq("403 needs a scope, not a retry", shouldRetry(403), "false");

console.log("\n--- the method rule: a 5xx is ambiguous, and duplicates are worse than failures ---");
{
  // The server may have created the calendar event and failed to tell us. Retrying puts a second
  // one in someone's calendar, which is a far worse outcome than the job failing honestly.
  eq("5xx on POST is NOT retried", shouldRetry(503, "POST"), "false");
  eq("5xx on PUT is NOT retried", shouldRetry(500, "PUT"), "false");
  eq("5xx on PATCH is NOT retried", shouldRetry(502, "PATCH"), "false");
  eq("5xx on DELETE is NOT retried", shouldRetry(504, "DELETE"), "false");
  eq("5xx on GET is retried, GET is idempotent", shouldRetry(503, "GET"), "true");
  eq("method is case-insensitive", shouldRetry(503, "get"), "true");
  eq("HEAD too", shouldRetry(503, "HEAD"), "true");

  // A rate limit is a REFUSAL to process, so nothing happened and repeating it cannot duplicate
  // anything. This is what makes drafting and event creation safe to retry on the common case.
  eq("429 on POST IS retried, nothing was processed", shouldRetry(429, "POST"), "true");
  eq("429 on DELETE too", shouldRetry(429, "DELETE"), "true");
}

console.log("\n--- Retry-After, because the provider knows better than our curve ---");
{
  const NOW = Date.parse("2026-08-04T12:00:00Z");
  eq("delta-seconds is honoured", retryDelayMs(1, "2", { now: NOW }), "2000");
  eq("an HTTP date is honoured", retryDelayMs(1, "Tue, 04 Aug 2026 12:00:03 GMT", { now: NOW }), "3000");
  // A hostile or mistaken header must not park a poll for an hour.
  eq("an absurd value is capped", retryDelayMs(1, "9999", { now: NOW, maxMs: 8000 }), "8000");
  // A date already in the past would otherwise mean "retry instantly", hammering a struggling API.
  check(
    "a past date falls through to the curve, not to zero",
    retryDelayMs(1, "Tue, 04 Aug 2026 11:59:00 GMT", { now: NOW, random: () => 1 }) === 500,
    String(retryDelayMs(1, "Tue, 04 Aug 2026 11:59:00 GMT", { now: NOW, random: () => 1 })),
  );
  eq("garbage falls through too", retryDelayMs(1, "soon", { now: NOW, random: () => 1 }), "500");
  eq("absent falls through", retryDelayMs(1, null, { random: () => 1 }), "500");
}

console.log("\n--- backoff shape ---");
{
  const full = (a: number) => retryDelayMs(a, null, { random: () => 1 });
  eq("attempt 1 ceiling is the base", full(1), "500");
  eq("attempt 2 doubles", full(2), "1000");
  eq("attempt 3 doubles again", full(3), "2000");
  eq("and it is capped", retryDelayMs(9, null, { random: () => 1 }), "8000");
  // Full jitter, and it is not decoration: every user's polls fire on the same cron tick, so a
  // provider blip hits them together. A fixed backoff would march them all back in lockstep and
  // rebuild the spike that caused it.
  eq("jitter can return near zero", retryDelayMs(3, null, { random: () => 0 }), "0");
  check("jitter never exceeds the ceiling", [0, 0.25, 0.5, 0.99, 1].every((r) => retryDelayMs(3, null, { random: () => r }) <= 2000));
}

console.log("\n--- the budget ---");
{
  // Three attempts, worst case ~8s of waiting, against a 2 minute Gmail cycle. A job must not stay
  // open long enough to collide with its own next tick.
  eq("three attempts means one try and two retries", MAX_ATTEMPTS, "3");
  const worst = [1, 2].reduce((s, a) => s + retryDelayMs(a, null, { random: () => 1 }), 0);
  check("worst-case wait stays well inside the shortest poll cycle", worst <= 10_000, `${worst}ms`);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
