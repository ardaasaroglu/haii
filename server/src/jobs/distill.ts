/** The distillation job: what the user DID becomes what Haii durably knows.
 *
 *  This is what makes the feedback loop durable. The extraction and briefing prompts already carry
 *  recent decisions as exemplars, but the exemplar block is a sliding window of ten: a
 *  preference expressed by fifteen consistent dismissals has already scrolled out of view by the
 *  time it is unmistakable. A memory persists, reaches the system
 *  prompt of BOTH extraction and briefing from one write, and rides the cacheable prefix.
 *
 *  The rule about WHAT may be learned lives in lib/distill.ts, on purpose, so it can be read and
 *  tested without a database or a model. This file is the IO around it.
 *
 *  WHY THIS IS SAFE TO SHIP WITHOUT A SCORED EVAL, unlike a change to an existing prompt: it
 *  adds a new prompt rather than editing an existing one. No card and no brief is generated
 *  differently because this ran. The only thing that moves is the content of a memory list the user
 *  can already read and delete in Setup, which is also why the dry run below is worth its one extra
 *  call the first time.
 */
import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { db, schema } from "../db";
import { log } from "../log";
import { llmJson, MODELS } from "../lib/llm";
import { userTz } from "../lib/tz";
import { notSimulated } from "../lib/metrics";
import { listMemories, formatMemories, applyMemoryWrites } from "../lib/memory";
import { buildPatterns, qualifying, renderPatterns, type FeedbackEvent } from "../lib/distill";
import { DISTILL_SCHEMA, distillSystem, distillUser } from "../prompts/distill.v003";

/** How far back a pattern may be drawn from. Long enough that a weekly rhythm shows up several
 *  times, short enough that a preference the user has since changed their mind about ages out. */
const WINDOW_DAYS = 30;

/** Gather this user's decisions and brief ratings in the window, as flat events, plus any notes
 *  they wrote in their own words.
 *
 *  Notes come back SEPARATELY rather than as events on purpose. An event feeds buildPatterns, which
 *  counts occurrences and distinct days and refuses anything that has not recurred; that guard is
 *  correct for behaviour we are inferring a preference from, and wrong for a sentence the user
 *  deliberately typed. Nothing about a written note needs corroborating across three days. */
async function collect(userId: string): Promise<{ events: FeedbackEvent[]; notes: string[] }> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000);

  const cards = await db
    .select({
      actionType: schema.cards.actionType,
      title: schema.cards.title,
      feedback: schema.cards.feedback,
      decidedAt: schema.cards.decidedAt,
    })
    .from(schema.cards)
    // notSimulated: the practice card is a tutorial. A decision on it is not taste, and it must
    // never reach a durable memory any more than it reaches the suppression rule.
    .where(
      and(
        eq(schema.cards.userId, userId),
        isNotNull(schema.cards.feedback),
        gte(schema.cards.decidedAt, since),
        notSimulated,
      ),
    )
    .orderBy(desc(schema.cards.decidedAt))
    .limit(400);

  const briefs = await db
    .select({
      rating: schema.briefings.rating,
      reason: schema.briefings.feedbackReason,
      note: schema.briefings.feedbackNote,
      createdAt: schema.briefings.createdAt,
    })
    .from(schema.briefings)
    .where(
      and(
        eq(schema.briefings.userId, userId),
        isNotNull(schema.briefings.rating),
        gte(schema.briefings.createdAt, since),
      ),
    )
    .orderBy(desc(schema.briefings.createdAt))
    .limit(100);

  const events: FeedbackEvent[] = [];
  for (const c of cards) {
    const fb = c.feedback as { decision?: string; reason?: string; edit_diff?: string[] } | null;
    if (!fb?.decision || !c.decidedAt) continue;
    events.push({
      kind: "card",
      actionType: c.actionType,
      decision: String(fb.decision),
      reason: String(fb.reason ?? ""),
      editFields: Array.isArray(fb.edit_diff) ? fb.edit_diff.map(String) : [],
      title: c.title,
      at: c.decidedAt,
    });
  }
  for (const b of briefs) {
    events.push({
      kind: "brief",
      actionType: "",
      decision: String(b.rating ?? ""),
      reason: String(b.reason ?? ""),
      editFields: [],
      title: "",
      at: b.createdAt,
    });
  }

  // Its own query because a note does NOT require a rating: the case it exists for is "the brief
  // was fine, but it missed the attachment on the invite", where there is nothing to rate. Joining
  // it onto the rated set above would drop exactly the notes worth reading.
  const noteRows = await db
    .select({ note: schema.briefings.feedbackNote })
    .from(schema.briefings)
    .where(
      and(
        eq(schema.briefings.userId, userId),
        isNotNull(schema.briefings.feedbackNote),
        gte(schema.briefings.createdAt, since),
      ),
    )
    .orderBy(desc(schema.briefings.createdAt))
    .limit(20);
  const notes = noteRows.map((r) => String(r.note ?? "").trim()).filter(Boolean);

  return { events, notes };
}

