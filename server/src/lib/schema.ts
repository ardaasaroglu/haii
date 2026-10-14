/** JSON Schema shaping for the structured-outputs dialect.
 *
 *  Kept in its own module (rather than inline in llm.ts) so it can be exercised without booting the
 *  DB, env guard, and Telegram client that llm.ts pulls in. It sits on the critical path of every
 *  metered call, so it needs to be testable in isolation.
 *
 *  `output_config.format` accepts a restricted dialect: types, enum, const, anyOf, allOf, $ref/$def,
 *  string formats, and additionalProperties:false. Cardinality and range bounds are NOT accepted and
 *  fail the whole request with a 400. The prompt schemas use minItems/maxItems, so without this pass
 *  the first metered call on any job (briefing, extraction, digest) would 400.
 */

/** Dropped silently: a numeric range on a model-filled field is advisory anyway. */
const DROPPED_SCHEMA_KEYS = new Set([
  "uniqueItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

/** Bounds worth preserving. Stripping these outright would delete real intent: BRIEFING_SCHEMA's
 *  "max 4 sections" exists nowhere else, the prose only caps total words. So fold each into the
 *  node's `description`, which the dialect does accept. The cap degrades from validated to
 *  instructed rather than vanishing, and future schemas get the same treatment for free. */
const FOLDED_SCHEMA_KEYS: Record<string, (v: unknown) => string> = {
  maxItems: (v) => `at most ${v} items`,
  minItems: (v) => `at least ${v} items`,
  maxLength: (v) => `at most ${v} characters`,
  minLength: (v) => `at least ${v} characters`,
};

function sentence(s: string): string {
  return `${s[0].toUpperCase()}${s.slice(1)}`;
}

/** Recursively rewrite a schema into the accepted dialect. Pure; never mutates the input. */
export function sanitizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (!node || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  const folded: string[] = [];
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (DROPPED_SCHEMA_KEYS.has(k)) continue;
    const fold = FOLDED_SCHEMA_KEYS[k];
    if (fold) {
      folded.push(fold(v));
      continue;
    }
    out[k] = sanitizeSchema(v);
  }

  if (folded.length) {
    const note = sentence(`${folded.join(", ")}.`);
    const prior = typeof out.description === "string" ? out.description.trim() : "";
    out.description = prior ? `${prior.replace(/\.?$/, ".")} ${note}` : note;
  }
  return out;
}

/** Test helper: every key the dialect rejects, for asserting a sanitized schema is actually clean. */
export const REJECTED_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  ...DROPPED_SCHEMA_KEYS,
  ...Object.keys(FOLDED_SCHEMA_KEYS),
]);
