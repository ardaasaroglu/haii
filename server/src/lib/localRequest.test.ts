import { fromThisApp } from "./localRequest";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "ok" : "FAIL"} · ${name}`);
  if (!ok) failures++;
}

const APP = "http://localhost:4820";
const H = "localhost:4820";

console.log("\n--- the app's own page, and tools with no browser ---");
check("a script or curl, no browser headers", fromThisApp({ host: "127.0.0.1:4820" }, APP));
check("the page's own request", fromThisApp({ host: H, origin: "http://localhost:4820", site: "same-origin" }, APP));
check("a typed address or a bookmark", fromThisApp({ host: H, site: "none" }, APP));
check("the IPv6 loopback", fromThisApp({ host: "[::1]:4820", origin: "http://[::1]:4820", site: "same-origin" }, APP));
check("header case does not matter", fromThisApp({ host: "LocalHost:4820", origin: "http://LOCALHOST:4820", site: "Same-Origin" }, APP));

console.log("\n--- another site making the browser call this port ---");
// The request that matters: approving a card posts a real message or books a real meeting in the owner's name.
check("a cross-site request is refused", !fromThisApp({ host: H, origin: "https://evil.example", site: "cross-site" }, APP));
check("refused on the origin alone, for a browser that sends no fetch metadata", !fromThisApp({ host: H, origin: "https://evil.example" }, APP));
check("refused on the fetch metadata alone, for a request that carries no origin", !fromThisApp({ host: H, site: "cross-site" }, APP));
check("a page on another local port is refused", !fromThisApp({ host: H, origin: "http://localhost:3000", site: "same-site" }, APP));
check("a sandboxed frame or a local file is refused", !fromThisApp({ host: H, origin: "null" }, APP));
check("a malformed origin is refused", !fromThisApp({ host: H, origin: "not a url" }, APP));

console.log("\n--- a foreign name pointed at this machine ---");
check("a foreign host name is refused", !fromThisApp({ host: "evil.example:4820" }, APP));
check("even when its own page looks same-origin", !fromThisApp({ host: "evil.example:4820", origin: "http://evil.example:4820", site: "same-origin" }, APP));
check("a name that only starts like localhost is refused", !fromThisApp({ host: "localhost.evil.example:4820" }, APP));
check("no host at all is refused", !fromThisApp({}, APP));

console.log("\n--- a phone on the same wifi, which is an explicit opt-in elsewhere ---");
check("the machine's own address", fromThisApp({ host: "192.168.1.20:4820", origin: "http://192.168.1.20:4820", site: "same-origin" }, APP));
check("but not another site calling that address", !fromThisApp({ host: "192.168.1.20:4820", origin: "https://evil.example", site: "cross-site" }, APP));

console.log("\n--- a name the owner chose ---");
check("the host in APP_URL is this app", fromThisApp({ host: "haii.home:4820", origin: "http://haii.home:4820", site: "same-origin" }, "http://haii.home:4820"));
check("and is refused when APP_URL does not name it", !fromThisApp({ host: "haii.home:4820" }, APP));
check("a broken APP_URL does not open the door", !fromThisApp({ host: "haii.home:4820" }, "not a url"));

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
