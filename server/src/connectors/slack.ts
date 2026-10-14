import { env } from "../env";
import { OWNER } from "../db";
import { log } from "../log";
import { getCreds, getCursor, mergeCursor, getMeta, mergeMeta, isConnected } from "../lib/connections";
import { upsertItems, type RawItem } from "./normalize";

/** The complete user-token scope set Haii needs, and the single source of truth for it.
 *
 *  This list exists because the previous arrangement asked a human to retype it into the Slack app
 *  config from a note in Setup, and that note was missing mpim:read and groups:read. The result was
 *  a token that authenticated fine and could not send or poll. Declared here, it goes straight into
 *  the OAuth authorize URL and nobody can transcribe it wrongly.
 *
 *  Every conversation type Haii reads needs BOTH its :history scope (to read messages) and its
 *  :read scope (to list conversations of that type). conversations.list fails the whole call with
 *  missing_scope if any requested type's :read scope is absent. */
export const SLACK_USER_SCOPES = [
  "chat:write",       // the only scope sending actually needs
  "channels:history", "channels:read",   // public channels
  "groups:history", "groups:read",       // private channels
  "im:history", "im:read",               // DMs
  "mpim:history", "mpim:read",           // group DMs
  "users:read",                          // resolve display names for DM targeting and authorship
  // Slack listening (cards from the user's OWN Slack messages): search.messages with
  // from:@me finds own-messages in one call instead of walking every conversation, which is slow
  // on a large workspace and grows with every channel anyone joins.
  // The Slack app must list this scope too. This array builds the authorize URL, and the two MUST
  // match or a reconnect grants a token that authenticates and cannot search. Existing tokens do
  // NOT gain it retroactively: connected users reconnect AFTER this deploys, or they re-consent
  // to the old set and have to do it twice.
  "search:read",
] as const;

async function slackToken(userId: string): Promise<string | null> {
  const stored = (await getCreds<{ user_token?: string }>(userId, "slack")) ?? {};
  // Env fallback is owner-only: see the rationale in connectors/jira.ts. Applied to every user, a
  // decrypt failure would silently poll the OPERATOR's Slack into another user's items table and
  // post to real channels as the operator.
  return stored.user_token || (userId === OWNER ? env.SLACK_USER_TOKEN : "") || null;
}

/** userId comes first so every caller names whose Slack this is. The OWNER default only serves a
 *  local single-user call. */
export async function slackApi(userId: string = OWNER, method: string, params: Record<string, string> = {}): Promise<any> {
  const token = await slackToken(userId);
  if (!token) throw new Error("slack not configured");
  const body = new URLSearchParams(params);
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data: any = await res.json();
  if (!data.ok) throw new Error(`slack ${method}: ${data.error}`);
  return data;
}

