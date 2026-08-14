// sw.js - the offline shell, the one notification this app can show, and the
// catcher for what other apps share into tenfold.
//
// What it does: precaches the app's own files on install and serves them from
// the cache first, so tenfold opens without a connection. Same-origin GET
// requests only, with exactly one exception - the POST the platform sends when
// something is shared into the app (see the share target below). It also
// answers the daily push: the signal that arrives is EMPTY, so the sentence
// shown comes out of the small catalogue below, in the language the app parked
// in its own cache entry, and the app icon gets a badge with NO number on it,
// because a worker cannot count what it cannot decrypt.
//
// What it deliberately does NOT do: it never touches a foreign origin, never
// caches a response it did not ask for, and never sees vault data - the vault
// lives in IndexedDB, which a service worker cache cannot reach. It never
// reads a push payload, because there is none; if one ever arrived it would
// still be ignored. Requests that are neither same-origin GETs nor that one
// share POST are passed through untouched, so nothing can be smuggled through
// this worker.

const VERSION = "tenfold-v67";

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

/**
 * Where a shared item waits until the next unlock. The same two strings live
 * in js/shareinbox.js, which is the reader - a service worker is a classic
 * script and cannot import an ES module, so the pair is pinned by a test
 * instead. One item at a time: the newest share overwrites the previous one.
 *
 * What is parked here is PLAINTEXT and cannot be anything else: this worker
 * holds no key and never will. The app empties the bucket at the next unlock,
 * when the text either becomes a node inside the sealed vault or is dropped.
 */
const SHARE_CACHE = "tenfold-share-inbox";
const SHARE_URL = `${self.location.origin}/tenfold-share-inbox`;

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
  "./js/shell.js",
  "./js/webauthn.js",
  "./js/bio.js",
  "./js/aihelp.js",
  "./js/qr.js",
  "./js/qrread.js",
  "./js/questions.js",
  "./js/badge.js",
  "./js/shareinbox.js",
  "./js/vaultlock.js",
  "./js/vaultmirror.js",
  "./js/haptics.js",
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
  "./js/ui/aihelp.js",
  "./js/ui/shareimport.js",
  "./js/ui/pushoffer.js",
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
  "./js/ui/support.js",
  "./js/ui/supportnudge.js",
  "./js/ui/policy.js",
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
      // English on the next update. The share bucket survives for a harder
      // reason: an update that lands between a share and the next unlock would
      // otherwise throw away something the person deliberately sent here.
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== VERSION && k !== LOCALE_CACHE && k !== SHARE_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ------------------------------------------------------------- share target
//
// The platform hands a share to the app as a POST navigation - which is the
// point of choosing POST in the manifest: the shared text travels in a body
// and never in a URL, so it cannot end up in the address bar, in the history,
// or in a screenshot of either.

/**
 * The path the manifest names as the share target, whatever the app is mounted
 * under: the registration scope plus one segment. Written as a bare segment on
 * purpose - the precache drift guard reads every quoted dot-slash path in this
 * file as a shell entry, and this one is a route, not a file.
 */
const SHARE_SEGMENT = "share";

function sharePath() {
  try {
    return new URL(SHARE_SEGMENT, self.registration.scope).pathname;
  } catch {
    return `/${SHARE_SEGMENT}`;
  }
}

/**
 * Park what was shared and send the browser to the app. The worker cannot
 * encrypt it - it has no key, by design - so it writes the least it can get
 * away with and gets out of the way. A share that carries nothing readable is
 * dropped rather than parked as an empty card.
 *
 * Nothing here is logged, forwarded or kept anywhere else.
 */
async function stashShare(request) {
  try {
    const form = await request.formData();
    const item = {
      title: String(form.get("title") || ""),
      text: String(form.get("text") || ""),
      url: String(form.get("url") || ""),
      ts: Date.now(),
    };
    if (item.title.trim() || item.text.trim() || item.url.trim()) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put(
        SHARE_URL,
        new Response(JSON.stringify(item), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
  } catch {
    // An unreadable body is not an error worth showing: the app opens, and
    // there is simply nothing waiting in it.
  }
  // 303, so the browser turns the POST into a plain GET of the app root.
  return Response.redirect(self.registration.scope, 303);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (
    req.method === "POST" &&
    url.origin === self.location.origin &&
    url.pathname === sharePath()
  ) {
    event.respondWith(stashShare(req));
    return;
  }
  if (req.method !== "GET") return;
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

/**
 * The badge in FLAG mode: a mark with no number on it. The worker cannot count
 * what is due - the list is encrypted and it holds no key - so it says "there
 * is something" and lets the app correct that to a real count the next time it
 * is opened. Guarded twice, like everywhere else: the API is missing on most
 * desktops and refuses where the app is not installed.
 */
function flagBadge() {
  try {
    const nav = self.navigator;
    if (!nav || typeof nav.setAppBadge !== "function") return;
    const result = nav.setAppBadge();
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // A platform that only pretends to have the API.
  }
}

// The push carries nothing. event.data is deliberately never read: the sentence
// is chosen here, so no server and nobody on the way can put text on a screen.
self.addEventListener("push", (event) => {
  flagBadge();
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
