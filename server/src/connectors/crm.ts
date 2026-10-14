/** HubSpot and Salesforce: the two CRM destinations behind `create_crm_note`.
 *
 *  They are one file because they answer exactly two questions each ("who is this person" and "log
 *  a note against them") and the card does not care which one is connected. Keeping them apart
 *  would mean two copies of the resolve-then-write shape, and the second copy is where they drift.
 *
 *  WHY A NOTE AND NOT A DEAL UPDATE. A note is additive and reversible, and it is the thing people
 *  actually promise out loud ("I'll log this", "I'll write it up in HubSpot"). Moving a deal stage
 *  or editing an amount from something said in a meeting is a different risk class: it changes a
 *  number someone else reports on. Not in this type, deliberately.
 *
 *  THE RESOLVE STEP IS THE WHOLE RISK. The model reads "log it against Dana" and we have to decide
 *  which record that is. Writing a note onto the WRONG contact is the mistake here that a user
 *  cannot see and cannot undo, so an ambiguous match blocks rather than guesses. That is the same
 *  stance shareFile in connectors/docs.ts takes on file names.
 */
import { getCreds, isConnected, type ConnectorId } from "../lib/connections";
import { isAllowedSalesforceHost } from "./salesforceHost";

export type CrmId = "hubspot" | "salesforce";

export interface CrmResult {
  ok: boolean;
  detail: string;
  url?: string;
}

/* ---------------- HubSpot ---------------- */

const HS = "https://api.hubapi.com";

async function hsFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${HS}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export async function hubspotTest(userId: string, keyOverride?: string): Promise<{ ok: boolean; detail: string }> {
  const token = keyOverride || (await getCreds<{ api_key?: string }>(userId, "hubspot"))?.api_key;
  if (!token) return { ok: false, detail: "no private app token saved" };
  try {
    const res = await hsFetch(token, "/crm/v3/objects/contacts?limit=1");
    if (res.status === 401) return { ok: false, detail: "HubSpot rejected the token" };
    if (res.status === 403) {
      return { ok: false, detail: "token is missing a scope. It needs crm.objects.contacts.read/write and crm.objects.notes.write" };
    }
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, detail: "connected" };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 160) };
  }
}

