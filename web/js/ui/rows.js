// ui/rows.js - the row, and the two gestures that live on it.
//
// What it does: builds one node row (rank chip, title, sub line, mono metric,
// progress track) and wires the two direct manipulations from the design:
// swipe right on a step to finish it, long press to lift and reorder siblings.
// Both gestures run on real spring physics with rubber-band resistance past
// their limits, and both have a visible button equivalent in the row menu.
//
// What it deliberately does NOT do: no innerHTML, no business rules. It asks
// the context to mutate the document and re-render; it never writes to the
// document itself and never touches storage.

import { el, text, icon, depthMark } from "./dom.js";
import { childrenOf, isLeaf, storyDepth } from "../model.js";
import { metricFor, progressOf, dueLabel } from "./format.js";
import { t } from "../i18n.js";
import { spring, rubberBand, collapse, prefersReducedMotion } from "../motion.js";

const SWIPE_START = 8;
const SWIPE_COMMIT = 92;
const LONG_PRESS_MS = 420;

/**
 * The small line under a title. `opts.path` is the chain a step hangs in - the
 * today list needs it, because there a row is torn out of its context and
 * "call the physio" alone says nothing about which goal it serves.
 */
function subLine(ctx, node, opts = {}) {
  const parts = [];
  if (opts.path) parts.push(opts.path);
  if (node.status === "doing") parts.push(t("status.doing"));
  if (typeof node.due === "number" && node.status !== "done") {
    parts.push(dueLabel(node.due, ctx.now()));
  }
  return parts.join(" · ");
}

/**
 * One row.
 * @param {Object} ctx app context
 * @param {Object} node
 * @param {{rank:number,total:number,lead:boolean,showRank:boolean,path:string}} opts
 */
export function nodeRow(ctx, node, opts = {}) {
  const nodes = ctx.doc.nodes;
  const leaf = isLeaf(nodes, node.id);
  const rank = opts.rank || 0;
  const p = progressOf(nodes, node.id);

  const shell = el("li", {
    class: "row-shell",
    vars: { "--rank": String(rank) },
    dataset: { id: node.id },
  });

  const behind = el("div", { class: "row-behind", attrs: { "aria-hidden": "true" } }, [icon("check", 22)]);

  const chipLabel = opts.showRank ? String(rank + 1) : leaf ? "·" : "–";
  const chip = el("span", { class: "row-chip", attrs: { "aria-hidden": "true" }, text: chipLabel });

  const body = el("div", { class: "row-body" }, [
    el("div", { class: "row-title" }, [text(node.title || t("editor.newTitle"))]),
  ]);
  const sub = subLine(ctx, node, opts);
  if (sub) body.appendChild(el("div", { class: "row-sub" }, [text(sub)]));

  // The mono rail on the right: the machine figure, and - unless it is
  // switched off - the story-depth ring in front of it.
  const showDepth = (ctx.doc.settings || {}).storyDepth !== false;
  const depth = storyDepth(node);
  const metric = el("div", { class: "row-meta" }, [
    showDepth && depth > 0 ? depthMark(depth) : null,
    el("span", { class: "m" }, [text(metricFor(nodes, node))]),
  ]);

  const row = el("div", {
    class: `row${opts.lead ? " is-lead" : ""}${node.status === "done" ? " is-done" : ""}${
      node.status === "parked" ? " is-parked" : ""
    }`,
    attrs: {
      role: "button",
      tabindex: "0",
      "aria-label": t("a11y.openNode", { title: node.title }),
    },
  });
  row.appendChild(chip);
  row.appendChild(body);
  row.appendChild(metric);
  // The gauge appears once there is something to show. An empty one is not
  // information: it is a full-width rule under the title, and since only a goal
  // WITH parts carried it, one row in ten looked struck through. The count in
  // the mono rail already says "0 of 6".
  if (!leaf && p.ratio > 0) {
    row.appendChild(el("span", { class: "row-track", vars: { "--p": String(p.ratio) } }, [el("i", {})]));
  }

  shell.appendChild(behind);
  shell.appendChild(row);

  attachGestures(ctx, { shell, row, behind, node, leaf, opts });
  return shell;
}

/** A list of the living children of `parentId`. */
export function nodeList(ctx, parentId, opts = {}) {
  const kids = childrenOf(ctx.doc.nodes, parentId);
  const ul = el("ul", { class: opts.kids ? "list is-kids" : "list" });
  if (opts.kids) ul.appendChild(el("div", { class: "rail", attrs: { "aria-hidden": "true" } }));
  kids.forEach((n, i) => {
    ul.appendChild(
      nodeRow(ctx, n, {
        rank: i,
        total: kids.length,
        lead: !!opts.lead && i === 0,
        showRank: !!opts.showRank,
        parentId,
      }),
    );
  });
  return ul;
}

