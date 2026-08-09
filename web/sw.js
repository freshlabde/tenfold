// sw.js - the offline shell, and the one notification this app can show.
//
// What it does: precaches the app's own files on install and serves them from
// the cache first, so tenfold opens without a connection. Same-origin GET
// requests only. It also answers the daily push: the signal that arrives is
// EMPTY, so the sentence shown comes out of the small catalogue below, in the
// language the app parked in its own cache entry.
//
// What it deliberately does NOT do: it never touches a foreign origin, never
// caches a response it did not ask for, and never sees vault data - the vault
// lives in IndexedDB, which a service worker cache cannot reach. It never
// reads a push payload, because there is none; if one ever arrived it would
// still be ignored. Requests that are not same-origin GETs are passed through
// untouched, so nothing can be smuggled through this worker.

const VERSION = "tenfold-v36";

/**
 * Where the app leaves the current locale for the notification text. The key is
 * built from the origin, not from a relative path: the app is served both at
 * the root and under a /tenfold prefix, and a relative key would resolve
 * differently in the worker than in a module under js/.
 */
const LOCALE_CACHE = "tenfold-locale";
const LOCALE_URL = `${self.location.origin}/tenfold-locale`;

/**
 * The whole vocabulary of the notification. Three fixed sentences - nothing
 * from the list, nothing from the push, nothing that could identify anybody.
 */
const NOTICE = {
  en: { title: "tenfold", body: "Your question is waiting." },
  de: { title: "tenfold", body: "Deine Frage wartet." },
  es: { title: "tenfold", body: "Tu pregunta te espera." },
};

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
  "./js/entities.js",
  "./js/store.js",
  "./js/portability.js",
  "./js/prioritize.js",
  "./js/search.js",
  "./js/sync.js",
  "./js/push.js",
  "./js/webauthn.js",
  "./js/llm.js",
  "./js/prompts.js",
  "./js/qr.js",
  "./js/qrread.js",
  "./js/questions.js",
  "./js/motion.js",
  "./js/i18n.js",
  "./js/locales/en.js",
  "./js/locales/de.js",
  "./js/locales/es.js",
  "./js/ui/dom.js",
  "./js/ui/qrview.js",
  "./js/ui/scan.js",
  "./js/ui/photoscan.js",
  "./js/ui/format.js",
  "./js/ui/rows.js",
  "./js/ui/sheet.js",
  "./js/ui/editor.js",
  "./js/ui/entity.js",
  "./js/ui/storyguide.js",
  "./js/ui/assist.js",
  "./js/ui/imageimport.js",
  "./js/ui/setup.js",
  "./js/ui/emergency.js",
  "./js/ui/langswitch.js",
  "./js/ui/lock.js",
  "./js/ui/outline.js",
  "./js/ui/today.js",
  "./js/ui/map.js",
  "./js/ui/mindmap.js",
  "./js/ui/focus.js",
  "./js/ui/leaf.js",
  "./js/ui/duel.js",
  "./js/ui/search.js",
  "./js/ui/settings.js",
  "./js/ui/about.js",
  "./icons/icon.svg",
  "./icons/icon-maskable.svg",
  "./icons/favicon-32.png",
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
      // The locale entry survives a version bump on purpose: it is not part of
      // the shell, and losing it would silently switch the notification to
      // English on the next update.
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== VERSION && k !== LOCALE_CACHE).map((k) => caches.delete(k)),
        ),
      )
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

// ------------------------------------------------------------ notifications

/** The locale the app last parked here. English when there is none. */
async function currentLocale() {
  try {
    const cache = await caches.open(LOCALE_CACHE);
    const hit = await cache.match(LOCALE_URL);
    if (!hit) return "en";
    const value = (await hit.text()).trim();
    return Object.prototype.hasOwnProperty.call(NOTICE, value) ? value : "en";
  } catch {
    return "en";
  }
}

// The push carries nothing. event.data is deliberately never read: the sentence
// is chosen here, so no server and nobody on the way can put text on a screen.
self.addEventListener("push", (event) => {
  event.waitUntil(
    currentLocale().then((locale) => {
      const notice = NOTICE[locale] || NOTICE.en;
      return self.registration.showNotification(notice.title, {
        body: notice.body,
        icon: "./icons/icon-192.png",
        badge: "./icons/icon-192.png",
        tag: "tenfold-daily",
        renotify: false,
        requireInteraction: false,
      });
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // The scope is where the app lives, whether that is / or /tenfold/.
  const url = new URL(self.registration.scope);
  url.searchParams.set("view", "today");
  const target = url.href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        if ("focus" in client) {
          if ("navigate" in client) client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    }),
  );
});
