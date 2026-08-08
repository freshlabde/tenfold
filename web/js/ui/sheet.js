// ui/sheet.js - the one modal surface: a sheet that rises from the bottom.
//
// What it does: mounts a scrim plus a panel into the overlay layer, animates
// both in and out, returns focus to whatever was focused before, and keeps
// Tab inside the panel while it is open.
//
// What it deliberately does NOT do: no stacking of sheets (one at a time, on
// purpose - a sheet on a sheet on a phone is a dead end), no innerHTML, no
// content of its own beyond the grip, the title row and the close button.

import { el, text, icon } from "./dom.js";
import { t } from "../i18n.js";

let openState = null;

export function isSheetOpen() {
  return !!openState;
}

/**
 * @param {Element} layer the overlay host
 * @param {{title:string, body:Node, footer?:Node, onClose?:Function}} spec
 */
export function openSheet(layer, spec) {
  closeSheet();
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

  openState = { layer, scrim, sheet, previous, onClose: spec.onClose };
  const firstField = sheet.querySelector("input, textarea, button:not(.iconbtn)");
  if (firstField) queueMicrotask(() => firstField.focus());
  return sheet;
}

export function closeSheet() {
  if (!openState) return;
  const { scrim, sheet, previous, onClose } = openState;
  openState = null;
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
}
