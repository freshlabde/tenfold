// qrread.js - reading a QR symbol back out of a still picture.
//
// What it does: takes one frame - an ImageData or a canvas - and returns the
// text of the QR code in it, or null. The whole chain is here: luminance,
// a tile-based adaptive threshold with global fallbacks, finder patterns found
// by the 1:1:3:1:1 scanline ratio in rows and in columns with a cross-check
// through both axes, the three that form a right angle, the grid geometry
// (perspective when the version has an alignment pattern to pin the fourth
// corner, affine otherwise), the module sampling, and then the symbol itself:
// format information with its BCH errors corrected, unmasking, de-interleaving
// and REAL Reed-Solomon correction - Berlekamp-Massey, Chien search, Forney -
// over the same GF(256) tables web/js/qr.js writes the parity with. A photo of
// a screen always has a few wrong modules; detecting that is not enough, they
// have to be repaired.
//
// What it deliberately does NOT do: no third-party code, no worker, no
// network, no storage, no DOM beyond reading pixels out of the canvas it was
// handed. It reads level M only - that is the level our own encoder writes,
// and inventing block tables for levels this app never produces would be
// three untested tables pretending to be a feature. Versions 1 to 10, byte
// mode, like the encoder. It never throws at the caller: every failure, from a
// blurred photo to a corrupt matrix, is a null.

import { EXP, gfMul, gfDiv, EC_TABLE, ALIGNMENT, MAX_VERSION, maskCondition } from "./qr.js";

/** Smallest and largest symbol this reader will sample, in modules. */
const MIN_DIMENSION = 21;
const MAX_DIMENSION = 17 + MAX_VERSION * 4;

/** Edge length of one threshold tile, in pixels. */
const TILE = 8;

/** Below this spread a tile holds no edge and borrows its neighbours' level. */
const FLAT_SPREAD = 24;

/** How far a run may sit from its ideal width, relative to the module size. */
const RUN_TOLERANCE = 0.6;

// ------------------------------------------------------------------- pixels

/**
 * Whatever came in, as ImageData. A canvas is read once; an ImageData is used
 * as it is. Anything else is not a picture and the caller gets null.
 */
function toImageData(source) {
  if (!source) return null;
  if (source.data && typeof source.width === "number" && typeof source.height === "number") {
    return source;
  }
  if (typeof source.getContext === "function") {
    const g = source.getContext("2d", { willReadFrequently: true });
    if (!g) return null;
    const w = source.width;
    const h = source.height;
    if (!w || !h) return null;
    return g.getImageData(0, 0, w, h);
  }
  return null;
}

/**
 * Luminance, alpha composited over white. Transparent corners of a canvas are
 * paper, not black - reading them as black would invent a quiet zone that is
 * the wrong colour.
 */
function luminance(image) {
  const { data, width, height } = image;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < out.length; i += 4, p += 1) {
    const a = data[i + 3];
    const grey = (data[i] * 77 + data[i + 1] * 151 + data[i + 2] * 28) >> 8;
    out[p] = a === 255 ? grey : Math.round((grey * a + 255 * (255 - a)) / 255);
  }
  return out;
}

/** Otsu's threshold: the split that separates the histogram best. */
function otsu(grey) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < grey.length; i += 1) hist[grey[i]] += 1;
  const total = grey.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * hist[i];
  let sumB = 0;
  let weightB = 0;
  let best = 0;
  let bestVariance = -1;
  for (let i = 0; i < 256; i += 1) {
    weightB += hist[i];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;
    sumB += i * hist[i];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
    if (variance > bestVariance) {
      bestVariance = variance;
      best = i;
    }
  }
  return best;
}

/** Every pixel darker than one fixed level. The honest simple case. */
function globalBits(grey, level) {
  const bits = new Uint8Array(grey.length);
  for (let i = 0; i < grey.length; i += 1) bits[i] = grey[i] < level ? 1 : 0;
  return bits;
}

/**
 * The tile-based threshold. Each 8x8 tile gets its own level from its own
 * min and max; a tile with no contrast in it (all paper, or all inside one
 * fat module) has no level of its own and takes the average of the levels
 * around it, which is what keeps a shadow across half the picture from
 * turning into a black block.
 */
function adaptiveBits(grey, width, height) {
  const cols = Math.max(1, Math.ceil(width / TILE));
  const rows = Math.max(1, Math.ceil(height / TILE));
  const level = new Float32Array(cols * rows);
  const known = new Uint8Array(cols * rows);

  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < cols; tx += 1) {
      let min = 255;
      let max = 0;
      const y1 = Math.min(height, (ty + 1) * TILE);
      const x1 = Math.min(width, (tx + 1) * TILE);
      for (let y = ty * TILE; y < y1; y += 1) {
        for (let x = tx * TILE; x < x1; x += 1) {
          const v = grey[y * width + x];
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (max - min >= FLAT_SPREAD) {
        level[ty * cols + tx] = (min + max) / 2;
        known[ty * cols + tx] = 1;
      }
    }
  }

  // Tiles without an edge of their own borrow from the 5x5 around them; if
  // there is nothing to borrow anywhere, the global split stands in.
  const fallback = otsu(grey);
  const smooth = new Float32Array(cols * rows);
  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < cols; tx += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -2; dy <= 2; dy += 1) {
        const y = ty + dy;
        if (y < 0 || y >= rows) continue;
        for (let dx = -2; dx <= 2; dx += 1) {
          const x = tx + dx;
          if (x < 0 || x >= cols) continue;
          if (!known[y * cols + x]) continue;
          sum += level[y * cols + x];
          count += 1;
        }
      }
      smooth[ty * cols + tx] = count ? sum / count : fallback;
    }
  }

  const bits = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const ty = Math.min(rows - 1, (y / TILE) | 0);
    for (let x = 0; x < width; x += 1) {
      const tx = Math.min(cols - 1, (x / TILE) | 0);
      bits[y * width + x] = grey[y * width + x] < smooth[ty * cols + tx] ? 1 : 0;
    }
  }
  return bits;
}

