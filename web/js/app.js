// app.js - the wiring.
//
// What it does: owns the only mutable state in the app (vault, master key, the
// decrypted document, the current view), routes between screens, debounces the
// seal-and-save cycle, keeps one undo step for every destructive action and
// locks the app after a period without activity.
//
// What it deliberately does NOT do: no DOM building of its own beyond the
// screen swap, no crypto, no IndexedDB access - those are crypto.js and
// store.js. It never writes plaintext anywhere but into the DOM and never
// makes a network request of its own: everything that leaves the device goes
// through sync.js, and only as a sealed vault.
//
// The master key is deliberately NOT on the ctx object every screen receives.
// sync.js needs it (it decrypts the remote copy to merge), so it gets its own
// narrow context object further down instead of a key on the shared one.

import { createVault, unlockWithPassphrase, unlockWithRecoveryKey, sealIntoVault, openFromVault, VaultUnlockError } from "./crypto.js";
import { loadVault, saveVault, requestPersistence, lastSavedAt, clearAll } from "./store.js";
import {
  createNode,
  childrenOf,
  ancestorsOf,
  isLeaf,
  moveNode,
  reorder,
  softDelete,
  upgradeDoc,
  createdAtOf,
} from "./model.js";
import {
  addEntity,
  updateEntity,
  deleteEntity,
  entityById,
  linkEntity,
  unlinkEntity,
  rememberDismissal,
} from "./entities.js";
import * as sync from "./sync.js";
import * as push from "./push.js";
import { setBadge, clearBadge, clearWidgetState, badgeCount, questionWaits } from "./badge.js";
import { vaultUnlocked } from "./haptics.js";
import { readShare, clearShare, startShellShareInbox } from "./shareinbox.js";
import { startShellVaultLock } from "./vaultlock.js";
import { navState, startShellNav } from "./nav.js";
import { CAP_NAV, shellWith } from "./shell.js";
import { mirrorAvailable, writeMirror, readMirror, mirrorStatus, mirrorStatusCached } from "./vaultmirror.js";
import { importEncrypted } from "./portability.js";
import * as webauthn from "./webauthn.js";
import * as bio from "./bio.js";
import { t, setLocale, detectLocale, getLocale, LOCALES } from "./i18n.js";
import {
  transition,
  nameTransition,
  clearTransition,
  clearAllTransitionNames,
  spring,
  prefersReducedMotion,
} from "./motion.js";
import { el, clear, text, icon } from "./ui/dom.js";
import * as setupScreen from "./ui/setup.js";
import * as lockScreen from "./ui/lock.js";
import * as outlineScreen from "./ui/outline.js";
import * as todayScreen from "./ui/today.js";
import * as mapScreen from "./ui/map.js";
import * as focusScreen from "./ui/focus.js";
import * as leafScreen from "./ui/leaf.js";
import * as duelScreen from "./ui/duel.js";
import * as searchScreen from "./ui/search.js";
import * as settingsScreen from "./ui/settings.js";
import * as aboutScreen from "./ui/about.js";
import * as entityScreen from "./ui/entity.js";
import { openSheet, closeSheet, isSheetOpen, onSheetChange } from "./ui/sheet.js";
import { openEditor } from "./ui/editor.js";
import { openStoryGuide } from "./ui/storyguide.js";
import * as aihelp from "./ui/aihelp.js";
import { openShareImport } from "./ui/shareimport.js";
import { openPushOffer } from "./ui/pushoffer.js";
import { openSupportNudge } from "./ui/supportnudge.js";
import { supportAvailable } from "./ui/support.js";

/** Minutes of inactivity after which the document is wiped from memory. */
export const IDLE_LOCK_MS = 15 * 60 * 1000;
const AUTOSAVE_MS = 600;
const MAX_ROOTS = 10;
const UI_PREF_KEY = "tenfold.ui";
/**
 * The one field of the lock screen's biometric offer that has to be remembered:
 * that somebody said no to it.
 *
 * It lives in the UI preferences, next to the language, and NOT in
 * `doc.settings`, for two reasons. The offer is drawn with the vault SHUT, so
 * the document that would carry the flag cannot be read at the moment the flag
 * is needed. And the answer is about this device: the wrapper is device-local,
 * the hardware behind it is device-local, and somebody declining on the phone
 * they hold has said nothing about the laptop that could also do this. A synced
 * flag would silence a device that was never asked.
 */
const BIO_OFFER_PREF = "bioOfferDismissed";
/**
 * Is there a native tab bar under this web view?
 *
 * `shellWith(CAP_NAV)`, and deliberately NOT `inShell()`. Every shell ever
 * built answers yes to `inShell()`, including the ones bundling a copy of
 * `web/` older than this line and the one shipping today; only a shell that
 * actually paints the bar advertises `nav`. Reading the weaker predicate would
 * take the settings gear off an older build's outline and leave nothing in its
 * place - the header fork has to follow the control that replaces it, not the
 * channel that could one day carry it.
 *
 * Read ONCE, here, and handed to the screens as `ctx.shellNav` below: the
 * capability list is injected at document start and cannot change while the
 * page is alive, the `ui/` modules then import nothing new to read a boolean
 * off the context they already have, and a test can set the field directly.
 */
const SHELL_NAV = shellWith(CAP_NAV) !== null;
export const APP_VERSION = "1.0.0";
// The cache generation, mirrored from web/sw.js VERSION and shown in the
// settings foot - the one answer to "which build is this phone actually
// running?" that survives a stale service worker debate. A drift guard in
// tests/regressions.spec.js keeps the two strings identical; the bump command
// rewrites both.
export const CACHE_VERSION = "tenfold-v69";

/**
 * How long a vault has to have been in use before the app asks, once, whether
 * it is worth an espresso. The owner's number: seven days.
 */
const SUPPORT_NUDGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const appEl = document.getElementById("app");
const layerEl = document.getElementById("layer");
const toastEl = document.getElementById("toast");
const liveEl = document.getElementById("live");

const SCREENS = {
  setup: setupScreen,
  lock: lockScreen,
  outline: outlineScreen,
  today: todayScreen,
  map: mapScreen,
  focus: focusScreen,
  leaf: leafScreen,
  duel: duelScreen,
  search: searchScreen,
  settings: settingsScreen,
  about: aboutScreen,
  entities: entityScreen,
};

const state = {
  vault: null,
  masterKey: null,
  doc: null,
  view: { name: "setup", id: null },
  stack: [],
  compose: null,
  duel: null,
  undo: null,
  savedAt: null,
  persisted: null,
  autoLocked: false,
  /** "today" when the app was opened from the daily notification. */
  pendingView: null,
  /** True once the espresso question has been put this session - see offerSupport. */
  supportNudgedThisSession: false,
  /**
   * "shell" or "prf" when the lock screen was told to arm the device's own
   * authenticator, null otherwise. A wish, not a setting: it is taken with the
   * vault shut, it is spent by the very next unlock, and nothing writes it
   * down - see the offer in ui/lock.js and `enrolAfterUnlock` below.
   */
  bioOfferWish: null,
};

let saveTimer = 0;
let idleTimer = 0;
let toastTimer = 0;

// --------------------------------------------------------------- preferences

