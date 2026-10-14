/** The user/operator error split, tested without a database.
 *
 *  The invariant under test is "users never see raw provider errors". It was written down long
 *  before anything enforced it, and in that gap a raw Gmail 400 body reached a user's Today screen.
 *  The cases below are the two halves that matter: a provider's words must never survive into what
 *  the user reads, and a sentence written FOR the user must survive intact rather than being
 *  flattened into a generic apology.
 */
import { splitError, UserFacingError } from "./errorSplit";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "ok" : "FAIL"} · ${name}`);
  if (!ok) failures++;
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) console.log(`   got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  check(name, ok);
}

const FB = "Gmail would not accept this draft. Edit the card and approve again.";
const GMAIL_400 =
  'gmail draft 400: { "error": { "code": 400, "message": "Invalid To header", "status": "INVALID_ARGUMENT" } }';

console.log("\n--- a provider's own words never reach the user ---");
const raw = splitError(new Error(GMAIL_400), FB);
eq("the user gets the fallback", raw.detail, FB);
check("the raw body is kept for the operator", raw.operatorNote === GMAIL_400);
check("no status code leaks into the user's copy", !/\b\d{3}\b/.test(raw.detail));
check("no JSON leaks into the user's copy", !raw.detail.includes("{"));

console.log("\n--- a sentence written for the user survives intact ---");
const safe = splitError(new UserFacingError("This card has no recipient. Edit it and approve again."), FB);
eq("shown verbatim", safe.detail, "This card has no recipient. Edit it and approve again.");
check("and nothing is sent to the operator", safe.operatorNote === undefined);

console.log("\n--- anything unmarked is treated as unsafe, which is the safe default ---");
check("a plain Error is not trusted", splitError(new Error("anything at all"), FB).detail === FB);
check("a thrown string is not trusted", splitError("boom", FB).detail === FB);
check("a thrown object is not trusted", splitError({ weird: true }, FB).detail === FB);
check("null is not trusted", splitError(null, FB).detail === FB);

console.log("\n--- bounded, because these land in a 500-char column and a Telegram message ---");
const long = splitError(new Error("x".repeat(5000)), FB);
check("the operator note is capped at 300", (long.operatorNote ?? "").length === 300);
const longSafe = splitError(new UserFacingError("y".repeat(5000)), FB);
check("a user-facing message is capped too", longSafe.detail.length === 300);

console.log("\n--- a subclass of UserFacingError is still user-facing ---");
class NoRecipient extends UserFacingError {}
eq("subclass passes through", splitError(new NoRecipient("pick someone"), FB).detail, "pick someone");

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
