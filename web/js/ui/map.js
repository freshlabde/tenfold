// ui/map.js - the whole list as one sky, or as one mind map.
//
// The screen has TWO readings of the same tree and one of everything else: one
// camera, one gesture layer, one set of family hues, one header. The
// constellation below is the atmosphere; the mind map (ui/mindmap.js) is the
// structural reading, where every title is drawn in full and nothing moves.
// Which one is showing lives in doc.settings.mapMode ("sky" | "tree"), so the
// choice travels with the vault. Everything from here down to "the screen" is
// the sky; the mind map contributes a scene and reads the same camera.
//
// What it does: draws every living node of the tree as a floating body. The
// ten roots descend the screen in rank order - rank one largest and highest -
// alternating around a vertical axis and widest in the middle, their parts
// orbit them, and the parts of those parts orbit again. Rank is carried by
// size AND by light: rank one is about 2.3x the radius of rank ten and stands
// at nearly full accent, rank ten is a dim ember, and a quiet mono figure
// inside each root says which is which. Each family turns the accent hue by a
// few fixed degrees so a branch is its own when the camera comes close, while
// the sky as a whole stays one metal - the app has one accent per skin and
// this screen does not get a second. Where the tree goes
// deeper than three levels the rest is summed up into a small figure on its
// level-three ancestor. Each family carries one of the ten hues of the data
// palette, which is what says at a glance which small orbs belong to which
// goal; rank never rides on hue, so the ladder survives colour blindness.
// A circle would have been the obvious arrangement and
// is the wrong one: a phone is tall, and two ranks at the same height put two
// names on the same line. The arrangement is not
// authored: a small force simulation (parent springs, sibling repulsion,
// centre gravity, collision) is run to rest BEFORE anything is shown, from a
// seed derived from the node ids - the same list therefore always produces the
// same sky. Afterwards the bodies never move again in layout terms; they only
// drift, each on its own slow sine, and the camera moves.
//
// What it deliberately does NOT do: no Math.random - a map that rearranged
// itself on every visit would be a toy, not a view. No layout work per frame:
// a frame writes transforms and nothing else. No persistence either - the
// camera is a way of looking, not a document, so it starts fitted every time.
// No library: the physics, the camera, the pinch and the rubber band are all
// here. And with prefers-reduced-motion, or while the tab is hidden, there is
// no animation frame at all - the sky simply stands still.

import { el, sel, text, icon, clear, brandMark } from "./dom.js";
import { t } from "../i18n.js";
import { childrenOf } from "../model.js";
import { prefersReducedMotion, spring, rubberBand } from "../motion.js";
import { buildScene, makeRuler, modeToggle } from "./mindmap.js";

// ----------------------------------------------------------------- constants

/** Levels drawn. Everything below is summarised into its level-3 ancestor. */
const MAX_DEPTH = 3;
/** Above this many bodies the deepest level is dropped rather than crammed. */
const CROWD = 380;

/**
 * The rank ladder. A root's radius, the strength of its light and the reach of
 * its halo are all one number - its rank - read through three ramps. Rank one
 * is roughly 2.3x the radius of rank ten and stands at nearly full accent;
 * rank ten is a dim ember. Nobody should have to read a label to see what
 * matters: the size and the light say it first.
 */
const R_ROOT_MAX = 38;
const R_ROOT_MIN = 17;
/** >1 spends more of the ladder on the top of the list, where it is read. */
const R_ROOT_CURVE = 1.35;
/** Percent of the family hue in a root's fill, brightest rank first. */
const MIX_MAX = 80;
/** Not lower: below a third the family hue stops being visible at all, and the
 *  last ranks would lose the one thing that says whose parts those are. */
const MIX_MIN = 34;
/**
 * A short list must not be spread across the whole ladder - two goals would
 * read as a planet and a speck. Below four roots the ramp is compressed.
 */
const RANK_DENOM_MIN = 3;

/** Body radius by depth; index 0 is unused, a root reads the ladder above. */
const R_BASE = [0, 11.6, 7.6, 5.2];
/** Rest length of the spring that ties a body to its parent, by child depth. */
const REST = [0, 74, 40, 24];
/** Clearance kept between two bodies, by the deeper of the two. */
const CLEAR = [18, 10, 6.5, 5];

/**
 * Ten families, ten hues out of the data palette. This module never names a
 * colour: it puts the family INDEX on the root group as a class, and app.css
 * decides what that index means - so a theme change still owns every pixel of
 * this screen, exactly as with the ladder numbers below. Read by rank, so the
 * same list always colours the same way, and it cycles if a merged vault ever
 * holds more than ten roots.
 */
const FAMILIES = 10;

/**
 * The ranked slots the roots are anchored to. Not a circle: a circle would
 * leave half a phone empty and would stack two root names on the same line
 * whenever two ranks share a height. The ten descend instead, alternating
 * around a vertical axis, widest in the middle - a lens rather than a ring.
 */
const ANCHOR_SPAN = 880;
const ANCHOR_WIDTH = 158;

/** Two float layers: one for x, one for y, both far slower than a heartbeat. */
const FLOAT_X = 0.00041;
const FLOAT_Y = 0.00029;

const FIT_PAD = 30;
/** How far the initial fit may magnify. A vault with one goal in it should
 *  show one body, not one wall. */
const FIT_MAX_K = 1.6;
const FOCUS_MAX_K = 3.2;
/** The floating header owns the top of the stage; the fit stays below it. */
const FIT_TOP = 104;
/** The floating veil owns the bottom of the stage the way the header owns the
 *  top: enough for the hint line plus the name of the last body above it. */
const FIT_BOTTOM = 68;
const KEEP_ON_SCREEN = 72;
/**
 * A name is cut on a WORD boundary or not at all. The old limit of 26 sliced
 * "Less screen time in the evening" into "Less screen time in the e…", which
 * reads as a rendering fault rather than as a shortening; at 32 almost every
 * real goal fits whole, and the ones that do not end on a whole word.
 */
const LABEL_MAX = 32;
/** Screen-space label geometry, for the collision pass. */
const LABEL_LINE = 15;
/** How far a colliding name may be pushed before it stops belonging to its
 *  body. Larger than the old 26, because a name is now also pushed clear of
 *  the discs it would otherwise sit on, and a rank-one disc is 38 units. */
const LABEL_PUSH = 48;
/** Above this many bodies the disc-avoidance pass is skipped: it is O(labels x
 *  bodies) per frame, and a sky that big has other problems. */
const AVOID_LIMIT = 160;

// ----------------------------------------------------------- the mind map fit

/**
 * The mind map is fitted to WIDTH and never to height: two columns of real
 * titles are as wide as they are, and a tall list must scroll rather than
 * shrink. The whole tree is shown when it also fits vertically at that scale;
 * otherwise the top of it is, and the rest is one pan away.
 */
