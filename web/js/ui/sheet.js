// ui/sheet.js - the one modal surface: a sheet that rises from the bottom.
//
// What it does: mounts a scrim plus a panel into the overlay layer, animates
// both in and out, returns focus to whatever was focused before, and keeps
// Tab inside the panel while it is open.
//
// What it deliberately does NOT do: no stacking of sheets (one at a time, on
// purpose - a sheet on a sheet on a phone is a dead end), no innerHTML, no
// content of its own beyond the grip, the title row and the close button.
//
// It also owns the keyboard. Owner report: "Click auf Tell the Story -
// Eingabefeld taucht hinter Keyboard auf. Ich muss rauf scrollen." On iOS the
// software keyboard does NOT shrink the layout viewport - it is drawn OVER the
// page, so a sheet pinned to the bottom keeps sitting exactly where the keys
// now are. The visual viewport is the only thing that knows: it shrinks, and
// the difference between the two is the height of what is covering the screen.
// Every sheet in this app is built here, so the lift is here too, once - the
// story guide, the editor, the pairing sheet and the paste field all inherit
// it without knowing that they do.

import { el, text, icon } from "./dom.js";
import { t } from "../i18n.js";
import { prefersReducedMotion } from "../motion.js";

let openState = null;

/**
 * Fewer hidden pixels than this are not a keyboard. A browser toolbar sliding
 * in and out, a rounding difference between the two viewports and the rubber
 * band at the end of a scroll all land in single or low double digits; a
 * keyboard never does. Without this floor the sheet would twitch upwards every
 * time the address bar breathed.
 */
export const KEYBOARD_MIN = 60;

/**
 * The most of the frame a keyboard is allowed to be worth. A keyboard on a
 * phone in landscape reaches roughly two thirds; past three quarters the number
 * is not a keyboard any more but something wrong, and lifting the sheet by it
 * would fling it off the top of the screen. The cap is a floor under the
 * failure, never a shape anybody sees.
 */
export const MAX_LIFT_RATIO = 0.75;

/**
 * How far a bottom-pinned sheet has to rise to clear whatever is covering the
 * bottom of the screen. Pure on purpose: this is the whole arithmetic of the
 * fix, and it can be checked without a keyboard, a phone or a browser.
 *
 * `offsetTop` matters as much as the height does: a page scrolled inside the
 * visual viewport - which is what iOS does when it "reveals" a focused field -
 * moves the visual viewport DOWN over the layout one, and the covered strip is
 * then what is left below it, not the raw difference of the two heights.
 *
 * @param {number} layoutHeight window.innerHeight - the viewport CSS lays out in
 * @param {number} viewportHeight visualViewport.height - what is actually visible
 * @param {number} offsetTop visualViewport.offsetTop
 * @returns {number} pixels to translate the sheet upwards, 0 for "nothing to do"
 */
export function liftFor(layoutHeight, viewportHeight, offsetTop) {
  const layout = Number(layoutHeight);
  const visual = Number(viewportHeight);
  const top = Number(offsetTop);
  if (!Number.isFinite(layout) || !Number.isFinite(visual) || layout <= 0 || visual <= 0) return 0;
  const covered = layout - visual - (Number.isFinite(top) ? top : 0);
  if (!Number.isFinite(covered) || covered < KEYBOARD_MIN) return 0;
  return Math.round(Math.min(covered, layout * MAX_LIFT_RATIO));
}

/**
 * Keep the field somebody is typing in on screen. The lift alone puts the
 * BOTTOM of the sheet above the keyboard; a long sheet can still have the
 * focused control scrolled out of its own body. So: nearest, inside the sheet
 * body, never the page - the frame is `overflow: clip` and has no scroll of its
 * own precisely so that nothing can slide the whole app to reveal a field.
 */
