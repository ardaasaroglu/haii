/** Local mode has no login: a request with no session is treated as the owner. That is only safe
 *  when the request really comes from this app's own page.
 *
 *  Two ways it might not. A page on any other site can make the browser send requests to this
 *  port, and without a check one of those could approve a card, which acts in the owner's name:
 *  it can post to Slack, file a ticket, share a file or book a meeting. And a hostile DNS name can
 *  be pointed at 127.0.0.1, which lets a foreign page read replies as if it were this app.
 *
 *  So the automatic identity needs a Host that names this machine (localhost, an address, or the
 *  host in APP_URL), and a browser that does not mark the request as coming from another site.
 *  Tools with no browser, such as curl and the tests, send neither header and pass.
 *
 *  Pure on purpose: no env, no database, so it can be tested without booting anything. */
export interface RequestOrigin {
  host?: string | null;
  origin?: string | null;
  /** The Sec-Fetch-Site header. */
  site?: string | null;
}

const bare = (name: string) => name.replace(/^\[|\]$/g, "");

export function fromThisApp(h: RequestOrigin, appUrl: string): boolean {
  const host = (h.host || "").trim().toLowerCase();
  if (!host) return false;
  const name = bare(host.replace(/:\d+$/, ""));
  let appHost = "";
  try {
    appHost = bare(new URL(appUrl).hostname.toLowerCase());
  } catch {
    appHost = "";
  }
  // An address cannot be rebound the way a name can, so any literal address is this machine.
  const isAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(":");
  if (!(name === "localhost" || isAddress || (appHost !== "" && name === appHost))) return false;

  // "none" is a person typing the address or opening a bookmark.
  const site = (h.site || "").toLowerCase();
  if (site && site !== "same-origin" && site !== "none") return false;

  if (h.origin) {
    try {
      if (new URL(h.origin).host.toLowerCase() !== host) return false;
    } catch {
      // "null" (a sandboxed frame or a file) and anything unparseable.
      return false;
    }
  }
  return true;
}
