/** Who holds the embedded database, and whether to believe them.
 *
 *  PGlite is strictly single-writer, so the dev server writes a lockfile and refuses to start if
 *  another instance holds it. The refusal is right; the evidence was not. The old lockfile held a
 *  bare pid and the check was `process.kill(pid, 0)`, which answers "is SOME process alive with
 *  this number", not "is the holder alive".
 *
 *  On Windows pids recycle quickly, and the lockfile is left behind by any hard kill (Ctrl-C is
 *  fine, `timeout`, a killed terminal or a force-quit are not, because the exit handler never
 *  runs). So the common sequence is: force-quit the dev server, start it again some time later,
 *  the recycled pid belongs to an unrelated live process, and the server exits(1) while the
 *  `tsx watch` supervisor stays up. The result is a process tree that looks healthy, no port, and
 *  no error anywhere the operator will look. That is roughly an hour of confusion, and it is worth
 *  a file to make it impossible.
 *
 *  Two changes: the lock records WHEN it was taken, and a lock older than STALE_AFTER_MS is taken
 *  over even if its pid looks alive, because a dev server genuinely running for that long is far
 *  less likely than a recycled pid. Legacy bare-pid locks are still read so an upgrade does not
 *  strand anyone.
 *
 *  Pure so it can be tested without a filesystem or a real process table.
 */

/** A dev server running longer than this is less likely than a recycled pid. */
export const STALE_AFTER_MS = 12 * 3600_000;

export interface LockFile {
  pid: number;
  /** ISO timestamp the lock was taken. Absent on legacy bare-pid locks. */
  at?: string;
}

export type LockVerdict =
  | { action: "take"; reason: string }
  | { action: "refuse"; pid: number; reason: string };

export function serializeLock(pid: number, now: Date): string {
  return JSON.stringify({ pid, at: now.toISOString() });
}

/** Tolerant on purpose: an unreadable or malformed lock is a reason to take over, never to crash.
 *  Returns null when nothing usable is in the file. */
export function parseLock(raw: string): LockFile | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    const o: unknown = JSON.parse(text);
    // Only an OBJECT is the new format. JSON.parse succeeds on a bare number too, so a legacy
    // "35068" lock parses cleanly as 35068 and reading `.pid` off it yields undefined. Treating
    // that as unparseable would silently take over a database another process is writing to,
    // which is the exact corruption the lock exists to prevent.
    if (o && typeof o === "object") {
      const pid = Number((o as { pid?: unknown }).pid);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const at = (o as { at?: unknown }).at;
      return { pid, at: typeof at === "string" ? at : undefined };
    }
  } catch {
    /* not JSON: fall through to the legacy reading below */
  }
  // Legacy format: the file was just the pid.
  const pid = Number(text);
  return Number.isInteger(pid) && pid > 0 ? { pid } : null;
}

/** `isAlive` is injected so this stays pure; production passes a process.kill(pid, 0) probe. */
export function lockVerdict(
  raw: string,
  isAlive: (pid: number) => boolean,
  now: Date = new Date(),
): LockVerdict {
  const lock = parseLock(raw);
  if (!lock) return { action: "take", reason: "lockfile empty or unreadable" };
  if (!isAlive(lock.pid)) return { action: "take", reason: `pid ${lock.pid} is gone` };

  const takenAt = lock.at ? Date.parse(lock.at) : NaN;
  if (!Number.isFinite(takenAt)) {
    // Legacy lock, or a corrupt timestamp. The pid looks alive but we cannot tell whether it is
    // the holder or a recycled number, and refusing on that evidence is what caused the silent
    // no-start. Refuse, but the caller says so loudly and names the file.
    return { action: "refuse", pid: lock.pid, reason: `pid ${lock.pid} is alive and the lock has no timestamp` };
  }
  const ageMs = now.getTime() - takenAt;
  if (ageMs > STALE_AFTER_MS) {
    return {
      action: "take",
      reason: `lock is ${Math.round(ageMs / 3600_000)}h old, so pid ${lock.pid} is almost certainly recycled`,
    };
  }
  // A clock that jumped backwards, or a lock written by a future run. Not evidence of a live
  // holder, and treating it as one strands the developer.
  if (ageMs < -60_000) {
    return { action: "take", reason: "lock timestamp is in the future, treating as stale" };
  }
  return { action: "refuse", pid: lock.pid, reason: `pid ${lock.pid} took the lock ${Math.max(0, Math.round(ageMs / 60_000))}m ago` };
}