// ------------------------------------------------------------------ gestures

function attachGestures(ctx, refs) {
  const { shell, row, behind, node, leaf, opts } = refs;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let mode = "none"; // none | swipe | drag | scroll
  let pressTimer = 0;
  let lastT = 0;
  let lastX = 0;
  let velocity = 0;
  let drag = null;
  let gestured = false;
  // A gesture exists only between pointerdown and pointerup. Without this
  // guard a plain mouse hover fires pointermove with stale start coordinates
  // and swipes the row away (desktop regression, 2026-08-08).
  let down = false;

  const setX = (v) => {
    row.style.transform = v ? `translate3d(${v}px,0,0)` : "";
    const ratio = Math.max(0, Math.min(1, v / SWIPE_COMMIT));
    behind.style.opacity = String(ratio);
    behind.style.transform = `scale(${0.85 + ratio * 0.15})`;
  };

  const reset = (from, v) => {
    row.classList.remove("is-dragging");
    spring({
      from,
      to: 0,
      velocity: v,
      stiffness: 420,
      damping: 34,
      onUpdate: (val) => setX(val),
      onDone: () => setX(0),
    });
  };

  const onDown = (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    down = true;
    gestured = false;
    startX = ev.clientX;
    startY = ev.clientY;
    lastX = startX;
    lastT = ev.timeStamp;
    dx = 0;
    mode = "none";
    velocity = 0;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      if (mode !== "none") return;
      mode = "drag";
      drag = beginDrag(ctx, shell, row, node, opts);
    }, LONG_PRESS_MS);
    row.setPointerCapture(ev.pointerId);
  };

  const onMove = (ev) => {
    if (!down) return;
    // Belt and braces for mice: a captured pointer can report moves after the
    // button was released outside the window.
    if (ev.pointerType === "mouse" && ev.buttons === 0) return;
    const mx = ev.clientX - startX;
    const my = ev.clientY - startY;
    if (mode === "none") {
      if (Math.abs(my) > SWIPE_START && Math.abs(my) > Math.abs(mx)) {
        mode = "scroll";
        clearTimeout(pressTimer);
        return;
      }
      if (Math.abs(mx) > SWIPE_START) {
        clearTimeout(pressTimer);
        mode = "swipe";
      }
    }
    if (mode === "swipe") {
      ev.preventDefault();
      const dt = Math.max(1, ev.timeStamp - lastT);
      velocity = ((ev.clientX - lastX) / dt) * 1000;
      lastX = ev.clientX;
      lastT = ev.timeStamp;
      // Left has no meaning here, so it is pure resistance.
      dx = mx >= 0 ? (leaf ? mx : rubberBand(mx, 90)) : rubberBand(mx, 70);
      setX(dx);
    } else if (mode === "drag" && drag) {
      ev.preventDefault();
      drag.move(my);
    }
  };

  const onUp = () => {
    down = false;
    clearTimeout(pressTimer);
    // A gesture must not also count as a tap: the click event arrives after
    // pointerup, when dx has already been reset.
    if (mode === "swipe" || mode === "drag") gestured = true;
    if (mode === "drag" && drag) {
      drag.end();
      drag = null;
      mode = "none";
      return;
    }
    if (mode === "swipe") {
      if (leaf && dx > SWIPE_COMMIT && node.status !== "done") {
        finish();
      } else {
        reset(dx, velocity);
      }
    }
    mode = "none";
    dx = 0;
  };

  const finish = async () => {
    setX(SWIPE_COMMIT + 40);
    await collapse(shell);
    ctx.setStatus(node.id, "done");
  };

  const activate = () => {
    if (ctx.openNode) ctx.openNode(node, row);
  };

  row.addEventListener("pointerdown", onDown);
  row.addEventListener("pointermove", onMove);
  row.addEventListener("pointerup", onUp);
  row.addEventListener("pointercancel", onUp);
  row.addEventListener("click", (ev) => {
    if (gestured || Math.abs(dx) > SWIPE_START) {
      gestured = false;
      return;
    }
    ev.preventDefault();
    activate();
  });
  row.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ctx.openRowMenu(node);
  });
  row.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      if (ev.metaKey || ev.ctrlKey) ctx.startCompose(node.parentId, node.id);
      else activate();
      return;
    }
    if (ev.altKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) {
      ev.preventDefault();
      ctx.moveWithinSiblings(node, ev.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
      ev.preventDefault();
      focusSibling(shell, ev.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (ev.key === "Tab") {
      ev.preventDefault();
      if (ev.shiftKey) ctx.outdent(node);
      else ctx.indent(node);
      return;
    }
    if (ev.key === "Backspace" || ev.key === "Delete") {
      ev.preventDefault();
      ctx.deleteNode(node);
    }
  });
}

