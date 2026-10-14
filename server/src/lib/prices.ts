/** Which row of a price table applies to the model the API says it served.
 *
 *  The API reports the dated snapshot it actually ran ("claude-haiku-4-5-20251001"), not the alias
 *  that was asked for ("claude-haiku-4-5"). An exact lookup missed every dated id and fell through
 *  to the default model's rate, so the ledger billed the small model at the large one's price and
 *  the caps tripped early. Match on the family name instead, longest name first, so
 *  "claude-sonnet-5-5" is never mistaken for "claude-sonnet-5".
 *
 *  Pure, so it is tested without booting anything. */
export function priceFor<T>(model: string, table: Record<string, T>, fallback: string): T {
  const names = Object.keys(table).sort((a, b) => b.length - a.length);
  const hit = names.find((name) => model === name || model.startsWith(name + "-"));
  return table[hit ?? fallback];
}
