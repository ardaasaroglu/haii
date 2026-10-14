import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import { log } from "../log";
import { selectWakes, resolveWake, type SnoozedCard } from "../lib/snooze";
import { userTz } from "../lib/tz";

/** Return deferred cards to the deck: anything past its time, plus the soonest ones early when the
 *  deck is thin. The rules live in lib/snooze.ts; this is only the database around them.
 *
 *  Called from the feed rather than a scheduled job on purpose. The thin-deck rule needs to know
 *  the deck is thin, and a read of the feed is the one moment that is known. A timer would leave
 *  someone looking at an empty deck until the next tick.
 *
 *  Safe to call on every feed load: it is a no-op when nothing is snoozed, which is the common case.
 */
export async function wakeSnoozed(userId: string): Promise<number> {
  const snoozed = await db
    .select({
      id: schema.cards.id,
      snoozedUntil: schema.cards.snoozedUntil,
      snoozedAt: schema.cards.snoozedAt,
      snoozedWakeDay: schema.cards.snoozedWakeDay,
    })
    .from(schema.cards)
    .where(and(eq(schema.cards.userId, userId), eq(schema.cards.status, "snoozed")));
  if (!snoozed.length) return 0;

  const liveRows = await db
    .select({ id: schema.cards.id })
    .from(schema.cards)
    .where(and(eq(schema.cards.userId, userId), eq(schema.cards.status, "proposed")));

  // The "next morning" rule is a wall-clock INTENTION, not the instant snoozed_until happens to
  // hold: resolve every candidate against the user's CURRENT zone before selectWakes ever compares
  // a timestamp, or a card deferred in one zone and woken after a flight to a zone ten hours behind
  // comes back at 22:00 the evening before, local to the new zone. resolveWake leaves floor-rule cards (null wake day)
  // untouched, since that rule genuinely is a fixed instant.
  const urows = await db.select({ tz: schema.users.tz }).from(schema.users).where(eq(schema.users.id, userId));
  const tz = userTz(urows[0]?.tz);

  // A row can only be missing these if something wrote status 'snoozed' without them. Treat it as
  // due rather than stranding the card forever in a status nothing else looks at.
  const now = new Date();
  const candidates: SnoozedCard[] = snoozed.map((c) => ({
    id: c.id,
    snoozedUntil: resolveWake(c.snoozedWakeDay, c.snoozedUntil ?? now, tz),
    snoozedAt: c.snoozedAt ?? new Date(0),
  }));

  const { due, pulledForward } = selectWakes(candidates, now, liveRows.length);
  const ids = [...due, ...pulledForward];
  if (!ids.length) return 0;

  await db
    .update(schema.cards)
    .set({ status: "proposed", snoozedUntil: null, snoozedWakeDay: null })
    .where(and(eq(schema.cards.userId, userId), inArray(schema.cards.id, ids)));

  // snoozed_at is deliberately NOT cleared: it is the record of when the user last pushed the card
  // away, and the floor is measured from it if they defer again.
  log.info({ userId, due: due.length, pulledForward: pulledForward.length }, "deferred cards returned to the deck");
  return ids.length;
}
