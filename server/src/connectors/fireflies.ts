/** Fireflies. GraphQL, one bearer key the user creates in their own Fireflies settings.
 *
 *  Everything shared with the other notetakers (meeting matching, dedupe, writing the row) lives in
 *  lib/notetaker.ts. This file is only "how do you ask Fireflies for a transcript".
 *
 *  WHY A KEY AND NOT A CONNECT BUTTON: a Connect button means OAuth, and OAuth means an application
 *  registered with the vendor and a client id and secret, the way Google and Slack work here
 *  (GOOGLE_CLIENT_ID and SLACK_CLIENT_ID in server/.env). Fireflies authenticates third parties with a personal API key; there is no
 *  third-party OAuth to point a button at. Of the three notetakers only Fathom publishes OAuth for
 *  public apps, and taking it still means registering with them first. See connectors/fathom.ts.
 */
import { getCreds, isConnected } from "../lib/connections";
import { pollNotetaker, sentencesToMarkdown, type NotetakerAdapter, type NotetakerMeeting } from "../lib/notetaker";

const ENDPOINT = "https://api.fireflies.ai/graphql";
const LIST_LIMIT = 25;

async function gql<T>(apiKey: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`fireflies ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body: any = await res.json();
  // GraphQL answers 200 with an errors array, so res.ok alone is not success and trusting it would
  // read an error payload as an empty meeting list.
  if (body?.errors?.length) throw new Error(`fireflies: ${String(body.errors[0]?.message).slice(0, 160)}`);
  return body?.data as T;
}

export async function firefliesKey(userId: string): Promise<string | null> {
  const creds = (await getCreds<{ api_key?: string }>(userId, "fireflies")) ?? {};
  return creds.api_key || null;
}

export async function firefliesTest(userId: string, keyOverride?: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const key = keyOverride || (await firefliesKey(userId));
    if (!key) return { ok: false, detail: "no API key saved" };
    const data = await gql<{ user: { name?: string; email?: string } }>(key, `query { user { name email } }`);
    const who = data?.user?.name || data?.user?.email;
    return { ok: true, detail: who ? `connected as ${who}` : "connected" };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 160) };
  }
}

const adapter: NotetakerAdapter = {
  connector: "fireflies",
  vendor: "fireflies",
  async list(userId) {
    const key = await firefliesKey(userId);
    if (!key) return [];
    const data = await gql<{ transcripts: Array<{ id: string; title?: string; date?: number | string }> }>(
      key,
      `query Recent($limit: Int) { transcripts(limit: $limit) { id title date } }`,
      { limit: LIST_LIMIT },
    );
    return (data?.transcripts ?? []).map((t): NotetakerMeeting => {
      const raw = t.date ?? Date.now();
      const at = new Date(typeof raw === "number" ? raw : String(raw));
      return { id: t.id, title: String(t.title ?? "Fireflies meeting"), at: isNaN(at.getTime()) ? new Date() : at };
    });
  },
  async fetchOne(userId, id) {
    const key = await firefliesKey(userId);
    if (!key) return "";
    const data = await gql<{ transcript: { sentences?: Array<{ speaker_name?: string; text?: string }> } }>(
      key,
      `query One($id: String!) { transcript(id: $id) { id sentences { speaker_name text } } }`,
      { id },
    );
    return sentencesToMarkdown((data?.transcript?.sentences ?? []).map((s) => ({ speaker: s.speaker_name, text: s.text })));
  },
};

export async function pollFireflies(userId: string): Promise<string> {
  if (!(await isConnected(userId, "fireflies"))) return "skipped: fireflies not connected";
  if (!(await firefliesKey(userId))) return "skipped: no fireflies api key";
  return pollNotetaker(userId, adapter);
}
