import { config } from "dotenv";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, "..");
const envPath = join(serverRoot, ".env");
config({ path: envPath });

// DATABASE_URL decides two things: which database db/index.ts opens (managed Postgres when it is
// set, the embedded PGlite database when it is not) and which ENCRYPTION_KEY rule applies below.
// So it is read once, before the key check.
const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

if (hasDatabaseUrl) {
  // Cloud deploy: there is no durable local disk to self-heal onto (a fresh container every
  // deploy would silently mint a new key and orphan every encrypted connector token). Require a
  // real key up front instead and fail fast if it's missing or malformed.
  if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 64) {
    throw new Error(
      `ENCRYPTION_KEY must be set in the environment for cloud deploys; generate once with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" and keep it stable or stored connector tokens become unreadable`,
    );
  }
} else {
  // Self-heal: an encryption key is mandatory for token storage. Generate one on
  // first boot and persist it so encrypted credentials survive restarts.
  if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 64) {
    const key = randomBytes(32).toString("hex");
    if (existsSync(envPath)) {
      const cur = readFileSync(envPath, "utf8");
      if (/^ENCRYPTION_KEY=.*$/m.test(cur)) {
        writeFileSync(envPath, cur.replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${key}`));
      } else {
        appendFileSync(envPath, `\nENCRYPTION_KEY=${key}\n`);
      }
    } else {
      writeFileSync(envPath, `ENCRYPTION_KEY=${key}\n`);
    }
    process.env.ENCRYPTION_KEY = key;
  }
}

// There is deliberately no dry-run or test mode here. An approved card either does the thing or
// fails loudly. The safety contract is the gesture (the nod, with a short undo), not a simulation
// switch. Deployment-wide switches that silently turned every "executed" card into a no-op made the
// product report work it never did. If a preview is ever wanted, make it a property of the ACTION,
// not of the deployment.
export const env = {
  // The port the server listens on.
  PORT: Number(process.env.PORT || 4820),
  // The address the server binds to. Locally that is 127.0.0.1, so only this machine can reach it.
  // With DATABASE_URL set the default is "::", which listens on IPv6 and IPv4. Many container
  // platforms send traffic and healthchecks over IPv6, so an IPv4-only 0.0.0.0 bind boots but never
  // passes a healthcheck, and a 127.0.0.1 bind cannot be reached at all. An explicit HOST wins.
  HOST: process.env.HOST || (hasDatabaseUrl ? "::" : "127.0.0.1"),
  // The address people open Haii at. Used to build OAuth redirect URLs and the links in Telegram
  // messages, and an https address turns on secure cookies and HSTS. Local mode also accepts
  // requests that arrive under this host name (lib/localRequest.ts).
  APP_URL: process.env.APP_URL || `http://localhost:${process.env.PORT || 4820}`,
  // Empty: the embedded PGlite database in DATA_DIR. Set: managed Postgres through `pg`, and the
  // automatic local login is switched off (see DEV_AUTOLOGIN below).
  DATABASE_URL: process.env.DATABASE_URL || "",
  // 64 hex characters. Encrypts the connector credentials stored in the database. Generated and
  // saved on first boot locally (above); you must set it yourself when DATABASE_URL is set.
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY!,
  // Folder for the embedded database and its lock file, relative to server/.
  DATA_DIR: join(serverRoot, process.env.DATA_DIR || ".data"),
  // How much the server logs: trace, debug, info, warn, error or fatal.
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  // Spend caps in US dollars, checked before each model call (lib/llm.ts).
  // Daily caps for the whole instance. Past the soft cap, everyone's briefs and extraction run on the
  // cheaper model for the rest of the day. At the hard cap, model jobs pause for the rest of the day.
  BUDGET_SOFT_USD: Number(process.env.BUDGET_SOFT_USD || 3),
  BUDGET_HARD_USD: Number(process.env.BUDGET_HARD_USD || 8),
  // The same two caps for one user's own spend in a day. Keep them below the instance caps, or the
  // instance cap binds first and pauses everybody.
  USER_DAILY_SOFT_USD: Number(process.env.USER_DAILY_SOFT_USD || 0.75),
  USER_DAILY_HARD_USD: Number(process.env.USER_DAILY_HARD_USD || 1.5),
  // Total spend for the whole instance in a calendar month. At the cap, model jobs pause until the
  // next month.
  MONTHLY_CAP_USD: Number(process.env.MONTHLY_CAP_USD || 60),
  // Your Anthropic API key. Every model call is billed to it. Empty means Haii cannot read meetings.
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
  // Reasoning effort for extraction and the memory jobs, applied in lib/llm.ts. Briefs always run at
  // low effort and ignore this. Anything other than exactly "low" becomes "medium", so a stray value can never buy a
  // higher effort and a bigger bill. Never sent to the Haiku models (NO_TUNING_MODELS in lib/llm.ts).
  LLM_EFFORT: (process.env.LLM_EFFORT === "low" ? "low" : "medium") as "low" | "medium",
  // Meant to send the background extraction sweep through the Message Batches API. That path is
  // disabled (BATCH_EXTRACT_PATH_WORKS in jobs/extract.ts), so today this setting changes nothing.
  // A pasted transcript is always extracted right away either way.
  BATCH_EXTRACT: process.env.BATCH_EXTRACT === "1",
  // Telegram bot token. Without it Haii sends nothing to Telegram.
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  // The chat that receives operator alerts: boot, crash, job failures, budget caps.
  TELEGRAM_ADMIN_CHAT_ID: process.env.TELEGRAM_ADMIN_CHAT_ID || "",
  // Per-user Telegram linking. The webhook answers 404 until a secret is set, and the link a user
  // taps needs the bot's @username. Both stay empty for a local install.
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET || "",
  TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME || "",
  // Your Google OAuth client, created in Google Cloud. Needed for Google sign-in and for every Google
  // connector. Read from here only; values stored in the database are ignored.
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || "",
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || "",
  // Who may sign in with Google, and who is made an admin when they do. Comma-separated,
  // case-insensitive email lists. An existing admin can always sign in.
  ALLOWED_EMAILS: process.env.ALLOWED_EMAILS || "",
  ADMIN_EMAILS: process.env.ADMIN_EMAILS || "",
  // A fixed secret for admin-only routes, sent in the x-admin-token header, for scripts that have
  // no login session (for example a coding agent calling the /api/v1/ingest bridge). A caller with
  // the token acts as the local owner.
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || "",
  // The automatic local login: a request with no session is treated as this user id, but only when
  // it comes from this app's own page (lib/localRequest.ts). Forced to "" whenever DATABASE_URL is
  // set, whatever the variable says: a shared instance must never invent an identity, and Google
  // sign-in is required there. Uses ?? (not ||) in the local branch so an explicit empty value
  // (DEV_AUTOLOGIN=) turns it off rather than falling back to "owner".
  DEV_AUTOLOGIN: hasDatabaseUrl ? "" : (process.env.DEV_AUTOLOGIN ?? "owner"),
  // Not needed: connect Jira in Setup. If set, these are fallback credentials for the local owner
  // only, never for other users (connectors/jira.ts says why).
  JIRA_EMAIL: process.env.JIRA_EMAIL || "",
  JIRA_API_TOKEN: process.env.JIRA_API_TOKEN || "",
  JIRA_SITE: process.env.JIRA_SITE || "",
  // The project key a new Jira issue goes to when the card does not name one, for example ENG.
  // Unlike the credentials above, it is one key for the whole instance, applied to every user's
  // Jira, so on a shared instance the key must exist on each user's own Jira site.
  JIRA_PROJECT: (process.env.JIRA_PROJECT || "").trim().toUpperCase(),
  // Not needed: connect Slack in Setup. If set, a fallback user token for the local owner only.
  SLACK_USER_TOKEN: process.env.SLACK_USER_TOKEN || "",
  // Your Slack app, for the Connect Slack button. With these set, the scopes are declared in code
  // in the authorize URL (SLACK_USER_SCOPES in connectors/slack.ts) instead of typed by a person
  // into the Slack app config, which is how a missing mpim:read once silently broke both sending
  // and polling. Without them, Setup falls back to pasting a token.
  SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID || "",
  SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET || "",
};

// Exposure guard: DEV_AUTOLOGIN hands every unauthenticated request an admin identity, which is
// only acceptable on a bind nobody else can reach. A local-mode process on a public bind (the
// state a cloud deploy lands in when DATABASE_URL goes missing while HOST is overridden) must
// refuse to boot rather than serve an open admin API with a passing healthcheck. Phone testing
// on a trusted home network stays possible by explicitly opting in with ALLOW_LAN_DEV=1.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
if (env.DEV_AUTOLOGIN && !LOOPBACK_HOSTS.has(env.HOST) && process.env.ALLOW_LAN_DEV !== "1") {
  throw new Error(
    `refusing to boot: DEV_AUTOLOGIN is active but HOST=${env.HOST} is not loopback, which would expose an unauthenticated admin API. If this is deliberate LAN testing on a trusted network, set ALLOW_LAN_DEV=1. If this is a cloud deploy, DATABASE_URL is missing.`,
  );
}

// The same guard for APP_URL. A tunnel or reverse proxy in front of a loopback bind passes the HOST
// check above, and local mode then trusts requests that arrive under the name in APP_URL
// (lib/localRequest.ts), so every visitor through the tunnel would act as the owner. A name that is
// not this machine needs the same explicit opt-in as a LAN bind.
const appUrlHost = (() => {
  try {
    return new URL(env.APP_URL).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
})();
const appUrlIsLocal = LOOPBACK_HOSTS.has(appUrlHost) || appUrlHost.endsWith(".localhost");
if (env.DEV_AUTOLOGIN && !appUrlIsLocal && process.env.ALLOW_LAN_DEV !== "1") {
  throw new Error(
    `refusing to boot: DEV_AUTOLOGIN is active and APP_URL names "${appUrlHost}", which is not this machine. Local mode has no login, so a tunnel or proxy under that name would let every visitor act as you. If this is deliberate testing on a trusted home network, set ALLOW_LAN_DEV=1. Never put a public name in APP_URL in local mode.`,
  );
}
