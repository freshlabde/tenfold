// ui/mindmap.js - the map's second reading: the list as a mind map.
//
// What it does: lays the whole living tree out around one centre - the vault
// itself - with the ten branching alternately right and left by rank and their
// parts running further outward on the same side. Every title is drawn in full
// (two lines, cut on a word boundary only past the budget) and the layout is
// built FROM the measured text: a hidden ruler in the live SVG returns the real
// advance width of every line in the current skin, and those widths decide the
// column reach, the hit box and the bounds the camera fits to. Rows never
// collide, by construction rather than by a pass: every node owns a disjoint
// vertical band, and a parent takes its own band in the middle of its children,
// which is what gives the branch its up/down split.
//
// What it deliberately does NOT do: no float, no simulation, no randomness and
// no clock - a mind map that breathed would be unreadable, which is the whole
// reason this mode exists. It names no colour either: the family index goes on
// the branch group as a class and app.css decides what that means, exactly as
// in the constellation. No layout work per frame: the camera moves, the tree
// does not.

import { el, sel, icon } from "./dom.js";
import { t } from "../i18n.js";
import { childrenOf } from "../model.js";

// ----------------------------------------------------------------- constants

/** Levels drawn. Everything below is summed onto its level-three ancestor -
 *  the same rule, and the same badge, as the constellation. */
export const MAX_DEPTH = 3;
const FAMILIES = 10;

/**
 * The width budget of a title, per depth, in user units - NOT in characters.
 * Two columns of real text have to share one phone, and the reach of the widest
 * line is the single number that decides how far the camera has to pull back;
 * so the budget is a width, it is spent against the measured advance of the
 * actual string in the actual skin, and it narrows with depth because a part is
 * read in the context of its goal. Roughly 18 characters at the top, 14 at the
 * bottom - but a string of capitals costs more than a string of i's, and only
 * the ruler knows that.
 */
const MAXW = [132, 118, 108, 98];
const MAX_LINES = 2;

/** Type metrics of a row. A single line is 34 high, two lines 43 - inside the
 *  34..44 band a thumb can still separate two titles at a glance. */
const LINE = 15;
const ROW_MIN = 34;
const ROW_PAD = 13;

/** The leading dot carries the family tint; the ring around it carries progress
 *  where there is any, on the same convention as the sky's completion arc. */
const DOT_R = [4.2, 3.4, 3, 2.7];
const RING = 6.8;
const DOT_GAP = 11;

/** How far one level steps outward. Small on purpose: a column per level would
 *  be honest mind-map geometry and unreadable type on a 390pt screen. */
const INDENT = 15;
/** Centre plate edge to the first column - the length of the trunk. */
const TRUNK = 20;

const CENTRE_H = 34;
const CENTRE_PAD = 11;
const MARK = 16;
const MARK_GAP = 6;

const BADGE_GAP = 7;
/** Air around the whole thing, so a fit never puts a letter on the edge. */
const PAD = 10;

// --------------------------------------------------------------------- shape

/**
 * Walk the living tree into a flat list, parents before children. Every item
 * carries the totals of its WHOLE subtree, not only of the drawn part - that is
 * what the +n badge and the progress ring are made of.
 */
function collect(nodes, node, depth, parent, index, siblings, out) {
  const kids = childrenOf(nodes, node.id);
  let item = null;
  if (depth <= MAX_DEPTH) {
    item = {
      id: node.id,
      node,
      depth,
      parent,
      index,
      siblings,
      kids: [],
      total: 0,
      done: 0,
      hidden: 0,
      fam: 0,
      side: 1,
      lines: [],
      textW: 0,
      numW: 0,
      badgeW: 0,
      w: 0,
      h: ROW_MIN,
      x: 0,
      y: 0,
    };
    if (parent) parent.kids.push(item);
    out.push(item);
  }
  let total = 0;
  let done = 0;
  kids.forEach((kid, i) => {
    const s = collect(nodes, kid, depth + 1, item || parent, i, kids.length, out);
    total += s.total + 1;
    done += s.done + (kid.status === "done" ? 1 : 0);
  });
  if (item) {
    item.total = total;
    item.done = done;
    if (depth === MAX_DEPTH) item.hidden = total;
  }
  return { total, done };
}

