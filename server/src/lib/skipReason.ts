/** What every LLM job returns when no key is set, and the sentence a person is shown for it. */
export const NO_KEY_REASON = "no_claude_key";
export const NO_KEY_MESSAGE = "No Claude API key is set. Add ANTHROPIC_API_KEY to server/.env and restart Haii.";

/** A model call that produced nothing comes back from the job layer as "skipped: <reason>".
 *
 *  That string is right for a log and useless on a screen. The paste box used to show it under the
 *  heading "Transcript ingested", so a wrong API key looked like a quiet success with no cards.
 *  This turns the reasons a person can act on into one sentence that says what to do.
 *
 *  Returns null for anything that is not a failed model call ("already extracted", "too short"),
 *  so a benign skip keeps its own wording. Pure, so it is tested without booting anything. */
export function explainSkip(detail: string | null | undefined): string | null {
  const m = /^skipped: (\S+)/.exec(detail ?? "");
  if (!m) return null;
  const reason = m[1];
  if (reason === NO_KEY_REASON) return NO_KEY_MESSAGE;
  if (reason === "bad_api_key") return "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in server/.env and restart Haii.";
  if (reason === "no_credit") return "The Anthropic account behind this key is out of credit. Add credit at platform.claude.com.";
  if (reason === "rate_limited:529") return "Anthropic is overloaded right now. Try again in a minute.";
  if (reason.startsWith("rate_limited")) return "Anthropic is rate limiting this key right now. Try again in a minute.";
  if (reason === "refusal") return "Claude declined to read this one.";
  if (reason === "max_tokens") return "Claude's reply was cut off before it finished. Try a shorter part of the meeting.";
  if (reason === "invalid_json" || reason === "empty_response") return "Claude's reply could not be read. Try again.";
  if (reason === "monthly_cap") return "This month's spend cap is reached, so reading is paused. Raise MONTHLY_CAP_USD in server/.env to continue.";
  if (reason === "budget_hard_cap" || reason === "user_daily_cap") return "Today's spend cap is reached, so reading is paused until tomorrow. Raise the cap in server/.env to continue.";
  if (reason.startsWith("api_error")) {
    const status = reason.split(":")[1];
    return `The Claude API returned an error${status ? ` (${status})` : ""}. Try again.`;
  }
  return null;
}
