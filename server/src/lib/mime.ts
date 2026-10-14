/** Building an RFC822 message, for connectors/gmail.ts to hand to the Gmail drafts API.
 *
 *  In lib/ rather than beside its only caller because everything here is pure, and connectors/
 *  reaches the database through lib/connections. A test importing the connector opens PGlite, which
 *  makes "run the suite" and "the dev server is up" mutually exclusive, and this file exists to
 *  keep the encodings testable without that.
 *
 *  Every failure mode below is SILENT. A mis-encoded header arrives as mojibake rather than as an
 *  error, an unencoded `raw` is a 400 that names no field, and an unstripped newline adds a
 *  recipient nobody saw on the card they approved.
 */

/** Base64url, which is what the Gmail API's `raw` field wants and is NOT what Buffer's "base64"
 *  produces. Passing standard base64 fails with a 400 that does not say which character was wrong.
 *  This shipped missing once, caught by a test rather than by a mailbox. */
export const toBase64Url = (s: string) =>
  Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** RFC 2047 encoded-word, for header values that are not plain ASCII.
 *
 *  A raw "Söz verdiğim" in a Subject line is not a subject with an umlaut in it, it is a malformed
 *  header, and clients render mojibake or drop the line. Pure ASCII passes through untouched so the
 *  common case stays readable on the wire, which is how encoding bugs get noticed at all. */
export function encodeHeaderValue(value: string): string {
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Header injection defence. A newline inside `to` or `subject` ends that header and starts a new
 *  one, so a payload carrying "\r\nBcc: someone@else" would add a recipient the user never saw on
 *  the card they approved. The payload is model output derived from a transcript, which makes this
 *  reachable by anyone who speaks in one of their meetings.
 *
 *  Flattened rather than escaped: there is no legitimate newline in a To or a Subject. */
const oneLine = (value: string) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();

/** The RFC822 message, before base64url. Body base64 with an explicit charset rather than 8bit: a
 *  long line, a bare newline or a non-ASCII character each become somebody else's problem
 *  otherwise, and the transports that still care are the ones nobody tests against. */
export function buildRawMessage(input: { to: string; subject: string; body: string }): string {
  const body = Buffer.from(String(input.body ?? ""), "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
  const headers = [
    `To: ${encodeHeaderValue(oneLine(input.to))}`,
    `Subject: ${encodeHeaderValue(oneLine(input.subject))}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  // No From: Gmail fills it from the authenticated account, and setting it invites a mismatch with
  // the mailbox the token belongs to, which Gmail rejects rather than quietly corrects.
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}