function readUiPrefs() {
  try {
    const raw = localStorage.getItem(UI_PREF_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeUiPrefs(prefs) {
  try {
    localStorage.setItem(UI_PREF_KEY, JSON.stringify(prefs));
  } catch {
    // Storage disabled: the app still works, the choice just will not survive.
  }
}

/**
 * Presentation settings live in doc.settings (the truth) and are mirrored into
 * localStorage so boot.js can apply them while the vault is still locked.
 * Three enum values, no user content.
 */
function applyPresentation(settings) {
  const root = document.documentElement;
  const skin = ["slate", "register", "breath"].includes(settings.skin) ? settings.skin : "slate";
  const theme = settings.theme === "light" ? "light" : "dark";
  // Precedence: explicit doc setting, then a choice made on the lock/setup
  // screen (localStorage), then browser detection.
  const prefLang = readUiPrefs().lang;
  const lang = LOCALES.includes(settings.lang)
    ? settings.lang
    : LOCALES.includes(prefLang)
      ? prefLang
      : detectLocale();
  root.setAttribute("data-skin", skin);
  root.setAttribute("data-theme", theme);
  root.setAttribute("lang", lang);
  setLocale(lang);
  writeUiPrefs({ skin, theme, lang });
  // The service worker cannot import the catalogues, so the chosen language is
  // parked where it can read it. One of three fixed strings, no user content.
  push.rememberLocale(lang);
}

// ------------------------------------------------------------------ autosave

function scheduleSave() {
  // The icon follows every change to the list, and it follows it NOW - not in
  // 600 ms with the sealed write. This is the cheapest correct hook there is:
  // everything that can change a status or a due date passes through here.
  setBadge(state.doc);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    flushSave();
  }, AUTOSAVE_MS);
}

/**
 * Seal and store. `opts.fromSync` marks the saves that sync itself caused
 * (a merge, a metadata change) - those must not schedule another push, or a
 * merge would bounce between two devices forever.
 */
async function flushSave(opts = {}) {
  clearTimeout(saveTimer);
  if (!state.vault || !state.masterKey || !state.doc) return;
  try {
    const sealed = await sealIntoVault(state.vault, state.masterKey, state.doc);
    state.vault = sealed;
    // One timestamp for all three readers of it - the record in IndexedDB, the
    // "Last saved" row, and the mirror. They used to be two `Date.now()` calls
    // a few milliseconds apart, which nobody could see and which made "the
    // mirror carries the vault's own save time" not quite true.
    const savedAt = Date.now();
    await saveVault(sealed, { now: savedAt });
    state.savedAt = savedAt;
    // The spare copy, into the shell's app container. Started and never
    // awaited, and that is the contract rather than an optimisation: the vault
    // in IndexedDB is the one that matters and this is the second copy of the
    // same bytes, so it may not lengthen a save and a mirror that fails may not
    // fail one. The `.catch` is there because an async function reports a
    // failure as a rejection and an unhandled one is noise in a console
    // somebody is reading for real problems.
    //
    // It survives `lock()`, which starts this function without awaiting it:
    // `sealed` is a local, so the lines that take the master key and the
    // document away below cannot reach it, and the post happens a microtask
    // later on a lock screen that is already up.
    writeMirror(sealed, { savedAt }).catch(() => {});
    if (!opts.fromSync) sync.schedulePush(syncCtx);
  } catch {
    // A failed save must not take the session down; the next mutation retries.
  }
}

// --------------------------------------------------------------- idle locking

function touchIdle() {
  clearTimeout(idleTimer);
  if (!state.doc) return;
  idleTimer = setTimeout(() => {
    lock(true);
  }, IDLE_LOCK_MS);
}

/**
 * Close the vault: the document leaves memory, every screen that keeps its own
 * step state starts clean, and the lock screen goes up.
 *
 * The ORDER is the whole of it, and it is what to preserve when this function
 * is touched. `flushSave()` is started rather than awaited: an async function
 * runs to its first `await` synchronously, so by the time it yields,
 * `sealIntoVault` is already holding the master key and the document it seals.
 * Everything below can then drop both without losing the last edit - the
 * debounced 600 ms save included, which is the one this cancels and completes.
 *
 * What that buys is a lock screen that is on screen when this function RETURNS
 * rather than one seal and one IndexedDB write later. The idle lock never
 * needed that; the shell's does. It keeps a privacy veil over the web view
 * until the JavaScript that took `vault.lock` returns, and a lock that only
 * became visible a promise tick later would hand the veil back over the list.
 */
async function lock(auto = false) {
  const saving = flushSave();
  state.doc = null;
  state.masterKey = null;
  state.duel = null;
  state.compose = null;
  state.undo = null;
  state.stack = [];
  state.autoLocked = !!auto;
  // Every screen with its own step state starts clean behind the lock.
  [setupScreen, lockScreen, duelScreen, searchScreen].forEach((s) => {
    if (typeof s.reset === "function") s.reset();
  });
  // Immediately, not over the quarter second a sheet usually takes to slide
  // away: whatever is in an open sheet is plaintext somebody typed, and a
  // vault that is closed must not still be showing it.
  closeSheet({ immediate: true });
  clearTimeout(idleTimer);
  state.view = { name: "lock", id: null };
  syncHistory();
  // "none", so the swap happens in THIS call rather than inside a View
  // Transition. The wrapper is asynchronous by construction - it hands the
  // update to the browser, which paints a snapshot of the old screen and
  // cross-fades it over about a quarter of a second - and what it would be
  // cross-fading here is the list, out of a vault that is already closed. The
  // one screen change in this app that has to be instant is this one.
  render("none");
  if (!auto) toast(t("toast.locked"));
  await saving;
  // Sync stops at the lock: without the master key nothing could be merged,
  // and a timer firing behind the lock screen would only produce errors. After
  // the save rather than before it, exactly as when the save was awaited at
  // the top - the push that save schedules is the one this has to cancel.
  sync.resetSync();
}

// -------------------------------------------------------------------- toasts
//
// Three things the owner asked for after a delete: the pill must not stand on
// the bottom action bar (it hid "Put in order" for the whole eight seconds the
// undo was on offer), it must be smaller, and it must be possible to wipe away.
//
// The lift is MEASURED, not assumed: the bar's height depends on how many
// buttons the screen puts in it and on the safe-area inset, and a screen
// without a bar must keep the toast exactly where it always was. So the CSS
// owns the resting place and this owns one variable on top of it.

/** Air between the top of the toast pill and the top of the bar underneath. */
const TOAST_BAR_GAP = 10;
/** Nothing below this is a gesture - the same slop the duel and the rows use. */
const TOAST_TAP_SLOP = 9;
/** Past this the release means "away", the way SWIPE_COMMIT does on a row. */
const TOAST_COMMIT = 56;
/** ... and so does a throw, however short. px/s. */
const TOAST_FLING = 520;

/** Cancel of the spring currently moving the toast, if one is running. */
let toastSpring = null;
/** Where the finger (or the spring) currently holds the pill, in px. */
let toastDx = 0;

/**
 * Raise the toast clear of the bottom action bar of the screen that is up.
 * Sets --toast-lift; zero when this screen has no bar.
 */
function liftToastAboveBar() {
  toastEl.style.setProperty("--toast-lift", "0px");
  const bar = appEl.querySelector(".bar");
  const frame = toastEl.parentElement;
  if (!bar || !frame) return;
  const barBox = bar.getBoundingClientRect();
  if (!barBox.height) return;
  // The toast's `bottom` is measured from the frame's bottom edge, so the
  // distance we want is the one from that edge to the top of the bar.
  const base = parseFloat(getComputedStyle(toastEl).bottom);
  if (!Number.isFinite(base)) return;
  const wanted = frame.getBoundingClientRect().bottom - barBox.top + TOAST_BAR_GAP;
  const lift = Math.max(0, Math.round(wanted - base));
  if (lift) toastEl.style.setProperty("--toast-lift", `${lift}px`);
}

function setToastX(v) {
  toastDx = v;
  toastEl.style.transform = v ? `translate3d(${v}px,0,0)` : "";
}

function stopToastSpring() {
  if (toastSpring) toastSpring();
  toastSpring = null;
}

function toast(message, actionLabel, action) {
  clearTimeout(toastTimer);
  stopToastSpring();
  clear(toastEl);
  toastEl.classList.remove("is-dragging");
  setToastX(0);
  toastEl.appendChild(el("span", {}, [text(message)]));
  if (actionLabel && action) {
    toastEl.appendChild(
      el("button", { attrs: { type: "button" }, on: { click: () => { hideToast(); action(); } } }, [
        text(actionLabel),
      ]),
    );
  }
  liftToastAboveBar();
  toastEl.classList.add("is-open");
  toastTimer = setTimeout(hideToast, actionLabel ? 8000 : 2600);
}

function hideToast() {
  clearTimeout(toastTimer);
  stopToastSpring();
  toastEl.classList.remove("is-open", "is-dragging");
  setToastX(0);
}

/**
 * Put the toast away with no movement at all. Used at the end of a swipe -
 * the pill is already off the edge, and letting the CSS transition run from
 * there would drag it back across the screen on a diagonal - and as the whole
 * of the gesture when the user asked for less movement.
 */
function dropToast() {
  clearTimeout(toastTimer);
  stopToastSpring();
  const previous = toastEl.style.transition;
  toastEl.style.transition = "none";
  toastEl.classList.remove("is-open", "is-dragging");
  setToastX(0);
  void toastEl.offsetHeight; // commit the jump before the transition comes back
  toastEl.style.transition = previous;
}

/** The quick way out sideways, after a committed swipe. */
function flingToast(direction, velocity) {
  clearTimeout(toastTimer);
  if (prefersReducedMotion()) {
    dropToast();
    return;
  }
  const width = toastEl.getBoundingClientRect().width || 240;
  toastEl.classList.add("is-dragging");
  toastSpring = spring({
    from: toastDx,
    to: direction * (width + 40),
    velocity: Math.abs(velocity) > 1 ? velocity : direction * 700,
    stiffness: 300,
    damping: 30,
    onUpdate: setToastX,
    onDone: () => {
      toastSpring = null;
      dropToast();
    },
  });
}

/**
 * Swipe the toast away. Same vocabulary as a row: nothing happens inside the
 * tap slop, past it the pill follows the finger one to one in either
 * direction, and a release past the commit distance - or a throw - springs it
 * out. Dismissing is NOT undo: it says nothing and decides nothing, it only
 * clears the way to the bar underneath.
 */
function wireToastSwipe() {
  let down = false;
  let mode = "none"; // none | swipe | off
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastT = 0;
  let velocity = 0;
  let swiped = false;

  toastEl.addEventListener("pointerdown", (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    if (!toastEl.classList.contains("is-open")) return;
    stopToastSpring();
    down = true;
    swiped = false;
    mode = "none";
    startX = ev.clientX;
    startY = ev.clientY;
    lastX = startX;
    lastT = ev.timeStamp;
    velocity = 0;
  });

  toastEl.addEventListener("pointermove", (ev) => {
    if (!down) return;
    // A captured mouse can report moves after the button was let go outside
    // the window - the same belt and braces the rows wear.
    if (ev.pointerType === "mouse" && ev.buttons === 0) return;
    const mx = ev.clientX - startX;
    const my = ev.clientY - startY;
    if (mode === "none") {
      if (Math.abs(my) > TOAST_TAP_SLOP && Math.abs(my) > Math.abs(mx)) {
        mode = "off";
        return;
      }
      if (Math.abs(mx) > TOAST_TAP_SLOP) {
        mode = "swipe";
        toastEl.classList.add("is-dragging");
        // The pill is small and the swipe leaves it almost at once, so the
        // capture is taken the moment the gesture is one - not before, or a
        // plain tap on Undo would be delivered to the toast instead.
        try {
          toastEl.setPointerCapture(ev.pointerId);
        } catch {
          // No capture available: the gesture still works while the pointer
          // stays over the pill, which is all a mouse test needs.
        }
      }
    }
    if (mode !== "swipe") return;
    ev.preventDefault();
    const dt = Math.max(1, ev.timeStamp - lastT);
    velocity = ((ev.clientX - lastX) / dt) * 1000;
    lastX = ev.clientX;
    lastT = ev.timeStamp;
    setToastX(mx);
  });

  const release = () => {
    if (!down) return;
    down = false;
    if (mode !== "swipe") {
      mode = "none";
      return;
    }
    mode = "none";
    swiped = true;
    const dx = toastDx;
    if (Math.abs(dx) > TOAST_COMMIT || Math.abs(velocity) > TOAST_FLING) {
      flingToast(dx < 0 || (dx === 0 && velocity < 0) ? -1 : 1, velocity);
      return;
    }
    toastSpring = spring({
      from: dx,
      to: 0,
      velocity,
      stiffness: 420,
      damping: 34,
      onUpdate: setToastX,
      onDone: () => {
        toastSpring = null;
        setToastX(0);
        toastEl.classList.remove("is-dragging");
      },
    });
  };

  toastEl.addEventListener("pointerup", release);
  toastEl.addEventListener("pointercancel", release);

  // A swipe must not also count as a tap on Undo: the click arrives after
  // pointerup, and this catches it on the way down to the button.
  toastEl.addEventListener(
    "click",
    (ev) => {
      if (!swiped) return;
      swiped = false;
      ev.preventDefault();
      ev.stopPropagation();
    },
    true,
  );
}

wireToastSwipe();

function live(message) {
  liveEl.textContent = message;
}

// ------------------------------------------------------------------- history
//
// The browser's history mirrors the in-app view stack: one entry per screen
// that was navigated into, plus one guard entry while a sheet is open. A back
// gesture - the browser button, the phone's swipe, Alt+Left - therefore lands
// exactly where the app's own back arrow lands, and only leaves the app when
// there is nothing left to go back to.
//
// What goes INTO a history entry is the screen name and nothing else. No node
// id: browsers persist history state to disk for session restore, and even a
// uuid out of an encrypted list has no business outside memory. The entries are
// decorative anyway - routing reads the counters below, never history.state.

/** How many entries the browser holds above the one the page was loaded with. */
let historyDepth = 0;
/** How many the app's own state says there should be. */
let wantedDepth = 0;
/** A reconciliation is already queued for this task. */
let syncScheduled = false;
/** A traversal of ours is in flight; nothing else may touch the history until
 *  its popstate has landed, or the two would race. */
let traversing = false;
/** popstate events we caused ourselves and must not act on. */
let popSuppress = 0;

/**
 * The depth the app wants: one entry per screen on the stack, plus one for an
 * open sheet - the guard that makes a back gesture close the sheet instead of
 * leaving the screen behind it.
 */
function depthNow() {
  return state.stack.length + (isSheetOpen() ? 1 : 0);
}

function historyEntry() {
  return { view: state.view.name, sheet: isSheetOpen() };
}

/**
 * Bring the browser's history in line with the app's stack. EVERYTHING routing
 * related goes through here and nothing calls the history API directly, for one
 * reason: pushState is synchronous, a traversal is not. A close-then-open pair
 * in the same task - the row menu handing over to the editor sheet - would
 * otherwise push first and travel back afterwards, and the page would end up an
 * entry below where the app thinks it is. Here the two cancel out before
 * anything is issued, and any number of steps costs exactly one traversal.
 */
function syncHistory() {
  // The native shell's tab bar is the second mirror of this same stack, and it
  // is fed from HERE rather than from a hook of its own: this function is the
  // one point in the app at which "it moved" is known, reached from `go()`,
  // `stepBack()`, `lock()`, `enterApp()`, `finishIntro()`, `landOn()` and the
  // sheet subscription. A second collection point would drift from this one on
  // the day somebody adds a seventh caller to only one of them.
  //
  // Before the early return, not after: a second routing change inside the same
  // task reconciles once but has to REPORT twice, or the bar would hold the
  // first of the two. And `mutate()` does not come through here - which is what
  // keeps this off the composer's typing path, and is worth keeping true.
  //
  // `depth` is the app's own stack, not `depthNow()`: an open sheet is not a
  // screen, it travels in `sheet`, and the native back gesture arms on screens.
  navState({
    screen: state.view.name,
    root: state.stack.length ? state.stack[0].name : null,
    depth: state.stack.length,
    sheet: isSheetOpen(),
  });
  wantedDepth = depthNow();
  if (syncScheduled) return;
  syncScheduled = true;
  queueMicrotask(reconcileHistory);
}

function reconcileHistory() {
  syncScheduled = false;
  // A traversal in flight finishes first; its popstate calls back in here.
  if (traversing) return;
  const delta = wantedDepth - historyDepth;
  try {
    if (delta > 0) {
      for (let i = 0; i < delta; i += 1) history.pushState(historyEntry(), "");
      historyDepth = wantedDepth;
    } else if (delta < 0) {
      historyDepth = wantedDepth;
      traversing = true;
      popSuppress += 1;
      history.go(delta);
    } else {
      // Same depth, possibly another screen: keep the entry's label current.
      history.replaceState(historyEntry(), "");
    }
  } catch {
    // A browser that refuses (sandbox, traversal rate limit): the app routes on
    // its own stack regardless, only the back button loses its manners.
    traversing = false;
    popSuppress = Math.max(0, popSuppress - 1);
    historyDepth = wantedDepth;
  }
}

// ------------------------------------------------------------------- routing

function go(name, id = null, opts = {}) {
  if (!SCREENS[name]) return;
  const same = state.view.name === name && state.view.id === id;
  // `replace` collapses the in-app stack; the reconciliation above then walks
  // the browser back to the same depth, so a back press from the root leaves
  // the app instead of stepping through screens that are no longer reachable.
  if (opts.replace) state.stack = [];
  else if (!same) state.stack.push({ ...state.view });
  state.view = { name, id };
  state.compose = null;
  syncHistory();
  render(opts.direction || "in");
}

/**
 * One step back. `fromHistory` marks the call a popstate already paid for: the
 * browser has moved on its own, so the depth is corrected there, not here.
 */
function stepBack(fromHistory = false) {
  const prev = state.stack.pop();
  let moved = false;
  if (prev) {
    state.view = prev;
    moved = true;
  } else if (state.doc && state.view.name !== "outline") {
    state.view = { name: "outline", id: null };
    moved = true;
  }
  state.compose = null;
  syncHistory();
  // A popstate that changed nothing (the root screen) must not repaint - the
  // screen would flash for a press that deliberately does nothing.
  if (moved || !fromHistory) render("out");
}

function back() {
  stepBack(false);
}

/**
 * One step back, asked for by the shell rather than by a control on the screen.
 *
 * DELIBERATELY NOT `back()`, and the difference is one branch. `stepBack()`
 * falls back to the outline when there is nothing to pop and the screen is not
 * already the outline, and that branch is what makes the X on Today work: many
 * ways in, one way out, and the screen behind a closing button is never a
 * surprise. Inherited here it would make an edge swipe *invent* a destination
 * on a screen somebody never navigated into - the tab would change under a
 * thumb that asked to go back, which is the one outcome a back gesture must
 * never produce. Popping a screen that is genuinely on the stack is a different
 * thing and stays: that screen is one the person walked through, and leaving it
 * is what going back means, whichever tab it happens to light.
 *
 * So: a step only when there is something to step onto, and otherwise nothing
 * at all - not a repaint, not a `nav.state`. The native half declines to arm the
 * recogniser at `depth === 0` as well; two guards for one rule, because the cost
 * of missing it is a silent tab change rather than a visible fault.
 *
 * A sheet first, because that is what a person means by back with a sheet up,
 * and because it is what every other route into this already does - the X, the
 * scrim, Escape, and the popstate handler below, which spends the sheet's own
 * history entry on exactly this. Closed the ordinary way rather than
 * `{ immediate: true }`: nothing follows it, so there is no incoming screen for
 * the quarter second it takes to slide away to play over. `closeSheet()` emits
 * to `onSheetChange`, which syncs; there is nothing further to do here.
 */
function navBack() {
  if (isSheetOpen()) {
    closeSheet();
    return;
  }
  if (!state.stack.length) return;
  stepBack(false);
}

window.addEventListener("popstate", () => {
  if (popSuppress > 0) {
    popSuppress -= 1;
    traversing = false;
    // Whatever piled up while we were travelling is settled now.
    reconcileHistory();
    return;
  }
  // A real back gesture: the browser has left one of our entries behind.
  historyDepth = Math.max(0, historyDepth - 1);
  if (isSheetOpen()) {
    // The guard entry was spent on the sheet, which is exactly what it is for.
    closeSheet();
    syncHistory();
    return;
  }
  stepBack(true);
});

// An open sheet owns one history entry for as long as it is up - opened or
// closed by any route: the X, the scrim, Escape, a footer button, a popstate.
onSheetChange(() => syncHistory());

let painting = false;

function paint() {
  // Re-entrancy guard: tearing down a screen can blur an input whose handler
  // asks for another render. The outer paint is always the newer state.
  if (painting) return;
  painting = true;
  try {
    const mod = SCREENS[state.view.name] || SCREENS.lock;
    clear(appEl);
    appEl.appendChild(mod.render(ctx, state.view.id));
  } finally {
    painting = false;
  }
}

/**
 * `direction` "none" is an in-place update after a mutation - it must not
 * animate, or every keystroke in the composer would cross-fade the screen.
 */
function render(direction = "in") {
  if (direction === "none") {
    paint();
    return;
  }
  transition(appEl, paint, { direction });
}

// ---------------------------------------------------------------- mutations

function mutate(fn, opts = {}) {
  if (!state.doc) return;
  if (opts.undoLabel) state.undo = { nodes: state.doc.nodes, label: opts.undoLabel };
  const nodes = fn(state.doc.nodes);
  state.doc = { ...state.doc, nodes };
  scheduleSave();
  touchIdle();
  if (opts.silent !== true) render(opts.direction || "none");
}

/**
 * The same cycle for the context index. Cards have no undo step: a card is
 * created deliberately in a sheet and deleted behind a confirmation, so the
 * toast-undo that guards a stray swipe on a row has nothing to protect here.
 */
function mutateEntities(fn) {
  if (!state.doc) return;
  const entities = fn(state.doc.entities || []);
  state.doc = { ...state.doc, entities };
  scheduleSave();
  touchIdle();
  render("none");
}

function undo() {
  if (!state.undo) return;
  state.doc = { ...state.doc, nodes: state.undo.nodes };
  state.undo = null;
  scheduleSave();
  render();
}

/**
 * @param {Object} patch
 * @param {{now?: boolean}} [opts] `now` seals immediately instead of waiting
 *   for the debounced autosave - for a flag that decides whether a question is
 *   ever asked again, where a reload in the next 600 ms would ask it twice.
 */
function setSettings(patch, opts = {}) {
  if (!state.doc) return;
  state.doc = { ...state.doc, settings: { ...state.doc.settings, ...patch } };
  applyPresentation(state.doc.settings);
  if (opts.now) flushSave();
  else scheduleSave();
  render();
}

/**
 * Explicit language choice. Unlike setSettings this also works on the lock
 * and setup screens, where no document is open yet - the choice then lives
 * in the localStorage presentation prefs and is folded into doc.settings on
 * the next unlock or vault creation.
 */
function setLanguage(lang) {
  if (!LOCALES.includes(lang)) return;
  if (state.doc) {
    setSettings({ lang });
    return;
  }
  setLocale(lang);
  document.documentElement.setAttribute("lang", lang);
  writeUiPrefs({ ...readUiPrefs(), lang });
  push.rememberLocale(lang);
  render();
}

/**
 * Give the document a birthday if it has none.
 *
 * A vault created from now on gets its stamp at creation, which is the honest
 * moment. Every vault that already exists gets one here, on the first unlock
 * after this version: the earliest `createdAt` in the document, i.e. the oldest
 * goal or card anybody ever wrote, and only where there is nothing at all to go
 * on, today. That errs towards "younger than it really is", so the one thing
 * that reads this stamp - the week-old espresso question - asks late rather
 * than early.
 *
 * Not sealed on its own: the debounced save picks it up with the next change,
 * and a session that ends before that simply derives the same value again.
 */
function stampCreatedAt() {
  if (!state.doc) return;
  const settings = state.doc.settings || {};
  if (typeof settings.createdAt === "number" && Number.isFinite(settings.createdAt)) return;
  const anchor = createdAtOf(state.doc);
  state.doc = {
    ...state.doc,
    settings: { ...settings, createdAt: anchor === null ? Date.now() : anchor },
  };
  scheduleSave();
}

/**
 * What every unlock has in common, whichever envelope released the key: the
 * document is opened, lifted to the current schema before any screen or merge
 * can see it, and the idle clock starts. The key stays in this module - it is
 * not put on ctx, and it is never written anywhere.
 * @param {CryptoKey} key
 */
async function openWithMasterKey(key) {
  state.masterKey = key;
  state.doc = upgradeDoc(await openFromVault(state.vault, key));
  state.autoLocked = false;
  // A biometric wrapper the shell has proved dead (the key is gone, or the
  // enrolled face changed) leaves here - lazily, now that there is a master key
  // and a save on the way. On a lock screen nothing can be saved, so nothing is
  // cleaned there.
  try {
    const reconciled = await bio.reconcile(state.vault);
    if (reconciled !== state.vault) {
      state.vault = reconciled;
      await saveVault(state.vault);
    }
  } catch {
    // A vault that would not let go of a dead wrapper is still an open vault.
  }
  // A fresh unlock is a fresh session for anything that may be offered at most
  // once per unlock.
  state.supportNudgedThisSession = false;
  stampCreatedAt();
  applyPresentation(state.doc.settings || {});
  state.savedAt = await lastSavedAt();
  // First correct count of the session: the worker may have left a numberless
  // flag on the icon after a push, and nothing before this line could count.
  setBadge(state.doc);
  // The vault is open. Fired here and not from the three buttons on the lock
  // screen because this is where the fact becomes true: above this line an
  // envelope has released a key, which is not the same thing as a document that
  // opened - `openFromVault` can still throw, and a wrong passphrase never
  // reaches here at all. One place, all three envelopes, no way to feel an
  // unlock that did not happen.
  vaultUnlocked();
  touchIdle();
}

// --------------------------------------------------------------- share inbox

/**
 * Something was shared into tenfold from another app while this one was closed
 * or locked. The service worker parked it - it could do nothing else, it holds
 * no key - and this is the first moment anything can be done with it: the
 * document is open, so the text can be filed into the sealed vault or dropped.
 *
 * Offered, never applied: a sheet asks where it belongs. Until one of its two
 * buttons is pressed the item stays parked and is offered again at the next
 * unlock. One item at a time, the newest wins - see the contract.
 */
async function offerShare() {
  if (!state.doc) return;
  const item = await readShare();
  // The read is async: a lock, a wipe or a second unlock may have happened in
  // between, and a sheet over the lock screen would be a leak, not a feature.
  if (!item || !state.doc) return;
  openShareImport(layerEl, ctx, item);
}

// -------------------------------------------------------------- push offer

/**
 * The daily reminder, asked once where the first run could not ask for it.
 * On iOS the setup step can only say that a tab receives nothing, so the
 * question is picked up here: the first unlock inside the INSTALLED app, with
 * sync on (the subscription needs the write token) and no reminder running.
 *
 * Both answers write `settings.pushOffered`, so this happens exactly once per
 * vault and the decision travels to every device with it.
 */
async function offerPush() {
  if (!state.doc || state.introAbout) return;
  // Something that arrived from outside the app is the older claim on this
  // moment; the reminder can wait for the next unlock.
  if (isSheetOpen()) return;
  if (state.doc.settings.pushOffered) return;
  if (!sync.syncMeta(state.vault)) return;
  if (!push.remindableHere()) return;
  // The browser is the authority on whether a subscription already exists.
  await push.refresh();
  if (push.snapshot().enabled) return;
  // The refresh is async: a lock, a wipe or a share sheet may have happened.
  if (!state.doc || state.introAbout || isSheetOpen()) return;
  openPushOffer(layerEl, ctx);
}

// ----------------------------------------------------------- espresso nudge

/**
 * The only time this app asks for anything unprompted, and it asks once.
 *
 * A vault that has been in use for a week has proved the app is worth keeping;
 * somebody who already found the tip jar by themselves needs no reminder of it,
 * ever. Everything else here is a reason NOT to ask: the shell, where an
 * external payment link is an App Store rejection and an in-app purchase is a
 * later wave; a sheet already on screen, because a share or a reminder is the
 * older claim on this moment; and the first-run intro, which is somebody
 * deciding whether to trust this app with their goals.
 *
 * `supportNudged` (written by both buttons, sealed at once) is what makes it
 * once per vault. The session flag is what makes the X honest: closing the
 * sheet settles nothing and the question comes back at the NEXT unlock, but it
 * does not come back a second time in the same session.
 */
async function offerSupport() {
  if (!state.doc || state.introAbout) return;
  if (isSheetOpen()) return;
  if (!supportAvailable()) return;
  if (state.supportNudgedThisSession) return;
  const settings = state.doc.settings || {};
  if (settings.supportNudged || settings.supportOpened) return;
  const created = createdAtOf(state.doc);
  if (created === null || ctx.now() - created < SUPPORT_NUDGE_AFTER_MS) return;
  state.supportNudgedThisSession = true;
  openSupportNudge(layerEl, ctx);
}

// ------------------------------------------------- the lock screen's own wish

/**
 * Arm the device's authenticator because the lock screen was asked to.
 *
 * THE CONSTRAINT THAT SHAPES THIS: enrolment wraps the master key, so it can
 * only happen with the vault OPEN. The offer is made where the pain is - on the
 * lock screen, to somebody typing a passphrase on a device that could do
 * better - and that is precisely the one place where it cannot be carried out.
 * So the tap leaves a wish behind and this is where it is spent: the first
 * moment a master key exists, through the same `enable()`/`enrol()` call the
 * settings row uses and with the same two sentences, because a second enrolment
 * flow would be a second thing to keep true.
 *
 * It cannot hold anything up. The wish is consumed before the first await, so a
 * failure cannot leave it armed for a second attempt nobody asked for; the
 * screen is already up and the vault is already open when this runs; and a
 * refusal - a cancelled prompt, a Keychain that said no - ends in one line of
 * toast and nothing else. The session is not conditional on it.
 */
async function enrolAfterUnlock() {
  const wish = state.bioOfferWish;
  state.bioOfferWish = null;
  if (!wish || !state.doc || !state.masterKey) return;
  try {
    if (wish === "shell") await ctx.shellBio.enable();
    else await ctx.biometric.enrol();
    toast(t("webauthn.enrolled"));
  } catch {
    // Exactly what the settings row says when the same call fails there. The
    // offer is not marked as declined: nothing was declined, something did not
    // work, and the next lock screen may offer it again.
    toast(t("webauthn.failed"));
  }
}

/**
 * Everything that wants a word after an unlock, in the one order that makes
 * sense: the enrolment somebody asked for on the way in is finished first
 * (it answers a tap that has already been made, and it puts a system prompt on
 * screen - nothing may be sitting under that), what another app sent in is
 * answered next, the reminder is only offered when that left the screen empty,
 * and the one question that is about the app itself rather than about the
 * person's own list comes last of all.
 */
async function offerAfterUnlock() {
  await enrolAfterUnlock();
  await offerShare();
  await offerPush();
  await offerSupport();
}

// ------------------------------------------------------------------- landing

/**
 * Is anything actually waiting? The one question that decides where an unlock
 * lands, and it is NOT answered here.
 *
 * Both halves come out of badge.js, which is the same pair of calls the icon
 * and the home-screen widget are fed from in the same tick. That is the whole
 * point of routing through it: if the badge says nothing is waiting and the app
 * still opens Today, one of the two is lying, and nobody would ever find out
 * which - the icon and the screen are never looked at in the same second. A
 * second definition of "waiting" would not be a duplicate, it would be a slowly
 * diverging pair.
 *
 * `dueNowCount` is the overdue-and-due-today count Today ranks first;
 * `questionWaits` is the daily question still being unanswered, which is false
 * on an empty list and false once it has been put away for the day. Neither is
 * defined here and neither may be.
 *
 * @returns {boolean}
 */
function somethingWaits() {
  if (!state.doc) return false;
  const opts = { now: ctx.now() };
  return badgeCount(state.doc, opts) > 0 || questionWaits(state.doc, opts);
}

/**
 * Which screen an unlock opens, as one name - `doc.settings.landing` answered.
 *
 * Three values, and the default is the rule above rather than a screen: a
 * document with no `landing` field behaves exactly as it did before this
 * setting existed, which is the whole point. Anything unrecognised falls back
 * to the same rule, so a document written by a newer version can never land
 * somewhere this build has no screen for.
 *
 *   - "today"   - the default: `somethingWaits()` decides, Today or The Ten.
 *                 Deliberately NOT "always Today": an empty Today is nobody's
 *                 preferred start, and somebody who asks for Today is asking to
 *                 be shown the work, not to be shown that there is none.
 *   - "outline" - The Ten, unconditionally.
 *   - "map"     - the map, unconditionally, with ONE exception below.
 *
 * The map on an empty vault. It is not a broken screen - it draws its own
 * empty state, a centre mark and the line "Write your ten. Each one appears
 * here" - but it is a reading of a list, and there is nothing there to read. It
 * also names an action it cannot perform: the composer is on the outline, and
 * the map has no way to add anything. So with no roots at all this falls back
 * to The Ten, which is both the thing the map's own hint points at and the
 * screen one tap behind the map anyway. One root is enough for the map to mean
 * something (a body, its name, "One so far") and it is shown then.
 *
 * @returns {string} a SCREENS key
 */
function landingView() {
  if (!state.doc) return "outline";
  const chosen = (state.doc.settings || {}).landing;
  if (chosen === "outline") return "outline";
  if (chosen === "map") return childrenOf(state.doc.nodes, null).length ? "map" : "outline";
  return somethingWaits() ? "today" : "outline";
}

/**
 * Land on one screen, with the outline underneath it.
 *
 * The stack matters: the close button on Today and on the map is `ctx.back()`,
 * so the outline has to be under both of them whether somebody arrived from a
 * notification, from the rule above, from their own choice of start screen, or
 * by pressing the Today button themselves. Many ways in, one way out, and the
 * screen behind the close button is never a surprise.
 *
 * This was `landOnToday` until the setting arrived and is now the one place
 * that arranges a landing, rather than a second copy of the same four lines per
 * destination - a copy is how the map ends up with a different screen behind
 * its X than Today has, for no reason anybody could name later.
 */
function landOn(name) {
  // The outline as a destination is not the outline as a floor: `replace`
  // collapses the stack so a back press from the root leaves the app.
  if (name === "outline") {
    go("outline", null, { replace: true });
    return;
  }
  state.view = { name: "outline", id: null };
  state.stack = [];
  syncHistory();
  go(name);
}

// ------------------------------------------------------------------- context

const ctx = {
  get doc() {
    return state.doc;
  },
  get view() {
    return state.view;
  },
  get compose() {
    return state.compose;
  },
  get duel() {
    return state.duel;
  },
  get vault() {
    return state.vault;
  },
  get savedAt() {
    return state.savedAt;
  },
  get persisted() {
    return state.persisted;
  },
  get autoLocked() {
    return state.autoLocked;
  },
  get canUndo() {
    return !!state.undo;
  },
  version: APP_VERSION,
  cacheVersion: CACHE_VERSION,
  idleMinutes: Math.round(IDLE_LOCK_MS / 60000),
  /**
   * True only where a native tab bar is drawn under the web view, and the one
   * thing the screens branch on to leave out what that bar duplicates: the
   * Today link, the map button and the gear on the outline, and the closing X
   * on the three tab roots. Everything else in every header stays - the search
   * icon above all, because search is not a tab and hiding it would delete the
   * only entrance to a screen rather than a second one.
   *
   * A plain writable field rather than a getter: the browser and the PWA read
   * `false` and take the branch they take today, and a test can put `true` here
   * without a shell to assert the other side of the fork.
   */
  shellNav: SHELL_NAV,
  now: () => Date.now(),
  t,
  go,
  back,
  render,
  /** In-place update: no screen transition, for a screen that redraws itself. */
  repaint: () => render("none"),
  toast,
  live,
  lock,
  undo,
  setSettings,
  setLanguage,

  get introAbout() {
    return state.introAbout;
  },

  /**
   * The way into the app after a successful unlock or setup. The very first
   * time a vault is entered, the About text is offered for reading - once
   * dismissed it never appears uninvited again (flag in doc.settings, so the
   * decision travels with the vault).
   *
   * WHERE IT LANDS. Not always the outline any more: the app opens where the
   * work is. Something due now, or the day's question still unanswered, and it
   * opens Today; otherwise The Ten, which is where somebody with nothing
   * pending would want to think rather than act. The rule is `somethingWaits()`
   * above and is the badge's own arithmetic, not a second opinion.
   *
   * That rule is now the DEFAULT rather than the only answer:
   * `doc.settings.landing` can ask for The Ten or the map instead, and
   * `landingView()` above resolves the three values into one screen name. A
   * document without the field - which is every document that existed before
   * the setting, and every document belonging to somebody who never opens
   * settings - resolves to exactly the rule described above.
   *
   * Three things this rule does not touch, in the order they are checked:
   *
   *   - The intro wins. A vault whose About text has not been read is a first
   *     run, and a first run must never land on Today: a list somebody made
   *     ninety seconds ago has nothing due, and the question card over an empty
   *     list ("Nothing calls for today") is the worst possible first screen for
   *     an app that has just asked for a passphrase. `finishIntro` below then
   *     goes to the outline deliberately, without consulting the rule. Nothing
   *     had to be added for the setting: the intro is returned into before this
   *     decision is reached at all, and a first run has no setting yet anyway.
   *   - An explicit `pendingView` wins over it, and over the setting with it. A
   *     notification or a share brought somebody somewhere on purpose, and
   *     neither a rule computed from a document nor a preference somebody set
   *     last month may overrule the tap they are making now.
   *   - It is not a shell rule. There is no capability here and no branch on
   *     `inShell()` - the browser, the installed PWA and the shell open in the
   *     same place, because this is one app and "where does it open" is one
   *     answer.
   */
  async enterApp() {
    // With sync on, the remote copy is folded in before the list appears -
    // unless the server is slow, in which case the list wins and the merge
    // arrives a moment later. It also has to be before the landing decision:
    // a step that fell due on another device is something waiting here too.
    await pullOnEntry();
    if (state.doc && !state.doc.settings.aboutRead) {
      state.introAbout = true;
      state.view = { name: "about", id: null };
      state.stack = [];
      syncHistory();
      render();
      return;
    }
    // Arrived through the notification: the outline stays underneath, so the
    // close button on Today lands where it always does.
    if (state.pendingView === "today") {
      state.pendingView = null;
      landOn("today");
      offerAfterUnlock();
      return;
    }
    landOn(landingView());
    offerAfterUnlock();
  },

  /**
   * Out of the About intro and into the app - the outline, always, and
   * deliberately WITHOUT consulting the landing rule or the start-screen
   * setting in `enterApp` (a first run has neither a reason nor a way to have
   * chosen one: the settings screen is behind this intro). This is the
   * end of a first run: the list is minutes old, nothing in it can be due, and
   * the only thing the rule could find waiting is the daily question, which
   * would put a coaching card over "Nothing calls for today" as the first thing
   * somebody sees after handing this app a passphrase. The Ten is what they
   * just built and what they came to look at. An explicit `pendingView` still
   * wins, for the same reason it wins everywhere else.
   */
  finishIntro() {
    state.introAbout = false;
    state.view = { name: "outline", id: null };
    state.stack = [];
    syncHistory();
    if (state.pendingView === "today") {
      state.pendingView = null;
      state.view = { name: "today", id: null };
      state.stack = [{ name: "outline", id: null }];
      syncHistory();
    }
    setSettings({ aboutRead: true });
    // Persist immediately - the debounced autosave loses this flag when the
    // page is closed right after the intro, and the intro would reappear.
    flushSave();
    // The intro is the one screen a shared item must not land on top of, so
    // the offer waits until it has been read away.
    offerAfterUnlock();
  },
  openSheet: (spec) => openSheet(layerEl, spec),
  closeSheet,
  maxRoots: MAX_ROOTS,

  /**
   * Wipe the vault on THIS device and return to the first-run screen.
   * Reachable from the lock screen: whoever holds an unlocked device could
   * clear site data anyway, so this adds convenience, not attack surface.
   * A server copy (if sync was on) is deliberately left alone.
   */
  async wipeLocalVault() {
    sync.resetSync();
    // The shell is told BEFORE the vault goes, because the message has to name
    // which vault died and that name lives in the file. One message clears
    // three things the web app cannot reach: the Keychain key behind Face ID,
    // the widget's state with the badge, and the share slot.
    await bio.announceWipe(state.vault).catch(() => {});
    await clearAll();
    // Everything this device held about the list goes, including the three
    // things that live outside the vault: the count on the icon, whatever the
    // home-screen widget was showing, and anything another app shared in that
    // nobody filed yet.
    //
    // The widget is cleared explicitly rather than left to the next save,
    // because after a wipe there is no next save. With the opt-in title on it
    // would otherwise keep a goal on the home screen of a device whose vault
    // no longer exists, which is the one outcome that feature must not have.
    clearBadge();
    clearWidgetState();
    await clearShare();
    state.vault = null;
    state.masterKey = null;
    state.doc = null;
    state.stack = [];
    state.undo = null;
    state.savedAt = null;
    state.autoLocked = false;
    // A wish taken on the lock screen of the vault that just died. The next
    // unlock in this session is the end of a FIRST RUN, and a first run belongs
    // to the recovery key - nothing else may put a system prompt over it.
    state.bioOfferWish = null;
    [setupScreen, lockScreen, duelScreen, searchScreen].forEach((s) => {
      if (typeof s.reset === "function") s.reset();
    });
    closeSheet();
    state.view = { name: "setup", id: null };
    syncHistory();
    render();
  },

  /**
   * Delete the vault everywhere: the encrypted copy on the server first, then
   * everything this device holds - the vault itself, the biometric pointers,
   * the reminder subscription. The order is deliberate: the server copy is the
   * only part that a later attempt could not reach again once the local vault
   * (and with it the write token) is gone. So it goes first, and if it cannot
   * be reached this throws BEFORE anything local is touched. The caller then
   * says so and offers the device-only wipe - a silent half deletion would
   * leave a copy on a server nobody can address any more.
   *
   * The presentation preferences (skin, theme, language) stay: they are three
   * enum values about how a screen looks, not anything personal.
   *
   * @throws {SyncError} when the server copy could not be removed
   */
  async deleteEverywhere() {
    if (sync.syncMeta(state.vault)) await sync.deleteRemote(syncCtx);
    // Past this line the server copy is gone. A reminder subscription or a
    // biometric pointer that refuses to go is not a reason to stop - and must
    // not surface as "the server copy is still there", which is the one thing
    // that is now certainly not true. Only the wipe itself may still throw,
    // and it throws a plain Error, which the caller tells apart by name.
    await push.forgetLocal().catch(() => {});
    try {
      webauthn.forget();
    } catch {
      // No storage: there was no pointer to forget.
    }
    // The shell's key, the widget and the share slot go with the wipe below -
    // wipeLocalVault sends `vault.wiped`, which is the one message that says
    // the vault is gone rather than merely empty.
    await ctx.wipeLocalVault();
  },

  /** Open a node: goals zoom in, steps show their detail. */
  openNode(node, rowEl) {
    if (rowEl) {
      clearAllTransitionNames(appEl);
      nameTransition(rowEl, "hero");
      setTimeout(() => clearTransition(rowEl), 700);
    }
    const leaf = isLeaf(state.doc.nodes, node.id);
    if (!leaf || node.parentId === null) go("focus", node.id);
    else go("leaf", node.id);
  },

  startCompose(parentId, afterId = null) {
    if (parentId === null && childrenOf(state.doc.nodes, null).length >= MAX_ROOTS) {
      toast(t("outline.full"));
      return;
    }
    state.compose = { parentId, afterId };
    render("none");
  },

  cancelCompose() {
    if (!state.compose) return;
    state.compose = null;
    render("none");
  },

  commitCompose(title, parentId, mode) {
    const nodes = state.doc.nodes;
    let targetParent = parentId;
    if (mode === "indent") {
      const siblings = childrenOf(nodes, parentId);
      const last = siblings[siblings.length - 1];
      if (last) targetParent = last.id;
    } else if (mode === "outdent") {
      const parent = nodes.find((n) => n.id === parentId);
      targetParent = parent ? parent.parentId : null;
    }
    if (targetParent === null && childrenOf(nodes, null).length >= MAX_ROOTS) {
      toast(t("outline.full"));
      state.compose = null;
      render("none");
      return;
    }
    const rank = childrenOf(nodes, targetParent).length;
    const node = createNode({ title, parentId: targetParent, rank });
    state.compose = mode === "stay" ? null : { parentId: targetParent, afterId: node.id };

    // Indenting or outdenting moves the writing to another level. The view has
    // to follow, or the composer would sit on a screen that cannot show it.
    if (targetParent !== parentId) {
      state.stack.push({ ...state.view });
      state.view = targetParent === null ? { name: "outline", id: null } : { name: "focus", id: targetParent };
      syncHistory();
    }
    mutate((list) => [...list, node]);
  },

  setStatus(id, status) {
    const node = state.doc.nodes.find((n) => n.id === id);
    if (!node) return;
    const now = Date.now();
    mutate(
      (list) => list.map((n) => (n.id === id ? { ...n, status, updatedAt: now } : n)),
      { undoLabel: "status" },
    );
    toast(status === "done" ? t("toast.done") : t("toast.reopened"), t("common.undo"), undo);
  },

  deleteNode(node) {
    mutate((list) => softDelete(list, node.id), { undoLabel: "delete" });
    if (state.view.id === node.id) back();
    toast(t("toast.deleted"), t("common.undo"), undo);
  },

  moveWithinSiblings(node, dir) {
    const siblings = childrenOf(state.doc.nodes, node.parentId);
    const i = siblings.findIndex((n) => n.id === node.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= siblings.length) return;
    const ids = siblings.map((n) => n.id);
    ids.splice(j, 0, ids.splice(i, 1)[0]);
    mutate((list) => reorder(list, node.parentId, ids));
    queueMicrotask(() => {
      const row = appEl.querySelector(`[data-id="${CSS.escape(node.id)}"] .row`);
      if (row) row.focus();
    });
  },

  reorderSibling(node, parentId, index) {
    const pid = parentId === undefined ? node.parentId : parentId;
    const siblings = childrenOf(state.doc.nodes, pid);
    const ids = siblings.map((n) => n.id);
    const from = ids.indexOf(node.id);
    if (from < 0) return;
    ids.splice(index, 0, ids.splice(from, 1)[0]);
    mutate((list) => reorder(list, pid, ids));
  },

  indent(node) {
    const siblings = childrenOf(state.doc.nodes, node.parentId);
    const i = siblings.findIndex((n) => n.id === node.id);
    if (i <= 0) return;
    const newParent = siblings[i - 1];
    mutate((list) => moveNode(list, node.id, newParent.id, childrenOf(list, newParent.id).length));
    toast(t("toast.moved"));
  },

  outdent(node) {
    if (node.parentId === null) return;
    const parent = state.doc.nodes.find((n) => n.id === node.parentId);
    if (!parent) return;
    if (parent.parentId === null && childrenOf(state.doc.nodes, null).length >= MAX_ROOTS) {
      toast(t("outline.full"));
      return;
    }
    const grandParent = parent.parentId;
    const index = childrenOf(state.doc.nodes, grandParent).findIndex((n) => n.id === parent.id) + 1;
    mutate((list) => moveNode(list, node.id, grandParent, index));
    toast(t("toast.moved"));
  },

  updateNode(id, patch) {
    const now = Date.now();
    mutate((list) => list.map((n) => (n.id === id ? { ...n, ...patch, updatedAt: now } : n)), {
      undoLabel: "edit",
    });
  },

  /** `focus` names the field the sheet should open on (leaf add chips). */
  editNode(node, focus) {
    openEditor(layerEl, ctx, node, { focus });
  },

  /** The four questions. Answers land in the node's story as they are given. */
  startStoryGuide(node) {
    openStoryGuide(layerEl, ctx, node);
  },

  // --- the context index ----------------------------------------------------

  get entities() {
    return (state.doc && state.doc.entities) || [];
  },

  entityById: (id) => entityById((state.doc && state.doc.entities) || [], id),

  /** @returns {string|null} the id of the new card */
  addEntity(partial) {
    let id = null;
    mutateEntities((list) => {
      const next = addEntity(list, partial);
      id = next[next.length - 1].id;
      return next;
    });
    return id;
  },

  updateEntity(id, patch) {
    mutateEntities((list) => updateEntity(list, id, patch));
    return id;
  },

  deleteEntity(id) {
    // A card that goes also leaves the steps that pointed at it.
    mutate((list) =>
      list.map((n) =>
        Array.isArray(n.entityRefs) && n.entityRefs.includes(id)
          ? { ...n, entityRefs: n.entityRefs.filter((r) => r !== id), updatedAt: Date.now() }
          : n,
      ),
      { silent: true },
    );
    mutateEntities((list) => deleteEntity(list, id));
  },

  linkEntity(nodeId, entityId) {
    mutate((list) => linkEntity(list, nodeId, entityId));
  },

  toggleEntityLink(nodeId, entityId) {
    const node = state.doc.nodes.find((n) => n.id === nodeId);
    const linked = node && Array.isArray(node.entityRefs) && node.entityRefs.includes(entityId);
    mutate((list) =>
      linked ? unlinkEntity(list, nodeId, entityId) : linkEntity(list, nodeId, entityId),
    );
  },

  /** Open the add/edit sheet. `id` null = a new card, `opts` may prefill it. */
  editEntity(id, opts = {}) {
    entityScreen.openEntitySheet(layerEl, ctx, id ? ctx.entityById(id) : null, opts);
  },

  /** The link picker for one node. */
  pickEntities(node) {
    entityScreen.openEntityPicker(layerEl, ctx, node);
  },

  /** Jump to the index and open that card. */
  openEntity(id) {
    go("entities");
    queueMicrotask(() => ctx.editEntity(id));
  },

  /**
   * "Do not ask about this name again." The memory is a short, capped list of
   * folded names in doc.settings - it travels with the vault, so the question
   * stays answered on every device.
   */
  dismissName(name) {
    const settings = state.doc.settings || {};
    setSettings({ dismissedNames: rememberDismissal(settings.dismissedNames, name) });
    toast(t("entities.dismissed"));
  },

  openRowMenu(node) {
    const nodes = state.doc.nodes;
    const siblings = childrenOf(nodes, node.parentId);
    const i = siblings.findIndex((n) => n.id === node.id);
    // The keep-away switch, and nothing else that has to do with a model. It is
    // no longer gated on assistance being configured: since v1.1 the only route
    // to a model is the copy loop, which has nothing to switch on, so the
    // control that holds a branch back from it must exist unconditionally -
    // the same rule the leaf screen follows. An inherited state is shown there,
    // never toggled here: the switch belongs where it was thrown.
    const keep = ctx.optout(node.id);
    const keepAwayAction = keep.inherited
      ? []
      : [
          {
            label: keep.own ? t("llm.optoutOff") : t("llm.optout"),
            icon: "lock",
            run: () => ctx.toggleOptout(node),
          },
        ];
    const actions = [
      { label: t("common.edit"), icon: "pencil", run: () => ctx.editNode(node) },
      {
        label: node.story ? t("story.continue") : t("story.tell"),
        icon: "mark",
        run: () => ctx.startStoryGuide(node),
      },
      {
        label: node.status === "done" ? t("leaf.markOpen") : t("leaf.markDone"),
        icon: "check",
        run: () => ctx.setStatus(node.id, node.status === "done" ? "open" : "done"),
      },
      { label: t("a11y.moveUp"), icon: "arrowUp", disabled: i <= 0, run: () => ctx.moveWithinSiblings(node, -1) },
      {
        label: t("a11y.moveDown"),
        icon: "arrowDown",
        disabled: i < 0 || i >= siblings.length - 1,
        run: () => ctx.moveWithinSiblings(node, 1),
      },
      ...keepAwayAction,
      { label: t("common.delete"), icon: "trash", danger: true, run: () => ctx.deleteNode(node) },
    ];
    openSheet(layerEl, {
      title: node.title,
      body: el(
        "div",
        {},
        actions.map((a) =>
          el(
            "button",
            {
              class: `setrow${a.danger ? " is-danger" : ""}`,
              attrs: { type: "button", "aria-disabled": a.disabled ? "true" : "false" },
              on: {
                click: () => {
                  if (a.disabled) return;
                  closeSheet();
                  a.run();
                },
              },
            },
            [el("span", { class: "setrow-label" }, [text(a.label)]), icon(a.icon, 18)],
          ),
        ),
      ),
    });
  },

  startDuel(parentId) {
    state.duel = { parentId };
    go("duel", parentId);
  },

  applyOrder(parentId, orderedIds) {
    mutate((list) => reorder(list, parentId, orderedIds));
    state.duel = null;
    const now = Date.now();
    state.doc = { ...state.doc, settings: { ...state.doc.settings, sortedAt: now } };
    scheduleSave();
    toast(t("duel.applied"));
    go("outline", null, { replace: true });
  },

  ancestors: (id) => ancestorsOf(state.doc.nodes, id),
  childrenOf: (parentId) => childrenOf(state.doc.nodes, parentId),
  isLeaf: (id) => isLeaf(state.doc.nodes, id),
  nodeById: (id) => state.doc.nodes.find((n) => n.id === id) || null,

  // --- assistance ----------------------------------------------------------
  //
  // Two things, and no third: open the copy loop, and say whether a node is
  // kept away from models at all. Nothing here talks to a model, because since
  // v1.1 nothing in this app does - the person carries the prompt out and the
  // answer back by hand. There is no mode, no key, no address and nothing to
  // switch on, which is why none of this asks whether assistance is enabled.

  /**
   * The copy loop: a prompt to carry to whatever AI the person already uses,
   * and a field to paste the answer back into.
   */
  aiHelp(node) {
    aihelp.openAiHelp(layerEl, ctx, node);
  },

  /**
   * The same loop with only one half: the WHOLE list as a review prompt, from
   * the outline title. What comes back is prose to read, so there is no way
   * back in - the sheet carries no paste row and this context no importer for
   * it.
   */
  aiHelpTree() {
    aihelp.openAiHelpTree(layerEl, ctx);
  },

  /**
   * Whether a node is kept away from the model, and whether that decision was
   * made here or further up. An inherited state is shown, never toggled: the
   * switch belongs where it was thrown.
   */
  optout(id) {
    const node = state.doc.nodes.find((n) => n.id === id);
    const own = !!(node && node.llmOptout);
    const source = own ? null : ancestorsOf(state.doc.nodes, id).find((a) => a.llmOptout === true);
    return { own, inherited: !!source, source: source ? source.title : "" };
  },

  toggleOptout(node) {
    const on = !node.llmOptout;
    ctx.updateNode(node.id, { llmOptout: on });
    toast(on ? t("llm.optoutSet") : t("llm.optoutCleared"));
  },

  /**
   * One node out of something another app shared into tenfold. Ordinary in
   * every respect - the normal mutate path, `origin: "manual"` - because a
   * person choosing where a shared link belongs is exactly as manual as typing
   * it. The ten-root rule applies here as it does everywhere else.
   *
   * @param {string|null} parentId null = the ten
   * @param {{title: string, note: string}} draft
   * @returns {string|null} the id of the new node
   */
  addSharedNode(parentId, draft) {
    if (!state.doc) return null;
    const nodes = state.doc.nodes;
    if (parentId === null && childrenOf(nodes, null).length >= MAX_ROOTS) {
      toast(t("outline.full"));
      return null;
    }
    const now = Date.now();
    const node = createNode({
      title: draft.title,
      note: draft.note || "",
      parentId,
      rank: childrenOf(nodes, parentId).length,
      createdAt: now,
      updatedAt: now,
    });
    mutate((list) => [...list, node]);
    return node.id;
  },

  /**
   * A hierarchy somebody accepted out of a pasted answer. The levels become
   * parents: a line at the outer margin hangs under `parentId` (null = the
   * ten), every deeper line under the last line one level above it. Ordinary
   * nodes, one mutation, origin "llm" on all of them - the answer did come
   * from a model, and the provenance mark says so however it arrived.
   *
   * The ten-root rule is enforced here as well, not only in the sheet that
   * offered the lines: a line that would be the eleventh goal is dropped, and
   * everything written under it goes with it. Two guards for one invariant is
   * the right number when the invariant is the whole method.
   *
   * @param {string|null} parentId
   * @param {{title: string, level: number}[]} items
   */
  importTree(parentId, items) {
    const now = Date.now();
    mutate((list) => {
      const made = [];
      /** The last node created at each level - the parent of the next level. */
      const open = [];
      /** Next rank per parent id; a fresh parent starts its children at zero. */
      const ranks = new Map();
      const key = (id) => (id === null ? " root" : id);
      const nextRank = (pid) => {
        const k = key(pid);
        if (!ranks.has(k)) ranks.set(k, childrenOf(list, pid).length);
        const rank = ranks.get(k);
        ranks.set(k, rank + 1);
        return rank;
      };
      let roots = parentId === null ? childrenOf(list, null).length : 0;
      /** Everything under a dropped line is dropped: the depth it starts at. */
      let dropped = -1;

      for (const item of items) {
        const level = Math.max(0, Math.min(3, Math.trunc(Number(item.level) || 0)));
        if (dropped >= 0 && level > dropped) continue;
        dropped = -1;
        if (parentId === null && level === 0 && roots >= MAX_ROOTS) {
          dropped = level;
          continue;
        }
        const pid = level === 0 ? parentId : open[level - 1] === undefined ? parentId : open[level - 1];
        const node = createNode({
          title: item.title,
          parentId: pid,
          rank: nextRank(pid),
          origin: "llm",
          createdAt: now,
          updatedAt: now,
        });
        if (pid === null) roots += 1;
        open.length = level;
        open[level] = node.id;
        made.push(node);
      }
      return [...list, ...made];
    });
  },

  // --- vault lifecycle used by setup.js and lock.js -------------------------

  async createVaultWith(passphrase) {
    const { vault, recoveryKey, masterKey } = await createVault({ passphrase });
    state.vault = vault;
    state.masterKey = masterKey;
    state.doc = upgradeDoc(await openFromVault(vault, masterKey));
    // A language chosen on the welcome screen (localStorage pref) must win
    // over browser detection when the vault is created.
    const prefLang = readUiPrefs().lang;
    state.doc = {
      ...state.doc,
      settings: {
        ...state.doc.settings,
        lang: LOCALES.includes(prefLang) ? prefLang : detectLocale(),
        skin: "slate",
        theme: "dark",
        // The vault's birthday, written at the one moment that knows it for
        // certain. Everything that asks how old this vault is reads this, and
        // a document that predates the stamp gets one backfilled on unlock.
        createdAt: Date.now(),
      },
    };
    applyPresentation(state.doc.settings);
    await flushSave();
    const p = await requestPersistence();
    state.persisted = p;
    touchIdle();
    return recoveryKey;
  },

  seedTemplate(titles) {
    const now = Date.now();
    const nodes = titles.map((title, i) =>
      createNode({ title, parentId: null, rank: i, createdAt: now, updatedAt: now }),
    );
    mutate((list) => [...list, ...nodes], { silent: true });
  },

  async unlock(secret, kind) {
    if (!state.vault) throw new VaultUnlockError();
    const key =
      kind === "recovery"
        ? await unlockWithRecoveryKey(state.vault, secret)
        : await unlockWithPassphrase(state.vault, secret);
    await openWithMasterKey(key);
  },

  /**
   * The device's own authenticator instead of the passphrase. Everything after
   * the key arrives is identical - the app cannot tell which envelope opened
   * the vault, and does not need to.
   */
  async unlockBiometric() {
    if (!state.vault) throw new VaultUnlockError();
    const key = await webauthn.unlock(state.vault);
    await openWithMasterKey(key);
  },

  /**
   * The same thing one layer down, inside the native shell: the shell holds the
   * key behind Face ID, the page unwraps with it. The sentence the system
   * prompt shows is handed over from here, in the language the app is showing -
   * the shell holds no catalogue and must not grow one.
   *
   * Errors carry a code (bio.js CODES) and the lock screen decides what, if
   * anything, to say. Everything after the key arrives is identical to a
   * passphrase unlock.
   */
  async unlockShellBio() {
    if (!state.vault) throw new VaultUnlockError();
    const key = await bio.unlock(state.vault, t("bio.reason"));
    await openWithMasterKey(key);
  },

  /**
   * Face ID / Touch ID as one more envelope. The wrapper travels inside the
   * vault, so it reaches the other devices through sync - but the credential
   * behind it is device-local, and each device carries its own label, so
   * turning it off here cannot lock another device out.
   */
  biometric: {
    get supported() {
      return webauthn.supported();
    },
    /** null until the platform has been asked - the screens repaint on the answer. */
    get availableCached() {
      return webauthn.platformAvailableCached();
    },
    available: () => webauthn.platformAvailable(),
    get enrolled() {
      return webauthn.enrolled(state.vault);
    },
    async enrol() {
      if (!state.vault || !state.masterKey) throw new Error("vault is locked");
      state.vault = await webauthn.enrol(state.vault, state.masterKey);
      // flushSave re-seals the payload into the vault we just extended, so the
      // new wrapper is stored and pushed with the same cycle as any edit.
      await flushSave();
    },
    async remove() {
      if (!state.vault) return;
      state.vault = await webauthn.revoke(state.vault);
      if (state.masterKey && state.doc) await flushSave();
      else await saveVault(state.vault);
    },
  },

  /**
   * The shell's own biometric envelope. Same shape as `biometric` above, on
   * purpose: the two are alternatives, never both on offer, and the screens
   * that draw them should not have to learn two vocabularies.
   *
   * `supported` is the capability, `available()` is the device right now
   * (hardware and enrolment are two facts), `enabled` is this vault carrying
   * this device's wrapper. Turning it on writes a wrapper and saves; turning it
   * off removes the wrapper here and the key over there.
   */
  shellBio: {
    get supported() {
      return bio.supported();
    },
    /** null until the shell has been asked - the screens repaint on the answer. */
    get availableCached() {
      return bio.availableCached();
    },
    available: () => bio.available(),
    get enabled() {
      return bio.enabled(state.vault);
    },
    /** The lock screen hides the button after an outcome that cannot improve. */
    get hidden() {
      return bio.offerHidden();
    },
    get lastCode() {
      return bio.lastCode();
    },
    /** True after an enrolment change, until it is armed again or turned off. */
    get setupAgain() {
      return bio.needsSetupAgain();
    },
    async enable() {
      if (!state.vault || !state.masterKey) throw new Error("vault is locked");
      state.vault = await bio.enable(state.vault, state.masterKey);
      // flushSave re-seals the payload into the vault we just extended, so the
      // new wrapper is stored and pushed with the same cycle as any edit.
      await flushSave();
    },
    async remove() {
      if (!state.vault) return;
      state.vault = await bio.disable(state.vault);
      if (state.masterKey && state.doc) await flushSave();
      else await saveVault(state.vault);
    },
  },

  /**
   * The lock screen's offer to arm one of the two above, and the whole of its
   * state: has it been waved away for good, and is a wish waiting.
   *
   * `dismissed` is read from the UI preferences (see BIO_OFFER_PREF for why it
   * is there and not in the document) and is permanent - one no ends the offer
   * on this device. `arm()` records which of the two paths the lock screen was
   * looking at; `enrolAfterUnlock` spends it at the next unlock, because that
   * is the first moment a master key exists to wrap.
   */
  bioOffer: {
    get dismissed() {
      return readUiPrefs()[BIO_OFFER_PREF] === true;
    },
    dismiss() {
      writeUiPrefs({ ...readUiPrefs(), [BIO_OFFER_PREF]: true });
    },
    get armed() {
      return state.bioOfferWish !== null;
    },
    arm(kind) {
      state.bioOfferWish = kind === "prf" ? "prf" : "shell";
    },
  },

  /**
   * The spare copy in the app container, for the one row in settings that
   * reports on it. Read-only on purpose: nothing on a screen writes or deletes
   * a mirror - `flushSave` writes it and `vault.wiped` removes it - so what a
   * screen gets is a status and nothing to press.
   */
  mirror: {
    get supported() {
      return mirrorAvailable();
    },
    /** null until the shell has been asked - the row repaints on the answer. */
    get statusCached() {
      return mirrorStatusCached();
    },
    status: () => mirrorStatus(),
  },

  async setVault(vault) {
    state.vault = vault;
    await saveVault(vault);
    // The one other place a whole vault is written, and the only one besides
    // `flushSave` that needs the mirror: an import REPLACES the vault, and it
    // does it with the vault locked, so there is no seal-and-save cycle
    // following it. Without this line the spare copy would still be the vault
    // that was just replaced - and a person who imported a file and then lost
    // their IndexedDB would be handed back the list they had imported over.
    // The bio wrapper writes further up are a different case and deliberately
    // left alone: they change which envelopes open the vault, not what is in
    // it, and the next save carries them.
    writeMirror(vault).catch(() => {});
    state.masterKey = null;
    state.doc = null;
    state.stack = [];
    state.view = { name: "lock", id: null };
    syncHistory();
    render();
  },

  async refreshPersistence() {
    state.persisted = await requestPersistence();
    return state.persisted;
  },

  // --- sync surface for the UI ---------------------------------------------

  /**
   * Everything the settings and setup screens need. The screens never see the
   * master key or a URL; they ask for a status, a code, or an action.
   */
  sync: {
    get meta() {
      return sync.syncMeta(state.vault);
    },
    get enabled() {
      return sync.syncMeta(state.vault) !== null;
    },
    get status() {
      return sync.snapshot();
    },
    pairingCode: () => sync.pairingCode(state.vault),
    pairingUrl: () => sync.pairingUrl(state.vault),
    enable: () => sync.enableSync(syncCtx),
    disable: () => sync.disableSync(syncCtx),
    pushNow: () => sync.push(syncCtx),
    /** Fetch a vault by pairing code and put it on this device. */
    async adopt(code) {
      const vault = await sync.adopt(code);
      await ctx.setVault(vault);
    },
  },

  /**
   * The daily reminder. Optional, off by default, and only offered when sync
   * is on - the server has to know which vault a subscription belongs to, and
   * the write token is what proves it may.
   */
  push: {
    get status() {
      return push.snapshot();
    },
    /**
     * Would a permission prompt lead anywhere in THIS window? False in an iOS
     * browser tab, where only the installed home-screen app ever receives a
     * push - the first run says so instead of asking for nothing.
     */
    get usableHere() {
      return push.usableHere();
    },
    /** Re-read the browser truth; resolves to true when something changed. */
    refresh: () => push.refresh(),
    enable: (hour) => push.enablePush(syncCtx, hour),
    disable: () => push.disablePush(syncCtx),
  },

  /** Write a Blob to disk. Local only - no upload, no network. */
  download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = el("a", { attrs: { href: url, download: filename } });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },
};

