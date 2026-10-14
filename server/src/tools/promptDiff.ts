/** Show what a prompt change actually did, before it reaches anyone.
 *
 *  Without this a prompt edit is unobservable: you change how exemplars render, ship it, and find
 *  out weeks later that a whole card type stopped being proposed. This is the cheap 10% of an eval
 *  harness that removes that specific risk.
 *
 *  WHY IT DIFFS THE PROMPT AND NOT THE MODEL OUTPUT:
 *    • Output costs money. Re-extracting fixtures is a real charge on your API key.
 *    • Output is non-deterministic. The same prompt yields different cards run to run, so an
 *      output diff reports sampling noise as change. As a regression signal that is worse than
 *      useless: it teaches you to ignore it.
 *  The assembled prompt is free, deterministic, and is where prompt changes actually live.
 *
 *  WHY IT SEEDS ITS OWN DATA rather than reading real rows: fixtures drawn from a live database
 *  drift between snapshot and check, so a card merely changing status looks identical to a logic
 *  change, and the diff becomes noise. Seeding also means the fixtures encode the exact conditions
 *  worth watching (a card type sitting under the suppression threshold, dismissals carrying each
 *  reason) instead of whatever happened to be in someone's sandbox. Follows the house pattern from
 *  CLAUDE.md: seed known rows, read, assert, clean up.
 *
 *  WHAT IT CANNOT DO: say the change was an improvement, or catch a model behaving differently on
 *  an identical prompt. That is the scored eval harness, still to build.
 *
 *  USE: `npm run prompts:snap -w @haii/server` before editing, `npm run prompts:check -w @haii/server`
 *  after. PGlite is single-writer, so stop the dev server or give this its own database
 *  (DATA_DIR=.data-promptdiff, as CLAUDE.md shows).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq, like } from "drizzle-orm";
import { db, schema, initDb } from "../db";
import { userTz } from "../lib/tz";
import { buildExtractRequest } from "../jobs/extract";
import { buildBriefingRequest } from "../jobs/briefing";

/** A system prompt is now either a plain string or a `{ stable, variable }` split (lib/llm.ts).
 *  Render the ASSEMBLED text either way, because what this harness exists to show is what the model
 *  actually receives. An object would stringify to "[object Object]" without ever throwing, which
 *  would leave the tool reporting a clean diff of nothing. */
function flatten(system: unknown): string {
  if (typeof system === "string") return system;
  const s = system as { stable?: string; variable?: string };
  return [s?.stable, s?.variable].filter(Boolean).join("\n\n");
}

const DIR = join(process.cwd(), ".fixtures", "prompts");
const FX = "fxdiff_"; // every seeded row id starts with this, which is also how cleanup finds them

/** Fixed instants so nothing in a rendered prompt moves with the wall clock. */
const T0 = new Date("2026-06-01T09:00:00.000Z");
const MEETING_AT = new Date("2026-06-02T11:00:00.000Z");

const TRANSCRIPTS = [
  {
    id: `${FX}tr_pricing`,
    title: "Pricing sync",
    contentMd:
      "Alex: I'll send Noor the fee comparison before Friday.\n" +
      "Noor: Great. Can someone also book a follow-up on the platform config?\n" +
      "Alex: I'll set that up for next week.\n" +
      "Noor: And the data retention question still has no owner.\n" +
      "Alex: I'll raise a ticket for it.",
  },
  {
    id: `${FX}tr_standup`,
    title: "Product standup",
    contentMd:
      "Mina: Blocked on the onboarding flow copy.\n" +
      "Alex: I'll post a summary in the product channel after this.\n" +
      "Mina: Thanks. Anything for Northwind?\n" +
      "Alex: I owe them answers on the API limits, I'll write back this week.",
  },
];

/** Cards chosen so the prompt exercises the parts that actually change:
 *  six dismissed calendar cards put that type under the suppression threshold (n>=5, rate<0.2),
 *  and five of them carry reason "later". So the moment "later" stops counting as disapproval,
 *  n drops to 1, the FEEDBACK SIGNALS block disappears, and this harness shows it. */
const CARDS = [
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `${FX}c_later_${i}`,
    actionType: "create_calendar_event",
    title: `Book the platform config follow-up (${i + 1})`,
    feedback: { decision: "dismissed", reason: "later" },
  })),
  {
    id: `${FX}c_wrong`,
    actionType: "create_calendar_event",
    title: "Book a review nobody asked for",
    feedback: { decision: "dismissed", reason: "wrong" },
  },
  {
    id: `${FX}c_notmine`,
    actionType: "create_todo",
    title: "Chase the vendor invoice",
    feedback: { decision: "dismissed", reason: "not_mine" },
  },
  {
    id: `${FX}c_ok`,
    actionType: "create_todo",
    title: "Send Noor the fee comparison",
    feedback: { decision: "approved" },
  },
  {
    id: `${FX}c_edited`,
    actionType: "send_slack_message",
    title: "Post the sprint summary",
    feedback: { decision: "edited", edit_diff: ["channel: #general -> #product"] },
  },
];

