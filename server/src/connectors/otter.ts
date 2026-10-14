/** Otter. REST, an API key from an Otter workspace.
 *
 *  ONE THING TO KNOW BEFORE ANYONE PROMISES THIS TO A USER: Otter's public API is an ENTERPRISE
 *  feature. A person on Otter's free, Pro or Business plan cannot obtain a key at all, so for most
 *  people this connector is unreachable no matter how correct the code is. That is a fact about
 *  Otter, not a limitation we can engineer around, and it belongs on the Setup panel rather than
 *  being discovered as a key that never works. Checked 2026-08-09.
 *
 *  It is still worth having: Otter is one of the three notetakers people actually use, and riding
 *  lib/notetaker.ts made it nearly free to add.
 *
 *  For everyone else there is a route that needs no key: Otter can export to Google Drive. The Drive
 *  poll (connectors/drive.ts) picks an export up only when it is a Google Doc whose name matches
 *  TRANSCRIPT_NAME there, and then it arrives on the path Gemini notes already use.
 */
import { getCreds, isConnected } from "../lib/connections";
import { pollNotetaker, sentencesToMarkdown, type NotetakerAdapter, type NotetakerMeeting } from "../lib/notetaker";

const BASE = "https://api.otter.ai/v1";
const LIST_LIMIT = 25;

async function ot<T>(apiKey: string, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    // The overwhelmingly likely cause, so say it rather than "HTTP 403".
    throw new Error("Otter rejected the key. The Otter API is an Enterprise-plan feature.");
  }
  if (!res.ok) throw new Error(`otter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export async function otterKey(userId: string): Promise<string | null> {
  const creds = (await getCreds<{ api_key?: string }>(userId, "otter")) ?? {};
  return creds.api_key || null;
}

export async function otterTest(userId: string, keyOverride?: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const key = keyOverride || (await otterKey(userId));
    if (!key) return { ok: false, detail: "no API key saved" };
    const data = await ot<{ conversations?: unknown[] }>(key, `/conversations?page_size=1`);
    const n = (data?.conversations ?? []).length;
    return { ok: true, detail: n ? "connected, conversations visible" : "connected, no conversations yet" };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 200) };
  }
}

interface OtterConversation {
  id?: string; speech_id?: string;
  title?: string;
  created_at?: string | number; start_time?: string | number;
}

const adapter: NotetakerAdapter = {
  connector: "otter",
  vendor: "otter",
  async list(userId) {
    const key = await otterKey(userId);
    if (!key) return [];
    const data = await ot<{ conversations?: OtterConversation[] }>(key, `/conversations?page_size=${LIST_LIMIT}`);
    return (data?.conversations ?? [])
      .map((c): NotetakerMeeting | null => {
        const id = String(c.id ?? c.speech_id ?? "");
        if (!id) return null;
        const raw = c.start_time ?? c.created_at ?? Date.now();
        // Otter returns seconds in some responses and ISO strings in others. A bare number under
        // 10^12 is seconds, not milliseconds; treating it as ms would date every meeting to 1970
        // and linkMeeting would match none of them.
        const at =
          typeof raw === "number"
            ? new Date(raw < 1e12 ? raw * 1000 : raw)
            : new Date(String(raw));
        return { id, title: String(c.title ?? "Otter conversation"), at: isNaN(at.getTime()) ? new Date() : at };
      })
      .filter((x): x is NotetakerMeeting => Boolean(x));
  },
  async fetchOne(userId, id) {
    const key = await otterKey(userId);
    if (!key) return "";
    const data = await ot<{ transcripts?: Array<{ speaker?: string; speaker_name?: string; transcript?: string; text?: string }> }>(
      key,
      `/conversations/${encodeURIComponent(id)}/transcript`,
    );
    return sentencesToMarkdown(
      (data?.transcripts ?? []).map((s) => ({
        speaker: s.speaker_name ?? s.speaker,
        text: s.transcript ?? s.text,
      })),
    );
  },
};

export async function pollOtter(userId: string): Promise<string> {
  if (!(await isConnected(userId, "otter"))) return "skipped: otter not connected";
  if (!(await otterKey(userId))) return "skipped: no otter api key";
  return pollNotetaker(userId, adapter);
}
