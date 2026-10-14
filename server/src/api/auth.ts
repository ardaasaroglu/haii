import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { OAuth2Client, type Credentials, type TokenPayload } from "google-auth-library";
import { and, eq } from "drizzle-orm";
import { db, schema, seedEntitiesForUser } from "../db";
import { env } from "../env";
import { log } from "../log";
import { encrypt, decrypt } from "../lib/crypto";
import { ensureConnections, getCreds, mergeMeta, setCreds, setStatus } from "../lib/connections";
import {
  createSession,
  destroySession,
  requireUser,
  resolveUserId,
  sessionCookie,
  SESSION_COOKIE,
  type AppEnv,
} from "../lib/session";
import { opsNotify } from "../lib/telegram";
import { GOOGLE_SCOPES, GOOGLE_REQUIRED_SCOPES } from "../connectors/google";
import { SLACK_USER_SCOPES } from "../connectors/slack";

export const auth = new Hono<AppEnv>();

const CALLBACK_PATH = "/auth/google/callback";
const STATE_TTL_MS = 10 * 60_000; // 10 minutes

interface OAuthState {
  p: "login" | "connect" | "slack";
  exp: number;
  n: string;
  uid?: string;
}

/** Login/connect handshake client: env-sourced client id/secret, shared callback redirect.
 *  Distinct from connectors/google.ts's per-user oauthClient(), which threads stored refresh
 *  tokens for ongoing API calls; this one only ever runs the authorization-code exchange. */
function loginClient(): OAuth2Client | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, `${env.APP_URL}${CALLBACK_PATH}`);
}

function packState(state: OAuthState): string {
  return encrypt(JSON.stringify(state));
}

function unpackState(raw: string | undefined): OAuthState | null {
  if (!raw) return null;
  try {
    const state = JSON.parse(decrypt(raw)) as OAuthState;
    if (
      (state.p !== "login" && state.p !== "connect" && state.p !== "slack") ||
      typeof state.exp !== "number" ||
      Date.now() > state.exp
    ) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

async function exchangeCode(client: OAuth2Client, code: string, context: string): Promise<Credentials | null> {
  try {
    const { tokens } = await client.getToken(code);
    return tokens;
  } catch (e) {
    log.error({ err: String(e), context }, "google code exchange failed");
    return null;
  }
}

async function verifyLogin(client: OAuth2Client, idToken: string): Promise<TokenPayload | null> {
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
    return ticket.getPayload() ?? null;
  } catch (e) {
    log.error({ err: String(e) }, "google id token verification failed");
    return null;
  }
}

/* ---------------- login: GET /auth/google/start -> Google -> GET /auth/google/callback ---------------- */

/** Cookie that binds a login `state` to the browser that started it. Without it the callback
 *  accepts any un-expired state from any browser, so an allowlisted attacker can complete consent
 *  with their own account, capture the code, and hand the victim a callback URL that logs the
 *  victim's browser into the ATTACKER's account (session fixation): the victim then pastes
 *  transcripts and connects Google into the attacker's tenant. The connect flow already defends
 *  this by requiring the same session; login has no session yet, hence this cookie. */
const OAUTH_NONCE_COOKIE = "haii_oauth_n";
const nonceCookie = (value: string, maxAge: number) =>
  `${OAUTH_NONCE_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${env.DATABASE_URL ? "; Secure" : ""}`;

/** Scopes requested at sign-in.
 *
 *  Sign-in asks for the data scopes too, so a new user lands on a working app instead of an empty
 *  one. That suits an instance shared by people who know what it is.
 *
 *  If you open sign-in to strangers, change this to identity only (openid, email, profile) and let
 *  Setup's Connect Google button ask for data access. Gmail and Drive read scopes are restricted.
 *  On an External OAuth client they need Google verification and a yearly security assessment,
 *  and with them in the login flow nobody can create an account until that review is done. */
const LOGIN_SCOPES = [...GOOGLE_SCOPES, "profile"];

auth.get("/auth/google/start", (c) => {
  const client = loginClient();
  if (!client) return c.text("Google client not configured", 500);
  const n = randomBytes(16).toString("hex");
  const state = packState({ p: "login", exp: Date.now() + STATE_TTL_MS, n });
  const url = client.generateAuthUrl({
    scope: LOGIN_SCOPES,
    // offline is what yields a refresh token, which is what "connected" actually means.
    access_type: "offline",
    include_granted_scopes: true,
    // Deliberately NOT prompt:"consent". That would re-show the full consent screen on EVERY
    // sign-in, including for people who connected months ago. Google returns a refresh token on
    // first authorization, which is the only time we need one; Setup's Connect Google button keeps
    // prompt:consent and stays the repair path when a token is lost or scopes change.
    state,
  });
  c.header("Set-Cookie", nonceCookie(n, Math.floor(STATE_TTL_MS / 1000)));
  return c.redirect(url);
});

/* ---------------- connect: an already-logged-in user grants Gmail/Calendar/Drive ---------------- */

auth.get("/auth/google/connect", requireUser, (c) => {
  const client = loginClient();
  if (!client) return c.text("Google client not configured", 500);
  const uid = c.get("userId");
  const state = packState({
    p: "connect",
    uid,
    exp: Date.now() + STATE_TTL_MS,
    n: randomBytes(16).toString("hex"),
  });
  const url = client.generateAuthUrl({
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    state,
  });
  return c.redirect(url);
});

/* ---------------- connect: Slack, one button instead of a pasted token ----------------
 *
 *  Same shape as the Google connect flow above, including the session-bound CSRF check, and for
 *  the same reason: the encrypted state proves WE minted the link, not that the person clicking
 *  Allow owns it. Without the check a forwarded consent link would attach someone else's Slack
 *  account to the initiator's tenant, and Haii would then post to real channels as them.
 *
 *  The point of this beyond convenience: SLACK_USER_SCOPES goes into the authorize URL from code.
 *  Nobody transcribes a scope list any more, so the missing-scope class of failure that broke both
 *  sending and polling cannot recur. */

const SLACK_CALLBACK_PATH = "/auth/slack/callback";
const slackRedirect = () => `${env.APP_URL}${SLACK_CALLBACK_PATH}`;

auth.get("/auth/slack/connect", requireUser, (c) => {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) return c.text("Slack OAuth is not configured", 500);
  const uid = c.get("userId");
  const state = packState({ p: "slack", uid, exp: Date.now() + STATE_TTL_MS, n: randomBytes(16).toString("hex") });
  const url =
    "https://slack.com/oauth/v2/authorize?" +
    new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      // user_scope, NOT scope: Haii acts AS the user (posts from you, reads what you can see),
      // so it needs a user token (xoxp). `scope` would request a bot token (xoxb) instead.
      user_scope: SLACK_USER_SCOPES.join(","),
      redirect_uri: slackRedirect(),
      state,
    }).toString();
  return c.redirect(url);
});

