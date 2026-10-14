/** Turning what the user DID into what Haii durably knows.
 *
 *  The gap this closes, stated precisely: Haii already remembers what it READ (the model writes
 *  memories as a side output of extraction), and it can see recent decisions as prompt
 *  exemplars. But exemplars are a sliding window of ten, so a preference expressed by
 *  fifteen consistent dismissals is gone by the time it has been expressed. Nothing the user DOES
 *  has ever survived. This file decides what deserves to.
 *
 *  It is deliberately the boring half: pure functions, no database, no model, no Telegram, so the
 *  rule that decides what may become durable can be read and tested on its own. jobs/distill.ts
 *  does the IO around it.
 *
 *  THE MULTI-DAY RULE IS THE POINT. A memory reaches the system prompt of BOTH extraction and
 *  briefing and persists until someone deletes it, so a wrong one degrades everything quietly and
 *  forever. That asymmetry is why a pattern must span several distinct LOCAL days before it can be
 *  learned. The concrete case it was written for: one afternoon of testing the dismiss flow drove
 *  the trailing-20 approval rate down sharply inside a single day. Those are real rows with real
 *  reasons and they are not preferences. Counting events alone would have learned "the user does
 *  not want these cards" from an afternoon of QA. Counting DAYS cannot.
 */
import { dayKeyInTz } from "./tz";

/** How many times a pattern must occur before it can be learned. */
export const MIN_EVENTS = 4;
/** How many DISTINCT local days it must span. The guard that a single session cannot teach. */
export const MIN_DAYS = 3;
/** Minimum absolute elapsed time, in hours, between a pattern's earliest and latest event.
 *
 *  MIN_DAYS alone can be gamed by nothing more than a timezone change: dayKeyInTz buckets every
 *  historical event by the CURRENT tz argument, so a user who flies from one time zone to another
 *  has every past event re-bucketed in the new zone, which can move the distinct-day count of a
 *  single afternoon's burst across MIN_DAYS. Elapsed instant-to-instant time cannot be distorted by
 *  a zone change: a burst inside one afternoon is still under 24h apart no matter what tz is applied
 *  to it. 48h (two full days) is comfortably past what a single working session can span. */
export const MIN_SPAN_HOURS = 48;
/** Example titles shown per qualifying pattern, for grounding. Two is enough to make a memory
 *  concrete and few enough that the model cannot mistake the list for the evidence. */
export const EXAMPLES_PER_PATTERN = 2;

export interface FeedbackEvent {
  /** "card" or "brief". Briefs carry no action type. */
  kind: "card" | "brief";
  actionType: string;
  /** approved | edited | dismissed for cards; up | down for briefs. */
  decision: string;
  /** The chip: wrong | not_mine for cards, too_long | wrong_people | missed_the_point for briefs. */
  reason: string;
  /** Field names parsed from a card's edit diff, e.g. ["channel"]. */
  editFields: string[];
  /** What it was called, for grounding only. */
  title: string;
  at: Date;
}

export interface Pattern {
  key: string;
  /** A sentence the prompt can read directly. */
  label: string;
  n: number;
  days: number;
  /** Hours between the earliest and latest event, in absolute elapsed time. Timezone-independent
   *  companion to `days`; see MIN_SPAN_HOURS for why both are needed. */
  spanHours: number;
  examples: string[];
}

/** The field a diff entry is about. Entries look like `channel: #general -> #product`, so the
 *  field is whatever precedes the first colon. A malformed entry contributes nothing rather than
 *  becoming a pattern named after a fragment of prose. */
export function editField(entry: string): string {
  const i = String(entry ?? "").indexOf(":");
  if (i <= 0) return "";
  return entry.slice(0, i).trim().toLowerCase();
}

/** Group raw feedback into candidate patterns, counting both occurrences and distinct local days.
 *
 *  `later` never appears here. It is timing, not taste, and lib/metrics.ts already drops it from
 *  the approval rate for exactly that reason; letting it through would teach "propose fewer of
 *  these" from a user saying "not now", which is the same bug this codebase has now fixed twice. */
