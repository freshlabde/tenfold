// ui/leaf.js - one step, in full.
//
// What it does: shows everything a single node carries - the story behind it,
// the note sunk into the surface, the cards it is linked to, the values in
// their settings, the chain it belongs to - and puts exactly one cast action
// at the bottom: done. The story sits directly under the title, because it is
// the reason the step exists; everything measurable comes after it.
//
// What it deliberately does NOT do: no editing in place. Changing a value
// opens the editor sheet, so a stray tap on a phone cannot silently rewrite a
// due date. Deleting always goes through the undo toast. The name hint is one
// line that can be dismissed - never a modal, never a second time.

import { el, text, icon, depthMark } from "./dom.js";
import { t, getLocale } from "../i18n.js";
import { formatDate, dueLabel, relativeTime } from "./format.js";
import { storyDepth } from "../model.js";
import { detectNames, foldName } from "../entities.js";
import { entityChips } from "./entity.js";

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
  // The way out to the ten, first and always - the focus screen has carried it
  // since the beginning, and a leaf that hid it made the same row of pills mean
  // two different things one tap apart.
  box.appendChild(
    el(
      "button",
      { class: "crumb-pill", attrs: { type: "button" }, on: { click: () => ctx.go("outline", null, { replace: true }) } },
      [text(t("focus.root"))],
    ),
  );
  const shown = chain.slice(-1);
  shown.forEach((a) => {
    box.appendChild(el("span", { class: "crumb-caret", attrs: { "aria-hidden": "true" } }, [icon("chevronRight", 11)]));
    box.appendChild(
      el("button", { class: "crumb-pill", attrs: { type: "button" }, on: { click: () => ctx.go("focus", a.id) } }, [
        text(a.title),
      ]),
    );
  });
  box.appendChild(el("span", { style: { flex: "1 1 auto" }, attrs: { "aria-hidden": "true" } }));
  box.appendChild(
    el(
      "button",
      {
        class: "iconbtn",
        attrs: { type: "button", "aria-label": t("a11y.menu") },
        on: { click: () => ctx.openRowMenu(node) },
      },
      [icon("dots", 20)],
    ),
  );
  return box;
}

/** The story block: what is told so far, and the way to tell more. */
function storyBlock(ctx, node) {
  const told = String(node.story || "").trim();
  return el("section", { class: "story" }, [
    el("div", { class: "cell-key" }, [text(t("story.label"))]),
    told
      ? el("div", { class: "story-text" }, [text(node.story)])
      : el("p", { class: "story-empty" }, [text(t("story.empty"))]),
    el(
      "button",
      {
        class: "btn-ghost is-accent",
        attrs: { type: "button" },
        style: { padding: "10px 0 0" },
        on: { click: () => ctx.startStoryGuide(node) },
      },
      [text(told ? t("story.continue") : t("story.tell"))],
    ),
  ]);
}

/**
 * The one quiet question about a name that keeps coming up here. Only a name
 * that appears in THIS node is offered - a hint about something on another
 * screen would be noise.
 */
function nameHint(ctx, node) {
  const settings = ctx.doc.settings || {};
  const candidates = detectNames(ctx.doc.nodes, ctx.entities, {
    locale: getLocale(),
    dismissed: settings.dismissedNames,
  });
  if (!candidates.length) return null;
  const here = `${node.title || ""}\n${node.story || ""}`;
  const hit = candidates.find((c) => foldName(here).includes(foldName(c.name)));
  if (!hit) return null;

  return el("div", { class: "hintrow" }, [
    el(
      "button",
      {
        class: "hintchip",
        attrs: { type: "button" },
        on: { click: () => ctx.editEntity(null, { name: hit.name, link: node.id }) },
      },
      [text(t("entities.whoIs", { name: hit.name }))],
    ),
    el(
      "button",
      {
        class: "iconbtn is-small",
        attrs: { type: "button", "aria-label": t("entities.dismiss") },
        on: { click: () => ctx.dismissName(hit.name) },
      },
      [icon("close", 15)],
    ),
  ]);
}

/**
 * The assistance block. It exists only when assistance is switched on at all -
 * in "off" mode not one of these elements is built. A step that is kept away
 * from the model has no assist entry; a step that inherits that decision says
 * where it came from and offers no switch, because the switch belongs to the
 * goal it was thrown on.
 */
function assistBlock(ctx, node) {
  if (!ctx.llmOn) return null;
  const keep = ctx.optout(node.id);
  const box = el("section", { class: "assist-foot", dataset: { llm: "leaf" } });

  if (!keep.own && !keep.inherited) {
    box.appendChild(
      el(
        "button",
        {
          class: "btn-ghost is-accent",
          attrs: { type: "button" },
          on: { click: () => ctx.assist(node) },
        },
        [text(t("llm.assist"))],
      ),
    );
  }

  if (keep.inherited) {
    box.appendChild(
      el("p", { class: "field-hint" }, [text(t("llm.optoutInherited", { title: keep.source }))]),
    );
  } else {
    box.appendChild(
      el(
        "button",
        {
          class: "btn-ghost",
          attrs: { type: "button" },
          on: { click: () => ctx.toggleOptout(node) },
        },
        [text(keep.own ? t("llm.optoutOff") : t("llm.optout"))],
      ),
    );
  }
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
  const showDepth = (ctx.doc.settings || {}).storyDepth !== false;

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
      el("div", { class: "leaf-head" }, [
        el("h1", { class: "leaf-title" }, [text(node.title)]),
        showDepth ? depthMark(storyDepth(node)) : null,
      ]),
      storyBlock(ctx, node),
      nameHint(ctx, node),
      entityChips(ctx, node),
      el("div", { class: "panel" }, [text(node.note || t("leaf.noteEmpty"))]),
      cells,
      assistBlock(ctx, node),
    ]),
    el("div", { style: { flex: "none", margin: "0 var(--gutter)", paddingTop: "10px" } }, [doneBtn, alt]),
  ]);
}
