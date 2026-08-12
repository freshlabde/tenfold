// shareinbox.js - the app half of the share target.
//
// What it does: reads the one item that may have been parked when something
// was shared into tenfold from another app, and wipes that parking space
// again. There are two writers and they are both outside this module:
//
//   - sw.js, on Android/Chromium, which catches the share POST the platform
//     sends and is the only code running at that moment (the app itself may
//     not even be open);
//   - the native shell on iOS, where a Share Extension writes into an App
//     Group and the shell hands the item over the bridge as `share.incoming`.
//     `stashShare()` below is the door it comes through, and it parks the
//     item in the same Cache bucket the worker uses, so everything after that
//     point - the offer sheet, latest-wins, the wipe rules - is one
//     implementation with no idea which platform it is running on.
//
// What it deliberately does NOT do: no network of any kind, no decryption, no
// document access. And it holds nothing itself: the item lives in a Cache
// bucket of its own, never in IndexedDB beside the vault, so the one place in
// this app that ever holds unencrypted user text is a single named bucket that
// is emptied at the first opportunity.
//
// THE HONEST PART, and it belongs in the code as much as in the contract: what
// is parked here is PLAINTEXT. A service worker has no key - it cannot have
// one, by design - so it cannot encrypt what it receives. The window is from
// the moment of sharing until the next unlock, when the app either files the
// item into the sealed vault or drops it. A vault wipe empties it too.
//
// On iOS the window has one earlier leg and is otherwise identical: the Share
// Extension is a separate process that also holds no key, so its App Group
// slot is plaintext from the moment of sharing until the shell hands the item
// over here - and the shell empties that slot the moment it has. Two
// plaintext resting places in a row, both named, neither longer than it has
// to be.
//
// The bucket name is repeated in sw.js on purpose: a service worker is a
// classic script and cannot import this module. A test pins the two together.

import { onShellMessage, shellPost } from "./shell.js";

/** The Cache bucket the worker parks a shared item in. Also in sw.js. */
export const SHARE_CACHE = "tenfold-share-inbox";

/**
 * The message the native shell sends when its Share Extension left something
 * in the App Group. Spelled out here and in tenfold-ios/Sources/Bridge/
 * ShareHandover.swift - two repositories, no shared import - and pinned by a
 * test on each side, because a rename would silently stop shares arriving
 * rather than break a build.
 */
export const SHELL_MESSAGE = "share.incoming";

/**
 * What this app sends back once the item is in the bucket.
 *
 * The shell keeps its own copy - an App Group slot the extension wrote - until
 * it sees this, and only then deletes it. Receiving is not storing: parking an
 * item is a Cache write and a Cache write can fail. It did, on the first run
 * of this feature inside the shell, because the Cache API refuses a key whose
 * scheme is not http(s) and the shell's origin is `tenfold-app://`. Had the
 * shell cleared its slot on delivery, that bug would have presented as shares
 * that silently disappeared.
 */
export const SHELL_STORED_MESSAGE = "share.stored";

/**
 * The key inside the bucket. Built from the origin, not from a relative path -
 * the app is served both at the root and under a /tenfold prefix, and the
 * worker and this module have to agree on one string either way. The same
 * trick push.js uses for the locale entry.
 *
 * THE ONE EXCEPTION, and it is a rule of the Cache API rather than a
 * preference: `cache.put()` rejects with a TypeError unless the request's URL
 * scheme is http or https. Inside the native shell the origin is
 * `tenfold-app://app`, so a key built from it cannot be written at all -
 * measured on iOS 26.5, where `caches` exists, `caches.open()` resolves, and
 * `put()` throws (tenfold-ios/docs/DECISIONS.md D12).
 *
 * So on any other scheme the key falls back to a fixed https URL. It is never
 * fetched and no such host is ever contacted: a Cache key is a string that has
 * to look like a URL, and `.invalid` is the reserved TLD that guarantees it
 * can never resolve to anything real. The bucket, the shape and the
 * latest-wins rule are unchanged, so everything downstream stays one
 * implementation.
 */
export function shareKey() {
  return shareKeyFor(String(location.origin || ""));
}

/**
 * The rule behind `shareKey()`, as a function of the origin.
 *
 * Split out only so it can be tested: `location` cannot be redefined in a
 * browser, so the fallback branch is unreachable from a test that does not
 * actually run on a custom scheme - and an untested branch is exactly how this
 * would quietly regress to a key the shell cannot write.
 *
 * @param {string} origin
 * @returns {string}
 */
export function shareKeyFor(origin) {
  const from = String(origin || "");
  if (from.startsWith("http:") || from.startsWith("https:")) {
    return `${from}/tenfold-share-inbox`;
  }
  return "https://shell.tenfold.invalid/tenfold-share-inbox";
}

/** A title is one line. Anything longer was a paragraph, not a heading. */
const MAX_TITLE = 200;

/**
 * The item waiting to be filed, or null. Never throws: no Cache API, no
 * bucket, a half-written entry - all of them mean "nothing was shared".
 * @returns {Promise<{title: string, text: string, url: string, ts: number}|null>}
 */