/**
 * A title broken to fit a WIDTH, not a character count.
 *
 * One line if the whole title fits - a short goal has no business being set as
 * two lines. Past the budget the split is the BALANCED one: of all the word
 * boundaries, the one whose longer half is shortest, which typically costs a
 * third of the reach a greedy fill would have taken ("The people close to /
 * me" is 19 characters wide, "The people / close to me" is 11) and reads
 * better into the bargain. Only when even the balanced pair is too wide is the
 * text filled greedily and ended, on a word boundary, with an ellipsis; and
 * only a single word wider than the whole budget is ever sliced, that one
 * having no boundary to cut on.
 *
 * @returns {{lines: string[], w: number}} the lines and the reach of the widest
 */
export function fitLines(raw, maxW, measure) {
  const words = String(raw || "").split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: ["…"], w: measure("…") };
  const whole = measure(words.join(" "));
  if (whole <= maxW) return { lines: [words.join(" ")], w: whole };

  let best = null;
  for (let i = 1; i < words.length; i += 1) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const m = Math.max(measure(a), measure(b));
    if (!best || m < best.m) best = { lines: [a, b], w: m, m };
  }
  if (best && best.m <= maxW) return { lines: best.lines, w: best.w };

  /** Shave characters off the tail until the ellipsis fits inside the budget. */
  const shave = (value) => {
    let v = value.replace(/[\s,.;:]+$/, "");
    while (v.length > 1 && measure(`${v}…`) > maxW) v = v.slice(0, -1);
    return `${v}…`;
  };

  const lines = [];
  let line = "";
  let i = 0;
  while (i < words.length && lines.length < MAX_LINES) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (measure(next) <= maxW) {
      line = next;
      i += 1;
      continue;
    }
    if (!line) {
      const cut = shave(words[i]);
      return { lines: [cut], w: measure(cut) };
    }
    lines.push(line);
    line = "";
  }
  if (line) lines.push(line);
  if (i < words.length) lines[lines.length - 1] = shave(lines[lines.length - 1]);
  let w = 0;
  for (const l of lines) w = Math.max(w, measure(l));
  return { lines, w };
}

/**
 * Real text extents, one item at a time. Everything the layout does downstream -
 * the column reach, the badge position, the hit box, the bounds the camera fits
 * to - is a function of what came back from here, which is why the ruler runs
 * in the live SVG with the very classes the finished nodes will carry.
 */
function shape(item, measure) {
  const raw = (item.node.title || "").trim() || t("editor.newTitle");
  const cls = `mm-title is-d${item.depth}`;
  const budget = MAXW[item.depth] || MAXW[MAXW.length - 1];
  const fitted = fitLines(raw, budget, (value) => measure(value, cls));
  item.lines = fitted.lines;
  item.textW = fitted.w;
  item.numW = item.depth === 0 ? measure(String(item.index + 1), "mm-rank") + 5 : 0;
  item.badgeW = item.hidden > 0 ? BADGE_GAP + measure(t("map.more", { n: item.hidden }), "mm-more") : 0;
  item.w = DOT_GAP + item.numW + item.textW + item.badgeW;
  item.h = Math.max(ROW_MIN, item.lines.length * LINE + ROW_PAD);
}

// -------------------------------------------------------------------- layout

/**
 * The tidy stack. Columns come from depth, rows from the measured line count,
 * and a parent takes its own row in the MIDDLE of its children - the upper half
 * above it, the lower half below - which is the split that makes a branch look
 * like a branch instead of an indented list. Because the cursor only ever moves
 * forward, every node owns a vertical band nobody else can be in: two titles
 * cannot overlap, at any depth, for any list, without a collision pass.
 * Reading order survives it, top to bottom, rank by rank.
 * @returns {number} the bottom of the band this subtree occupies
 */
function stack(item, x, y, side) {
  item.x = x;
  item.side = side;
  const kids = item.depth < MAX_DEPTH ? item.kids : [];
  if (!kids.length) {
    item.y = y + item.h / 2;
    return y + item.h;
  }
  const childX = x + side * INDENT;
  // floor, not ceil: with one child the parent stays above it, which is what
  // a reader expects, and with four it sits exactly in the middle.
  const up = Math.floor(kids.length / 2);
  let cursor = y;
  for (let i = 0; i < up; i += 1) cursor = stack(kids[i], childX, cursor, side);
  item.y = cursor + item.h / 2;
  cursor += item.h;
  for (let i = up; i < kids.length; i += 1) cursor = stack(kids[i], childX, cursor, side);
  return cursor;
}

