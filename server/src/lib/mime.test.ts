/** Tests for buildRawMessage in lib/mime.ts: the RFC822 message that becomes a Gmail draft.
 *
 *  This is the part of Gmail drafting worth testing without a mailbox. Every failure mode here is
 *  silent: a mis-encoded header arrives as mojibake rather than as an error, and an unstripped
 *  newline adds a recipient nobody saw on the card they approved. The API call around it is a POST
 *  that either works or returns a status.
 *
 *  Pure: no database, no network, no wall clock. `npx tsx src/lib/mime.test.ts`
 */
import { buildRawMessage, toBase64Url } from "./mime";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok" : "FAIL"} · ${name}${pass || !detail ? "" : `  (${detail})`}`);
  if (!pass) failures++;
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, String(got) === String(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/** Split a built message the way a mail server would: headers, blank line, body. */
function parse(raw: string) {
  const i = raw.indexOf("\r\n\r\n");
  const headerBlock = i < 0 ? raw : raw.slice(0, i);
  const bodyBlock = i < 0 ? "" : raw.slice(i + 4);
  const lines = headerBlock.split("\r\n");
  const get = (name: string) =>
    (lines.find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`)) ?? "").slice(name.length + 1).trim();
  return {
    lines,
    get,
    body: Buffer.from(bodyBlock.replace(/\r\n/g, ""), "base64").toString("utf8"),
    bodyLines: bodyBlock.split("\r\n").filter(Boolean),
  };
}

console.log("\n--- the shape a mail server expects ---");
{
  const m = parse(buildRawMessage({ to: "dana@northwind.example", subject: "Pricing", body: "Here it is." }));
  eq("To survives", m.get("To"), "dana@northwind.example");
  eq("Subject survives", m.get("Subject"), "Pricing");
  eq("body round-trips through base64", m.body, "Here it is.");
  eq("MIME-Version is declared", m.get("MIME-Version"), "1.0");
  eq("charset is explicit", m.get("Content-Type"), 'text/plain; charset="UTF-8"');
  eq("transfer encoding matches the body", m.get("Content-Transfer-Encoding"), "base64");
  // Gmail fills From from the authenticated account. Setting it invites a mismatch with the
  // mailbox the token belongs to, which Gmail rejects rather than silently corrects.
  check("no From header", !m.lines.some((l) => /^from:/i.test(l)));
}

console.log("\n--- non-ASCII, which is mojibake rather than an error when it is wrong ---");
{
  const m = parse(buildRawMessage({ to: "Mina <mina@acme.example>", subject: "Söz verdiğim fiyat", body: "Merhaba" }));
  check("a non-ASCII subject is RFC 2047 encoded", m.get("Subject").startsWith("=?UTF-8?B?"), m.get("Subject"));
  eq(
    "and decodes back to exactly what was asked for",
    Buffer.from(m.get("Subject").replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, ""), "base64").toString("utf8"),
    "Söz verdiğim fiyat",
  );
  eq("a non-ASCII body round-trips", m.body, "Merhaba");
}
{
  // Pure ASCII must NOT be encoded: an encoded-word is legal but makes the wire format unreadable
  // for the common case, and unreadable is how encoding bugs survive.
  const m = parse(buildRawMessage({ to: "a@b.com", subject: "Plain ASCII", body: "x" }));
  eq("plain ASCII passes through untouched", m.get("Subject"), "Plain ASCII");
}
{
  const m = parse(buildRawMessage({ to: "Zoë Reyes <zoe@northwind.example>", subject: "Hi", body: "x" }));
  check("a non-ASCII display name is encoded too", m.get("To").startsWith("=?UTF-8?B?"), m.get("To"));
}

console.log("\n--- header injection: the payload is model output from a transcript ---");
{
  // Reachable by anyone who talks in one of the user's meetings, so it is a real path, not a
  // theoretical one.
  const m = parse(
    buildRawMessage({
      to: "dana@northwind.example\r\nBcc: attacker@evil.test",
      subject: "Pricing\r\nBcc: attacker@evil.test",
      body: "Here it is.",
    }),
  );
  check("no Bcc header exists", !m.lines.some((l) => /^bcc:/i.test(l)));
  eq("the injected text is flattened into the To value", m.get("To"), "dana@northwind.example Bcc: attacker@evil.test");
  eq("and into the Subject value", m.get("Subject"), "Pricing Bcc: attacker@evil.test");
  eq("the header block still has exactly five lines", m.lines.length, 5);
}
{
  const m = parse(buildRawMessage({ to: "a@b.com", subject: "s", body: "line one\r\nBcc: attacker@evil.test" }));
  // The body is BELOW the blank line and cannot inject a header, so it is deliberately not stripped:
  // mangling someone's paragraph breaks to defend against nothing would be the worse bug.
  eq("a newline in the BODY survives, because it cannot inject", m.body, "line one\r\nBcc: attacker@evil.test");
  check("and still produces no Bcc header", !m.lines.some((l) => /^bcc:/i.test(l)));
}

console.log("\n--- edges that reach this from a real card ---");
{
  const m = parse(buildRawMessage({ to: "a@b.com", subject: "", body: "" }));
  eq("an empty subject is still a well-formed header", m.get("Subject"), "");
  eq("an empty body decodes to empty", m.body, "");
  eq("the header block is intact", m.lines.length, 5);
}
{
  const long = "x".repeat(500);
  const m = parse(buildRawMessage({ to: "a@b.com", subject: "s", body: long }));
  eq("a long body round-trips exactly", m.body, long);
  check("and is wrapped, not one enormous line", m.bodyLines.every((l) => l.length <= 76), `longest ${Math.max(...m.bodyLines.map((l) => l.length))}`);
}
{
  const raw = buildRawMessage({ to: "a@b.com", subject: "s", body: "hello" });
  check("headers and body are separated by exactly one blank line", raw.includes("\r\n\r\n"));
  check("line endings are CRLF, never bare LF", !/[^\r]\n/.test(raw));
}

console.log("\n--- base64url, the encoding the Gmail API's `raw` field actually wants ---");
{
  // This was missing on the first pass: createDraft handed Gmail the plain RFC822 string, which is
  // a 400 naming no field. Standard base64 is the other wrong answer and fails the same way.
  const enc = toBase64Url(buildRawMessage({ to: "a@b.com", subject: "s", body: "hello" }));
  check("no + in the output", !enc.includes("+"));
  check("no / in the output", !enc.includes("/"));
  check("no = padding", !enc.includes("="));
  eq("and it decodes back to the message", Buffer.from(enc, "base64url").toString("utf8"), buildRawMessage({ to: "a@b.com", subject: "s", body: "hello" }));
}
{
  // A body whose base64 lands on the characters that differ between the two alphabets, so this
  // fails loudly if toBase64Url is ever swapped back for a plain toString("base64").
  const enc = toBase64Url(buildRawMessage({ to: "a@b.com", subject: "s", body: "ÿÿþ?>?>" }));
  check("a body that exercises the + and / positions still encodes clean", !/[+/=]/.test(enc), enc.slice(-24));
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
