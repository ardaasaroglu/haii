/** End-to-end check for deferring a card: does it actually leave the deck, and does it actually
 *  come back?
 *
 *  Separate from `npm test` on purpose. That suite is pure and needs no database (CLAUDE.md: schema
 *  + server, fast, no database needed) and it is worth keeping that way. This one exercises the
 *  wiring the unit tests cannot see: the status transition, the feed's status filter, the waker,
 *  and the thin-deck rule against real rows.
 *
 *  House pattern from CLAUDE.md: read, seed known rows, read again, assert the deltas, clean up.
 *  Deltas make it immune to whatever else is in the local database.
 *
 *  Run: `npx tsx src/tools/snoozeCheck.ts` from server/, with the dev server STOPPED.
 */
import { and, eq, like } from "drizzle-orm";
import { db, schema, initDb } from "../db";
import { wakeSnoozed } from "../jobs/wake";
import { nextReturn, SNOOZE_FLOOR_MIN, DECK_TARGET } from "../lib/snooze";
import { userTz } from "../lib/tz";

const FX = "snzchk_";
const UID = `${FX}user`;

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}
const eq2 = (name: string, got: unknown, want: unknown) =>
  check(name, String(got) === String(want), `got ${got}, want ${want}`);

async function cleanup() {
  await db.delete(schema.cards).where(like(schema.cards.id, `${FX}%`));
  await db.delete(schema.users).where(eq(schema.users.id, UID));
}

const deckCount = async () =>
  (await db.select({ id: schema.cards.id }).from(schema.cards)
    .where(and(eq(schema.cards.userId, UID), eq(schema.cards.status, "proposed")))).length;

const statusOf = async (id: string) =>
  (await db.select({ s: schema.cards.status }).from(schema.cards).where(eq(schema.cards.id, id)))[0]?.s;

async function addCard(id: string, status = "proposed", extra: Record<string, unknown> = {}) {
  await db.insert(schema.cards).values({
    id: `${FX}${id}`,
    userId: UID,
    actionType: "create_todo",
    status,
    title: `card ${id}`,
    summary: "check",
    confidence: 0.8,
    priority: "normal",
    sourceJson: {},
    payload: {},
    context: {},
    expiresAt: new Date(Date.now() + 7 * 86400_000),
    ...extra,
  });
  return `${FX}${id}`;
}

async function main() {
  await initDb();
  await cleanup();
  try {
    await db.insert(schema.users).values({ id: UID, name: "SnoozeCheck", tz: "Europe/Istanbul" });

    console.log("\n--- a deferred card leaves the deck ---");
    const a = await addCard("a");
    await addCard("b");
    await addCard("c");
    await addCard("d");
    eq2("deck starts with 4", await deckCount(), 4);

    const now = new Date();
    const { at } = nextReturn(now, userTz("Europe/Istanbul"));
    await db.update(schema.cards)
      .set({ status: "snoozed", snoozedUntil: at, snoozedAt: now, snoozeCount: 1 })
      .where(eq(schema.cards.id, a));
    eq2("status is snoozed", await statusOf(a), "snoozed");
    eq2("deck drops to 3", await deckCount(), 3);

    console.log("\n--- waking does nothing while it is not due and the deck is full ---");
    eq2("woke nothing", await wakeSnoozed(UID), 0);
    eq2("still snoozed", await statusOf(a), "snoozed");
    eq2("deck unchanged", await deckCount(), 3);

    console.log("\n--- a card past its time comes back ---");
    await db.update(schema.cards)
      .set({ snoozedUntil: new Date(Date.now() - 60_000) })
      .where(eq(schema.cards.id, a));
    eq2("woke one", await wakeSnoozed(UID), 1);
    eq2("back to proposed", await statusOf(a), "proposed");
    eq2("deck back to 4", await deckCount(), 4);
    const rowA = (await db.select().from(schema.cards).where(eq(schema.cards.id, a)))[0];
    eq2("snoozed_until cleared", rowA.snoozedUntil, "null");
    check("snoozed_at kept as the record of when they pushed it away", rowA.snoozedAt !== null);
    eq2("snooze count remembered", rowA.snoozeCount, 1);

    console.log("\n--- THE case: deferred just now, deck emptied, must NOT come straight back ---");
    // Everything else leaves the deck, so the deck is empty and the thin-deck rule wants to fill it.
    for (const id of ["b", "c", "d"]) {
      await db.update(schema.cards).set({ status: "dismissed" }).where(eq(schema.cards.id, `${FX}${id}`));
    }
    const justNow = new Date();
    await db.update(schema.cards)
      .set({ status: "snoozed", snoozedUntil: nextReturn(justNow, "Europe/Istanbul").at, snoozedAt: justNow })
      .where(eq(schema.cards.id, a));
    eq2("deck is empty", await deckCount(), 0);
    eq2("nothing woke", await wakeSnoozed(UID), 0);
    eq2("still snoozed, floor respected", await statusOf(a), "snoozed");

    console.log("\n--- once the floor has passed, the empty deck does refill ---");
    await db.update(schema.cards)
      .set({ snoozedAt: new Date(Date.now() - (SNOOZE_FLOOR_MIN + 1) * 60_000) })
      .where(eq(schema.cards.id, a));
    eq2("pulled forward", await wakeSnoozed(UID), 1);
    eq2("back in the deck", await statusOf(a), "proposed");

    console.log("\n--- a full deck is never topped up early ---");
    await db.update(schema.cards)
      .set({ status: "snoozed", snoozedUntil: new Date(Date.now() + 6 * 3600_000), snoozedAt: new Date(0) })
      .where(eq(schema.cards.id, a));
    for (const id of ["b", "c", "d"]) {
      await db.update(schema.cards).set({ status: "proposed" }).where(eq(schema.cards.id, `${FX}${id}`));
    }
    eq2(`deck is at the target (${DECK_TARGET})`, await deckCount(), DECK_TARGET);
    eq2("nothing pulled forward", await wakeSnoozed(UID), 0);
    eq2("still snoozed", await statusOf(a), "snoozed");

    console.log("\n--- the waker ignores other users ---");
    const before = await wakeSnoozed(`${FX}nobody`);
    eq2("no such user, no writes", before, 0);
    eq2("our card untouched", await statusOf(a), "snoozed");
  } finally {
    await cleanup();
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  await cleanup().catch(() => {});
  console.error(String(e?.stack ?? e));
  if (e?.cause) console.error("cause:", String((e.cause as Error)?.stack ?? e.cause));
  process.exit(1);
});