const TREE_PAD = 10;
/** How far the fit may magnify. A vault with two goals should read as a mind
 *  map, not as two words filling a wall. */
const TREE_MAX_K = 1.25;
/**
 * The floor under the scale, and the reason this mode exists: below it the
 * smallest title in the tree stops being readable at arm's length, and the
 * screen would be asking for the zoom it was built to abolish. Under the floor
 * the tree is simply wider than the phone and the camera pans.
 */
const TREE_MIN_K = 0.78;

// --------------------------------------------------------------------- seed

/**
 * FNV-1a over a node id. The only source of "randomness" in this screen:
 * deterministic, so the same vault always draws the same sky.
 */
function hash32(value) {
  let h = 2166136261;
  const s = String(value);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A hash folded into 0..1. */
function unit(h) {
  return (h >>> 8) / 16777216;
}

// ---------------------------------------------------------------- the ladder

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 1 at rank one, 0 at the last rank - the single number every root-sized
 * decision on this screen is made from.
 */
function rankLight(index, siblings) {
  const denom = Math.max(RANK_DENOM_MIN, siblings - 1);
  return 1 - clamp01(index / denom);
}

/** Everything a root's rank decides: how big, how bright, how far it glows. */
function rankLook(index, siblings) {
  const light = rankLight(index, siblings);
  const mix = MIX_MIN + (MIX_MAX - MIX_MIN) * light;
  return {
    r: R_ROOT_MIN + (R_ROOT_MAX - R_ROOT_MIN) * Math.pow(light, R_ROOT_CURVE),
    mix,
    glow: 0.3 + 0.7 * light,
    // The numeral flips between the two inks the tokens already guarantee:
    // the one that is readable on accent, and the one that is readable on the
    // background. The flip is deliberately narrow - a wide blend would put a
    // mid grey on the mid ranks, which is the one thing neither ink is. Both
    // themes are covered by this single number, because both inks are defined
    // per theme.
    ink: clamp01((mix - 52) / 6) * 100,
    fam: index % FAMILIES,
  };
}

// ------------------------------------------------------------- scene building

/**
 * Walk the living tree into a flat list of bodies, parents before children.
 * Returns the bodies; every body carries the totals of its WHOLE subtree, not
 * only of the part that is drawn - that is what the summarising figure and the
 * completion arc are made of.
 */
function collect(nodes, node, depth, parent, index, siblings, maxDepth, out) {
  const kids = childrenOf(nodes, node.id);
  let body = null;
  if (depth <= maxDepth) {
    const h = hash32(node.id);
    body = {
      id: node.id,
      node,
      depth,
      parent,
      index,
      siblings,
      rank: depth === 0 ? index : 0,
      kids: [],
      total: 0,
      done: 0,
      hidden: 0,
      r: 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      ax: 0,
      ay: 0,
      // Float: amplitude and phase, both fixed by the id. Deeper bodies are
      // lighter and drift a little more, but never far enough for a connector
      // to slide out from under its body.
      amp: 0,
      pxc: 0,
      pxs: 0,
      pyc: 0,
      pys: 0,
      seed: h,
      look: null,
      g: null,
      chain: null,
    };
    if (depth === 0) {
      body.look = rankLook(index, siblings);
      body.r = body.look.r;
    } else {
      body.r = R_BASE[depth];
    }
    if (node.status === "done") body.r *= 0.72;
    const amp = depth === 0 ? 5.5 : Math.min(3, 1.6 + depth * 0.5);
    const px = unit(h) * Math.PI * 2;
    const py = unit(Math.imul(h ^ 0x9e3779b9, 2654435761) >>> 0) * Math.PI * 2;
    body.amp = amp;
    body.pxc = amp * Math.cos(px);
    body.pxs = amp * Math.sin(px);
    body.pyc = amp * Math.cos(py);
    body.pys = amp * Math.sin(py);
    if (parent) parent.kids.push(body);
    out.push(body);
  }

  let total = 0;
  let done = 0;
  kids.forEach((kid, i) => {
    const s = collect(nodes, kid, depth + 1, body || parent, i, kids.length, maxDepth, out);
    total += s.total + 1;
    done += s.done + (kid.status === "done" ? 1 : 0);
  });
  if (body) {
    body.total = total;
    body.done = done;
    if (depth === maxDepth) body.hidden = total;
  }
  return { total, done };
}

/** Build the bodies, dropping the deepest level if the tree is very large. */
function buildBodies(nodes) {
  const roots = childrenOf(nodes, null);
  const at = (maxDepth) => {
    const out = [];
    roots.forEach((root, i) => collect(nodes, root, 0, null, i, roots.length, maxDepth, out));
    return out;
  };
  let bodies = at(MAX_DEPTH);
  if (bodies.length > CROWD) bodies = at(MAX_DEPTH - 1);
  return bodies;
}

// ---------------------------------------------------------------- the physics

/**
 * The layout. Semi-implicit Euler with annealing, a fixed iteration budget and
 * no clock: the same input always walks the same path to the same rest state.
 *
 * Four forces, in this order per step:
 *   1. every body is tied to its parent by a spring of a length that belongs
 *      to its level - that is what makes a subtree read as a family;
 *   2. siblings push each other apart, so a fan opens instead of stacking;
 *   3. roots are pulled towards their ranked slot on the ellipse, everything
 *      else is pulled weakly towards the centre so the sky stays one object;
 *   4. after integrating, overlaps are resolved by moving both bodies apart -
 *      position based, because a force alone lets small bodies sink into big
 *      ones at rest.
 */
function simulate(bodies) {
  const n = bodies.length;
  if (!n) return;

  // Ranked slots: rank one highest, then one step down per rank, alternating
  // left and right of the axis. The horizontal swing is widest in the middle,
  // so the ten read as one body rather than as a column.
  const rootCount = bodies.reduce((c, b) => (b.depth === 0 ? c + 1 : c), 0);
  for (const b of bodies) {
    if (b.depth !== 0) continue;
    const i = b.rank;
    const span = rootCount > 1 ? ANCHOR_SPAN : 0;
    const side = i % 2 === 1 ? 1 : -1;
    const swing = Math.sin(((i + 0.5) / Math.max(1, rootCount)) * Math.PI);
    // A goal with many parts needs more room sideways, never more height:
    // the even vertical spacing is what gives every name its own line.
    const grow = 1 + Math.min(0.45, b.total * 0.018);
    b.ax = side * (0.16 + 0.84 * swing) * ANCHOR_WIDTH * grow;
    b.ay = (i / Math.max(1, rootCount - 1) - 0.5) * span;
  }

  // Seeded start: roots on their slot, children fanned outwards from the
  // parent, plus a hash-sized nudge so mirror-symmetric cases break.
  for (const b of bodies) {
    const jx = (unit(b.seed) - 0.5) * 7;
    const jy = (unit(b.seed >>> 3) - 0.5) * 7;
    if (!b.parent) {
      b.x = b.ax + jx;
      b.y = b.ay + jy;
      continue;
    }
    const p = b.parent;
    const outward = p.depth === 0 ? Math.atan2(p.y, p.x) : Math.atan2(p.y - p.parent.y, p.x - p.parent.x);
    const span = Math.min(Math.PI * 1.35, 0.6 + b.siblings * 0.34);
    const step = b.siblings > 1 ? span / (b.siblings - 1) : 0;
    const a = outward - span / 2 + b.index * step;
    const len = REST[b.depth];
    b.x = p.x + Math.cos(a) * len + jx;
    b.y = p.y + Math.sin(a) * len + jy;
  }

  const iterations = n <= 60 ? 300 : n <= 170 ? 210 : 130;
  const damping = 0.82;

  for (let step = 0; step < iterations; step += 1) {
    const cool = 0.25 + 0.75 * (1 - step / iterations);

    // 1 - parent springs. The parent yields less than the child, or a heavy
    // subtree would drag its goal off its ranked slot.
    for (const b of bodies) {
      const p = b.parent;
      if (!p) continue;
      let dx = b.x - p.x;
      let dy = b.y - p.y;
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d < 0.001) {
        dx = 0.01;
        dy = 0.01;
        d = 0.014;
      }
      const f = (d - REST[b.depth]) * 0.16;
      const ux = dx / d;
      const uy = dy / d;
      b.vx -= ux * f;
      b.vy -= uy * f;
      p.vx += ux * f * 0.3;
      p.vy += uy * f * 0.3;
    }

    // 2 - siblings repel, inverse square, capped so a big family cannot
    // explode on the first step.
    for (const p of bodies) {
      const kids = p.kids;
      for (let i = 0; i < kids.length; i += 1) {
        for (let j = i + 1; j < kids.length; j += 1) {
          const a = kids[i];
          const c = kids[j];
          const dx = a.x - c.x;
          const dy = a.y - c.y;
          const d2 = dx * dx + dy * dy || 0.01;
          const want = REST[a.depth] * 0.9;
          if (d2 > want * want * 4) continue;
          const f = Math.min(2.2, (want * want * 0.35) / d2);
          const d = Math.sqrt(d2);
          a.vx += (dx / d) * f;
          a.vy += (dy / d) * f;
          c.vx -= (dx / d) * f;
          c.vy -= (dy / d) * f;
        }
      }
    }

    // 3 - roots to their slot, everything else weakly to the middle.
    for (const b of bodies) {
      if (b.depth === 0) {
        b.vx += (b.ax - b.x) * 0.055;
        b.vy += (b.ay - b.y) * 0.055;
      } else {
        // Anisotropic on purpose: the sky is pulled together sideways more
        // than vertically, which is what keeps it phone-shaped.
        b.vx += -b.x * 0.0028;
        b.vy += -b.y * 0.0005;
      }
    }

    // integrate
    for (const b of bodies) {
      b.vx *= damping;
      b.vy *= damping;
      const v = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      const cap = 26;
      if (v > cap) {
        b.vx = (b.vx / v) * cap;
        b.vy = (b.vy / v) * cap;
      }
      b.x += b.vx * cool;
      b.y += b.vy * cool;
    }

    // 4 - collisions. O(n^2) with an early square-distance reject; at the
    // sizes this screen is built for that is far cheaper than a grid.
    for (let i = 0; i < n; i += 1) {
      const a = bodies[i];
      for (let j = i + 1; j < n; j += 1) {
        const c = bodies[j];
        const want = a.r + c.r + CLEAR[Math.max(a.depth, c.depth)];
        let dx = c.x - a.x;
        let dy = c.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= want * want) continue;
        let d = Math.sqrt(d2);
        if (d < 0.001) {
          // Perfectly coincident: push along a direction the ids decide on.
          const a0 = unit(a.seed ^ c.seed) * Math.PI * 2;
          dx = Math.cos(a0);
          dy = Math.sin(a0);
          d = 1;
        }
        const push = ((want - d) / d) * 0.5;
        // A root gives way less than a leaf: the ranked ring is the skeleton.
        const wa = a.depth === 0 ? 0.3 : 1;
        const wc = c.depth === 0 ? 0.3 : 1;
        const sum = wa + wc;
        a.x -= dx * push * ((wa / sum) * 2);
        a.y -= dy * push * ((wa / sum) * 2);
        c.x += dx * push * ((wc / sum) * 2);
        c.y += dy * push * ((wc / sum) * 2);
      }
    }
  }
}