// ------------------------------------------------------------- sync context

/**
 * The narrow context sync.js works with. It carries the master key, which the
 * screen-facing ctx deliberately does not: merging a remote copy means
 * decrypting it, and that has to happen somewhere.
 */
const syncCtx = {
  get vault() {
    return state.vault;
  },
  get masterKey() {
    return state.masterKey;
  },
  get doc() {
    return state.doc;
  },

  /** Result of a merge: becomes the open document, is sealed and repainted. */
  async applyMerged(doc) {
    if (!state.doc || !state.masterKey) return;
    state.doc = upgradeDoc(doc);
    applyPresentation(state.doc.settings || {});
    setBadge(state.doc);
    await flushSave({ fromSync: true });
    render("none");
  },

  /** Write or drop the non-secret sync metadata on the vault. */
  async setSyncMeta(meta) {
    if (!state.vault) return;
    const next = { ...state.vault };
    if (meta) next.sync = { id: meta.id, authSalt: meta.authSalt };
    else delete next.sync;
    state.vault = next;
    await flushSave({ fromSync: true });
  },
};

sync.bindContext(syncCtx);
// A status change only matters while the settings screen is on screen; the
// outline stays calm on purpose.
sync.onSyncChange(() => {
  if (state.view.name === "settings" && state.doc) render("none");
});

