// ui/rows.js - the row, and the gestures that live on it.
//
// What it does: builds one node row (rank chip, title, sub line, mono metric,
// progress track) and wires the direct manipulations from the design: swipe
// right on a step to finish it, swipe left on any row to delete it, long press
// to lift and reorder siblings. All of them run on real spring physics with
// rubber-band resistance past their limits, and all of them have a visible
// button equivalent in the row menu.
//
// What it deliberately does NOT do: no innerHTML, no business rules. It asks
// the context to mutate the document and re-render; it never writes to the
// document itself and never touches storage.

import { el, text, icon, depthMark } from "./dom.js";
import { childrenOf, isLeaf, storyDepth, dueGroupOf } from "../model.js";
import { metricFor, progressOf, dueLabel } from "./format.js";
import { t } from "../i18n.js";
import { spring, rubberBand, collapse, prefersReducedMotion } from "../motion.js";
import { stepFinished, rowDeleted, rowLifted, rowShifted, rowDropped, warmUp } from "../haptics.js";

const SWIPE_START = 8;
/* The slop that CANCELS a pending long press, deliberately larger than the
   8px that declares a swipe. A thumb waiting out the press timer drifts -
   more as a hand gets less careful through a session, which is exactly the
   "sorting works at first, later not" a device round reported. The scroll
   never needed the early guess: touch-action pan-y means a real scroll
   arrives as pointercancel, which this file already treats as a release. */
const PRESS_CANCEL = 15;
const SWIPE_COMMIT = 92;
const LONG_PRESS_MS = 420;

/**
 * The small line under a title. `opts.path` is the whole chain a step hangs in
 * - the today list needs it, because there a row is torn out of its context and
 * "call the physio" alone says nothing about which goal it serves.
 *
 * Built from spans rather than one string for a single reason: an overdue step
 * that says so in the same grey as everything else is not read. The due phrase
 * - and only that phrase, never the whole row - carries the accent, and which
 * of the two due groups it is in comes from model.dueGroupOf, so the colour
 * cannot disagree with the badge or with the Today list.
 * @returns {HTMLElement|null} the line, or null when there is nothing to say
 */
function subLine(ctx, node, opts = {}) {
  const parts = [];
  if (opts.path) parts.push(el("span", { class: "row-path" }, [text(opts.path)]));
  if (node.status === "doing") parts.push(el("span", {}, [text(t("status.doing"))]));
  if (typeof node.due === "number" && node.status !== "done") {
    const group = dueGroupOf(node, ctx.now());
    const tone = group === 0 ? " is-overdue" : group === 1 ? " is-today" : "";
    parts.push(el("span", { class: `row-due${tone}` }, [text(dueLabel(node.due, ctx.now()))]));
  }
  if (!parts.length) return null;

  const line = el("div", { class: "row-sub" });
  parts.forEach((part, i) => {
    if (i) line.appendChild(text(" · "));
    line.appendChild(part);
  });
  return line;
}

