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
import { loadVault, saveVault, requestPersistence, lastSavedAt } from "./store.js";
import {
  createNode,
  childrenOf,
  ancestorsOf,
  isLeaf,
  moveNode,
  reorder,
  softDelete,
  upgradeDoc,
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
import { t, setLocale, detectLocale, getLocale, LOCALES } from "./i18n.js";
import { transition, nameTransition, clearTransition, clearAllTransitionNames } from "./motion.js";
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
import { openSheet, closeSheet, isSheetOpen } from "./ui/sheet.js";
import { openEditor } from "./ui/editor.js";
import { openStoryGuide } from "./ui/storyguide.js";

/** Minutes of inactivity after which the document is wiped from memory. */
export const IDLE_LOCK_MS = 15 * 60 * 1000;
const AUTOSAVE_MS = 600;
const MAX_ROOTS = 10;
const UI_PREF_KEY = "tenfold.ui";
export const APP_VERSION = "0.1.0";

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
    await saveVault(sealed);
    state.savedAt = Date.now();
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

async function lock(auto = false) {
  await flushSave();
  // Sync stops at the lock: without the master key nothing could be merged,
  // and a timer firing behind the lock screen would only produce errors.
  sync.resetSync();
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
  closeSheet();
  clearTimeout(idleTimer);
  state.view = { name: "lock", id: null };
  render();
  if (!auto) toast(t("toast.locked"));
}

// -------------------------------------------------------------------- toasts

function toast(message, actionLabel, action) {
  clearTimeout(toastTimer);
  clear(toastEl);
  toastEl.appendChild(el("span", {}, [text(message)]));
  if (actionLabel && action) {
    toastEl.appendChild(
      el("button", { attrs: { type: "button" }, on: { click: () => { hideToast(); action(); } } }, [
        text(actionLabel),
      ]),
    );
  }
  toastEl.classList.add("is-open");
  toastTimer = setTimeout(hideToast, actionLabel ? 8000 : 2600);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastEl.classList.remove("is-open");
}

function live(message) {
  liveEl.textContent = message;
}

// ------------------------------------------------------------------- routing

function go(name, id = null, opts = {}) {
  if (!SCREENS[name]) return;
  if (opts.replace) state.stack = [];
  else if (state.view.name !== name || state.view.id !== id) state.stack.push({ ...state.view });
  state.view = { name, id };
  state.compose = null;
  render(opts.direction || "in");
}

function back() {
  const prev = state.stack.pop();
  if (prev) {
    state.view = prev;
  } else if (state.doc) {
    state.view = { name: "outline", id: null };
  }
  state.compose = null;
  render("out");
}

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

function setSettings(patch) {
  if (!state.doc) return;
  state.doc = { ...state.doc, settings: { ...state.doc.settings, ...patch } };
  applyPresentation(state.doc.settings);
  scheduleSave();
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
  idleMinutes: Math.round(IDLE_LOCK_MS / 60000),
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
   * The way into the outline after a successful unlock or setup. The very
   * first time a vault is entered, the About text is offered for reading -
   * once dismissed it never appears uninvited again (flag in doc.settings,
   * so the decision travels with the vault).
   */
  async enterApp() {
    // With sync on, the remote copy is folded in before the list appears -
    // unless the server is slow, in which case the list wins and the merge
    // arrives a moment later.
    await pullOnEntry();
    if (state.doc && !state.doc.settings.aboutRead) {
      state.introAbout = true;
      state.view = { name: "about", id: null };
      state.stack = [];
      render();
      return;
    }
    // Arrived through the notification: the outline stays underneath, so the
    // close button on Today lands where it always does.
    if (state.pendingView === "today") {
      state.pendingView = null;
      state.view = { name: "outline", id: null };
      state.stack = [];
      ctx.go("today");
      return;
    }
    ctx.go("outline", null, { replace: true });
  },

  finishIntro() {
    state.introAbout = false;
    state.view = { name: "outline", id: null };
    state.stack = [];
    if (state.pendingView === "today") {
      state.pendingView = null;
      state.view = { name: "today", id: null };
      state.stack = [{ name: "outline", id: null }];
    }
    setSettings({ aboutRead: true });
    // Persist immediately - the debounced autosave loses this flag when the
    // page is closed right after the intro, and the intro would reappear.
    flushSave();
  },
  openSheet: (spec) => openSheet(layerEl, spec),
  closeSheet,
  maxRoots: MAX_ROOTS,

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

  editNode(node) {
    openEditor(layerEl, ctx, node);
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
    state.masterKey = key;
    // Every document that comes out of the vault is lifted to the current
    // schema right here, before any screen or merge can see it. Invisible:
    // an old vault simply has empty stories and an empty index.
    state.doc = upgradeDoc(await openFromVault(state.vault, key));
    state.autoLocked = false;
    applyPresentation(state.doc.settings || {});
    state.savedAt = await lastSavedAt();
    touchIdle();
  },

  async setVault(vault) {
    state.vault = vault;
    await saveVault(vault);
    state.masterKey = null;
    state.doc = null;
    state.stack = [];
    state.view = { name: "lock", id: null };
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
  history.replaceState(null, "", location.pathname + location.search);
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
    render();
    return;
  }
  try {
    await ctx.sync.adopt(code);
    toast(t("sync.adoptDone"));
  } catch (err) {
    setupScreen.prime(code, false, err && err.code ? err.code : "offline");
    state.view = { name: "setup", id: null };
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
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  return view === "today" ? "today" : null;
}

async function boot() {
  const prefs = readUiPrefs();
  setLocale(LOCALES.includes(prefs.lang) ? prefs.lang : detectLocale());
  document.documentElement.setAttribute("lang", getLocale());
  push.rememberLocale(getLocale());
  state.pendingView = takePendingView();
  const pairing = takePairingFromFragment();
  try {
    state.vault = await loadVault();
  } catch {
    state.vault = null;
  }
  state.savedAt = state.vault ? await lastSavedAt().catch(() => null) : null;
  state.view = state.vault ? { name: "lock", id: null } : { name: "setup", id: null };
  render();

  if (pairing) await handlePairing(pairing);

  if ("serviceWorker" in navigator && !navigator.webdriver && location.protocol !== "file:") {
    // Registered outside the test runner: a cached shell would otherwise hide
    // source changes from Playwright between runs.
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

boot();

export { ctx };
