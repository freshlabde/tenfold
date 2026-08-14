// ui/duel.js - the scale.
//
// What it does: drives prioritize.js with a physical gesture. The pair hangs
// on a beam; dragging tilts it, the side that rises catches the light and the
// other sinks and dims. Past the commit angle the decision is taken. The card
// IS the button: a plain tap on it is the same decision as the swipe towards
// it, so nothing on this screen needs to be aimed at. Each card carries a
// thick arrow on the edge it travels towards - the direction is on the thing
// that moves, not in a legend between the two.
//
// What it deliberately does NOT do: it does not write to the document while
// the duel runs. The new order is applied in one reorder call at the end, and
// leaving early keeps the old order untouched.

import { el, text, icon } from "./dom.js";
import { t } from "../i18n.js";
import { startDuel, currentPair, choose, result, progress } from "../prioritize.js";
import { spring, rubberBand, prefersReducedMotion } from "../motion.js";
import { decisionCommitted } from "../haptics.js";
import { pad2 } from "./format.js";

const COMMIT = 88;
const MAX_TILT = 3.4;
// A pointer that travelled this far was a gesture and must not also count as
// a tap - the click event arrives after pointerup, when dx is back at zero.
const TAP_SLOP = 9;
// One beat for the chosen card to be seen before the next pair paints. Short
// enough that a run of ten decisions does not feel metered.
const ACK_MS = 190;

let duel = null;
let parentId;
let history = [];

function ensure(ctx, id) {
  if (duel && parentId === id) return;
  parentId = id;
  history = [];
  duel = startDuel(ctx.childrenOf(id).map((n) => ({ id: n.id, title: n.title })));
}

export function reset() {
  duel = null;
  parentId = undefined;
  history = [];
}

/**
 * One side of the scale. `side` is "a" (swiped left) or "b" (swiped right);
 * the arrow is drawn from the shared icon table at three times its stroke
 * weight and placed on the edge the card is pushed towards.
 */
function cardFor(ctx, item, label, side) {
  const siblings = ctx.childrenOf(parentId);
  const rank = siblings.findIndex((n) => n.id === item.id);
  const glyph = icon(side === "a" ? "arrowLeft" : "arrowRight", 34);
  glyph.setAttribute("class", "duel-arrow-glyph");
  return el(
    "div",
    {
      class: `duel-card is-tappable is-${side}`,
      dataset: { id: item.id, side },
      // The whole card is the control, so it carries the role and the name.
      // The letter stays as a label only - "currently place n" is read next
      // to it and the A/B wording is what the rest of the screen refers to.
      attrs: {
        role: "button",
        tabindex: "0",
        "aria-label": t("duel.chooseCard", { title: item.title }),
      },
    },
    [
      el("span", { class: "duel-arrow", attrs: { "aria-hidden": "true" } }, [glyph]),
      el("div", { class: "duel-card-label" }, [text(label)]),
      el("h2", { class: "duel-card-title" }, [text(item.title)]),
      rank >= 0
        ? el("div", { class: "duel-card-sub" }, [text(t("duel.currentRank", { rank: rank + 1 }))])
        : null,
    ],
  );
}

function finished(ctx) {
  const order = result(duel);
  return el("section", { class: "screen" }, [
    el("div", { class: "head" }, [
      el("div", { class: "eyebrow" }, [text(t("outline.order"))]),
      el("h1", { class: "h-title" }, [text(t("duel.doneTitle"))]),
      el("p", { class: "h-sub" }, [text(t("duel.doneBody"))]),
    ]),
    el(
      "div",
      { class: "scroll" },
      [
        el(
          "ul",
          { class: "list" },
          order.map((nodeId, i) => {
            const node = ctx.nodeById(nodeId);
            return el("li", { class: "row-shell", vars: { "--rank": String(i) } }, [
              el("div", { class: `row${i === 0 ? " is-lead" : ""}` }, [
                el("span", { class: "row-chip", attrs: { "aria-hidden": "true" }, text: String(i + 1) }),
                el("div", { class: "row-body" }, [
                  el("div", { class: "row-title" }, [text(node ? node.title : "")]),
                ]),
                // No second figure in the mono rail: it said the same number as
                // the chip on the left, one column further over.
              ]),
            ]);
          }),
        ),
      ],
    ),
    el("div", { class: "bar" }, [
      el(
        "button",
        {
          class: "btn",
          attrs: { type: "button" },
          on: {
            click: () => {
              const back = parentId;
              reset();
              ctx.go(back === null ? "outline" : "focus", back, { replace: true });
            },
          },
        },
        [text(t("duel.discard"))],
      ),
      el(
        "button",
        {
          class: "btn is-primary",
          attrs: { type: "button" },
          on: {
            click: () => {
              const pid = parentId;
              const ids = result(duel);
              reset();
              ctx.applyOrder(pid, ids);
            },
          },
        },
        [icon("check", 16), text(t("duel.apply"))],
      ),
    ]),
  ]);
}

