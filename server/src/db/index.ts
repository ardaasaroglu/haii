import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import { join } from "node:path";
import { mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from "node:fs";
import { env } from "../env";
import { log } from "../log";
import * as schema from "./schema";
import { lockVerdict, serializeLock } from "../lib/lock";

/** The local owner's user id: the default user_id on rows and the identity used in local mode. */
export const OWNER = "owner";

/** Dual driver: DATABASE_URL present -> managed Postgres via `pg`; otherwise the
 *  embedded PGlite database. Both branches build a drizzle instance over the same `schema`
 *  plus a minimal raw-SQL handle used by the DDL bootstrap / migrations / seed helpers below. */
const usingPostgres = Boolean(env.DATABASE_URL);

/** Common shape the DDL bootstrap and seed helpers need from either driver: `exec` for
 *  multi-statement strings with no parameters (DDL, migrations), `query` for parameterized
 *  statements (seeds). PGlite's client natively has both. `pg.Pool` only has `.query`, but pg's
 *  simple query protocol runs a multi-statement string through `.query` too as long as it's
 *  called with no parameters, so `.exec` for the Postgres branch is just `.query` by another
 *  name. Both branches are wrapped in explicit functions (rather than assigning the raw client)
 *  so this interface is satisfied by construction, not by structural luck. */
interface SqlClient {
  exec(sql: string): Promise<unknown>;
  query(text: string, params?: unknown[]): Promise<unknown>;
}

let sqlClient: SqlClient;
let dbInstance: PgliteDatabase<typeof schema> | ReturnType<typeof drizzleNodePg<typeof schema>>;

if (usingPostgres) {
  // Managed Postgres serializes concurrent writers itself, so the PGlite single-writer
  // lockfile guard below (which exists only to protect embedded PGlite's WAL from corrupting
  // under concurrent opens) is skipped entirely on this path.
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 8 });
  dbInstance = drizzleNodePg(pool, { schema });
  sqlClient = {
    exec: (sql) => pool.query(sql),
    query: (text, params) => pool.query(text, params as unknown[] | undefined),
  };
} else {
  mkdirSync(env.DATA_DIR, { recursive: true });

  /** PGlite is strictly single-writer: a second process opening the same data dir corrupts the WAL
   *  (observed with force-killed concurrent instances). Refuse to open the DB twice. */
  const lockPath = join(env.DATA_DIR, ".lock");
  function acquireLock(attempt = 0): void {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, serializeLock(process.pid, new Date()));
      closeSync(fd);
    } catch {
      // The verdict is a pure function (lib/lock.ts) because getting it wrong is invisible: the
      // old check was `process.kill(pid, 0)` on a bare pid, which answers "is SOME process alive
      // with this number". A hard kill leaves the lockfile behind, Windows recycles pids, and the
      // next start then exits(1) while the tsx watch supervisor stays up: healthy-looking process
      // tree, no port, nothing logged.
      let raw = "";
      try {
        raw = readFileSync(lockPath, "utf8");
      } catch {
        /* unreadable: the verdict treats that as takeable */
      }
      const verdict = lockVerdict(raw, (pid) => {
        try {
          process.kill(pid, 0); // throws if the pid is gone
          return true;
        } catch {
          return false;
        }
      });
      if (verdict.action === "refuse") {
        // Through the logger as well as the console: a console line alone is invisible in the
        // tooling people actually watch.
        log.error(
          { holder: verdict.pid, lockPath, reason: verdict.reason },
          "another instance holds the database; exiting to protect it. If that pid is not a Haii dev server, delete the lock file.",
        );
        // eslint-disable-next-line no-console
        console.error(`[haii] ${verdict.reason}. Not starting. If that is not a Haii dev server, delete ${lockPath}`);
        process.exit(1);
      }
      log.warn({ lockPath, reason: verdict.reason }, "taking over a stale database lock");
      if (attempt >= 2) {
        // eslint-disable-next-line no-console
        console.error(`[haii] could not acquire the database lock at ${lockPath}`);
        process.exit(1);
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* raced */
      }
      return acquireLock(attempt + 1);
    }
    const release = () => {
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    };
    process.on("exit", release);
    process.on("SIGINT", () => {
      release();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      release();
      process.exit(0);
    });
  }
  acquireLock();

  const pglite = new PGlite(join(env.DATA_DIR, "pg"));
  dbInstance = drizzlePglite(pglite, { schema });
  sqlClient = {
    exec: (sql) => pglite.exec(sql),
    query: (text, params) => pglite.query(text, params),
  };
}

