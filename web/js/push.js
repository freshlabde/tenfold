// push.js - the daily reminder, and the second of exactly two modules in this
// app that are allowed to touch the network (the other one is sync.js).
//
// What it does: asks the browser for permission, registers a push subscription
// with the server's VAPID key, tells the server at which UTC hour it may send,
// and takes the subscription away again. It also parks the current locale in a
// tiny cache entry so the service worker can write its notification in the
// right language while the app is not running.
//
// What it deliberately does NOT do: it sends the push endpoint and one hour,
// nothing else - no title, no list, no id of any node, no locale, no device
// name. It calls same-origin /api/push/... only, and it reuses the sync write
// token (derived from the master key), so a stranger holding a sync id cannot
// register a reminder for somebody else's vault. The push that comes back
// carries NO payload at all, so there is nothing in it that could leak.

import { deriveSyncAuthToken } from "./crypto.js";
import { syncMeta } from "./sync.js";

/** Same trick as sync.js: the app also lives under the /tenfold prefix. */
const API_BASE = location.pathname.startsWith("/tenfold/") ? "/tenfold/api/push/" : "/api/push/";

/** Device-local, non-secret: whether this device asked for a reminder, and when. */
const PREF_KEY = "tenfold.push";

/**
 * Where the service worker looks up the language for its static text. Built
 * from the origin so this module and sw.js agree on the key whether the app is
 * served at the root or under the /tenfold prefix.
 */
const LOCALE_CACHE = "tenfold-locale";
const LOCALE_URL = `${location.origin}/tenfold-locale`;

/** Cached view of the state, so the settings screen can render synchronously. */
const state = { supported: null, permission: "default", enabled: false, hour: 8 };

function endpointUrl(path) {
  return `${API_BASE}${path}`;
}

function readPref() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    const p = raw ? JSON.parse(raw) : {};
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

function writePref(pref) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(pref));
  } catch {
    // Storage disabled: the subscription still exists, the app just forgets
    // which hour was chosen and falls back to the default next time.
  }
}

/** @returns {boolean} true when this browser can do web push at all. */
export function pushSupported() {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** The last known state. Cheap, synchronous, possibly one tick stale. */
export function snapshot() {
  return { ...state, supported: state.supported === null ? pushSupported() : state.supported };
}

/**
 * Re-read the truth from the browser: is there still a subscription, and is
 * permission still granted.
 * @returns {Promise<boolean>} true when the snapshot changed
 */
export async function refresh() {
  const before = JSON.stringify(snapshot());
  state.supported = pushSupported();
  const pref = readPref();
  state.hour = typeof pref.hour === "number" ? pref.hour : 8;
  state.permission = state.supported ? Notification.permission : "denied";
  state.enabled = false;
  if (state.supported && state.permission === "granted") {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      state.enabled = !!sub;
    } catch {
      state.enabled = false;
    }
  }
  return JSON.stringify(snapshot()) !== before;
}

/** base64url (what the server hands out) to the bytes pushManager wants. */
function decodeKey(value) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** Was this subscription made for the key the server hands out today? */
function sameKey(sub, wanted) {
  const raw = sub.options && sub.options.applicationServerKey;
  if (!raw) return false;
  const have = new Uint8Array(raw);
  if (have.length !== wanted.length) return false;
  for (let i = 0; i < have.length; i += 1) if (have[i] !== wanted[i]) return false;
  return true;
}

/** The UTC hour that corresponds to a local hour today. */
export function toUtcHour(localHour) {
  const d = new Date();
  d.setHours(localHour, 0, 0, 0);
  return d.getUTCHours();
}

/**
 * The current locale, parked where the service worker can read it. Not user
 * content: one of three fixed strings.
 */
export async function rememberLocale(locale) {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(LOCALE_CACHE);
    await cache.put(LOCALE_URL, new Response(String(locale)));
  } catch {
    // No cache storage: the worker falls back to English.
  }
}

/** Failure reasons the settings screen can translate. Never a server message. */
export class PushError extends Error {
  constructor(code) {
    super(code);
    this.name = "PushError";
    this.code = code;
  }
}

async function authHeaders(ctx) {
  const meta = syncMeta(ctx.vault);
  if (!meta || !ctx.masterKey) throw new PushError("sync");
  const token = await deriveSyncAuthToken(ctx.masterKey, meta.authSalt);
  return { meta, headers: { "Content-Type": "application/json", "X-Sync-Token": token } };
}

/** The server's VAPID public key. Public by definition - it identifies the
 *  sender to the push service and can verify a signature, nothing more. */
export async function vapidPublicKey() {
  let res;
  try {
    res = await fetch(endpointUrl("vapid"), { method: "GET", cache: "no-store" });
  } catch {
    throw new PushError("offline");
  }
  if (!res.ok) throw new PushError("server");
  const data = await res.json().catch(() => null);
  if (!data || typeof data.publicKey !== "string" || !data.publicKey) throw new PushError("server");
  return data.publicKey;
}

/**
 * Turn the daily reminder on for THIS device.
 * @param {Object} ctx the narrow context that carries vault and master key
 * @param {number} localHour 0..23
 */
export async function enablePush(ctx, localHour) {
  if (!pushSupported()) throw new PushError("unsupported");
  const hour = Math.max(0, Math.min(23, Math.trunc(localHour)));
  const permission = await Notification.requestPermission();
  state.permission = permission;
  if (permission !== "granted") throw new PushError("denied");

  const { meta, headers } = await authHeaders(ctx);
  const publicKey = await vapidPublicKey();

  const wanted = decodeKey(publicKey);
  let reg;
  let sub;
  try {
    reg = await navigator.serviceWorker.ready;
    sub = await reg.pushManager.getSubscription();
    // A subscription made for an older server key would be rejected by the
    // push service on every send, silently. Replace it instead of keeping it.
    if (sub && !sameKey(sub, wanted)) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
    }
  } catch {
    throw new PushError("subscribe");
  }

  let res;
  try {
    res = await fetch(endpointUrl("subscribe"), {
      method: "POST",
      cache: "no-store",
      headers,
      // The endpoint and one hour. The subscription's encryption keys are not
      // sent: an empty push needs none, and what is not sent cannot leak.
      body: JSON.stringify({ syncId: meta.id, sub: { endpoint: sub.endpoint }, hourUtc: toUtcHour(hour) }),
    });
  } catch {
    throw new PushError("offline");
  }
  if (res.status === 401) throw new PushError("denied");
  if (res.status === 429) throw new PushError("tooMany");
  if (!res.ok && res.status !== 204) throw new PushError("server");

  writePref({ ...readPref(), hour });
  state.hour = hour;
  state.enabled = true;
}

/** Take the reminder away again. The subscription is dropped on both sides. */
export async function disablePush(ctx) {
  let sub = null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    sub = reg ? await reg.pushManager.getSubscription() : null;
  } catch {
    sub = null;
  }
  if (sub) {
    try {
      const { meta, headers } = await authHeaders(ctx);
      await fetch(endpointUrl("unsubscribe"), {
        method: "POST",
        cache: "no-store",
        headers,
        body: JSON.stringify({ syncId: meta.id, endpoint: sub.endpoint }),
      });
    } catch {
      // The server keeps a subscription it can no longer deliver to; the push
      // service answers 410 on the next attempt and it is dropped there.
    }
    try {
      await sub.unsubscribe();
    } catch {
      // Already gone.
    }
  }
  state.enabled = false;
}
