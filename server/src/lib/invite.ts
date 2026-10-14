/** Pure helpers for what a Google Calendar invite carries beyond the event's own time and title:
 *  the organiser's description and any files attached to it. Both are captured at SYNC time
 *  (connectors/gcal.ts) and read at BRIEF time (jobs/briefing.ts, connectors/drive.ts); this file
 *  holds only the parts that are pure functions, so they can be unit tested without a database.
 *  See invite.test.ts.
 *
 *  Runs on every calendar sync for every user, so nothing here may throw: a malformed or absent
 *  field degrades to an empty result rather than taking the whole poll down with it. */

/** How much of an invite's description survives into `meetings.description`. A real agenda is a
 *  paragraph or two; the cap exists so one pathological invite (a giant HTML signature block, a
 *  tracking-pixel footer) can never dominate a briefing prompt the way an unbounded field
 *  eventually would. */
export const MAX_DESCRIPTION_CHARS = 3000;

/** Attachments kept per meeting, in `meetings.attachments`. Google rarely puts more than one or
 *  two real documents on an invite; the cap is a backstop against whatever put a folder's worth
 *  on one. */
export const MAX_ATTACHMENTS = 5;

/** The handful of named entities that actually show up in calendar invite bodies. Not exhaustive:
 *  Calendar's own editor writes &amp; and &nbsp; constantly, and this is a plain-text field, not a
 *  rendered document, so anything rarer can afford to survive undecoded rather than be guessed at. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes &amp;-style and numeric (&#39; / &#x27;) character references. An unknown named entity
 *  is left exactly as written rather than guessed at or dropped: a wrong guess would corrupt real
 *  content, and an undecoded &foo; is still readable text. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const codepoint =
        code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(codepoint) ? String.fromCodePoint(codepoint) : whole;
    }
    const known = NAMED_ENTITIES[code.toLowerCase()];
    return known ?? whole;
  });
}

/** A line whose first run of characters is ALL CAPS (letters only; internal spaces/tabs allowed, so
 *  a multi-word label like "RECENT STREAM CONTEXT" counts as one run), at least 4 letters, with a
 *  colon somewhere on the line. The colon is not required immediately after the run: every real
 *  section header this guards against (prompts/briefing.v005.ts's RECENT STREAM CONTEXT, OPEN WORK,
 *  and the rest) is "LABEL (lowercase parenthetical aside): content", so requiring immediate
 *  adjacency would let the exact headers being impersonated slip past undefused. A short token like
 *  "Q3" (only 2 letters) or a merely-capitalised word like "Note" (one capital, then lowercase)
 *  never reaches the 4-letter floor and is left alone. */
function looksLikeHeader(line: string): { headerEnd: number } | null {
  const m = /^[ \t]*([A-Z][A-Z \t]*)/.exec(line);
  if (!m) return null;
  if (m[1].replace(/[ \t]/g, "").length < 4) return null;
  if (!line.includes(":")) return null;
  return { headerEnd: m[0].length };
}

/** Defuses header-shaped lines (see looksLikeHeader) so text from an untrusted source cannot
 *  impersonate one of this app's own ALL-CAPS prompt section labels and have a model treat what
 *  follows as a different, trusted section. THE CHOICE: lowercase only the matched leading run,
 *  nothing else. Every prompt section label this defends against is rendered by our OWN template
 *  code in full uppercase, verbatim and unconditionally (see briefingUser in briefing.v005.ts), so
 *  shouting caps at the start of a line is precisely the one signal a real header always has and
 *  ordinary prose does not. Removing only that signal, on only the matched prefix, means: the
 *  words, their order and every character survive untouched, so a genuine "AGENDA:" reads as
 *  "agenda:" -- still perfectly legible as an agenda line to a human or a model -- while no longer
 *  being byte-for-byte confusable with this app's own section headers. The line is never dropped;
 *  deleting attacker text is not this function's job, and a real agenda line must still survive.
 *  Runs on real newlines only (before the whitespace collapse below erases them), which is where
 *  this matters: the common shape of an attack is a plain-text, multi-paragraph description with
 *  the fake header on its own line, exactly like the real sections it is impersonating. */
export function defuseHeaderLines(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => {
      const hit = looksLikeHeader(line);
      if (!hit) return line;
      return line.slice(0, hit.headerEnd).toLowerCase() + line.slice(hit.headerEnd);
    })
    .join("\n");
}

