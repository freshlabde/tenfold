// ui/outline.js - the ten, in order.
//
// What it does: the root list. Rank one sits in front and carries the accent,
// rank ten has sunk back into the ground. Below it the two things one does
// here: add an entry, or put the list in order.
//
// What it deliberately does NOT do: it does not sort, score or hide anything.
// The order on screen is the order in the document, and only the duel changes
// it. The empty state is part of this screen, not a separate tour.

import { el, text, icon, brandMark } from "./dom.js";
import { nodeList, composer } from "./rows.js";
import { dueCounts } from "../model.js";
import { treeReviewAvailable } from "../aihelp.js";
import { t } from "../i18n.js";
import { relativeTime } from "./format.js";

function headerSub(ctx) {
  const roots = ctx.childrenOf(null);
  const settings = (ctx.doc && ctx.doc.settings) || {};
  const parts = [];
  if (!roots.length) parts.push(text(t("outline.subEmpty")));
  else {
    const open = roots.filter((n) => n.status !== "done").length;
    const sortedAt = settings.sortedAt;
    const sorted = sortedAt
      ? t("outline.sortedAt", { ago: relativeTime(sortedAt, ctx.now()) })
      : t("outline.sortedNever");
    parts.push(
      text(t("outline.sub", { open, total: roots.length })),
      text(" · "),
      el("span", { class: "hot" }, [text(sorted)]),
    );
  }

  // No copy on the server, no export file ever written: this list exists in
  // exactly one browser, and clearing the site data would end it. One quiet
  // clause on a line that is already there - no banner, no dialog, and it
  // disappears the moment either of the two exists.
  if (ctx.sync.enabled || settings.exportedAt) return el("p", { class: "h-sub" }, parts);
  parts.push(text(" · "), el("span", { class: "hot" }, [text(t("outline.onlyHere"))]));
  return el(
    "button",
    {
      class: "h-sub",
      attrs: { type: "button", "aria-label": t("a11y.onlyHere") },
      on: { click: () => ctx.go("settings") },
    },
    parts,
  );
}

/**
 * What is overdue or due today, as one line above the list, in the accent -
 * this screen is where the app is opened, and the count on the icon is the one
 * thing that says so from outside. A hint, not a banner: one mono line, no
 * icon, no plate, and the way into the same short list the header button opens.
 *
 * The numbers come from model.dueCounts, the same primitive the badge and the
 * Today rule already share. When nothing is due this returns null and there is
 * nothing in the DOM at all.
 */
function dueHint(ctx) {
  const { overdue, today } = dueCounts(ctx.doc.nodes, { now: ctx.now() });
  const parts = [];
  if (overdue) parts.push(overdue === 1 ? t("outline.due.overdueOne") : t("outline.due.overdue", { n: overdue }));
  if (today) parts.push(today === 1 ? t("outline.due.todayOne") : t("outline.due.today", { n: today }));
  if (!parts.length) return null;

  const line = parts.join(" · ");
  return el(
    "button",
    {
      class: "duehint",
      attrs: { type: "button", "aria-label": t("a11y.dueHint", { what: line }) },
      on: { click: () => ctx.go("today") },
    },
    [text(line)],
  );
}

/**
 * The title of this screen, and the one thing tapping it does: carry the WHOLE
 * list out as a review prompt.
 *
 * The heading stays a heading - the h1 keeps its role and the button lives
 * inside it, so nothing about the document outline changes. The line above it
 * is the precedent for the shape (`button.h-sub` becomes tappable only while it
 * has somewhere to lead) and for the register: no chevron, no icon, no colour.
 * A list that is empty, or every goal of which is kept away from models, has
 * nothing to review, and then this is a plain heading again.
 */
function headerTitle(ctx) {
  const label = t("outline.title");
  if (!treeReviewAvailable(ctx.doc)) return el("h1", { class: "h-title" }, [text(label)]);
  return el("h1", { class: "h-title" }, [
    el(
      "button",
      {
        class: "h-title-btn",
        attrs: { type: "button", "aria-label": t("a11y.treeReview") },
        on: { click: () => ctx.aiHelpTree() },
      },
      [text(label)],
    ),
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
      el("div", {}, [brandMark(), headerTitle(ctx)]),
      actions,
    ]),
    headerSub(ctx),
  ]);

  const body =
    roots.length || composing
      ? el("div", { class: "scroll" }, [
          dueHint(ctx),
          nodeList(ctx, null, { showRank: true, lead: true }),
          composing ? composer(ctx, null, { placeholder: t("outline.composerPlaceholder") }) : null,
        ])
      : emptyState(ctx);

  // The cap of the method, enforced where an entry is actually made: ten
  // living goals ARE the list, and an eleventh is a decision to drop one
  // first. Living means not tombstoned - a finished or parked goal still
  // holds its place, because what clears the list is the next paper ritual
  // and not the act of finishing something. The button takes the ordinary
  // disabled styling (.btn[disabled]) the ordering button already uses.
  //
  // Honestly scoped: this is the only gate. A pasted outline, a shared note
  // filed from another app or a merge from another device can still land an
  // eleventh entry, and a list longer than ten renders correctly - it simply
  // scrolls, which is what the fit budget stops being able to promise there.
  const full = roots.length >= 10;
  const addLabel = roots.length ? t("outline.add") : t("outline.empty.cta");
  const add = el(
    "button",
    {
      class: `btn${roots.length ? "" : " is-primary"}`,
      attrs: { type: "button", disabled: full ? "disabled" : false },
      on: { click: () => ctx.startCompose(null) },
    },
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

  // Two controls, and until v1.1 a third between them: a camera that read a
  // photographed list through this app's own model relay. The relay is gone
  // and the bar is what it was before it - one word, and one word.
  const bar = roots.length
    ? el("div", { class: "bar" }, [add, order])
    : el("div", { class: "bar", style: { gridAutoFlow: "row" } }, [add]);

  return el("section", { class: "screen" }, [head, body, bar]);
}