/**
 * Pull before the outline appears when the server answers quickly, otherwise
 * paint first and reconcile in the background. A sync must never be the reason
 * the app feels slow.
 */
async function pullOnEntry() {
  if (!sync.syncMeta(state.vault) || !state.masterKey) return;
  const pulling = sync.pull(syncCtx).catch(() => "offline");
  const settle = (outcome) => {
    if (outcome === "merged") sync.push(syncCtx);
  };
  const raced = await Promise.race([
    pulling,
    new Promise((r) => setTimeout(() => r("slow"), 800)),
  ]);
  if (raced === "slow") pulling.then(settle);
  else settle(raced);
}

// ---------------------------------------------------------------- global keys

document.addEventListener("keydown", (ev) => {
  touchIdle();
  // The desktop way into the short list. In a browser tab Cmd/Ctrl+T belongs
  // to the browser and never reaches us; in the installed app it does, and the
  // header button works everywhere.
  if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && (ev.key === "t" || ev.key === "T")) {
    if (state.doc && !isSheetOpen()) {
      ev.preventDefault();
      if (state.view.name !== "today") go("today");
    }
    return;
  }
  // The desktop way into the map. A bare letter, so it must never fire while
  // something is being written - the composer and every sheet field would
  // otherwise lose an "m".
  if ((ev.key === "m" || ev.key === "M") && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
    const el0 = ev.target;
    const typing =
      el0 &&
      (el0.isContentEditable ||
        el0.tagName === "INPUT" ||
        el0.tagName === "TEXTAREA" ||
        el0.tagName === "SELECT");
    if (state.doc && !typing && !isSheetOpen()) {
      ev.preventDefault();
      if (state.view.name !== "map") go("map");
    }
    return;
  }
  if (ev.key === "Escape") {
    if (isSheetOpen()) {
      closeSheet();
      return;
    }
    if (state.doc && state.view.name !== "outline") back();
  }
});
["pointerdown", "wheel", "touchstart"].forEach((type) =>
  document.addEventListener(type, touchIdle, { passive: true }),
);
// A pairing link opened while the app is already running (still locked, or on
// the welcome screen). An unlocked session is left alone on purpose: the
// fragment is stripped, nothing is fetched, nothing is replaced.
window.addEventListener("hashchange", () => {
  const code = takePairingFromFragment();
  if (code && !state.doc) handlePairing(code);
});
window.addEventListener("pagehide", () => {
  flushSave();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushSave();
});