/** Find one contact by email, or by name if it does not look like an email. */
async function hubspotFindContact(token: string, who: string): Promise<{ id: string; label: string } | null | "ambiguous"> {
  const isEmail = who.includes("@");
  const body = {
    filterGroups: [
      {
        filters: [
          isEmail
            ? { propertyName: "email", operator: "EQ", value: who }
            : { propertyName: "firstname", operator: "CONTAINS_TOKEN", value: who.split(/\s+/)[0] },
        ],
      },
    ],
    properties: ["email", "firstname", "lastname"],
    limit: 5,
  };
  const res = await hsFetch(token, "/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`hubspot search ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data: any = await res.json();
  const results: any[] = data?.results ?? [];
  if (!results.length) return null;
  // An email is unique enough to act on. A first name is not, and two Danas is exactly when a note
  // lands on the wrong person, so it blocks and says so.
  if (!isEmail && results.length > 1) return "ambiguous";
  const r = results[0];
  const label = [r.properties?.firstname, r.properties?.lastname].filter(Boolean).join(" ") || r.properties?.email || r.id;
  return { id: String(r.id), label };
}

async function hubspotNote(userId: string, contact: string, note: string): Promise<CrmResult> {
  const token = (await getCreds<{ api_key?: string }>(userId, "hubspot"))?.api_key;
  if (!token) return { ok: false, detail: "HubSpot is not connected" };
  const found = await hubspotFindContact(token, contact);
  if (found === null) return { ok: false, detail: `no HubSpot contact matches "${contact}"` };
  if (found === "ambiguous") return { ok: false, detail: `"${contact}" matches more than one HubSpot contact, so nothing was written` };
  const res = await hsFetch(token, "/crm/v3/objects/notes", {
    method: "POST",
    body: JSON.stringify({
      properties: { hs_note_body: note, hs_timestamp: new Date().toISOString() },
      associations: [
        // 202 is the HubSpot association type id for note -> contact.
        { to: { id: found.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`hubspot note ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const created: any = await res.json();
  return {
    ok: true,
    detail: `note logged against ${found.label}`,
    url: `https://app.hubspot.com/contacts/objects/0-1/${found.id}`,
    ...(created?.id ? {} : {}),
  };
}

/* ---------------- Salesforce ----------------
 *  Salesforce has no personal API key. Real production access is a Connected App and an OAuth
 *  refresh flow, which is a registration task with Salesforce before it is a code one. What works
 *  today without that is an instance URL plus a session/access token the user pastes, which is
 *  genuinely useful for a small team and genuinely expires. The Setup panel says so rather than letting
 *  someone discover it when a note silently stops being written. */

interface SfCreds { instance_url?: string; access_token?: string }

async function sfFetch(c: Required<SfCreds>, path: string, init: RequestInit = {}): Promise<Response> {
  // Redirects are NOT followed. The host guard only checks the typed instance, and a redirect would
  // otherwise walk past it. A 3xx comes back as a failed status, which every caller already treats
  // as a failure.
  return fetch(`${c.instance_url.replace(/\/+$/, "")}${path}`, {
    ...init,
    redirect: "manual",
    headers: {
      authorization: `Bearer ${c.access_token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

// The SSRF guard for `instance_url`. It lives in salesforceHost.ts, which imports nothing, so its
// test runs without opening the database. Re-exported so existing imports from this file still work.
export { isAllowedSalesforceHost };

async function sfCreds(userId: string, override?: SfCreds): Promise<Required<SfCreds> | null> {
  const stored = override ?? (await getCreds<SfCreds>(userId, "salesforce")) ?? {};
  const raw = String(stored.instance_url ?? "").trim();
  const access_token = String(stored.access_token ?? "").trim();
  if (!raw || !access_token) return null;
  if (!isAllowedSalesforceHost(raw)) return null;
  // Rebuilt from the parsed URL rather than string-concatenated, so a path, query or credentials
  // smuggled into the field ("https://x.salesforce.com@evil.test") cannot survive into the fetch.
  const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  return { instance_url: `https://${u.host}`, access_token };
}

export async function salesforceTest(userId: string, override?: SfCreds): Promise<{ ok: boolean; detail: string }> {
  // The rejection reason is split out so a blocked host does not read as a missing field, which
  // would send someone re-typing a token that was never the problem.
  const raw = String(override?.instance_url ?? "").trim();
  if (raw && !isAllowedSalesforceHost(raw)) {
    return { ok: false, detail: "that is not a Salesforce address. It must be an https host under salesforce.com or force.com" };
  }
  const c = await sfCreds(userId, override);
  if (!c) return { ok: false, detail: "instance URL and access token are both required" };
  try {
    const res = await sfFetch(c, "/services/data/v60.0/sobjects/Contact/describe");
    if (res.status === 401) return { ok: false, detail: "Salesforce rejected the token. Session tokens expire; a Connected App is the durable path" };
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, detail: "connected" };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 160) };
  }
}

/** SOQL is string-built here, so anything interpolated is escaped for the quoted-literal context.
 *  A contact name arrives from a transcript, which is untrusted text by definition. */
function soqlEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function salesforceNote(userId: string, contact: string, note: string): Promise<CrmResult> {
  const c = await sfCreds(userId);
  if (!c) return { ok: false, detail: "Salesforce is not connected" };
  const isEmail = contact.includes("@");
  const where = isEmail ? `Email = '${soqlEscape(contact)}'` : `Name LIKE '%${soqlEscape(contact)}%'`;
  const q = encodeURIComponent(`SELECT Id, Name FROM Contact WHERE ${where} LIMIT 5`);
  const res = await sfFetch(c, `/services/data/v60.0/query?q=${q}`);
  if (!res.ok) throw new Error(`salesforce query ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data: any = await res.json();
  const records: any[] = data?.records ?? [];
  if (!records.length) return { ok: false, detail: `no Salesforce contact matches "${contact}"` };
  if (!isEmail && records.length > 1) {
    return { ok: false, detail: `"${contact}" matches more than one Salesforce contact, so nothing was written` };
  }
  const target = records[0];
  const mk = await sfFetch(c, "/services/data/v60.0/sobjects/Note", {
    method: "POST",
    body: JSON.stringify({ Title: note.slice(0, 80), Body: note, ParentId: target.Id }),
  });
  if (!mk.ok) throw new Error(`salesforce note ${mk.status}: ${(await mk.text()).slice(0, 200)}`);
  const created: any = await mk.json();
  return {
    ok: true,
    detail: `note logged against ${target.Name}`,
    url: created?.id ? `${c.instance_url}/${created.id}` : undefined,
  };
}

/* ---------------- what the executor calls ---------------- */

/** Which CRM is this user actually on? HubSpot first only because it is the one a user is
 *  likelier to hold; if both are connected the note goes to HubSpot and says so. */
export async function activeCrm(userId: string): Promise<CrmId | null> {
  if (await isConnected(userId, "hubspot")) return "hubspot";
  if (await isConnected(userId, "salesforce")) return "salesforce";
  return null;
}

export async function crmNote(userId: string, contact: string, note: string): Promise<CrmResult> {
  const which = await activeCrm(userId);
  if (!which) return { ok: false, detail: "No CRM is connected" };
  return which === "hubspot" ? hubspotNote(userId, contact, note) : salesforceNote(userId, contact, note);
}

export const CRM_CONNECTORS: ConnectorId[] = ["hubspot", "salesforce"];