async function cleanup() {
  await db.delete(schema.cards).where(like(schema.cards.id, `${FX}%`));
  await db.delete(schema.transcripts).where(like(schema.transcripts.id, `${FX}%`));
  await db.delete(schema.briefings).where(like(schema.briefings.id, `${FX}%`));
  await db.delete(schema.meetings).where(like(schema.meetings.id, `${FX}%`));
  await db.delete(schema.memories).where(eq(schema.memories.userId, `${FX}user`));
  await db.delete(schema.users).where(eq(schema.users.id, `${FX}user`));
}

async function seed() {
  await cleanup(); // idempotent: a killed run must not poison the next one
  await db.insert(schema.users).values({
    id: `${FX}user`,
    name: "Fixture",
    email: "fixture@example.invalid",
    role: "Product lead",
    tz: "Europe/Istanbul",
    locale: "en-US",
  });
  await db.insert(schema.memories).values({
    userId: `${FX}user`,
    content: "Prefers action cards that name a single owner.",
  });
  await db.insert(schema.meetings).values({
    id: `${FX}m_pricing`,
    userId: `${FX}user`,
    source: "gcal",
    externalId: `${FX}ext_pricing`,
    title: "Pricing sync",
    startsAt: MEETING_AT,
    attendees: [{ email: "noor@example.invalid", name: "Noor" }],
  });
  // An EARLIER meeting sharing an attendee, which is what makes the brief fixture render at all.
  // buildBriefingRequest returns null unless retrieval finds snippets, a prior meeting, or open
  // work, and before this the fixture had none of the three: the harness silently produced zero
  // brief prompts and reported "snapshotted 2", so every briefing-prompt change since it was built
  // was invisible to it. A prior meeting is the one of the three that costs nothing in accuracy:
  // stream items are filtered to the last 7 days so they would have to move with the wall clock,
  // and an open card would change the extract prompt's ALREADY OPEN block and pollute that diff.
  await db.insert(schema.meetings).values({
    id: `${FX}m_prior`,
    userId: `${FX}user`,
    source: "gcal",
    externalId: `${FX}ext_prior`,
    title: "Pricing sync (previous)",
    startsAt: new Date(MEETING_AT.getTime() - 7 * 86400_000),
    attendees: [{ email: "noor@example.invalid", name: "Noor" }],
  });
  // Rated briefs, so the feedback block that briefing.v004 renders has something to show. One of
  // each verdict and one carrying a chip: a fixture with only thumbs-down could not catch the block
  // dropping the up case, which is the kind of silent hole this harness exists to find.
  const BRIEFS = [
    { id: `${FX}b_down`, meetingId: `${FX}m_prior`, rating: "down", feedbackReason: "too_long" },
    { id: `${FX}b_up`, meetingId: `${FX}m_prior`, rating: "up", feedbackReason: null },
  ];
  let bn = 0;
  for (const b of BRIEFS) {
    await db.insert(schema.briefings).values({
      id: b.id,
      userId: `${FX}user`,
      meetingId: b.meetingId,
      model: "fixture",
      promptVersion: "fixture",
      contentJson: { tldr: "fixture", sections: [], last_met: [], open_threads: [] },
      rating: b.rating,
      feedbackReason: b.feedbackReason,
      // Spaced and fixed, never "now", so the newest-first ordering is stable run to run.
      createdAt: new Date(T0.getTime() + bn++ * 60_000),
    });
  }
  for (const t of TRANSCRIPTS) {
    await db.insert(schema.transcripts).values({
      id: t.id,
      userId: `${FX}user`,
      meetingId: t.id.endsWith("pricing") ? `${FX}m_pricing` : null,
      title: t.title,
      contentMd: t.contentMd,
      source: "paste",
      ingestedAt: T0,
    });
  }
  // decidedAt spaced so exemplar ordering (desc) is stable, never "now".
  let n = 0;
  for (const c of CARDS) {
    await db.insert(schema.cards).values({
      id: c.id,
      userId: `${FX}user`,
      actionType: c.actionType,
      status: "dismissed",
      title: c.title,
      summary: "fixture",
      confidence: 0.7,
      priority: "normal",
      sourceJson: { kind: "meeting", title: "fixture", when: T0.toISOString() },
      payload: {},
      context: {},
      feedback: c.feedback,
      expiresAt: new Date(T0.getTime() + 7 * 86400_000),
      decidedAt: new Date(T0.getTime() + n++ * 60_000),
      createdAt: T0,
    });
  }
}

