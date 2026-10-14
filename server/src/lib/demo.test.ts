/** Tests for the demo week (server/public/demo.js).
 *
 *  The demo runs the real interface on fictional data, and the one thing it must never do is
 *  demonstrate the opposite of the product. So the rule the real extractor is held to is enforced
 *  here by construction: every quote on a card, and every quote on a follow-up, has to appear
 *  VERBATIM in one of the demo's own transcripts. A plausible sentence in quotation marks looks
 *  exactly like a real one on screen, which is why this is a test and not a habit.
 *
 *  It also walks every API path the client actually calls, read out of index.html rather than
 *  copied here, so a path the demo cannot answer without throwing fails the build.
 *  `npm test -w @haii/server`
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const source = readFileSync(join(PUBLIC, "demo.js"), "utf8");
const client = readFileSync(join(PUBLIC, "index.html"), "utf8");

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, String(got) === String(want), `got ${got}, want ${want}`);

type Line = [string, string];
type Demo = {
  transcripts: Record<string, { title: string; content_md: string; lines: Line[] }>;
  cards: Array<{
    id: string; title: string; status: string; actionType: string; transcriptId: string; payload: Record<string, any>;
    context: { why: Array<{ text: string }>; scheduling?: { proposed?: unknown; verified?: unknown } };
  }>;
  todos: Array<{ id: string; title: string; card_id: string | null; quote: { text: string } | null }>;
  receipts: Record<string, string>;
  route: (method: string, path: string, query: URLSearchParams, body: Record<string, unknown>) => { status: number; json: any };
};

/** Load demo.js the way a browser would, into a window that has nothing but what it needs. */
function boot(search: string, document?: unknown): { demo: Demo | undefined; fetchReplaced: boolean } {
  const win: Record<string, unknown> = { location: { search, href: "http://localhost:4820/" + search }, document };
  const before = win.fetch;
  vm.runInNewContext(source, { window: win, URL, URLSearchParams, Response, Promise, JSON, Date, Intl, setTimeout, clearTimeout });
  return { demo: win.__HAII_DEMO as Demo | undefined, fetchReplaced: win.fetch !== before };
}

console.log("\n--- off unless asked for ---");
const off = boot("");
check("without ?demo it does nothing at all", off.demo === undefined && !off.fetchReplaced);
check("a look-alike parameter does not switch it on", boot("?demonstration=1").demo === undefined);
const { demo, fetchReplaced } = boot("?demo");
check("?demo switches it on", demo !== undefined && fetchReplaced);
if (!demo) {
  console.log("\n1 FAILED");
  process.exit(1);
}
const all = Object.values(demo.transcripts).map((t) => t.content_md).join("\n\n");

console.log("\n--- every quote is verbatim, in the transcript the card points at ---");
for (const c of demo.cards) {
  const t = demo.transcripts[c.transcriptId];
  check(`${c.id} points at a transcript that exists`, Boolean(t));
  check(`${c.id} carries at least one quote`, c.context.why.length >= 1);
  for (const w of c.context.why) {
    check(`${c.id}: "${w.text.slice(0, 44)}..." is in its own transcript`, Boolean(t) && t.content_md.includes(w.text));
  }
}
for (const t of demo.todos) {
  check(`${t.id}: its quote is somewhere in the demo transcripts`, t.quote !== null && all.includes(t.quote.text));
}

console.log("\n--- quotes belong to the user, because only their promises become cards ---");
for (const c of demo.cards) {
  const t = demo.transcripts[c.transcriptId];
  const mine = t.lines.filter(([who]) => who === "Alex").map(([, said]) => said).join("\n");
  check(`${c.id} quotes something Alex said`, c.context.why.every((w) => mine.includes(w.text)));
}

