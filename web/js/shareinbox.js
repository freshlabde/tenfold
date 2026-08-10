// shareinbox.js - the app half of the share target.
//
// What it does: reads the one item the service worker may have parked when
// something was shared into tenfold from another app, and wipes that parking
// space again. Read and clear only - the WRITER is sw.js, which is the only
// code running when a share arrives (the app itself may not even be open).
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
// The bucket name is repeated in sw.js on purpose: a service worker is a
// classic script and cannot import this module. A test pins the two together.

/** The Cache bucket the worker parks a shared item in. Also in sw.js. */
export const SHARE_CACHE = "tenfold-share-inbox";

/**
 * The key inside the bucket. Built from the origin, not from a relative path -
 * the app is served both at the root and under a /tenfold prefix, and the
 * worker and this module have to agree on one string either way. The same
 * trick push.js uses for the locale entry.
 */
export function shareKey() {
  return `${location.origin}/tenfold-share-inbox`;
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
