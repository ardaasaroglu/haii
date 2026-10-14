/** Tests for brief-batch request identity.
 *
 *  The bug: custom_id was the meeting id, meeting ids are `mtg_<userId>_<googleEventId>`, and the
 *  Message Batches API caps custom_id at 64 characters. The API validates the whole create call,
 *  so one oversized id rejected the ENTIRE batch. The user lost every pre-generated brief that day
 *  and saw a raw provider error on their home screen.
 *
 *  Pure functions only: no database, no HTTP. `npm test -w @haii/server`
 */
import { briefCustomId, resolveBriefMeetingId } from "./batch";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, String(got) === String(want), `got ${got}, want ${want}`);

const LIMIT = 64;

console.log("\n--- the arithmetic that broke it ---");
// Ids with the shape and length of real ones.
const ownerRecurring = "mtg_owner_a1b2c3d4e5f6g7h8i9j0k1l2m3_20260729T131500Z";
eq("the local owner's recurring instance length", ownerRecurring.length, 53);
check("the local owner fits, which is why a single-user install never sees this", ownerRecurring.length <= LIMIT);

// Same Google event, a generated user id: every signed-in account is `u_` + 10 hex.
const genPrefix = "mtg_u_0123456789_";
eq("generated-user prefix length", genPrefix.length, 17);
const genRecurring = genPrefix + "a1b2c3d4e5f6g7h8i9j0k1l2m3_20260729T131500Z";
eq("generated user, native recurring event", genRecurring.length, 60);
check("fits, but with only 4 characters to spare", genRecurring.length <= LIMIT);

// An imported invite (Outlook/Teams/Zoom interop) carries a much longer Google id.
const imported = genPrefix + "040000008200E00074C5B7101A82E00800000000A1B2C3D4E5F60000000000000000";
check("an imported invite overflows", imported.length > LIMIT, `${imported.length} chars`);

console.log("\n--- the fix: position, not identity ---");
eq("first request", briefCustomId(0), "b0");
eq("tenth request", briefCustomId(9), "b9");
check("a position id is nowhere near the cap", briefCustomId(999).length <= LIMIT);
// The point of the fix: bounded by meetings per day, so no id length can ever regress it.
check("still fine for an absurd day", briefCustomId(100000).length <= LIMIT);

console.log("\n--- resolving results back to meetings ---");
const ordered = ["mtg_u_1_aaa", "mtg_u_1_bbb", "mtg_u_1_ccc"];
eq("position 0", resolveBriefMeetingId("b0", ordered), "mtg_u_1_aaa");
eq("position 2", resolveBriefMeetingId("b2", ordered), "mtg_u_1_ccc");
// Batch results arrive unordered, so a middle position must not depend on arrival order.
eq("position 1 out of order", resolveBriefMeetingId("b1", ordered), "mtg_u_1_bbb");
eq("position past the end is dropped, not guessed", resolveBriefMeetingId("b9", ordered), "null");

console.log("\n--- batches already in flight when this ships ---");
// A batch submitted before the change is live for up to 24h and carries a raw meeting id with no
// custom_ids on its row. Refusing those would discard exactly the briefs this change protects.
eq("legacy row, raw meeting id", resolveBriefMeetingId(ownerRecurring, null), ownerRecurring);
eq("legacy row, undefined column", resolveBriefMeetingId(ownerRecurring, undefined), ownerRecurring);
eq("empty array is treated as legacy", resolveBriefMeetingId(ownerRecurring, []), ownerRecurring);
// Defensive: an unexpected shape falls through to the legacy reading rather than being dropped.
// A wrong-but-checkable meeting id fails the existence check downstream; a dropped result is silent.
eq("non-array column", resolveBriefMeetingId(ownerRecurring, { nope: 1 }), ownerRecurring);
eq("unrecognised custom_id shape", resolveBriefMeetingId("mtg_weird", ordered), "mtg_weird");

console.log("\n--- junk in ---");
eq("empty custom_id", resolveBriefMeetingId("", ordered), "null");
eq("non-string custom_id", resolveBriefMeetingId(42, ordered), "null");
eq("null custom_id", resolveBriefMeetingId(null, ordered), "null");
eq("hole in the ordered list", resolveBriefMeetingId("b1", ["a", null, "c"]), "null");

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
