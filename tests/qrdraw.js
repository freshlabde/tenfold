// tests/qrdraw.js - turning a QR matrix into something that looks photographed.
//
// The reader in web/js/qrread.js has to survive a picture, not a bitmap, so
// this helper produces pictures: the symbol scaled, rotated, skewed, projected
// as if seen from the side, laid on a grey that is not paper white, lit
// unevenly, and speckled. Everything is deterministic - the noise comes out of
// a seeded generator, never Math.random - so a failing case can be reproduced
// exactly.
//
// It builds a plain {data, width, height} the way ImageData looks, which is
// what decodeImage takes; nothing here needs a canvas, so the same helper runs
// in node and in the browser. It is a test helper and ships with nothing.

/** A small deterministic generator. Reproducible beats random in a test. */
export function prng(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * A projective mapping through four correspondences, solved by elimination.
 * Written out here rather than imported so the drawing side and the reading
 * side do not share a bug.
 */
function homography(pairs) {
  const rows = [];
  const rhs = [];
  for (const p of pairs) {
    rows.push([p.u, p.v, 1, 0, 0, 0, -p.u * p.x, -p.v * p.x]);
    rhs.push(p.x);
    rows.push([0, 0, 0, p.u, p.v, 1, -p.u * p.y, -p.v * p.y]);
    rhs.push(p.y);
  }
  const n = 8;
  const a = rows.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
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
  const h = a.map((row, i) => row[n] / row[i]);
  return (x, y) => {
    const w = h[6] * x + h[7] * y + 1;
    return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
  };
}

/**
 * Flip a set of modules, chosen deterministically, staying out of the function
 * patterns - a wrong module in a finder is a different test.
 *
 * @param {boolean[][]} matrix
 * @param {boolean[][]} reserved the map from tests/qrdecode.js
 * @param {number} count how many modules to flip
 * @param {number} seed
 */
export function flipModules(matrix, reserved, count, seed) {
  const size = matrix.length;
  const free = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) if (!reserved[r][c]) free.push([r, c]);
  }
  const random = prng(seed);
  const out = matrix.map((row) => row.slice());
  const taken = new Set();
  while (taken.size < Math.min(count, free.length)) {
    const i = Math.floor(random() * free.length);
    if (taken.has(i)) continue;
    taken.add(i);
    const [r, c] = free[i];
    out[r][c] = !out[r][c];
  }
  return out;
}

/**
 * Render a matrix as a picture.
 *
 * @param {boolean[][]} matrix
 * @param {Object} [opts]
 *   module   pixels per module (default 8)
 *   quiet    quiet zone in modules (default 4)
 *   pad      pixels of surround around the symbol
 *   rotate   degrees, clockwise
 *   corners  four explicit destination points, TL TR BR BL - beats rotate
 *   paper    luminance of the light modules (default 255)
 *   ink      luminance of the dark modules (default 0)
 *   margin   "light" (default) or "dark" for what lies outside the symbol
 *   gradient 0..1, how much darker the right edge is lit than the left
 *   noise    standard deviation of the speckle, in luminance steps
 *   seed     the noise seed
 * @returns {{data: Uint8ClampedArray, width: number, height: number}}
 */
export function renderMatrix(matrix, opts = {}) {
  const module = opts.module === undefined ? 8 : opts.module;
  const quiet = opts.quiet === undefined ? 4 : opts.quiet;
  const pad = opts.pad === undefined ? Math.max(6, Math.round(module * 2)) : opts.pad;
  const paper = opts.paper === undefined ? 255 : opts.paper;
  const ink = opts.ink === undefined ? 0 : opts.ink;
  const surround = opts.margin === "dark" ? Math.round(paper * 0.22) : paper;
  const size = matrix.length;
  const span = (size + quiet * 2) * module;

  // The symbol itself, crisp, with its quiet zone.
  const source = new Uint8Array(span * span).fill(paper);
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!matrix[r][c]) continue;
      const y0 = (r + quiet) * module;
      const x0 = (c + quiet) * module;
      for (let y = y0; y < y0 + module; y += 1) {
        for (let x = x0; x < x0 + module; x += 1) source[y * span + x] = ink;
      }
    }
  }

  // Where the four corners of that square end up in the picture.
  let corners = opts.corners
    ? opts.corners.map((p) => [p[0], p[1]])
    : [
        [0, 0],
        [span, 0],
        [span, span],
        [0, span],
      ];
  if (!opts.corners && opts.rotate) {
    const angle = (opts.rotate * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const cx = span / 2;
    const cy = span / 2;
    corners = corners.map(([x, y]) => [
      cx + (x - cx) * cos - (y - cy) * sin,
      cy + (x - cx) * sin + (y - cy) * cos,
    ]);
  }
  const minX = Math.min(...corners.map((p) => p[0]));
  const minY = Math.min(...corners.map((p) => p[1]));
  corners = corners.map(([x, y]) => [x - minX + pad, y - minY + pad]);
  const width = Math.ceil(Math.max(...corners.map((p) => p[0])) + pad);
  const height = Math.ceil(Math.max(...corners.map((p) => p[1])) + pad);

  // Destination back to source, so every output pixel gets a value.
  const back = homography([
    { u: corners[0][0], v: corners[0][1], x: 0, y: 0 },
    { u: corners[1][0], v: corners[1][1], x: span, y: 0 },
    { u: corners[2][0], v: corners[2][1], x: span, y: span },
    { u: corners[3][0], v: corners[3][1], x: 0, y: span },
  ]);

  const random = prng(opts.seed === undefined ? 7 : opts.seed);
  const noise = opts.noise || 0;
  const gradient = opts.gradient || 0;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [u, v] = back(x + 0.5, y + 0.5);
      let value = surround;
      if (u >= 0 && v >= 0 && u < span - 1 && v < span - 1) {
        // Bilinear, so an edge lands between two pixels the way a lens puts it.
        const x0 = Math.floor(u);
        const y0 = Math.floor(v);
        const fx = u - x0;
        const fy = v - y0;
        const a = source[y0 * span + x0];
        const b = source[y0 * span + x0 + 1];
        const c = source[(y0 + 1) * span + x0];
        const d = source[(y0 + 1) * span + x0 + 1];
        value = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
      }
      if (gradient) value *= 1 - gradient * (x / width);
      if (noise) {
        // Three uniforms added together lean towards a bell without needing one.
        const bell = random() + random() + random() - 1.5;
        value += bell * noise;
      }
      const p = (y * width + x) * 4;
      data[p] = value;
      data[p + 1] = value;
      data[p + 2] = value;
      data[p + 3] = 255;
    }
  }
  return { data, width, height };
}

/** The picture on a canvas, for the paths that need a real image file. */
export function toCanvas(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const g = canvas.getContext("2d");
  const target = g.createImageData(image.width, image.height);
  target.data.set(image.data);
  g.putImageData(target, 0, 0);
  return canvas;
}
