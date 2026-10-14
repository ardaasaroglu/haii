import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { env } from "../env";
import { log } from "../log";
import { decrypt, safeEqual } from "../lib/crypto";

/** Telegram webhook receiver: completes the /api/v1/telegram/link deep-link handshake.
 *  Not behind requireUser, because Telegram calls this, not a Haii session. Authenticated instead by
 *  the X-Telegram-Bot-Api-Secret-Token header Telegram echoes back on every delivery once
 *  TELEGRAM_WEBHOOK_SECRET is registered with setWebhook (cloud deploy; unset locally). */
export const telegramHook = new Hono();

const START_PREFIX = "/start ";

interface LinkCode {
  uid?: string;
  exp?: number;
}

/** One-shot link codes: a forwarded/leaked deep link must not let a second chat rebind the same
 *  account within the 15-minute validity window. In-memory is enough: the server runs as a single
 *  instance by design, and a restart forgets nothing that the exp check doesn't still bound. */
const usedCodes = new Map<string, number>();
function consumeCode(raw: string, exp: number): boolean {
  for (const [k, e] of usedCodes) if (e < Date.now()) usedCodes.delete(k);
  if (usedCodes.has(raw)) return false;
  usedCodes.set(raw, exp);
  return true;
}

async function sendMessage(chatId: number | string, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) log.error({ status: res.status, body: await res.text() }, "telegram webhook reply failed");
  } catch (e) {
    log.error({ err: String(e) }, "telegram webhook reply error");
  }
}

telegramHook.post("/telegram/webhook", async (c) => {
  // Webhook disabled until a secret is configured (empty locally; the cloud deploy sets one).
  if (!env.TELEGRAM_WEBHOOK_SECRET) return c.json({ error: "not found" }, 404);
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (!secret || !safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) return c.json({ error: "forbidden" }, 403);

  let update: any = null;
  try {
    update = await c.req.json();
  } catch (e) {
    log.warn({ err: String(e) }, "telegram webhook: unparsable body");
  }

  const message = update?.message;
  const chatId = message?.chat?.id;
  const text: string = typeof message?.text === "string" ? message.text : "";

  if (chatId && text.startsWith(START_PREFIX)) {
    const raw = text.slice(START_PREFIX.length).trim();
    let uid: string | null = null;
    try {
      // decodeURIComponent reverses the encodeURIComponent applied when the link was minted
      // (GET /api/v1/telegram/link); harmless no-op if Telegram already delivered it decoded.
      const decoded = JSON.parse(decrypt(decodeURIComponent(raw))) as LinkCode;
      if (decoded.uid && typeof decoded.exp === "number" && Date.now() <= decoded.exp && consumeCode(raw, decoded.exp)) {
        uid = decoded.uid;
      }
    } catch (e) {
      log.warn({ err: String(e) }, "telegram link code invalid or expired");
    }

    if (uid) {
      await db.update(schema.users).set({ telegramChatId: String(chatId) }).where(eq(schema.users.id, uid));
      await sendMessage(chatId, "✅ Linked. Haii briefs will arrive here.");
    } else {
      await sendMessage(chatId, "This link has expired or is invalid. Open Haii and tap Connect Telegram to get a fresh one.");
    }
  }

  // Telegram retries non-200 responses; always ack so a bad/expired code doesn't loop.
  return c.json({ ok: true });
});