auth.get(SLACK_CALLBACK_PATH, async (c) => {
  // Slack reports user-declined consent as an `error` param rather than an exchange failure.
  const denied = c.req.query("error");
  if (denied) return c.redirect(`/?slack=${encodeURIComponent(denied)}#setup`);
  const code = c.req.query("code");
  if (!code) return c.text("missing code", 400);
  const state = unpackState(c.req.query("state"));
  if (!state || state.p !== "slack" || !state.uid) return c.text("invalid or expired state", 400);
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) return c.text("Slack OAuth is not configured", 500);

  const sessionUid = await resolveUserId(c, { crossSiteOk: true });
  if (sessionUid !== state.uid) {
    return c.text("connect must finish in the session that started it; reopen Connect Slack from Setup", 403);
  }

  let data: any;
  try {
    const res = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.SLACK_CLIENT_ID,
        client_secret: env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: slackRedirect(),
      }),
    });
    data = await res.json();
  } catch (e) {
    log.error({ err: String(e) }, "slack code exchange failed");
    return c.redirect("/?slack=exchange_failed#setup");
  }
  if (!data?.ok) {
    log.error({ err: data?.error }, "slack oauth rejected");
    return c.redirect(`/?slack=${encodeURIComponent(data?.error || "oauth_failed")}#setup`);
  }
  // The USER token lives under authed_user; the top-level access_token is the bot token, which
  // is not what Haii uses and may be absent entirely when only user_scope was requested.
  const userToken: string | undefined = data.authed_user?.access_token;
  if (!userToken) return c.redirect("/?slack=no_user_token#setup");

  await setCreds(state.uid, "slack", { user_token: userToken }, "connected");
  // A fresh install can have different visibility from the last one, so the cached conversation
  // list must not survive it.
  await mergeMeta(state.uid, "slack", { channel_cache: null, channel_cache_at: null });
  void opsNotify(state.uid, "connected Slack");
  log.info({ userId: state.uid, team: data.team?.name }, "slack connected via oauth");
  return c.redirect("/?slack=connected#setup");
});

/* ---------------- callback: shared by both flows, branched on state.p ---------------- */

