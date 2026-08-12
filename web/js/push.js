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
//
// TWO TRANSPORTS, ONE FEATURE
// ---------------------------
// Everything above describes the browser. Inside the native shell there is a
// second way to the same reminder, and it is the shorter one: the shell owns
// UNUserNotificationCenter, which schedules a repeating local notification on
// the device itself. No VAPID key, no subscription, no /api/push call, no
// server that has to be running at the chosen hour - and nothing to leak,
// because nothing leaves the phone.
//
// Which transport is in use is decided HERE and nowhere else. `enablePush`,
// `disablePush`, `refresh` and the three "would this work here" probes each
// branch once, at the top, on whether the shell offers the reminder
// capability. The settings row, the setup step and the one-time offer sheet
// call the same four entry points either way and know nothing about it - the
// day this module forks its callers is the day the feature has two designs.

import { deriveSyncAuthToken } from "./crypto.js";
import { syncMeta } from "./sync.js";
import { CAP_REMINDER, shellWith, shellSend } from "./shell.js";
import { t } from "./i18n.js";

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

/**
 * The native shell, but only when it can actually schedule a reminder.
 * Null everywhere else, which is the browser path above.
 * @returns {Object|null}
 */
function reminderShell() {
  return shellWith(CAP_REMINDER);
}

/**
 * The sentence the notification shows, ready-localised.
 *
 * The shell holds no catalogue and must never grow one: it would be a second
 * place where the app's words live, in a repository on a different release
 * cycle, and the two would drift the first time either was touched. So the web
 * app hands over the finished line at the moment the reminder is scheduled.
 *
 * Content-free, and it has to stay that way - this is the one sentence the app
 * says while the vault is locked. Two fixed strings out of the catalogue: no
 * title, no goal, no count, nothing of the person's.
 * @returns {{title: string, body: string}}
 */
function reminderNotice() {
  return { title: t("push.notice.title"), body: t("push.notice.body") };
}

/** The browser's three permission words, from the shell's four. */
function permissionFromShell(value) {
  if (value === "granted" || value === "denied") return value;
  return "default";
}

function clampHour(value) {
  const hour = Math.trunc(Number(value));
  if (!Number.isFinite(hour)) return 8;
  return Math.max(0, Math.min(23, hour));
}

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

/**
 * Can a daily reminder be set up in this window at all?
 *
 * In the shell the answer is yes and none of the browser's three APIs are
 * involved - the web view has no Service Worker, no PushManager and no
 * Notification object, and measuring for them would return the wrong answer
 * for a feature that is fully present.
 * @returns {boolean}
 */
export function pushSupported() {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  if (reminderShell()) return true;
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/**
 * Is this window the installed app rather than a browser tab? One small
 * function, deliberately: it is the whole iOS story, and a test has to be able
 * to stand where a phone stands without being one.
 */
function defaultInstalled() {
  if (typeof window === "undefined") return false;
  // The shell IS the installed app - there is no tab it could be running in.
  // Answered before the display-mode probe rather than after it: a WKWebView
  // reports no display-mode at all, so the media query below would say "browser
  // tab" about the one context that is certainly not one.
  if (reminderShell()) return true;
  // iOS Safari's own flag, older than display-mode and still the honest one.
  if (navigator && navigator.standalone === true) return true;
  try {
    return !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  } catch {
    return false;
  }
}

let installedProbe = defaultInstalled;

/** Test seam: replace the probe, or pass nothing to put the real one back. */
export function setInstalledProbe(fn) {
  installedProbe = typeof fn === "function" ? fn : defaultInstalled;
}

/** @returns {boolean} true when this window is the installed home-screen app. */
export function installedHere() {
  return !!installedProbe();
}

/** iPhone, iPad, iPod - including the iPad that calls itself a Mac. */
function applePlatform() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
}

/**
 * Would asking for permission lead anywhere HERE, right now? On iOS a
 * notification prompt in a Safari tab is a prompt for nothing: only the app on
 * the home screen ever receives a push. Everywhere else a tab is enough.
 */
export function usableHere() {
  if (!pushSupported()) return false;
  // In the shell the prompt leads straight to UNUserNotificationCenter, so the
  // whole "is this a tab" question is moot. Stated explicitly rather than left
  // to fall out of installedHere(), because the answer must not depend on a
  // user-agent string or a display-mode the web view does not report.
  if (reminderShell()) return true;
  if (applePlatform()) return installedHere();
  return true;
}

