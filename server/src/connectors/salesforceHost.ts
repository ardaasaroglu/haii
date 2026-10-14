/** Is this a Salesforce host we are willing to send a request to?
 *
 *  Its own file with no imports, so crm.test.ts can check it without loading the database module.
 *
 *  SSRF GUARD, and it is not theoretical. `instance_url` is typed by the user and handed straight
 *  to fetch(), so without this a user could point it at `http://169.254.169.254/...` (the cloud
 *  metadata endpoint on the host we run on), at `http://localhost:PORT`, or at anything else inside
 *  the network, and the SERVER would make that request on their behalf. The status comes back in
 *  the error string, which is enough to probe what exists.
 *
 *  Two rules, both needed. HTTPS ONLY, because the metadata services that matter are plain http.
 *  And an ALLOWLIST of Salesforce's own domains, because "is this an internal IP" is a blocklist,
 *  and blocklists lose: decimal-encoded IPs, DNS names that resolve to 127.0.0.1, IPv6 forms, and
 *  redirects all get past them. There is no legitimate Salesforce org outside these suffixes. The
 *  allowlist checks only the address we call, which is why sfFetch in crm.ts does not follow
 *  redirects. */
export function isAllowedSalesforceHost(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return (
    host.endsWith(".salesforce.com") ||
    host.endsWith(".force.com") ||
    host.endsWith(".my.salesforce.com") ||
    host.endsWith(".salesforce.mil")
  );
}