auth.get(CALLBACK_PATH, async (c) => {
  const code = c.req.query("code");
  if (!code) return c.text("missing code", 400);
  const state = unpackState(c.req.query("state"));
  if (!state) return c.text("invalid or expired state", 400);
  const client = loginClient();
  if (!client) return c.text("Google client not configured", 500);

  if (state.p === "connect") {
    const uid = state.uid;
    if (!uid) return c.text("invalid state", 400);
    // CSRF binding: the browser finishing the connect must carry the same Haii identity that
    // started it. The encrypted state proves the link was minted by us, but not that the person
    // clicking Allow is its owner. Without this check a user could forward their own consent link
    // to someone else, and that person's Google tokens would be stored under the initiator's user.
    // SameSite=Lax keeps the session cookie present on Google's top-level redirect back to this
    // callback.
    const sessionUid = await resolveUserId(c, { crossSiteOk: true });
    if (sessionUid !== uid) {
      return c.text("connect must finish in the session that started it; reopen Connect Google from Setup", 403);
    }
    const tokens = await exchangeCode(client, code, "connect");
    if (!tokens) return c.text("google connect failed", 400);
    const existing = (await getCreds<{ refresh_token?: string }>(uid, "google")) ?? {};
    await setCreds(uid, "google", {
      refresh_token: tokens.refresh_token ?? existing.refresh_token,
      access_token: tokens.access_token,
      expiry_date: tokens.expiry_date,
    });
    await setStatus(uid, "google", "connected");
    void opsNotify(uid, "connected Google");
    return c.redirect("/#setup");
  }

  // LOGIN
  // Bind the state to the browser that started the flow, and make it single-use. A constant-time
  // compare is not needed (both values are ours and equal-length hex), but the cookie MUST match
  // before any token exchange happens.
  const nonce = getCookie(c, OAUTH_NONCE_COOKIE);
  if (!nonce || !state.n || nonce !== state.n) {
    return c.text("login must finish in the browser that started it. Start again from /auth/google/start", 403);
  }
  // append, not replace: the session cookie is set later on this same response and a plain
  // c.header() would overwrite this one, leaving the nonce replayable for its full TTL.
  c.header("Set-Cookie", nonceCookie("", 0), { append: true }); // burn it: one login per start

  const tokens = await exchangeCode(client, code, "login");
  if (!tokens) return c.text("google sign-in failed", 400);
  if (!tokens.id_token) return c.text("google did not return an id token", 400);
  const payload = await verifyLogin(client, tokens.id_token);
  const email = payload?.email?.toLowerCase();
  if (!email) return c.text("google account had no email", 400);

  const allowed = env.ALLOWED_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  let permitted = allowed.includes(email);
  if (!permitted) {
    // The owner always gets in even if ALLOWED_EMAILS is misconfigured: fall back to "already an admin".
    const adminMatch = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.email, email), eq(schema.users.isAdmin, true)));
    permitted = adminMatch.length > 0;
  }
  if (!permitted) return c.html("This instance is invite-only. Ask whoever runs it to add you.", 403);

  const adminEmails = env.ADMIN_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const isAdminEmail = adminEmails.includes(email);

  const existingUsers = await db.select().from(schema.users).where(eq(schema.users.email, email));
  let userId: string;
  let isNewUser = false;
  if (existingUsers[0]) {
    userId = existingUsers[0].id;
    if (isAdminEmail && !existingUsers[0].isAdmin) {
      await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, userId));
    }
  } else {
    userId = `u_${randomBytes(5).toString("hex")}`;
    isNewUser = true;
    const name = payload?.given_name || payload?.name || email.split("@")[0];
    await db.insert(schema.users).values({ id: userId, name, email, role: "", isAdmin: isAdminEmail });
    await ensureConnections(userId);
    await seedEntitiesForUser(userId);
  }
  if (isNewUser) void opsNotify(userId, "signed in for the first time");

  // Sign-in now carries the data grant too, so a new user lands on a working app instead of an
  // empty one. Everything below is written to be safe for someone who is ALREADY connected: Google
  // only returns a refresh token on first authorization, so a returning user's response has none
  // and the stored one must survive.
  const existingCreds = (await getCreds<{ refresh_token?: string }>(userId, "google")) ?? {};
  const refresh = tokens.refresh_token ?? existingCreds.refresh_token;
  if (refresh) {
    // Google's consent screen lets a user untick individual scopes, so a grant can come back
    // partial. Marking that "connected" would leave a connector that authenticates and then fails
    // on every Drive read. Flag it as needs_reauth instead, which is what the Today health banner
    // already watches for, and Setup's Connect Google button repairs it.
    const granted = new Set(String(tokens.scope ?? "").split(/\s+/).filter(Boolean));
    // REQUIRED, not the full requested set: an optional scope the user did not grant must not mark
    // a working connector broken. See GOOGLE_REQUIRED_SCOPES for which and why.
    const missing = GOOGLE_REQUIRED_SCOPES.filter((s) => s.startsWith("https://") && !granted.has(s));
    await setCreds(
      userId,
      "google",
      { refresh_token: refresh, access_token: tokens.access_token, expiry_date: tokens.expiry_date },
      missing.length ? "needs_reauth" : "connected",
    );
    if (missing.length) log.warn({ userId, missing }, "google sign-in granted only some scopes");
  }

  const sid = await createSession(userId);
  c.header("Set-Cookie", sessionCookie(sid), { append: true });
  return c.redirect("/");
});

/* ---------------- logout ---------------- */

auth.post("/auth/logout", async (c) => {
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) await destroySession(sid);
  c.header("Set-Cookie", sessionCookie("", 0));
  return c.json({ ok: true });
});
