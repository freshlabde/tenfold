// ui/outline.js - the ten, in order.
//
// What it does: the root list. Rank one sits in front and carries the accent,
// rank ten has sunk back into the ground. Below it the two things one does
// here: add an entry, or put the list in order.
//
// What it deliberately does NOT do: it does not sort, score or hide anything.
// The order on screen is the order in the document, and only the duel changes
// it. The empty state is part of this screen, not a separate tour.

import { el, text, icon } from "./dom.js";
import { nodeList, composer } from "./rows.js";
import { t } from "../i18n.js";
import { relativeTime } from "./format.js";
import { importEntry } from "./imageimport.js";

function headerSub(ctx) {
  const roots = ctx.childrenOf(null);
  if (!roots.length) return el("p", { class: "h-sub" }, [text(t("outline.subEmpty"))]);
  const open = roots.filter((n) => n.status !== "done").length;
  const sortedAt = ctx.doc.settings && ctx.doc.settings.sortedAt;
  const sorted = sortedAt
    ? t("outline.sortedAt", { ago: relativeTime(sortedAt, ctx.now()) })
    : t("outline.sortedNever");
  return el("p", { class: "h-sub" }, [
    text(t("outline.sub", { open, total: roots.length })),
    text(" · "),
    el("span", { class: "hot" }, [text(sorted)]),
  ]);
}

function emptyState(ctx) {
  return el("div", { class: "empty" }, [
    el("div", { class: "empty-mark" }, [icon("mark", 30)]),
    el("p", { class: "empty-line" }, [text(t("outline.empty.line"))]),
    el("p", { class: "empty-hint" }, [text(t("outline.empty.hint"))]),
  ]);
}

export function render(ctx) {
  const roots = ctx.childrenOf(null);
  const composing = ctx.compose && ctx.compose.parentId === null;

  const actions = el("div", { class: "head-actions" }, [
    // The way into the short list. A word, not an icon: "Today" is the one
    // thing on this screen that is a destination rather than a tool.
    el(
      "button",
      {
        class: "btn-ghost is-today",
        attrs: { type: "button" },
        on: { click: () => ctx.go("today") },
      },
      [text(t("today.entry"))],
    ),
    // The map: the same ten, seen all at once instead of one under the other.
    el(
      "button",
      {
        class: "iconbtn is-map",
        attrs: { type: "button", "aria-label": t("a11y.mapOpen") },
        on: { click: () => ctx.go("map") },
      },
      [icon("constellation", 20)],
    ),
    el(
      "button",
      {
        class: "iconbtn",
        attrs: { type: "button", "aria-label": t("a11y.searchOpen") },
        on: { click: () => ctx.go("search") },
      },
      [icon("search", 20)],
    ),
    el(
      "button",
      {
        class: "iconbtn",
        attrs: { type: "button", "aria-label": t("a11y.settingsOpen") },
        on: { click: () => ctx.go("settings") },
      },
      [icon("gear", 20)],
    ),
  ]);

  const head = el("div", { class: "head" }, [
    el("div", { class: "head-row" }, [
      el("div", {}, [
        el("div", { class: "eyebrow" }, [text(t("app.name"))]),
        el("h1", { class: "h-title" }, [text(t("outline.title"))]),
      ]),
      actions,
    ]),
    headerSub(ctx),
  ]);

  const body =
    roots.length || composing
      ? el("div", { class: "scroll" }, [
          nodeList(ctx, null, { showRank: true, lead: true }),
          composing ? composer(ctx, null, { placeholder: t("outline.composerPlaceholder") }) : null,
        ])
      : emptyState(ctx);

  const addLabel = roots.length ? t("outline.add") : t("outline.empty.cta");
  const add = el(
    "button",
    { class: `btn${roots.length ? "" : " is-primary"}`, attrs: { type: "button" }, on: { click: () => ctx.startCompose(null) } },
    [icon("plus", 16), text(addLabel)],
  );

  const order = el(
    "button",
    {
      class: "btn is-primary",
      attrs: { type: "button", disabled: roots.length < 2 ? "disabled" : false },
      on: {
        click: () => {
          if (roots.length < 2) {
            ctx.toast(t("outline.orderNeedsTwo"));
            return;
          }
          ctx.startDuel(null);
        },
      },
    },
    [icon("scales", 16), text(t("outline.order"))],
  );

  const bar = roots.length
    ? el("div", { class: "bar" }, [add, order])
    : el("div", { class: "bar", style: { gridAutoFlow: "row" } }, [add]);

  // The way in from paper: one quiet line above the bar, next to the way in
  // from the keyboard. It exists only when assistance is switched on at all.
  return el("section", { class: "screen" }, [head, body, importEntry(ctx, null), bar]);
}
