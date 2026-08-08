// search.js - local full text search over title and note.
//
// What it does: folds accents and case away (NFD plus combining-mark strip),
// matches partial words, ranks title hits above note hits and word-start hits
// above hits in the middle of a word, and returns the ancestor path so a
// result is readable without opening the tree.
//
// What it deliberately does NOT do: no index is ever written to disk or to
// IndexedDB - an index of a zero knowledge app would be a plaintext leak. It
// scans the in-memory node list on every call. No DOM, no network, no HTML.

import { ancestorsOf } from "./model.js";

const PATH_SEPARATOR = " › ";

// Lowercase and strip combining marks, so "Übung", "übung" and "ubung" all
// meet. Transliteration ("ue" for "ü") is deliberately not done - it would
// create false hits across languages.
export function fold(text) {
  return String(text === null || text === undefined ? "" : text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isWordChar(ch) {
  return /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Score one term against one field.
 * 0 = no hit, higher = better. A hit at the start of a word beats a hit inside
 * a word; the caller weights title over note.
 */
function fieldHit(haystack, term) {
  const idx = haystack.indexOf(term);
  if (idx < 0) return 0;
  // Best hit wins: keep scanning for a word-start occurrence.
  let i = idx;
  let best = 1;
  while (i >= 0) {
    const atWordStart = i === 0 || !isWordChar(haystack[i - 1]);
    if (atWordStart) {
      best = i === 0 ? 3 : 2;
      if (best === 3) break;
    }
    i = haystack.indexOf(term, i + 1);
  }
  return best;
}

/**
 * Search living nodes. All terms of the query must be found (AND), each of
 * them in the title or in the note.
 * @param {Array} nodes
 * @param {string} query
 * @param {{limit?: number}} [opts]
 * @returns {{node: Object, path: string, matchField: string}[]}
 */
export function search(nodes, query, opts = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const limit = typeof opts.limit === "number" && opts.limit >= 0 ? opts.limit : 50;

  const scored = [];
  for (const node of list) {
    if (node.deletedAt) continue; // tombstones never surface
    const title = fold(node.title);
    const note = fold(node.note);
    let total = 0;
    let titleHits = 0;
    let ok = true;
    for (const term of terms) {
      const t = fieldHit(title, term);
      const n = fieldHit(note, term);
      if (!t && !n) {
        ok = false;
        break;
      }
      if (t) titleHits += 1;
      // Title weight 100, note weight 10; word-start bonus inside each field.
      total += t ? 100 * t : 10 * n;
    }
    if (!ok) continue;
    const matchField = titleHits > 0 ? "title" : "note";
    scored.push({ node, score: total, matchField });
  }

  scored.sort((x, y) => {
    if (x.score !== y.score) return y.score - x.score;
    const tx = fold(x.node.title);
    const ty = fold(y.node.title);
    if (tx !== ty) return tx < ty ? -1 : 1;
    return x.node.id < y.node.id ? -1 : x.node.id > y.node.id ? 1 : 0;
  });

  return scored.slice(0, limit).map((s) => ({
    node: s.node,
    path: ancestorsOf(list, s.node.id)
      .map((a) => a.title)
      .join(PATH_SEPARATOR),
    matchField: s.matchField,
  }));
}