/** Every bit flipped - a symbol printed light on dark reads like this. */
function invertBits(bits) {
  const out = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i += 1) out[i] = bits[i] ? 0 : 1;
  return out;
}

/**
 * The binarisations to try, in the order they are worth trying: the local one
 * first, then three global ones, then the local one inverted.
 */
function* binarisations(grey, width, height) {
  const local = adaptiveBits(grey, width, height);
  yield local;
  const level = otsu(grey);
  yield globalBits(grey, level);
  let sum = 0;
  for (let i = 0; i < grey.length; i += 1) sum += grey[i];
  yield globalBits(grey, sum / grey.length);
  let min = 255;
  let max = 0;
  for (let i = 0; i < grey.length; i += 1) {
    if (grey[i] < min) min = grey[i];
    if (grey[i] > max) max = grey[i];
  }
  yield globalBits(grey, (min + max) / 2);
  yield invertBits(local);
}

// ----------------------------------------------------------- finder patterns

/** Run-length encoding of one scan line: alternating stretches of one colour. */
function runsOf(get, n) {
  const list = [];
  let i = 0;
  while (i < n) {
    const dark = get(i);
    let j = i + 1;
    while (j < n && get(j) === dark) j += 1;
    list.push({ dark, start: i, len: j - i });
    i = j;
  }
  return list;
}

/**
 * Does a five-run window hold the given ratio? Returns the module width the
 * window implies, or 0 when it does not.
 * @param {number[]} run five lengths
 * @param {number[]} weights the ideal proportion, e.g. 1:1:3:1:1
 */
function ratioModule(run, weights) {
  let total = 0;
  let parts = 0;
  for (let i = 0; i < 5; i += 1) {
    total += run[i];
    parts += weights[i];
  }
  if (total < parts) return 0;
  const unit = total / parts;
  for (let i = 0; i < 5; i += 1) {
    if (Math.abs(run[i] - weights[i] * unit) > unit * RUN_TOLERANCE * weights[i]) return 0;
  }
  return unit;
}

/**
 * Walk outwards from a point inside the centre run and check the same ratio
 * along the other axis. Returns the centre of the middle run and the module
 * width, or null.
 */
function crossPattern(get, n, start, weights) {
  if (start < 0 || start >= n || !get(start)) return null;
  let lo = start;
  while (lo > 0 && get(lo - 1)) lo -= 1;
  let hi = start;
  while (hi + 1 < n && get(hi + 1)) hi += 1;
  const centre = hi - lo + 1;
  // Nothing that belongs to this pattern is longer than the centre run plus a
  // little; the cap stops a walk from running away into a black margin.
  const cap = centre * 2 + 2;

  let i = lo - 1;
  let inner1 = 0;
  while (i >= 0 && !get(i) && inner1 < cap) {
    inner1 += 1;
    i -= 1;
  }
  let outer1 = 0;
  while (i >= 0 && get(i) && outer1 < cap) {
    outer1 += 1;
    i -= 1;
  }
  i = hi + 1;
  let inner2 = 0;
  while (i < n && !get(i) && inner2 < cap) {
    inner2 += 1;
    i += 1;
  }
  let outer2 = 0;
  while (i < n && get(i) && outer2 < cap) {
    outer2 += 1;
    i += 1;
  }

  const unit = ratioModule([outer1, inner1, centre, inner2, outer2], weights);
  if (!unit) return null;
  return { centre: (lo + hi + 1) / 2, module: unit };
}

const FINDER_WEIGHTS = [1, 1, 3, 1, 1];
const ALIGN_WEIGHTS = [1, 1, 1, 1, 1];

/** Two module widths are the same width if they are within half of each other. */
function similar(a, b) {
  return Math.abs(a - b) <= Math.max(a, b) * 0.5;
}

