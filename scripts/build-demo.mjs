/* Build the hosted demo: the real interface with the demo week baked in, as static files.
 *
 *   node scripts/build-demo.mjs        writes docs/index.html and its assets
 *
 * Nothing is rewritten by hand. The page is server/public/index.html with three kinds of change,
 * each one asserted so a silent miss fails the build:
 *   1. demo.js is inlined and switched on, so no ?demo is needed and no server is asked for it
 *   2. absolute asset paths become relative, because a static host serves this from a subpath
 *   3. the manifest link is dropped, since installing a demo as an app makes no sense
 *
 * The service worker is already skipped whenever the demo is on (see index.html), so a hosted
 * copy never caches itself into a state nobody can update.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "server", "public");
const OUT = join(ROOT, "docs");

let html = readFileSync(join(PUBLIC, "index.html"), "utf8");
const demo = readFileSync(join(PUBLIC, "demo.js"), "utf8");
if (demo.includes("</script")) throw new Error("demo.js contains a closing script tag and cannot be inlined");

/** Replace `from` with `to`, and fail loudly unless it occurs exactly `times` times. */
function swap(from, to, times = 1) {
  const found = html.split(from).length - 1;
  if (found !== times) throw new Error(`expected ${times} of ${JSON.stringify(from)} in index.html, found ${found}`);
  html = html.split(from).join(to);
}

swap('<script src="/demo.js"></script>', "<script>window.HAII_DEMO=true;</script>\n<script>\n" + demo + "\n</script>");
swap('<link rel="manifest" href="/manifest.webmanifest">', "");
swap('href="/icon.svg"', 'href="icon.svg"');
swap("'/fonts/", "'fonts/", 2);
swap('"/icons/', '"icons/');

mkdirSync(join(OUT, "fonts"), { recursive: true });
mkdirSync(join(OUT, "icons"), { recursive: true });
writeFileSync(join(OUT, "index.html"), html);
copyFileSync(join(PUBLIC, "icon.svg"), join(OUT, "icon.svg"));
for (const f of readdirSync(join(PUBLIC, "fonts"))) copyFileSync(join(PUBLIC, "fonts", f), join(OUT, "fonts", f));
for (const f of readdirSync(join(PUBLIC, "icons"))) copyFileSync(join(PUBLIC, "icons", f), join(OUT, "icons", f));
// A static host must not run its own site generator over a page that is already finished.
writeFileSync(join(OUT, ".nojekyll"), "");

console.log(`wrote ${join(OUT, "index.html")} (${Math.round(html.length / 1024)} KB)`);
