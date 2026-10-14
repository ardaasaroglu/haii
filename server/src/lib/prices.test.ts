import { priceFor } from "./prices";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "ok" : "FAIL"} · ${name}`);
  if (!ok) failures++;
}

const TABLE: Record<string, [number, number]> = {
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [3, 15],
  "claude-haiku-4-5": [1, 5],
};
const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
const at = (model: string) => priceFor(model, TABLE, "claude-sonnet-5-5");

console.log("\n--- the name that was asked for ---");
check("an exact name", same(at("claude-haiku-4-5"), [1, 5]));
check("the default model", same(at("claude-sonnet-5-5"), [2, 10]));

console.log("\n--- the dated name the API reports back ---");
// The real case: a call to the small model came back as "claude-haiku-4-5-20251001" and was
// billed at the default model's rate.
check("a dated small model is billed as the small model", same(at("claude-haiku-4-5-20251001"), [1, 5]));
check("a dated default model", same(at("claude-sonnet-5-5-20260101"), [2, 10]));

console.log("\n--- one name inside another ---");
check("the longer name wins for itself", same(at("claude-sonnet-5-5"), [2, 10]));
check("the shorter name is still found", same(at("claude-sonnet-5"), [3, 15]));
check("a dated shorter name is not taken for the longer one", same(at("claude-sonnet-5-20250929"), [3, 15]));
check("a name that only shares a prefix is not matched", same(at("claude-haiku-4-55"), [2, 10]));

console.log("\n--- a model that is not in the table ---");
check("falls back to the default row", same(at("some-other-model"), [2, 10]));
check("an empty name falls back too", same(at(""), [2, 10]));

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
