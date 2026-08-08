// ui/format.js - turning numbers and timestamps into the strings on screen.
//
// What it does: relative times, due-date labels, progress ratios over a
// subtree, and the fixed-width figures for the mono rail. Everything routed
// through i18n so no screen has to assemble a sentence itself.
//
// What it deliberately does NOT do: no DOM, no state, no clock of its own -
// `now` is always passed in so screens and tests see the same values.

import { t, getLocale } from "../i18n.js";
import { childrenOf, descendantsOf } from "../model.js";

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

/** Midnight of the day a timestamp falls into. */
export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole days from today to the due date; negative means overdue. */
export function daysUntil(due, now) {
  return Math.round((startOfDay(due) - startOfDay(now)) / DAY);
}

/** "3 days ago", "just now". Coarse on purpose - this is not a log. */
export function relativeTime(ts, now) {
  if (typeof ts !== "number") return t("time.never");
  const d = Math.max(0, now - ts);
  if (d < 2 * MIN) return t("time.justNow");
  if (d < HOUR) return t("time.minutes", { n: Math.round(d / MIN) });
  if (d < DAY) return t("time.hours", { n: Math.round(d / HOUR) });
  return t("time.days", { n: Math.round(d / DAY) });
}

/** Locale-aware short date. Intl is built in - no data is fetched. */
export function formatDate(ts) {
  if (typeof ts !== "number") return t("common.none");
  try {
    return new Intl.DateTimeFormat(getLocale(), {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

/** The value of a date input (yyyy-mm-dd) for a timestamp. */
export function dateInputValue(ts) {
  if (typeof ts !== "number") return "";
  const d = new Date(ts);
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parse a yyyy-mm-dd input back to local noon, so time zones cannot shift it. */
export function dateInputToTs(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
}

/** "in 6 days", "today", "4 days overdue". */
export function dueLabel(due, now) {
  if (typeof due !== "number") return "";
  const days = daysUntil(due, now);
  if (days < 0) return t("leaf.overdue", { days: Math.abs(days) });
  if (days === 0) return t("leaf.dueToday");
  if (days === 1) return t("leaf.dueTomorrow");
  return t("leaf.dueInDays", { days });
}

/**
 * How far a node is. A node with children is measured by its living
 * descendants; a leaf is simply done or not.
 * @returns {{done: number, total: number, ratio: number}}
 */
export function progressOf(nodes, id) {
  const kids = descendantsOf(nodes, id).filter((n) => !n.deletedAt);
  if (!kids.length) {
    const self = nodes.find((n) => n.id === id);
    const done = self && self.status === "done" ? 1 : 0;
    return { done, total: 1, ratio: done };
  }
  const done = kids.filter((n) => n.status === "done").length;
  return { done, total: kids.length, ratio: kids.length ? done / kids.length : 0 };
}

/** The short mono figure on a row: "3/8", "step", "resting", "done". */
export function metricFor(nodes, node) {
  if (node.status === "done") return t("status.done");
  if (node.status === "parked") return t("status.parked");
  const kids = childrenOf(nodes, node.id);
  // A root goal that has not been broken down yet says nothing rather than
  // calling itself a step - it is not one, it just has no parts yet.
  if (!kids.length) return node.parentId === null ? "" : t("focus.leafBadge");
  const p = progressOf(nodes, node.id);
  return `${p.done}/${p.total}`;
}

/** Two-digit figure for the duel counter and similar rails. */
export function pad2(n) {
  return String(Math.max(0, Math.trunc(n))).padStart(2, "0");
}
