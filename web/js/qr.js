// qr.js - the QR encoder, written here rather than borrowed.
//
// What it does: encodes a short string as a QR code in byte mode at error
// correction level M, picking the smallest of versions 1 to 10 that holds the
// payload. The full chain is here: mode and length header, terminator and
// padding, Reed-Solomon parity over GF(256), block interleaving, the function
// patterns (finder, separator, timing, alignment, dark module), all eight mask
// patterns scored against the four penalty rules, and the BCH-protected format
// and version information.
//
// What it deliberately does NOT do: no third-party code and no dependency of
// any kind - not on the DOM, not on the network, not on storage. No numeric or
// alphanumeric mode (a pairing URL is bytes, and a second mode would be a
// second thing to get wrong), no ECI, no structured append, no rendering
// beyond a path string. qrMatrix is pure: the same text always yields the same
// matrix, and nothing outside it is touched.

/** Error correction level M, as the format information encodes it. */
const EC_LEVEL_BITS = 0b00;

/** Byte mode. */
const MODE_BYTE = 0b0100;

/** The largest version this module builds. Ten is far past a pairing URL. */
export const MAX_VERSION = 10;

/**
 * Per version at level M: how many parity codewords each block carries, and
 * how the data codewords are cut into blocks. `groups` is a list of
 * [blockCount, dataCodewordsPerBlock] - two entries where the spec asks for
 * blocks of two different sizes. Straight out of the standard's tables.
 *
 * Exported because the reader in qrread.js has to cut the same blocks the
 * other way round. One table, transcribed once - two copies of it would be
 * two chances to mistype a number that nothing else would catch.
 */
export const EC_TABLE = {
  1: { ec: 10, groups: [[1, 16]] },
  2: { ec: 16, groups: [[1, 28]] },
  3: { ec: 26, groups: [[1, 44]] },
  4: { ec: 18, groups: [[2, 32]] },
  5: { ec: 24, groups: [[2, 43]] },
  6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] },
  8: { ec: 22, groups: [[2, 38], [2, 39]] },
  9: { ec: 22, groups: [[3, 36], [2, 37]] },
  10: { ec: 26, groups: [[4, 43], [1, 44]] },
};

/**
 * Centre coordinates of the alignment patterns, per version. Exported for the
 * same reason as EC_TABLE: the reader needs the identical geometry to know
 * which modules are function patterns and where to look for the bottom-right
 * alignment ring when it straightens a photograph.
 */
export const ALIGNMENT = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

/** The four penalty weights of the mask evaluation. */
const N1 = 3;
const N2 = 3;
const N3 = 40;
const N4 = 10;

// ------------------------------------------------------------------- GF(256)

// The field the standard uses: bytes modulo x^8 + x^4 + x^3 + x^2 + 1, with 2
// as the primitive element. Two lookup tables make multiplication a lookup.
// Both are exported (read-only by convention - nothing in this repo writes to
// them) so the reader's error correction works in the same field as the
// parity that was written here, rather than in a second copy of it.
export const EXP = new Uint8Array(512);
export const LOG = new Uint8Array(256);

(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

/** Product in GF(256). Zero is absorbing; everything else is a log lookup. */
export function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Quotient in GF(256). Dividing by zero is a programming error, not a value. */
export function gfDiv(a, b) {
  if (b === 0) throw new RangeError("qr: division by zero in GF(256)");
  if (a === 0) return 0;
  return EXP[LOG[a] + 255 - LOG[b]];
}

/**
 * The generator polynomial of the code, built from its definition as the
 * product of (x - a^i) for i = 0 .. n-1, rather than copied from a table of
 * coefficients. Highest degree first, monic.
 */
function generatorPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Polynomial remainder of data * x^n divided by the generator: the parity. */
function parity(data, n) {
  const gen = generatorPoly(n);
  const rem = new Uint8Array(n);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[n - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < n; i += 1) rem[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return rem;
}

// ----------------------------------------------------------------- bit stream

/** How many bits the character count field takes in this version. */
function lengthBits(version) {
  return version < 10 ? 8 : 16;
}

/** Total data codewords of a version at level M. */
function dataCodewordCount(version) {
  const spec = EC_TABLE[version];
  let total = 0;
  for (const [blocks, size] of spec.groups) total += blocks * size;
  return total;
}

/** The smallest version that carries `byteLength` bytes, or 0 if none does. */
function pickVersion(byteLength) {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const needed = 4 + lengthBits(version) + byteLength * 8;
    if (needed <= dataCodewordCount(version) * 8) return version;
  }
  return 0;
}

/** UTF-8 bytes of the payload. A pairing URL is ASCII; this is the honest path. */
function utf8(text) {
  return new TextEncoder().encode(text);
}

/**
 * Header, payload, terminator, byte alignment and the alternating pad bytes -
 * the data codewords exactly as the standard orders them.
 */
function dataCodewords(bytes, version) {
  const capacity = dataCodewordCount(version) * 8;
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };

  push(MODE_BYTE, 4);
  push(bytes.length, lengthBits(version));
  for (const byte of bytes) push(byte, 8);

  // Terminator: up to four zeroes, fewer when the capacity is nearly full.
  const terminator = Math.min(4, capacity - bits.length);
  for (let i = 0; i < terminator; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(capacity / 8);
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  }
  // The two pad bytes the standard names, alternating to the end.
  const pads = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < out.length; i += 1, p += 1) out[i] = pads[p % 2];
  return out;
}

