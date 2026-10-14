/** The north star, defined so it can survive being asked what it means.
 *
 *  The first definition was "cards reaching status executed". That number is inflated, because three
 *  different things reach that status and only one of them is a commitment Haii actually kept:
 *
 *    • a Slack post, a Jira issue, a calendar event, a Gmail draft  -> something was created in a
 *      system that is not Haii. This is the product working. LEAVES_HAII below is the full list.
 *    • a create_todo                                  -> a row in Haii's own list. The user made a
 *      real decision, but nothing left the building. A capture that arrives without its evidence
 *      quote tends to sit in that list and die there.
 *    • a BLOCKED action                               -> the connector was not connected, so it
 *      became a follow-up todo, and the card is still stamped executed.
 *
 *  An email card used to be a fourth case: it wrote a todo and still returned mode "real", which was
 *  the product's own lie about itself. It now writes a real Gmail draft (see send_email below).
 *
 *  Counting all of these as one number is the difference between a metric that survives a hard
 *  question and a metric that falls apart in the first follow-up question. */

import { eq } from "drizzle-orm";
import { cards } from "../db/schema";

/** True when a card is real, i.e. not the one-time practice card (lib/practice.ts) shown to a
 *  brand-new user before their first meeting produces anything. AND this into every query that
 *  feeds a tally, a rate, or the model's own suppression/exemplar context: a tutorial decision
 *  must never move a number someone might quote, and must never teach the extractor anything.
 *  One exported constant rather than a per-call-site `eq(...)`, so "did I remember it here" is a
 *  grep for one import, not a re-derivation at every query site.
 *
 *  Imports the table straight from `../db/schema`, deliberately NOT from `../db`: the latter
 *  opens PGlite/Postgres as an import-time side effect (see db/index.ts's top-level acquireLock
 *  + `new PGlite(...)`), which this file must never trigger: metrics.test.ts runs with no
 *  database and needs to stay that way. `../db/schema` is just table definitions, nothing opens. */
export const notSimulated = eq(cards.simulated, false);

/** Does performing this action put something into a system that is NOT Haii?
 *
 *  Deliberately keyed on the action rather than hardcoded into the query, so that reclassifying a
 *  type is a one-entry edit here and the north star follows it with no edit to any metric,
 *  dashboard or document. That is the whole reason this is a map and not an `IN (...)` list: the
 *  definition is "it left Haii", not "it is one of these strings". */
export const LEAVES_HAII: Record<string, boolean> = {
  send_slack_message: true,
  create_jira_issue: true,
  create_calendar_event: true,
  create_todo: false,
  // TRUE, because an email card writes a real Gmail draft.
  //
  // The case for false was that executed means "landed where another person can see it", and a
  // draft sits in the author's own mailbox. That argument does not match this very table:
  // create_calendar_event is true regardless of attendees, so a solo focus block nobody else can
  // see ALREADY counts. "Someone else can see it" was never the rule, it was a description of the
  // rule that happened to be wrong.
  //
  // The line this table actually draws: was the artifact created in a system OUTSIDE Haii? Todos
  // live in Haii's own table, so the work is only remembered. A draft lives in Gmail, finished, in
  // the user's real workflow. That is the distinction the north star exists to protect, and by it
  // a draft is an execution.
  //
  // The remaining press of send is a product decision, not an incomplete outcome: Haii is capable
  // of the whole thing and stops on purpose so a human reads it first.
  //
  // WHAT THIS DOES NOT MEASURE, and the thing to watch: whether drafts get SENT. If they pile up
  // unsent, the to-do pile is back behind a number that says otherwise. Gmail can answer it, a
  // draft that no longer exists was sent or discarded, and that is the follow-up.
  send_email: true,
  // ALL TRUE, by the rule this table already draws: was the artifact created in a system OUTSIDE
  // Haii? A Google Doc, a Drive permission, a HubSpot note and a Jira/Linear/Asana issue all are.
  //
  // These four once shipped without entries here, and that was not a small omission. An action
  // type absent from this map reads as `false`, so every document, share, CRM note and ticket was
  // counted as CAPTURED, meaning the work stayed inside Haii. The north star undercounted the four
  // newest ways the product actually does something, and the card told the user "CAPTURE" while
  // creating a real file in their Drive. Found by using the card deck, not by any test.
  create_document: true,
  share_file: true,
  create_crm_note: true,
  create_task: true,
  // TRUE, and this one was argued the other way first.
  //
  // The case for false was that a `sms:` deep link creates NOTHING anywhere. A Gmail draft persists
  // in Gmail whether or not it is sent, so the artifact exists; a Messages compose window the user
  // abandons leaves no trace at all. On that reading a handoff is not an outcome, it is an intent,
  // and counting it would inflate the one number the product is judged on.
  //
  // Why that lost, and it is the same reasoning that settled send_email: this table asks whether the
  // artifact was created in a system OUTSIDE Haii, and the finished message IS created, in the
  // user's own Messages app, addressed and written and one tap from gone. Haii is capable of the
  // whole thing and stops on purpose so a human reads it first, exactly as with a draft. Holding
  // send_text to a stricter standard than send_email would mean the table draws two different lines
  // depending on which type is being asked about, and a metric that does that is not a metric.
  //
  // WHAT THIS DOES NOT MEASURE, and it is a sharper version of the same gap send_email has: whether
  // the user pressed send. Gmail can at least be asked, because a draft that no longer exists was
  // sent or discarded. Messages cannot be asked at all. So this number will run optimistic by
  // whatever share of handoffs get abandoned, and nothing here can measure that share.
  //
  // The follow-up that closes it, and it should not be dropped: a one-tap "Sent it" tick on the
  // Follow-ups row, which turns an unanswerable question into a measured rate. Until that ships,
  // treat send_text's contribution to the north star as an upper bound rather than a count.
  send_text: true,
};

