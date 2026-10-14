import {
  pgTable,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  serial,
  primaryKey,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email"), // unique index in DDL; nullable until first Google login maps it
  role: text("role").notNull().default(""), // persona line for prompts, e.g. "Product lead at Northwind"
  tz: text("tz").notNull().default("local"),
  // BCP-47 tag the PWA reports from the device, alongside tz. Decides how a time is spelled
  // (2:00 PM vs 14:00); tz decides which instant. Empty means "not reported yet" and falls back
  // to en-GB, the 24h format every one of these surfaces used before. See lib/tz.hhmmForUser.
  locale: text("locale").notNull().default(""),
  telegramChatId: text("telegram_chat_id"),
  isAdmin: boolean("is_admin").notNull().default(false),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  /** The user chose their zone by hand, so the device must stop overwriting it. Without this a
   *  manual choice survives exactly until the next page load, because the PWA reports the device
   *  zone on every boot. */
  tzPinned: boolean("tz_pinned").notNull().default(false),
  /** new | reading | first | questions | done. Resumable: closing the tab mid-backfill returns
   *  you where you were, not to the start and not past it. */
  onboardingState: text("onboarding_state").notNull().default("new"),
  /** The two onboarding answers, fed to extraction as the user's own words about what matters. */
  owns: text("owns").notNull().default(""),
  catches: jsonb("catches").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per (user, connector). auth_json is AES-256-GCM encrypted; cursor/meta are plain. */
export const connections = pgTable(
  "connections",
  {
    userId: text("user_id").notNull().default("owner"),
    id: text("id").notNull(), // a ConnectorId (lib/connections.ts). Older installs may also hold unused telegram/anthropic rows.
    status: text("status").notNull().default("disconnected"),
    authJson: text("auth_json"),
    cursor: jsonb("cursor").notNull().default({}),
    meta: jsonb("meta").notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] })],
);