/** Candidates that sit on top of each other are one pattern seen many times. */
function mergeCandidates(list) {
  const out = [];
  for (const c of list) {
    let hit = null;
    for (const o of out) {
      if (Math.hypot(o.x - c.x, o.y - c.y) < Math.max(o.module, c.module) * 1.5) {
        hit = o;
        break;
      }
    }
    if (hit) {
      hit.x = (hit.x * hit.count + c.x) / (hit.count + 1);
      hit.y = (hit.y * hit.count + c.y) / (hit.count + 1);
      hit.module = (hit.module * hit.count + c.module) / (hit.count + 1);
      hit.count += 1;
    } else {
      out.push({ x: c.x, y: c.y, module: c.module, count: 1 });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

/**
 * Every place in the picture that looks like a finder pattern. Rows and
 * columns are both swept, because a code photographed at an angle can hide
 * its ratio from one direction and show it in the other; each hit is then
 * confirmed along the other axis before it counts.
 */
function findFinders(bits, width, height) {
  const raw = [];
  const step = Math.max(1, Math.round(Math.min(width, height) / 400));

  for (let y = 0; y < height; y += step) {
    const line = runsOf((x) => bits[y * width + x] === 1, width);
    for (let k = 0; k + 4 < line.length; k += 1) {
      if (!line[k].dark) continue;
      const unit = ratioModule(
        [line[k].len, line[k + 1].len, line[k + 2].len, line[k + 3].len, line[k + 4].len],
        FINDER_WEIGHTS,
      );
      if (!unit) continue;
      const cx = Math.round(line[k + 2].start + line[k + 2].len / 2);
      if (cx < 0 || cx >= width) continue;
      const down = crossPattern((yy) => bits[yy * width + cx] === 1, height, y, FINDER_WEIGHTS);
      if (!down || !similar(down.module, unit)) continue;
      const cy = Math.round(down.centre);
      if (cy < 0 || cy >= height) continue;
      const across = crossPattern((xx) => bits[cy * width + xx] === 1, width, cx, FINDER_WEIGHTS);
      if (!across || !similar(across.module, unit)) continue;
      raw.push({ x: across.centre, y: down.centre, module: (unit + down.module + across.module) / 3 });
    }
  }

  for (let x = 0; x < width; x += step) {
    const line = runsOf((y) => bits[y * width + x] === 1, height);
    for (let k = 0; k + 4 < line.length; k += 1) {
      if (!line[k].dark) continue;
      const unit = ratioModule(
        [line[k].len, line[k + 1].len, line[k + 2].len, line[k + 3].len, line[k + 4].len],
        FINDER_WEIGHTS,
      );
      if (!unit) continue;
      const cy = Math.round(line[k + 2].start + line[k + 2].len / 2);
      if (cy < 0 || cy >= height) continue;
      const across = crossPattern((xx) => bits[cy * width + xx] === 1, width, x, FINDER_WEIGHTS);
      if (!across || !similar(across.module, unit)) continue;
      const cx = Math.round(across.centre);
      if (cx < 0 || cx >= width) continue;
      const down = crossPattern((yy) => bits[yy * width + cx] === 1, height, cy, FINDER_WEIGHTS);
      if (!down || !similar(down.module, unit)) continue;
      raw.push({ x: across.centre, y: down.centre, module: (unit + down.module + across.module) / 3 });
    }
  }

  return mergeCandidates(raw);
}

/**
 * Three candidates in the arrangement a QR code has them: a corner with two
 * arms of equal length at a right angle. Returns them named, with a small
 * error score, or null when the three cannot be that.
 */
function orderTriple(p, q, r) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const pq = dist(p, q);
  const pr = dist(p, r);
  const qr = dist(q, r);
  let corner;
  let one;
  let two;
  if (qr >= pq && qr >= pr) {
    corner = p;
    one = q;
    two = r;
  } else if (pr >= pq && pr >= qr) {
    corner = q;
    one = p;
    two = r;
  } else {
    corner = r;
    one = p;
    two = q;
  }
  const leg1 = dist(corner, one);
  const leg2 = dist(corner, two);
  const hyp = dist(one, two);
  if (leg1 < 4 || leg2 < 4 || hyp < 4) return null;

  const legs = Math.abs(leg1 - leg2) / Math.max(leg1, leg2);
  const right = Math.abs(hyp - Math.hypot(leg1, leg2)) / hyp;
  const mods = [p.module, q.module, r.module];
  const spread = (Math.max(...mods) - Math.min(...mods)) / Math.max(...mods);
  if (legs > 0.4 || right > 0.3 || spread > 0.55) return null;

  // Corner, top right, bottom left turn clockwise in image coordinates, where
  // y points down. A mirrored photo turns the other way and is caught later,
  // when the matrix is tried in all eight orientations.
  const cross =
    (one.x - corner.x) * (two.y - corner.y) - (one.y - corner.y) * (two.x - corner.x);
  return {
    topLeft: corner,
    topRight: cross > 0 ? one : two,
    bottomLeft: cross > 0 ? two : one,
    error: legs + right + spread,
  };
}

/** The most plausible arrangements of three, best first. */
function bestTriples(candidates, limit) {
  const pool = candidates.slice(0, 8);
  const out = [];
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      for (let k = j + 1; k < pool.length; k += 1) {
        const triple = orderTriple(pool[i], pool[j], pool[k]);
        if (triple) out.push(triple);
      }
    }
  }
  out.sort((a, b) => a.error - b.error);
  return out.slice(0, limit);
}

// ------------------------------------------------------------------ geometry

