/** Static checks on the client, which has no other tests and is one large file.
 *
 *  WHY THIS EXISTS. A comment was once added inside `v.innerHTML=\`…\`` in renderToday that
 *  contained backticks around a CSS selector. The first backtick ENDED the template literal,
 *  and what followed parsed as JavaScript: `.row-lbl .c` became `str.row - lbl.c`, a subtraction
 *  against an undeclared variable. Today threw ReferenceError on every render and the app showed
 *  "can't reach Haii" instead of the Today screen.
 *
 *  It shipped because the only check on this file was `new vm.Script(...)`, and the broken form
 *  PARSES PERFECTLY. Parsing is not running. That is the whole lesson, and this file is the part of
 *  it that can be automated: the failure is invisible to a parser but trivial to spot in the text.
 *
 *  Deliberately not a general JS linter. It tests the specific, repeatable mistakes this one file
 *  makes, which is worth more than nothing while real client tests are still unbuilt.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "index.html");
const html = readFileSync(CLIENT, "utf8");

let failures = 0;
function check(name: string, ok: boolean, note = "") {
  console.log(`${ok ? "ok" : "FAIL"} · ${name}`);
  if (!ok) {
    if (note) console.log(`   ${note}`);
    failures++;
  }
}

console.log("\n--- no backticks inside HTML comments ---");
{
  const offenders: string[] = [];
  for (const m of html.matchAll(/<!--[\s\S]*?-->/g)) {
    if (!m[0].includes("`")) continue;
    const line = html.slice(0, m.index).split("\n").length;
    offenders.push(`line ${line}: ${m[0].slice(0, 80).replace(/\s+/g, " ")}…`);
  }
  check(
    "an HTML comment never contains a backtick",
    offenders.length === 0,
    offenders.join("\n   ") +
      "\n   A backtick inside a comment that sits in a template literal ends the string.",
  );
}

console.log("\n--- every action type the client must know about ---");
{
  // The lists that silently break a card when a type is missing from them. TYPES renders the chip,
  // FIELDS makes it editable, CARD_MODE decides what the card claims a nod will do.
  const types = /const TYPES=\{([\s\S]*?)\n\};/.exec(html)?.[1] ?? "";
  const fields = /const FIELDS=\{([\s\S]*?)\n\};/.exec(html)?.[1] ?? "";
  const cardMode = /const CARD_MODE=\{(.*?)\};/.exec(html)?.[1] ?? "";
  check("TYPES was found", types.length > 0);
  check("FIELDS was found", fields.length > 0);
  check("CARD_MODE was found", cardMode.length > 0);
  for (const t of [
    "send_email", "create_calendar_event", "create_todo", "send_slack_message", "create_jira_issue",
    "create_document", "share_file", "create_crm_note", "create_task", "send_text",
  ]) {
    check(`${t} is in TYPES, FIELDS and CARD_MODE`,
      types.includes(`${t}:`) && fields.includes(`${t}:`) && cardMode.includes(`${t}:`));
  }
}

console.log("\n--- every mode named by CARD_MODE actually exists in MODE ---");
{
  const modeBlock = /const MODE=\{([\s\S]*?)\n\};/.exec(html)?.[1] ?? "";
  const cardMode = /const CARD_MODE=\{(.*?)\};/.exec(html)?.[1] ?? "";
  const named = [...cardMode.matchAll(/:"([a-z_]+)"/g)].map((m) => m[1]);
  check("MODE was found", modeBlock.length > 0);
  check("at least one mode is named", named.length > 0);
  for (const mode of [...new Set(named)]) {
    check(`MODE.${mode} exists`, new RegExp(`\\b${mode}:\\{`).test(modeBlock));
  }
}

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