export async function slackTest(userId: string = OWNER): Promise<{ ok: boolean; detail: string }> {
  try {
    const data = await slackApi(userId, "auth.test");
    return { ok: true, detail: `connected as ${data.user} in ${data.team}` };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

// Cache key is `${userId}:${slackUserId}`, different tenants can have different Slack
// workspaces, so a bare Slack user id is not globally unique across users.
const userNames = new Map<string, string>();
export async function userName(userId: string, slackUserId: string): Promise<string> {
  if (!slackUserId) return "";
  const cacheKey = `${userId}:${slackUserId}`;
  if (userNames.has(cacheKey)) return userNames.get(cacheKey)!;
  try {
    const data = await slackApi(userId, "users.info", { user: slackUserId });
    const name = data.user?.profile?.display_name || data.user?.real_name || slackUserId;
    userNames.set(cacheKey, name);
    return name;
  } catch {
    return slackUserId;
  }
}

/** One users.list call to warm the userName() cache for every id in `ids`, instead of one
 *  users.info call each. resolveChannels is what made this worth doing: on a cold cache it was
 *  one HTTP round trip per DM, which was most of a slow pollSlack on a large workspace. Same name
 *  priority as userName() itself (display_name, then real_name, then the bare
 *  id), so a cache warmed here is indistinguishable from one warmed the old way.
 *
 *  Only fills gaps (`!userNames.has`), so it composes with whatever is already cached, and ids the
 *  bulk page does not return (a workspace over 500 members, a deactivated user) simply stay
 *  uncached here; userName()'s own per-user call is still the fallback for exactly those, which is
 *  the existing behaviour for everyone, unchanged. */
async function primeUserNames(userId: string, ids: string[]): Promise<void> {
  const need = [...new Set(ids)].filter((i) => i && !userNames.has(`${userId}:${i}`));
  if (!need.length) return;
  try {
    const data = await slackApi(userId, "users.list", { limit: "500" });
    for (const m of data.members ?? []) {
      const cacheKey = `${userId}:${m.id}`;
      if (!userNames.has(cacheKey)) userNames.set(cacheKey, m.profile?.display_name || m.real_name || m.id);
    }
  } catch (e) {
    // Never rethrows. This is a cache optimisation with a complete fallback already in place
    // (userName's own per-user call), so ANY failure here should cost speed and nothing else.
    // Rethrowing only missing_scope was close, but it left a rate_limited or a transient 5xx able
    // to fail the whole poll, which the per-DM path it replaced could never do: userName catches
    // its own errors one at a time. A speedup must not be able to break what it sped up.
    log.warn({ userId, err: String(e) }, "slack users.list failed; DM labels resolve one at a time instead");
  }
}

interface ChannelRef {
  id: string;
  label: string;
}

/** conversations.list needs a SEPARATE read scope per conversation type it is asked for:
 *  channels:read, groups:read, im:read, mpim:read. Asking for several types in one call means a
 *  single missing scope fails the whole call with `missing_scope`, which is what took down every
 *  Slack send and every Slack poll: the token could post fine, but the listing call in front of
 *  the send asked for `im,mpim` and only `im:read` had been granted.
 *
 *  So: one call per type, and a denied type degrades to "Haii cannot see this kind of
 *  conversation" instead of killing the operation. `denied` is reported, never swallowed. */
async function listByType(
  userId: string,
  types: string[],
  extra: Record<string, string> = {},
): Promise<{ channels: any[]; denied: string[] }> {
  const channels: any[] = [];
  const denied: string[] = [];
  for (const t of types) {
    try {
      const data = await slackApi(userId, "conversations.list", { types: t, limit: "200", ...extra });
      channels.push(...(data.channels ?? []));
    } catch (e) {
      if (String(e).includes("missing_scope")) denied.push(t);
      else throw e;
    }
  }
  return { channels, denied };
}

/** The read scope conversations.list wants for each type, so an error can name the actual fix. */
const SCOPE_FOR: Record<string, string> = {
  im: "im:read",
  mpim: "mpim:read",
  public_channel: "channels:read",
  private_channel: "groups:read",
};
const missingScopeHint = (denied: string[]) =>
  denied.length ? ` (Slack denied ${denied.join(", ")}; the token is missing ${denied.map((d) => SCOPE_FOR[d] ?? d).join(", ")})` : "";

/** Resolve DMs, group DMs, and the allowlisted channels (meta.channels: names without #). */
export async function resolveChannels(userId: string): Promise<ChannelRef[]> {
  const meta = await getMeta<{ channels?: string[]; channel_cache?: ChannelRef[]; channel_cache_at?: string }>(userId, "slack");
  const cachedAt = meta.channel_cache_at ? Date.parse(meta.channel_cache_at) : 0;
  if (meta.channel_cache && Date.now() - cachedAt < 3600_000) return meta.channel_cache;

  const refs: ChannelRef[] = [];
  const ims = await listByType(userId, ["im", "mpim"]);
  if (ims.denied.length) log.warn({ userId, denied: ims.denied }, "slack DM listing partly unavailable");
  // Bulk-warm the name cache before the per-DM loop below, instead of one users.info call per DM.
  await primeUserNames(userId, ims.channels.filter((c) => c.is_im).map((c) => c.user));
  for (const c of ims.channels) {
    refs.push({ id: c.id, label: c.is_im ? `DM:${await userName(userId, c.user)}` : "group DM" });
  }
  const allow = (meta.channels ?? []).map((c) => c.replace(/^#/, "").toLowerCase());
  if (allow.length) {
    const chans = await listByType(userId, ["public_channel", "private_channel"], { exclude_archived: "true" });
    if (chans.denied.length) log.warn({ userId, denied: chans.denied }, "slack channel listing partly unavailable");
    for (const c of chans.channels) {
      if (allow.includes(String(c.name).toLowerCase())) refs.push({ id: c.id, label: `#${c.name}` });
    }
  }
  await mergeMeta(userId, "slack", { channel_cache: refs, channel_cache_at: new Date().toISOString() });
  return refs;
}

/** What Haii can actually reach with the stored token, probed with the same calls the poller
 *  makes. Used at connect time so "connected" stops meaning "the token parses". auth.test needs
 *  no scopes at all, so on its own it will happily green-light a token that cannot do one useful
 *  thing. */
export async function slackCapabilities(userId: string = OWNER): Promise<{ conversations: number; denied: string[] }> {
  const ims = await listByType(userId, ["im", "mpim"]);
  const chans = await listByType(userId, ["public_channel"], { exclude_archived: "true" });
  return { conversations: ims.channels.length + chans.channels.length, denied: [...ims.denied, ...chans.denied] };
}

/** Runs `fn` over `items` with at most `limit` in flight at once, in a fixed-size worker pool
 *  rather than an unbounded Promise.all: Slack rate-limits per method, and firing the
 *  conversations.history loop below at all 25 channels simultaneously is exactly the kind of burst
 *  that starts earning 429s instead of finishing sooner. `fn` is expected to catch its own errors,
 *  the same contract the sequential loop always had; a slot moves on to the next item either way. */
async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** 15-minute polling (jobs/scheduler.ts). There is no Events API push. Scoped to the polled user
 *  throughout; channel cache and meta live on that user's own (userId, connector) row.
 *
 *  Bounded concurrency (max 5 channels in flight): each channel reads its own starting mark and
 *  builds its own items[]/mark from nothing else, so no shared state is written until every
 *  channel has finished. The merge into `marks` below is the only point more than one channel's
 *  result touches shared state, and by then it is back to being sequential, so it stays correct
 *  without needing a lock. */
export async function pollSlack(userId: string): Promise<string> {
  if (!(await isConnected(userId, "slack"))) return "skipped: slack not connected";
  const refs = await resolveChannels(userId);
  const cursor = await getCursor<{ slack?: Record<string, string> }>(userId, "slack");
  const startMarks: Record<string, string> = { ...(cursor.slack ?? {}) };

  const perChannel = await mapBounded(refs.slice(0, 25), 5, async (ref) => {
    const startMark = startMarks[ref.id];
    let mark = startMark;
    const items: RawItem[] = [];
    try {
      const params: Record<string, string> = { channel: ref.id, limit: "20" };
      if (startMark) params.oldest = startMark;
      const data = await slackApi(userId, "conversations.history", params);
      for (const m of data.messages ?? []) {
        if (!m.ts || m.subtype === "channel_join") continue;
        if (startMark && Number(m.ts) <= Number(startMark)) continue;
        items.push({
          connector: "slack",
          external_id: `${ref.id}:${m.ts}`,
          kind: "slack_message",
          author: await userName(userId, m.user ?? ""),
          title: ref.label,
          body_text: m.text ?? "",
          ts: new Date(Number(m.ts) * 1000),
        });
        if (!mark || Number(m.ts) > Number(mark)) mark = m.ts;
      }
    } catch (e) {
      log.warn({ userId, channel: ref.label, err: String(e) }, "slack channel poll failed");
    }
    return { channelId: ref.id, items, mark };
  });

  const found: RawItem[] = [];
  const marks: Record<string, string> = { ...startMarks };
  for (const r of perChannel) {
    found.push(...r.items);
    if (r.mark) marks[r.channelId] = r.mark;
  }

  const n = await upsertItems("slack", found, userId);
  // Atomic top-level merge, not setCursor's whole-object write: slackListen (jobs/slackListen.ts)
  // writes its own `slack_search_ts` key into this SAME cursor row, concurrently, via mergeCursor.
  // A whole-object write from this function's snapshot of `cursor` (read before the channel loop
  // above, which can take a while) would silently revert slackListen's advance and cause the same
  // Slack messages to be re-fetched into a second transcript and pushed to the user twice. This
  // function owns the `slack` key entirely, so replacing just that key is correct; every other
  // top-level key is left untouched.
  await mergeCursor(userId, "slack", { slack: marks });
  return `${n} messages from ${refs.length} conversations`;
}

/** Classify a card's `channel` before spending a single API call on it.
 *
 *  Extraction writes whatever the meeting said, and "DM Alex Morgan" arrives as the bare display
 *  name "Alex Morgan". Slack channel names are lowercase and cannot contain whitespace, so that
 *  string is a PERSON and can never be a channel; routing it down the channel path is what
 *  produced `slack channel not found: Alex Morgan`. A bare single word stays ambiguous on
 *  purpose ("design" is far more likely a channel than a person) and gets tried both ways. */
function classifyTarget(raw: string): { kind: "self" | "person" | "channel" | "ambiguous"; name: string } {
  const s = raw.trim();
  if (/^(me|self|myself)$/i.test(s)) return { kind: "self", name: s };
  if (s.startsWith("@")) return { kind: "person", name: s.slice(1).trim() };
  if (/^dm:/i.test(s)) return { kind: "person", name: s.slice(3).trim() };
  if (s.startsWith("#")) return { kind: "channel", name: s.slice(1).trim() };
  if (/\s/.test(s)) return { kind: "person", name: s };
  return { kind: "ambiguous", name: s };
}

/** A person to a postable conversation id, cheapest scope first. Returns null if nobody matches. */
async function resolvePerson(userId: string, name: string): Promise<string | null> {
  const n = name.trim().toLowerCase();
  if (!n) return null;

  // Yourself, by handle, user id, or your own display name. chat.postMessage to your own user id
  // opens the self-DM, so this whole branch needs nothing beyond chat:write and the users:read we
  // already rely on to label DMs. It is also the obvious way anyone tests a Slack connection.
  const auth = await slackApi(userId, "auth.test");
  if (n === String(auth.user_id).toLowerCase() || n === String(auth.user ?? "").toLowerCase()) return auth.user_id;
  if (n === (await userName(userId, auth.user_id)).toLowerCase()) return auth.user_id;

  // Somebody we already have a DM with.
  const refs = await resolveChannels(userId);
  const dm =
    refs.find((r) => r.label.toLowerCase() === `dm:${n}`) ||
    refs.find((r) => r.label.toLowerCase().startsWith("dm:") && r.label.toLowerCase().includes(n));
  if (dm) return dm.id;

  // Somebody we have never DMed. users:read only; a denial here is not fatal, it just means we
  // cannot resolve strangers by name.
  try {
    const data = await slackApi(userId, "users.list", { limit: "500" });
    const hit = (data.members ?? []).find((m: any) =>
      [m.name, m.real_name, m.profile?.display_name, m.profile?.real_name]
        .filter(Boolean)
        .map((s: string) => String(s).toLowerCase())
        .includes(n),
    );
    if (hit?.id) return hit.id;
  } catch (e) {
    if (!String(e).includes("missing_scope")) throw e;
    log.warn({ userId }, "slack users.list denied; cannot resolve people by name");
  }
  return null;
}

async function resolveChannelByName(userId: string, name: string): Promise<{ id?: string; denied: string[] }> {
  const n = name.replace(/^#/, "").toLowerCase();
  // Public first: the common case, and it needs only channels:read. Private is a separate call so
  // a token without groups:read can still post to public channels.
  const pub = await listByType(userId, ["public_channel"], { exclude_archived: "true" });
  let id = pub.channels.find((c: any) => String(c.name).toLowerCase() === n)?.id;
  let denied = pub.denied;
  if (!id) {
    const priv = await listByType(userId, ["private_channel"], { exclude_archived: "true" });
    id = priv.channels.find((c: any) => String(c.name).toLowerCase() === n)?.id;
    denied = [...denied, ...priv.denied];
  }
  return { id, denied };
}

/** Post a message (the executor's real send path).
 *
 *  Ordered cheapest-scope-first on purpose. This used to open with resolveChannels(), so posting
 *  to #general required permission to enumerate your group DMs, and one missing read scope failed
 *  a send the token was perfectly able to make. Sending needs chat:write; a listing call is only
 *  worth making when we genuinely have to turn a name into an id. */
/** `threadTs` replies in that thread instead of posting to the channel. Slack ignores an unknown
 *  ts by posting to the channel anyway, which is the right failure: the message still lands. */
export async function slackPost(userId: string = OWNER, channel: string, text: string, threadTs?: string): Promise<{ url?: string }> {
  const t = classifyTarget(channel);
  const post = async (id: string) => {
    await slackApi(userId, "chat.postMessage", { channel: id, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
    return {};
  };

  if (t.kind === "self") {
    const auth = await slackApi(userId, "auth.test");
    return post(auth.user_id);
  }

  if (t.kind === "person") {
    const id = await resolvePerson(userId, t.name);
    if (!id) throw new Error(`no Slack user matching "${t.name}". Check the name, or use #channel to post to a channel.`);
    return post(id);
  }

  const { id, denied } = await resolveChannelByName(userId, t.name);
  if (id) return post(id);
  // A bare word that is not a channel might still be a person.
  if (t.kind === "ambiguous") {
    const pid = await resolvePerson(userId, t.name);
    if (pid) return post(pid);
  }
  throw new Error(`no Slack channel or user matching "${channel}"${missingScopeHint(denied)}`);
}
