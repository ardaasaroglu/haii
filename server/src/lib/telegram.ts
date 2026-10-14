import { eq } from "drizzle-orm";
import { env } from "../env";
import { db, schema } from "../db";
import { log } from "../log";

let warned = false;
const lastAlert = new Map<string, number>();

/** Escape a dynamic value before interpolating it into a parse_mode:"HTML" message. Titles,
 *  transcript names, and LLM prose can carry a literal "<" (a stray one breaks the parser; a
 *  well-formed <a href> tag would render a real link in a message that looks like the bot's own).
 *  The static tags the call sites add (<b>, <i>) are written after escaping, so they survive. */
export function escapeHtml(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Who a user is, for an OPERATOR-facing line. Name, else email, else the raw id. Never throws:
 *  an identity lookup failing is not a reason to lose the alert it was decorating. */
export async function userLabel(userId: string): Promise<string> {
  if (!userId) return "system";
  try {
    const rows = await db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    const u = rows[0];
    return (u?.name || u?.email || userId) as string;
  } catch {
    return userId;
  }
}

/** A user's linked Telegram chat id, or null if they haven't linked one. */
async function chatIdFor(userId: string): Promise<string | null> {
  const rows = await db
    .select({ telegramChatId: schema.users.telegramChatId })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return rows[0]?.telegramChatId ?? null;
}

async function post(chatId: string, text: string, opts: { silent?: boolean } = {}): Promise<boolean> {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    if (!warned) {
      log.warn("telegram not configured; skipping outbound message");
      warned = true;
    }
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        disable_notification: !!opts.silent,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      // Dynamic content (meeting titles, LLM prose) can contain a stray "<" that breaks
      // Telegram's HTML parser and would silently cost the user the whole push. Losing the
      // formatting (and, worst case, an angle-bracketed fragment) beats losing the message.
      if (/can't parse entities/i.test(body)) {
        const plain = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: text.replace(/<[^>]*>/g, "").slice(0, 4000),
            disable_web_page_preview: true,
            disable_notification: !!opts.silent,
          }),
        });
        if (plain.ok) return true;
      }
      log.error({ status: res.status, body }, "telegram send failed");
      return false;
    }
    return true;
  } catch (e) {
    log.error({ err: String(e) }, "telegram send error");
    return false;
  }
}

/** Send a Telegram message (HTML) to a specific user's linked chat. Returns false silently
 *  if that user has no chat linked (or the bot token isn't configured). */
export async function tgSend(userId: string, text: string, opts: { silent?: boolean } = {}): Promise<boolean> {
  const chatId = await chatIdFor(userId);
  if (!chatId) return false;
  return post(chatId, text, opts);
}

/** Send a Telegram message to the operator/admin chat (boot, crash, job errors, budget, reauth). */
export async function tgAdmin(text: string, opts: { silent?: boolean } = {}): Promise<boolean> {
  if (!env.TELEGRAM_ADMIN_CHAT_ID) return false;
  return post(env.TELEGRAM_ADMIN_CHAT_ID, text, opts);
}

/** Alert with per-key throttling so a flapping job can't spam the chat. Always operator-facing. */
export async function tgAlertOnce(key: string, text: string, windowMs = 6 * 3600_000) {
  const last = lastAlert.get(key) ?? 0;
  if (Date.now() - last < windowMs) return;
  lastAlert.set(key, Date.now());
  await tgAdmin(`⚠️ ${text}`);
}

export async function telegramConfigured(): Promise<boolean> {
  return Boolean(env.TELEGRAM_BOT_TOKEN);
}

/** Operator visibility on a USER's activity, sent to the admin chat.
 *
 *  Deliberately content-free. Every line says what KIND of thing happened, never the card title,
 *  the meeting name, the recipient or the quote. Those come from that user's own inbox, calendar
 *  and meetings, and forwarding them to the operator's phone is not something a user agrees to by
 *  joining a shared instance. It also is not what the operator needs: "is it being used" and "is it
 *  failing" are both answerable from types and counts. Failures are the exception and already
 *  carry their title through recordFailure, because you cannot debug a failure you cannot identify.
 *
 *  Admins are skipped: the operator does not need a push about their own swipes. */
export async function opsNotify(userId: string, line: string): Promise<void> {
  if (!env.TELEGRAM_ADMIN_CHAT_ID) return;
  try {
    const rows = await db
      .select({ name: schema.users.name, email: schema.users.email, isAdmin: schema.users.isAdmin })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    const u = rows[0];
    if (!u || u.isAdmin) return;
    const who = u.name || u.email || userId;
    await tgAdmin(`<b>${escapeHtml(who)}</b> ${escapeHtml(line)}`, { silent: true });
  } catch (e) {
    // Never let observability break the thing it is observing.
    log.warn({ err: String(e), userId }, "ops notify failed");
  }
}