/**
 * Cuts the data into blocks, computes the parity of each, and interleaves both
 * halves the way the standard prescribes - one codeword from every block in
 * turn, so a scratch across the symbol is spread over all blocks instead of
 * destroying one of them.
 */
function interleave(data, version) {
  const spec = EC_TABLE[version];
  const blocks = [];
  let offset = 0;
  for (const [count, size] of spec.groups) {
    for (let i = 0; i < count; i += 1) {
      const block = data.subarray(offset, offset + size);
      offset += size;
      blocks.push({ data: block, ec: parity(block, spec.ec) });
    }
  }

  const out = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  for (let i = 0; i < spec.ec; i += 1) {
    for (const block of blocks) out.push(block.ec[i]);
  }
  return Uint8Array.from(out);
}

// ----------------------------------------------------------- function patterns

function emptyGrid(size, value) {
  const grid = [];
  for (let r = 0; r < size; r += 1) grid.push(new Array(size).fill(value));
  return grid;
}

/**
 * Draws everything that is not payload: the three finders with their
 * separators, the two timing lines, the alignment patterns, and the reserved
 * strips where format and version information will go. `reserved` marks every
 * module the payload must skip.
 */
function drawFunctionPatterns(modules, reserved, version) {
  const size = modules.length;

  const set = (row, col, dark) => {
    if (row < 0 || col < 0 || row >= size || col >= size) return;
    modules[row][col] = dark;
    reserved[row][col] = true;
  };

  // Finder plus separator: a 9x9 field around each centre, dark where the
  // Chebyshev distance from the centre is 0, 1 or 3.
  const finder = (row, col) => {
    for (let dr = -4; dr <= 4; dr += 1) {
      for (let dc = -4; dc <= 4; dc += 1) {
        const dist = Math.max(Math.abs(dr), Math.abs(dc));
        set(row + dr, col + dc, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(3, size - 4);
  finder(size - 4, 3);

  // Timing: the alternating line that tells a scanner the module pitch.
  for (let i = 8; i < size - 8; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Alignment: 5x5, dark except for the ring at distance one. The three
  // positions that would sit on a finder are left out.
  const centres = ALIGNMENT[version];
  for (let i = 0; i < centres.length; i += 1) {
    for (let j = 0; j < centres.length; j += 1) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === centres.length - 1) ||
        (i === centres.length - 1 && j === 0);
      if (corner) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          set(centres[i] + dr, centres[j] + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // The strips the format information occupies are reserved now and written
  // later, once the mask is known.
  for (let i = 0; i <= 8; i += 1) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  // The one module that is dark in every symbol.
  set(size - 8, 8, true);

  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      reserved[b][a] = true;
      reserved[a][b] = true;
    }
  }
}

/** The fifteen format bits: five payload bits, ten BCH bits, XOR 0x5412. */
export function formatBits(mask) {
  const data = (EC_LEVEL_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The eighteen version bits: six payload bits plus twelve BCH bits. */
export function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function drawFormatInfo(modules, mask) {
  const size = modules.length;
  const bits = formatBits(mask);
  const bit = (i) => ((bits >> i) & 1) === 1;

  // First copy: down the left of the top-left finder, then across.
  for (let i = 0; i <= 5; i += 1) modules[i][8] = bit(i);
  modules[7][8] = bit(6);
  modules[8][8] = bit(7);
  modules[8][7] = bit(8);
  for (let i = 9; i < 15; i += 1) modules[8][14 - i] = bit(i);

  // Second copy: along the bottom of the top-right finder and up from the
  // bottom-left one, so a damaged corner cannot take the format with it.
  for (let i = 0; i < 8; i += 1) modules[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i += 1) modules[size - 15 + i][8] = bit(i);
  modules[size - 8][8] = true;
}

function drawVersionInfo(modules, version) {
  if (version < 7) return;
  const size = modules.length;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[b][a] = dark;
    modules[a][b] = dark;
  }
}

/**
 * Places the codeword bits in the two-module-wide zigzag that starts at the
 * bottom right, skipping the vertical timing column and every reserved module.
 * Modules left over at the end stay light - those are the remainder bits.
 */
function drawCodewords(modules, reserved, codewords) {
  const size = modules.length;
  let bitIndex = 0;
  const total = codewords.length * 8;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (reserved[row][col]) continue;
        if (bitIndex < total) {
          modules[row][col] = ((codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex += 1;
        }
      }
    }
  }
}

// ------------------------------------------------------------------- masking

/** The eight mask conditions. True means the module is flipped. */
export function maskCondition(mask, row, col) {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

/** Rule 3 looks for these two sequences in every row and every column. */
const FINDER_LIKE = [
  [true, false, true, true, true, false, true, false, false, false, false],
  [false, false, false, false, true, false, true, true, true, false, true],
];

function runPenalty(run) {
  if (run < 5) return 0;
  return N1 + (run - 5);
}

/** The four penalty rules of the standard, summed. Lower is better. */
export function penalty(modules) {
  const size = modules.length;
  let score = 0;

  // Rule 1: runs of five or more modules of one colour, in both directions.
  for (let i = 0; i < size; i += 1) {
    let rowColour = modules[i][0];
    let rowRun = 1;
    let colColour = modules[0][i];
    let colRun = 1;
    for (let j = 1; j < size; j += 1) {
      if (modules[i][j] === rowColour) rowRun += 1;
      else {
        score += runPenalty(rowRun);
        rowColour = modules[i][j];
        rowRun = 1;
      }
      if (modules[j][i] === colColour) colRun += 1;
      else {
        score += runPenalty(colRun);
        colColour = modules[j][i];
        colRun = 1;
      }
    }
    score += runPenalty(rowRun);
    score += runPenalty(colRun);
  }

  // Rule 2: every 2x2 block of one colour.
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        score += N2;
      }
    }
  }

  // Rule 3: anything that could be mistaken for a finder pattern.
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j + 11 <= size; j += 1) {
      for (const pattern of FINDER_LIKE) {
        let rowHit = true;
        let colHit = true;
        for (let k = 0; k < 11; k += 1) {
          if (modules[i][j + k] !== pattern[k]) rowHit = false;
          if (modules[j + k][i] !== pattern[k]) colHit = false;
        }
        if (rowHit) score += N3;
        if (colHit) score += N3;
      }
    }
  }

  // Rule 4: how far the share of dark modules sits from half.
  let dark = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) if (modules[r][c]) dark += 1;
  }
  const total = size * size;
  const deviation = Math.floor(Math.abs((dark * 100) / total - 50) / 5);
  score += deviation * N4;

  return score;
}

