import { env } from "../env";
import { OWNER } from "../db";
import { getCreds, isConnected } from "../lib/connections";
import { upsertItems, type RawItem } from "./normalize";

interface JiraCreds {
  email?: string;
  api_token?: string;
  site?: string;
}

export async function jiraCreds(userId: string = OWNER): Promise<Required<JiraCreds> | null> {
  const stored = (await getCreds<JiraCreds>(userId, "jira")) ?? {};
  // The env fallback is for the local owner only. Applied to every user it would be a cross-tenant
  // hazard: a user whose stored credentials cannot be read (getCreds returns null, for example after
  // ENCRYPTION_KEY changed) would act with the instance owner's Jira credentials, in the owner's
  // Jira site.
  const envOk = userId === OWNER;
  const email = stored.email || (envOk ? env.JIRA_EMAIL : "");
  const api_token = stored.api_token || (envOk ? env.JIRA_API_TOKEN : "");
  const site = (stored.site || (envOk ? env.JIRA_SITE : "") || "").replace(/^https?:\/\//, "");
  if (!email || !api_token || !site) return null;
  return { email, api_token, site };
}

/** Is this a host we are willing to send an Atlassian request to?
 *
 *  `site` is typed by the user and interpolated into a fetch URL, so without this it is an SSRF:
 *  point it at an internal address and the SERVER makes the request. Narrower than the Salesforce
 *  guard on purpose. Salesforce Cloud is always under salesforce.com, so an allowlist costs nobody
 *  anything; Atlassian has self-hosted Server and Data Center installs on genuinely arbitrary
 *  company domains, so an allowlist there would lock out real customers.
 *
 *  So this blocks the shapes that are never a legitimate Atlassian site rather than allowing a list
 *  of ones that are: literal IP addresses (which is how you reach a metadata endpoint or a
 *  neighbour on the network) and loopback-ish names. Plain http is already impossible because the
 *  URL below hardcodes https and jiraFetch does not follow redirects, which rules out the metadata
 *  services that matter most.
 *
 *  Honest about what it does not stop: a hostname in public DNS that resolves to a private address.
 *  Closing that needs resolve-then-pin, which is a bigger change than this is worth today. */
export function isAllowedAtlassianHost(site: string): boolean {
  const host = String(site ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
  if (!host || host.includes("@")) return false;
  // Any bare IPv4, and the bracketed or colon-bearing forms of IPv6.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host.includes(":") || host.startsWith("[")) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return false;
  // A hostname with no dot is a bare machine name on the local network, never a public site.
  if (!host.includes(".")) return false;
  return true;
}

export async function jiraFetch(userId: string = OWNER, path: string, init: RequestInit = {}): Promise<Response> {
  const c = await jiraCreds(userId);
  if (!c) throw new Error("jira not configured");
  if (!isAllowedAtlassianHost(c.site)) throw new Error("that Atlassian site address is not allowed");
  const auth = Buffer.from(`${c.email}:${c.api_token}`).toString("base64");
  // Redirects are NOT followed. The host guard above only checks the typed site, and a public host
  // that answers with a redirect to an internal address would otherwise walk straight past it. A
  // redirect comes back as a 3xx response, which every caller already treats as a failed status.
  return fetch(`https://${c.site}${path}`, {
    ...init,
    redirect: "manual",
    headers: {
      authorization: `Basic ${auth}`,
      accept: "application/json",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export async function jiraTest(userId: string = OWNER): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await jiraFetch(userId, "/rest/api/3/myself");
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const me: any = await res.json();
    return { ok: true, detail: `connected as ${me.displayName ?? me.emailAddress}` };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

/** Poll issues touching the user, updated in the last 20 minutes. Scoped to the polled user
 *  throughout. */
export async function pollJira(userId: string): Promise<string> {
  if (!(await isConnected(userId, "jira"))) return "skipped: jira not connected";
  const c = await jiraCreds(userId);
  if (!c) return "skipped: jira creds missing";

  const res = await jiraFetch(userId, "/rest/api/3/search/jql", {
    method: "POST",
    body: JSON.stringify({
      jql: "updated >= '-20m' AND (assignee = currentUser() OR reporter = currentUser()) ORDER BY updated DESC",
      fields: ["summary", "status", "assignee", "priority", "updated"],
      maxResults: 25,
    }),
  });
  if (!res.ok) throw new Error(`jira search ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();

  const found: RawItem[] = (data.issues ?? []).map((issue: any) => ({
    connector: "jira",
    external_id: `${issue.key}@${issue.fields?.updated ?? ""}`,
    kind: "jira_update",
    author: issue.fields?.assignee?.displayName ?? "",
    title: `${issue.key} ${issue.fields?.summary ?? ""}`.trim(),
    body_text: `status: ${issue.fields?.status?.name ?? "?"} · priority: ${issue.fields?.priority?.name ?? "?"}`,
    url: `https://${c.site}/browse/${issue.key}`,
    ts: new Date(issue.fields?.updated ?? Date.now()),
  }));
  const n = await upsertItems("jira", found, userId);
  return `${n} issue updates`;
}