/**
 * How wide one module is along one particular direction, measured by walking
 * the 1:1:3:1:1 of a finder pattern along exactly that line.
 *
 * This is not the same number as the width a horizontal scanline reported. A
 * symbol turned forty-five degrees shows a horizontal scanline runs that are
 * longer by a factor of the square root of two, and a dimension computed from
 * that is a third too small - which is a different version, and a failed read.
 * The distance between two finder centres has to be divided by the module
 * width measured in the direction of that distance.
 */
function moduleAlong(at, centre, dx, dy, hint) {
  const reach = Math.max(10, Math.round(hint * 8));
  const n = reach * 2 + 1;
  const get = (i) => at(centre.x + (i - reach) * dx, centre.y + (i - reach) * dy);
  const found = crossPattern(get, n, reach, FINDER_WEIGHTS);
  return found ? found.module : 0;
}

/**
 * How many modules across the symbol is. The distance between two finder
 * centres is the width minus seven modules, and the answer has to be one more
 * than a multiple of four - so the rounding is snapped onto that grid. The
 * neighbours are returned too: this estimate is the most fragile number in the
 * whole read, and trying three costs nothing.
 */
function dimensionsFor(triple, at) {
  const hint = (triple.topLeft.module + triple.topRight.module + triple.bottomLeft.module) / 3;
  if (!(hint > 0)) return null;

  const measure = (from, to) => {
    const span = Math.hypot(to.x - from.x, to.y - from.y);
    if (span < 1) return null;
    const dx = (to.x - from.x) / span;
    const dy = (to.y - from.y) / span;
    const a = moduleAlong(at, from, dx, dy, hint);
    const b = moduleAlong(at, to, dx, dy, hint);
    const widths = [a, b].filter((v) => v > 0);
    if (!widths.length) return null;
    const width = widths.reduce((s, v) => s + v, 0) / widths.length;
    return { span, width };
  };

  const across = measure(triple.topLeft, triple.topRight);
  const down = measure(triple.topLeft, triple.bottomLeft);
  const parts = [across, down].filter(Boolean);
  const module = parts.length
    ? parts.reduce((s, p) => s + p.width, 0) / parts.length
    : hint;
  if (!(module > 0)) return null;

  let estimate = 0;
  if (parts.length) {
    for (const part of parts) estimate += part.span / part.width;
    estimate = estimate / parts.length + 7;
  } else {
    const a = Math.hypot(triple.topRight.x - triple.topLeft.x, triple.topRight.y - triple.topLeft.y);
    const b = Math.hypot(
      triple.bottomLeft.x - triple.topLeft.x,
      triple.bottomLeft.y - triple.topLeft.y,
    );
    estimate = (a + b) / 2 / hint + 7;
  }

  let dim = Math.round(estimate);
  const rest = dim % 4;
  if (rest === 0) dim += 1;
  else if (rest === 2) dim -= 1;
  else if (rest === 3) dim += 2;

  const dims = [];
  for (const d of [dim, dim - 4, dim + 4, dim - 8, dim + 8]) {
    if (d >= MIN_DIMENSION && d <= MAX_DIMENSION && !dims.includes(d)) dims.push(d);
  }
  return { module, dims };
}

/**
 * Straight-line mapping from module coordinates to pixels, from three points.
 * The two basis vectors come back with it: they are what one module step looks
 * like in the picture, which is how the alignment ring can be recognised
 * whatever angle the camera was held at.
 */
function affineMap(triple, dim) {
  const span = dim - 7;
  const ax = (triple.topRight.x - triple.topLeft.x) / span;
  const bx = (triple.bottomLeft.x - triple.topLeft.x) / span;
  const cx = triple.topLeft.x - 3.5 * ax - 3.5 * bx;
  const ay = (triple.topRight.y - triple.topLeft.y) / span;
  const by = (triple.bottomLeft.y - triple.topLeft.y) / span;
  const cy = triple.topLeft.y - 3.5 * ay - 3.5 * by;
  return {
    map: (u, v) => [ax * u + bx * v + cx, ay * u + by * v + cy],
    eu: [ax, ay],
    ev: [bx, by],
  };
}

/** Solve a small dense linear system by elimination with partial pivoting. */
function solveLinear(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    const tmp = a[col];
    a[col] = a[pivot];
    a[pivot] = tmp;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col] / a[col][col];
      if (!factor) continue;
      for (let k = col; k <= n; k += 1) a[row][k] -= factor * a[col][k];
    }
  }
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = a[i][n] / a[i][i];
  return out;
}

/**
 * The projective mapping through four correspondences - what turns a photo
 * taken from the side back into a square grid. Eight unknowns, eight
 * equations, solved directly.
 */
function perspectiveMap(pairs) {
  const rows = [];
  const rhs = [];
  for (const p of pairs) {
    rows.push([p.u, p.v, 1, 0, 0, 0, -p.u * p.x, -p.v * p.x]);
    rhs.push(p.x);
    rows.push([0, 0, 0, p.u, p.v, 1, -p.u * p.y, -p.v * p.y]);
    rhs.push(p.y);
  }
  const h = solveLinear(rows, rhs);
  if (!h) return null;
  for (const value of h) if (!Number.isFinite(value)) return null;
  return (u, v) => {
    const w = h[6] * u + h[7] * v + 1;
    if (!w) return null;
    return [(h[0] * u + h[1] * v + h[2]) / w, (h[3] * u + h[4] * v + h[5]) / w];
  };
}

