/** The context manifest: a record of what actually went into a prompt.
 *
 *  This is the keystone of the data boundary. Before it existed, `retrieve()` in jobs/briefing.ts
 *  and `buildExtractRequest()` in jobs/extract.ts each returned plain strings, so the moment a
 *  prompt was assembled there was no record of which source rows produced it. Provenance was
 *  unrecoverable after the fact, not merely unrecorded.
 *
 *  What uses it today: every card stores one on context.manifest and every brief on
 *  briefings.manifest, and the admin overview (api/routes.ts) reads the card manifests to compare
 *  approval rates for cards made with and without memory. Three planned features need this same
 *  shape, and none of them is built yet:
 *  • an executor gate that refuses an outbound draft whose sources include internal-only material,
 *    enforced in code rather than by asking the model nicely in a prompt;
 *  • provenance chips on a card, which need something to render;
 *  • connector privacy filters, which need exactly one chokepoint where "the model never saw this"
 *    is actually true.
 *
 *  The pattern: one place assembles what the model sees, and **the stored form is richer than the
 *  sent form.**
 */

/** Meant to be set at source granularity (a Slack channel, a Drive folder, a Jira project) with
 *  per-item override, once the visibility controls ship. Until then every entry is `internal`.
 *  Nothing reads this value yet: the executor has no gate that checks it. The default is the closed
 *  one so that a gate added later starts from a world where nothing unclassified counts as cleared
 *  to leave. */
export type Visibility = "internal" | "external_approved";

export interface ManifestEntry {
  /** Which table this came from, so a reader can find the row again. */
  source: "item" | "transcript" | "meeting" | "card" | "todo" | "memory" | "attachment";
  /** The row's own id, or the closest stable identifier available. */
  id: string;
  /** The stream it arrived on, where that is meaningful (gmail, slack, jira, drive). */
  connector?: string;
  visibility: Visibility;
}

/** A manifest is capped, because it rides on every card and briefing row forever. Sixty is far
 *  above what either assembler can currently include (the briefing retrieves at most 6 snippets,
 *  10 cards, 10 todos and 6 attendees) and low enough that a future assembler cannot bloat a row
 *  without someone noticing the truncation. */
export const MANIFEST_LIMIT = 60;

/** Normalise, de-duplicate and cap. Order is preserved so the first mention of a row wins, which
 *  keeps the highest-value context (the snippets a brief was actually built from) ahead of the
 *  incidental (the open-todo list) when the cap bites.
 *
 *  De-duplication is on source+id, NOT on id alone: ids are only unique within their own table, and
 *  a card and a todo could collide. That is the sort of thing that silently drops a provenance
 *  entry and stays invisible until a gate built on this list lets something through it should have
 *  caught. */
export function buildManifest(entries: Array<ManifestEntry | null | undefined>): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e || !e.id) continue;
    const key = `${e.source}:${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source: e.source,
      id: String(e.id),
      ...(e.connector ? { connector: e.connector } : {}),
      visibility: e.visibility === "external_approved" ? "external_approved" : "internal",
    });
    if (out.length >= MANIFEST_LIMIT) break;
  }
  return out;
}

/** One entry, with `internal` filled in. Exists so the two assemblers read as lists of sources
 *  rather than as object literals, and so the default can never be forgotten at a call site. */
export function src(
  source: ManifestEntry["source"],
  // number as well as string, and not as a convenience: `items.id` is a serial while `cards.id` is
  // text, so a signature that took only strings would push a cast to every call site, and a cast at
  // a call site is where a wrong id gets written without anything complaining.
  id: string | number | null | undefined,
  connector?: string | null,
): ManifestEntry | null {
  if (id === null || id === undefined || id === "") return null;
  return { source, id: String(id), ...(connector ? { connector } : {}), visibility: "internal" };
}
