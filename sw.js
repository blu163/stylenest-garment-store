// Network-first for same-origin pages/assets: always try to fetch the latest
// version first, and only fall back to the cache when offline. This means
// site updates show up immediately instead of getting stuck on old cached
// files (which is what a cache-first strategy did before).
const CACHE_NAME = "handloom-house-v4";
const ASSETS = [
  "./",
  "./index.html",
  "./product.html",
  "./orders.html",
  "./help.html",
  "./admin.html",
  "./security.html",
  "./css/style.css",
  "./css/admin.css",
  "./css/security.css",
  "./js/shared.js",
  "./js/app.js",
  "./js/product.js",
  "./js/orders.js",
  "./js/help.js",
  "./js/admin.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return; // always hit the server for live data (auth, products, orders)

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => cached || caches.match("./index.html"))
      )
  );
});