function walk(item, fn) {
  fn(item);
  for (const kid of item.kids) walk(kid, fn);
}

function shiftBranch(item, dy) {
  walk(item, (it) => {
    it.y += dy;
  });
}

// ------------------------------------------------------------------- drawing

const n2 = (v) => v.toFixed(2);

/**
 * One edge, one cubic. The trunk leaves the centre plate horizontally and
 * arrives at its goal the same way; a branch inside a family drops out of its
 * parent and curves outward into the child, because there the vertical distance
 * is the large one and a horizontal S would read as a wobble.
 */
function curve(px, py, cx, cy, side, trunk) {
  const dx = Math.abs(cx - px);
  const dy = cy - py;
  if (trunk) {
    const k = Math.max(10, dx * 0.62);
    return `M${n2(px)} ${n2(py)}C${n2(px + side * k)} ${n2(py)} ${n2(cx - side * k)} ${n2(cy)} ${n2(cx)} ${n2(cy)}`;
  }
  const k = Math.max(10, Math.abs(dy) * 0.5) * (dy < 0 ? -1 : 1);
  return `M${n2(px)} ${n2(py)}C${n2(px)} ${n2(py + k)} ${n2(cx - side * dx * 1.1)} ${n2(cy)} ${n2(cx)} ${n2(cy)}`;
}

/** One node: its ring, its dot, its rank, its full title, its badge, its box. */
function drawNode(item) {
  const side = item.side;
  const cls = ["mm-node", `is-d${item.depth}`];
  if (item.node.status === "done") cls.push("is-done");
  const g = sel("g", {
    class: cls.join(" "),
    attrs: {
      "data-node": item.id,
      role: "button",
      tabindex: "0",
      "aria-label": t("a11y.openNode", { title: item.node.title || t("editor.newTitle") }),
    },
  });
  const gx = item.x;
  const gy = item.y;

  if (item.total > 0) {
    const c = 2 * Math.PI * RING;
    g.appendChild(sel("circle", { class: "map-arcbase", attrs: { cx: n2(gx), cy: n2(gy), r: RING } }));
    const ratio = item.done / item.total;
    if (ratio > 0) {
      g.appendChild(
        sel("circle", {
          class: "map-arc",
          attrs: {
            cx: n2(gx),
            cy: n2(gy),
            r: RING,
            "stroke-dasharray": `${(c * ratio).toFixed(2)} ${c.toFixed(2)}`,
            transform: `rotate(-90 ${n2(gx)} ${n2(gy)})`,
          },
        }),
      );
    }
  }

  g.appendChild(
    sel("circle", { class: "mm-dot", attrs: { cx: n2(gx), cy: n2(gy), r: DOT_R[item.depth] || 2.7 } }),
  );

  const anchor = side > 0 ? "start" : "end";
  // The rank sits BEFORE the title in reading order, on both sides - which on
  // the left branch means at the outer end of the row, not next to the dot.
  // A figure that trails its own title reads as a count, not as a rank.
  const tx = side > 0 ? gx + DOT_GAP + item.numW : gx - DOT_GAP;
  if (item.depth === 0) {
    g.appendChild(
      sel("text", {
        class: "mm-rank",
        text: String(item.index + 1),
        attrs: {
          x: n2(side > 0 ? gx + DOT_GAP : tx - item.textW - 5),
          y: n2(gy),
          "text-anchor": anchor,
        },
      }),
    );
  }
  const top = gy - ((item.lines.length - 1) * LINE) / 2;
  item.lines.forEach((line, i) => {
    g.appendChild(
      sel("text", {
        class: `mm-title is-d${item.depth}`,
        text: line,
        attrs: { x: n2(tx), y: n2(top + i * LINE), "text-anchor": anchor },
      }),
    );
  });
  if (item.hidden > 0) {
    g.appendChild(
      sel("text", {
        class: "mm-more",
        text: t("map.more", { n: item.hidden }),
        attrs: { x: n2(tx + side * (item.textW + BADGE_GAP)), y: n2(gy), "text-anchor": anchor },
      }),
    );
  }

  // The whole row is the target - this is the reading view, and a 3px dot is
  // not something a thumb should have to find.
  const hx = side > 0 ? gx - 9 : gx - (item.w + 3);
  g.appendChild(
    sel("rect", {
      class: "mm-hit",
      attrs: {
        x: n2(hx),
        y: n2(gy - item.h / 2),
        width: n2(item.w + 12),
        height: n2(item.h),
        "data-hit": item.id,
      },
    }),
  );
  return g;
}

