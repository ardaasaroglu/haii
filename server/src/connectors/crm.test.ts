/** The Salesforce SSRF guard.
 *
 *  `instance_url` is typed by the user and handed to fetch(), so without a guard a user could make
 *  the SERVER request the cloud metadata endpoint, localhost, or anything else on the internal
 *  network, and read the status back out of the error string.
 *
 *  Imports salesforceHost.ts, not crm.ts: crm.ts loads the database module, and this test must run
 *  without one.
 */
import { isAllowedSalesforceHost } from "./salesforceHost";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "ok" : "FAIL"} · ${name}`);
  if (!ok) failures++;
}

console.log("\n--- real Salesforce orgs are allowed ---");
check("a my.salesforce.com org", isAllowedSalesforceHost("https://acme.my.salesforce.com"));
check("bare host without a scheme", isAllowedSalesforceHost("acme.my.salesforce.com"));
check("a force.com host", isAllowedSalesforceHost("https://acme.force.com"));
check("a sandbox", isAllowedSalesforceHost("https://acme--dev.sandbox.my.salesforce.com"));

console.log("\n--- the attacks this exists to stop ---");
// The one that matters most: the metadata service of the host we run on.
check("cloud metadata IP is refused", !isAllowedSalesforceHost("http://169.254.169.254/latest/meta-data/"));
check("metadata over https is still refused", !isAllowedSalesforceHost("https://169.254.169.254/"));
check("localhost is refused", !isAllowedSalesforceHost("http://localhost:4820/api/v1/feed"));
check("loopback IP is refused", !isAllowedSalesforceHost("http://127.0.0.1/"));
check("private range is refused", !isAllowedSalesforceHost("https://10.0.0.5/"));
check("plain http on a real org is refused", !isAllowedSalesforceHost("http://acme.my.salesforce.com"));
// Userinfo smuggling: the host is evil.test, everything before @ is decoration.
check("credentials before @ cannot fake the host", !isAllowedSalesforceHost("https://acme.my.salesforce.com@evil.test/"));
// Suffix confusion: it ENDS with the string but is not the domain.
check("a lookalike domain is refused", !isAllowedSalesforceHost("https://salesforce.com.evil.test/"));
check("garbage is refused", !isAllowedSalesforceHost("not a url at all"));
check("empty is refused", !isAllowedSalesforceHost(""));

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
