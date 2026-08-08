// sw.js - the offline shell.
//
// What it does: precaches the app's own files on install and serves them from
// the cache first, so tenfold opens without a connection. Same-origin GET
// requests only.
//
// What it deliberately does NOT do: it never touches a foreign origin, never
// caches a response it did not ask for, and never sees vault data - the vault
// lives in IndexedDB, which a service worker cache cannot reach. Requests that
// are not same-origin GETs are passed through untouched, so nothing can be
// smuggled through this worker.

const VERSION = "tenfold-v3";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/tokens.css",
  "./css/app.css",
  "./js/boot.js",
  "./js/app.js",
  "./js/crypto.js",
  "./js/model.js",
  "./js/store.js",
  "./js/portability.js",
  "./js/prioritize.js",
  "./js/search.js",
  "./js/sync.js",
  "./js/motion.js",
  "./js/i18n.js",
  "./js/locales/en.js",
  "./js/locales/de.js",
  "./js/locales/es.js",
  "./js/ui/dom.js",
  "./js/ui/format.js",
  "./js/ui/rows.js",
  "./js/ui/sheet.js",
  "./js/ui/editor.js",
  "./js/ui/setup.js",
  "./js/ui/langswitch.js",
  "./js/ui/lock.js",
  "./js/ui/outline.js",
  "./js/ui/focus.js",
  "./js/ui/leaf.js",
  "./js/ui/duel.js",
  "./js/ui/search.js",
  "./js/ui/settings.js",
  "./js/ui/about.js",
  "./icons/icon.svg",
  "./icons/icon-maskable.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-192-maskable.png",
  "./icons/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // The sync mailbox is never cached: a cached vault would be served instead
  // of the current one, and a copy of the ciphertext would sit in a store the
  // app cannot see. Sync handles its own offline case.
  if (url.pathname.includes("/api/vault/")) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match("./index.html"));
    }),
  );
});