/**
 * One row.
 * @param {Object} ctx app context
 * @param {Object} node
 * @param {{rank:number,total:number,lead:boolean,showRank:boolean,path:string,
 *          tier:0|1|2|3}} opts
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

  // One layer, two roles, one extra glyph: the check sits on the left edge and
  // the trash on the right, and the swipe lights whichever the finger is
  // pulling towards. A second .row-behind element would double the absolutely
  // positioned layers in every list for nothing, and swapping the paths of a
  // single icon would rebuild SVG nodes in the middle of a drag.
  const okMark = icon("check", 22);
  okMark.setAttribute("class", "behind-ok");
  const delMark = icon("trash", 22);
  delMark.setAttribute("class", "behind-del");
  const behind = el("div", { class: "row-behind", attrs: { "aria-hidden": "true" } }, [okMark, delMark]);

  // A finished node carries the check instead of its figure - the one green
  // in the app, consistent across all skins.
  const done = node.status === "done";
  const chipLabel = opts.showRank ? String(rank + 1) : leaf ? "·" : "–";
  const chip = done
    ? el("span", { class: "row-chip", attrs: { "aria-hidden": "true" } }, [icon("check", 13)])
    : el("span", { class: "row-chip", attrs: { "aria-hidden": "true" }, text: chipLabel });

  const body = el("div", { class: "row-body" }, [
    el("div", { class: "row-title" }, [text(node.title || t("editor.newTitle"))]),
  ]);
  const sub = subLine(ctx, node, opts);
  if (sub) body.appendChild(sub);

  // The mono rail on the right: the machine figure, and - unless it is
  // switched off - the story-depth ring in front of it.
  const showDepth = (ctx.doc.settings || {}).storyDepth !== false;
  const depth = storyDepth(node);
  const metric = el("div", { class: "row-meta" }, [
    showDepth && depth > 0 ? depthMark(depth) : null,
    el("span", { class: "m" }, [text(metricFor(nodes, node))]),
  ]);

  // The importance band. Pure CSS could derive it from --rank, but only as a
  // chain of comparisons written three times over; a class says outright which
  // of the three a row is in, and it is the same thing the design calls it.
  // Zero means "no bands here" - every list that is not the ranked ten.
  const row = el("div", {
    class: `row${opts.tier ? ` is-tier${opts.tier}` : ""}${opts.lead ? " is-lead" : ""}${
      node.status === "done" ? " is-done" : ""
    }${node.status === "parked" ? " is-parked" : ""}`,
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
  // Every row carries its --rank, in every list. The loudness ramp that reads
  // that rank belongs to the ranked ten alone, so it hangs off the class that
  // marks exactly the list which also shows the rank figures - a sublist and
  // the today list are ordered, but their order is not the point of them.
  const ul = el("ul", {
    class: opts.kids ? "list is-kids" : opts.showRank ? "list is-ranked" : "list",
    // The quiet end of the ramp is the last row THIS list has, not a fixed
    // rank ten - an eight-goal list must run the same loud-to-quiet arc.
    vars: opts.showRank ? { "--rank-last": String(Math.max(1, kids.length - 1)) } : undefined,
  });
  if (opts.kids) ul.appendChild(el("div", { class: "rail", attrs: { "aria-hidden": "true" } }));
  kids.forEach((n, i) => {
    ul.appendChild(
      nodeRow(ctx, n, {
        rank: i,
        total: kids.length,
        lead: !!opts.lead && i === 0,
        showRank: !!opts.showRank,
        // The three bands of the ranked ten: the lead, the two behind it, and
        // the rest. Only the list that shows rank figures has them at all.
        tier: opts.showRank ? (i === 0 ? 1 : i <= 2 ? 2 : 3) : 0,
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
    // The distance is read as a magnitude and the direction as a class, so the
    // affordance rises out of the same ratio on both sides.
    const ratio = Math.max(0, Math.min(1, Math.abs(v) / SWIPE_COMMIT));
    behind.classList.toggle("is-delete", v < 0);
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
      // beginDrag FIRST, and the mode only once it answered. It returns null
      // when the shell has no parent - a row from a render that has since
      // been torn down - and spending the mode on a null drag was this file's
      // quietest failure: the row buzzed, nothing moved, the release did
      // nothing, and the person's report read "sorting works at first, later
      // not". A dead press now stays mode none, costs no haptic, and the next
      // press starts clean on the fresh render.
      drag = beginDrag(ctx, shell, row, node, opts);
      if (!drag) return;
      mode = "drag";
      // The lift is the one moment on this row where nothing has moved yet and
      // something has nevertheless happened: the press was long enough, and the
      // row now belongs to the finger. A hand holding still has no other way of
      // being told that, so this is the haptic that earns its keep most.
      rowLifted();
    }, LONG_PRESS_MS);
    row.setPointerCapture(ev.pointerId);
  };

  // Fix 3 of the sort hunt: preventDefault() on pointermove cannot take back
  // an axis that touch-action already granted - per spec, a pan the UA has
  // begun keeps running. pan-y is granted on every row (it is how the list
  // scrolls), so a DRAG has to refuse the native pan at the touchmove level,
  // from a non-passive listener registered up front. On The Ten this is a
  // no-op by geometry (ten rows can never overflow); on a goal's step list it
  // is the difference between dragging a row and scrolling the screen with a
  // row stuck to the finger.
  const onTouchMove = (ev) => {
    if (mode === "drag") ev.preventDefault();
  };

  const onMove = (ev) => {
    if (!down) return;
    // Belt and braces for mice: a captured pointer can report moves after the
    // button was released outside the window.
    if (ev.pointerType === "mouse" && ev.buttons === 0) return;
    const mx = ev.clientX - startX;
    const my = ev.clientY - startY;
    if (mode === "none") {
      if (Math.abs(my) > PRESS_CANCEL && Math.abs(my) > Math.abs(mx)) {
        mode = "scroll";
        clearTimeout(pressTimer);
        // gestured, or the click that follows pointerup opens the node. The
        // Ten never overflows, so WebKit does not swallow that click there -
        // measured in a simulator walk where an attempted scroll opened a
        // goal and the test met an empty outline two rounds later.
        gestured = true;
        return;
      }
      if (Math.abs(mx) > SWIPE_START) {
        clearTimeout(pressTimer);
        mode = "swipe";
        // The swipe has declared itself; the commit is 84px away. Wake the
        // Taptic Engine NOW so the success or warning at the end lands - a
        // notification pattern asked of a cold engine is quietly dropped,
        // which is why sorting buzzed while a lone swipe out of idle did not.
        warmUp();
      }
    }
    if (mode === "swipe") {
      ev.preventDefault();
      const dt = Math.max(1, ev.timeStamp - lastT);
      velocity = ((ev.clientX - lastX) / dt) * 1000;
      lastX = ev.clientX;
      lastT = ev.timeStamp;
      // Both directions mean something now, so both travel one to one. The
      // exception is unchanged: a goal cannot be finished by a swipe, so for
      // one of those the right side stays pure resistance.
      dx = mx >= 0 ? (leaf ? mx : rubberBand(mx, 90)) : mx;
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
      } else if (dx < -SWIPE_COMMIT) {
        remove();
      } else {
        reset(dx, velocity);
      }
    }
    mode = "none";
    dx = 0;
  };

  const finish = async () => {
    // Before the collapse, not after it: the answer belongs to the finger that
    // is still on the glass. Waiting for the animation would put a fifth of a
    // second between the gesture and its confirmation, which is long enough to
    // read as a response to something else.
    stepFinished();
    setX(SWIPE_COMMIT + 40);
    await collapse(shell);
    ctx.setStatus(node.id, "done");
  };

  // The mirror of finish(), and deliberately not a second deletion rule: it
  // calls exactly what the row menu's Delete calls, so the tombstone covers the
  // same subtree and the same undo toast is offered. The menu asks for no
  // confirmation on any node kind, so this must not invent one either - the
  // toast is what makes both paths recoverable.
  const remove = async () => {
    // Deliberately not the same feeling as the finish above. The two gestures
    // are mirror images on one row and one of them takes a whole subtree away,
    // so the hand should be able to tell which one it just made without
    // looking - see haptics.js for why this is the warning and not an impact.
    rowDeleted();
    setX(-(SWIPE_COMMIT + 40));
    await collapse(shell);
    ctx.deleteNode(node);
  };

  const activate = () => {
    if (ctx.openNode) ctx.openNode(node, row);
  };

  row.addEventListener("pointerdown", onDown);
  // Non-passive on purpose - a passive listener may not preventDefault, and
  // preventing the native pan mid-drag is this listener's only job.
  row.addEventListener("touchmove", onTouchMove, { passive: false });
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
    // Once per crossing, exactly here: this line is the app deciding the row
    // occupies a new slot, and the neighbours animating is its visible half.
    rowShifted();
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
      if (to !== from) {
        rowDropped();
        ctx.reorderSibling(node, opts.parentId === undefined ? node.parentId : opts.parentId, to);
      }
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
