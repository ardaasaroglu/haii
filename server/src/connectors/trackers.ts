/** Linear and Asana.
 *
 *  POLLING PRODUCES ITEMS, NOT CARDS, exactly like Jira. Cards come from transcripts and nothing
 *  else (CLAUDE.md). An issue someone moved is context for a brief, the same way a Jira update or a
 *  Slack message is.
 *
 *  Both are also destinations. A `create_task` card names its tracker in the payload, and the
 *  executor (jobs/executor.ts) calls linearCreateIssue or asanaCreateTask below. One type carrying
 *  a destination, rather than one action type per vendor.
 */
import { getCreds, getMeta, isConnected, mergeMeta } from "../lib/connections";
import { upsertItems, type RawItem } from "./normalize";

const LINEAR = "https://api.linear.app/graphql";
const ASANA = "https://app.asana.com/api/1.0";
const LIMIT = 25;

/* ---------------- Linear ---------------- */

async function linearGql<T>(key: string, query: string): Promise<T> {
  const res = await fetch(LINEAR, {
    method: "POST",
    // Linear personal API keys go in Authorization WITHOUT a Bearer prefix. With one, Linear
    // answers 400 rather than 401, which reads as a malformed query instead of a bad credential.
    headers: { authorization: key, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`linear ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body: any = await res.json();
  if (body?.errors?.length) throw new Error(`linear: ${String(body.errors[0]?.message).slice(0, 160)}`);
  return body?.data as T;
}

export async function linearTest(userId: string, keyOverride?: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const key = keyOverride || (await getCreds<{ api_key?: string }>(userId, "linear"))?.api_key;
    if (!key) return { ok: false, detail: "no API key saved" };
    const d = await linearGql<{ viewer: { name?: string; email?: string } }>(key, `query { viewer { name email } }`);
    const who = d?.viewer?.name || d?.viewer?.email;
    return { ok: true, detail: who ? `connected as ${who}` : "connected" };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 160) };
  }
}

export async function pollLinear(userId: string): Promise<string> {
  if (!(await isConnected(userId, "linear"))) return "skipped: linear not connected";
  const key = (await getCreds<{ api_key?: string }>(userId, "linear"))?.api_key;
  if (!key) return "skipped: no linear api key";
  const d = await linearGql<{ issues: { nodes: any[] } }>(
    key,
    `query { issues(first: ${LIMIT}, filter: { assignee: { isMe: { eq: true } } }, orderBy: updatedAt) {
      nodes { id identifier title updatedAt url state { name } } } }`,
  );
  const found: RawItem[] = (d?.issues?.nodes ?? []).map((n: any) => ({
    connector: "linear",
    // Stamped with updatedAt like the Jira key, so one row per CHANGE and a re-poll is a no-op.
    external_id: `${n.identifier ?? n.id}@${n.updatedAt ?? ""}`,
    kind: "linear_issue",
    author: "",
    title: `${n.identifier ?? ""} ${n.title ?? ""}`.trim(),
    body_text: `state: ${n.state?.name ?? "?"}`,
    url: n.url ?? "",
    ts: new Date(n.updatedAt ?? Date.now()),
  }));
  const count = await upsertItems("linear", found, userId);
  await mergeMeta(userId, "linear", { last_item_at: new Date().toISOString() });
  return `${count} issue updates`;
}

/** Create a Linear issue. The destination half of `create_task`.
 *
 *  Team is not asked for: Linear requires one and the user did not name it in a meeting, so it takes
 *  the first team the key can see. A key scoped to one team, which is the normal case, has exactly
 *  one answer. Naming a team is an edit-sheet problem, not something to guess at from a transcript. */
export async function linearCreateIssue(
  userId: string,
  title: string,
  description: string,
): Promise<{ ok: boolean; detail: string; url?: string }> {
  const key = (await getCreds<{ api_key?: string }>(userId, "linear"))?.api_key;
  if (!key) return { ok: false, detail: "Linear is not connected" };
  const teams = await linearGql<{ teams: { nodes: Array<{ id: string; name: string }> } }>(
    key,
    `query { teams(first: 1) { nodes { id name } } }`,
  );
  const team = teams?.teams?.nodes?.[0];
  if (!team) return { ok: false, detail: "this Linear key can see no team" };
  const esc = (v: string) => JSON.stringify(v);
  const res = await linearGql<{ issueCreate: { success: boolean; issue: { identifier: string; url: string } } }>(
    key,
    `mutation { issueCreate(input: { teamId: ${esc(team.id)}, title: ${esc(title.slice(0, 250))}, description: ${esc(description || "")} }) {
      success issue { identifier url } } }`,
  );
  const issue = res?.issueCreate?.issue;
  if (!res?.issueCreate?.success || !issue) return { ok: false, detail: "Linear refused the issue" };
  return { ok: true, detail: `created ${issue.identifier} in ${team.name}`, url: issue.url };
}

/* ---------------- Asana ---------------- */

async function asanaFetch<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${ASANA}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (res.status === 401) throw new Error("Asana rejected the token");
  if (!res.ok) throw new Error(`asana ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export async function asanaTest(userId: string, keyOverride?: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const token = keyOverride || (await getCreds<{ api_key?: string }>(userId, "asana"))?.api_key;
    if (!token) return { ok: false, detail: "no personal access token saved" };
    const d = await asanaFetch<{ data?: { name?: string; workspaces?: Array<{ gid: string; name: string }> } }>(
      token,
      "/users/me?opt_fields=name,workspaces.name",
    );
    const ws = d?.data?.workspaces ?? [];
    if (!ws.length) return { ok: false, detail: "connected, but this token sees no workspace" };
    return { ok: true, detail: `connected as ${d?.data?.name ?? "you"} (${ws[0].name})` };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 160) };
  }
}

/** Create an Asana task, assigned to the user, in their workspace. */
export async function asanaCreateTask(
  userId: string,
  title: string,
  notes: string,
  due = "",
): Promise<{ ok: boolean; detail: string; url?: string }> {
  const token = (await getCreds<{ api_key?: string }>(userId, "asana"))?.api_key;
  if (!token) return { ok: false, detail: "Asana is not connected" };
  const meta = (await getMeta(userId, "asana")) ?? {};
  let workspace = String((meta as any).workspace ?? "");
  if (!workspace) {
    const me = await asanaFetch<{ data?: { workspaces?: Array<{ gid: string }> } }>(token, "/users/me?opt_fields=workspaces.name");
    workspace = me?.data?.workspaces?.[0]?.gid ?? "";
    if (!workspace) return { ok: false, detail: "this Asana token sees no workspace" };
    await mergeMeta(userId, "asana", { workspace });
  }
  const res = await fetch(`${ASANA}/tasks`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      data: {
        workspace,
        name: title.slice(0, 250),
        notes: notes || "",
        assignee: "me",
        // Asana rejects an empty string here, so the key is omitted entirely when there is no date.
        ...(/^\d{4}-\d{2}-\d{2}$/.test(due) ? { due_on: due } : {}),
      },
    }),
  });
  if (!res.ok) return { ok: false, detail: `Asana ${res.status}: ${(await res.text()).slice(0, 160)}` };
  const body: any = await res.json();
  return { ok: true, detail: "task created in Asana", url: body?.data?.permalink_url };
}