/** One family: the trunk, every edge below it, then every node. */
function drawBranch(root, centreHalf) {
  const g = sel("g", { class: `mm-branch is-fam${root.fam}` });
  g.style.setProperty("--i", String(root.index));
  const links = sel("g", { class: "mm-links" });
  links.appendChild(
    sel("path", {
      class: "mm-link is-trunk",
      attrs: { d: curve(root.side * centreHalf, 0, root.x, root.y, root.side, true) },
    }),
  );
  walk(root, (it) => {
    for (const kid of it.kids) {
      links.appendChild(
        sel("path", { class: "mm-link", attrs: { d: curve(it.x, it.y, kid.x, kid.y, it.side, false) } }),
      );
    }
  });
  g.appendChild(links);
  walk(root, (it) => g.appendChild(drawNode(it)));
  return g;
}

/** The vault, as a node: the mark and the name of the list, on one plate. */
function drawCentre(halfW, label) {
  const g = sel("g", { class: "mm-centre" });
  g.appendChild(
    sel("rect", {
      class: "mm-centre-plate",
      attrs: {
        x: n2(-halfW),
        y: n2(-CENTRE_H / 2),
        width: n2(halfW * 2),
        height: CENTRE_H,
        rx: CENTRE_H / 2,
      },
    }),
  );
  const mark = icon("mark", MARK);
  mark.setAttribute("class", "mm-centre-mark");
  mark.setAttribute("x", n2(-halfW + CENTRE_PAD));
  mark.setAttribute("y", n2(-MARK / 2));
  g.appendChild(mark);
  g.appendChild(
    sel("text", {
      class: "mm-centre-label",
      text: label,
      attrs: { x: n2(-halfW + CENTRE_PAD + MARK + MARK_GAP), y: 0, "text-anchor": "start" },
    }),
  );
  return g;
}

// --------------------------------------------------------------------- ruler

/**
 * The hidden ruler. It lives in the very SVG the tree will be drawn in and
 * carries the very classes the finished text will carry, so a skin with a serif
 * body font measures as a serif and the layout widens with it. Cached per
 * string and class - a tree of forty nodes costs about eighty measurements,
 * once, and never again.
 */
