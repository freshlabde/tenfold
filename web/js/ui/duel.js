// ui/duel.js - the scale.
//
// What it does: drives prioritize.js with a physical gesture. The pair hangs
// on a beam; dragging tilts it, the side that rises catches the light and the
// other sinks and dims. Past the commit angle the decision is taken. Every
// decision is also a button, because a scale is no use to somebody on a
// keyboard.
//
// What it deliberately does NOT do: it does not write to the document while
// the duel runs. The new order is applied in one reorder call at the end, and
// leaving early keeps the old order untouched.

import { el, text, icon } from "./dom.js";
import { t } from "../i18n.js";
import { startDuel, currentPair, choose, result, progress } from "../prioritize.js";
import { spring, rubberBand } from "../motion.js";
import { pad2 } from "./format.js";

const COMMIT = 88;
const MAX_TILT = 3.4;

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

function cardFor(ctx, item, label) {
  const siblings = ctx.childrenOf(parentId);
  const rank = siblings.findIndex((n) => n.id === item.id);
  return el("div", { class: "duel-card", dataset: { id: item.id } }, [
    el("div", { class: "duel-card-label" }, [text(label)]),
    el("h2", { class: "duel-card-title" }, [text(item.title)]),
    rank >= 0
      ? el("div", { class: "duel-card-sub" }, [text(t("duel.currentRank", { rank: rank + 1 }))])
      : null,
  ]);
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
                el("span", { class: "m" }, [text(pad2(i + 1))]),
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
  const cardA = cardFor(ctx, pair.a, t("duel.labelA"));
  const cardB = cardFor(ctx, pair.b, t("duel.labelB"));

  const scale = el("div", { class: "scale" });
  const glow = el("div", { class: "beam-glow", attrs: { "aria-hidden": "true" } });

  // A button belongs to exactly the pair it was drawn for. A second click on
  // an element that a re-render already replaced must do nothing, or one
  // decision would count twice.
  const commit = (winnerId) => {
    const live = currentPair(duel);
    if (!live || live.a.id !== pair.a.id || live.b.id !== pair.b.id) return;
    history.push(duel);
    duel = choose(duel, winnerId);
    ctx.repaint();
    // The counter is the only thing that changes for somebody who cannot see
    // the scale move, so it is announced.
    const after = progress(duel);
    ctx.live(t("duel.progress", { done: after.done + 1, total: after.estimatedTotal }));
  };

  const dirs = el("div", { class: "duel-dirs" }, [
    el(
      "button",
      {
        class: "btn-ghost",
        attrs: { type: "button", "aria-label": t("duel.chooseA") },
        on: { click: () => commit(pair.a.id) },
      },
      [icon("arrowLeft", 14), text(t("duel.labelA"))],
    ),
    el(
      "button",
      {
        class: "btn-ghost",
        attrs: { type: "button", "aria-label": t("duel.chooseB") },
        on: { click: () => commit(pair.b.id) },
      },
      [text(t("duel.labelB")), icon("arrowRight", 14)],
    ),
  ]);

  scale.appendChild(cardA);
  scale.appendChild(dirs);
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
    dirs.children[0].classList.toggle("is-accent", lean && v < 0);
    dirs.children[1].classList.toggle("is-accent", lean && v > 0);
  };

  beam.addEventListener("pointerdown", (ev) => {
    if (ev.target.closest("button")) return;
    active = true;
    startX = ev.clientX;
    startY = ev.clientY;
    lastX = startX;
    lastT = ev.timeStamp;
    beam.setPointerCapture(ev.pointerId);
  });
  beam.addEventListener("pointermove", (ev) => {
    if (!active) return;
    const mx = ev.clientX - startX;
    const my = ev.clientY - startY;
    if (Math.abs(my) > Math.abs(mx) && Math.abs(my) > 24) {
      active = false;
      paint(0);
      return;
    }
    ev.preventDefault();
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
    if (Math.abs(dx) >= COMMIT) {
      commit(dx > 0 ? pair.b.id : pair.a.id);
      return;
    }
    spring({ from: dx, to: 0, velocity, stiffness: 300, damping: 28, onUpdate: paint });
  };
  beam.addEventListener("pointerup", release);
  beam.addEventListener("pointercancel", release);

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
