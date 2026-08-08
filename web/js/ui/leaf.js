// ui/leaf.js - one step, in full.
//
// What it does: shows everything a single node carries - the note sunk into
// the surface, the values in their settings, the chain it belongs to - and
// puts exactly one cast action at the bottom: done.
//
// What it deliberately does NOT do: no editing in place. Changing a value
// opens the editor sheet, so a stray tap on a phone cannot silently rewrite a
// due date. Deleting always goes through the undo toast.

import { el, text, icon } from "./dom.js";
import { t } from "../i18n.js";
import { formatDate, dueLabel, relativeTime } from "./format.js";

function cell(labelKey, value, note, wide) {
  return el("div", { class: `cell${wide ? " is-wide" : ""}` }, [
    el("div", { class: "cell-key" }, [text(t(labelKey))]),
    el("div", { class: `cell-val${wide ? " is-prose" : ""}` }, [
      text(value),
      note ? el("em", { class: "cell-note" }, [text(note)]) : null,
    ]),
  ]);
}

function crumb(ctx, node) {
  const chain = ctx.ancestors(node.id);
  const box = el("nav", { class: "crumb", attrs: { "aria-label": t("common.back") } }, [
    el(
      "button",
      {
        class: "crumb-back",
        attrs: { type: "button", "aria-label": t("a11y.back") },
        on: { click: () => ctx.back() },
      },
      [icon("chevronLeft", 16)],
    ),
  ]);
  const shown = chain.slice(-2);
  shown.forEach((a, i) => {
    if (i > 0) {
      box.appendChild(el("span", { class: "crumb-caret", attrs: { "aria-hidden": "true" } }, [icon("chevronRight", 11)]));
    }
    box.appendChild(
      el("button", { class: "crumb-pill", attrs: { type: "button" }, on: { click: () => ctx.go("focus", a.id) } }, [
        text(a.title),
      ]),
    );
  });
  return box;
}

export function render(ctx, id) {
  const node = ctx.nodeById(id);
  if (!node) {
    ctx.go("outline", null, { replace: true });
    return el("section", { class: "screen" });
  }
  const now = ctx.now();
  const chain = ctx.ancestors(node.id).map((a) => a.title).join(" · ");
  const isDone = node.status === "done";

  const cells = el("div", { class: "cells" }, [
    cell(
      "leaf.due",
      typeof node.due === "number" ? formatDate(node.due) : t("common.none"),
      typeof node.due === "number" ? dueLabel(node.due, now) : "",
    ),
    cell(
      "leaf.effort",
      typeof node.effortMinutes === "number" ? t("leaf.minutes", { n: node.effortMinutes }) : t("common.none"),
    ),
    cell("leaf.doneWhen", node.doneWhen || t("leaf.doneWhenEmpty"), "", true),
    chain ? cell("leaf.belongsTo", chain, "", true) : null,
    cell("leaf.created", formatDate(node.createdAt)),
    cell("leaf.state", t(`status.${node.status}`), relativeTime(node.updatedAt, now)),
  ]);

  const doneBtn = el(
    "button",
    {
      class: "btn is-primary is-big is-wide",
      attrs: { type: "button" },
      on: { click: () => ctx.setStatus(node.id, isDone ? "open" : "done") },
    },
    [icon(isDone ? "arrowLeft" : "check", 18), text(isDone ? t("leaf.markOpen") : t("leaf.markDone"))],
  );

  const alt = el("div", { style: { display: "flex", justifyContent: "space-between", paddingTop: "4px" } }, [
    el("button", { class: "btn-ghost", attrs: { type: "button" }, on: { click: () => ctx.editNode(node) } }, [
      text(t("common.edit")),
    ]),
    el("button", { class: "btn-ghost", attrs: { type: "button" }, on: { click: () => ctx.go("focus", node.id) } }, [
      text(t("focus.addChild")),
    ]),
    el(
      "button",
      { class: "btn-ghost is-accent", attrs: { type: "button" }, on: { click: () => ctx.deleteNode(node) } },
      [text(t("common.delete"))],
    ),
  ]);

  return el("section", { class: "screen" }, [
    crumb(ctx, node),
    el("div", { class: "scroll" }, [
      el("h1", { class: "leaf-title" }, [text(node.title)]),
      el("div", { class: "panel" }, [text(node.note || t("leaf.noteEmpty"))]),
      cells,
    ]),
    el("div", { style: { flex: "none", margin: "0 var(--gutter)", paddingTop: "10px" } }, [doneBtn, alt]),
  ]);
}
