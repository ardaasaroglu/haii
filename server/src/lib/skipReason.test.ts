import { explainSkip } from "./skipReason";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "ok" : "FAIL"} · ${name}`);
  if (!ok) failures++;
}
const says = (detail: string, re: RegExp) => re.test(explainSkip(detail) ?? "");

console.log("\n--- the failures a person can fix ---");
check("no key names the setting and the file", says("skipped: no_claude_key", /ANTHROPIC_API_KEY.*server\/\.env/));
check("a rejected key says so", says("skipped: bad_api_key", /rejected the API key/));
check("out of credit says so", says("skipped: no_credit", /out of credit/));
check("rate limited says to wait", says("skipped: rate_limited:429", /rate limiting.*Try again/));
check("overloaded is not blamed on the key", says("skipped: rate_limited:529", /overloaded/) && !says("skipped: rate_limited:529", /this key/));
check("a cut-off reply suggests a shorter paste", says("skipped: max_tokens", /cut off.*shorter/));
check("a decline is named", says("skipped: refusal", /declined/));
check("an unreadable reply", says("skipped: invalid_json", /could not be read/) && says("skipped: empty_response", /could not be read/));
check("the daily cap names the way out", says("skipped: user_daily_cap", /spend cap.*server\/\.env/) && says("skipped: budget_hard_cap", /spend cap/));
check("the monthly cap names its own setting", says("skipped: monthly_cap", /MONTHLY_CAP_USD/));
check("an API error carries its status", says("skipped: api_error:500", /\(500\)/));
check("an API error with no status still reads", says("skipped: api_error", /returned an error\. Try again/));

console.log("\n--- what must be left alone ---");
// These are not failures. Turning them into an error would tell someone their paste broke when it
// was simply read already.
check("already extracted is not a failure", explainSkip("skipped: already extracted") === null);
check("too short is not a failure", explainSkip("skipped: too short after cleaning (120 chars)") === null);
check("a success line is not a failure", explainSkip('3 cards from "Renewal" ($0.021)') === null);
check("an unknown reason is not guessed at", explainSkip("skipped: something_new") === null);
check("empty input is handled", explainSkip("") === null && explainSkip(null) === null && explainSkip(undefined) === null);

console.log("\n--- no internal names reach the screen ---");
const all = ["no_claude_key", "bad_api_key", "no_credit", "rate_limited:429", "rate_limited:529", "refusal", "max_tokens", "invalid_json", "empty_response", "monthly_cap", "budget_hard_cap", "user_daily_cap", "api_error:400"];
check("every sentence ends as a sentence", all.every((r) => /[.]$/.test(explainSkip(`skipped: ${r}`) ?? "")));
check("none of them shows the raw reason", all.every((r) => !(explainSkip(`skipped: ${r}`) ?? "").includes(r.split(":")[0])));

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
