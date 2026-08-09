// ui/focus.js - one node becomes the header, its parts line up beneath it.
//
// What it does: the signature move. Tapping an entry lifts it out of the list
// and into the head of its own screen; the siblings it came from stay cropped
// at the top edge, the breadcrumb shows the way back, and the level below is
// the new working list. Going in and coming out is one View Transition when
// the browser has them, a Web-Animations fade when it does not.
//
// What it deliberately does NOT do: no infinite breadcrumb - a deep chain is
// shortened in the middle, never wrapped - and no separate "add" screen. The
// composer appears in place, where the new line will be.

import { el, text, icon, depthMark } from "./dom.js";
import { nodeList, composer } from "./rows.js";
import { t } from "../i18n.js";
import { storyDepth } from "../model.js";
import { progressOf, relativeTime } from "./format.js";
import { nameTransition, clearTransition } from "../motion.js";
import { importEntry } from "./imageimport.js";

function crumb(ctx, node) {
  const chain = ctx.ancestors(node.id);
  const box = el("nav", { class: "crumb", attrs: { "aria-label": t("common.back") } });

  box.appendChild(
    el(
      "button",
      {
        class: "crumb-back",
        attrs: { type: "button", "aria-label": t("a11y.back") },
        on: { click: () => ctx.back() },
      },
      [icon("chevronLeft", 16)],
    ),
  );

  const pill = (label, onClick) =>
    el("button", { class: "crumb-pill", attrs: { type: "button" }, on: { click: onClick } }, [text(label)]);
  const caret = () => el("span", { class: "crumb-caret", attrs: { "aria-hidden": "true" } }, [icon("chevronRight", 11)]);

  box.appendChild(pill(t("focus.root"), () => ctx.go("outline", null, { replace: true })));

  const shown = chain.length > 2 ? chain.slice(-1) : chain;
  if (chain.length > 2) {
    box.appendChild(caret());
    box.appendChild(el("span", { class: "crumb-ellipsis" }, [text("...")]));
  }
  for (const a of shown) {
    box.appendChild(caret());
    box.appendChild(pill(a.title, () => ctx.go("focus", a.id)));
  }

  // The only route to edit, finish, move or delete THIS node on a touch
  // screen: long press is taken by the drag gesture, right click by desktop.
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

function hero(ctx, node) {
  const siblings = ctx.childrenOf(node.parentId);
  const rank = siblings.findIndex((n) => n.id === node.id);
  const p = progressOf(ctx.doc.nodes, node.id);

  const showDepth = (ctx.doc.settings || {}).storyDepth !== false;

  // The hero shows a PREVIEW of the story/note (CSS-clamped) - a long story
  // must never push the children and the action bar off the screen (real bug:
  // "nothing clickable on the deepest level"). The full text lives one tap
  // away: the card itself opens the details.
  const card = el("div", {
    class: "hero-card is-tappable",
    attrs: { role: "button", tabindex: "0", "aria-label": t("focus.openLeaf") },
    on: {
      click: () => ctx.go("leaf", node.id),
      keydown: (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          ctx.go("leaf", node.id);
        }
      },
    },
  }, [
    el("div", { class: "hero-head" }, [
      el("div", { class: "hero-rank" }, [
        text(t("focus.rank", { rank: rank + 1, total: siblings.length })),
      ]),
      showDepth ? depthMark(storyDepth(node)) : null,
    ]),
    el("h1", { class: "hero-title" }, [text(node.title)]),
    node.story ? el("p", { class: "hero-story" }, [text(node.story)]) : null,
    node.note ? el("p", { class: "hero-note" }, [text(node.note)]) : null,
    el("div", { class: "hero-meta" }, [
      el("span", { class: "m is-mid" }, [text(t("focus.progress", { done: p.done, total: p.total }))]),
      el("span", { class: "track", vars: { "--p": String(p.ratio) } }, [el("i", {})]),
      el("span", { class: "m" }, [text(relativeTime(node.createdAt, ctx.now()))]),
    ]),
  ]);

  nameTransition(card, "hero");
  setTimeout(() => clearTransition(card), 700);
  return el("div", { class: "hero" }, [card]);
}

function emptyChildren(ctx, node) {
  return el("div", { class: "empty" }, [
    el("p", { class: "empty-line" }, [text(t("focus.childrenEmpty.line"))]),
    el("p", { class: "empty-hint" }, [text(t("focus.childrenEmpty.hint"))]),
  ]);
}

export function render(ctx, id) {
  const node = ctx.nodeById(id);
  if (!node) {
    ctx.go("outline", null, { replace: true });
    return el("section", { class: "screen" });
  }
  const kids = ctx.childrenOf(node.id);
  const composing = ctx.compose && ctx.compose.parentId === node.id;

  const body =
    kids.length || composing
      ? el("div", { class: "scroll" }, [
          nodeList(ctx, node.id, { kids: true }),
          composing ? composer(ctx, node.id, { placeholder: t("focus.composerPlaceholder") }) : null,
        ])
      : emptyChildren(ctx, node);

  const add = el(
    "button",
    {
      class: `btn${kids.length ? "" : " is-primary"}`,
      attrs: { type: "button" },
      on: { click: () => ctx.startCompose(node.id) },
    },
    [icon("plus", 16), text(kids.length ? t("focus.addChild") : t("focus.childrenEmpty.cta"))],
  );

  const second = kids.length >= 2
    ? el(
        "button",
        { class: "btn is-primary", attrs: { type: "button" }, on: { click: () => ctx.startDuel(node.id) } },
        [icon("scales", 16), text(t("outline.order"))],
      )
    : el(
        "button",
        { class: "btn", attrs: { type: "button" }, on: { click: () => ctx.go("leaf", node.id) } },
        [icon("dots", 16), text(t("focus.openLeaf"))],
      );

  return el("section", { class: "screen" }, [
    crumb(ctx, node),
    el("div", { class: "peek", attrs: { "aria-hidden": "true" } }, [el("i", {}), el("i", {})]),
    hero(ctx, node),
    body,
    // A picture of a list read into THIS goal: the outer margin of the paper
    // becomes the level below this node, and everything shifts down with it.
    importEntry(ctx, node.id),
    el("div", { class: "bar" }, [add, second]),
  ]);
}