export async function pollAsana(userId: string): Promise<string> {
  if (!(await isConnected(userId, "asana"))) return "skipped: asana not connected";
  const token = (await getCreds<{ api_key?: string }>(userId, "asana"))?.api_key;
  if (!token) return "skipped: no asana api key";

  // Asana needs a workspace for an assignee query and will not infer one. Resolved once and kept
  // on the connection, because it never changes and re-asking every ten minutes is a wasted call.
  const meta = (await getMeta(userId, "asana")) ?? {};
  let workspace = String((meta as any).workspace ?? "");
  if (!workspace) {
    const me = await asanaFetch<{ data?: { workspaces?: Array<{ gid: string }> } }>(token, "/users/me?opt_fields=workspaces.name");
    workspace = me?.data?.workspaces?.[0]?.gid ?? "";
    if (!workspace) return "skipped: no asana workspace visible";
    await mergeMeta(userId, "asana", { workspace });
  }

  const d = await asanaFetch<{ data?: any[] }>(
    token,
    `/tasks?assignee=me&workspace=${encodeURIComponent(workspace)}&limit=${LIMIT}` +
      `&opt_fields=name,completed,modified_at,permalink_url`,
  );
  const found: RawItem[] = (d?.data ?? []).map((t: any) => ({
    connector: "asana",
    external_id: `${t.gid}@${t.modified_at ?? ""}`,
    kind: "asana_task",
    author: "",
    title: String(t.name ?? "").slice(0, 300),
    body_text: t.completed ? "state: completed" : "state: open",
    url: t.permalink_url ?? "",
    ts: new Date(t.modified_at ?? Date.now()),
  }));
  const count = await upsertItems("asana", found, userId);
  await mergeMeta(userId, "asana", { last_item_at: new Date().toISOString() });
  return `${count} task updates`;
}
