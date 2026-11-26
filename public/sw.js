/* chocotalk service worker: static assets only. API and WebSocket traffic always go to the network. */
"use strict";

const CACHE_NAME = "chocotalk-static-v7";
const STATE_CACHE = "chocotalk-state"; // not a static cache: kept across versions
const BADGE_KEY = "/__badge";
const OPEN_KEY = "/__open";
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
  "/vendor/qrcode.js",
  "/vendor/jsQR.js"
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

async function readBadgeCount() {
  try {
    const cache = await caches.open(STATE_CACHE);
    const response = await cache.match(BADGE_KEY);
    const value = response ? Number(await response.text()) : 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (_error) {
    return 0;
  }
}

async function writeBadgeCount(count) {
  try {
    const cache = await caches.open(STATE_CACHE);
    await cache.put(BADGE_KEY, new Response(String(count)));
  } catch (_error) {
    /* badge storage is best-effort */
  }
}

// Web Push: the server sends { title, body, tag, url } for each new message
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_error) {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "chocotalk";
  const body = typeof data.body === "string" && data.body ? data.body : "新着メッセージがあります";
  const url = new URL(typeof data.url === "string" ? data.url : "/", self.location.origin).href;
  const options = {
    body,
    icon: "/icons/icon-192.png",
    data: { url }
  };
  if (typeof data.tag === "string" && data.tag) {
    options.tag = data.tag;
    options.renotify = true; // 同じルームの通知は上書きしつつ毎回知らせる
  }

  event.waitUntil((async () => {
    // iOS は Push ごとに必ず通知を表示する必要がある
    await self.registration.showNotification(title, options);
    const count = (await readBadgeCount()) + 1;
    await writeBadgeCount(count);
    try {
      if (self.navigator && typeof self.navigator.setAppBadge === "function") {
        await self.navigator.setAppBadge(count);
      }
    } catch (_error) {
      /* app badges are best-effort */
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawUrl = (event.notification.data && event.notification.data.url) || "/";
  const targetUrl = new URL(rawUrl, self.location.origin).href;
  const targetPath = new URL(targetUrl).pathname;

  event.waitUntil((async () => {
    // アプリが start_url で起動した場合に備えて、開く先を残しておく（アプリ側で 60 秒以内なら移動）
    try {
      const cache = await caches.open(STATE_CACHE);
      await cache.put(OPEN_KEY, new Response(JSON.stringify({ url: targetUrl, at: Date.now() }), {
        headers: { "content-type": "application/json" }
      }));
    } catch (_error) {
      /* best-effort */
    }

    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const sameRoom = clientList.find((client) => new URL(client.url).pathname === targetPath);
    const target = sameRoom || clientList[0];
    if (target) {
      // 開いているアプリをそのトークへ移動させてから前面に出す
      if (!sameRoom) {
        try {
          target.postMessage({ type: "kc-open", url: targetUrl });
        } catch (_error) {
          /* ignore */
        }
      }
      try {
        await target.focus();
        return;
      } catch (_error) {
        /* fall back to opening a window */
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});
