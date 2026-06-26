/* StockScan service worker — precache the app shell so it runs fully offline on-device.
   POST (laptop sync) and cross-origin requests pass straight through, never cached. */
const CACHE = "stockscan-v3";
const ASSETS = [
  "./", "index.html", "app.js", "parser.js", "manifest.webmanifest",
  "vendor/jsqr.min.js", "icons/icon-192.png", "icons/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                 // never touch sync uploads
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;       // never touch the laptop receiver
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match("index.html"))
    )
  );
});