// ----------------------------------------------------------------- bootstrap

/**
 * Reads a pairing code out of the URL fragment and removes it immediately.
 * A fragment is never sent to a server by the browser, and it does not stay in
 * the address bar either - a link that was shared once should not linger in a
 * screenshot or a bookmark.
 * @returns {string|null} the normalised sync id
 */
function takePairingFromFragment() {
  const hash = location.hash || "";
  if (!hash.startsWith("#s=")) return null;
  let code = null;
  try {
    code = sync.normaliseSyncId(hash);
  } catch {
    code = null;
  }
  // history.state is carried over: this strips the fragment, it does not hand
  // the entry back to somebody else.
  history.replaceState(history.state, "", location.pathname + location.search);
  return code;
}

/** A pairing link was opened. What happens depends on what is on this device. */
async function handlePairing(code) {
  const local = sync.syncMeta(state.vault);
  if (local && local.id === code) return; // already this vault
  if (state.vault) {
    // Adopting would replace the vault that is already here, so it needs a
    // deliberate press, not a link.
    setupScreen.prime(code, true);
    state.view = { name: "setup", id: null };
    syncHistory();
    render();
    return;
  }
  try {
    await ctx.sync.adopt(code);
    toast(t("sync.adoptDone"));
  } catch (err) {
    setupScreen.prime(code, false, err && err.code ? err.code : "offline");
    state.view = { name: "setup", id: null };
    syncHistory();
    render();
  }
}

