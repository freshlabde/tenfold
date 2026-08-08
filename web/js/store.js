// store.js - the only place that talks to IndexedDB.
//
// What it does: keeps exactly one record - the encrypted vault - plus the
// metadata `lastSavedAt`, and asks the browser for persistent storage.
//
// What it deliberately does NOT do:
//   *** NEVER WRITE PLAINTEXT INTO INDEXEDDB. ***
// No decrypted document, no title, no note, no search index, no draft, no
// cache, not even "temporarily". Everything that leaves this module towards
// the database is the opaque VaultFile produced by crypto.js. This module does
// not know and must not know how that object is built - it only stores it.
// It also does no crypto itself, no network, no DOM.

const DB_NAME = "tenfold";
const DB_VERSION = 1;
const STORE = "vault";
const RECORD_ID = "vault";

/** Keys whose presence would mean somebody handed us a decrypted document. */
const PLAINTEXT_MARKERS = ["nodes", "doc", "plaintext", "settings"];

function hasIndexedDb() {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!hasIndexedDb()) {
      reject(new Error("store: IndexedDB is not available in this context"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("store: cannot open database"));
    req.onblocked = () => reject(new Error("store: database upgrade blocked by another tab"));
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let inner;
      try {
        inner = Promise.resolve(fn(store));
      } catch (err) {
        try {
          tx.abort();
        } catch {
          /* transaction already gone */
        }
        reject(err);
        return;
      }
      inner.catch(reject);
      tx.oncomplete = () => inner.then(resolve, reject);
      tx.onerror = () => reject(tx.error || new Error("store: transaction failed"));
      tx.onabort = () => reject(tx.error || new Error("store: transaction aborted"));
    });
  } finally {
    db.close();
  }
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("store: request failed"));
  });
}

/**
 * Reject anything that is obviously not an encrypted vault. This is a guard
 * rail against an accidental "just save the doc for a second" - it can never
 * prove that a blob is ciphertext, but it does stop the shapes we know are
 * plaintext.
 */
function assertOpaqueVault(vault) {
  if (!vault || typeof vault !== "object" || Array.isArray(vault)) {
    throw new TypeError("store: vault must be a plain object");
  }
  for (const key of PLAINTEXT_MARKERS) {
    if (Object.prototype.hasOwnProperty.call(vault, key)) {
      throw new Error(`store: refusing to persist "${key}" - only the encrypted vault may be stored`);
    }
  }
}

/**
 * Ask the browser to keep our data. Reports what actually came back, not what
 * we hoped for: `supported` is false when the API does not exist at all, and
 * `persisted` is whatever the browser said.
 * @returns {Promise<{persisted: boolean, supported: boolean}>}
 */
export async function requestPersistence() {
  const s = typeof navigator !== "undefined" ? navigator.storage : undefined;
  if (!s || typeof s.persist !== "function") return { persisted: false, supported: false };
  try {
    if (typeof s.persisted === "function") {
      const already = await s.persisted();
      if (already === true) return { persisted: true, supported: true };
    }
    const granted = await s.persist();
    return { persisted: granted === true, supported: true };
  } catch {
    // The API exists but refused; say so instead of pretending.
    return { persisted: false, supported: true };
  }
}

/** @returns {Promise<Object|null>} the stored VaultFile or null. */
export async function loadVault() {
  const rec = await withStore("readonly", (store) => request(store.get(RECORD_ID)));
  return rec && rec.vault ? rec.vault : null;
}

/** Persist the encrypted vault. Overwrites the single record. */
export async function saveVault(vault, opts = {}) {
  assertOpaqueVault(vault);
  // JSON round-trip: enforces the "JSON-serialisable" part of the VaultFile
  // contract and stores a detached copy, never a live reference.
  const copy = JSON.parse(JSON.stringify(vault));
  const savedAt = typeof opts.now === "number" ? opts.now : Date.now();
  await withStore("readwrite", (store) =>
    request(store.put({ id: RECORD_ID, vault: copy, lastSavedAt: savedAt })),
  );
}

/** Remove everything this app stored. */
export async function clearAll() {
  await withStore("readwrite", (store) => request(store.clear()));
}

/** @returns {Promise<number|null>} epoch-ms of the last successful save. */
export async function lastSavedAt() {
  const rec = await withStore("readonly", (store) => request(store.get(RECORD_ID)));
  return rec && typeof rec.lastSavedAt === "number" ? rec.lastSavedAt : null;
}
