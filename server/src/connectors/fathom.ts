/** Fathom. REST, an API key created at developers.fathom.ai.
 *
 *  THE ONE NOTETAKER THAT PUBLISHES OAUTH for public apps, so it is the only one where a one-tap
 *  "Connect" button is actually reachable. It still needs an application registered with Fathom and
 *  a client id and secret, the same as Google and Slack, so it is a vendor-registration task rather
 *  than a code one, and it is not built. The key path below works without it; the Setup panel says
 *  so rather than leaving the question hanging.
 *
 *  Rate limit is 60 calls a minute per user across all their keys, which the bounded fetch in
 *  lib/notetaker.ts stays far under: one list call plus at most six bodies per ten-minute tick.
 */
import { getCreds, isConnected } from "../lib/connections";
import { pollNotetaker, sentencesToMarkdown, type NotetakerAdapter, type NotetakerMeeting } from "../lib/notetaker";

const BASE = "https://api.fathom.ai/external/v1";
const LIST_LIMIT = 25;

async function ff<T>(apiKey: string, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "X-Api-Key": apiKey, accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) throw new Error("fathom rejected the key");
  if (!res.ok) throw new Error(`fathom ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export async function fathomKey(userId: string): Promise<string | null> {
  const creds = (await getCreds<{ api_key?: string }>(userId, "fathom")) ?? {};
  return creds.api_key || null;
}

export async function fathomTest(userId: string, keyOverride?: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const key = keyOverride || (await fathomKey(userId));
    if (!key) return { ok: false, detail: "no API key saved" };
    // Listing one meeting is the lightest call that proves the key AND that it can see recordings,
    // which a bare identity endpoint would not.
    const data = await ff<{ items?: unknown[] }>(key, `/meetings?limit=1`);
    const n = (data?.items ?? []).length;
    return { ok: true, detail: n ? "connected, recordings visible" : "connected, no recordings yet" };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 160) };
  }
}

interface FathomMeeting {
  id?: string; recording_id?: string;
  title?: string; meeting_title?: string;
  started_at?: string; created_at?: string;
}

const adapter: NotetakerAdapter = {
  connector: "fathom",
  vendor: "fathom",
  async list(userId) {
    const key = await fathomKey(userId);
    if (!key) return [];
    const data = await ff<{ items?: FathomMeeting[] }>(key, `/meetings?limit=${LIST_LIMIT}`);
    return (data?.items ?? [])
      .map((m): NotetakerMeeting | null => {
        const id = String(m.id ?? m.recording_id ?? "");
        if (!id) return null;
        const at = new Date(String(m.started_at ?? m.created_at ?? Date.now()));
        return {
          id,
          title: String(m.title ?? m.meeting_title ?? "Fathom meeting"),
          at: isNaN(at.getTime()) ? new Date() : at,
        };
      })
      .filter((x): x is NotetakerMeeting => Boolean(x));
  },
  async fetchOne(userId, id) {
    const key = await fathomKey(userId);
    if (!key) return "";
    const data = await ff<{ transcript?: Array<{ speaker?: { display_name?: string } | string; text?: string }> }>(
      key,
      `/meetings/${encodeURIComponent(id)}/transcript`,
    );
    return sentencesToMarkdown(
      (data?.transcript ?? []).map((s) => ({
        // Fathom returns the speaker either as an object or a bare name depending on the endpoint
        // version; both shapes are handled rather than assuming one and silently losing attribution.
        speaker: typeof s.speaker === "string" ? s.speaker : s.speaker?.display_name,
        text: s.text,
      })),
    );
  },
};

export async function pollFathom(userId: string): Promise<string> {
  if (!(await isConnected(userId, "fathom"))) return "skipped: fathom not connected";
  if (!(await fathomKey(userId))) return "skipped: no fathom api key";
  return pollNotetaker(userId, adapter);
}
