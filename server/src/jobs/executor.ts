import { and, eq, inArray, lte } from "drizzle-orm";
import { db, schema, OWNER } from "../db";
import { env } from "../env";
import { log } from "../log";
import { getMeta, isConnected } from "../lib/connections";
import { tgAlertOnce, tgSend, escapeHtml, opsNotify } from "../lib/telegram";
import { recordFailure } from "../lib/failures";
import { splitError, UserFacingError } from "../lib/errorSplit";
import { jiraFetch, jiraCreds } from "../connectors/jira";
import { slackPost } from "../connectors/slack";
import { gFetch, googleReady } from "../connectors/google";
import { createDraft } from "../connectors/gmail";
import { createDocument, shareFile } from "../connectors/docs";
import { crmNote } from "../connectors/crm";
import { linearCreateIssue, asanaCreateTask } from "../connectors/trackers";
import { isSlotFree, findOpenSlot } from "../lib/schedule";
import { startHasPassed, nextWorkdayStart } from "../lib/slot";
import { cardResolutionTz, zonedTimeToUtc, dayKeyInTz, hhmmInTz } from "../lib/tz";

export const UNDO_GRACE_MS = 5_000;

const EXECUTOR_POLL_MS = 5_000;
const EXECUTOR_BATCH_LIMIT = 10;

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Wall-clock ISO (no zone suffix) of an absolute instant AS SEEN IN `tz`; the event's timeZone
 *  field carries the zone. Must be computed in the user's zone, not the server's: the server runs
 *  UTC by design in cloud, so a server-local rendering shifted every event by the user's offset. */
function localIsoInTz(tz: string, d: Date): string {
  return `${dayKeyInTz(tz, d)}T${hhmmInTz(tz, d)}:00`;
}

/** `mode` survives the removal of dry-run because a connector that is not connected still cannot
 *  act; that is a real state the card must report, not a simulation setting. Nothing else is
 *  simulated: there is no test-flight mode and no per-connector dry_run toggle, so an approved card
 *  either does the thing or fails loudly. */
interface ExecOutcome {
  mode: "real" | "blocked";
  detail: string;
  url?: string;
}

/** What the USER is told when a provider rejected their approved action, by action type.
 *
 *  Never the provider's own words. These name the destination and the next step, because the user's
 *  question is "which card do I fix", not "what did the API say". The cause is hedged where we
 *  genuinely cannot know it: a 400 from Gmail is usually the address but not always, so it says
 *  "may be wrong" rather than asserting.
 *
 *  Design system: amber, never red. These are states to recover from, and every line ends with the
 *  way out. */
const FAILED_COPY: Record<string, string> = {
  send_email: "Gmail would not accept this draft. The address on the card may be wrong. Edit it and approve again.",
  create_calendar_event: "Google Calendar would not accept this event. Edit the card and approve again.",
  create_jira_issue: "Jira would not accept this issue. Edit the card and approve again.",
  create_task: "That tracker would not accept this task. Edit the card and approve again.",
  send_slack_message: "Slack would not accept this message. Edit the card and approve again.",
  create_document: "Google Drive would not create this document. Edit the card and approve again.",
  share_file: "Google Drive would not share that file. Edit the card and approve again.",
  create_crm_note: "Your CRM would not accept this note. Edit the card and approve again.",
  send_text: "Haii could not hand this to your Messages app. Edit the card and approve again.",
};
const FAILED_FALLBACK = "This did not go through. Nothing was sent. Edit the card and approve again.";

/** The Jira project a new issue goes to: the one named on the card, else JIRA_PROJECT from
 *  server/.env. Never a built-in key, because a key that exists on one Jira site does not exist on
 *  another. Empty when neither is set, and the caller then refuses with a sentence the user can act
 *  on, the same way a card with no recipient is refused. */
function jiraProjectKey(payload: any): string {
  return String(payload?.project ?? "").trim() || env.JIRA_PROJECT;
}