export async function readShare() {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const hit = await cache.match(shareKey());
    if (!hit) return null;
    const raw = await hit.json();
    if (!raw || typeof raw !== "object") return null;
    const item = {
      title: typeof raw.title === "string" ? raw.title : "",
      text: typeof raw.text === "string" ? raw.text : "",
      url: typeof raw.url === "string" ? raw.url : "",
      ts: typeof raw.ts === "number" ? raw.ts : 0,
    };
    if (!item.title && !item.text && !item.url) return null;
    return item;
  } catch {
    return null;
  }
}

/**
 * Park an item that did not arrive as a POST.
 *
 * The iOS entry point, and deliberately the *only* thing this module does
 * differently for it: what it writes is byte-identical to what the service
 * worker writes on the web, in the same bucket, under the same key, with the
 * same latest-wins rule. From here on the two platforms are the same code
 * path - the offer sheet after unlock, the wipe on import or dismissal, the
 * wipe on `wipeLocalVault`.
 *
 * A share carrying nothing readable is dropped rather than parked as an empty
 * card, which is the rule sw.js already follows.
 *
 * Never throws: no Cache API means the platform cannot hold a shared item, and
 * a share that could not be parked is not a reason to take a session down.
 *
 * @param {{title?: string, text?: string, url?: string, ts?: number}} item
 * @returns {Promise<boolean>} whether something is now waiting
 */
export async function stashShare(item) {
  if (typeof caches === "undefined") return false;
  const shared = item || {};
  const parked = {
    title: typeof shared.title === "string" ? shared.title : "",
    text: typeof shared.text === "string" ? shared.text : "",
    url: typeof shared.url === "string" ? shared.url : "",
    ts: typeof shared.ts === "number" ? shared.ts : Date.now(),
  };
  if (!parked.title.trim() && !parked.text.trim() && !parked.url.trim()) return false;
  try {
    const cache = await caches.open(SHARE_CACHE);
    await cache.put(
      shareKey(),
      new Response(JSON.stringify(parked), { headers: { "Content-Type": "application/json" } }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Listen for shares handed over by the native shell.
 *
 * Two things happen here, and the second one is the reason this is a function
 * rather than a line in app.js. The listener is registered, and the page then
 * announces that it exists by setting `window.__tenfoldShareReady`. The shell
 * reads that flag before it hands anything over and keeps the item in its App
 * Group slot until it sees it - otherwise a cold launch would deliver into a
 * document that has a bridge but no listener yet, the shell would clear its
 * slot, and something a person deliberately sent here would be gone with
 * nothing anywhere saying so.
 *
 * In a browser this costs one event listener that never fires.
 *
 * @param {() => void} onArrived called after an item has been parked
 * @returns {() => void} removes the listener again
 */
export function startShellShareInbox(onArrived) {
  if (typeof window === "undefined") return () => {};
  const stop = onShellMessage(SHELL_MESSAGE, (message) => {
    stashShare(message).then((parked) => {
      if (!parked) return;
      // Tell the shell it may let go of its copy - and only now, with the item
      // actually in the bucket. A failed park is silence, which leaves the
      // item where it is and gets another attempt at the next launch.
      shellPost({ type: SHELL_STORED_MESSAGE });
      if (typeof onArrived === "function") onArrived();
    });
  });
  // The handshake. Set last, so it is never true before the listener is real.
  window.__tenfoldShareReady = true;
  return () => {
    stop();
    window.__tenfoldShareReady = false;
  };
}

/** Empty the bucket. Called after an import, after a dismissal, and on wipe. */
export async function clearShare() {
  if (typeof caches === "undefined") return;
  try {
    await caches.delete(SHARE_CACHE);
  } catch {
    // No cache storage: there was nothing parked to begin with.
  }
}

/**
 * What one shared item becomes: a title and a note, both plain text.
 *
 * The title is the shared title when there is one, otherwise the first line of
 * the text, otherwise the link. Everything that did not become the title goes
 * into the note, the link last and on its own line - so nothing that arrived
 * is dropped on the way in.
 *
 * Pure: no clock, no DOM, no ids. The caller creates the node.
 *
 * @param {{title?: string, text?: string, url?: string}} item
 * @returns {{title: string, note: string}}
 */
export function shareToNode(item) {
  const shared = item || {};
  const title = String(shared.title || "").trim();
  const body = String(shared.text || "").trim();
  const url = String(shared.url || "").trim();

  const lines = body ? body.split(/\r?\n/) : [];
  let head = title;
  let rest = lines;
  if (!head) {
    // No title came with the share: the first non-empty line becomes one.
    const first = lines.findIndex((line) => line.trim() !== "");
    if (first >= 0) {
      head = lines[first].trim();
      rest = lines.slice(first + 1);
    }
  }
  if (!head) head = url;

  const noteParts = [];
  // A heading that had to be cut keeps its full text in the note: the title is
  // shortened for the row it will sit in, nothing that arrived is thrown away.
  if (head.length > MAX_TITLE) noteParts.push(head);
  const tail = rest.join("\n").trim();
  if (tail) noteParts.push(tail);
  // A link that is already the title needs no second appearance.
  if (url && url !== head) noteParts.push(url);

  return {
    title: head.length > MAX_TITLE ? `${head.slice(0, MAX_TITLE - 1)}…` : head,
    note: noteParts.join("\n\n"),
  };
}
