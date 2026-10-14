// The installed app's shell cache. Network first, cache only as the offline fallback.
//
// Only a complete, same-origin 200 is ever cached. A server restart can answer a request with a
// 5xx or an edge error page, and caching that would replay it as the app on every offline launch
// afterwards.
//
// Change the cache name whenever an offline launch must stop serving the old shell (a new font
// source, a new skin, a bad entry). `activate` deletes every cache that is not the current name,
// so a stale or poisoned entry is dropped on the next load rather than needing site data cleared
// by hand.
const SHELL = "haii-shell-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon.svg"])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // API + auth: network only (decisions, and login/session state, must never come from cache)
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/connect/") ||
    url.pathname.startsWith("/auth/") ||
    url.pathname === "/login.html"
  )
    return;
  // Shell: network first, cache fallback (offline shows last-known shell)
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Only a real, complete, same-origin 200 is worth keeping. An error page cached here is
        // served to this user on every subsequent offline moment, which turns one bad second during
        // a restart into a permanently broken app. `res.type === "basic"` excludes opaque
        // cross-origin responses, whose status always reads 0 and which we can never inspect.
        //
        // put() is allowed to fail and that is fine: a rejected put stores nothing, which is the
        // outcome we want. Swallow it so an unhandled rejection cannot take down the fetch handler
        // and leave the page with no response at all.
        if (res.ok && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match("/"))),
  );
});