/**
 * Does a five by five alignment ring sit around this point? The stencil is
 * walked in MODULE space - one step is `eu` across and `ev` down in the
 * picture - so a code photographed at an angle is checked at the angle it was
 * photographed. The centre nine have to be exactly right (dark middle, light
 * ring); of the sixteen around them, which lie against the payload and blur
 * into it, twelve dark is enough.
 *
 * A ring that is not a ring costs one wasted sampling attempt and nothing
 * else: the affine grid is tried afterwards either way, and no matrix leaves
 * this module without its Reed-Solomon parity checking out.
 */
function ringAt(at, cx, cy, eu, ev) {
  let outer = 0;
  for (let j = -2; j <= 2; j += 1) {
    for (let i = -2; i <= 2; i += 1) {
      const x = cx + i * eu[0] + j * ev[0];
      const y = cy + i * eu[1] + j * ev[1];
      const dark = at(x, y);
      const reach = Math.max(Math.abs(i), Math.abs(j));
      if (reach === 2) {
        if (dark) outer += 1;
      } else if (dark !== (reach === 0)) {
        return false;
      }
    }
  }
  return outer >= 12;
}

/**
 * The bottom-right alignment ring, looked for near where the straight-line
 * mapping says it should be. Finding it is what lets the fourth corner be
 * pinned instead of guessed, and that is the difference between a photo taken
 * straight on and one taken from a chair. The window is generous, because the
 * straight-line guess is exactly what goes wrong when the camera was tilted -
 * what keeps a wrong ring out is the stencil, not a narrow search.
 *
 * @returns {{x:number,y:number}[]} the closest few candidates, nearest first
 */
function findAlignment(bits, width, height, guessX, guessY, module, eu, ev) {
  const radius = Math.max(8, Math.round(module * 6));
  const x0 = Math.max(0, Math.round(guessX - radius));
  const x1 = Math.min(width - 1, Math.round(guessX + radius));
  const y0 = Math.max(0, Math.round(guessY - radius));
  const y1 = Math.min(height - 1, Math.round(guessY + radius));
  if (x1 - x0 < 5 || y1 - y0 < 5) return [];

  const at = (x, y) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return false;
    return bits[yi * width + xi] === 1;
  };

  const found = [];
  for (let y = y0; y <= y1; y += 1) {
    const line = runsOf((x) => bits[y * width + x] === 1, width);
    for (let k = 1; k + 1 < line.length; k += 1) {
      // A dark stretch about one module wide with light on both sides: the
      // centre of the ring, and not much else that is worth verifying.
      if (!line[k].dark) continue;
      if (!similar(line[k].len, module)) continue;
      if (line[k - 1].len < module * 0.4 || line[k + 1].len < module * 0.4) continue;
      const cx = line[k].start + line[k].len / 2;
      if (cx < x0 || cx > x1) continue;
      const down = crossPattern(
        (yy) => bits[yy * width + Math.round(cx)] === 1,
        height,
        y,
        ALIGN_WEIGHTS,
      );
      const cy = down && similar(down.module, module) ? down.centre : y;
      if (!ringAt(at, cx, cy, eu, ev)) continue;
      const away = Math.hypot(cx - guessX, cy - guessY);
      found.push({ x: cx, y: cy, away });
    }
  }
  found.sort((a, b) => a.away - b.away);
  // Nearby hits are the same ring seen on several rows; keep the distinct ones.
  const out = [];
  for (const hit of found) {
    if (out.some((o) => Math.hypot(o.x - hit.x, o.y - hit.y) < module * 2)) continue;
    out.push(hit);
    if (out.length === 2) break;
  }
  return out;
}

/**
 * Read the modules off the picture. Each module is sampled at its centre; when
 * the modules are big enough to have an inside, a small square around that
 * centre votes, which is what shrugs off single noisy pixels.
 */
function sampleMatrix(bits, width, height, dim, map, module) {
  const out = [];
  const radius = module >= 5 ? Math.min(2, Math.floor(module / 4)) : 0;
  let outside = 0;
  for (let r = 0; r < dim; r += 1) {
    const row = new Array(dim);
    for (let c = 0; c < dim; c += 1) {
      const point = map(c + 0.5, r + 0.5);
      if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
      let x = Math.round(point[0]);
      let y = Math.round(point[1]);
      if (x < 0 || y < 0 || x >= width || y >= height) {
        outside += 1;
        if (outside > dim) return null;
        x = Math.min(width - 1, Math.max(0, x));
        y = Math.min(height - 1, Math.max(0, y));
      }
      if (radius === 0) {
        row[c] = bits[y * width + x] === 1;
      } else {
        let dark = 0;
        let total = 0;
        for (let dy = -radius; dy <= radius; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -radius; dx <= radius; dx += 1) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            total += 1;
            if (bits[yy * width + xx] === 1) dark += 1;
          }
        }
        row[c] = dark * 2 > total;
      }
    }
    out.push(row);
  }
  return out;
}