export function makeRuler(svg) {
  const g = sel("g", { attrs: { "aria-hidden": "true" }, style: { visibility: "hidden" } });
  const node = sel("text", { attrs: { x: -9999, y: -9999 } });
  g.appendChild(node);
  svg.appendChild(g);
  const cache = new Map();
  return {
    measure(value, cls) {
      const key = `${cls} ${value}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      node.setAttribute("class", cls);
      node.textContent = value;
      let w = 0;
      try {
        w = node.getComputedTextLength();
      } catch {
        w = 0;
      }
      // Not laid out yet, or a font that refuses to measure: half an em per
      // character is close enough that the fit is still sane.
      if (!w) w = value.length * 6.2;
      cache.set(key, w);
      return w;
    },
    dispose() {
      if (g.parentNode) g.parentNode.removeChild(g);
    },
  };
}

// --------------------------------------------------------------------- scene

/**
 * Build the whole mind map.
 * @param {Array} nodes the living document
 * @param {(value: string, cls: string) => number} measure a ruler
 * @returns {{g: SVGElement, items: Array, bounds: Object, centreHalf: number}}
 */
export function buildScene(nodes, measure) {
  const roots = childrenOf(nodes, null);
  const items = [];
  roots.forEach((root, i) => collect(nodes, root, 0, null, i, roots.length, items));
  for (const item of items) shape(item, measure);

  const label = t("outline.title");
  const centreHalf = (CENTRE_PAD * 2 + MARK + MARK_GAP + measure(label, "mm-centre-label")) / 2;
  const columnX = centreHalf + TRUNK;

  // Rank one goes right and top, rank two left and top, and so on down: the
  // two columns stay the same length within one goal of each other, and the
  // list still reads top to bottom on both sides.
  const sides = [[], []];
  const tops = items.filter((it) => it.depth === 0);
  tops.forEach((it, i) => {
    it.fam = i % FAMILIES;
    sides[i % 2].push(it);
  });

  [1, -1].forEach((side, s) => {
    let cursor = 0;
    for (const root of sides[s]) cursor = stack(root, side * columnX, cursor, side);
    const shift = -cursor / 2;
    for (const root of sides[s]) shiftBranch(root, shift);
  });

  const g = sel("g", { class: "mm-tree" });
  g.appendChild(drawCentre(centreHalf, label));
  for (const root of tops) g.appendChild(drawBranch(root, centreHalf));

  let minX = -centreHalf;
  let maxX = centreHalf;
  let minY = -CENTRE_H / 2;
  let maxY = CENTRE_H / 2;
  for (const it of items) {
    const x0 = it.side > 0 ? it.x - 9 : it.x - (it.w + 3);
    const x1 = it.side > 0 ? it.x + it.w + 3 : it.x + 9;
    if (x0 < minX) minX = x0;
    if (x1 > maxX) maxX = x1;
    if (it.y - it.h / 2 < minY) minY = it.y - it.h / 2;
    if (it.y + it.h / 2 > maxY) maxY = it.y + it.h / 2;
  }
  return {
    g,
    items,
    centreHalf,
    bounds: { minX: minX - PAD, minY: minY - PAD, maxX: maxX + PAD, maxY: maxY + PAD },
  };
}

// -------------------------------------------------------------------- chrome

/** The two glyphs, drawn here rather than added to the shared icon table: they
 *  belong to one control on one screen. Same stroke weight as every other icon
 *  in the app, so the header stays one set. */
function glyph(paths, dots = []) {
  const svg = sel("svg", {
    attrs: {
      width: 19,
      height: 19,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.7,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    },
  });
  for (const d of paths) svg.appendChild(sel("path", { attrs: { d } }));
  for (const [cx, cy, r] of dots) {
    svg.appendChild(sel("circle", { attrs: { cx, cy, r, fill: "currentColor", stroke: "none" } }));
  }
  return svg;
}

/** A centre, two branches, three titles - the shape of the thing it switches to. */
function treeGlyph() {
  return glyph(
    [
      "M6.4 12h12.4",
      "M8.6 12C8.6 7.2 10.1 6.8 13.4 6.8",
      "M13.4 6.8h5.4",
      "M8.6 12c0 4.8 1.5 5.2 4.8 5.2",
      "M13.4 17.2h5.4",
    ],
    [[5, 12, 1.9]],
  );
}

/**
 * Bodies of different sizes, scattered - the sky, in miniature. Filled and
 * without the connecting lines on purpose: three small rings joined by two
 * strokes is the share icon on every phone made, and the one thing this glyph
 * has to say is that the other reading is a scatter, not a structure.
 */
function skyGlyph() {
  return glyph([], [
    [12.4, 5.4, 2.4],
    [5.6, 9.4, 1.3],
    [18.2, 10.4, 1.5],
    [8.8, 15.2, 3],
    [16.4, 18, 1.9],
    [4.8, 19.2, 1.1],
  ]);
}

/**
 * The two-state control in the map header. It carries no words - two glyphs and
 * their labels, so a screen reader hears "Constellation, pressed" and a thumb
 * still gets the full target every other control in the app is held to.
 * @param {"sky"|"tree"} current
 * @param {(mode: "sky"|"tree") => void} pick
 */
export function modeToggle(current, pick) {
  const make = (mode, glyphNode) =>
    el(
      "button",
      {
        class: "map-mode-btn",
        attrs: {
          type: "button",
          "aria-label": t(`map.mode.${mode}`),
          "aria-pressed": current === mode ? "true" : "false",
        },
        on: {
          click: () => {
            if (current !== mode) pick(mode);
          },
        },
      },
      [glyphNode],
    );
  return el(
    "div",
    { class: "map-mode", attrs: { role: "group", "aria-label": t("map.mode.label") } },
    [make("sky", skyGlyph()), make("tree", treeGlyph())],
  );
}
