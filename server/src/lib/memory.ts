import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { isDuplicateFact } from "./memorySelect";
import { log } from "../log";

/** Hard ceiling on what reaches a prompt. Memory earns its keep by being small: the authoring
 *  rules (revise, do not append) are the real control, this is the backstop. */
export const MEMORY_LIMIT = 40;

export interface MemoryWrite {
  op: "add" | "update" | "forget";
  id?: number;
  content?: string;
}

/** Durable facts about how this user works, newest first. */
export async function listMemories(userId: string, limit = MEMORY_LIMIT) {
  return db
    .select({
      id: schema.memories.id,
      content: schema.memories.content,
      updatedAt: schema.memories.updatedAt,
    })
    .from(schema.memories)
    .where(eq(schema.memories.userId, userId))
    .orderBy(desc(schema.memories.updatedAt))
    .limit(limit);
}

/** Render for the system prompt. Ids are shown so the model can REVISE an entry instead of
 *  adding a near-duplicate, which is the whole reason this stays small without embeddings or
 *  any retrieval step. */
export function formatMemories(items: Array<{ id: number; content: string }>): string {
  if (!items.length) return "";
  return (
    `\n\nWhat you have learned about this user in earlier sessions (revise or retire these rather than repeating them):\n` +
    items.map((m) => `- [#${m.id}] ${m.content}`).join("\n")
  );
}

/** Apply the model's proposed memory writes. Deliberately forgiving: a malformed entry is skipped
 *  rather than failing the extraction that produced it, because losing a user's action cards to a
 *  bad memory write would be a terrible trade. Ownership is enforced on every id. */
export async function applyMemoryWrites(userId: string, raw: unknown): Promise<number> {
  const writes: MemoryWrite[] = Array.isArray(raw) ? (raw as MemoryWrite[]) : [];
  if (!writes.length) return 0;
  // THE WHOLE CORPUS, not the slice the model was shown. Since retrieval landed the prompt carries
  // only twelve of up to forty facts, so the model's own "do not add a near-duplicate" rule can
  // only police what it can see. Without this the corpus fills with restatements of itself and the
  // trim below evicts older, still-true facts to make room. See isDuplicateFact.
  const existingRows = await db
    .select({ content: schema.memories.content })
    .from(schema.memories)
    .where(eq(schema.memories.userId, userId));
  const existing = existingRows.map((r) => r.content);
  let applied = 0;
  for (const w of writes.slice(0, 5)) {
    try {
      const content = String(w?.content ?? "").trim().slice(0, 500);
      if (w?.op === "add") {
        if (content.length < 8) continue;
        if (isDuplicateFact(content, existing)) {
          log.info({ userId, content: content.slice(0, 80) }, "memory add skipped as a duplicate");
          continue;
        }
        await db.insert(schema.memories).values({ userId, content });
        // Added to the in-memory list too, so two near-identical adds in ONE response cannot both
        // land: the second is compared against the first.
        existing.push(content);
        applied++;
      } else if (w?.op === "update" && w.id) {
        if (content.length < 8) continue;
        const r = await db
          .update(schema.memories)
          .set({ content, updatedAt: new Date() })
          .where(and(eq(schema.memories.id, Number(w.id)), eq(schema.memories.userId, userId)))
          .returning({ id: schema.memories.id });
        applied += r.length;
      } else if (w?.op === "forget" && w.id) {
        const r = await db
          .delete(schema.memories)
          .where(and(eq(schema.memories.id, Number(w.id)), eq(schema.memories.userId, userId)))
          .returning({ id: schema.memories.id });
        applied += r.length;
      }
    } catch (e: any) {
      log.warn({ err: String(e?.message ?? e), op: w?.op }, "memory write skipped");
    }
  }
  // Backstop the ceiling: drop the oldest beyond the limit so the prompt block cannot creep.
  try {
    const all = await db
      .select({ id: schema.memories.id })
      .from(schema.memories)
      .where(eq(schema.memories.userId, userId))
      .orderBy(desc(schema.memories.updatedAt));
    for (const row of all.slice(MEMORY_LIMIT)) {
      await db.delete(schema.memories).where(eq(schema.memories.id, row.id));
    }
  } catch {
    /* trimming is hygiene, never a reason to fail the caller */
  }
  return applied;
}