// --------------------------------------------------------- the symbol itself

/** Every module a payload bit may not sit in, derived from the geometry. */
function reservedMap(size, version) {
  const grid = [];
  for (let r = 0; r < size; r += 1) grid.push(new Array(size).fill(false));
  const mark = (r, c) => {
    if (r >= 0 && c >= 0 && r < size && c < size) grid[r][c] = true;
  };
  const block = (r0, c0, h, w) => {
    for (let r = r0; r < r0 + h; r += 1) for (let c = c0; c < c0 + w; c += 1) mark(r, c);
  };
  block(0, 0, 9, 9);
  block(0, size - 8, 9, 8);
  block(size - 8, 0, 8, 9);
  for (let i = 0; i < size; i += 1) {
    mark(6, i);
    mark(i, 6);
  }
  const centres = ALIGNMENT[version] || [];
  for (let i = 0; i < centres.length; i += 1) {
    for (let j = 0; j < centres.length; j += 1) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === centres.length - 1) ||
        (i === centres.length - 1 && j === 0);
      if (!corner) block(centres[i] - 2, centres[j] - 2, 5, 5);
    }
  }
  if (version >= 7) {
    block(0, size - 11, 6, 3);
    block(size - 11, 0, 3, 6);
  }
  return grid;
}

/** The fifteen format bits for one error correction level and one mask. */
function formatWord(level, mask) {
  const data = (level << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function popcount(value) {
  let v = value;
  let count = 0;
  while (v) {
    v &= v - 1;
    count += 1;
  }
  return count;
}

/**
 * The closest legal format string to what was read. The BCH code behind the
 * format information has a minimum distance of seven, so up to three wrong
 * modules still name exactly one level and one mask - and anything further off
 * than that is not a format string at all.
 */
function nearestFormat(word) {
  let best = null;
  for (let level = 0; level < 4; level += 1) {
    for (let mask = 0; mask < 8; mask += 1) {
      const distance = popcount(word ^ formatWord(level, mask));
      if (!best || distance < best.distance) best = { level, mask, distance };
    }
  }
  return best;
}

/**
 * Both copies of the format information, each corrected on its own; the one
 * that needed less repair wins. Level M is the only level this reader has
 * block tables for, so anything else is refused rather than misread.
 */
function readFormat(matrix) {
  const size = matrix.length;
  let first = 0;
  const pushFirst = (bit) => {
    first = (first << 1) | (bit ? 1 : 0);
  };
  for (let i = 14; i >= 9; i -= 1) pushFirst(matrix[8][14 - i]);
  pushFirst(matrix[8][7]);
  pushFirst(matrix[8][8]);
  pushFirst(matrix[7][8]);
  for (let i = 5; i >= 0; i -= 1) pushFirst(matrix[i][8]);

  let second = 0;
  const pushSecond = (bit) => {
    second = (second << 1) | (bit ? 1 : 0);
  };
  for (let i = 14; i >= 8; i -= 1) pushSecond(matrix[size - 15 + i][8]);
  for (let i = 7; i >= 0; i -= 1) pushSecond(matrix[8][size - 1 - i]);

  const a = nearestFormat(first);
  const b = nearestFormat(second);
  const best = a.distance <= b.distance ? a : b;
  if (best.distance > 3) return null;
  if (best.level !== 0) return null;
  return best;
}

/** The unmasked codeword stream, read in the zigzag the standard prescribes. */
function readCodewords(matrix, version, mask) {
  const size = matrix.length;
  const reserved = reservedMap(size, version);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (reserved[row][col]) continue;
        bits.push(matrix[row][col] !== maskCondition(mask, row, col) ? 1 : 0);
      }
    }
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let v = 0;
    for (let k = 0; k < 8; k += 1) v = (v << 1) | bits[i + k];
    bytes.push(v);
  }
  return bytes;
}

/** Undo the block interleaving: each block whole again, parity attached. */
function deinterleave(stream, version) {
  const spec = EC_TABLE[version];
  if (!spec) return null;
  const sizes = [];
  for (const [count, size] of spec.groups) for (let i = 0; i < count; i += 1) sizes.push(size);
  let needed = sizes.length * spec.ec;
  for (const size of sizes) needed += size;
  if (stream.length < needed) return null;

  const data = sizes.map(() => []);
  const parity = sizes.map(() => []);
  const longest = Math.max(...sizes);
  let p = 0;
  for (let i = 0; i < longest; i += 1) {
    for (let b = 0; b < sizes.length; b += 1) if (i < sizes[b]) data[b].push(stream[p++]);
  }
  for (let i = 0; i < spec.ec; i += 1) {
    for (let b = 0; b < sizes.length; b += 1) parity[b].push(stream[p++]);
  }
  const blocks = data.map((d, i) => Uint8Array.from([...d, ...parity[i]]));
  return { blocks, ec: spec.ec };
}

// ------------------------------------------------------ Reed-Solomon repair

/**
 * The syndromes of a codeword: the codeword polynomial evaluated at the roots
 * of the generator, a^0 to a^(n-1). All zero means the codeword is a codeword.
 */
