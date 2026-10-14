import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { gFetch } from "../connectors/google";
import { log } from "../log";
import { pickSlot, type Interval } from "./slot";
import { dayKeyInTz, hhmmInTz } from "./tz";

type Att = { email: string; name: string };

function firstTok(s: string): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .split(/[\s.]+/)[0] || "";
}

async function meetingAttendees(userId: string, meetingId: string): Promise<Att[]> {
  const rows = await db
    .select({ att: schema.meetings.attendees })
    .from(schema.meetings)
    .where(and(eq(schema.meetings.id, meetingId), eq(schema.meetings.userId, userId)));
  const att = rows[0]?.att;
  return Array.isArray(att) ? (att as Att[]) : [];
}

/** First-name match a bare name against a synced attendee list, then the person-entity aliases. */
function matchEmail(name: string, meetingAtt: Att[], persons: Array<{ name: string; aliases: unknown }>): string | null {
  const n = firstTok(name);
  if (!n) return null;
  for (const a of meetingAtt) {
    if (!a.email) continue;
    const localFirst = a.email.toLowerCase().split("@")[0].split(/[._-]/)[0];
    if (firstTok(a.name) === n || localFirst === n) return a.email;
  }
  for (const p of persons) {
    const aliases = Array.isArray(p.aliases) ? (p.aliases as unknown[]) : [];
    const emailAlias = aliases.find((x): x is string => typeof x === "string" && x.includes("@"));
    if (!emailAlias) continue;
    const nameHit = firstTok(p.name) === n || aliases.some((x) => typeof x === "string" && firstTok(x) === n);
    if (nameHit) return emailAlias;
  }
  return null;
}

/** Resolve a comma/semicolon list of attendee NAMES (what the extractor produces) to emails.
 *  Sources, in order: the linked meeting's synced attendees (carry real emails), then the
 *  person-entity store (people-learning stores aliases as [name, email]). Tokens that already
 *  look like emails pass through; names we can't resolve are returned in `unresolved`. */
export async function resolveAttendeeEmails(
  userId: string,
  raw: string,
  meetingId: string | null,
): Promise<{ emails: string[]; unresolved: string[] }> {
  const tokens = String(raw ?? "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!tokens.length) return { emails: [], unresolved: [] };

  const meetingAtt = meetingId ? await meetingAttendees(userId, meetingId) : [];
  const persons = await db
    .select({ name: schema.entities.name, aliases: schema.entities.aliases })
    .from(schema.entities)
    .where(and(eq(schema.entities.userId, userId), eq(schema.entities.type, "person")));

  const emails: string[] = [];
  const unresolved: string[] = [];
  for (const tok of tokens) {
    if (tok.includes("@")) {
      emails.push(tok.toLowerCase());
      continue;
    }
    const email = matchEmail(tok, meetingAtt, persons);
    if (email) emails.push(email.toLowerCase());
    else unresolved.push(tok);
  }
  return { emails: [...new Set(emails)], unresolved };
}

/** Raw FreeBusy fetch shared by the slot picker and the pre-execution re-check.
 *  Returns null (rather than throwing or an empty array) when the query itself could not be
 *  answered, so callers can distinguish "nobody is busy" from "we could not tell". */
async function fetchBusy(
  userId: string,
  emails: string[],
  timeMin: Date,
  timeMax: Date,
  tz: string,
): Promise<Interval[] | null> {
  const items = emails.filter(Boolean).map((email) => ({ id: email }));
  if (!items.length) return null;
  const res = await gFetch(userId, "https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      timeZone: tz,
      items,
    }),
  });
  if (!res.ok) {
    log.warn({ status: res.status, body: (await res.text()).slice(0, 200) }, "freeBusy query failed");
    return null;
  }
  const data: any = await res.json();
  const busy: Interval[] = [];
  for (const cal of Object.values<any>(data.calendars ?? {})) {
    for (const b of cal?.busy ?? []) {
      const s = Date.parse(b.start);
      const e = Date.parse(b.end);
      if (!Number.isNaN(s) && !Number.isNaN(e)) busy.push({ start: s, end: e });
    }
  }
  return busy;
}

/** Pre-execution re-check. A card is proposed with a slot that was open at EXTRACTION time, but
 *  cards live up to 7 days, so the slot can be taken by the time the user nods. Called by the
 *  executor just before creating the event.
 *
 *  Fail-open by design: "unverifiable" (no calendar.readonly scope, API error, no emails) returns
 *  free:true, because blocking a user's approved action on a telemetry call we cannot make would
 *  be worse than the rare double-book. Only a definitive "someone is busy" returns free:false. */
export async function isSlotFree(
  userId: string,
  opts: { startMs: number; endMs: number; emails: string[]; tz: string },
): Promise<{ free: boolean; verified: boolean }> {
  try {
    const busy = await fetchBusy(
      userId,
      opts.emails,
      new Date(opts.startMs),
      new Date(opts.endMs),
      opts.tz,
    );
    if (busy === null) return { free: true, verified: false };
    const clash = busy.some((b) => opts.startMs < b.end && opts.endMs > b.start);
    return { free: !clash, verified: true };
  } catch (e: any) {
    log.warn({ err: String(e?.message ?? e) }, "isSlotFree check failed");
    return { free: true, verified: false };
  }
}

/** Query Google FreeBusy across the user + attendees and return the earliest open working-hours
 *  slot (in the user's zone) as { date: YYYY-MM-DD, time: HH:MM }. Returns null on missing key or
 *  scope, API error, or no gap found. NEVER throws: scheduling is an enhancement, so a failure
 *  here must let extraction fall back to the model's guessed time rather than losing the card. */
export async function findOpenSlot(
  userId: string,
  opts: {
    tz: string;
    durationMin: number;
    selfEmail: string;
    attendeeEmails: string[];
    /** Earliest acceptable start. The caller sets it from what the transcript said: the start of a
     *  named day for "next Tuesday", the start of tomorrow when nothing was said. Never earlier
     *  than ten minutes from now whatever is passed, because a slot in the past is not a proposal.
     *  Default is ten minutes from now. */
    notBefore?: number;
  },
): Promise<{ date: string; time: string } | null> {
  try {
    const now = Date.now();
    const from = Math.max(now + 10 * 60_000, opts.notBefore ?? 0);
    const busy = await fetchBusy(
      userId,
      [opts.selfEmail, ...opts.attendeeEmails],
      new Date(from),
      new Date(from + 14 * 24 * 3600_000),
      opts.tz,
    );
    if (busy === null) return null;
    const slot = pickSlot(busy, {
      tz: opts.tz,
      fromMs: from,
      days: 14,
      workStartHour: 9,
      workEndHour: 18,
      durationMin: opts.durationMin,
      stepMin: 30,
    });
    if (!slot) return null;
    const at = new Date(slot.startMs);
    return { date: dayKeyInTz(opts.tz, at), time: hhmmInTz(opts.tz, at) };
  } catch (e: any) {
    log.warn({ err: String(e?.message ?? e) }, "findOpenSlot failed");
    return null;
  }
}
