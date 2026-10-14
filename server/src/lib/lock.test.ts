/** Tests for the database lockfile verdict.
 *
 *  Written after a dev server "hung" for 17 minutes with a healthy-looking process tree, no port,
 *  and nothing in any log. The old check was `process.kill(pid, 0)` against a bare pid, which
 *  answers "is SOME process alive with this number", not "is the holder alive". Combine that with
 *  a lockfile left behind by any hard kill and Windows recycling pids, and the server exits(1)
 *  silently while the tsx watch supervisor stays up.
 *
 *  Pure: no filesystem, no real process table. `npm test -w @haii/server`
 */
import { lockVerdict, parseLock, serializeLock, STALE_AFTER_MS } from "./lock";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, String(got) === String(want), `got ${got}, want ${want}`);

const NOW = new Date("2026-07-29T14:00:00.000Z");
const alive = () => true;
const dead = () => false;
const at = (msAgo: number) => serializeLock(4242, new Date(NOW.getTime() - msAgo));

console.log("\n--- reading the file ---");
eq("round trips a pid", parseLock(serializeLock(99, NOW))?.pid, 99);
eq("records when it was taken", parseLock(serializeLock(99, NOW))?.at, NOW.toISOString());
eq("legacy bare pid still readable", parseLock("35068")?.pid, 35068);
eq("legacy bare pid has no timestamp", parseLock("35068")?.at, "undefined");
eq("empty file", parseLock(""), "null");
eq("whitespace", parseLock("   \n"), "null");
eq("garbage", parseLock("not a lock"), "null");
eq("json without a pid", parseLock('{"at":"2026-01-01T00:00:00Z"}'), "null");
eq("negative pid rejected", parseLock('{"pid":-1}'), "null");
eq("zero pid rejected", parseLock("0"), "null");

console.log("\n--- the holder is gone ---");
eq("dead pid, take it", lockVerdict(at(60_000), dead, NOW).action, "take");
eq("no file at all, take it", lockVerdict("", alive, NOW).action, "take");
eq("unreadable file, take it", lockVerdict("garbage", alive, NOW).action, "take");

console.log("\n--- the holder is genuinely running ---");
eq("fresh lock, live pid, refuse", lockVerdict(at(60_000), alive, NOW).action, "refuse");
eq("an hour old, live pid, refuse", lockVerdict(at(3600_000), alive, NOW).action, "refuse");
const refused = lockVerdict(at(5 * 60_000), alive, NOW);
check("refusal names the pid", refused.action === "refuse" && refused.pid === 4242);
check("refusal explains itself", refused.reason.includes("4242") && /ago/.test(refused.reason), refused.reason);

console.log("\n--- the bug this was written for ---");
// Force-quit yesterday, start today, pid recycled onto an unrelated live process. The old code
// refused here and said nothing anywhere visible.
const old = at(STALE_AFTER_MS + 60_000);
eq("stale lock with a live (recycled) pid is taken over", lockVerdict(old, alive, NOW).action, "take");
check("and says why", lockVerdict(old, alive, NOW).reason.includes("recycled"), lockVerdict(old, alive, NOW).reason);
// Just inside the window is still a refusal: a real dev server running 11h is plausible.
eq("just inside the window still refuses", lockVerdict(at(STALE_AFTER_MS - 60_000), alive, NOW).action, "refuse");

console.log("\n--- clock and legacy edge cases ---");
// A legacy bare-pid lock cannot prove age, so a live pid is still a refusal. It must be LOUD,
// which is the caller's job, but it must not silently take over a database either.
eq("legacy lock, live pid, refuse", lockVerdict("4242", alive, NOW).action, "refuse");
eq("legacy lock, dead pid, take", lockVerdict("4242", dead, NOW).action, "take");
eq("corrupt timestamp, live pid, refuse", lockVerdict('{"pid":4242,"at":"nonsense"}', alive, NOW).action, "refuse");
// A lock stamped in the future means a clock jump, not a live holder.
eq("future timestamp is taken over", lockVerdict(at(-10 * 60_000), alive, NOW).action, "take");
// A few seconds of skew is not a future lock.
eq("small skew still refuses", lockVerdict(at(-5_000), alive, NOW).action, "refuse");

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