console.log("\n--- a calendar card books only a day and an hour someone said ---");
// The client tells the user the time was taken from the meeting unless the card says Haii proposed
// or checked it, so for every other calendar card the meeting has to have named both.
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HOURS = ["twelve", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven"];
for (const c of demo.cards.filter((x) => x.actionType === "create_calendar_event")) {
  const sc = c.context.scheduling ?? {};
  if (sc.proposed || sc.verified) continue;
  const said = demo.transcripts[c.transcriptId].content_md;
  const day = DAYS[new Date(`${c.payload.date}T12:00:00`).getDay()];
  const time = String(c.payload.time);
  const hour = HOURS[Number(time.slice(0, 2)) % 12];
  check(`${c.id}: ${day} was said in the meeting`, said.includes(day));
  check(`${c.id}: ${time} was said in the meeting, as "at ${hour}"`, time.endsWith(":00") && new RegExp(`\\bat ${hour}\\b`).test(said));
}

console.log("\n--- a promise is in one state, not two ---");
for (const t of demo.todos) {
  const same = demo.cards.filter((c) => t.quote !== null && c.context.why.some((w) => w.text === t.quote?.text));
  check(`${t.id}: no dismissed card holds the same promise`, same.every((c) => c.status !== "dismissed"));
  check(`${t.id}: a to-do card for the same promise is the card it points at`,
    same.filter((c) => c.actionType === "create_todo").every((c) => c.id === t.card_id));
  if (t.card_id) {
    const c = demo.cards.find((x) => x.id === t.card_id);
    check(`${t.id}: the card behind it was approved and saved it`, Boolean(c) && c?.actionType === "create_todo" && c?.status === "executed");
  }
}

console.log("\n--- the feed has the shape the client reads ---");
const q = new URLSearchParams();
const feed = demo.route("GET", "/api/v1/feed", q, {}).json;
for (const key of ["failures", "user", "today_meetings", "next_meeting", "cards", "digest", "connections", "undo_grace_ms", "onboarding"]) {
  check(`feed.${key}`, key in feed);
}
eq("first run is skipped in the demo", feed.onboarding, "done");
eq("and nobody is asked for a name", feed.user.needs_name, false);
check("the deck opens with cards to decide", feed.cards.length >= 5);
check("there is a next meeting with a brief", Boolean(feed.next_meeting && feed.next_meeting.briefing && feed.next_meeting.briefing.content.tldr));
eq("health says demo, so the header can", demo.route("GET", "/healthz", q, {}).json.mode, "demo");

console.log("\n--- the deck offers only what Setup shows as connected ---");
// The connector each card needs, as BLOCKED_CONNECTOR and TASK_CONNECTOR in api/routes.ts name it.
// A CRM note can use either CRM, a create_task card names its tracker in the payload, and a to-do
// or a text needs none. A card the demo deals that a real install would block is a demo that lies.
const NEEDS: Record<string, string[]> = {
  create_jira_issue: ["jira"], send_slack_message: ["slack"], create_calendar_event: ["google"],
  send_email: ["google"], create_document: ["google"], share_file: ["google"], create_crm_note: ["hubspot", "salesforce"],
};
type Conn = { id: string; status: string };
const setupConns = demo.route("GET", "/api/v1/connections", q, {}).json.connections as Conn[];
const up = (list: Conn[], ids: string[]) => list.some((x) => ids.includes(x.id) && x.status === "connected");
for (const c of feed.cards as Demo["cards"]) {
  const needs = c.actionType === "create_task" ? [String(c.payload.destination ?? "").toLowerCase()] : NEEDS[c.actionType];
  if (!needs) continue;
  check(`${c.id}: ${needs.join(" or ")} is connected in Setup`, up(setupConns, needs));
  check(`${c.id}: ${needs.join(" or ")} is connected in the feed`, up(feed.connections as Conn[], needs));
}

console.log("\n--- a decision moves the way the real one does ---");
const first = feed.cards[0].id as string;
const dec = `/api/v1/cards/${first}/decision`;
eq("approve is accepted", demo.route("POST", dec, q, { decision: "approved", via: "button" }).json.status, "approved");
check("and the card leaves the deck", !demo.route("GET", "/api/v1/feed", q, {}).json.cards.some((c: { id: string }) => c.id === first));
eq("a second decision on it is refused", demo.route("POST", dec, q, { decision: "approved" }).status, 409);
eq("undo puts it back", demo.route("DELETE", dec, q, {}).json.status, "proposed");
check("and it is in the deck again", demo.route("GET", "/api/v1/feed", q, {}).json.cards.some((c: { id: string }) => c.id === first));
eq("a shake is recorded", demo.route("POST", dec, q, { decision: "dismissed" }).json.status, "dismissed");
check("and shows up in History", demo.route("GET", "/api/v1/history", q, {}).json.cards.some((c: { id: string }) => c.id === first));
eq("nonsense is refused, never defaulted to approve", demo.route("POST", `/api/v1/cards/${feed.cards[1].id}/decision`, q, { decision: "yes please" }).status, 400);
eq("an unknown card is a 404", demo.route("POST", "/api/v1/cards/nope/decision", q, { decision: "approved" }).status, 404);

console.log("\n--- it says what it is rather than pretending ---");
const paste = demo.route("POST", "/api/v1/transcripts", q, { title: "x", content: "y" });
eq("pasting a transcript is refused", paste.status, 400);
check("with a sentence that says why", /demo/i.test(String(paste.json.error)));
const history = demo.route("GET", "/api/v1/history", q, {}).json.cards as Array<{ actionType: string; status: string; feedback: { executed?: { detail: string } } }>;
check("every executed receipt outside Haii's own list says Demo",
  history.filter((c) => c.status === "executed" && c.actionType !== "create_todo").every((c) => /^Demo\./.test(c.feedback.executed?.detail ?? "")));
check("every receipt in History is the one a nod would give",
  history.filter((c) => c.status === "executed").every((c) => c.feedback.executed?.detail === demo.receipts[c.actionType]));
for (const [type, text] of Object.entries(demo.receipts)) {
  if (type === "create_todo") check("a to-do kept in Haii says saved, as the client does", /^Saved\b/.test(text));
  else check(`the ${type} receipt starts with Demo.`, /^Demo\./.test(text));
}
check("the share receipt promises only a file Haii created", /only if Haii created it/.test(demo.receipts.share_file ?? ""));

console.log("\n--- the demo bar says what this is and links to the source ---");
type Node = {
  tag: string; attrs: Record<string, string>; children: Node[];
  id?: string; textContent?: string; href?: string; target?: string; rel?: string;
};
const make = (tag: string) => {
  const n: Node & { setAttribute(k: string, v: string): void; appendChild(c: Node): void } = {
    tag, attrs: {}, children: [],
    setAttribute(k, v) { n.attrs[k] = v; },
    appendChild(c) { n.children.push(c); },
  };
  return n;
};
const inserted: Node[] = [];
const header = { parentNode: { insertBefore(n: Node) { inserted.push(n); } } };
boot("?demo", {
  querySelector: (s: string) => (s === "header" ? header : null), getElementById: () => null,
  createElement: make, addEventListener() {}, body: { appendChild() {} },
});
const barEl = inserted[0];
check("a bar goes in above the header", inserted.length === 1 && barEl?.id === "demoBar");
const text = barEl ? barEl.children.map((c) => c.textContent ?? "").join(" ") : "";
check("it says the demo is fictional and sends nothing", /fictional/i.test(text) && /nothing is sent/i.test(text));
const link = barEl?.children.find((c) => c.tag === "a");
eq("the link names the source", link?.textContent, "Source on GitHub");
eq("and points at the repository", link?.href, "https://github.com/ardaasaroglu/haii");
check("in a new tab, with no opener", link?.target === "_blank" && link?.rel === "noopener");
// The bar now says what Haii is, so on a narrow screen it wraps rather than cutting the sentence off.
check("the bar may wrap instead of cutting its text", /flex-wrap:wrap/.test(barEl?.attrs.style ?? "") && !/white-space:nowrap/.test(barEl?.attrs.style ?? ""));

console.log("\n--- every path the client calls gets an answer ---");
const paths = new Set<string>();
for (const m of client.matchAll(/(?:api|fetch)\(\s*[`"](\/(?:api\/v1|healthz|auth)[^`"]*)[`"]/g)) {
  paths.add(m[1].replace(/\$\{[^}]+\}/g, "x").split("?")[0]);
}
check("found the client's calls", paths.size >= 25, `${paths.size} paths`);
for (const p of [...paths].sort()) {
  let answered = false;
  try {
    const r = demo.route("GET", p, q, {});
    answered = typeof r.status === "number" && r.json !== undefined;
  } catch { answered = false; }
  check(`answers ${p}`, answered);
}

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
