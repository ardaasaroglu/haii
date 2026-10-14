import { eq } from "drizzle-orm";
import { db, schema, OWNER } from "../db";
import { log } from "../log";
import { mergeMeta, type ConnectorId } from "../lib/connections";

export interface RawItem {
  connector: string;
  external_id: string;
  kind: string;
  author?: string;
  title?: string;
  body_text?: string;
  url?: string;
  ts: Date;
  relevance?: number;
  raw?: unknown;
}

// Entities are per-user (learned from each user's own attendees), so the cache is keyed by user.
// A single pooled cache would tag one tenant's items with another tenant's private contact names.
type EntityList = Array<{ name: string; needles: string[] }>;
const entityCache = new Map<string, { at: number; ents: EntityList }>();

async function loadEntities(userId: string): Promise<EntityList> {
  const hit = entityCache.get(userId);
  if (hit && Date.now() - hit.at < 300_000) return hit.ents;
  const rows = await db.select().from(schema.entities).where(eq(schema.entities.userId, userId));
  const ents = rows.map((r) => ({
    name: r.name,
    needles: [r.name, ...((r.aliases as string[]) ?? [])].map((n) => n.toLowerCase()),
  }));
  entityCache.set(userId, { at: Date.now(), ents });
  return ents;
}

export function invalidateEntityCache() {
  entityCache.clear();
}

export async function tagEntities(text: string, userId: string): Promise<string[]> {
  const ents = await loadEntities(userId);
  const hay = text.toLowerCase();
  const found: string[] = [];
  for (const e of ents) {
    if (e.needles.some((n) => n.length > 2 && hay.includes(n))) found.push(e.name);
  }
  return found;
}

/** Idempotent ingest: dedupe on (user_id, connector, external_id), tag entities, track freshness.
 *  Every caller passes the user whose items these are: each poller passes the polled user, and the
 *  admin-gated /api/v1/ingest route passes the caller. The OWNER default is only a fallback for a
 *  local single-user call; no current caller relies on it. */
export async function upsertItems(connector: ConnectorId, rawItems: RawItem[], userId: string = OWNER): Promise<number> {
  if (!rawItems.length) return 0;
  let inserted = 0;
  for (const it of rawItems) {
    const entities = await tagEntities(`${it.title ?? ""} ${it.body_text ?? ""}`, userId);
    const res = await db
      .insert(schema.items)
      .values({
        userId,
        connector: it.connector,
        externalId: it.external_id,
        kind: it.kind,
        author: it.author ?? "",
        title: (it.title ?? "").slice(0, 500),
        bodyText: (it.body_text ?? "").slice(0, 4000),
        url: it.url ?? "",
        ts: it.ts,
        entities,
        relevance: it.relevance ?? 0.5,
        raw: it.raw ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: schema.items.id });
    if (res.length) inserted++;
  }
  if (inserted > 0) {
    await mergeMeta(userId, connector, { last_item_at: new Date().toISOString() });
    log.info({ connector, inserted }, "items ingested");
  }
  return inserted;
}