/** The box the finished layout occupies, bodies and their float included. */
function boundsOf(list) {
  if (!list.length) return { minX: -60, minY: -60, maxX: 60, maxY: 60 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of list) {
    const pad = b.r + b.amp + (b.depth === 0 ? 26 : 6);
    if (b.x - pad < minX) minX = b.x - pad;
    if (b.y - pad < minY) minY = b.y - pad;
    if (b.x + pad > maxX) maxX = b.x + pad;
    if (b.y + pad > maxY) maxY = b.y + pad;
  }
  return { minX, minY, maxX, maxY };
}

/** A body and every drawn body below it. */
function branchOf(body) {
  const out = [];
  const stack = [body];
  while (stack.length) {
    const b = stack.pop();
    out.push(b);
    for (const k of b.kids) stack.push(k);
  }
  return out;
}

// ------------------------------------------------------------------- drawing

const ARC_GAP = 4.6;

/**
 * Title shortened for a label - on a word boundary, never in the middle of one.
 * User text, so it travels as a text node and nothing else.
 */
function shortTitle(node) {
  const raw = (node.title || "").trim();
  if (!raw) return t("editor.newTitle");
  if (raw.length <= LABEL_MAX) return raw;
  const at = raw.lastIndexOf(" ", LABEL_MAX - 1);
  // A single word longer than the whole budget has no boundary to cut on; that
  // one is sliced, because the alternative is a name wider than the phone.
  return `${raw.slice(0, at > 10 ? at : LABEL_MAX - 1).trimEnd()}…`;
}