function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let name = "(head)";
  let buf: string[] = [];
  for (const line of text.split("\n")) {
    if (/^[A-Z][A-Z ]{3,}:/.test(line)) {
      out.set(name, buf.join("\n").trim());
      name = line.replace(/:.*$/, ":");
      buf = [line.slice(line.indexOf(":") + 1).trim()];
    } else buf.push(line);
  }
  out.set(name, buf.join("\n").trim());
  return out;
}

function lineDiff(a: string, b: string): string[] {
  const A = a.split("\n");
  const B = b.split("\n");
  const inB = new Set(B);
  const inA = new Set(A);
  const out: string[] = [];
  for (const l of A) if (!inB.has(l) && l.trim()) out.push(`  - ${l.slice(0, 150)}`);
  for (const l of B) if (!inA.has(l) && l.trim()) out.push(`  + ${l.slice(0, 150)}`);
  return out;
}

/** Memory rows carry a serial id that formatMemories prints so the model can revise an entry, and
 *  re-seeding assigns a fresh one every run. Left alone it would show as a change in every diff
 *  forever and drown the signal. The id is real prompt content, so it is normalised, not removed. */
function stabilise(s: string): string {
  return s.replace(/\[#\d+\]/g, "[#N]");
}

async function render(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const urows = await db.select().from(schema.users).where(eq(schema.users.id, `${FX}user`));
  const user = urows[0];
  for (const t of TRANSCRIPTS) {
    const trs = await db.select().from(schema.transcripts).where(eq(schema.transcripts.id, t.id));
    const req = await buildExtractRequest(user, trs[0], trs[0].contentMd);
    out.set(`extract__${t.title.replace(/\W+/g, "_")}`, stabilise(`--- SYSTEM ---\n${flatten(req.system)}\n\n--- USER ---\n${req.user}`));
  }
  const ms = await db.select().from(schema.meetings).where(eq(schema.meetings.id, `${FX}m_pricing`));
  const breq = await buildBriefingRequest(`${FX}user`, ms[0], user, userTz(user?.tz));
  if (breq) out.set("brief__Pricing_sync", stabilise(`--- SYSTEM ---\n${flatten(breq.system)}\n\n--- USER ---\n${breq.user}`));
  return out;
}

const safe = (k: string) => k.replace(/[^a-zA-Z0-9_.-]/g, "_");


async function main() {
  const snap = process.argv.includes("--snap");
  mkdirSync(DIR, { recursive: true });
  await initDb();

  let now: Map<string, string>;
  try {
    await seed();
    now = await render();
  } finally {
    await cleanup(); // fixtures never outlive the run, even if rendering threw
  }

  if (snap) {
    for (const [k, v] of now) writeFileSync(join(DIR, `${safe(k)}.txt`), v, "utf8");
    console.log(`snapshotted ${now.size} prompts to ${DIR}`);
    console.log("Edit the prompt, then: npm run prompts:check -w @haii/server");
    return;
  }

  const existing = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".txt")) : [];
  if (!existing.length) {
    console.log(`no snapshot in ${DIR}. Run: npm run prompts:snap -w @haii/server`);
    process.exit(2);
  }

  let changed = 0;
  for (const [k, v] of now) {
    const p = join(DIR, `${safe(k)}.txt`);
    if (!existsSync(p)) {
      console.log(`\nNEW  ${k} (no baseline)`);
      changed++;
      continue;
    }
    const before = readFileSync(p, "utf8");
    if (before === v) continue;
    changed++;
    console.log(`\nCHANGED  ${k}`);
    const sa = sections(before);
    const sb = sections(v);
    for (const name of new Set([...sa.keys(), ...sb.keys()])) {
      const x = sa.get(name) ?? "";
      const y = sb.get(name) ?? "";
      if (x === y) continue;
      console.log(`  [${name}]`);
      for (const line of lineDiff(x, y).slice(0, 20)) console.log(line);
    }
  }
  for (const f of existing) {
    const key = f.replace(/\.txt$/, "");
    if (![...now.keys()].map(safe).includes(key)) {
      console.log(`\nGONE  ${key} (fixture no longer produced)`);
      changed++;
    }
  }

  console.log(changed ? `\n${changed} prompt(s) changed.` : `\nno prompt changed (${now.size} checked).`);
  process.exit(changed ? 1 : 0);
}

main().catch(async (e) => {
  await cleanup().catch(() => {});
  console.error(String(e?.stack ?? e));
  if (e?.cause) console.error("cause:", String((e.cause as Error)?.stack ?? e.cause));
  process.exit(1);
});