/** Normalized stream items from every connector. */
export const items = pgTable("items", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().default("owner"),
  connector: text("connector").notNull(),
  externalId: text("external_id").notNull(),
  kind: text("kind").notNull(),
  author: text("author").notNull().default(""),
  title: text("title").notNull().default(""),
  bodyText: text("body_text").notNull().default(""),
  url: text("url").notNull().default(""),
  ts: timestamp("ts", { withTimezone: true }).notNull(),
  entities: jsonb("entities").notNull().default([]),
  relevance: real("relevance").notNull().default(0.5),
  raw: jsonb("raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const meetings = pgTable("meetings", {
  id: text("id").primaryKey(), // mtg_${userId}_${externalId} for gcal rows
  userId: text("user_id").notNull().default("owner"),
  source: text("source").notNull().default("gcal"), // gcal | manual | bridge
  externalId: text("external_id"),
  title: text("title").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  attendees: jsonb("attendees").notNull().default([]),
  location: text("location").notNull().default(""),
  /** The invite body. Agendas, dial-in notes and "read this first" links live here; without it a
   *  brief could miss the one thing the organiser wrote down. */
  description: text("description").notNull().default(""),
  /** Files attached to the invite: [{fileId, title, mimeType, url}]. The attached agenda doc is
   *  usually the most brief-worthy thing about a meeting, and a filename alone is nearly useless,
   *  so the Drive content is fetched for the ones we can read. */
  attachments: jsonb("attachments").notNull().default([]),
  raw: jsonb("raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transcripts = pgTable("transcripts", {
  id: text("id").primaryKey(), // tr_${userId}_${fileId} for drive rows
  userId: text("user_id").notNull().default("owner"),
  driveFileId: text("drive_file_id"),
  meetingId: text("meeting_id"),
  title: text("title").notNull(),
  contentMd: text("content_md").notNull(),
  source: text("source").notNull().default("paste"), // drive | paste | slack | fireflies | fathom | otter
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  extractedAt: timestamp("extracted_at", { withTimezone: true }),
  /** The transcript that already covers this meeting, when this one is a SECOND recording of the
   *  same conversation.
   *
   *  The moment a second transcript source exists (a notetaker alongside Gemini), the same meeting
   *  can arrive twice, and cards come from transcripts, so that is two sets of cards for one
   *  conversation: the user is asked to nod the same promise twice and the north star counts it
   *  twice. One EXTRACTED transcript per meeting is the invariant.
   *
   *  A superseded row is kept rather than dropped, because it is often the better text and we may
   *  want it later; it is simply never a card source. `extracted_at` is stamped alongside this,
   *  because that is the marker the pending sweep reads, so the sweep skips it. This column is what
   *  makes that decision explicable afterwards instead of looking like a transcript that was
   *  silently read and produced nothing. */
  supersededBy: text("superseded_by"),
});

export const briefings = pgTable("briefings", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().default("owner"),
  meetingId: text("meeting_id").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  contentJson: jsonb("content_json").notNull(),
  /** What went into the prompt that produced this brief: source rows with ids and visibility.
   *  NULL on a brief written before manifests existed, which is not the same as an empty manifest
   *  and must not be read as one. See lib/manifest.ts. */
  manifest: jsonb("manifest"),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  rating: text("rating"),
  /** Seconds the brief was actually on screen. Written on CLOSE, not only on rate: while the rating
   *  endpoint was the sole writer this column measured "briefs rated", and a brief read for two
   *  minutes without a thumb was indistinguishable from one never opened. That made the
   *  briefs_read gauge unable to observe the one behaviour it existed to detect. */
  readSeconds: integer("read_seconds"),
  /** Which chip was tapped on a thumbs-down: too_long | wrong_people | missed_the_point. Chips, not
   *  free text, for the same reason cards use them: aggregatable and one tap. */
  feedbackReason: text("feedback_reason"),
  /** Free text the user wrote about this brief. Chips cannot express "the brief was fine but it
   *  missed the agenda attached to the invite", and that sentence is worth more than any chip.
   *  Available whatever the rating, because a brief can be good and still be missing something. */
  feedbackNote: text("feedback_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
});

export const cards = pgTable("cards", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().default("owner"),
  schemaVersion: integer("schema_version").notNull().default(1),
  type: text("type").notNull().default("action"),
  actionType: text("action_type").notNull(),
  status: text("status").notNull().default("proposed"),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  confidence: real("confidence").notNull(),
  priority: text("priority").notNull().default("normal"),
  sourceJson: jsonb("source_json").notNull(),
  payload: jsonb("payload").notNull(),
  context: jsonb("context").notNull(),
  feedback: jsonb("feedback"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** Set when the user swipes left and picks Later. status becomes 'snoozed', which the feed's
   *  status = 'proposed' filter excludes for free, and lib/snooze.ts decides when it comes back. */
  snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
  /** When they deferred it. The 2h floor is measured from HERE, not from snoozed_until, so the
   *  thin-deck rule cannot hand back a card the user pushed away minutes ago. */
  snoozedAt: timestamp("snoozed_at", { withTimezone: true }),
  /** The LOCAL day the card is due back on (YYYY-MM-DD), when the "next morning" rule decided.
   *  snoozed_until is still written and is what selectWakes compares, but it is recomputed from
   *  this key in the user's CURRENT zone on every wake, so travel moves the card with the user.
   *  Null when the 2h floor decided: that rule produces a real instant and must not be re-resolved. */
  snoozedWakeDay: text("snoozed_wake_day"),
  /** Deferrals so far. At MAX_SNOOZES the card stops returning, or Later becomes never. */
  snoozeCount: integer("snooze_count").notNull().default(0),
  simulated: boolean("simulated").notNull().default(false),
  transcriptId: text("transcript_id"),
  meetingId: text("meeting_id"),
  model: text("model").notNull().default(""),
  promptVersion: text("prompt_version").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  /** How many times this card was decided and then taken back. Its own column because undo nulls
   *  `feedback` (the card has to be re-decidable, and /stats treats a non-null feedback as decided),
   *  so anything stored in there would be erased by the very event we are trying to count.
   *  An approve-then-immediately-regret is the sharpest precision signal we have: the user believed
   *  the card enough to swipe and changed their mind within five seconds. */
  undoCount: integer("undo_count").notNull().default(0),
});

export const todos = pgTable("todos", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().default("owner"),
  title: text("title").notNull(),
  due: text("due").notNull().default(""),
  notes: text("notes").notNull().default(""),
  status: text("status").notNull().default("open"),
  cardId: text("card_id"),
  /** The card this capture was PROMOTED into: a real Jira issue. Set once and
   *  never cleared, so a capture cannot be promoted twice, and so the follow-ups view can show
   *  where a commitment actually went instead of leaving it in a list that only accumulates. */
  promotedCardId: text("promoted_card_id"),
  /** When the self-wake job last nudged about this. Its own column so the nudge fires once per
   *  due date rather than every time the job ticks. Null means never nudged. */
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  /** Manual position in "Yours to do", NULL until the user drags something. Null rather than a
   *  default of 0 on purpose: it distinguishes "the user has an opinion about this list" from
   *  "nobody has touched it", so an untouched list keeps sorting by due date and only becomes
   *  hand-ordered once somebody says so. */
  sortOrder: integer("sort_order"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const entities = pgTable("entities", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().default("owner"),
  name: text("name").notNull(),
  type: text("type").notNull().default("person"), // person | org | project | topic
  aliases: jsonb("aliases").notNull().default([]),
});

export const jobRuns = pgTable("job_runs", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().default(""), // '' = system-wide run
  job: text("job").notNull(),
  status: text("status").notNull(), // ok | error | skipped
  detail: text("detail").notNull().default(""),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
});

/** Durable facts about how a user works, written by the model as a side-output of extraction and
 *  read back into the system prompt. Distinct from the visibility of ingested content (see
 *  lib/manifest.ts): this is a short list of learned preferences. */
export const memories = pgTable("memories", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Dead-letter store: anything that failed with nobody watching (cron-driven jobs, card
 *  executions, rate limits). One row = one thing the user should be told about. */
export const failures = pgTable("failures", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().default(""),
  kind: text("kind").notNull(), // job | execution | rate_limit
  ref: text("ref").notNull().default(""), // job name, card id, or model
  title: text("title").notNull().default(""), // human label for the UI
  detail: text("detail").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  seenAt: timestamp("seen_at", { withTimezone: true }),
});

export const llmLedger = pgTable("llm_ledger", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().default(""), // '' = system
  day: text("day").notNull(), // YYYY-MM-DD local
  job: text("job").notNull(),
  model: text("model").notNull(),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  // Prompt-cache accounting: writes bill ~1.25x input, reads ~0.1x. Zero until caching activates.
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const digests = pgTable("digests", {
  id: text("id").primaryKey(), // dg_${userId}_${day}
  userId: text("user_id").notNull().default("owner"),
  day: text("day").notNull(),
  contentJson: jsonb("content_json").notNull(),
  model: text("model").notNull().default(""),
  promptVersion: text("prompt_version").notNull().default(""),
  costUsd: real("cost_usd").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Login sessions. sid is the cookie value. */
export const sessions = pgTable("sessions", {
  sid: text("sid").primaryKey(),
  userId: text("user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
});

/** DB-backed executor timers: undo grace + scheduled executions survive restarts and deploys. */
export const executions = pgTable("executions", {
  id: serial("id").primaryKey(),
  cardId: text("card_id").notNull(), // unique index in DDL
  userId: text("user_id").notNull().default("owner"),
  executeAfter: timestamp("execute_after", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("queued"), // queued | running | done | cancelled | failed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Batch bookkeeping: one row per submitted Anthropic Message Batch. status is our own
 *  submission lifecycle, not the API's processing_status: submitted | canceling | ended | failed. */
export const llmBatches = pgTable("llm_batches", {
  id: serial("id").primaryKey(),
  providerBatchId: text("provider_batch_id"),
  status: text("status"),
  // Which applier owns this batch's results. Was implicitly "extract" when extraction was the only
  // batched job; briefing batches (4am pre-generation) reuse the same table and poller.
  kind: text("kind").notNull().default("extract"),
  userId: text("user_id").notNull().default(""),
  // Ordered meeting ids for a brief batch, positionally matching the requests. custom_id is the
  // position, because the meeting id overflows the API's 64-char cap. See lib/batch.ts.
  customIds: jsonb("custom_ids"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
