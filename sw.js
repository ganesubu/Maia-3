// Bump this on every release. Old cache buckets are deleted on activate,
// which is what actually forces stale JS out -- unregistering the worker
// alone does NOT clear previously-cached files.
const CACHE_NAME = "maia3-v5-analysis";

const PRECACHE = [
  "./",
  "./index.html",
  "./selftest.html",
  "./manifest.json",
  "./css/style.css",
  "./js/app.js",
  "./js/board.js",
  "./js/chess.esm.js",
  "./js/engine.js",
  "./js/idb.js",
  "./js/linalg.js",
  "./js/model.js",
  "./js/movemap.js",
  "./js/tokenize.js",
  "./js/weights-format.js",
  "./js/worker.js",
  "./js/personality/features.js",
  "./js/personality/dimensions.js",
  "./js/personality/presets.js",
  "./js/personality/scoring.js",
  "./js/personality/controller.js",
  "./js/characters.js",
  "./js/openings.js",
  "./js/analysis.js",
  "./js/stockfish-engine.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(async (cache) => {
        // addAll() is all-or-nothing: one 404 would leave the app with no
        // offline cache at all. Cache per-file instead so a single missing
        // optional asset can't break offline use of everything else.
        await Promise.all(
          PRECACHE.map((url) =>
            cache.add(url).catch((err) => console.warn("sw: could not precache", url, err))
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for the app shell, so a reload needs zero network requests
// once it's been visited once. Model weight files (weights/*.bin) are
// deliberately NOT handled here -- they're large (tens to hundreds of MB),
// and js/idb.js already caches them in IndexedDB once loaded, keyed by
// model id, with its own offline-reuse logic. Double-caching them here in
// Cache Storage too would just waste device storage for no benefit, so
// those requests are left to pass straight through to the network.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/weights/")) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
