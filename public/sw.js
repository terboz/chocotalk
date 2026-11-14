/* chocotalk service worker: static assets only. API and WebSocket traffic always go to the network. */
"use strict";

const CACHE_NAME = "chocotalk-static-v4";
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/vendor/qrcode.js"
];
const NETWORK_FIRST_ASSETS = new Set([
  "/app.js",
  "/styles.css",
  "/manifest.webmanifest"
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => (key.startsWith("chocotalk-static-") || key.startsWith("kchat-static-")) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

async function fetchAndCache(request, cacheKey) {
  const response = await fetch(request);
  if (response && response.ok) {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(cacheKey, response.clone());
    } catch (_error) {
      /* cache write failures must not break the response */
    }
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetchAndCache(request, "/index.html")
        .catch(() => caches.match("/index.html"))
    );
    return;
  }

  if (NETWORK_FIRST_ASSETS.has(url.pathname)) {
    event.respondWith(
      fetchAndCache(request, request)
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetchAndCache(request, request);
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || new URL("/", self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      const targetClient = clientList.find((client) => client.url === targetUrl);
      if (targetClient && "focus" in targetClient) {
        return targetClient.focus();
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return null;
    })
  );
});
