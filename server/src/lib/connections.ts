import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { encrypt, decrypt } from "./crypto";
import { log } from "../log";

export type ConnectorId =
  | "google" | "jira" | "slack" | "confluence"
  // Notetakers: transcript sources, so CARD sources. See lib/notetaker.ts.
  | "fireflies" | "fathom" | "otter"
  // Destinations and context. CRMs serve create_crm_note; Linear and Asana are create_task
  // destinations and are also polled for context.
  | "hubspot" | "salesforce" | "linear" | "asana"
  | "telegram";

export async function getConnection(userId: string, id: ConnectorId) {
  const rows = await db
    .select()
    .from(schema.connections)
    .where(and(eq(schema.connections.userId, userId), eq(schema.connections.id, id)));
  return rows[0] ?? null;
}

/** Make sure a user has their connector rows (called at signup and defensively).
 *
 *  `confluence` is here so the Setup card can render its off state from a real row like every
 *  other connector. It carries no credentials of its own: it reads the Jira token, and its own
 *  status is what records that the user opted in to us reading their wiki as well as their board. */
export async function ensureConnections(userId: string) {
  for (const id of [
    "google", "jira", "slack", "confluence",
    "fireflies", "fathom", "otter",
    "hubspot", "salesforce", "linear", "asana",
  ] as const) {
    await db
      .insert(schema.connections)
      .values({ userId, id })
      .onConflictDoNothing();
  }
}

export async function getCreds<T = Record<string, unknown>>(
  userId: string,
  id: ConnectorId,
): Promise<T | null> {
  const row = await getConnection(userId, id);
  if (!row?.authJson) return null;
  try {
    return JSON.parse(decrypt(row.authJson)) as T;
  } catch (e) {
    log.error({ userId, id, err: String(e) }, "failed to decrypt creds");
    // Flip the connection out of "connected" so isConnected() stops lying. Otherwise every caller
    // still believes the connector is live, pollers keep running against nothing, and the UI shows
    // a healthy badge while the streams quietly go stale. needs_reauth is the state the user can
    // actually resolve (reconnect), which is the correct remedy for an unreadable credential.
    await setStatus(userId, id, "needs_reauth").catch(() => {});
    return null;
  }
}

export async function setCreds(
  userId: string,
  id: ConnectorId,
  creds: Record<string, unknown>,
  status = "connected",
) {
  await db
    .insert(schema.connections)
    .values({ userId, id, authJson: encrypt(JSON.stringify(creds)), status, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.connections.userId, schema.connections.id],
      set: { authJson: encrypt(JSON.stringify(creds)), status, updatedAt: new Date() },
    });
}

export async function mergeCreds(userId: string, id: ConnectorId, patch: Record<string, unknown>) {
  const cur = (await getCreds(userId, id)) ?? {};
  await setCreds(userId, id, { ...cur, ...patch });
}

export async function setStatus(userId: string, id: ConnectorId, status: string) {
  await db
    .update(schema.connections)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(schema.connections.userId, userId), eq(schema.connections.id, id)));
}

export async function getCursor<T = Record<string, unknown>>(
  userId: string,
  id: ConnectorId,
): Promise<T> {
  const row = await getConnection(userId, id);
  return ((row?.cursor as T) ?? {}) as T;
}

export async function setCursor(userId: string, id: ConnectorId, cursor: Record<string, unknown>) {
  await db
    .update(schema.connections)
    .set({ cursor, updatedAt: new Date() })
    .where(and(eq(schema.connections.userId, userId), eq(schema.connections.id, id)));
}

/** Merge top-level cursor keys ATOMICALLY, in the database, instead of read-modify-write.
 *
 *  `setCursor` writes the whole object, so two jobs sharing one connector's cursor can lose each
 *  other's writes: slack_poll keeps per-channel marks under `slack`, slack_listen keeps
 *  `slack_search_ts`, and whichever read first and wrote last silently reverts the other. Re-reading
 *  immediately before the write narrows that window but cannot close it, because the gap is between
 *  the read and the write and there is no optimistic locking on this row.
 *
 *  jsonb `||` is a shallow merge evaluated inside the UPDATE, so the read never happens in our
 *  process and there is no window at all. Shallow is exactly right here: every key that two jobs
 *  contend over is top-level, and a deep merge would silently union the per-channel mark maps
 *  rather than letting the owning job replace its own. Use this whenever more than one writer
 *  touches a connector's cursor; `setCursor` is still correct when a job owns the whole object. */
export async function mergeCursor(userId: string, id: ConnectorId, patch: Record<string, unknown>) {
  await db
    .update(schema.connections)
    .set({
      cursor: sql`${schema.connections.cursor} || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.connections.userId, userId), eq(schema.connections.id, id)));
}

export async function getMeta<T = Record<string, unknown>>(
  userId: string,
  id: ConnectorId,
): Promise<T> {
  const row = await getConnection(userId, id);
  return ((row?.meta as T) ?? {}) as T;
}

export async function mergeMeta(userId: string, id: ConnectorId, patch: Record<string, unknown>) {
  const cur = await getMeta(userId, id);
  await db
    .update(schema.connections)
    .set({ meta: { ...cur, ...patch }, updatedAt: new Date() })
    .where(and(eq(schema.connections.userId, userId), eq(schema.connections.id, id)));
}

export async function isConnected(userId: string, id: ConnectorId): Promise<boolean> {
  const row = await getConnection(userId, id);
  return row?.status === "connected";
}