function syndromes(codeword, count) {
  const values = new Array(count);
  let any = false;
  for (let i = 0; i < count; i += 1) {
    let acc = 0;
    for (let j = 0; j < codeword.length; j += 1) acc = gfMul(acc, EXP[i]) ^ codeword[j];
    values[i] = acc;
    if (acc) any = true;
  }
  return { values, any };
}

/** A polynomial in ascending coefficient order, evaluated by Horner. */
function evalPoly(coefficients, x) {
  let acc = 0;
  for (let i = coefficients.length - 1; i >= 0; i -= 1) acc = gfMul(acc, x) ^ coefficients[i];
  return acc;
}

/**
 * Berlekamp-Massey, from its definition: build the shortest linear recurrence
 * the syndrome sequence obeys. Each step measures how far the current
 * candidate is off (the discrepancy), and either leaves it alone or corrects
 * it with a shifted copy of the last candidate that was replaced. What comes
 * out is the error locator polynomial, ascending coefficients, constant term 1.
 */
function errorLocator(syndrome) {
  let lambda = [1];
  let previous = [1];
  let discrepancyBefore = 1;
  let length = 0;
  let shift = 1;

  for (let r = 0; r < syndrome.length; r += 1) {
    let discrepancy = syndrome[r];
    for (let i = 1; i <= length; i += 1) {
      discrepancy ^= gfMul(lambda[i] || 0, syndrome[r - i]);
    }
    if (discrepancy === 0) {
      shift += 1;
      continue;
    }
    const scale = gfDiv(discrepancy, discrepancyBefore);
    const correction = new Array(shift + previous.length).fill(0);
    for (let i = 0; i < previous.length; i += 1) correction[i + shift] = gfMul(previous[i], scale);
    const next = new Array(Math.max(lambda.length, correction.length)).fill(0);
    for (let i = 0; i < next.length; i += 1) next[i] = (lambda[i] || 0) ^ (correction[i] || 0);

    if (2 * length <= r) {
      previous = lambda;
      discrepancyBefore = discrepancy;
      length = r + 1 - length;
      shift = 1;
    } else {
      shift += 1;
    }
    lambda = next;
  }
  while (lambda.length > 1 && lambda[lambda.length - 1] === 0) lambda.pop();
  return lambda;
}

/**
 * Chien search: try every position and keep the ones where the locator
 * vanishes. Position i in the codeword array carries the term of degree
 * n-1-i, so its locator is a^(n-1-i).
 */
function errorPositions(lambda, n) {
  const found = [];
  for (let power = 0; power < n; power += 1) {
    const inverse = EXP[(255 - (power % 255)) % 255];
    if (evalPoly(lambda, inverse) === 0) found.push({ index: n - 1 - power, power });
  }
  return found;
}

/**
 * Forney's formula for the magnitudes. The generator's first root is a^0, so
 * the value at a location X is X * omega(1/X) / lambda'(1/X), where omega is
 * the syndrome polynomial times the locator, cut at the parity length, and
 * lambda' is the formal derivative - in this field, the odd-degree terms
 * shifted down by one.
 */
function errorValues(syndrome, lambda, positions) {
  const count = syndrome.length;
  const omega = new Array(count).fill(0);
  for (let i = 0; i < count; i += 1) {
    for (let j = 0; j < lambda.length && i + j < count; j += 1) {
      omega[i + j] ^= gfMul(syndrome[i], lambda[j]);
    }
  }
  const derivative = new Array(Math.max(1, lambda.length - 1)).fill(0);
  for (let i = 1; i < lambda.length; i += 1) {
    if (i % 2 === 1) derivative[i - 1] = lambda[i];
  }

  const values = [];
  for (const position of positions) {
    const inverse = EXP[(255 - (position.power % 255)) % 255];
    const denominator = evalPoly(derivative, inverse);
    if (denominator === 0) return null;
    const numerator = evalPoly(omega, inverse);
    const locator = EXP[position.power % 255];
    values.push(gfMul(locator, gfDiv(numerator, denominator)));
  }
  return values;
}

/**
 * Repair a block, or say it cannot be repaired. The result is checked by
 * recomputing the syndromes: a decoder that silently "corrects" a codeword
 * into a different valid one is worse than a decoder that gives up, because
 * the caller would then adopt a vault that is not the one on the screen.
 *
 * @param {Uint8Array} codeword data followed by parity
 * @param {number} count number of parity codewords
 * @returns {Uint8Array|null}
 */
export function correctBlock(codeword, count) {
  const first = syndromes(codeword, count);
  if (!first.any) return Uint8Array.from(codeword);

  const lambda = errorLocator(first.values);
  const degree = lambda.length - 1;
  if (degree < 1 || degree * 2 > count) return null;

  const positions = errorPositions(lambda, codeword.length);
  if (positions.length !== degree) return null;

  const values = errorValues(first.values, lambda, positions);
  if (!values) return null;

  const out = Uint8Array.from(codeword);
  for (let i = 0; i < positions.length; i += 1) {
    const index = positions[i].index;
    if (index < 0 || index >= out.length) return null;
    out[index] ^= values[i];
  }
  return syndromes(out, count).any ? null : out;
}

