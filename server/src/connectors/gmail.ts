import { log } from "../log";
import { getCursor, setCursor } from "../lib/connections";
import { gFetch, googleReady } from "./google";
import { buildRawMessage, toBase64Url } from "../lib/mime";
import { upsertItems, type RawItem } from "./normalize";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

function header(msg: any, name: string): string {
  return (
    msg?.payload?.headers?.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value ??
    ""
  );
}

async function fetchMessage(userId: string, id: string): Promise<RawItem | null> {
  const res = await gFetch(
    userId,
    `${BASE}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
  );
  if (!res.ok) return null;
  const msg: any = await res.json();
  return {
    connector: "gmail",
    external_id: msg.id,
    kind: "email",
    author: header(msg, "From"),
    title: header(msg, "Subject") || "(no subject)",
    body_text: msg.snippet ?? "",
    url: `https://mail.google.com/mail/u/0/#all/${msg.id}`,
    ts: new Date(Number(msg.internalDate || Date.now())),
  };
}

/* ---------------- drafting ----------------
 *  Haii cannot send mail and this does not change that. It creates a DRAFT in the user's own
 *  mailbox, which is the cheapest honest path from a captured commitment to a done one. A finished
 *  draft turns the follow-up into a press of send.
 */

export interface DraftResult {
  id: string;
  messageId: string;
  url: string;
}

/** Create a draft in the user's own mailbox. Throws on anything that is not a scope problem, and
 *  returns null when the token lacks gmail.compose, which the executor turns into `blocked` rather
 *  than into another to-do. Scoped to the card's owner. */
export async function createDraft(
  userId: string,
  input: { to: string; subject: string; body: string },
): Promise<DraftResult | null> {
  const res = await gFetch(userId, `${BASE}/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // base64url, not the RFC822 string and not standard base64. Both of the wrong answers are a
    // 400 that names no field.
    body: JSON.stringify({ message: { raw: toBase64Url(buildRawMessage(input)) } }),
  });
  // 403 is the missing scope, and it is the expected state for every user who has not re-consented
  // since gmail.compose was added. 401 is a dead token, which the connector health path owns.
  if (res.status === 403 || res.status === 401) {
    log.warn({ userId, status: res.status }, "gmail draft refused: token lacks gmail.compose");
    return null;
  }
  if (!res.ok) throw new Error(`gmail draft ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const d: any = await res.json();
  const messageId = String(d?.message?.id ?? "");
  return {
    id: String(d?.id ?? ""),
    messageId,
    // Opens the draft in the compose window. Built from the MESSAGE id, not the draft id: the two
    // are different and the drafts view keys on the message.
    url: messageId ? `https://mail.google.com/mail/u/0/#drafts?compose=${messageId}` : "https://mail.google.com/mail/u/0/#drafts",
  };
}

/** Poll Gmail via history.list with a stored historyId cursor; 7-day backfill on first run.
 *  Every call below is scoped to the polled user. */
export async function pollGmail(userId: string): Promise<string> {
  if (!(await googleReady(userId))) return "skipped: google not connected";
  const cursor = await getCursor<{ historyId?: string }>(userId, "google");

  if (!cursor.historyId) {
    const profRes = await gFetch(userId, `${BASE}/profile`);
    if (!profRes.ok) throw new Error(`gmail profile ${profRes.status}`);
    const prof: any = await profRes.json();

    const listRes = await gFetch(
      userId,
      `${BASE}/messages?q=${encodeURIComponent("newer_than:7d -category:promotions -category:social")}&maxResults=25`,
    );
    if (!listRes.ok) throw new Error(`gmail list ${listRes.status}`);
    const list: any = await listRes.json();
    const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
    const found: RawItem[] = [];
    for (const id of ids) {
      const item = await fetchMessage(userId, id);
      if (item) found.push(item);
    }
    const n = await upsertItems("google", found, userId);
    await setCursor(userId, "google", { ...cursor, historyId: prof.historyId });
    return `backfill: ${n} emails, baseline historyId set`;
  }

  const res = await gFetch(
    userId,
    `${BASE}/history?startHistoryId=${cursor.historyId}&historyTypes=messageAdded&maxResults=50`,
  );
  if (res.status === 404) {
    // Cursor too old; re-baseline on the next poll.
    await setCursor(userId, "google", { ...cursor, historyId: undefined });
    log.warn({ userId }, "gmail history cursor expired; re-baselining");
    return "cursor expired; re-baselining next poll";
  }
  if (!res.ok) throw new Error(`gmail history ${res.status}`);
  const data: any = await res.json();
  const ids = new Set<string>();
  for (const h of data.history ?? []) {
    for (const added of h.messagesAdded ?? []) {
      if (added.message?.id) ids.add(added.message.id);
    }
  }
  const found: RawItem[] = [];
  for (const id of [...ids].slice(0, 30)) {
    const item = await fetchMessage(userId, id);
    if (item) found.push(item);
  }
  const n = await upsertItems("google", found, userId);
  if (data.historyId) await setCursor(userId, "google", { ...cursor, historyId: data.historyId });
  return `${n} new emails`;
}

