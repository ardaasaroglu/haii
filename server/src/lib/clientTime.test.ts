/** Tests the PWA's wall-clock formatter by reading it out of server/public/index.html.
 *
 *  Unusual, and deliberate. There is no client test runner, the page script is wrapped in an IIFE
 *  so fmtWallTime cannot be reached from a browser console, and on a dev machine with a 24-hour
 *  locale the 12-hour branch is exactly the one that can never be exercised by looking at the screen.
 *  That branch is the whole point of the change: a US user reads 2:00 PM, not 14:00.
 *
 *  Reading the real source rather than a copy is what makes this worth keeping. A copy would pass
 *  forever while the shipped function rotted.
 *
 *  Pure: no browser, no database. `npm test -w @haii/server`
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, String(got) === String(want), `got ${got}, want ${want}`);

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "..", "public", "index.html"), "utf8");

// Non-greedy to the first closing brace at column 0. Brace COUNTING would be wrong here: the body
// contains /^(\d{1,2}):(\d{2})$/ and those braces are not block delimiters.
const src = /function fmtWallTime\(t\)\{[\s\S]*?\n\}/.exec(html)?.[0];
check("fmtWallTime found in index.html", Boolean(src), "the function was renamed or reformatted");
if (!src) {
  console.log("\n1 FAILED");
  process.exit(1);
}

/** Build the shipped function with HOUR12 pinned, which is the one input a test cannot get from
 *  the host machine's own locale. */
function build(hour12: boolean): (t: unknown) => string {
  return new Function("HOUR12", `${src}\nreturn fmtWallTime;`)(hour12) as (t: unknown) => string;
}
const h12 = build(true);
const h24 = build(false);

console.log("\n--- a US reader (12h) ---");
eq("afternoon", h12("14:00"), "2:00 PM");
eq("morning", h12("09:30"), "9:30 AM");
eq("midnight is 12 AM, not 0 AM", h12("00:00"), "12:00 AM");
eq("noon is 12 PM, not 0 PM", h12("12:00"), "12:00 PM");
eq("just before noon", h12("11:59"), "11:59 AM");
eq("just after noon", h12("12:01"), "12:01 PM");
eq("last minute of the day", h12("23:59"), "11:59 PM");
eq("single-digit hour input", h12("9:05"), "9:05 AM");

console.log("\n--- a Turkish or European reader (24h) ---");
eq("afternoon stays put", h24("14:00"), "14:00");
eq("morning is zero padded", h24("9:30"), "09:30");
eq("midnight", h24("00:00"), "00:00");
eq("noon", h24("12:00"), "12:00");

console.log("\n--- never mangle what it does not understand ---");
// The payload is the commitment. Anything unparseable must survive untouched rather than be
// rewritten into something that looks confident and is wrong.
for (const junk of ["", "tomorrow", "14:00:00", "2 PM", "25:00", "14:99", "1400"]) {
  eq(`passthrough ${JSON.stringify(junk)}`, h12(junk), junk);
}
eq("null", h12(null), "");
eq("undefined", h12(undefined), "");

console.log("\n--- the payload shape the executor requires is untouched ---");
// fmtWallTime is display only. executor.ts validates the PAYLOAD with /^\d{1,2}:\d{2}$/, so this
// asserts the two never got wired together: formatting must not be what gets stored.
check("12h output would NOT pass the executor regex", !/^\d{1,2}:\d{2}$/.test(h12("14:00")));
check("which is why the edit field is labelled 24h", /"time","Start \(24h\)"/.test(html));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