/** Run distillation for one user.
 *
 *  `dryRun` proposes without writing, and returns the proposed writes in the string. Worth the one
 *  extra call the first time it is pointed at a real account: a wrong memory is invisible after the
 *  fact (it just makes every later suggestion slightly worse) and is far cheaper to catch before it
 *  is written than after. */
export async function distillMemories(userId: string, opts: { dryRun?: boolean } = {}): Promise<string> {
  // Deliberately NOT wrapped in runJob here. The scheduler's guard() and the manual-trigger route
  // both wrap whatever they call, so self-wrapping would write two job_runs rows for every run and
  // quietly double this job's share of the telemetry. Same contract as pollSlack, slackListen and
  // followUpSweep: return a short string, let the caller record it.
  {
    const urow = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
    const tz = userTz(urow?.tz);

    const { events, notes } = await collect(userId);
    if (!events.length && !notes.length) return "skipped: nothing to learn from in the window";

    const all = buildPatterns(events, tz);
    const strong = qualifying(all);
    // A note alone is enough to run. The multi-day rule gates INFERENCE, and a written note is not
    // inferred; refusing to read it because behaviour had not also recurred would mean the user
    // told Haii something directly and Haii ignored it, which is the whole failure being fixed.
    if (!strong.length && !notes.length) {
      // Worth saying how close it came: "nothing qualified" reads as broken when the real answer is
      // that the user has not used it across enough days yet.
      const best = all[0];
      return best
        ? `skipped: no pattern qualified (best: ${best.n} times across ${best.days} days)`
        : "skipped: no pattern qualified";
    }

    const existing = await listMemories(userId);
    const result = await llmJson({
      userId,
      job: "distill_memories",
      model: MODELS.deep,
      system: distillSystem(urow?.name || userId, urow?.role || ""),
      user: distillUser({
        selfName: urow?.name || userId,
        patterns: strong.length ? renderPatterns(strong) : "(nothing recurred often enough to count)",
        notes: notes.map((n) => `- "${n}"`).join("\n"),
        memories: formatMemories(existing),
        windowDays: WINDOW_DAYS,
      }),
      jsonSchema: DISTILL_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 1200,
      // Deciding whether a pattern is a preference or a coincidence is exactly the judgement call
      // thinking is for, and this runs once a user per week, so the tokens are affordable here in a
      // way they are not on the per-transcript path. Briefing turns thinking off for the opposite
      // reason: summarising handed-over context into a fixed shape is not a judgement task.
      reasoning: "adaptive",
    });
    if (!result.ok) return `skipped: ${result.reason}`;

    const seen = `${strong.length} pattern(s), ${notes.length} note(s)`;
    const writes = Array.isArray(result.data?.memory_writes) ? result.data.memory_writes : [];
    if (!writes.length) {
      // THE ONE OUTCOME THAT PRODUCES NOTHING WAS ALSO THE ONE THAT RECORDED NOTHING.
      //
      // Memories could sit at zero for weeks while this line said "no memory worth
      // writing", which cannot distinguish the two explanations that matter: the input was thin, or
      // the model was too conservative with a decent input. The dry run logged its writes when
      // there were writes, and logged nothing in exactly the case anyone would be investigating.
      //
      // This corpus is the one part of the product that cannot be cold-started.
      // A mechanism that silently declines to accrue it has to say what it turned down.
      log.info(
        {
          userId,
          patterns: strong.map((p) => ({ label: p.label, n: p.n, days: p.days, spanHours: Math.round(p.spanHours) })),
          notes,
          nearMisses: all.filter((p) => !strong.includes(p)).slice(0, 5).map((p) => ({ label: p.label, n: p.n, days: p.days })),
        },
        "distill wrote nothing, here is what it was offered",
      );
      const why = strong.map((p) => `${p.label} x${p.n}/${p.days}d`).join("; ");
      const noteHint = notes.length ? ` · note: "${notes[0].slice(0, 80)}"` : "";
      return `${seen}, no memory worth writing · saw: ${why || "(none)"}${noteHint}`.slice(0, 400);
    }

    if (opts.dryRun) {
      // Rendered rather than applied. Every write is logged too, so this is inspectable from the
      // operator side without reading a job string.
      const preview = writes
        .map((w: any) => `${w.op}${w.id ? ` #${w.id}` : ""}: ${String(w.content ?? "").slice(0, 120)}`)
        .join(" | ");
      log.info({ userId, writes }, "distill dry run, nothing written");
      return `DRY RUN, nothing written. Would ${writes.length}: ${preview}`;
    }

    const applied = await applyMemoryWrites(userId, writes);
    // Logged individually because a memory silently degrades every later prompt if it is wrong, so
    // "what did it learn and when" has to be answerable from the logs, not only from the UI.
    for (const w of writes) {
      log.info({ userId, op: w?.op, id: w?.id, content: String(w?.content ?? "").slice(0, 200) }, "memory distilled");
    }
    return `${seen}, ${applied} memory write(s) applied`;
  }
}
