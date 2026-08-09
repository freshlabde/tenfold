// sync.js - the only module in this app that is allowed to touch the network.
//
// What it does: pushes the sealed vault to a dumb ciphertext mailbox, pulls it
// back on another device, and resolves every conflict here on the client -
// decrypt both sides with the in-memory master key, mergeDocs, re-seal, retry.
// It owns the sync ids, the pairing code and the small status the settings
// screen shows.
//
// What it deliberately does NOT do: it sends nothing but a sealed VaultFile,
// only to same-origin /api/vault/... paths, and never a passphrase, a key, a
// title or a note. It has no account, no session cookie, no telemetry, no
// third-party endpoint and no retry storm - every failure ends in a status
// line, never in a dialog and never in a lost local edit. It does not write to
// IndexedDB either; storing is the app layer's job.

import { deriveSyncAuthToken, newAuthSalt, openFromVault } from "./crypto.js";
import { mergeDocs, upgradeDoc } from "./model.js";

/**
 * Sync id alphabet: the recovery-key alphabet in lower case (I, L, O, U, 0, 1
 * removed because they are misread when read off a screen and typed on a
 * phone). 26 symbols carry 26 * log2(30) = 127.6 bits, which is the 128-bit
 * capability the contract asks for. Lower case, because that is what the
 * server validates against.
 */
const ID_ALPHABET = "23456789abcdefghjkmnpqrstvwxyz";
const ID_LENGTH = 26;
const ID_GROUP = 4;

/** Debounce after a local save, and the ladder used after a failed attempt. */
const PUSH_DEBOUNCE_MS = 3000;
const RETRY_STEPS_MS = [5000, 10000, 20000, 30000];

/** A 409 loop that does not settle after this many merges is left to the user. */
const MAX_MERGE_ROUNDS = 3;

/**
 * The mailbox path. The app is served at the root, and additionally under the
 * /tenfold prefix on the public domain; the API sits next to it either way.
 * Same origin only - an absolute URL is never built here.
 */
const API_BASE = location.pathname.startsWith("/tenfold/") ? "/tenfold/api/vault/" : "/api/vault/";

/** Failure reasons the UI can translate. Never a server message, never a stack. */
export class SyncError extends Error {
  constructor(code) {
    super(code);
    this.name = "SyncError";
    this.code = code;
  }
}

// ------------------------------------------------------------------- state

const state = {
  /** "off" | "idle" | "syncing" | "offline" | "conflict" | "denied" | "error" */
  phase: "off",
  lastSyncedAt: null,
  /** Server version this device last saw. 0 means "unknown, expect a 409". */
  version: 0,
};

let pushTimer = 0;
let retryTimer = 0;
let retryStep = 0;
let running = false;
let again = false;
/** The app context, handed over once at boot so timers can reach it. */
let boundCtx = null;

const listeners = new Set();

/** The app registers itself once; retries and the online handler use this. */
export function bindContext(ctx) {
  boundCtx = ctx;
}

function emit() {
  for (const fn of listeners) {
    try {
      fn(snapshot());
    } catch {
      // A broken status listener must not break the sync run.
    }
  }
}

function setPhase(phase) {
  if (state.phase === phase) return;
  state.phase = phase;
  emit();
}