// ------------------------------------------------------------- the payload

/** Mode, length and bytes out of the joined data codewords. Byte mode only. */
function parseData(bytes, version) {
  const limit = bytes.length * 8;
  let pos = 0;
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i += 1) {
      v = (v << 1) | ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1);
      pos += 1;
    }
    return v;
  };
  if (limit < 12) return null;
  if (take(4) !== 4) return null;
  const lengthBits = version < 10 ? 8 : 16;
  if (pos + lengthBits > limit) return null;
  const length = take(lengthBits);
  if (length < 1) return null;
  if (pos + length * 8 > limit) return null;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = take(8);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(out);
  } catch {
    return null;
  }
}

// ----------------------------------------------------------- orientations

/** The same modules, turned a quarter turn clockwise. */
function turned(matrix) {
  const n = matrix.length;
  const out = [];
  for (let r = 0; r < n; r += 1) {
    const row = new Array(n);
    for (let c = 0; c < n; c += 1) row[c] = matrix[n - 1 - c][r];
    out.push(row);
  }
  return out;
}

/** The same modules seen from behind. */
function flipped(matrix) {
  return matrix.map((row) => row.slice().reverse());
}

// --------------------------------------------------------------- public API

/**
 * One matrix of modules, decoded. true is a dark module. Returns the payload
 * or null; it never throws.
 * @param {boolean[][]} matrix
 * @returns {string|null}
 */
export function decodeMatrix(matrix) {
  try {
    if (!Array.isArray(matrix) || !matrix.length) return null;
    const size = matrix.length;
    if ((size - 17) % 4 !== 0) return null;
    const version = (size - 17) / 4;
    if (version < 1 || version > MAX_VERSION) return null;
    for (const row of matrix) if (!row || row.length !== size) return null;

    const format = readFormat(matrix);
    if (!format) return null;
    const stream = readCodewords(matrix, version, format.mask);
    const split = deinterleave(stream, version);
    if (!split) return null;

    const data = [];
    for (const block of split.blocks) {
      const fixed = correctBlock(block, split.ec);
      if (!fixed) return null;
      for (let i = 0; i < block.length - split.ec; i += 1) data.push(fixed[i]);
    }
    return parseData(data, version);
  } catch {
    return null;
  }
}

/**
 * A matrix in whichever of the eight orientations a camera happened to catch
 * it. A photo has no guaranteed rotation, and a picture of a screen taken
 * through a mirror or a front camera is the wrong way round.
 */
function decodeAnyOrientation(matrix) {
  let current = matrix;
  for (let turn = 0; turn < 4; turn += 1) {
    const hit = decodeMatrix(current);
    if (hit !== null) return hit;
    const back = decodeMatrix(flipped(current));
    if (back !== null) return back;
    current = turned(current);
  }
  return null;
}

/** Everything that can be tried on one binarised picture. */
function decodeBits(bits, width, height) {
  const finders = findFinders(bits, width, height);
  if (finders.length < 3) return null;
  const at = (x, y) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return false;
    return bits[yi * width + xi] === 1;
  };
  for (const triple of bestTriples(finders, 6)) {
    const guess = dimensionsFor(triple, at);
    if (!guess) continue;
    for (const dim of guess.dims) {
      const affine = affineMap(triple, dim);
      const maps = [];

      // The bottom-right alignment ring pins the fourth corner. Where the
      // version has one and it is found, the grid is a real projection;
      // otherwise the straight-line mapping has to carry the read alone.
      const version = (dim - 17) / 4;
      if (version >= 2 && version <= MAX_VERSION) {
        const target = dim - 6.5;
        const expected = affine.map(target, target);
        const rings = findAlignment(
          bits,
          width,
          height,
          expected[0],
          expected[1],
          guess.module,
          affine.eu,
          affine.ev,
        );
        for (const ring of rings) {
          const projective = perspectiveMap([
            { u: 3.5, v: 3.5, x: triple.topLeft.x, y: triple.topLeft.y },
            { u: dim - 3.5, v: 3.5, x: triple.topRight.x, y: triple.topRight.y },
            { u: 3.5, v: dim - 3.5, x: triple.bottomLeft.x, y: triple.bottomLeft.y },
            { u: target, v: target, x: ring.x, y: ring.y },
          ]);
          if (projective) maps.push(projective);
        }
      }
      maps.push(affine.map);

      for (const map of maps) {
        const matrix = sampleMatrix(bits, width, height, dim, map, guess.module);
        if (!matrix) continue;
        const hit = decodeAnyOrientation(matrix);
        if (hit !== null) return hit;
      }
    }
  }
  return null;
}

/**
 * Read the QR code in a still picture.
 *
 * @param {ImageData|HTMLCanvasElement|OffscreenCanvas} source
 * @returns {string|null} the payload, or null when nothing could be read
 */
export function decodeImage(source) {
  try {
    const image = toImageData(source);
    if (!image || !image.width || !image.height) return null;
    const grey = luminance(image);
    for (const bits of binarisations(grey, image.width, image.height)) {
      const hit = decodeBits(bits, image.width, image.height);
      if (hit !== null) return hit;
    }
    return null;
  } catch {
    return null;
  }
}
