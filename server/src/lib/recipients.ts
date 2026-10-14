/** Who would this card send something to, and is that someone we expected?
 *
 *  THE THREAT THIS EXISTS FOR. Indirect prompt injection is the primary AI-native risk in this
 *  product (CLAUDE.md), and the transcript is attacker-reachable: anyone in a meeting can say a
 *  sentence, and anyone who can get text into a Gemini doc, a notetaker recording or a Slack thread
 *  can put words in front of the extractor.
 *
 *  The existing defences are real but they do not cover this. Nothing auto-executes, so a human
 *  always nods. Every card carries a verbatim quote checked against its source. But BOTH of those
 *  pass for an injected line: the malicious sentence IS in the transcript, so its quote verifies,
 *  and it can be phrased as the user's own commitment, so attribution passes too. Quote fidelity
 *  proves the words were said. It cannot prove they should be acted on.
 *
 *  What actually protects the user is SEEING the destination before they nod. The blast radius grew
 *  when share_file and create_crm_note shipped: before that the worst an injection could do was
 *  draft an email the user would read. Now "share the pricing doc with
 *  billing@northwind-invoices.example" is a plausible-looking card that exfiltrates a file on one
 *  careless swipe.
 *
 *  So this does not block anything. Blocking would violate the swipe invariant and would be wrong
 *  anyway, because sending things to people outside your company is most of what work is. It marks
 *  the recipients the user could not have predicted, so the card can say so plainly and loudly at
 *  the one moment it matters.
 *
 *  Pure and separately tested: no database, no clock, no model.
 */

/** Everything this payload would send to, by action type. Slack channels are deliberately absent:
 *  a channel is not an address, it is inside a workspace the user already controls. */
export function recipientsOf(actionType: string, payload: Record<string, unknown>): string[] {
  const grab = (v: unknown) =>
    String(v ?? "")
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes("@"));
  switch (actionType) {
    case "send_email":
      return grab(payload.to);
    case "share_file":
      return grab(payload.emails);
    case "create_document":
      return grab(payload.share_with);
    case "create_calendar_event":
      return grab(payload.attendees);
    case "create_crm_note":
      // A CRM contact is a lookup key, not a delivery address, but it still decides WHOSE record
      // gets written, so an unexpected one is worth surfacing on the same terms.
      return grab(payload.contact);
    default:
      return [];
  }
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

/** Free and disposable mail hosts. A colleague is never at one of these, so an address here is
 *  always worth showing even when the user's own account happens to be a personal one. */
const PUBLIC_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com",
  "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com", "gmx.com", "mail.com",
  "yandex.com", "zoho.com", "fastmail.com",
]);

export interface UnexpectedInput {
  actionType: string;
  payload: Record<string, unknown>;
  /** The card owner's own address. Their domain is trusted. */
  selfEmail?: string | null;
  /** Everyone who was in the meeting this card came from. Being in the room is the strongest
   *  signal that a recipient is expected, and it is the whole reason this is not just a domain
   *  check: an external client on the call is exactly who a promise is usually TO. */
  attendeeEmails?: string[];
}

/** Recipients the user could not have predicted from the meeting itself.
 *
 *  Expected means one of: the user themselves, someone who was in the meeting, or someone at the
 *  user's own company domain. Everything else is returned, in the order it appeared, deduped. */
export function unexpectedRecipients(input: UnexpectedInput): string[] {
  const all = recipientsOf(input.actionType, input.payload);
  if (!all.length) return [];

  const self = String(input.selfEmail ?? "").trim().toLowerCase();
  const selfDomain = domainOf(self);
  const known = new Set((input.attendeeEmails ?? []).map((e) => String(e ?? "").trim().toLowerCase()).filter(Boolean));

  const out: string[] = [];
  for (const addr of all) {
    if (out.includes(addr)) continue;
    if (addr === self) continue;
    if (known.has(addr)) continue;
    // A shared company domain only counts as expected when it is a REAL company domain. Treating
    // gmail.com as "same company" would make every personal account trust every other one.
    if (selfDomain && !PUBLIC_MAIL.has(selfDomain) && domainOf(addr) === selfDomain) continue;
    out.push(addr);
  }
  return out;
}
