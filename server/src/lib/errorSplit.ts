/** Who is allowed to read a thrown error.
 *
 *  Its own module, with NO database import, for the same reason lib/metrics.ts keeps to
 *  `../db/schema`: lib/failures.ts imports `../db`, which opens PGlite as an import-time side
 *  effect, so anything living there cannot be tested without a database. This is a pure decision
 *  about a string and it must stay cheap to test.
 *
 *  The rule it enforces is old and is stated in CLAUDE.md: users never see raw provider errors.
 *  What was missing was any way for a catch block to tell a sentence written for a person from a
 *  provider's status code and JSON body, so jobs/executor.ts treated every message as safe. That
 *  once put a raw Gmail 400 body on a user's Today screen and into their Telegram messages.
 */

/** An error whose message was WRITTEN FOR THE USER and is safe to put on their screen.
 *
 *  A marker class rather than a prefix convention or a regex over the text, because "did a person
 *  write this sentence for another person" is not a question you can answer by inspecting a string.
 *  Anything not marked is assumed to be a provider's own words, which is the safe default: a new
 *  throw added later leaks nothing until someone deliberately marks it. */
export class UserFacingError extends Error {}

/** Split a caught error into the half the user sees and the half only the operator sees.
 *
 *  `fallback` is what the user is told for anything not marked safe. Callers pass one that names
 *  the DESTINATION, because "Jira would not accept this" tells someone which card to go and fix
 *  while "something went wrong" tells them nothing. The provider's actual words always survive, in
 *  `operatorNote`, which reaches Telegram and never the database row behind the banner. */
export function splitError(e: unknown, fallback: string): { detail: string; operatorNote?: string } {
  const raw = String((e as { message?: unknown } | null)?.message ?? e).slice(0, 300);
  if (e instanceof UserFacingError) return { detail: raw };
  return { detail: fallback, operatorNote: raw };
}