/**
 * The notification opens the app at ?view=today. The parameter is read once
 * and removed immediately, so a reload or a bookmark does not keep forcing the
 * screen - and it never carries anything but that one fixed word.
 */
function takePendingView() {
  const params = new URLSearchParams(location.search);
  const view = params.get("view");
  if (view === null) return null;
  params.delete("view");
  const query = params.toString();
  history.replaceState(
    history.state,
    "",
    `${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
  );
  return view === "today" ? "today" : null;
}

/**
 * IndexedDB is empty. Ask the shell whether it is holding the spare copy, and
 * if it is, put it back.
 *
 * When this runs at all: only where `loadVault()` returned nothing. IndexedDB
 * is the vault and the mirror is the spare, so the spare is never consulted
 * while there is anything to consult it against - a boot with both present is a
 * boot that never asks, which is also the only ordering under which the two can
 * never disagree about which is newer.
 *
 * Why there is no confirmation prompt, and why this is safe WITHOUT one:
 *
 * The failure mode this has to not have is a vault reappearing after somebody
 * deliberately destroyed it. Everything rests on that, and nothing else does -
 * an eviction and a wipe leave IndexedDB in exactly the same state, so this
 * function cannot tell them apart and must not try. What tells them apart is
 * what the SHELL was told: every path in this app that destroys the vault ends
 * in `wipeLocalVault()`, which sends `vault.wiped` BEFORE it clears anything,
 * and the shell deletes the mirror on that message together with the biometric
 * Keychain item. So after a wipe there is nothing here to find, and the only
 * thing left to find is a copy of a vault nobody asked to lose.
 *
 * A prompt was the obvious alternative and is worse. The question would be
 * "your list is gone, here is a copy from Tuesday - restore it?", asked of
 * somebody who has no way of knowing why it is gone, at the one moment they are
 * least able to evaluate it. Answering no destroys the last copy; answering yes
 * is what the app would have done anyway. A question with one sensible answer
 * teaches people to tap through questions, and the next one might matter.
 *
 * The vault comes back LOCKED, like every other vault at every other start.
 * Nothing is decrypted here and nothing could be: this is ciphertext arriving
 * from a file, and the passphrase is still the only way in.
 *
 * @returns {Promise<Object|null>} the adopted VaultFile, or null
 */
async function adoptMirror() {
  // In a browser `readMirror()` is null without a round trip. Inside the shell
  // it is one local file read behind `shellSend`'s own timeout, on a path that
  // only runs when there is no vault to show anyway - a first run pays a few
  // milliseconds before the setup screen.
  const copy = await readMirror();
  if (!copy) return null;
  let vault;
  try {
    // The import path, not a second reader: this is a `.tenfold` file's bytes,
    // so it goes through the same validation - magic, version, wrappers - that
    // a file picked from settings does. A mirror that fails it is a mirror
    // worth nothing, and dropping it silently is right: there is no vault, so
    // there is nothing this could have damaged and nothing to report to.
    vault = await importEncrypted(copy.blob);
  } catch {
    return null;
  }
  try {
    // Written back immediately rather than merely shown. An adopted vault that
    // stayed only in memory would be gone again at the next reload, and the
    // person would have unlocked a list that never came back.
    await saveVault(vault, { now: typeof copy.savedAt === "number" ? copy.savedAt : Date.now() });
  } catch {
    // IndexedDB refused the write. The vault is still usable for this session,
    // which is better than the empty setup screen the alternative would be.
  }
  return vault;
}

async function boot() {
  const prefs = readUiPrefs();
  setLocale(LOCALES.includes(prefs.lang) ? prefs.lang : detectLocale());
  document.documentElement.setAttribute("lang", getLocale());
  push.rememberLocale(getLocale());
  // The four tab labels, before the first `nav.state` below: a shell that is
  // about to be told which tab is current should already know what the four of
  // them are called. Subscribes to the locale for the rest of the session, so a
  // language change re-titles the native bar in the same frame as the app's own
  // headings. In a browser, and in a shell that does not advertise `nav`, this
  // is one subscription that posts nothing.
  //
  // The callbacks are the other direction: a tab was tapped, or the left edge
  // was swiped. `nav.js` has already decided what the wire said - that the tab
  // exists, which screen is its root, that the reason is one of three;
  // everything below is about what the app is currently DOING, which is state
  // this module owns and that one deliberately holds none of.
  startShellNav(
    ({ root, reason }) => {
      // Nothing to route into. The bar is not drawn on these screens either, so
      // this is the pair being briefly out of step rather than a tap somebody
      // made - and a silent drop is the honest answer to both.
      if (!state.doc) return;
      if (state.view.name === "setup" || state.view.name === "lock") return;

      if (reason === "tab-again") {
        // The tab that is already showing. Deep inside it, collapse to its root;
        // already at the root, do nothing at all. Not scroll-to-top: that would
        // be a fourth behaviour needing a fifth message to reach the scroll
        // container, and "nothing" is an answer somebody learns in one try.
        if (!state.stack.length) return;
        landOn(root);
        return;
      }

      // A sheet is closed from HERE rather than by the shell, and before the
      // route rather than after it: both happen in one task, which costs one
      // history traversal instead of two. Immediately, because the quarter
      // second a sheet takes to slide away would play over the screen it was
      // asked to leave.
      if (isSheetOpen()) closeSheet({ immediate: true });
      landOn(root);
    },
    () => {
      // The same two drops as a tab tap, for the same reason and in the same
      // order: there is nothing to go back inside, and the gesture is not armed
      // on those screens either, so a swipe arriving here is the two
      // repositories being briefly out of step rather than something somebody
      // did.
      if (!state.doc) return;
      if (state.view.name === "setup" || state.view.name === "lock") return;
      navBack();
    },
  );
  state.pendingView = takePendingView();
  const pairing = takePairingFromFragment();
  try {
    state.vault = await loadVault();
  } catch {
    state.vault = null;
  }
  if (!state.vault) state.vault = await adoptMirror();
  state.savedAt = state.vault ? await lastSavedAt().catch(() => null) : null;
  state.view = state.vault ? { name: "lock", id: null } : { name: "setup", id: null };
  // A reload always lands here, on the entry the page was loaded with: marked
  // as ours, never pushed. That is what keeps a reload free of history
  // weirdness - the lock screen is the bottom of the app's own stack, and a
  // back press from it leaves the app, as it should.
  syncHistory();
  render();

  // The native shell's share hand-off. Registered here, before anything is
  // unlocked, because the shell waits for this listener to exist before it
  // gives up its copy - and because a share can arrive at any moment, not only
  // during an unlock. Parking the item is all that happens now; the offer
  // sheet is the same one the Android share target gets, and it only opens
  // over an open document.
  startShellShareInbox(() => {
    // Not over another sheet. Something the person is already in the middle of
    // outranks something that arrived a second ago; the item stays parked and
    // is offered at the next unlock, which is the same rule closing this sheet
    // with the X follows.
    if (isSheetOpen()) return;
    offerShare();
  });

  // The shell's own deadline. It measures how long the app was away from the
  // foreground - natively, because a backgrounded page cannot time itself - and
  // asks for the vault to be closed when that is past. Registered here for the
  // same reason the share inbox is: the message can arrive at any moment, and
  // registering it once, unconditionally, is cheaper than a capability nobody
  // would ever answer no to. In a browser it is one listener that never fires.
  //
  // Three moments where there is nothing to close, and all three have to be
  // silent rather than clever:
  //
  //   no document   already locked, or never unlocked. The lock screen is
  //                 where this would put somebody, and they are on it.
  //   setup         `createVaultWith` opens a document while the first run is
  //                 still going, so "a document exists" is not the same
  //                 question as "the app is in use". Locking here would take
  //                 away the recovery key screen before it had been read, and
  //                 that is the one screen this app cannot show twice.
  //   the lock view the same fact from the other side, and cheap to state.
  //
  // `lock(false)` and not `lock(true)`: the auto flag exists to put "locked
  // after fifteen minutes without activity" on the screen, and this was not
  // that. It was a minute in the background - a different sentence, and the
  // wrong one is a lie, so the plain lock with its one-word toast is used.
  startShellVaultLock(() => {
    if (!state.doc) return;
    if (state.view.name === "setup" || state.view.name === "lock") return;
    lock(false);
  });

  if (pairing) await handlePairing(pairing);

  if ("serviceWorker" in navigator && !navigator.webdriver && location.protocol !== "file:") {
    // Registered outside the test runner: a cached shell would otherwise hide
    // source changes from Playwright between runs.
    //
    // Updates apply THEMSELVES. Without this, a deploy only reaches a device
    // on the SECOND reload: the first one still serves from the old cache
    // while the new worker installs in the background - the owner sat on a
    // week-old map wondering why nothing changed. When the new worker takes
    // control the page reloads once, immediately; the guard stops any loop.
    // The reload does NOT wait for idle: an unlocked vault is sealed on disk
    // at every debounced save, so the worst a reload costs is the last 600ms
    // of typing, and an update that waits for a quiet moment on a phone that
    // is never quiet is an update that never lands.
    // On the very first visit clients.claim() also fires controllerchange -
    // that is adoption, not an update, and must not reload a fresh page.
    const hadController = !!navigator.serviceWorker.controller;
    let reloadedForUpdate = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloadedForUpdate || !navigator.serviceWorker.controller) return;
      reloadedForUpdate = true;
      location.reload();
    });
    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => {
        // Ask for a fresh check on every return to the app, not only on
        // navigation - an installed PWA can live for days without one.
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") reg.update().catch(() => {});
        });
      })
      .catch(() => {});
  }
}

boot();

export { ctx };