/** Does this decision belong in a card type's approval rate?
 *
 *  "Later" is the answer this exists for. The dismiss chips are Wrong / Not mine / Later, and the
 *  three mean completely different things: Wrong is an extraction bug, Not mine is an attribution
 *  bug, and **Later means the card was right and the timing was not**. Scoring all three the same
 *  ran the learning loop backwards: deferring a correct card pushed its type toward the suppression
 *  rule in jobs/extract.ts, so telling Haii "right card, wrong week" taught it to stop proposing
 *  that kind of card at all.
 *
 *  Ignored rather than counted as approval. A deferral says the proposal was legitimate, not that
 *  the user wants the action, and inflating the rate would be the same error in the other
 *  direction. Neutral is the honest reading.
 *
 *  One function because three places compute this (the suppression stats, the admin roster's
 *  trailing-20, and the weekly tally) and three copies of a definition drift. */
export function approvalSignal(feedback: unknown): "approved" | "disapproved" | "ignore" {
  const fb = feedback as { decision?: string; reason?: string } | null;
  if (!fb?.decision) return "ignore";
  if (fb.decision === "approved" || fb.decision === "edited") return "approved";
  if (fb.decision === "dismissed" && fb.reason === "later") return "ignore";
  return "disapproved";
}

export type Outcome =
  /** The artifact was created in a system outside Haii, so the work is done. THE north star. */
  | "executed"
  /** Approved and completed, but the artifact never left Haii's own database. Today: todos only. */
  | "captured"
  /** Approved, but the connector was missing, so Haii promised and did not deliver. */
  | "blocked"
  /** Approved and the attempt threw. */
  | "failed"
  | "dismissed"
  | "expired"
  /** Proposed, approved-in-grace, or mid-execution. Not yet an outcome. */
  | "pending";

interface CardLike {
  status: string;
  actionType: string;
  feedback: unknown;
}

export function classifyCard(card: CardLike): Outcome {
  const fb = card.feedback as { executed?: { mode?: string } } | null;
  switch (card.status) {
    case "failed":
      return "failed";
    case "dismissed":
      return "dismissed";
    case "expired":
      return "expired";
    case "executed":
      // Checked BEFORE the action type: a blocked Slack card never reached Slack, so whether Slack
      // is an external system is irrelevant to what actually happened.
      if (fb?.executed?.mode === "blocked") return "blocked";
      return LEAVES_HAII[card.actionType] ? "executed" : "captured";
    default:
      return "pending";
  }
}

/** ISO-8601 week key, "2026-W31". Takes a local day key (YYYY-MM-DD) rather than an instant, so the
 *  week a decision belongs to is the week it was in FOR THAT USER. A decision at 00:30 Monday for a
 *  user at UTC+3 belongs to the new week even though it is still Sunday in UTC. */