export function buildPatterns(events: FeedbackEvent[], tz: string): Pattern[] {
  const acc = new Map<
    string,
    { label: string; days: Set<string>; n: number; examples: string[]; firstMs: number; lastMs: number }
  >();

  const add = (key: string, label: string, day: string, title: string, at: Date) => {
    const ms = at.getTime();
    const p = acc.get(key) ?? { label, days: new Set<string>(), n: 0, examples: [], firstMs: ms, lastMs: ms };
    p.n++;
    p.days.add(day);
    // Track the instant range regardless of the order `events` arrives in (callers pass newest
    // first); min/max comparisons are order-independent, unlike assuming the first add() is earliest.
    if (ms < p.firstMs) p.firstMs = ms;
    if (ms > p.lastMs) p.lastMs = ms;
    if (title && p.examples.length < EXAMPLES_PER_PATTERN && !p.examples.includes(title)) {
      p.examples.push(title);
    }
    acc.set(key, p);
  };

  for (const e of events) {
    if (!e?.at || Number.isNaN(e.at.getTime())) continue;
    const day = dayKeyInTz(tz, e.at);

    if (e.kind === "brief") {
      if (e.decision === "down" && e.reason) {
        add(`brief:${e.reason}`, `marked a brief "${e.reason.replace(/_/g, " ")}"`, day, e.title, e.at);
      } else if (e.decision === "up") {
        add("brief:up", "rated a brief useful", day, e.title, e.at);
      }
      continue;
    }

    if (e.decision === "dismissed") {
      if (e.reason === "later" || !e.reason) continue;
      add(
        `dismiss:${e.actionType}:${e.reason}`,
        `dismissed a ${e.actionType} card as "${e.reason.replace(/_/g, " ")}"`,
        day,
        e.title,
        e.at,
      );
      // ALSO across types, and this is what makes dismissals learnable at all.
      //
      // Found on a real month of history: the only patterns that qualified were approvals, and
      // the model correctly wrote nothing from them, because approving what we proposed describes
      // OUR output, not the user's taste. The signal lives in dismissals and edits.
      //
      // Those were starved by their own key. Splitting per action type spreads a month of
      // dismissals across up to 25 keys, so nothing reaches 4 events on 3 distinct days and the
      // whole taste-bearing half of the corpus never reached the model. "Not mine, twelve times
      // across eight days" is a real instruction about attribution; the same twelve split five
      // ways is silence. Additive on purpose: the per-type pattern still fires, so a preference
      // specific to one card type is not lost to the aggregate.
      add(
        `dismiss-any:${e.reason}`,
        `dismissed a card as "${e.reason.replace(/_/g, " ")}", across card types`,
        day,
        e.title,
        e.at,
      );
    } else if (e.decision === "edited") {
      // The card was right and the details were not, so the FIELD edited is the signal, not the
      // fact of editing. An edit with no parseable diff says only "approved with changes", which
      // the approval pattern below already carries.
      for (const f of new Set(e.editFields.map(editField).filter(Boolean))) {
        add(`edit:${e.actionType}:${f}`, `edited the ${f} on a ${e.actionType} card`, day, e.title, e.at);
        // Same starvation, same fix. "Always rewrites the body" is a tone preference whether the
        // card was an email or a Slack message, and it is the single most useful thing this job
        // could ever learn.
        add(`edit-any:${f}`, `edited the ${f} before approving, across card types`, day, e.title, e.at);
      }
      add(`approve:${e.actionType}`, `approved a ${e.actionType} card`, day, e.title, e.at);
    } else if (e.decision === "approved") {
      add(`approve:${e.actionType}`, `approved a ${e.actionType} card`, day, e.title, e.at);
    }
  }

  return [...acc.entries()]
    .map(([key, v]) => ({
      key,
      label: v.label,
      n: v.n,
      days: v.days.size,
      spanHours: (v.lastMs - v.firstMs) / 3600_000,
      examples: v.examples,
    }))
    .sort((a, b) => b.n - a.n || b.days - a.days || a.key.localeCompare(b.key));
}

/** The gate. A pattern the model never sees cannot be learned from, which is why the filter runs
 *  here in code rather than as an instruction in the prompt.
 *
 *  Three independent conditions, all required: enough occurrences (MIN_EVENTS), enough distinct
 *  LOCAL days (MIN_DAYS), and enough absolute elapsed time (MIN_SPAN_HOURS). Days alone is not
 *  enough: it is computed from the CURRENT timezone argument against events that may predate a
 *  timezone change, so it can be fooled either way by a move. Span cannot be, which is why a burst
 *  inside one afternoon fails here even on a day count a hostile tz made look like three. */
export function qualifying(patterns: Pattern[]): Pattern[] {
  return patterns.filter((p) => p.n >= MIN_EVENTS && p.days >= MIN_DAYS && p.spanHours >= MIN_SPAN_HOURS);
}

/** Render the qualifying patterns for the prompt. Counts and day spans are shown because they are
 *  the reason the pattern is here at all, and a model told "4 times across 3 days" writes a more
 *  cautious memory than one told "the user does this". */
export function renderPatterns(patterns: Pattern[]): string {
  return patterns
    .map((p) => {
      const eg = p.examples.length ? ` (e.g. ${p.examples.map((t) => `"${t}"`).join(", ")})` : "";
      return `- ${p.label}: ${p.n} times across ${p.days} different days${eg}`;
    })
    .join("\n");
}