/** Google Calendar's `description` is free-form and routinely HTML: Calendar's own editor writes
 *  <a>/<br>/<div> markup even for a one-line invite. Shoving that markup into a prompt wastes
 *  tokens and reads badly, so this strips it to plain text before anything is stored or sent to a
 *  model. Dependency-free by house style: no HTML parser, just tag removal, entity decoding and
 *  whitespace collapse, which is everything a calendar invite body ever needs.
 *
 *  Also defuses header-shaped lines (defuseHeaderLines) before the whitespace collapse below
 *  erases the newlines that make "a line" a meaningful unit. Every caller of this function is
 *  processing organiser-authored, untrusted text (indirect prompt
 *  injection is the threat); there is no trusted call site that would need this skipped.
 *
 *  Every tag (attributes included) is replaced with a single space, never with nothing, so
 *  "Budget</b> review" cannot glue into "Budgetreview"; the whitespace collapse below removes the
 *  doubling this introduces. script/style blocks are dropped by content as well as by tag, since
 *  their content is never prose.
 *
 *  A known, accepted limit of the regex-only approach: a tag attribute value that itself contains
 *  a literal ">" would end the match early. Real calendar invites do not do this, and a real parser
 *  would be a dependency for a case that has never shown up here.
 *
 *  Defensive on the input type as well as its content: this runs on every calendar sync for every
 *  user (connectors/gcal.ts), reading a field Google hands back as whatever it happens to be. */
export function stripHtmlToText(input: unknown, maxChars: number = MAX_DESCRIPTION_CHARS): string {
  if (typeof input !== "string" || !input) return "";
  const noScripts = input.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Anchors keep their href, as "text (url)". Everything else about this function throws markup
  // away, and that is right, but a link is not markup: the pre-read doc and the agenda are very
  // often the ONLY substance in an invite body, and "see the doc" with the URL stripped is a brief
  // telling the reader to look at something it has just made unfindable. Skipped when the text
  // already IS the url, which is what Calendar's editor produces when someone pastes a bare link,
  // so that case does not render the same address twice.
  const withLinks = noScripts.replace(
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (whole, href: string, inner: string) => {
      const text = decodeEntities(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      if (!text) return ` ${href} `;
      if (text === href) return ` ${text} `;
      return ` ${text} (${href}) `;
    },
  );
  const noTags = withLinks.replace(/<[^>]+>/g, " ");
  const decoded = decodeEntities(noTags);
  // Must run before the collapse below: real newlines from the original text are what make "a
  // line" a meaningful unit, and the collapse is about to flatten every one of them into a space.
  const defused = defuseHeaderLines(decoded);
  const collapsed = defused.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, Math.max(0, maxChars));
}

/** Our stored shape for one invite attachment. `url` is Google's `fileUrl`, renamed to match how
 *  this table already names its other stored links (schema.ts's `location`, `raw.htmlLink`). */
export interface MeetingAttachment {
  fileId: string;
  title: string;
  mimeType: string;
  url: string;
}

/** Maps Google Calendar's event.attachments shape ({fileId, fileUrl, title, mimeType, iconLink})
 *  to what this app stores. Caps at MAX_ATTACHMENTS and drops any entry with no fileId, since
 *  brief-time fetching (connectors/drive.ts) has nothing to fetch without one.
 *
 *  Defensive on every level: `input` may be anything (a field Google omits arrives as `undefined`;
 *  a hand-edited row could be anything at all), and one malformed entry must never take the rest
 *  of the same event's attachments down with it. Runs on every calendar sync for every user. */
export function mapAttachments(input: unknown): MeetingAttachment[] {
  if (!Array.isArray(input)) return [];
  const out: MeetingAttachment[] = [];
  for (const raw of input) {
    if (out.length >= MAX_ATTACHMENTS) break;
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const fileId = typeof a.fileId === "string" ? a.fileId : "";
    if (!fileId) continue;
    out.push({
      fileId,
      title: typeof a.title === "string" ? a.title : "",
      mimeType: typeof a.mimeType === "string" ? a.mimeType : "",
      url: typeof a.fileUrl === "string" ? a.fileUrl : "",
    });
  }
  return out;
}
