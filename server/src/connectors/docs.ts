/** Writing to the user's Drive: the destinations behind `create_document` and `share_file`.
 *
 *  WHY THESE TWO TYPES EXIST. An action type only executes when the user has its destination
 *  connected. Calendar works for anyone who connected Google, while a tracker like Jira works only
 *  for people who connect one. Drive comes with the same Google connection, which makes it a place
 *  a new action type can land and work on day one.
 *
 *  THE SCOPE, AND ITS LIMIT, because this decides what the two types can honestly promise:
 *
 *  `drive.file` is what Haii asks for. It is NOT a restricted scope, so it adds nothing to Google's
 *  security assessment (CASA) for verification, and it grants access only to files this app
 *  created. That is the whole safety story: Haii can write you a document and manage the documents
 *  it wrote, and it cannot read or touch anything else in your Drive.
 *
 *  The consequence, stated plainly rather than discovered later: `share_file` can only share files
 *  HAII CREATED. Sharing a pre-existing file, which is what people actually ask for (copy the
 *  proposal template, move it, add editors, send the link), needs the full `drive` scope. That one
 *  IS restricted and brings an annual security assessment with it. That is a choice to make
 *  deliberately, not a thing to quietly take. shareFile says so when a file is out of reach instead
 *  of failing vaguely.
 */
import { gFetch, googleReady } from "./google";
import { isConnected } from "../lib/connections";

const DRIVE = "https://www.googleapis.com/drive/v3";
const DOCS = "https://docs.googleapis.com/v1";

export interface DocResult {
  ok: boolean;
  detail: string;
  url?: string;
}

async function ready(userId: string): Promise<string | null> {
  if (!(await isConnected(userId, "google"))) return "Google is not connected";
  if (!(await googleReady(userId))) return "Google is not fully configured";
  return null;
}

/** Create a Google Doc with the given text, and optionally share it in the same action.
 *
 *  One card, one gesture, one outcome. "Send Dana the pricing" is one promise; splitting it into
 *  "write a doc" and then "share the doc" would make the user nod twice for something they said
 *  once, and the second nod would arrive with no memory of the first.
 *
 *  Sharing is best-effort AFTER the document exists. If the doc is created and a share fails, the
 *  document is real and the result says who did not get it: that is an honest partial outcome, and
 *  it is strictly better than throwing away a document the user asked for. */
export async function createDocument(
  userId: string,
  title: string,
  content: string,
  shareWith = "",
): Promise<DocResult> {
  const blocked = await ready(userId);
  if (blocked) return { ok: false, detail: blocked };

  const mk = await gFetch(userId, `${DOCS}/documents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: title.slice(0, 300) }),
  });
  if (!mk.ok) {
    const body = (await mk.text()).slice(0, 300);
    // 403 here is almost always the scope, and saying "HTTP 403" teaches the user nothing.
    if (mk.status === 403) return { ok: false, detail: "Haii cannot write to your Drive yet. Reconnect Google to grant it." };
    throw new Error(`docs create ${mk.status}: ${body}`);
  }
  const doc: any = await mk.json();
  const docId = String(doc?.documentId ?? "");
  if (!docId) throw new Error("docs create returned no documentId");

  if (content.trim()) {
    // Index 1 is the first writable position in a new document; 0 is the body start marker itself
    // and inserting there is rejected.
    const put = await gFetch(userId, `${DOCS}/documents/${docId}:batchUpdate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: content } }] }),
    });
    if (!put.ok) throw new Error(`docs write ${put.status}: ${(await put.text()).slice(0, 200)}`);
  }

  const url = `https://docs.google.com/document/d/${docId}/edit`;
  const emails = splitEmails(shareWith);
  if (!emails.length) return { ok: true, detail: `created "${title}"`, url };

  const shared = await sharePermissions(userId, docId, emails, "writer");
  return {
    ok: true,
    detail: shared.failed.length
      ? `created "${title}", shared with ${shared.ok.length}, could not share with ${shared.failed.join(", ")}`
      : `created "${title}" and shared with ${shared.ok.join(", ")}`,
    url,
  };
}

/** Share a file Haii created, found by name. */
export async function shareFile(
  userId: string,
  fileName: string,
  emails: string,
  role = "reader",
): Promise<DocResult> {
  const blocked = await ready(userId);
  if (blocked) return { ok: false, detail: blocked };
  const people = splitEmails(emails);
  if (!people.length) return { ok: false, detail: "no email addresses to share with" };

  // Name search, because the model read "the proposal template" in a transcript and not a file id.
  // Drive's `contains` is prefix matching per word, so this narrows and JS decides (the same trap
  // documented in CLAUDE.md for "Notes by Gemini").
  const q = encodeURIComponent(`name contains '${fileName.replace(/'/g, "\\'")}' and trashed = false`);
  const res = await gFetch(userId, `${DRIVE}/files?q=${q}&fields=files(id,name)&pageSize=10`);
  if (!res.ok) throw new Error(`drive search ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  const files: Array<{ id: string; name: string }> = data?.files ?? [];
  const wanted = fileName.trim().toLowerCase();
  const exact = files.filter((f) => String(f.name).toLowerCase() === wanted);
  const pool = exact.length ? exact : files;

  if (!pool.length) {
    return {
      ok: false,
      detail: `Haii cannot find a file called "${fileName}" that it has access to. It can only share files it created.`,
    };
  }
  // HANDING THE WRONG FILE TO SOMEONE CANNOT BE UNDONE by the person who did it, so an ambiguous
  // match refuses. This is the one place in the executor where guessing is worse than stopping.
  if (pool.length > 1) {
    return { ok: false, detail: `"${fileName}" matches ${pool.length} files, so nothing was shared` };
  }

  const target = pool[0];
  const safeRole = ["reader", "commenter", "writer"].includes(role) ? role : "reader";
  const shared = await sharePermissions(userId, target.id, people, safeRole);
  if (!shared.ok.length) {
    return { ok: false, detail: `could not share "${target.name}" with ${shared.failed.join(", ")}` };
  }
  return {
    ok: true,
    detail: shared.failed.length
      ? `shared "${target.name}" with ${shared.ok.join(", ")}, failed for ${shared.failed.join(", ")}`
      : `shared "${target.name}" with ${shared.ok.join(", ")}`,
    url: `https://drive.google.com/file/d/${target.id}/view`,
  };
}

function splitEmails(raw: string): string[] {
  return String(raw ?? "")
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter((e) => e.includes("@"))
    .slice(0, 20);
}

/** Grant each person access. Per-person rather than all-or-nothing: one bad address should not
 *  deny the document to everyone else who was named. */
async function sharePermissions(
  userId: string,
  fileId: string,
  emails: string[],
  role: string,
): Promise<{ ok: string[]; failed: string[] }> {
  const okList: string[] = [];
  const failed: string[] = [];
  for (const email of emails) {
    try {
      const res = await gFetch(userId, `${DRIVE}/files/${fileId}/permissions?sendNotificationEmail=true`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "user", role, emailAddress: email }),
      });
      if (res.ok) okList.push(email);
      else failed.push(email);
    } catch {
      failed.push(email);
    }
  }
  return { ok: okList, failed };
}
