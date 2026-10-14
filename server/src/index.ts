import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env";
import { log } from "./log";
import { initDb } from "./db";
import { auth } from "./api/auth";
import { api } from "./api/routes";
import { telegramHook } from "./api/telegram";
import { startScheduler } from "./jobs/scheduler";
import { recoverPending, startExecutorPoller } from "./jobs/executor";
import { tgAdmin } from "./lib/telegram";

const here = dirname(fileURLToPath(import.meta.url));
// serveStatic resolves relative to process.cwd(); compute the public dir accordingly.
const publicRoot = relative(process.cwd(), join(here, "..", "public")).replace(/\\/g, "/") || "./";

async function main() {
  await initDb();

  const app = new Hono();

  /* Security headers, on every response including the static shell.
   *
   * FIRST, before the routes, because middleware registered after a matching route never runs for
   * it: this has to be the outermost thing or it protects only whatever happens to be defined
   * below it.
   *
   * The CSP allows 'unsafe-inline' for scripts and styles, which is not a fig leaf and is worth
   * being straight about. The whole client is ONE inline <script> and one inline <style> in
   * index.html, so a strict policy would need nonces threaded through a static file the server does
   * not template. What it still buys, and this is the part that matters for an app whose input is
   * attacker-reachable text: default-src 'self' means no injected markup can pull a script from
   * another origin or beacon data out to one, and connect-src 'self' means nothing can call an
   * external API from the page. Tightening to nonces is worth doing when the client is next
   * rebuilt.
   *
   * frame-ancestors 'none' is the clickjacking fix: without it Haii can be framed invisibly over
   * someone else's page and a "nod" harvested from a click the user thought was somewhere else.
   * That matters more here than in most apps, because a nod is the ONLY gate on a real action. */
  app.use("/*", async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "font-src 'self' data:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ].join("; "),
    );
    h.set("X-Content-Type-Options", "nosniff");
    h.set("Referrer-Policy", "strict-origin-when-cross-origin");
    h.set("X-Frame-Options", "DENY");
    h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    // HSTS only where the site is actually https, or a local http dev server would tell the browser
    // to refuse plain http to localhost for the next two years.
    if (env.APP_URL.startsWith("https")) {
      h.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    }
  });

  // A size limit on every request body, before any route reads one. Without it the whole body is
  // read into memory before any length check, so one request could exhaust memory. Two megabytes
  // holds the largest transcript the paste route keeps (200,000 characters) in any script.
  app.use(
    "/*",
    bodyLimit({
      maxSize: 2 * 1024 * 1024,
      onError: (c) => c.json({ error: "That is too large to read. Paste a shorter part." }, 413),
    }),
  );

  app.route("/", auth);
  app.route("/", api);
  app.route("/", telegramHook);
  app.use("/*", serveStatic({ root: publicRoot }));
  app.get("/", serveStatic({ path: join(publicRoot, "index.html").replace(/\\/g, "/") }));

  serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, async (info) => {
    log.info({ port: info.port, url: env.APP_URL, host: env.HOST }, "Haii server up");
    if (env.HOST === "0.0.0.0") {
      const { networkInterfaces } = await import("node:os");
      const nets = networkInterfaces();
      for (const list of Object.values(nets)) {
        for (const n of list ?? []) {
          if (n.family === "IPv4" && !n.internal) {
            log.info(`phone on the same wifi: http://${n.address}:${info.port}`);
          }
        }
      }
    }
    await recoverPending();
    startExecutorPoller();
    startScheduler();
    await tgAdmin(`🚀 Haii server up at ${env.APP_URL}`, { silent: true });
  });
}

main().catch((e) => {
  log.error({ err: String(e?.stack ?? e) }, "fatal boot error");
  process.exit(1);
});

process.on("uncaughtException", async (e) => {
  log.error({ err: String(e?.stack ?? e) }, "uncaught exception");
  await tgAdmin(`🔥 Haii server crashed: ${String(e?.message ?? e).slice(0, 300)}`).catch(() => {});
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  log.error({ err: String(e) }, "unhandled rejection");
});