export function isoWeek(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // ISO weeks belong to the year containing their Thursday, which is what makes the turn of the
  // year work: 2026-01-01 can legitimately fall in 2025-W53.
  const dow = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(dt.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((dt.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Does the quote a card is built on actually appear in the transcript it came from?
 *
 *  The verbatim quote is the point of the product. A card whose evidence was invented is worse
 *  than a wrong card, because the thing that makes the product trustworthy is the thing that lied.
 *  Until this existed, nothing checked it.
 *
 *  Deterministic and free: both sides are in Postgres, so this is substring matching, no model.
 *  Normalised because a transcript carries markdown, smart quotes and irregular whitespace while
 *  the model emits clean prose; comparing raw would report false misses and teach us to ignore it.
 *  Deliberately NOT fuzzy: near-enough matching is how a quote drifts far enough to change meaning
 *  while still scoring as fidelity. Exact-after-normalisation, or it counts as a miss. */
export function normalizeForQuoteMatch(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/[*_`~#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Is ONE quote verifiable against this source?
 *
 *  Three answers, not two, and the third is why this is not a boolean. A fragment under 12
 *  characters matches by accident ("ok", "will do"), so it can be neither confirmed nor denied.
 *  The metric skips those so the number is not flattered; the guard in jobs/extract.ts keeps them
 *  so a card is never dropped on evidence nobody could have judged. */
export function quoteVerdict(quote: string, sourceText: string): "found" | "missing" | "unverifiable" {
  const needle = normalizeForQuoteMatch(quote);
  if (needle.length < 12) return "unverifiable";
  return normalizeForQuoteMatch(sourceText).includes(needle) ? "found" : "missing";
}

/** Quotes checked and quotes found, for one card against its source text. */
export function quoteFidelity(quotes: string[], sourceText: string): { checked: number; found: number } {
  let found = 0;
  let checked = 0;
  for (const q of quotes) {
    const v = quoteVerdict(q, sourceText);
    if (v === "unverifiable") continue;
    checked++;
    if (v === "found") found++;
  }
  return { checked, found };
}

export interface WeekTally {
  proposed: number;
  decided: number;
  approved: number;
  edited: number;
  dismissed: number;
  executed: number;
  captured: number;
  blocked: number;
  failed: number;
  expired: number;
}

export function emptyTally(): WeekTally {
  return {
    proposed: 0, decided: 0, approved: 0, edited: 0, dismissed: 0,
    executed: 0, captured: 0, blocked: 0, failed: 0, expired: 0,
  };
}

/** Fold one decided card into a tally. Extracted from the route so it can be tested without a
 *  database or an HTTP round trip, because this is exactly where the bug lived.
 *
 *  The trap: classifyCard returns "dismissed" and "expired" as outcomes, and WeekTally carries
 *  `dismissed` as a DECISION counter. A blanket `t[outcome]++` therefore counted every shake twice,
 *  once here and once as a decision, which inflated the approval-rate denominator and made the
 *  reported rate materially worse than reality. It survived 17 passing assertions and only died
 *  when real production data arrived. Only the four execution outcomes accumulate. */
export function tallyCard(t: WeekTally, card: CardLike & { feedback: unknown }): void {
  const outcome = classifyCard(card);
  if (outcome === "pending") return;
  if (outcome === "expired") {
    t.expired++;
    return;
  }
  t.decided++;
  const decision = (card.feedback as { decision?: string } | null)?.decision;
  // A deferral is not a rejection, so it must not land in `dismissed`, which is what approvalRate
  // divides by. Same rule as approvalSignal; kept here rather than delegated because the three
  // counters below are decision labels, not a single verdict.
  const deferred = approvalSignal(card.feedback) === "ignore" && decision === "dismissed";
  if (decision === "approved") t.approved++;
  else if (decision === "edited") t.edited++;
  else if (decision === "dismissed" && !deferred) t.dismissed++;
  if (outcome === "executed" || outcome === "captured" || outcome === "blocked" || outcome === "failed") {
    t[outcome]++;
  }
}

/** (approved + edited) / decided. Null rather than 1.0 on an empty set: "no decisions yet" and
 *  "everything approved" are opposite facts and must not render as the same number. */
export function approvalRate(t: WeekTally): number | null {
  const n = t.approved + t.edited + t.dismissed;
  return n ? Number(((t.approved + t.edited) / n).toFixed(3)) : null;
}