/** Subscribe to status changes. Returns an unsubscribe function. */
export function onSyncChange(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** @returns {{enabled: boolean, phase: string, lastSyncedAt: number|null}} */
export function snapshot() {
  return { enabled: state.phase !== "off", phase: state.phase, lastSyncedAt: state.lastSyncedAt };
}

/** Clears timers and volatile state - called when the app locks. */
export function resetSync() {
  clearTimeout(pushTimer);
  clearTimeout(retryTimer);
  pushTimer = 0;
  retryTimer = 0;
  retryStep = 0;
  again = false;
  state.phase = "off";
  state.lastSyncedAt = null;
  state.version = 0;
}

// ------------------------------------------------------------- ids and codes

function randomSymbols(n) {
  // Rejection sampling: 256 is not a multiple of 30, so plain modulo would
  // bias the first ten symbols of the alphabet.
  const limit = Math.floor(256 / ID_ALPHABET.length) * ID_ALPHABET.length;
  const out = [];
  while (out.length < n) {
    const chunk = new Uint8Array(n);
    crypto.getRandomValues(chunk);
    for (let i = 0; i < chunk.length && out.length < n; i += 1) {
      if (chunk[i] < limit) out.push(ID_ALPHABET[chunk[i] % ID_ALPHABET.length]);
    }
    chunk.fill(0);
  }
  return out.join("");
}

/** A fresh capability id. Not derived from any secret - it grants read only. */
export function newSyncId() {
  return randomSymbols(ID_LENGTH);
}

/**
 * Accepts what a human types or pastes: upper case, hyphens, spaces of any
 * width, a whole pairing URL. Confusable symbols are not remapped - they are
 * not in the alphabet, and guessing intent could turn a typo into someone
 * else's valid id.
 */
export function normaliseSyncId(text) {
  if (typeof text !== "string") throw new SyncError("code");
  const fragment = text.includes("#s=") ? text.slice(text.lastIndexOf("#s=") + 3) : text;
  const cleaned = fragment.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cleaned.length !== ID_LENGTH) throw new SyncError("code");
  for (const ch of cleaned) {
    if (!ID_ALPHABET.includes(ch)) throw new SyncError("code");
  }
  return cleaned;
}

/** The id grouped for reading aloud and typing on the other device. */
export function formatSyncId(id) {
  const cleaned = normaliseSyncId(id);
  const groups = [];
  for (let i = 0; i < cleaned.length; i += ID_GROUP) groups.push(cleaned.slice(i, i + ID_GROUP));
  return groups.join("-");
}

/** @returns {string} the grouped pairing code of a vault, or "" when off. */
export function pairingCode(vault) {
  const meta = syncMeta(vault);
  return meta ? formatSyncId(meta.id) : "";
}

/**
 * The same code as a link. The id sits in the URL fragment, which browsers do
 * not send to any server - it is read locally and immediately removed from the
 * address bar.
 */
export function pairingUrl(vault) {
  const meta = syncMeta(vault);
  if (!meta) return "";
  // The page's own address, unchanged: shortening it to the directory would
  // produce a link that only works where a directory index exists.
  return `${location.origin}${location.pathname}#s=${meta.id}`;
}

/** The non-secret sync metadata of a vault, or null when sync is off. */
export function syncMeta(vault) {
  const meta = vault && vault.sync;
  if (!meta || typeof meta !== "object") return null;
  if (typeof meta.id !== "string" || typeof meta.authSalt !== "string") return null;
  if (!/^[a-z0-9]{26}$/.test(meta.id)) return null;
  return meta;
}

// ------------------------------------------------------------------ requests

function endpoint(id) {
  return `${API_BASE}${id}`;
}