/** One body: its connectors, its halo, its completion arc, its disc. */
function drawBody(body) {
  const cls = ["map-body", `is-d${body.depth}`];
  if (body.node.status === "done") cls.push("is-done");
  if (body.depth === 0 && body.rank === 0) cls.push("is-lead");
  const g = sel("g", { class: cls.join(" "), attrs: { "data-node": body.id } });
  // The reveal cascades from the ten outwards; the step is a fraction of a
  // token duration, so reduced motion collapses it to nothing along with it.
  g.style.setProperty("--i", String(body.depth));
  // The rank ladder enters the stylesheet as five plain numbers on the root
  // group: no colour is ever written here. What they mean - which mix of
  // accent, which turn of the hue - is decided in app.css, where the skins
  // are, and the whole family inherits it from the root.
  if (body.look) {
    const look = body.look;
    g.style.setProperty("--rm", `${look.mix.toFixed(1)}%`);
    g.style.setProperty("--glow", look.glow.toFixed(3));
    g.style.setProperty("--ink", `${look.ink.toFixed(1)}%`);
    // The family, as an index. Which hue that is stands in app.css.
    g.classList.add(`is-fam${look.fam}`);
  }
  body.g = g;

  // Connectors live in the parent, so the whole family drifts together and a
  // line never has to be rewritten while the sky breathes.
  for (const kid of body.kids) {
    g.appendChild(
      sel("line", {
        class: "map-link",
        attrs: {
          x1: 0,
          y1: 0,
          x2: (kid.x - body.x).toFixed(2),
          y2: (kid.y - body.y).toFixed(2),
        },
      }),
    );
  }

  if (body.depth === 0) {
    // A fragment id, not a colour: which gradient, decided by the family index;
    // what colour that gradient is made of, decided in tokens.css.
    const halo = sel("circle", { class: "map-halo", attrs: { r: (body.r * 2.9).toFixed(1) } });
    halo.setAttribute("fill", `url(#tf-halo-${body.look ? body.look.fam : 0})`);
    g.appendChild(halo);
  }

  if (body.total > 0) {
    const r = body.r + ARC_GAP;
    const c = 2 * Math.PI * r;
    g.appendChild(sel("circle", { class: "map-arcbase", attrs: { r: r.toFixed(2) } }));
    const ratio = body.done / body.total;
    if (ratio > 0) {
      g.appendChild(
        sel("circle", {
          class: "map-arc",
          attrs: {
            r: r.toFixed(2),
            "stroke-dasharray": `${(c * ratio).toFixed(2)} ${c.toFixed(2)}`,
            transform: "rotate(-90)",
          },
        }),
      );
    }
  }

  g.appendChild(sel("circle", { class: "map-disc", attrs: { r: body.r.toFixed(2) } }));

  // The rank, inside the body it belongs to. It is information, not ornament,
  // so it is always there - but it is set quietly, and a low rank carries it
  // small enough that it only becomes readable once the camera comes closer.
  // A number, not a string: nothing here has to be translated.
  if (body.depth === 0) {
    const figure = String(body.rank + 1);
    // 8.4 was below the floor at which a figure inside a dim body can be read
    // at all; the last three ranks were decoration.
    const size = Math.max(10.4, body.r * (figure.length > 1 ? 0.42 : 0.52));
    g.appendChild(
      sel("text", {
        class: "map-rank",
        text: figure,
        attrs: { x: 0, y: 0, "font-size": size.toFixed(1) },
      }),
    );
  }

  if (body.hidden > 0) {
    g.appendChild(
      sel("text", {
        class: "map-more",
        text: t("map.more", { n: body.hidden }),
        attrs: { x: (body.r + 5).toFixed(1), y: (body.r + 7).toFixed(1) },
      }),
    );
  }

  // The tap target. Small bodies get a generous one; the deepest still need a
  // zoom, which is exactly the movement this screen is built around.
  g.appendChild(
    sel("circle", {
      class: "map-hit",
      attrs: { r: Math.max(body.r * 1.5, 13).toFixed(1), "data-hit": body.id },
    }),
  );

  for (const kid of body.kids) {
    const kg = drawBody(kid);
    kg.setAttribute("transform", `translate(${(kid.x - body.x).toFixed(2)},${(kid.y - body.y).toFixed(2)})`);
    g.appendChild(kg);
  }
  return g;
}

// ------------------------------------------------------------------ the screen