/**
 * Should the app offer the reminder on its own, after an unlock? Only in the
 * installed app: that is where the first run could not ask, and it is the one
 * context where the answer is worth anything on every platform.
 */
export function remindableHere() {
  if (reminderShell()) return true;
  return pushSupported() && installedHere();
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

  // The shell is the authority on its own scheduled notification, exactly as
  // the browser is on its subscription. Ask it rather than trusting the local
  // preference: permission can be revoked in Settings and the notification can
  // be gone without this app ever running in between.
  const shell = reminderShell();
  if (shell) {
    let reply = null;
    try {
      reply = await shellSend({ type: "reminder.status" });
    } catch {
      // No answer. Report what is certain - the feature exists here - and
      // leave the rest at the last known values rather than inventing a state.
      reply = null;
    }
    if (reply) {
      state.permission = permissionFromShell(reply.permission);
      state.enabled = !!reply.enabled;
      if (typeof reply.hour === "number") state.hour = clampHour(reply.hour);
    }
    return JSON.stringify(snapshot()) !== before;
  }

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
  const hour = clampHour(localHour);

  // ---- the shell transport -------------------------------------------------
  // Local, and therefore short: the shell asks the operating system for
  // permission inside this same user gesture and schedules a repeating daily
  // notification. Nothing is sent anywhere. Notably absent: authHeaders(),
  // vapidPublicKey() and the /api/push/subscribe POST - a reminder that never
  // leaves the device needs no vault to prove anything about, which is why
  // this branch does not touch `ctx` at all.
  const shell = reminderShell();
  if (shell) {
    const notice = reminderNotice();
    let reply;
    try {
      reply = await shellSend({ type: "reminder.schedule", hour, title: notice.title, body: notice.body });
    } catch {
      throw new PushError("shell");
    }
    state.permission = permissionFromShell(reply && reply.permission);
    // A refused prompt is the same answer here as in a browser, so it arrives
    // as the same error code and the settings screen shows the same sentence.
    if (state.permission === "denied") throw new PushError("denied");
    if (!reply || reply.ok !== true) throw new PushError("shell");
    writePref({ ...readPref(), hour });
    state.hour = hour;
    state.enabled = true;
    return;
  }

  // ---- the browser transport ----------------------------------------------
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

/**
 * Forget the reminder on THIS device without asking the server anything: the
 * browser subscription is cancelled and the local preference is dropped. Used
 * by the full deletion, where the server side is already gone - the whole id
 * directory, subscriptions included - and there is no vault left to prove
 * anything with.
 */
export async function forgetLocal() {
  // In the shell there is nothing to give back to a server - the notification
  // is on this device and only this device, so cancelling it IS the whole of
  // forgetting it.
  if (reminderShell()) {
    try {
      await shellSend({ type: "reminder.cancel" });
    } catch {
      // A wipe must complete whatever the shell says. The scheduled
      // notification carries no content, so the worst case is one more calm
      // line tomorrow morning about a vault that is gone.
    }
    try {
      localStorage.removeItem(PREF_KEY);
    } catch {
      // Storage disabled: there was no preference to remove.
    }
    state.enabled = false;
    state.hour = 8;
    return;
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) await sub.unsubscribe();
  } catch {
    // No worker, no subscription, no permission: nothing to give back.
  }
  try {
    localStorage.removeItem(PREF_KEY);
  } catch {
    // Storage disabled: there was no preference to remove.
  }
  state.enabled = false;
  state.hour = 8;
}

/** Take the reminder away again. The subscription is dropped on both sides. */
export async function disablePush(ctx) {
  // The shell removes the pending request by its fixed identifier. There is no
  // second side to tell, and no permission to hand back: iOS keeps the
  // authorization, which is what makes turning the reminder on again silent.
  const shell = reminderShell();
  if (shell) {
    try {
      await shellSend({ type: "reminder.cancel" });
    } catch {
      // Nothing answered. The settings screen re-reads the truth from the
      // shell straight after this call, so a failure shows up as a reminder
      // that is still on rather than as a wrong claim that it is off.
    }
    state.enabled = false;
    return;
  }

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