function keepFocusInView(sheet) {
  const active = document.activeElement;
  if (!active || !sheet.contains(active) || typeof active.getBoundingClientRect !== "function") return;
  const body = sheet.querySelector(".sheet-body");
  if (!body || !body.contains(active)) return;
  const field = active.getBoundingClientRect();
  const frame = body.getBoundingClientRect();
  if (field.bottom <= frame.bottom && field.top >= frame.top) return;
  if (typeof active.scrollIntoView === "function") {
    active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

/**
 * Watch the visual viewport for as long as one sheet is open.
 *
 * @param {HTMLElement} sheet
 * @returns {(() => void)|null} the release, or null where there is nothing to watch
 */
function watchKeyboard(sheet) {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  // Every browser without the API keeps exactly the behaviour it had: no
  // listener, no transform, no lift. That is most desktop cases and all of the
  // older ones, and on those the keyboard was never the problem.
  if (!vv || typeof vv.addEventListener !== "function") return null;
  if (prefersReducedMotion()) sheet.classList.add("is-still");

  let last = -1;
  const apply = () => {
    const lift = liftFor(window.innerHeight, vv.height, vv.offsetTop);
    if (lift !== last) {
      last = lift;
      sheet.style.setProperty("--kb-lift", `${lift}px`);
      sheet.classList.toggle("is-lifted", lift > 0);
    }
    // Checked on every event, not only on a change: the sheet can scroll under
    // a standing keyboard while the lift itself stays exactly where it was.
    if (lift > 0) requestAnimationFrame(() => keepFocusInView(sheet));
  };

  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  // A sheet opened while a keyboard is already up starts lifted, without a
  // frame in the wrong place first.
  apply();

  return () => {
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
    sheet.style.removeProperty("--kb-lift");
    sheet.classList.remove("is-lifted", "is-still");
  };
}

/**
 * Listeners for "a sheet went up / came down". app.js uses this to keep the
 * browser history in step: an open sheet owns one history entry, so a back
 * gesture closes the sheet instead of leaving the screen behind it.
 */
const listeners = new Set();
/** True while openSheet is replacing one sheet with the next - the pair of
 *  events in between would otherwise read as "closed, then opened again". */
let reopening = false;

export function isSheetOpen() {
  return !!openState;
}

/** @param {(open: boolean) => void} fn */
export function onSheetChange(fn) {
  listeners.add(fn);
}

function emit(open) {
  for (const fn of listeners) {
    try {
      fn(open);
    } catch {
      // A listener must never be able to break the sheet it is watching.
    }
  }
}

/**
 * @param {Element} layer the overlay host
 * @param {{title:string, body:Node, footer?:Node, onClose?:Function}} spec
 */
export function openSheet(layer, spec) {
  reopening = true;
  closeSheet();
  reopening = false;
  const previous = document.activeElement;

  const scrim = el("div", { class: "scrim", attrs: { "aria-hidden": "true" }, on: { click: () => closeSheet() } });

  const closeBtn = el(
    "button",
    {
      class: "iconbtn",
      attrs: { type: "button", "aria-label": t("common.close") },
      on: { click: () => closeSheet() },
    },
    [icon("close", 20)],
  );

  const head = el("div", { class: "sheet-head" }, [
    el("div", { class: "sheet-title" }, [text(spec.title || "")]),
    closeBtn,
  ]);

  const body = el("div", { class: "sheet-body" }, [spec.body || null]);
  const sheet = el(
    "div",
    {
      class: "sheet",
      attrs: { role: "dialog", "aria-modal": "true", "aria-label": spec.title || "" },
    },
    [el("div", { class: "sheet-grip", attrs: { "aria-hidden": "true" } }), head, body, spec.footer || null],
  );

  layer.appendChild(scrim);
  layer.appendChild(sheet);
  // One frame later so the transition has a start value to move from.
  requestAnimationFrame(() => {
    scrim.classList.add("is-open");
    sheet.classList.add("is-open");
  });

  const onKey = (ev) => {
    if (ev.key !== "Tab") return;
    const focusables = sheet.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  };
  sheet.addEventListener("keydown", onKey);

  openState = { layer, scrim, sheet, previous, onClose: spec.onClose, releaseKeyboard: watchKeyboard(sheet) };
  // A readonly field is never where a sheet wants to start: the pairing sheet
  // opens on its link, the link selects itself on focus, and the browser then
  // scrolled the whole app up to "reveal" it - taking the sheet's own title off
  // the top of the screen. The first field somebody can actually type in wins.
  const firstField = sheet.querySelector(
    "input:not([readonly]), textarea:not([readonly]), button:not(.iconbtn)",
  );
  if (firstField) queueMicrotask(() => firstField.focus());
  emit(true);
  return sheet;
}

export function closeSheet() {
  if (!openState) return;
  const { scrim, sheet, previous, onClose, releaseKeyboard } = openState;
  openState = null;
  // The listeners go first: a sheet on its way out must not be moved again by
  // the keyboard it is taking down with it.
  if (typeof releaseKeyboard === "function") releaseKeyboard();
  scrim.classList.remove("is-open");
  sheet.classList.remove("is-open");
  // Remove exactly these two nodes, never the whole layer: a sheet that opens
  // another sheet would otherwise have its successor swept away by this
  // deferred cleanup.
  const done = () => {
    scrim.remove();
    sheet.remove();
  };
  const anim = sheet.getAnimations ? sheet.getAnimations() : [];
  if (anim.length) {
    Promise.allSettled(anim.map((a) => a.finished)).then(done);
  } else {
    setTimeout(done, 240);
  }
  if (previous && typeof previous.focus === "function") previous.focus();
  if (typeof onClose === "function") onClose();
  if (!reopening) emit(false);
}