// --------------------------------------------------------------------- public

/**
 * Encode a string as a QR matrix.
 * @param {string} text
 * @returns {boolean[][]} rows of modules, true = dark
 */
export function qrMatrix(text) {
  const value = typeof text === "string" ? text : String(text === null || text === undefined ? "" : text);
  const bytes = utf8(value);
  const version = pickVersion(bytes.length);
  if (!version) throw new RangeError("qr: payload too long");

  const size = 17 + version * 4;
  const base = emptyGrid(size, false);
  const reserved = emptyGrid(size, false);
  drawFunctionPatterns(base, reserved, version);
  drawVersionInfo(base, version);
  drawCodewords(base, reserved, interleave(dataCodewords(bytes, version), version));

  // Every mask is built and scored; the lowest penalty wins, ties by index.
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = base.map((row) => row.slice());
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (!reserved[r][c] && maskCondition(mask, r, c)) candidate[r][c] = !candidate[r][c];
      }
    }
    drawFormatInfo(candidate, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/**
 * The matrix as one SVG path. Horizontal runs become single rectangles, so a
 * symbol is a few hundred path commands instead of a few hundred elements -
 * and it stays crisp at any size because every coordinate is an integer.
 * @param {boolean[][]} matrix
 * @param {number} [offset] quiet zone in modules
 * @returns {string}
 */
export function qrPath(matrix, offset = 0) {
  const parts = [];
  for (let r = 0; r < matrix.length; r += 1) {
    let c = 0;
    while (c < matrix.length) {
      if (!matrix[r][c]) {
        c += 1;
        continue;
      }
      let run = 1;
      while (c + run < matrix.length && matrix[r][c + run]) run += 1;
      parts.push(`M${c + offset} ${r + offset}h${run}v1h-${run}z`);
      c += run;
    }
  }
  return parts.join("");
}