/** Single unify-cast: `drizzleNodePg(...)` and `drizzlePglite(...)` return TS types that differ
 *  in their query-result generic (NodePgQueryResultHKT vs PgliteQueryResultHKT) even though both
 *  are plain Postgres drivers built from the same `schema` and expose the identical query-builder
 *  surface this codebase actually calls (select/insert/update/delete, all taking the table object
 *  as an argument). Rather than threading a driver union type through every file that imports
 *  `db`, erase it once here (union-erasing cast via `unknown`) and re-assert as the pglite-flavored
 *  type, parameterized with the real `schema` so downstream types stay accurate. Every other file
 *  in the codebase compiles against this one shape, untouched. */
export const db = dbInstance as unknown as PgliteDatabase<typeof schema>;
export { schema };

/** Idempotent DDL bootstrap. Some columns are added only by MIGRATIONS below, so it is the DDL and
 *  MIGRATIONS together that must match schema.ts. Runs on both drivers: this is plain Postgres SQL,
 *  and PGlite (embedded Postgres) and managed Postgres speak the same dialect. */
const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text,
  role text NOT NULL DEFAULT '',
  tz text NOT NULL DEFAULT 'local',
  telegram_chat_id text,
  is_admin boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz,
  tz_pinned boolean NOT NULL DEFAULT false,
  onboarding_state text NOT NULL DEFAULT 'new',
  owns text NOT NULL DEFAULT '',
  catches jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS connections (
  user_id text NOT NULL DEFAULT 'owner',
  id text NOT NULL,
  status text NOT NULL DEFAULT 'disconnected',
  auth_json text,
  cursor jsonb NOT NULL DEFAULT '{}',
  meta jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS items (
  id serial PRIMARY KEY,
  user_id text NOT NULL DEFAULT 'owner',
  connector text NOT NULL,
  external_id text NOT NULL,
  kind text NOT NULL,
  author text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  body_text text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT '',
  ts timestamptz NOT NULL,
  entities jsonb NOT NULL DEFAULT '[]',
  relevance real NOT NULL DEFAULT 0.5,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS items_user_connector_external ON items (user_id, connector, external_id);
CREATE INDEX IF NOT EXISTS items_user_ts ON items (user_id, ts DESC);
CREATE TABLE IF NOT EXISTS meetings (
  id text PRIMARY KEY,
  user_id text NOT NULL DEFAULT 'owner',
  source text NOT NULL DEFAULT 'gcal',
  external_id text,
  title text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  attendees jsonb NOT NULL DEFAULT '[]',
  location text NOT NULL DEFAULT '',
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS meetings_user_external ON meetings (user_id, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS transcripts (
  id text PRIMARY KEY,
  user_id text NOT NULL DEFAULT 'owner',
  drive_file_id text,
  meeting_id text,
  title text NOT NULL,
  content_md text NOT NULL,
  source text NOT NULL DEFAULT 'paste',
  ingested_at timestamptz NOT NULL DEFAULT now(),
  extracted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS transcripts_user_drive_file ON transcripts (user_id, drive_file_id) WHERE drive_file_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS briefings (
  id text PRIMARY KEY,
  user_id text NOT NULL DEFAULT 'owner',
  meeting_id text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  content_json jsonb NOT NULL,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  cost_usd real NOT NULL DEFAULT 0,
  rating text,
  read_seconds integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS briefings_user_meeting ON briefings (user_id, meeting_id);
CREATE TABLE IF NOT EXISTS cards (
  id text PRIMARY KEY,
  user_id text NOT NULL DEFAULT 'owner',
  schema_version integer NOT NULL DEFAULT 1,
  type text NOT NULL DEFAULT 'action',
  action_type text NOT NULL,
  status text NOT NULL DEFAULT 'proposed',
  title text NOT NULL,
  summary text NOT NULL,
  confidence real NOT NULL,
  priority text NOT NULL DEFAULT 'normal',
  source_json jsonb NOT NULL,
  payload jsonb NOT NULL,
  context jsonb NOT NULL,
  feedback jsonb,
  expires_at timestamptz NOT NULL,
  simulated boolean NOT NULL DEFAULT false,
  transcript_id text,
  meeting_id text,
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  executed_at timestamptz
);
CREATE INDEX IF NOT EXISTS cards_user_status ON cards (user_id, status);
CREATE TABLE IF NOT EXISTS todos (
  id text PRIMARY KEY,
  user_id text NOT NULL DEFAULT 'owner',
  title text NOT NULL,
  due text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  card_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entities (
  id serial PRIMARY KEY,
  user_id text NOT NULL DEFAULT 'owner',
  name text NOT NULL,
  type text NOT NULL DEFAULT 'person',
  aliases jsonb NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS entities_user_name ON entities (user_id, name);
CREATE TABLE IF NOT EXISTS job_runs (
  id serial PRIMARY KEY,
  user_id text NOT NULL DEFAULT '',
  job text NOT NULL,
  status text NOT NULL,
  detail text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  duration_ms integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS job_runs_started ON job_runs (started_at DESC);
CREATE TABLE IF NOT EXISTS llm_ledger (
  id serial PRIMARY KEY,
  user_id text NOT NULL DEFAULT '',
  day text NOT NULL,
  job text NOT NULL,
  model text NOT NULL,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  cost_usd real NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_ledger_day ON llm_ledger (day);
CREATE INDEX IF NOT EXISTS llm_ledger_user_day ON llm_ledger (user_id, day);
CREATE TABLE IF NOT EXISTS digests (
  id text PRIMARY KEY,
  user_id text NOT NULL DEFAULT 'owner',
  day text NOT NULL,
  content_json jsonb NOT NULL,
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  cost_usd real NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS digests_user_day ON digests (user_id, day);
CREATE TABLE IF NOT EXISTS sessions (
  sid text PRIMARY KEY,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE TABLE IF NOT EXISTS executions (
  id serial PRIMARY KEY,
  card_id text NOT NULL,
  user_id text NOT NULL DEFAULT 'owner',
  execute_after timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS executions_card ON executions (card_id);
CREATE INDEX IF NOT EXISTS executions_due ON executions (status, execute_after);
CREATE TABLE IF NOT EXISTS llm_batches (id serial PRIMARY KEY, provider_batch_id text, status text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS memories (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_user ON memories (user_id, updated_at DESC);
-- Dead-letter: anything that failed with nobody watching. Haii's core loop is cron-driven, so a
-- failed extraction/briefing/execution used to be invisible: the user simply got no card and never
-- learned a meeting was skipped. Every row is a thing the USER should know about, surfaced in-app,
-- and alerted to the operator on Telegram, when a bot is configured, with the user's identity.
CREATE TABLE IF NOT EXISTS failures (
  id serial PRIMARY KEY,
  user_id text NOT NULL DEFAULT '',
  kind text NOT NULL,             -- job | execution | rate_limit
  ref text NOT NULL DEFAULT '',   -- job name, card id, or model
  title text NOT NULL DEFAULT '', -- human label: the card/meeting this was about
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  seen_at timestamptz
);
CREATE INDEX IF NOT EXISTS failures_user_unseen ON failures (user_id, seen_at, created_at DESC);
`;

/** Migrations for databases created by an older version. Run on every boot, one statement at a
 *  time. "already exists" and "does not exist" errors are expected. */
const MIGRATIONS = [
  // Prompt-cache accounting. Cache reads are billed at ~0.1x input and writes at ~1.25x, so
  // without these the ledger would price a cached call as if it were fully uncached: spend
  // overstated ~10x on the cached portion, budget caps tripping early, and the cost per brief
  // simply wrong. Added BEFORE caching can activate, on purpose.
  `ALTER TABLE llm_ledger ADD COLUMN IF NOT EXISTS cache_write_tokens integer NOT NULL DEFAULT 0`,
  `ALTER TABLE llm_ledger ADD COLUMN IF NOT EXISTS cache_read_tokens integer NOT NULL DEFAULT 0`,
  `ALTER TABLE llm_batches ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'extract'`,
  `ALTER TABLE llm_batches ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT ''`,
  // Ordered meeting ids for brief batches. Nullable: rows written before this, and every extract
  // batch, have none, and lib/batch.ts reads a missing value as "custom_id is the meeting id".
  `ALTER TABLE llm_batches ADD COLUMN IF NOT EXISTS custom_ids jsonb`,
  // The context manifest: what actually went into the prompt that produced this brief. Cards carry
  // theirs inside the existing `context` jsonb, so only briefings needed a column. Nullable rather
  // than defaulted, because NULL means "written before manifests existed" and an empty array would
  // claim, falsely, that the brief was built from nothing.
  `ALTER TABLE briefings ADD COLUMN IF NOT EXISTS manifest jsonb`,
  `ALTER TABLE todos ADD COLUMN IF NOT EXISTS sort_order integer`,
  // Deferral ("Later" on a left swipe). Nullable and zero-default so every existing card reads as
  // never deferred, which is exactly what they are.
  `ALTER TABLE cards ADD COLUMN IF NOT EXISTS snoozed_until timestamptz`,
  `ALTER TABLE cards ADD COLUMN IF NOT EXISTS snoozed_at timestamptz`,
  `ALTER TABLE cards ADD COLUMN IF NOT EXISTS snooze_count integer NOT NULL DEFAULT 0`,
  // The waker looks up snoozed cards by (user, status) and the feed reads it on every load.
  `CREATE INDEX IF NOT EXISTS cards_user_snoozed ON cards (user_id, snoozed_until) WHERE status = 'snoozed'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email text`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id text`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz`,
  // Empty, not null: "" means the device has not reported a locale yet and formatting falls back
  // to en-GB, which is exactly what every surface did before this column existed.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS tz_pinned boolean NOT NULL DEFAULT false`,
  // A second transcript source (a notetaker beside Gemini) means the same meeting can arrive twice.
  // This names the transcript that already covers it, so the duplicate is kept but never mints a
  // second set of cards for one conversation.
  `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS superseded_by text`,
  // Onboarding is resumable. A user who closes the tab mid-backfill comes back to where they were,
  // not to the start and not past it.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_state text NOT NULL DEFAULT 'new'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS owns text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS catches jsonb`,
  `ALTER TABLE connections ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT 'owner'`,
  `ALTER TABLE items ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT 'owner'`,
  `DROP INDEX IF EXISTS items_connector_external`,
  `DROP INDEX IF EXISTS items_ts`,
  `ALTER TABLE meetings ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT 'owner'`,
  `DROP INDEX IF EXISTS meetings_external`,
  `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT 'owner'`,
  `DROP INDEX IF EXISTS transcripts_drive_file`,
  `ALTER TABLE briefings ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT 'owner'`,
  `ALTER TABLE cards ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT 'owner'`,
  // Undo has erased itself since the beginning: the endpoint nulls `feedback` so the card can be
  // re-decided, which also deletes the fact that it was ever decided. Its own column so the count
  // survives the reset. See the note on cards.undoCount in schema.ts.
  `ALTER TABLE cards ADD COLUMN IF NOT EXISTS undo_count integer NOT NULL DEFAULT 0`,
  // A deferral is a wall-clock intention ("next morning"), not an instant. Storing only the instant
  // meant a card deferred in one time zone and woken in another returned at 22:00 the evening
  // before. The day key is the intention; the zone is resolved at wake time. Null means the floor
  // rule decided, and that one genuinely IS an absolute instant. See lib/snooze.ts.
  `ALTER TABLE cards ADD COLUMN IF NOT EXISTS snoozed_wake_day text`,
  `DROP INDEX IF EXISTS cards_status`,
  // Which chip the user tapped on a brief they rated down. Same grammar as a card's dismiss reason.
  `ALTER TABLE briefings ADD COLUMN IF NOT EXISTS feedback_reason text`,
  // Free text about a brief. A chip cannot say "it was fine but it missed the agenda attached to
  // the invite", and that sentence is the most useful feedback there is.
  `ALTER TABLE briefings ADD COLUMN IF NOT EXISTS feedback_note text`,
  // The invite body and its attachments. Ignoring them meant a brief could miss the one document
  // the organiser actually wrote for the meeting.
  `ALTER TABLE meetings ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT ''`,
  `ALTER TABLE meetings ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE todos ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT 'owner'`,
  // A capture is a commitment parked inside Haii, where it cannot count as executed by
  // construction. Promotion is how it leaves: the column records the card it became, and its
  // presence is what stops a second promotion.
  `ALTER TABLE todos ADD COLUMN IF NOT EXISTS promoted_card_id text`,
  // Self-wake: "I'll get back to you Thursday" is a promise with a date, and until now nothing
  // came back on Thursday. Nudge once per due date, not once per job tick.
  `ALTER TABLE todos ADD COLUMN IF NOT EXISTS notified_at timestamptz`,
  `ALTER TABLE entities ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT 'owner'`,
  `DROP INDEX IF EXISTS entities_name`,
  `ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT ''`,
  `ALTER TABLE llm_ledger ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT ''`,
  `ALTER TABLE digests ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT 'owner'`,
  `DROP INDEX IF EXISTS digests_day`,
];

/** Org-level seed copied to every new user at signup: the names your team says out loud that a
 *  model would not otherwise recognise (your company, your products, your acronyms). Empty by
 *  default. People are learned per user from their own meeting attendees; no people are seeded.
 *
 *  Example: { name: "Northwind", type: "org", aliases: ["NW"] } */
export const ORG_SEED: Array<{ name: string; type: string; aliases: string[] }> = [];

export async function seedEntitiesForUser(userId: string) {
  for (const e of ORG_SEED) {
    await sqlClient.query(
      `INSERT INTO entities (user_id, name, type, aliases) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, name) DO NOTHING`,
      [userId, e.name, e.type, JSON.stringify(e.aliases)],
    );
  }
}

export async function initDb() {
  await sqlClient.exec(DDL);
  for (const stmt of MIGRATIONS) {
    try {
      await sqlClient.exec(stmt);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!/already exists|does not exist|multiple primary keys/i.test(msg)) {
        log.warn({ stmt: stmt.slice(0, 60), err: msg }, "migration statement failed");
      }
    }
  }
  // Post-migration index shapes (created after the columns exist on databases from an older version).
  await sqlClient.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS items_user_connector_external ON items (user_id, connector, external_id);
    CREATE INDEX IF NOT EXISTS items_user_ts ON items (user_id, ts DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS meetings_user_external ON meetings (user_id, external_id) WHERE external_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS transcripts_user_drive_file ON transcripts (user_id, drive_file_id) WHERE drive_file_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS cards_user_status ON cards (user_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS entities_user_name ON entities (user_id, name);
    CREATE UNIQUE INDEX IF NOT EXISTS digests_user_day ON digests (user_id, day);
    CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email) WHERE email IS NOT NULL;
  `);
  // The local owner. The name starts EMPTY on purpose: extraction needs the name people actually
  // call you in a meeting, so first run asks for it rather than guessing.
  await sqlClient.query(
    `INSERT INTO users (id, name, role, is_admin) VALUES ($1, '', '', true) ON CONFLICT (id) DO NOTHING`,
    [OWNER],
  );
  for (const c of ["google", "jira", "slack"]) {
    await sqlClient.query(
      `INSERT INTO connections (user_id, id) VALUES ($1, $2) ON CONFLICT (user_id, id) DO NOTHING`,
      [OWNER, c],
    );
  }
  await seedEntitiesForUser(OWNER);
  log.info({ driver: usingPostgres ? "postgres" : "pglite" }, "db ready");
}