async function getRecord(id) {
  const res = await fetch(endpoint(id), { method: "GET", cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new SyncError("server");
  const data = await res.json();
  if (!data || typeof data.version !== "number" || !data.vault) throw new SyncError("server");
  return data;
}

/** Cheap shape check on something that came off the wire. It is ciphertext -
 *  the only real proof is the unlock that follows. */
function looksLikeVault(vault) {
  return (
    vault &&
    typeof vault === "object" &&
    vault.magic === "TENFOLD1" &&
    Array.isArray(vault.wrappers) &&
    vault.wrappers.length > 0 &&
    vault.payload &&
    typeof vault.payload === "object"
  );
}

// -------------------------------------------------------------- doc compare

/** Canonical text of a document, so "did the merge change anything" is a
 *  string comparison instead of a deep walk with its own bugs. */
function canonical(doc) {
  if (!doc || typeof doc !== "object") return "";
  const flatten = (list) =>
    [...(list || [])]
      .map((n) => {
        const keys = Object.keys(n).sort();
        const flat = {};
        for (const k of keys) flat[k] = n[k];
        return flat;
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const settingsKeys = Object.keys(doc.settings || {}).sort();
  const settings = {};
  for (const k of settingsKeys) settings[k] = doc.settings[k];
  return JSON.stringify({
    schema: doc.schema || 1,
    nodes: flatten(doc.nodes),
    // The context index counts as content: a merge that only brought a new
    // card back must still be saved and pushed.
    entities: flatten(doc.entities),
    settings,
  });
}

// ------------------------------------------------------------------ scheduling

function scheduleRetry(ctx) {
  clearTimeout(retryTimer);
  const wait = RETRY_STEPS_MS[Math.min(retryStep, RETRY_STEPS_MS.length - 1)];
  retryStep += 1;
  retryTimer = setTimeout(() => {
    push(ctx);
  }, wait);
}

/**
 * Debounced push after a successful local save. Coalescing matters: a typed
 * line saves after 600 ms, and without this the app would upload a new blob
 * per sentence.
 */
export function schedulePush(ctx, delay = PUSH_DEBOUNCE_MS) {
  if (!syncMeta(ctx.vault)) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    push(ctx);
  }, delay);
}

// ---------------------------------------------------------------- operations

/**
 * Turns sync on: mints a capability id and an auth salt, writes them into the
 * vault (non-secret metadata that travels with every export) and uploads the
 * first blob.
 */
export async function enableSync(ctx) {
  if (!ctx.vault || !ctx.masterKey) return;
  let meta = syncMeta(ctx.vault);
  if (!meta) {
    meta = { id: newSyncId(), authSalt: newAuthSalt() };
    await ctx.setSyncMeta(meta);
  }
  state.version = 0;
  setPhase("syncing");
  await push(ctx);
}

/**
 * Turns sync off on THIS device: the id and the salt are dropped locally, the
 * pushing stops. The blob already on the server is not deleted - it is the
 * backup, and a device that just forgot its id cannot prove it may delete it.
 */
export async function disableSync(ctx) {
  clearTimeout(pushTimer);
  clearTimeout(retryTimer);
  await ctx.setSyncMeta(null);
  state.phase = "off";
  state.lastSyncedAt = null;
  state.version = 0;
  retryStep = 0;
  emit();
}

/**
 * Destroys the copy on the server. The write token is derived from the master
 * key, so only a device that can OPEN the vault can ask for this - which is the
 * point: the mailbox holds ciphertext, and the one who cannot read it has no
 * business destroying it either.
 *
 * A 404 counts as success: the record is gone, which is what was asked for -
 * another device may have deleted it a minute ago. Anything else throws, and
 * the caller must NOT continue with a local wipe on a throw: half a deletion,
 * silently, is the one outcome nobody could recover from.
 *
 * @throws {SyncError} "offline" (no connection), "denied" (the token does not
 *   own this id), "server" (anything else), "sync" (nothing to delete)
 */
export async function deleteRemote(ctx) {
  const meta = syncMeta(ctx.vault);
  if (!meta || !ctx.masterKey) throw new SyncError("sync");
  let token;
  try {
    token = await deriveSyncAuthToken(ctx.masterKey, meta.authSalt);
  } catch {
    throw new SyncError("server");
  }
  // Whatever was still queued must not resurrect what is about to go.
  clearTimeout(pushTimer);
  clearTimeout(retryTimer);
  let res;
  try {
    res = await fetch(endpoint(meta.id), {
      method: "DELETE",
      cache: "no-store",
      headers: { "X-Sync-Token": token },
    });
  } catch {
    throw new SyncError("offline");
  }
  if (res.status === 204 || res.status === 404) return;
  if (res.status === 401) throw new SyncError("denied");
  throw new SyncError("server");
}

/**
 * Uploads the current sealed vault. On a version clash the merge happens here:
 * both sides are decrypted with the master key that is already in memory, the
 * documents are merged, the result is saved locally and pushed again. Local
 * data is never dropped - after MAX_MERGE_ROUNDS the status says so and the
 * next save tries again.
 */
export async function push(ctx) {
  const meta = syncMeta(ctx.vault);
  if (!meta || !ctx.masterKey || !ctx.doc) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  clearTimeout(pushTimer);
  try {
    await pushRounds(ctx, meta);
  } finally {
    running = false;
    if (again) {
      again = false;
      schedulePush(ctx, 0);
    }
  }
}

async function pushRounds(ctx, meta) {
  setPhase("syncing");
  for (let round = 0; round <= MAX_MERGE_ROUNDS; round += 1) {
    if (!ctx.masterKey || !ctx.doc) return;
    let token;
    try {
      token = await deriveSyncAuthToken(ctx.masterKey, meta.authSalt);
    } catch {
      setPhase("error");
      return;
    }
    let res;
    try {
      res = await fetch(endpoint(meta.id), {
        method: "PUT",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Sync-Token": token,
          "X-If-Version": String(state.version),
        },
        body: JSON.stringify({ vault: ctx.vault }),
      });
    } catch {
      // Offline, blocked, tunnel down: swallowed into the status line.
      setPhase("offline");
      scheduleRetry(ctx);
      return;
    }

    if (res.status === 200) {
      const data = await res.json().catch(() => null);
      if (data && typeof data.version === "number") state.version = data.version;
      state.lastSyncedAt = Date.now();
      retryStep = 0;
      setPhase("idle");
      emit();
      return;
    }
    if (res.status === 401) {
      // Another vault owns this id, or the master key was rotated.
      setPhase("denied");
      return;
    }
    if (res.status !== 409) {
      setPhase("error");
      scheduleRetry(ctx);
      return;
    }

    const data = await res.json().catch(() => null);
    if (!data || typeof data.version !== "number") {
      setPhase("error");
      scheduleRetry(ctx);
      return;
    }
    state.version = data.version;
    if (data.vault) {
      let remoteDoc;
      try {
        // The other device may still write schema 1; both sides are lifted to
        // the current schema before they meet, so a merge never has to guess
        // what a missing field meant.
        remoteDoc = upgradeDoc(await openFromVault(data.vault, ctx.masterKey));
      } catch {
        // The blob under this id was not sealed with our key. Overwriting it
        // would destroy somebody's data; stop and say so.
        setPhase("denied");
        return;
      }
      const merged = mergeDocs(upgradeDoc(ctx.doc), remoteDoc);
      // Nothing new up there: the next round simply re-sends the same blob
      // with the version the server just told us about.
      if (canonical(merged) !== canonical(ctx.doc)) await ctx.applyMerged(merged);
    }
  }
  // Still clashing after three merges: somebody else is writing right now.
  setPhase("conflict");
  scheduleRetry(ctx);
}

/**
 * Fetches the remote state and folds it into the open document.
 * @returns {Promise<"clean"|"merged"|"offline">}
 */
export async function pull(ctx) {
  const meta = syncMeta(ctx.vault);
  if (!meta || !ctx.masterKey || !ctx.doc) return "offline";
  setPhase("syncing");
  let record;
  try {
    record = await getRecord(meta.id);
  } catch {
    setPhase("offline");
    return "offline";
  }
  if (!record) {
    // Nothing up there yet - this device is the origin.
    setPhase("idle");
    return "clean";
  }
  state.version = record.version;
  let remoteDoc;
  try {
    remoteDoc = upgradeDoc(await openFromVault(record.vault, ctx.masterKey));
  } catch {
    setPhase("denied");
    return "offline";
  }
  const merged = mergeDocs(upgradeDoc(ctx.doc), remoteDoc);
  if (canonical(merged) === canonical(ctx.doc)) {
    state.lastSyncedAt = Date.now();
    setPhase("idle");
    emit();
    return "clean";
  }
  await ctx.applyMerged(merged);
  state.lastSyncedAt = Date.now();
  setPhase("idle");
  emit();
  return "merged";
}

/**
 * Bootstraps a new device from a pairing code: the blob is public-by-capability
 * and useless without the passphrase, so it can be fetched before anything is
 * unlocked. Storing it and routing to the lock screen is the app layer's job.
 * @returns {Promise<Object>} the VaultFile
 */
export async function adopt(syncId) {
  const id = normaliseSyncId(syncId);
  let record;
  try {
    record = await getRecord(id);
  } catch (err) {
    throw err instanceof SyncError ? err : new SyncError("offline");
  }
  if (record === null) throw new SyncError("notFound");
  const vault = record.vault;
  if (!looksLikeVault(vault)) throw new SyncError("invalid");
  const meta = syncMeta(vault);
  if (!meta || meta.id !== id) throw new SyncError("invalid");
  state.version = record.version;
  return vault;
}

/** Retry a stalled push the moment the connection comes back. */
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    if (!boundCtx) return;
    if (state.phase === "offline" || state.phase === "error" || state.phase === "conflict") {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => push(boundCtx), 200);
    }
  });
}