export function render(ctx) {
  const nodes = ctx.doc.nodes;
  const roots = childrenOf(nodes, null);
  // Which reading of the tree. Unknown values fall back to the sky, so a
  // document written by a newer version can never leave this screen blank.
  const settings = ctx.doc.settings || {};
  const mode = settings.mapMode === "tree" ? "tree" : "sky";
  const sky = mode === "sky";

  const bodies = sky ? buildBodies(nodes) : [];
  if (sky) simulate(bodies);

  const byId = new Map(bodies.map((b) => [b.id, b]));
  for (const b of bodies) {
    const chain = [];
    let cur = b;
    while (cur) {
      chain.push(cur);
      cur = cur.parent;
    }
    b.chain = chain;
  }

  const reduced = prefersReducedMotion();
  // The mind map is measured against the live SVG, so its bounds only exist
  // once the screen has been laid out; until then this is a placeholder the
  // camera is never asked to fit.
  let bounds = sky ? boundsOf(bodies) : { minX: -60, minY: -60, maxX: 60, maxY: 60 };

  // ------------------------------------------------------------- the canvas

  // One halo gradient per family. A gradient resolves its custom properties
  // where it is DEFINED, so a single shared one could only ever carry a single
  // colour; ten of them is the price of ten families. Nothing here is a colour
  // literal - every stop reads a token, and how far the light reaches is a
  // token too, because on paper a halo becomes a smudge.
  const halos = [];
  for (let i = 0; i < FAMILIES; i += 1) {
    const hue = `var(--data-${i + 1})`;
    halos.push(
      sel("radialGradient", { attrs: { id: `tf-halo-${i}` } }, [
        sel("stop", { attrs: { offset: "0%", "stop-color": hue, "stop-opacity": "var(--map-halo-in)" } }),
        sel("stop", { attrs: { offset: "55%", "stop-color": hue, "stop-opacity": "var(--map-halo-mid)" } }),
        sel("stop", { attrs: { offset: "100%", "stop-color": hue, "stop-opacity": "0" } }),
      ]),
    );
  }
  const defs = sel("defs", {}, [
    ...halos,
    sel("radialGradient", { attrs: { id: "tf-core" } }, [
      // Faint on purpose: in the light theme anything stronger stops reading as
      // a light behind the sky and starts reading as a mark on the paper.
      sel("stop", { attrs: { offset: "0%", "stop-color": "var(--accent)", "stop-opacity": "var(--map-core)" } }),
      sel("stop", { attrs: { offset: "100%", "stop-color": "var(--accent)", "stop-opacity": "0" } }),
    ]),
  ]);

  const tree = sel("g", { class: "map-tree" });
  for (const b of bodies) {
    if (b.parent) continue;
    const g = drawBody(b);
    g.setAttribute("transform", `translate(${b.x.toFixed(2)},${b.y.toFixed(2)})`);
    tree.appendChild(g);
  }

  const core = sel("circle", { class: "map-core", attrs: { r: "150" } });
  core.setAttribute("fill", "url(#tf-core)");

  // The mind map hangs in the same scene, under the same core glow: the light
  // behind the list is the one thing both readings share.
  const scene = sel("g", { class: "map-scene" }, [core, tree]);
  const labels = sel("g", { class: "map-labels" });

  const svg = sel("svg", {
    class: "map-canvas",
    attrs: {
      viewBox: "0 0 390 760",
      preserveAspectRatio: "none",
      // The sky is a picture with a description; the mind map is a set of rows
      // that can be reached, so it must not be collapsed into one image.
      role: sky ? "img" : "group",
      "aria-label": t(sky ? "map.canvas" : "map.canvasTree"),
    },
  }, [defs, scene, labels]);

  // ------------------------------------------------------------- the camera

  const size = { w: 390, h: 760 };
  const cam = { x: 0, y: 0, k: 1 };
  let base = { x: 0, y: 0, k: 1 };
  let focusId = null;
  let ready = false;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /**
   * Fit a box into the part of the stage that is actually free: the header
   * floats over the top of the canvas, so the sky is centred below it rather
   * than in the geometric middle.
   */
  function fit(box, capK) {
    const bw = Math.max(1, box.maxX - box.minX);
    const bh = Math.max(1, box.maxY - box.minY);
    const pad = Math.min(FIT_PAD, size.w * 0.09);
    const top = Math.min(FIT_TOP, size.h * 0.18);
    const availW = size.w - pad * 2;
    const availH = size.h - top - FIT_BOTTOM;
    const k = Math.min(availW / bw, availH / bh, capK || Infinity);
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    return { k, x: size.w / 2 - cx * k, y: top + availH / 2 - cy * k };
  }

  /**
   * The mind map's fit: width only, floored at the scale below which the type
   * stops being readable, and top-aligned when the tree is taller than the
   * stage - a list is read from rank one downwards, not from its middle.
   */
  function fitTree(box) {
    const bw = Math.max(1, box.maxX - box.minX);
    const bh = Math.max(1, box.maxY - box.minY);
    const pad = Math.min(TREE_PAD, size.w * 0.04);
    const top = Math.min(FIT_TOP, size.h * 0.18);
    const availW = size.w - pad * 2;
    const availH = size.h - top - FIT_BOTTOM;
    const k = Math.max(TREE_MIN_K, Math.min(availW / bw, TREE_MAX_K));
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    const y = bh * k <= availH ? top + availH / 2 - cy * k : top - box.minY * k;
    return { k, x: size.w / 2 - cx * k, y };
  }

  const fitFor = (box) => (sky ? fit(box, FIT_MAX_K) : fitTree(box));

  /** Keep at least a strip of the sky on screen; past that, resistance. */
  function limitPan(c, elastic) {
    const axis = (v, lo, hi) => {
      if (lo > hi) return (lo + hi) / 2;
      if (v < lo) return elastic ? lo - rubberBand(lo - v, 110) : lo;
      if (v > hi) return elastic ? hi + rubberBand(v - hi, 110) : hi;
      return v;
    };
    const keep = Math.min(KEEP_ON_SCREEN, size.w * 0.3);
    c.x = axis(c.x, keep - bounds.maxX * c.k, size.w - keep - bounds.minX * c.k);
    c.y = axis(c.y, keep - bounds.maxY * c.k, size.h - keep - bounds.minY * c.k);
    return c;
  }

  const kMin = () => base.k * 0.62;
  const kMax = () => base.k * 7;

  let cancelCam = null;

  function stopCam() {
    if (cancelCam) cancelCam();
    cancelCam = null;
  }

  /** One spring drives one parameter; the camera is lerped along it, so the
   *  zoom and the pan can never come apart mid-flight. */
  function glideTo(target) {
    stopCam();
    const from = { x: cam.x, y: cam.y, k: cam.k };
    cancelCam = spring({
      from: 0,
      to: 1,
      stiffness: 148,
      damping: 25,
      restDistance: 0.0015,
      restVelocity: 0.006,
      onUpdate: (p) => {
        cam.x = from.x + (target.x - from.x) * p;
        cam.y = from.y + (target.y - from.y) * p;
        cam.k = from.k + (target.k - from.k) * p;
        draw();
      },
      onDone: () => {
        cancelCam = null;
      },
    });
  }

  // -------------------------------------------------------------- the labels

  /**
   * The labelling rule, and it is the whole rule:
   *   - a root always carries its title;
   *   - a focused body and its direct parts carry theirs while it is focused;
   *   - nothing else, ever.
   * Labels that do not apply are REMOVED, not faded - an invisible label is
   * still an element the browser has to lay out and hit-test.
   */
  function labelSet() {
    const set = new Map();
    for (const b of bodies) if (b.depth === 0) set.set(b.id, b);
    const f = focusId ? byId.get(focusId) : null;
    if (f) {
      set.set(f.id, f);
      for (const k of f.kids) set.set(k.id, k);
    }
    return [...set.values()];
  }

  let labelled = [];

  function buildLabels() {
    // The mind map carries its titles inside the scene, where they belong to
    // their rows; the screen-space label layer is the sky's answer to a picture
    // that must stay legible at any zoom, and it stays out of this mode.
    if (!sky) return;
    clear(labels);
    labelled = labelSet();
    const f = focusId ? byId.get(focusId) : null;
    for (const b of labelled) {
      const dim = f && !f.chain.includes(b.chain[b.chain.length - 1]);
      const g = sel("g", {
        class: `map-label is-d${b.depth}${b.node.status === "done" ? " is-done" : ""}${dim ? " is-dim" : ""}`,
        attrs: {
          "data-label": b.id,
          role: "button",
          tabindex: "0",
          "aria-label": t("a11y.openNode", { title: b.node.title || shortTitle(b.node) }),
        },
      });
      const hit = sel("rect", { class: "map-labelhit", attrs: { x: -40, y: -11, width: 80, height: 22 } });
      const label = sel("text", { class: "map-labeltext", text: shortTitle(b.node) });
      g.appendChild(hit);
      g.appendChild(label);
      labels.appendChild(g);
      b.label = g;
      b.labelHit = hit;
      b.labelText = label;
    }
    // One measuring pass per label change - never per frame.
    for (const b of labelled) {
      let w = 80;
      try {
        w = b.labelText.getComputedTextLength() || 80;
      } catch {
        // Not laid out yet; the default box is close enough to tap.
      }
      b.labelWidth = w;
      b.sx = 0;
      b.sy = 0;
      b.labelHit.setAttribute("x", (-w / 2 - 10).toFixed(1));
      b.labelHit.setAttribute("width", (w + 20).toFixed(1));
    }
    // Place them once right away: a label must never appear at the origin for
    // the one frame before the camera spring delivers its first update.
    if (ready) draw();
  }

  // ---------------------------------------------------------------- the loop

  const probe = navigator.webdriver ? { frames: 0, loop: false } : null;
  if (probe) window.__tfMap = probe;

  let raf = 0;
  let clock = 0;
  // A mind map holds still. Not "moves less" - there is no animation frame at
  // all in this mode, exactly as with reduced motion, because a structural
  // reading whose rows drift is a structural reading nobody can follow.
  const floats = !reduced && sky;

  function alive() {
    return svg.isConnected;
  }

  function draw() {
    // A camera spring that was in flight when the screen was left would
    // otherwise keep writing attributes into a detached tree.
    if (!alive()) {
      stopCam();
      return;
    }
    scene.setAttribute("transform", `translate(${cam.x.toFixed(2)},${cam.y.toFixed(2)}) scale(${cam.k.toFixed(4)})`);
    // The mind map is drawn once and moved by the camera alone: no drift to
    // accumulate, no labels in screen space to place.
    if (!sky) return;

    // Four trigonometric calls for the whole sky: every body's drift is
    // sin(wt + phase) expanded once, so a frame costs two multiplies a body.
    let sx = 0;
    let cx = 1;
    let sy = 0;
    let cy = 1;
    if (floats) {
      const a = clock * FLOAT_X;
      const b = clock * FLOAT_Y;
      sx = Math.sin(a);
      cx = Math.cos(a);
      sy = Math.sin(b);
      cy = Math.cos(b);
    }

    for (const b of bodies) {
      const dx = b.pxc * sx + b.pxs * cx;
      const dy = b.pyc * sy + b.pys * cy;
      const ox = b.parent ? b.x - b.parent.x : b.x;
      const oy = b.parent ? b.y - b.parent.y : b.y;
      b.g.setAttribute("transform", `translate(${(ox + dx).toFixed(2)},${(oy + dy).toFixed(2)})`);
      b.dx = dx;
      b.dy = dy;
      // The drift a body actually shows is its own plus every one above it -
      // accumulated here, once, because `bodies` holds parents before children.
      // Everything that needs a body's true scene position (the labels) reads
      // this instead of walking the chain again.
      b.driftX = (b.parent ? b.parent.driftX : 0) + dx;
      b.driftY = (b.parent ? b.parent.driftY : 0) + dy;
    }

    placeLabels();
  }

  /**
   * Labels live in screen space, so two bodies that sit far apart in the sky
   * can still have their names on top of each other once the camera is zoomed
   * out. One greedy pass in a fixed order - roots by rank first - nudges a
   * colliding name downwards, never further than one line and a half, so it
   * still belongs to its body. Cheap enough to run every frame: the order
   * never changes, so the result cannot flicker between two solutions.
   */
  function placeLabels() {
    const n = labelled.length;
    const avoidDiscs = bodies.length <= AVOID_LIMIT;
    for (let i = 0; i < n; i += 1) {
      const b = labelled[i];
      const ax = b.x + (b.driftX || 0);
      const ay = b.y + (b.driftY || 0);
      const lift = b.r + (b.depth === 0 ? 17 : 12);
      const half = b.labelWidth / 2 + 4;
      // Clamp horizontally so a name near the edge slides inward instead of
      // being cut off by the viewport.
      let sx = cam.x + ax * cam.k;
      const margin = 8;
      if (sx - half < margin) sx = margin + half;
      else if (sx + half > size.w - margin) sx = size.w - margin - half;
      // Walk a name away from everything it would sit on, in one direction.
      // A name over another name is untidy; a name over a BODY is the thing
      // that made this screen look broken, because a lit disc forces a dark
      // box behind the letters. Only ever one way, so a pass cannot oscillate;
      // its own body is skipped, since the name already hangs clear of that
      // one. Returns how far it had to go - the caller decides whether that
      // was too far to still belong to its body.
      const walk = (from, dir) => {
        let y = from;
        for (let pass = 0; pass < 8; pass += 1) {
          let hit = false;
          for (let j = 0; j < i; j += 1) {
            const o = labelled[j];
            if (Math.abs(y - o.sy) >= LABEL_LINE) continue;
            if (Math.abs(sx - o.sx) >= half + o.labelWidth / 2 + 4) continue;
            y = o.sy + dir * LABEL_LINE;
            hit = true;
            break;
          }
          if (!hit && avoidDiscs) {
            for (const c of bodies) {
              // Its own body is NOT skipped. Both starting points already clear
              // it, but a walk that got deflected by something else could end
              // up back across it - which is exactly how a name landed on the
              // very disc it belongs to.
              const cr = c.r * cam.k + 3;
              const cxs = cam.x + (c.x + (c.driftX || 0)) * cam.k;
              if (Math.abs(cxs - sx) > half + cr) continue;
              const cys = cam.y + (c.y + (c.driftY || 0)) * cam.k;
              if (Math.abs(cys - y) > LABEL_LINE / 2 + cr) continue;
              y = cys + dir * (cr + LABEL_LINE / 2);
              hit = true;
              break;
            }
          }
          if (!hit) return { y, clear: true };
        }
        return { y, clear: false };
      };

      const wanted = cam.y + (ay + lift) * cam.k;
      const down = walk(wanted, 1);
      let sy = down.y;
      // Below is the natural place. If getting clear below would drag the name
      // further than it can go and still read as this body's name, try above -
      // and only if that fails too, settle for the budget. Without this second
      // try the old code simply clamped the result back down onto the very
      // disc the walk had just escaped.
      if (!down.clear || down.y - wanted > LABEL_PUSH) {
        const wantedUp = cam.y + (ay - lift) * cam.k;
        const up = walk(wantedUp, -1);
        if (up.clear && wantedUp - up.y <= LABEL_PUSH) sy = up.y;
        // Neither way out: back to its own place under its own body. That is
        // the one position guaranteed to be clear of the body it names, and
        // the stroke behind the letters is there for exactly this case.
        else sy = wanted;
      }
      b.sx = sx;
      b.sy = sy;
      b.label.setAttribute("transform", `translate(${sx.toFixed(1)},${sy.toFixed(1)})`);
    }
  }

  function running() {
    return floats && alive() && document.visibilityState !== "hidden";
  }

  function frame(now) {
    raf = 0;
    if (!running()) {
      if (probe) probe.loop = false;
      // The screen is gone: take the one listener that outlives the DOM with
      // it, so a session of many map visits does not accumulate handlers.
      if (!alive()) document.removeEventListener("visibilitychange", onVisibility);
      return;
    }
    clock = now;
    if (probe) probe.frames += 1;
    draw();
    raf = requestAnimationFrame(frame);
  }

  function startLoop() {
    if (raf || !running()) return;
    if (probe) probe.loop = true;
    raf = requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (probe) probe.loop = false;
  }

  const onVisibility = () => {
    if (!alive()) {
      document.removeEventListener("visibilitychange", onVisibility);
      stopLoop();
      stopCam();
      return;
    }
    if (document.visibilityState === "hidden") stopLoop();
    else startLoop();
  };
  document.addEventListener("visibilitychange", onVisibility);

  // --------------------------------------------------------------- the start

  function measure() {
    const box = svg.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return false;
    size.w = box.width;
    size.h = box.height;
    svg.setAttribute("viewBox", `0 0 ${size.w.toFixed(1)} ${size.h.toFixed(1)}`);
    return true;
  }

  function recentre(animated = true) {
    focusId = null;
    markFocus();
    buildLabels();
    const target = limitPan(fitFor(bounds), false);
    if (animated && ready) glideTo(target);
    else {
      stopCam();
      cam.x = target.x;
      cam.y = target.y;
      cam.k = target.k;
      draw();
    }
  }

  /** The other nine step back; the branch being looked at keeps its light. */
  function markFocus() {
    const f = focusId ? byId.get(focusId) : null;
    tree.setAttribute("class", f ? "map-tree has-focus" : "map-tree");
    for (const b of bodies) {
      b.g.classList.toggle("is-focus", !!f && b.id === f.id);
      // Dimming happens per root, so one class per root carries the whole
      // branch - a subtree never has to be walked to keep its light.
      if (b.depth === 0) b.g.classList.toggle("is-path", !!f && f.chain.includes(b));
    }
  }

  function focusOn(body) {
    focusId = body.id;
    markFocus();
    buildLabels();
    const box = boundsOf(branchOf(body));
    const grown = {
      minX: box.minX - 30,
      minY: box.minY - 30,
      maxX: box.maxX + 30,
      maxY: box.maxY + 46,
    };
    const target = fit(grown, FOCUS_MAX_K);
    // A goal with nothing under it has a box the size of one disc, and the fit
    // would then magnify that one disc until it filled the screen and left the
    // rest of the sky out of sight. Coming closer to a bare goal means coming
    // closer, not landing on it.
    const bare = body.kids.length === 0;
    target.k = clamp(target.k, kMin(), Math.min(kMax(), base.k * (bare ? 1.5 : 4.2)));
    // Focusing means coming CLOSER. The bare-goal cap above was written for
    // childless ROOTS, but a leaf part deep in a family is also "bare" - and
    // capping it at 1.5x the overview zoomed the camera OUT from where the
    // user already was (owner report: "Klick auf Unterpunkt zoomt heraus").
    // Never end a focus below the current zoom.
    target.k = Math.max(target.k, cam.k);
    // Refit the translation to the clamped scale so the branch stays centred -
    // centred in the part of the stage the floating header leaves free, the
    // same rule fit() follows, or a focused branch sits under the title.
    const cxn = (grown.minX + grown.maxX) / 2;
    const cyn = (grown.minY + grown.maxY) / 2;
    const top = Math.min(FIT_TOP, size.h * 0.18);
    target.x = size.w / 2 - cxn * target.k;
    target.y = top + (size.h - top - FIT_BOTTOM) / 2 - cyn * target.k;
    glideTo(limitPan(target, false));
  }

  /**
   * The mind map cannot be laid out before the screen exists: its columns are
   * made of measured text, and getComputedTextLength only answers once the SVG
   * is in the document with the skin's fonts applied. So it is built here,
   * once, in the same frame that first knows how big the stage is.
   */
  let mindTree = null;
  function buildMind() {
    if (sky || mindTree) return;
    const ruler = makeRuler(svg);
    const built = buildScene(nodes, ruler.measure);
    ruler.dispose();
    mindTree = built.g;
    bounds = built.bounds;
    for (const item of built.items) byId.set(item.id, item);
    scene.appendChild(mindTree);
  }

  requestAnimationFrame(function start() {
    if (!alive()) return;
    if (!measure()) {
      requestAnimationFrame(start);
      return;
    }
    buildMind();
    base = fitFor(bounds);
    cam.x = base.x;
    cam.y = base.y;
    cam.k = base.k;
    buildLabels();
    draw();
    ready = true;
    scene.classList.add("is-ready");
    labels.classList.add("is-ready");
    if (mindTree) mindTree.classList.add("is-ready");
    startLoop();
  });

  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => {
      if (!alive()) {
        ro.disconnect();
        return;
      }
      if (!measure()) return;
      base = fitFor(bounds);
      const f = sky && focusId ? byId.get(focusId) : null;
      if (f) focusOn(f);
      else recentre(false);
    });
    ro.observe(svg);
  }

  // ------------------------------------------------------------- the gestures

  const pointers = new Map();
  let gesture = null;

  function scenePoint(ev) {
    const box = svg.getBoundingClientRect();
    return { x: ev.clientX - box.left, y: ev.clientY - box.top };
  }

  function zoomAt(px, py, factor, elastic) {
    stopCam();
    const next = clamp(cam.k * factor, kMin() * (elastic ? 0.7 : 1), kMax() * (elastic ? 1.35 : 1));
    const ratio = next / cam.k;
    cam.x = px - (px - cam.x) * ratio;
    cam.y = py - (py - cam.y) * ratio;
    cam.k = next;
    limitPan(cam, elastic);
    draw();
  }

  function settle() {
    const target = { x: cam.x, y: cam.y, k: clamp(cam.k, kMin(), kMax()) };
    if (target.k !== cam.k) {
      const ratio = target.k / cam.k;
      target.x = size.w / 2 - (size.w / 2 - cam.x) * ratio;
      target.y = size.h / 2 - (size.h / 2 - cam.y) * ratio;
    }
    limitPan(target, false);
    if (Math.abs(target.x - cam.x) > 0.5 || Math.abs(target.y - cam.y) > 0.5 || target.k !== cam.k) {
      glideTo(target);
    }
  }

  svg.addEventListener(
    "pointerdown",
    (ev) => {
      if (!ready) return;
      // Whoever touched the sky has read the line under it.
      dismissHint();
      svg.setPointerCapture(ev.pointerId);
      const p = scenePoint(ev);
      pointers.set(ev.pointerId, p);
      if (pointers.size === 1) {
        stopCam();
        gesture = {
          kind: "pan",
          id: ev.pointerId,
          start: p,
          cam: { x: cam.x, y: cam.y, k: cam.k },
          target: ev.target,
          at: Date.now(),
          moved: 0,
        };
      } else if (pointers.size === 2) {
        stopCam();
        const [a, b] = [...pointers.values()];
        gesture = {
          kind: "pinch",
          d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          k0: cam.k,
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          cam: { x: cam.x, y: cam.y },
        };
      }
    },
    { passive: true },
  );

  svg.addEventListener(
    "pointermove",
    (ev) => {
      if (!pointers.has(ev.pointerId) || !gesture) return;
      const p = scenePoint(ev);
      pointers.set(ev.pointerId, p);
      if (gesture.kind === "pan" && gesture.id === ev.pointerId) {
        const dx = p.x - gesture.start.x;
        const dy = p.y - gesture.start.y;
        gesture.moved = Math.max(gesture.moved, Math.hypot(dx, dy));
        cam.x = gesture.cam.x + dx;
        cam.y = gesture.cam.y + dy;
        limitPan(cam, true);
        draw();
      } else if (gesture.kind === "pinch" && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const want = clamp(gesture.k0 * (d / gesture.d0), kMin() * 0.7, kMax() * 1.35);
        const ratio = want / cam.k;
        cam.x = mid.x - (mid.x - cam.x) * ratio + (mid.x - gesture.mid.x) * 0.35;
        cam.y = mid.y - (mid.y - cam.y) * ratio + (mid.y - gesture.mid.y) * 0.35;
        cam.k = want;
        gesture.mid = mid;
        limitPan(cam, true);
        draw();
      }
    },
    { passive: true },
  );

  function endPointer(ev) {
    const g = gesture;
    pointers.delete(ev.pointerId);
    if (svg.hasPointerCapture && svg.hasPointerCapture(ev.pointerId)) {
      svg.releasePointerCapture(ev.pointerId);
    }
    if (!g) return;
    if (g.kind === "pan" && g.id === ev.pointerId) {
      gesture = null;
      const tapped = g.moved < 9 && Date.now() - g.at < 700;
      if (tapped) handleTap(g.target);
      else settle();
      return;
    }
    if (pointers.size === 0) {
      gesture = null;
      settle();
    }
  }

  svg.addEventListener("pointerup", endPointer, { passive: true });
  svg.addEventListener("pointercancel", endPointer, { passive: true });

  svg.addEventListener(
    "wheel",
    (ev) => {
      if (!ready) return;
      ev.preventDefault();
      dismissHint();
      const p = scenePoint(ev);
      const factor = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.012 : 0.0022));
      zoomAt(p.x, p.y, factor, false);
    },
    { passive: false },
  );

  /**
   * The two gestures that mean something:
   *   - a body: come closer. Tapping the body that is already close opens it.
   *   - its name: open it straight away.
   * Anything else on the canvas lets go and shows the whole sky again.
   */
  function handleTap(target) {
    const hit = target && target.closest ? target.closest("[data-hit]") : null;
    if (hit) {
      const body = byId.get(hit.getAttribute("data-hit"));
      if (!body) return;
      // In the mind map a tap is a tap: the title is already readable, so
      // there is nothing to come closer for and the two-step would only put a
      // zoom between the reader and the thing they pointed at.
      if (!sky) {
        openBody(body);
        return;
      }
      if (focusId === body.id) openBody(body);
      else focusOn(body);
      return;
    }
    const lab = target && target.closest ? target.closest("[data-label]") : null;
    if (lab) {
      const body = byId.get(lab.getAttribute("data-label"));
      if (body) openBody(body);
      return;
    }
    if (focusId) recentre();
  }

  function openBody(body) {
    stopLoop();
    stopCam();
    const current = ctx.nodeById(body.id);
    if (current) ctx.openNode(current);
  }

  labels.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const lab = ev.target && ev.target.closest ? ev.target.closest("[data-label]") : null;
    if (!lab) return;
    ev.preventDefault();
    const body = byId.get(lab.getAttribute("data-label"));
    if (body) openBody(body);
  });

  // The mind map's rows are focusable in the scene itself, so the same two keys
  // are answered there. One listener on the canvas, not one per row.
  svg.addEventListener("keydown", (ev) => {
    if (sky) return;
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const row = ev.target && ev.target.closest ? ev.target.closest("[data-node]") : null;
    if (!row) return;
    ev.preventDefault();
    const item = byId.get(row.getAttribute("data-node"));
    if (item) openBody(item);
  });

  // --------------------------------------------------------------- the chrome

  // Every living part below the ten, including the ones only summed up. Counted
  // off the document rather than off the scene: the two modes build different
  // scenes, and the line under the title is about the list, not about which
  // reading of it happens to be showing.
  const partCount = nodes.reduce(
    (sum, n) => (!n.deletedAt && n.parentId !== null ? sum + 1 : sum),
    0,
  );
  // Two independently counted things, so neither can end up as "1 goals".
  const subtitle = roots.length
    ? `${roots.length === 1 ? t("map.goalsOne") : t("map.goals", { n: roots.length })} · ${
        partCount === 1 ? t("map.partsOne") : t("map.parts", { n: partCount })
      }`
    : t("map.subEmpty");

  const head = el("div", { class: "map-veil" }, [
    el("div", { class: "head-row" }, [
      el("div", {}, [
        brandMark(),
        el("h1", { class: "h-title" }, [text(t("map.title"))]),
      ]),
      el("div", { class: "head-actions" }, [
        // Two readings of one list, so the switch belongs next to the title of
        // that list and not in settings three screens away.
        modeToggle(mode, (next) => {
          stopLoop();
          stopCam();
          ctx.setSettings({ mapMode: next });
        }),
        el(
          "button",
          {
            class: "iconbtn",
            attrs: { type: "button", "aria-label": t("map.recentre") },
            on: { click: () => recentre() },
          },
          [icon("target", 20)],
        ),
        el(
          "button",
          {
            class: "iconbtn",
            attrs: { type: "button", "aria-label": t("common.close") },
            on: {
              click: () => {
                stopLoop();
                stopCam();
                ctx.back();
              },
            },
          },
          [icon("close", 20)],
        ),
      ]),
    ]),
    el("p", { class: "h-sub" }, [text(subtitle)]),
  ]);

  // The bottom of the sky, and the one sentence that says it can be touched.
  // Without it the map was a picture: nothing on the screen told anybody that a
  // body answers a tap, and the orbs ran off the bottom edge on a hard cut.
  // The line goes at the first gesture, because by then it has been read.
  const hintKey = sky
    ? roots.length > 1
      ? "map.hint.tap"
      : roots.length
        ? "map.hint.one"
        : "map.hint.empty"
    : roots.length
      ? "map.hint.tree"
      : "map.hint.treeEmpty";
  const hint = el("p", { class: "map-hint" }, [text(t(hintKey))]);
  const foot = el("div", { class: "map-veil is-bottom" }, [hint]);
  const dismissHint = () => foot.classList.add("is-gone");

  const stage = el("div", { class: "map-stage" }, [svg, head, foot]);

  if (!roots.length && sky) {
    // Nothing yet: one hollow body in the middle, so the screen still reads as
    // a place rather than as a failure. The mind map has the centre node for
    // that - an empty vault there is the mark, its name, and nothing hanging
    // off it yet, which says the same thing without a second convention.
    const seed = sel("g", { class: "map-body is-seed" }, [
      sel("circle", { class: "map-arcbase", attrs: { r: "34" } }),
      sel("circle", { class: "map-disc", attrs: { r: "9" } }),
    ]);
    tree.appendChild(seed);
  }

  return el("section", { class: "screen is-map" }, [stage]);
}