async function performAction(card: typeof schema.cards.$inferSelect): Promise<ExecOutcome> {
  const payload = card.payload as any;
  const userId = card.userId;

  switch (card.actionType) {
    case "create_todo": {
      await db.insert(schema.todos).values({
        id: id("todo"),
        userId,
        title: payload.title ?? card.title,
        due: payload.due ?? "",
        notes: payload.notes ?? "",
        cardId: card.id,
      });
      return { mode: "real", detail: "Saved to your to-do list in Haii." };
    }
    case "create_jira_issue": {
      if (!(await isConnected(userId, "jira"))) return { mode: "blocked", detail: "Jira is not connected" };
      const projectKey = jiraProjectKey(payload);
      // Thrown, not blocked, for the same reason as the missing recipient on send_email below:
      // blocked means a connector is missing, and Jira is connected here.
      if (!projectKey) {
        throw new UserFacingError("No Jira project is set. Name the project on the card, or add JIRA_PROJECT to server/.env.");
      }
      const res = await jiraFetch(userId, "/rest/api/3/issue", {
        method: "POST",
        body: JSON.stringify({
          fields: {
            project: { key: projectKey },
            issuetype: { name: payload.issue_type || "Task" },
            summary: payload.summary,
            description: {
              type: "doc",
              version: 1,
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: payload.description || payload.summary }],
                },
              ],
            },
            ...(payload.labels
              ? { labels: String(payload.labels).split(",").map((l: string) => l.trim().replace(/\s+/g, "-")).filter(Boolean) }
              : {}),
          },
        }),
      });
      if (!res.ok) throw new Error(`jira create ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const created: any = await res.json();
      const c = await jiraCreds(userId);
      return {
        mode: "real",
        detail: `created ${created.key}`,
        url: c ? `https://${c.site}/browse/${created.key}` : undefined,
      };
    }
    case "create_task": {
      // A TICKET, not a to-do. A to-do lives in Haii's own list and never leaves; this type exists
      // for the different promise, "I'll raise a ticket for that", where the deliverable is an issue
      // in the tracker the team works in.
      const dest = String(payload.destination ?? "").toLowerCase();
      const title = payload.title ?? card.title;
      const body = payload.description ?? "";
      if (dest === "jira") {
        if (!(await isConnected(userId, "jira"))) return { mode: "blocked", detail: "Jira is not connected" };
        const projectKey = jiraProjectKey(payload);
        // A task card has no project field to edit, so the only fix the user has is the setting.
        if (!projectKey) throw new UserFacingError("No Jira project is set. Add JIRA_PROJECT to server/.env.");
        const res = await jiraFetch(userId, "/rest/api/3/issue", {
          method: "POST",
          body: JSON.stringify({
            fields: {
              project: { key: projectKey },
              issuetype: { name: "Task" },
              summary: title,
              description: {
                type: "doc",
                version: 1,
                content: [{ type: "paragraph", content: [{ type: "text", text: body || title }] }],
              },
            },
          }),
        });
        if (!res.ok) throw new Error(`jira create ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const created: any = await res.json();
        const c = await jiraCreds(userId);
        return { mode: "real", detail: `created ${created.key}`, url: c ? `https://${c.site}/browse/${created.key}` : undefined };
      }
      if (dest === "linear") {
        const r = await linearCreateIssue(userId, title, body);
        return r.ok ? { mode: "real", detail: r.detail, url: r.url } : { mode: "blocked", detail: r.detail };
      }
      if (dest === "asana") {
        const r = await asanaCreateTask(userId, title, body, payload.due ?? "");
        return r.ok ? { mode: "real", detail: r.detail, url: r.url } : { mode: "blocked", detail: r.detail };
      }
      // An unrecognised destination is blocked, never silently redirected somewhere else: the user
      // nodded a ticket in a named tracker, and filing it elsewhere is not a smaller version of that.
      return { mode: "blocked", detail: `no tracker called "${payload.destination}" is connected` };
    }
    case "create_document": {
      const r = await createDocument(userId, payload.title ?? card.title, payload.content ?? "", payload.share_with ?? "");
      // `blocked` and not `failed` when Drive is out of reach: the outside world did not fail, we
      // are simply not connected to it yet, and that is a thing the user can fix.
      if (!r.ok) return { mode: "blocked", detail: r.detail };
      return { mode: "real", detail: r.detail, url: r.url };
    }
    case "share_file": {
      const r = await shareFile(userId, payload.file_name ?? "", payload.emails ?? "", payload.role ?? "reader");
      if (!r.ok) return { mode: "blocked", detail: r.detail };
      return { mode: "real", detail: r.detail, url: r.url };
    }
    case "create_crm_note": {
      const r = await crmNote(userId, payload.contact ?? "", payload.note ?? card.title);
      if (!r.ok) return { mode: "blocked", detail: r.detail };
      return { mode: "real", detail: r.detail, url: r.url };
    }
    case "send_slack_message": {
      if (!(await isConnected(userId, "slack"))) return { mode: "blocked", detail: "Slack is not connected" };
      const out = await slackPost(userId, payload.channel, payload.message, payload.thread_ts || undefined);
      return {
        mode: "real",
        detail: payload.thread_ts ? `replied in thread in ${payload.channel}` : `posted to ${payload.channel}`,
        url: out.url,
      };
    }
    case "send_email": {
      // This used to write the finished mail into a TO-DO, because Haii could not reach Gmail at
      // all: the user composed it, approved it, and got a note to themselves.
      // gmail.compose creates the real draft in their own mailbox instead. Haii still cannot send,
      // and is not trying to: the mail sits in Gmail until a human presses send, so "nothing sends
      // without a gesture" is untouched and this needs no data-boundary work.
      if (!(await googleReady(userId))) return { mode: "blocked", detail: "Google is not connected" };
      const to = String(payload.to ?? "").trim();
      const subject = String(payload.subject ?? "").trim();
      // Thrown, not blocked: blocked means a connector is missing and routes the card to a
      // follow-up grouped by connector, which would be a lie about what went wrong. Same shape as
      // the calendar card's date check.
      if (!to) throw new UserFacingError("This card has no recipient. Edit it and approve again.");
      const draft = await createDraft(userId, {
        to,
        subject: subject || card.title,
        body: String(payload.body ?? ""),
      });
      // null means the token has no gmail.compose, which is EVERY user until they re-consent once.
      // Deliberately NOT a to-do: quietly writing one is the exact lie this replaced, and it would
      // read as success while nothing reached Gmail.
      if (!draft) {
        return { mode: "blocked", detail: "reconnect Google in Setup to let Haii write drafts" };
      }
      return { mode: "real", detail: "drafted in Gmail, ready for you to send", url: draft.url };
    }
    case "send_text": {
      // THE ONLY TYPE THAT DOES NOT ACT HERE, and the reason is a browser rule rather than a
      // product one. A text is handed off through an `sms:` URL, and following an external URL
      // scheme reliably requires being inside a user gesture. This function runs UNDO_GRACE_MS
      // after the swipe, by which time the gesture is long gone and iOS will not follow it. So the
      // CLIENT opens the link in its own swipe handler and this case records what happened.
      //
      // The URL is therefore built in ONE place, the client, rather than here as well. Two
      // implementations of the same string would drift, and the half that matters is the half we
      // cannot test from a server.
      //
      // No connector check, because there is no connector. Every other type can be blocked by
      // something the user has not connected; this one cannot fail that way, which is exactly why
      // it earns its place under the rule that a type executes in proportion to whether the user
      // already holds the destination.
      //
      // No recipient check either. An empty `to` is a valid card: `sms:&body=...` opens Messages
      // with the To field empty and the message written, and the user picks the person. Throwing
      // here would be Haii inventing a problem it has already solved, which the swipe invariant
      // forbids.
      if (!String(payload.body ?? "").trim()) {
        throw new UserFacingError("This card has no message. Edit it and approve again.");
      }
      return { mode: "real", detail: "ready to send in Messages" };
    }
    case "create_calendar_event": {
      if (!(await googleReady(userId))) return { mode: "blocked", detail: "Google is not connected" };
      const date = String(payload.date ?? "").trim();
      const time = String(payload.time ?? "").trim();
      const wellFormed = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{1,2}:\d{2}$/.test(time);
      const [h, m] = wellFormed ? time.split(":").map(Number) : [0, 0];
      const [Y, Mo, D] = wellFormed ? date.split("-").map(Number) : [0, 0, 0];
      // The card's date/time are the USER's wall clock: findOpenSlot emits them via dayKeyInTz/
      // hhmmInTz, and the model reads meeting times rendered in the user's zone. Interpreting them
      // in the SERVER's zone (UTC by design in cloud) shifted every event by the user's offset,
      // e.g. a 14:00 slot for a user at UTC+3 was created at 14:00 UTC, which is 17:00 on their
      // clock, and made the slot re-check below probe an unrelated hour, so it silently passed.
      const urows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
      // Resolve against the zone the card was PROPOSED in, not the zone the user is in now.
      // Cards live 7 days and users cross continents inside that window; the wall clock in the
      // payload is a commitment already made, so re-reading it in a new zone silently moves a
      // meeting the attendees have already been told about. Falls back to the live zone only for
      // cards proposed before the stamp existed, which is what used to happen to all of them.
      const stampedTz = ((card.context as { scheduling?: { tz?: unknown } } | null)?.scheduling ?? {}).tz;
      const tz = cardResolutionTz(stampedTz, urows[0]?.tz);
      const attendees = String(payload.attendees ?? "")
        .split(/[,;]/)
        .map((s: string) => s.trim())
        .filter((s: string) => s.includes("@"));
      const durationMin = Number(payload.duration_min) || 30;

      // A SWIPE ALWAYS PRODUCES A MEETING. The rule: after a swipe Haii finds a sensible answer
      // instead of showing an error. The product exists to solve problems for the user, not to
      // hand them new ones.
      //
      // Three separate things used to throw here and send the user back to the edit sheet with
      // nothing: a malformed time, a time that had passed, and a slot someone had since taken. All
      // three have the same answer, because we already own it: find the next opening. The user
      // approved "meet Dana", not "meet Dana at exactly 14:00 or not at all".
      //
      // Every one of them is now one path. The only thing that changes is the sentence explaining
      // what happened, and the user gets that in the result immediately, with undo untouched.
      //
      // What is NOT swallowed: Google being down, or the account not being connected. Those are the
      // world failing rather than Haii inventing a problem, and reporting them is honest.
      let start: Date | null = null;
      let movedFrom = "";
      if (wellFormed && !startHasPassed(tz, date, time)) {
        const candidate = zonedTimeToUtc(tz, Y, Mo, D, h, m);
        // The slot was open when the card was PROPOSED, but cards live 7 days. Fail-OPEN on an
        // unverifiable answer (no calendar.readonly scope, API error): only a definite "someone is
        // busy" moves it, because guessing that a slot is taken and silently relocating a meeting
        // the attendees may already know about is worse than the occasional double-book.
        const check = await isSlotFree(userId, {
          startMs: candidate.getTime(),
          endMs: candidate.getTime() + durationMin * 60_000,
          emails: [urows[0]?.email ?? "", ...attendees],
          tz,
        });
        if (check.free) start = candidate;
        else movedFrom = `${date} ${time} was taken`;
      } else if (wellFormed) {
        movedFrom = `${date} ${time} had already passed`;
      } else {
        // Extraction's own fallback should mean this never arrives, but a card edited by hand can
        // still carry nonsense. Picking a time beats refusing one.
        movedFrom = "no usable time was set";
      }

      if (!start) {
        const slot = await findOpenSlot(userId, {
          tz,
          durationMin,
          selfEmail: urows[0]?.email ?? "",
          attendeeEmails: attendees,
          notBefore: Date.now(),
        });
        if (slot) {
          const [nY, nMo, nD] = slot.date.split("-").map(Number);
          const [nh, nm] = slot.time.split(":").map(Number);
          start = new Date(zonedTimeToUtc(tz, nY, nMo, nD, nh, nm).getTime());
        } else {
          // Free/busy could not answer, or the next fortnight is genuinely solid. Propose anyway.
          // There USED to be a threshold here that refused when the next opening was far out, and
          // it is gone: it was the same dead end in a new coat. If the calendar is full, booking
          // the first gap and saying so beats a red banner.
          start = new Date(nextWorkdayStart(tz, Date.now(), 10));
        }
      }
      const end = new Date(start.getTime() + durationMin * 60_000);
      const evBody = {
        summary: payload.title || card.title,
        description: `${card.summary}\n\nCreated by Haii on a nod.`,
        start: { dateTime: localIsoInTz(tz, start), timeZone: tz },
        end: { dateTime: localIsoInTz(tz, end), timeZone: tz },
        conferenceData: {
          createRequest: { requestId: id("meet"), conferenceSolutionKey: { type: "hangoutsMeet" } },
        },
        ...(attendees.length ? { attendees: attendees.map((email: string) => ({ email })) } : {}),
      };
      const qs = `conferenceDataVersion=1${attendees.length ? "&sendUpdates=all" : ""}`;
      const res = await gFetch(userId, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${qs}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(evBody),
      });
      if (!res.ok) throw new Error(`calendar create ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const ev: any = await res.json();
      const meet = ev.hangoutLink || ev.conferenceData?.entryPoints?.[0]?.uri || "";
      // Rendered from the instant actually created, never from the payload strings. Those are the
      // time the card ASKED for, and after a move they are no longer the time that exists.
      const madeDay = dayKeyInTz(tz, start);
      const madeTime = hhmmInTz(tz, start);
      return {
        mode: "real",
        detail:
          `event created ${madeDay} ${madeTime}` +
          // The move is stated first and in plain words, because this is the only place the user
          // finds out that what they nodded at is not quite what happened. movedFrom carries its
          // own reason now, since there are three of them.
          (movedFrom ? ` · ${movedFrom}, so Haii moved it` : "") +
          (attendees.length ? ` · invited ${attendees.join(", ")}` : "") +
          (meet ? ` · Meet: ${meet}` : ""),
        url: ev.htmlLink,
      };
    }
    default:
      return { mode: "blocked", detail: `unknown action_type ${card.actionType}` };
  }
}

async function execute(cardId: string) {
  const rows = await db.select().from(schema.cards).where(eq(schema.cards.id, cardId));
  const card = rows[0];
  if (!card || card.status !== "approved") return;

  await db.update(schema.cards).set({ status: "executing" }).where(eq(schema.cards.id, cardId));
  try {
    const outcome = await performAction(card);
    await db
      .update(schema.cards)
      .set({
        status: "executed",
        executedAt: new Date(),
        feedback: { ...((card.feedback as object) ?? {}), executed: outcome },
      })
      .where(eq(schema.cards.id, cardId));
    // A blocked action used to vanish: the card was marked executed, the UI said "not sent", and
    // nothing was written anywhere, so an approved commitment silently ceased to exist. It is
    // still an open loop, and the thing standing in its way is ours to fix, so record it as a
    // follow-up. create_todo writes its own row above and is never blocked; only the
    // connector-gated actions land here.
    if (outcome.mode === "blocked") {
      await db.insert(schema.todos).values({
        id: id("todo"),
        userId: card.userId,
        title: card.title,
        due: "",
        notes: `${outcome.detail}. Once that is connected, Haii can do it for you from Follow-ups.`,
        cardId: card.id,
      });
      // Not an error, so it never reached recordFailure, and the operator heard nothing. But from
      // the user's side this is Haii promising and not delivering: they approved something and it
      // did not happen. The reason is a connector name, not their content, so it is safe to send.
      void opsNotify(card.userId, `approved a card Haii could not do: ${outcome.detail.toLowerCase()}`);
    }
    log.info({ card: card.title, ...outcome }, "card executed");
  } catch (e: any) {
    // The user is told what did not happen and what to do. The provider's own words go to the
    // operator and nowhere else. Before this, `detail` was the raw exception and it reached BOTH
    // the in-app banner and the user's Telegram, so a Gmail 400 could land on the Today screen as
    // a wall of JSON. The invariant was already written down; nothing enforced it.
    //
    // The fallback names the DESTINATION rather than apologising generically, because "Gmail would
    // not accept this" tells the user which card to look at and "something went wrong" does not.
    const { detail, operatorNote } = splitError(e, FAILED_COPY[card.actionType] ?? FAILED_FALLBACK);
    await db
      .update(schema.cards)
      .set({
        status: "failed",
        feedback: { ...((card.feedback as object) ?? {}), executed: { mode: "real", detail: `FAILED: ${detail}` } },
      })
      .where(eq(schema.cards.id, cardId));
    log.error({ card: card.title, err: detail }, "card execution failed");
    // Tell the CARD OWNER, not just the operator. tgAlertOnce routes to TELEGRAM_ADMIN_CHAT_ID,
    // so before this the user who nodded a card believed the meeting was booked or the message
    // sent, and only found out days later from the other person. Not throttled: an action the
    // user personally approved and that did not happen is never noise.
    // tgSend returns false when that user has no linked chat, and discarding it meant the alert
    // could evaporate with nothing logged and nobody told. The in-app banner still catches it, but
    // the operator needs to know the phone path is dark for this user.
    const notified = await tgSend(
      card.userId,
      `⚠️ <b>Did not go through</b>\n${escapeHtml(card.title)}\n\n${escapeHtml(detail)}\n\nNothing was sent. Open Haii to edit and approve again.`,
    );
    if (!notified) log.warn({ userId: card.userId, card: card.id }, "execution failure alert undeliverable: user has no linked telegram chat");
    // Dead-letter + operator ping naming the user. NOT throttled: an action the user personally
    // approved and that did not happen is never noise, and two different failed cards are two
    // different problems.
    await recordFailure({
      userId: card.userId,
      kind: "execution",
      ref: card.id,
      title: card.title,
      detail,
      // The provider's actual words live HERE and only here. Joined with the reachability note
      // rather than replacing it: losing "this user has no Telegram" would hide that the phone path
      // is dark for them, which is the thing that made this class of failure invisible before.
      operatorNote:
        [operatorNote, notified ? "" : "user is not reachable on Telegram; they will only see this in-app"]
          .filter(Boolean)
          .join(" · ") || undefined,
    });
  }
}

/** Approve path: upsert a DB-backed execution row due after the undo grace window. Survives
 *  restarts and deploys: the poller, not an in-process timer, is what actually fires it. */
export async function scheduleExecution(cardId: string, delayMs = UNDO_GRACE_MS): Promise<void> {
  const rows = await db.select({ userId: schema.cards.userId }).from(schema.cards).where(eq(schema.cards.id, cardId));
  const userId = rows[0]?.userId ?? OWNER;
  const executeAfter = new Date(Date.now() + delayMs);
  await db
    .insert(schema.executions)
    .values({ cardId, userId, executeAfter, status: "queued" })
    .onConflictDoUpdate({
      target: schema.executions.cardId,
      set: { executeAfter, status: "queued" },
    });
}

/** Undo path: cancel a pending (still-queued) execution. Returns true if one was cancelled. */
export async function cancelExecution(cardId: string): Promise<boolean> {
  const rows = await db
    .update(schema.executions)
    .set({ status: "cancelled" })
    .where(and(eq(schema.executions.cardId, cardId), eq(schema.executions.status, "queued")))
    .returning({ id: schema.executions.id });
  return rows.length > 0;
}

let polling = false;

async function executorTick() {
  if (polling) return;
  polling = true;
  try {
    const due = await db
      .select({ id: schema.executions.id, cardId: schema.executions.cardId })
      .from(schema.executions)
      .where(and(eq(schema.executions.status, "queued"), lte(schema.executions.executeAfter, new Date())))
      .orderBy(schema.executions.executeAfter)
      .limit(EXECUTOR_BATCH_LIMIT);

    for (const row of due) {
      // Claim it first (queued -> running); a 0-row result means another tick/process raced us.
      const claimed = await db
        .update(schema.executions)
        .set({ status: "running" })
        .where(and(eq(schema.executions.id, row.id), eq(schema.executions.status, "queued")))
        .returning({ id: schema.executions.id });
      if (!claimed.length) continue;

      await execute(row.cardId);

      const cardRows = await db
        .select({ status: schema.cards.status })
        .from(schema.cards)
        .where(eq(schema.cards.id, row.cardId));
      const finalStatus = cardRows[0]?.status === "executed" ? "done" : "failed";
      await db.update(schema.executions).set({ status: finalStatus }).where(eq(schema.executions.id, row.id));
    }
  } catch (e: any) {
    log.error({ err: String(e?.message ?? e) }, "executor poller tick failed");
  } finally {
    polling = false;
  }
}

/** DB-backed executor poller: replaces the in-process setTimeout scheduler so approved cards
 *  still execute on time across a restart or deploy. */
export function startExecutorPoller() {
  setInterval(() => void executorTick(), EXECUTOR_POLL_MS);
  log.info({ intervalMs: EXECUTOR_POLL_MS }, "executor poller started");
}

/** Boot recovery: cards left approved/executing by a previous process run now (+3s grace). */
export async function recoverPending() {
  const stuck = await db
    .select({ id: schema.cards.id, status: schema.cards.status, feedback: schema.cards.feedback })
    .from(schema.cards)
    .where(inArray(schema.cards.status, ["approved", "executing"]));
  let requeued = 0;
  let quarantined = 0;
  for (const c of stuck) {
    if (c.status === "executing") {
      // Do NOT re-queue. "executing" means performAction was already in flight, and we have no
      // record of whether the external side effect landed, so a redeploy mid-call would post the
      // Slack message / create the Jira issue a second time. Park it for a fresh human gesture
      // instead: a missed action the user can see beats a duplicate they cannot take back.
      await db
        .update(schema.cards)
        .set({
          status: "failed",
          feedback: {
            ...((c.feedback as object) ?? {}),
            executed: {
              mode: "real",
              detail:
                "INTERRUPTED: the server restarted while this was executing. It may or may not have gone through, so Haii did not retry it. Check, then approve again if needed.",
            },
          },
        })
        .where(eq(schema.cards.id, c.id));
      quarantined++;
      continue;
    }
    // Only "approved" (queued, never started) is safe to re-queue blindly.
    await scheduleExecution(c.id, 3_000);
    requeued++;
  }
  if (stuck.length) log.info({ requeued, quarantined }, "recovered pending executions");
  if (quarantined) {
    await tgAlertOnce(
      `exec_interrupted:${quarantined}`,
      `${quarantined} card(s) were mid-execution when Haii restarted. They were NOT retried (they may already have gone through). Check the History tab.`,
    );
  }
}
