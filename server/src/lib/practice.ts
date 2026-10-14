/** The practice card: a brand-new user's deck is otherwise empty until their first meeting WITH
 *  notes produces a real one, which can take days, and the first-run swipe coach (index.html,
 *  coachSwipe) never fires without a card to fire it on. This gives them something to swipe on
 *  day one.
 *
 *  It is a real create_todo card, not a fake action type: approving it runs the ordinary executor
 *  path and creates a real to-do, because inventing an extra "not really an action" type would
 *  touch the closed list of action types in packages/schema for a feature that does not need to.
 *  The only things marking it as a tutorial are `simulated: true` and a source that says "Welcome"
 *  instead of a meeting.
 *
 *  NEVER give this a fabricated evidence quote. `why: []` is deliberate: this product's whole
 *  trust story is that a quote is verbatim from a real transcript, and the caveat fills the slot
 *  where a quote would sit instead, telling the truth (nothing has been read yet) rather than
 *  inventing one. See the matching client change in index.html's cardEl() back face.
 *
 *  Pure and deterministic on purpose: id and now are injected, not generated here, so the exact
 *  shape is unit-testable without a clock or a database. The insertion side (the zero-cards guard
 *  and the DB write) lives in routes.ts's GET /api/v1/feed; the expire-on-first-real-card side
 *  lives in routes.ts's POST /cards/propose and jobs/extract.ts's applyExtractResult. */
export function buildPracticeCard(userId: string, cardId: string, now: Date) {
  return {
    id: cardId,
    userId,
    schemaVersion: 1,
    type: "action",
    actionType: "create_todo",
    status: "proposed",
    title: "Give Haii a few minutes",
    summary:
      "A practice card, so you can try the swipe. Nod right and it becomes a real to-do. Shake left and it goes away.",
    confidence: 0.9,
    priority: "normal",
    sourceJson: { kind: "welcome", title: "Welcome", when: now.toISOString() },
    payload: { title: "Give Haii a few minutes", due: "", notes: "" },
    context: {
      why: [] as { who: string; text: string; t?: string }[],
      links: ["Welcome to Haii"],
      caveat: "Nothing has been read yet. Your first real card arrives when Haii reads a meeting: paste one in Setup, or connect Google.",
    },
    expiresAt: new Date(now.getTime() + 7 * 24 * 3600_000),
    simulated: true,
    transcriptId: null as string | null,
    meetingId: null as string | null,
    model: "practice",
    promptVersion: "practice.v001",
  };
}