function focusSibling(shell, dir) {
  const list = shell.parentElement;
  if (!list) return;
  const shells = Array.from(list.querySelectorAll(":scope > .row-shell"));
  const i = shells.indexOf(shell);
  const next = shells[i + dir];
  if (next) next.querySelector(".row").focus();
}

/**
 * Long-press reorder. The lifted row follows the finger, the rows it passes
 * step aside, and the release commits one reorder call.
 */
function beginDrag(ctx, shell, row, node, opts) {
  const list = shell.parentElement;
  if (!list) return null;
  const shells = Array.from(list.querySelectorAll(":scope > .row-shell"));
  const from = shells.indexOf(shell);
  const step = shell.getBoundingClientRect().height + 5;
  let to = from;

  row.classList.add("is-dragging");
  shell.classList.add("is-lifted");
  if (!prefersReducedMotion()) row.style.transform = "scale(1.02)";

  const place = (dy) => {
    row.style.transform = `translate3d(0,${dy}px,0) scale(1.02)`;
    const target = Math.max(0, Math.min(shells.length - 1, from + Math.round(dy / step)));
    if (target === to) return;
    to = target;
    shells.forEach((s, i) => {
      if (s === shell) return;
      let shift = 0;
      if (from < to && i > from && i <= to) shift = -step;
      if (from > to && i >= to && i < from) shift = step;
      s.style.transition = "transform var(--dur) var(--ease)";
      s.style.transform = shift ? `translate3d(0,${shift}px,0)` : "";
    });
  };

  return {
    move: place,
    end: () => {
      shells.forEach((s) => {
        s.style.transition = "";
        s.style.transform = "";
      });
      row.classList.remove("is-dragging");
      shell.classList.remove("is-lifted");
      row.style.transform = "";
      if (to !== from) ctx.reorderSibling(node, opts.parentId === undefined ? node.parentId : opts.parentId, to);
    },
  };
}

/** The inline composer: one line, Enter keeps going, Tab indents. */
export function composer(ctx, parentId, opts = {}) {
  const input = el("input", {
    attrs: {
      type: "text",
      placeholder: opts.placeholder || t("outline.composerPlaceholder"),
      "aria-label": opts.placeholder || t("outline.composerPlaceholder"),
      enterkeyhint: "done",
      autocomplete: "off",
      autocapitalize: "sentences",
      spellcheck: "false",
    },
  });
  const box = el("div", { class: "composer" }, [
    el("span", { class: "row-chip", attrs: { "aria-hidden": "true" }, text: "+" }),
    input,
  ]);

  // True from the moment this composer hands over: the element is about to be
  // torn down and its blur must not be read as "the user tapped away".
  let closing = false;

  const commit = (mode) => {
    if (closing) return;
    const value = input.value.trim();
    closing = true;
    if (!value) {
      ctx.cancelCompose();
      return;
    }
    input.value = "";
    ctx.commitCompose(value, parentId, mode);
  };

  input.addEventListener("keydown", (ev) => {
    // The composer owns these keys; the global Escape handler must not also
    // read them and navigate away underneath the user.
    ev.stopPropagation();
    if (ev.key === "Enter") {
      ev.preventDefault();
      commit("sibling");
    } else if (ev.key === "Tab") {
      ev.preventDefault();
      commit(ev.shiftKey ? "outdent" : "indent");
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      input.value = "";
      closing = true;
      ctx.cancelCompose();
    }
  });
  input.addEventListener("blur", () => {
    if (closing) return;
    // A blur can also mean "this element is being removed by a re-render".
    // One tick later the difference is visible: a removed input is no longer
    // connected, and reacting to it would cancel the compose that replaced it.
    const value = input.value.trim();
    setTimeout(() => {
      if (closing || !input.isConnected) return;
      if (value) commit("stay");
      else ctx.cancelCompose();
    }, 0);
  });

  queueMicrotask(() => input.focus());
  return box;
}
