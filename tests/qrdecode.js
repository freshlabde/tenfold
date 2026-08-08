// tests/qrdecode.js - an independent QR reader, for the encoder's proof.
//
// This file exists so web/js/qr.js can be checked against something that is
// not itself. It is written from the standard, not from the encoder: it walks
// the geometry the other way round (it derives the reserved map from the
// pattern positions instead of from the drawing routine), it reads the format
// information out of the symbol and looks it up in the published table of
// format strings, and it proves the parity by evaluating the codeword
// polynomial at the roots of the generator - the definition of a Reed-Solomon
// codeword - rather than by re-running a division.
//
// It is a test helper. Nothing under web/ imports it, and it ships with
// nothing.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Level M block layout, from the standard's tables. */
const EC_TABLE = {
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

const ALIGNMENT = {
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

/**
 * The 15-bit format strings for level M, masks 0 to 7, as published in the
 * standard. Reading one of these out of a symbol proves the BCH code and the
 * 0x5412 mask without sharing a line of code with the encoder.
 */
export const FORMAT_M = [
  "101010000010010",
  "101000100100101",
  "101111001111100",
  "101101101001011",
  "100010111111001",
  "100000011001110",
  "100111110010111",
  "100101010100000",
];

/** The published version information strings for the versions that carry one. */
export const VERSION_STRINGS = {
  7: "000111110010010100",
  8: "001000010110111100",
  9: "001001101010011001",
  10: "001010010011010011",
};

/** Every module the payload may not occupy, derived from the geometry. */
export function reservedMap(size, version) {
  const grid = [];
  for (let r = 0; r < size; r += 1) grid.push(new Array(size).fill(false));
  const mark = (r, c) => {
    if (r >= 0 && c >= 0 && r < size && c < size) grid[r][c] = true;
  };
  const block = (r0, c0, h, w) => {
    for (let r = r0; r < r0 + h; r += 1) for (let c = c0; c < c0 + w; c += 1) mark(r, c);
  };
  block(0, 0, 8, 8);
  block(0, size - 8, 8, 8);
  block(size - 8, 0, 8, 8);
  for (let i = 0; i < size; i += 1) {
    mark(6, i);
    mark(i, 6);
  }
  for (let i = 0; i < 9; i += 1) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i += 1) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }
  const centres = ALIGNMENT[version];
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

export function maskAt(mask, r, c) {
  if (mask === 0) return (r + c) % 2 === 0;
  if (mask === 1) return r % 2 === 0;
  if (mask === 2) return c % 3 === 0;
  if (mask === 3) return (r + c) % 3 === 0;
  if (mask === 4) return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
  if (mask === 5) return ((r * c) % 2) + ((r * c) % 3) === 0;
  if (mask === 6) return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
  return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
}

/** Both copies of the format information, MSB first, plus the mask they name. */
export function readFormat(matrix) {
  const size = matrix.length;
  const first = [];
  for (let i = 14; i >= 9; i -= 1) first.push(matrix[8][14 - i]);
  first.push(matrix[8][7]);
  first.push(matrix[8][8]);
  first.push(matrix[7][8]);
  for (let i = 5; i >= 0; i -= 1) first.push(matrix[i][8]);

  const second = [];
  for (let i = 14; i >= 8; i -= 1) second.push(matrix[size - 15 + i][8]);
  for (let i = 7; i >= 0; i -= 1) second.push(matrix[8][size - 1 - i]);

  const bits = (list) => list.map((b) => (b ? "1" : "0")).join("");
  const firstStr = bits(first);
  return { first: firstStr, second: bits(second), mask: FORMAT_M.indexOf(firstStr) };
}

/** The version information block, MSB first, or "" below version 7. */
export function readVersionInfo(matrix) {
  const size = matrix.length;
  const version = (size - 17) / 4;
  if (version < 7) return "";
  const bits = [];
  for (let i = 17; i >= 0; i -= 1) bits.push(matrix[Math.floor(i / 3)][size - 11 + (i % 3)]);
  return bits.map((b) => (b ? "1" : "0")).join("");
}

/** The unmasked codeword stream, read in the zigzag the standard prescribes. */
export function readCodewords(matrix, version, mask) {
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
        bits.push(matrix[row][col] !== maskAt(mask, row, col) ? 1 : 0);
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

/** Undo the block interleaving. */
export function deinterleave(stream, version) {
  const spec = EC_TABLE[version];
  const sizes = [];
  for (const [count, size] of spec.groups) for (let i = 0; i < count; i += 1) sizes.push(size);
  const blocks = sizes.map(() => []);
  const ecs = sizes.map(() => []);
  const longest = Math.max(...sizes);
  let p = 0;
  for (let i = 0; i < longest; i += 1) {
    for (let b = 0; b < sizes.length; b += 1) if (i < sizes[b]) blocks[b].push(stream[p++]);
  }
  for (let i = 0; i < spec.ec; i += 1) {
    for (let b = 0; b < sizes.length; b += 1) ecs[b].push(stream[p++]);
  }
  return { blocks, ecs, ec: spec.ec, consumed: p, length: stream.length };
}

/**
 * The syndromes of a codeword: the codeword polynomial evaluated at a^0 .. a^n-1.
 * A correct Reed-Solomon codeword is divisible by the generator, so all of
 * them are zero. This checks the parity against the DEFINITION of the code,
 * not against a remembered table of generator coefficients.
 */
export function syndromes(codeword, ecCount) {
  const out = [];
  for (let i = 0; i < ecCount; i += 1) {
    let acc = 0;
    for (const byte of codeword) acc = mul(acc, EXP[i]) ^ byte;
    out.push(acc);
  }
  return out;
}

/** Mode, length and payload out of the joined data codewords. */
export function parseData(dataBytes, version) {
  let pos = 0;
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i += 1) {
      v = (v << 1) | ((dataBytes[pos >> 3] >> (7 - (pos & 7))) & 1);
      pos += 1;
    }
    return v;
  };
  const mode = take(4);
  const len = take(version < 10 ? 8 : 16);
  const out = [];
  for (let i = 0; i < len; i += 1) out.push(take(8));
  return { mode, len, text: new TextDecoder().decode(Uint8Array.from(out)) };
}