export function render(ctx, id) {
  ensure(ctx, id);
  const pair = currentPair(duel);
  if (!pair) return finished(ctx);

  const p = progress(duel);
  const cardA = cardFor(ctx, pair.a, t("duel.labelA"), "a");
  const cardB = cardFor(ctx, pair.b, t("duel.labelB"), "b");

  const scale = el("div", { class: "scale" });
  const glow = el("div", { class: "beam-glow", attrs: { "aria-hidden": "true" } });

  // A button belongs to exactly the pair it was drawn for. A second click on
  // an element that a re-render already replaced must do nothing, or one
  // decision would count twice.
  const commit = (winnerId) => {
    // The acknowledgement runs on a timer, so the screen may have been left
    // in the meantime - a finished or discarded duel is no longer decidable.
    if (!duel) return;
    const live = currentPair(duel);
    if (!live || live.a.id !== pair.a.id || live.b.id !== pair.b.id) return;
    history.push(duel);
    // Here rather than in `pick` or in the swipe release: this is the single
    // point both routes into a decision pass through, and it is the point past
    // the two guards above - a stale button and a duel that was left in the
    // meantime both come this far and neither is a decision anybody made.
    decisionCommitted();
    duel = choose(duel, winnerId);
    ctx.repaint();
    // The counter is the only thing that changes for somebody who cannot see
    // the scale move, so it is announced.
    const after = progress(duel);
    ctx.live(t("duel.progress", { done: after.done + 1, total: after.estimatedTotal }));
  };

  // A tap is the swipe without the travel: the chosen card plays the lift the
  // gesture would have shown, then the next pair paints. One decision per
  // render - a second tap during the beat would land on the same pair.
  let picking = false;
  const pick = (winnerId, card) => {
    if (picking) return;
    picking = true;
    if (prefersReducedMotion()) {
      commit(winnerId);
      return;
    }
    card.classList.add("is-up", "is-chosen");
    (card === cardA ? cardB : cardA).classList.add("is-down");
    setTimeout(() => commit(winnerId), ACK_MS);
  };

  scale.appendChild(cardA);
  scale.appendChild(cardB);
  scale.appendChild(el("div", { class: "scale-pivot", attrs: { "aria-hidden": "true" } }));

  const beam = el("div", { class: "beam" }, [glow, scale]);

  // --- the gesture ---------------------------------------------------------
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let active = false;
  let velocity = 0;
  let lastX = 0;
  let lastT = 0;
  let gestured = false;

  const paint = (v) => {
    dx = v;
    const tilt = Math.max(-MAX_TILT, Math.min(MAX_TILT, v / 26));
    scale.style.setProperty("--dx", String(v));
    scale.style.setProperty("--tilt", String(tilt));
    glow.classList.toggle("is-left", v < 0);
    glow.style.opacity = String(Math.min(1, Math.abs(v) / COMMIT) * 0.55);
    const lean = Math.abs(v) > 18;
    cardA.classList.toggle("is-up", lean && v < 0);
    cardA.classList.toggle("is-down", lean && v > 0);
    cardB.classList.toggle("is-up", lean && v > 0);
    cardB.classList.toggle("is-down", lean && v < 0);
    // The arrow answers the drag proportionally, and only on the side the
    // finger is actually going - both of them brightening would say nothing.
    const reach = Math.min(1, Math.abs(v) / COMMIT);
    cardA.style.setProperty("--arm", String(v < 0 ? reach : 0));
    cardB.style.setProperty("--arm", String(v > 0 ? reach : 0));
    cardA.classList.toggle("is-armed", lean && v < 0);
    cardB.classList.toggle("is-armed", lean && v > 0);
  };

  const setDragging = (on) => scale.classList.toggle("is-dragging", on);

  beam.addEventListener("pointerdown", (ev) => {
    if (ev.target.closest("button")) return;
    active = true;
    gestured = false;
    startX = ev.clientX;
    startY = ev.clientY;
    lastX = startX;
    lastT = ev.timeStamp;
    // The capture is deliberately NOT taken here. While a pointer is captured
    // the click event is dispatched at the capturing element, so a card that
    // was merely tapped would never see its own click - and the card is the
    // button now. The capture is taken below, the moment a drag is real.
  });
  beam.addEventListener("pointermove", (ev) => {
    if (!active) return;
    const mx = ev.clientX - startX;
    const my = ev.clientY - startY;
    if (Math.abs(my) > Math.abs(mx) && Math.abs(my) > 24) {
      // A scroll away from the beam is not a decision, and the click that
      // follows it must not become one either.
      active = false;
      gestured = true;
      setDragging(false);
      paint(0);
      return;
    }
    ev.preventDefault();
    if (Math.abs(mx) > TAP_SLOP && !gestured) {
      gestured = true;
      setDragging(true);
      // From here the finger owns the beam, wherever it travels.
      beam.setPointerCapture(ev.pointerId);
    }
    const dt = Math.max(1, ev.timeStamp - lastT);
    velocity = ((ev.clientX - lastX) / dt) * 1000;
    lastX = ev.clientX;
    lastT = ev.timeStamp;
    const over = Math.abs(mx) - COMMIT;
    paint(over > 0 ? Math.sign(mx) * (COMMIT + rubberBand(over, 70)) : mx);
  });
  const release = () => {
    if (!active) return;
    active = false;
    setDragging(false);
    if (Math.abs(dx) >= COMMIT) {
      // A committed swipe answers with the tilt it already has; the tap
      // acknowledgement would only delay the next pair.
      commit(dx > 0 ? pair.b.id : pair.a.id);
      return;
    }
    spring({ from: dx, to: 0, velocity, stiffness: 300, damping: 28, onUpdate: paint });
  };
  beam.addEventListener("pointerup", release);
  beam.addEventListener("pointercancel", release);

  // The card as a control. Click covers mouse, pen and the synthetic tap after
  // a touch; the keys are here because the two cards are the only focusable
  // things on this screen, so a left/right key can mean what a swipe means.
  const wire = (card, winnerId) => {
    card.addEventListener("click", () => {
      if (gestured) {
        gestured = false;
        return;
      }
      pick(winnerId, card);
    });
    card.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        pick(winnerId, card);
        return;
      }
      if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        pick(pair.a.id, cardA);
        return;
      }
      if (ev.key === "ArrowRight") {
        ev.preventDefault();
        pick(pair.b.id, cardB);
      }
    });
  };
  wire(cardA, pair.a.id);
  wire(cardB, pair.b.id);

  // --- head and foot -------------------------------------------------------
  // The counter is stated once, in the mono rail, and drawn once as a bar -
  // the same number twice in two forms would be noise.
  const head = el("div", { class: "duel-head" }, [
    el("h2", {}, [text(t("duel.title"))]),
    el("p", { class: "h-sub", style: { textAlign: "center" } }, [
      text(t("duel.progress", { done: pad2(p.done + 1), total: p.estimatedTotal })),
    ]),
    el("div", { class: "duel-prog" }, [
      el("span", { class: "track", vars: { "--p": String(p.estimatedTotal ? p.done / p.estimatedTotal : 0) } }, [
        el("i", {}),
      ]),
    ]),
  ]);

  const foot = el("div", { class: "duel-foot" }, [
    el(
      "button",
      {
        class: "btn-ghost",
        attrs: { type: "button", disabled: history.length ? false : "disabled" },
        on: {
          click: () => {
            const prev = history.pop();
            if (prev) {
              duel = prev;
              ctx.repaint();
            }
          },
        },
      },
      [text(t("duel.back"))],
    ),
    el(
      "button",
      {
        class: "btn-ghost",
        attrs: { type: "button" },
        on: {
          click: () => {
            const back = parentId;
            reset();
            ctx.go(back === null ? "outline" : "focus", back, { replace: true });
          },
        },
      },
      [text(t("duel.skip"))],
    ),
  ]);

  return el("section", { class: "screen" }, [
    el("div", { class: "duel" }, [head, beam, foot]),
  ]);
}
