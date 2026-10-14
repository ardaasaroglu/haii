import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import { db, schema, OWNER } from "../db";
import { env } from "../env";
import { safeEqual } from "./crypto";
import { fromThisApp } from "./localRequest";

/** Cookie session. sid is opaque, stored in the `sessions` table. */
export const SESSION_COOKIE = "haii_sid";
const SESSION_TTL_MS = 30 * 24 * 3600_000; // 30 days
const TOUCH_INTERVAL_MS = 3600_000; // touch sessions.last_seen_at at most once/hour per sid

/** Shared Hono env: every /api/v1 and /auth handler reads the caller's id via c.get("userId"). */
export type AppEnv = { Variables: { userId: string } };

export async function createSession(userId: string): Promise<string> {
  const sid = randomBytes(32).toString("hex");
  await db.insert(schema.sessions).values({
    sid,
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return sid;
}

/** The session row if it exists and hasn't expired; expired rows are deleted lazily. */
export async function getSession(sid: string) {
  const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.sid, sid));
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(schema.sessions).where(eq(schema.sessions.sid, sid));
    return null;
  }
  return row;
}

export async function destroySession(sid: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.sid, sid));
}

/** Set-Cookie value for the session cookie. Pass maxAgeSeconds=0 to clear it (logout). */
export function sessionCookie(sid: string, maxAgeSeconds = SESSION_TTL_MS / 1000): string {
  const secure = env.APP_URL.startsWith("https") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

// Per-sid throttle: an active session shouldn't write sessions.last_seen_at on every request.
const lastTouch = new Map<string, number>();
async function touchSession(sid: string): Promise<void> {
  const now = Date.now();
  if (now - (lastTouch.get(sid) ?? 0) < TOUCH_INTERVAL_MS) return;
  lastTouch.set(sid, now);
  await db.update(schema.sessions).set({ lastSeenAt: new Date(now) }).where(eq(schema.sessions.sid, sid));
}

// DEV_AUTOLOGIN's user row is ensured once per process, not on every unauthenticated request.
const ensuredDevUsers = new Set<string>();
async function ensureDevUser(userId: string): Promise<void> {
  if (ensuredDevUsers.has(userId)) return;
  await db.insert(schema.users).values({ id: userId, name: userId }).onConflictDoNothing();
  ensuredDevUsers.add(userId);
}

/** Cookie session first, DEV_AUTOLOGIN fallback second. Pure resolution, no response side
 *  effects: callers (requireUser/requireAdmin) decide what a null result means for them.
 *  Exported so the OAuth connect callback can bind the completing browser to the initiating id. */
export async function resolveUserId(c: Context, opts: { crossSiteOk?: boolean } = {}): Promise<string | null> {
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) {
    const session = await getSession(sid);
    if (session) {
      await touchSession(sid);
      return session.userId;
    }
  }
  if (env.DEV_AUTOLOGIN) {
    // No login in local mode, so this is the only gate: see lib/localRequest.ts. The two OAuth
    // callbacks pass crossSiteOk, because coming back from Google or Slack IS a cross-site
    // navigation, and they carry their own signed state.
    const mine =
      opts.crossSiteOk ||
      fromThisApp(
        { host: c.req.header("host"), origin: c.req.header("origin"), site: c.req.header("sec-fetch-site") },
        env.APP_URL,
      );
    if (!mine) return null;
    await ensureDevUser(env.DEV_AUTOLOGIN);
    return env.DEV_AUTOLOGIN;
  }
  return null;
}

/** Gate for /api/v1/*: valid session cookie, else DEV_AUTOLOGIN (local dev only), else refuse.
 *
 *  Local mode refuses with a 403 and a sentence, not a 401. The client turns a 401 into a redirect
 *  to the sign-in page (login.html), and local mode has no sign-in, so that redirect is a dead end.
 *  The feed screen shows a 403's error text instead. In local mode a refusal here means the
 *  request did not pass the local gate (lib/localRequest.ts), for example because the app was
 *  opened under a name other than APP_URL. */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const uid = await resolveUserId(c);
  if (!uid) {
    if (env.DEV_AUTOLOGIN) {
      return c.json({ error: `Local mode has no sign-in, so Haii only answers at ${env.APP_URL}. Open that address.` }, 403);
    }
    return c.json({ error: "login required" }, 401);
  }
  c.set("userId", uid);
  await next();
});

/** Gate for admin-only routes: a static ADMIN_TOKEN header, or a logged-in user with is_admin.
 *  A token caller runs as OWNER, this instance's standing admin identity. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const token = c.req.header("x-admin-token");
  if (token && env.ADMIN_TOKEN && safeEqual(token, env.ADMIN_TOKEN)) {
    if (!c.get("userId")) c.set("userId", OWNER);
    await next();
    return;
  }
  const uid = await resolveUserId(c);
  if (uid) {
    const rows = await db.select().from(schema.users).where(eq(schema.users.id, uid));
    if (rows[0]?.isAdmin) {
      c.set("userId", uid);
      await next();
      return;
    }
  }
  return c.json({ error: "forbidden" }, 403);
});
