/** Tests for lib/manifest.ts: the record of what actually went into a prompt.
 *
 *  This is the keystone of the data boundary, and it is the shape three planned features need: an
 *  outbound provenance gate in the executor, provenance chips, and connector privacy filters. None
 *  of them is built yet. A gate is only as good as the list it reads, so the failure modes worth
 *  testing are the silent ones: an entry dropped by a key collision, or a visibility that defaults
 *  open instead of closed.
 *
 *  Pure: no database, no network, no wall clock. `npx tsx src/lib/manifest.test.ts`
 */
import { buildManifest, src, MANIFEST_LIMIT, type ManifestEntry } from "./manifest";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, String(got) === String(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log("\n--- src(): the default can never be forgotten at a call site ---");
{
  const e = src("item", "it_1", "gmail") as ManifestEntry;
  eq("carries the source table", e.source, "item");
  eq("carries the id", e.id, "it_1");
  eq("carries the connector", e.connector, "gmail");
  // Closed by default, and this is the security-relevant half. A gate that refuses outbound sends
  // containing internal material (planned, not built) needs an unclassified world to be a closed
  // one: a default of external_approved would let anything not yet classified straight out.
  eq("visibility defaults to internal, never open", e.visibility, "internal");
  eq("a missing id is not an entry", src("item", ""), "null");
  eq("a null id is not an entry", src("item", null), "null");
  check("connector is omitted rather than undefined when absent", !("connector" in (src("transcript", "tr_1") as object)));
}

console.log("\n--- de-duplication is on source AND id, because ids collide across tables ---");
{
  const m = buildManifest([src("item", "1", "gmail"), src("item", "1", "gmail"), src("card", "1")]);
  eq("the same row twice is one entry", m.filter((e) => e.source === "item").length, 1);
  // The one that would be invisible in production: a card and a todo can both be id 1, and keying
  // on id alone would silently drop one. A dropped entry is a hole in any gate built on this list.
  eq("a different table with the same id survives", m.length, 2);
  eq("and it is the card", m[1].source, "card");
}

console.log("\n--- order is preserved, so the cap drops the least important ---");
{
  const m = buildManifest([src("transcript", "tr_1"), src("item", "a"), src("todo", "t_1")]);
  eq("first in, first out", m.map((e) => e.id).join(","), "tr_1,a,t_1");
}
{
  const many = Array.from({ length: MANIFEST_LIMIT + 25 }, (_, i) => src("item", `it_${i}`));
  const m = buildManifest(many);
  eq("capped", m.length, MANIFEST_LIMIT);
  eq("kept the earliest, which is the highest-value context", m[0].id, "it_0");
  eq("and dropped the tail", m[m.length - 1].id, `it_${MANIFEST_LIMIT - 1}`);
}

console.log("\n--- rubbish in the list cannot corrupt the manifest ---");
{
  const m = buildManifest([null, undefined, src("item", "ok"), { source: "item", id: "", visibility: "internal" }]);
  eq("nulls and empty ids are skipped, not stored", m.length, 1);
  eq("the real one survives", m[0].id, "ok");
}
{
  // An unrecognised visibility must fall CLOSED. Anything else and a typo, or a value from an
  // older row, quietly grants an export.
  const m = buildManifest([{ source: "item", id: "x", visibility: "public" as never }]);
  eq("an unknown visibility is treated as internal", m[0].visibility, "internal");
  const ok = buildManifest([{ source: "item", id: "y", visibility: "external_approved" }]);
  eq("but a real external_approved is kept", ok[0].visibility, "external_approved");
}
{
  const m = buildManifest([{ source: "item", id: 42 as never, visibility: "internal" }]);
  eq("a numeric id is normalised to a string, so keys compare properly", m[0].id, "42");
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
