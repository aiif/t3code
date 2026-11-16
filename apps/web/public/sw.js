/* Personal-mode portal service worker. Served from /sw.js and never cached. */

const SHELL_CACHE = "t3-portal-shell-v1";
const ASSET_CACHE = "t3-portal-assets-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) => key.startsWith("t3-portal-") && key !== SHELL_CACHE && key !== ASSET_CACHE,
          )
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

const passthrough = (pathname) =>
  pathname.startsWith("/api/") ||
  pathname.startsWith("/v1/") ||
  pathname.startsWith("/oauth") ||
  pathname.startsWith("/.well-known/") ||
  pathname === "/ws";

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || passthrough(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          await cache.put("/index.html", response.clone());
          return response;
        } catch {
          const cached = await caches.match("/index.html");
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      })(),
    );
  }
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const environmentId = typeof payload.environmentId === "string" ? payload.environmentId : null;
  const threadId = typeof payload.threadId === "string" ? payload.threadId : null;
  const title = typeof payload.title === "string" ? payload.title : "T3 Code";
  const body = typeof payload.body === "string" ? payload.body : "";
  const url = environmentId && threadId ? `/${environmentId}/${threadId}` : "/";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: threadId ?? title,
      data: { url },
      icon: "/icon-192x192.png",
      badge: "/favicon-32x32.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin)) {
          await client.focus();
          if ("navigate" in client) await client.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
