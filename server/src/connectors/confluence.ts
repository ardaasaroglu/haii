/** Confluence, read only.
 *
 *  The cheapest connector available and the reason is that it needs no new authentication at all:
 *  Confluence lives on the same Atlassian site as Jira and answers to the same API token, so this
 *  borrows `jiraCreds` outright rather than asking anyone for a second credential. It is the
 *  cheapest connector to add for exactly that reason.
 *
 *  IT PRODUCES ITEMS, NEVER CARDS. This is the rule in CLAUDE.md that is easiest to get wrong:
 *  cards come from transcripts and nothing else. A page someone edited is context for a brief, in
 *  the same way a Jira update or a Slack message is. Expecting a card from a Slack post is the
 *  common surprise; a Confluence page is the same expectation with the same answer.
 *
 *  SEPARATE CONNECTOR ROW, not a Jira sub-setting, even though it shares the token. Two reasons:
 *  a user must be able to give Haii their Jira board without also giving it every page in their
 *  wiki, and a future data boundary would classify visibility per source, which needs a source to
 *  hang off. Enabling it is therefore an explicit act even though no credential is collected.
 */
import { jiraCreds, jiraFetch } from "./jira";
import { getMeta, isConnected } from "../lib/connections";
import { upsertItems, type RawItem } from "./normalize";

/** How far back each poll looks. Wider than the 10 minute cadence on purpose, so a missed tick or
 *  a deploy does not leave a hole; upsertItems dedupes on external_id, so overlap costs nothing. */
const LOOKBACK = '-30m';

/** Confluence storage format is XHTML. Briefs want a sentence, not markup, and the model should
 *  never be handed a wall of tags it has to ignore. Cheap and deterministic: no parser, because a
 *  parser here would be a dependency for a preview line. */
function stripMarkup(html: string, max = 400): string {
  return String(html ?? "")
    .replace(/<ac:[^>]*>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Build the CQL. Spaces are optional and behave like Slack's channel list: empty means every
 *  space this token can already see, which is the same thing the user sees when they log in. */
export function confluenceCql(spaces: string[] = [], lookback = LOOKBACK): string {
  const clean = spaces.map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 25);
  const scope = clean.length ? ` and space in (${clean.map((s) => `"${s}"`).join(",")})` : "";
  return `type=page and lastmodified >= now("${lookback}")${scope} order by lastmodified desc`;
}

export async function confluenceTest(userId: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const c = await jiraCreds(userId);
    if (!c) return { ok: false, detail: "connect Jira first: Confluence uses the same Atlassian token" };
    // The space list is the lightest call that proves both the token and that Confluence is
    // actually enabled on this site, which a /myself against Jira cannot tell you.
    const res = await jiraFetch(userId, "/wiki/rest/api/space?limit=1");
    if (res.status === 404) return { ok: false, detail: "no Confluence on this Atlassian site" };
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const data: any = await res.json();
    const n = data?.size ?? (data?.results ?? []).length;
    return { ok: true, detail: n ? `connected to ${c.site}` : `connected, no spaces visible yet` };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

/** Pages edited in the last half hour, in the spaces the user named. */
export async function pollConfluence(userId: string): Promise<string> {
  if (!(await isConnected(userId, "confluence"))) return "skipped: confluence not connected";
  const c = await jiraCreds(userId);
  if (!c) return "skipped: no Atlassian credentials (connect Jira)";

  const meta = (await getMeta(userId, "confluence")) ?? {};
  const spaces = Array.isArray((meta as any).spaces) ? ((meta as any).spaces as string[]) : [];
  const cql = confluenceCql(spaces);
  const res = await jiraFetch(
    userId,
    `/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=25&expand=version,space,body.storage`,
  );
  if (res.status === 404) return "skipped: no Confluence on this site";
  if (!res.ok) throw new Error(`confluence search ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();

  const found: RawItem[] = (data.results ?? []).map((p: any) => {
    const when = p?.version?.when ?? "";
    const who = p?.version?.by?.displayName ?? "";
    const space = p?.space?.name ?? p?.space?.key ?? "";
    return {
      connector: "confluence",
      // Version-stamped, same shape as the Jira key: one row per EDIT, so a page touched twice is
      // two pieces of context and re-polling the same edit is a no-op.
      external_id: `${p.id}@${when}`,
      kind: "confluence_page",
      author: who,
      title: String(p?.title ?? "").slice(0, 300),
      body_text: [space && `space: ${space}`, stripMarkup(p?.body?.storage?.value ?? "")]
        .filter(Boolean)
        .join(" · "),
      url: p?._links?.webui ? `https://${c.site}/wiki${p._links.webui}` : `https://${c.site}/wiki`,
      ts: new Date(when || Date.now()),
    };
  });
  const n = await upsertItems("confluence", found, userId);
  return `${n} page edits`;
}
