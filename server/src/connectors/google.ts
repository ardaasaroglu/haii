import { OAuth2Client } from "google-auth-library";
import { OWNER } from "../db";
import { env } from "../env";
import {
  getCreds,
  mergeCreds,
  setStatus,
  isConnected,
} from "../lib/connections";
import { tgAlertOnce } from "../lib/telegram";
import { log } from "../log";
import { shouldRetry, retryDelayMs, MAX_ATTEMPTS } from "../lib/retry";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  // calendar.events covers reading events AND creating them.
  "https://www.googleapis.com/auth/calendar.events",
  // calendar.readonly is required for the freeBusy query (calendar.events alone does NOT grant it),
  // which powers availability-aware scheduling (lib/schedule.ts). Adding a scope forces every user
  // to reconnect Google once for the new consent to take effect.
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  // gmail.compose, for email drafts. DRAFTS ONLY: Haii uses it to create a message in the user's
  // own mailbox and never to send one, so "nothing sends without a gesture" is untouched. The
  // finished mail lands in their Gmail and a human presses send.
  //
  // No new verification tier: compose is a RESTRICTED scope, and gmail.readonly above is restricted
  // too and already sits in the SIGN-IN flow. An OAuth client of type Internal needs no Google
  // review at all; the tier only starts to matter for an External client.
  //
  // A user who connected before this scope was requested must re-consent once to get drafting.
  // Their connection stays healthy without it (it is left out of GOOGLE_REQUIRED_SCOPES below), and
  // Setup's Connect Google button adds it. Until they do, drafting returns `blocked` and says why.
  "https://www.googleapis.com/auth/gmail.compose",
  // drive.file, for create_document and share_file. NOT a restricted scope, so it adds nothing to
  // the Google security assessment (CASA) that gmail.readonly, gmail.compose and drive.readonly
  // already bring: it grants access ONLY to files this app itself created. Haii can write you a
  // document and manage the documents it wrote, and cannot touch anything else in your Drive.
  //
  // The limit that follows is a product constraint, not an oversight: share_file can only share
  // files HAII created. Sharing a pre-existing file (a proposal template, say) needs the full `drive`
  // scope, which IS restricted and brings an annual security assessment with it. That is a choice to
  // make deliberately, not one to slip in here.
  //
  // Same as gmail.compose: a user who connected before it was requested re-consents once through
  // Setup's Connect Google button, and the connection stays healthy meanwhile. Until then these two
  // card types return `blocked` and say why.
  "https://www.googleapis.com/auth/drive.file",
  "openid",
  "email",
];

/** What a connection must hold to count as healthy: the scopes whose ABSENCE means the connector is
 *  broken. That is not the same list as the one requested. Health is computed against this; the
 *  authorize URL still requests everything above.
 *
 *  gmail.compose and drive.file are BOTH excluded, for the same reason. They are additive scopes
 *  that unlock specific card types. Without them Google reading is completely fine: meetings sync,
 *  transcripts arrive, cards get made. If they were required, the deploy that adds one would flip
 *  every existing user to needs_reauth at once and raise the Today health banner ("Haii is not
 *  seeing new activity from these streams..."), which would be false for every existing user. A
 *  connector whose read path works is not broken, and a health signal that cries wolf is worse than
 *  none.
 *
 *  Excluded, the failure is proportionate instead: the connection stays healthy, and the one card
 *  type that needs the new scope returns `blocked` with a sentence saying to reconnect. The user
 *  meets the cost at the moment it buys them something. */
export const GOOGLE_REQUIRED_SCOPES = GOOGLE_SCOPES.filter(
  (s) =>
    s !== "https://www.googleapis.com/auth/gmail.compose" &&
    s !== "https://www.googleapis.com/auth/drive.file",
);

interface GoogleCreds {
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  access_token?: string;
  expiry_date?: number;
  email?: string;
}

// Only used as the OAuth2Client constructor arg for the per-user refresh path below (gFetch never
// performs an authorization redirect; the live login/connect handshake lives in api/auth.ts and
// owns the real redirect URI). Kept aligned with that route to avoid a misleading stale value.
const REDIRECT = `${env.APP_URL}/auth/google/callback`;

/** client_id and client_secret come from the environment only. Stored values are ignored. */
async function creds(userId: string = OWNER): Promise<GoogleCreds> {
  const stored = (await getCreds<GoogleCreds>(userId, "google")) ?? {};
  return {
    ...stored,
    client_id: env.GOOGLE_CLIENT_ID || undefined,
    client_secret: env.GOOGLE_CLIENT_SECRET || undefined,
  };
}

async function oauthClient(userId: string = OWNER): Promise<OAuth2Client | null> {
  const c = await creds(userId);
  if (!c.client_id || !c.client_secret) return null;
  const client = new OAuth2Client(c.client_id, c.client_secret, REDIRECT);
  if (c.refresh_token || c.access_token) {
    client.setCredentials({
      refresh_token: c.refresh_token,
      access_token: c.access_token,
      expiry_date: c.expiry_date,
    });
  }
  client.on("tokens", async (tokens) => {
    await mergeCreds(userId, "google", {
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      ...(tokens.access_token ? { access_token: tokens.access_token } : {}),
      ...(tokens.expiry_date ? { expiry_date: tokens.expiry_date } : {}),
    });
  });
  return client;
}

// There is deliberately no authorization handshake in this file. The live per-user handshake is
// /auth/google/start + /auth/google/connect in api/auth.ts. A helper here would have to be told
// whose tokens it is saving, and one that defaulted to OWNER would hand tokens to the wrong user.

/** Authenticated fetch against Google REST APIs with auto token refresh. Every caller passes the
 *  user whose Google account this is. */
export async function gFetch(userId: string = OWNER, url: string, init: RequestInit = {}): Promise<Response> {
  const client = await oauthClient(userId);
  if (!client) throw new Error("google not configured");
  let token: string | null | undefined;
  try {
    token = (await client.getAccessToken()).token;
  } catch (e: any) {
    if (String(e?.message ?? e).includes("invalid_grant")) {
      await setStatus(userId, "google", "needs_reauth");
      await tgAlertOnce(
        `google_reauth:${userId}`,
        `Google connection needs re-auth. Open ${env.APP_URL} → Setup → Connect Google.`,
        24 * 3600_000,
      );
    }
    throw e;
  }
  // RETRY. Without it a single transient 429 or 503 from Google ends the job: a dead-lettered
  // failure row and a red line on the user's home screen for a hiccup that was over in a second.
  //
  // lib/retry owns the policy, including the part that matters most: a 5xx is only retried for
  // idempotent methods, because the server may have completed a write and failed to say so, and
  // retrying a POST there is how you get two identical calendar events. 429 is safe for any method
  // because nothing was processed.
  let res!: Response;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
    });
    if (attempt === MAX_ATTEMPTS || !shouldRetry(res.status, String(init.method ?? "GET"))) break;
    const wait = retryDelayMs(attempt, res.headers.get("retry-after"));
    log.warn({ url: url.slice(0, 80), status: res.status, attempt, wait }, "google call retrying");
    await new Promise((r) => setTimeout(r, wait));
  }
  if (res.status === 401) {
    await setStatus(userId, "google", "needs_reauth");
    await tgAlertOnce(
      `google_reauth:${userId}`,
      `Google connection needs re-auth. Open ${env.APP_URL} → Setup → Connect Google.`,
      24 * 3600_000,
    );
  }
  return res;
}

export async function googleReady(userId: string = OWNER): Promise<boolean> {
  return (await isConnected(userId, "google")) && Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}
