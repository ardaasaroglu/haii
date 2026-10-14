/** Tests for withinSyncHorizon, the growth guard connectors/gcal.ts's upsertMeeting checks before
 *  persisting a still-scheduled occurrence.
 *
 *  This exists because of a real bug: the meetings table grew without limit. singleEvents=true
 *  expands a recurring series into one row per occurrence, and once a poll is running off a
 *  syncToken (true for almost every poll; a syncToken cannot be combined with timeMin/timeMax)
 *  nothing bounded how far into the future a changed series could expand, so growth had no ceiling.
 *
 *  Pure function only: no database, no HTTP, per lib/meeting.ts's own dependency-free contract.
 *  `npm test -w @haii/server` */
import { SYNC_HORIZON_DAYS, withinSyncHorizon, wholeWordPattern } from "./meeting";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, String(got) === String(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const NOW = new Date("2026-07-30T12:00:00.000Z");
const HORIZON_MS = SYNC_HORIZON_DAYS * 24 * 3600_000;

console.log("\n--- withinSyncHorizon: the growth guard ---");
check("a meeting later today is in horizon", withinSyncHorizon(new Date("2026-07-30T18:00:00.000Z"), NOW));
check(
  "a meeting tomorrow is in horizon",
  withinSyncHorizon(new Date(NOW.getTime() + 24 * 3600_000), NOW),
);
check(
  `exactly ${SYNC_HORIZON_DAYS} days out is still in horizon (inclusive bound)`,
  withinSyncHorizon(new Date(NOW.getTime() + HORIZON_MS), NOW),
);
check(
  `one minute past ${SYNC_HORIZON_DAYS} days out is not`,
  !withinSyncHorizon(new Date(NOW.getTime() + HORIZON_MS + 60_000), NOW),
);
check(
  "a recurring instance expanded a year out is rejected",
  !withinSyncHorizon(new Date("2027-07-30T12:00:00.000Z"), NOW),
);
check(
  "an already-happened meeting has no lower bound here (only a forward cap)",
  withinSyncHorizon(new Date("2020-01-01T00:00:00.000Z"), NOW),
);
check(
  "starting at this exact instant is in horizon",
  withinSyncHorizon(NOW, NOW),
);

console.log("\n--- wholeWordPattern: the brief that discussed the wrong Sam ---");
{
  // A brief for a meeting with Samantha Reyes once discussed Slack DMs with Sam Okafor, on
  // unrelated topics. Retrieval matched attendee names with ILIKE '%name%', so a short
  // first name matched inside ordinary words and pulled unrelated items in as "relevant" context.
  //
  // The \m and \M boundaries are Postgres's own and are not asserted here. What IS asserted is that
  // we hand it a pattern meaning what we think, with any regex syntax in a person's name defused.
  eq("wrapped in Postgres word boundaries", wholeWordPattern("Sam"), "\\mSam\\M");
  eq("case is preserved, the ~* operator folds it", wholeWordPattern("Samantha"), "\\mSamantha\\M");
  // Unescaped, a full stop is a wildcard: "J." would match "Ja", "Jo", any letter at all. Worse, an
  // unbalanced bracket is invalid regex and Postgres errors the whole query, killing the brief.
  eq("a full stop is escaped, not left as a wildcard", wholeWordPattern("J."), "\\mJ\\.\\M");
  eq("brackets cannot open a group", wholeWordPattern("Sam (Ops)"), "\\mSam \\(Ops\\)\\M");
  eq("a plus cannot become a quantifier", wholeWordPattern("A+B"), "\\mA\\+B\\M");
  eq("empty is handled rather than thrown", wholeWordPattern(""), "\\m\\M");
  // The property the individual cases are examples of: nothing between the boundaries is still
  // live regex syntax.
  const inner = wholeWordPattern("a.b*c(d)[e]|f+g?h^i$j{k}").slice(2, -2);
  check("no metacharacter survives unescaped", !/(^|[^\\])[.*+?^${}()|[\]]/.test(inner), inner);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);