/**
 * Rebuild the same symbol under a different mask: undo `fromMask`, apply
 * `toMask`, and write the published format string for the new mask into both
 * of its copies. Used to check that the encoder really picked the mask with
 * the lowest penalty.
 */
export function withMask(matrix, fromMask, toMask, version) {
  const size = matrix.length;
  const reserved = reservedMap(size, version);
  const out = matrix.map((row) => row.slice());
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (reserved[r][c]) continue;
      if (maskAt(fromMask, r, c)) out[r][c] = !out[r][c];
      if (maskAt(toMask, r, c)) out[r][c] = !out[r][c];
    }
  }
  const bits = FORMAT_M[toMask].split("").map((ch) => ch === "1");
  const bit = (i) => bits[14 - i];
  for (let i = 0; i <= 5; i += 1) out[i][8] = bit(i);
  out[7][8] = bit(6);
  out[8][8] = bit(7);
  out[8][7] = bit(8);
  for (let i = 9; i < 15; i += 1) out[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i += 1) out[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i += 1) out[size - 15 + i][8] = bit(i);
  return out;
}

/**
 * The four penalty rules, written out plainly. Same rules as the encoder's,
 * a separate implementation - so a transcription slip in either one shows up
 * as a different chosen mask.
 */
export function penaltyScore(matrix) {
  const size = matrix.length;
  const at = (r, c) => matrix[r][c];
  let score = 0;

  const line = (get) => {
    let run = 1;
    for (let i = 1; i < size; i += 1) {
      if (get(i) === get(i - 1)) run += 1;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  };
  for (let i = 0; i < size; i += 1) {
    line((j) => at(i, j));
    line((j) => at(j, i));
  }

  for (let r = 0; r + 1 < size; r += 1) {
    for (let c = 0; c + 1 < size; c += 1) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  const shapes = ["10111010000", "00001011101"];
  const readRow = (r, c) => {
    let s = "";
    for (let k = 0; k < 11; k += 1) s += at(r, c + k) ? "1" : "0";
    return s;
  };
  const readCol = (r, c) => {
    let s = "";
    for (let k = 0; k < 11; k += 1) s += at(r + k, c) ? "1" : "0";
    return s;
  };
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j + 11 <= size; j += 1) {
      if (shapes.includes(readRow(i, j))) score += 40;
      if (shapes.includes(readCol(j, i))) score += 40;
    }
  }

  let dark = 0;
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) if (at(r, c)) dark += 1;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/** The whole read: geometry, format, unmasking, parity check, payload. */
export function decode(matrix) {
  const size = matrix.length;
  const version = (size - 17) / 4;
  const format = readFormat(matrix);
  if (format.mask < 0) throw new Error("format information is not a level M string");
  const stream = readCodewords(matrix, version, format.mask);
  const { blocks, ecs, ec, consumed, length } = deinterleave(stream, version);
  const badBlocks = [];
  const data = [];
  for (let i = 0; i < blocks.length; i += 1) {
    if (syndromes([...blocks[i], ...ecs[i]], ec).some((v) => v !== 0)) badBlocks.push(i);
    data.push(...blocks[i]);
  }
  return {
    version,
    size,
    format,
    versionInfo: readVersionInfo(matrix),
    badBlocks,
    data,
    streamLength: length,
    consumed,
    ...parseData(data, version),
  };
}
