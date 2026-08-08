// search.js - local full text search over title, story, note and the cards of
// the context index.
//
// What it does: folds accents and case away (NFD plus combining-mark strip),
// matches partial words, ranks title hits above story and note hits and
// word-start hits above hits in the middle of a word, and returns the ancestor
// path so a result is readable without opening the tree.
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
 * Score one item over a list of weighted fields. All terms must be found (AND),
 * each of them in one of the fields.
 * @param {{name: string, text: string, weight: number}[]} fields best first
 * @returns {{score: number, matchField: string}|null}
 */
function scoreFields(fields, terms) {
  let total = 0;
  let best = null;
  for (const term of terms) {
    let hitHere = 0;
    let hitField = null;
    for (const f of fields) {
      const h = fieldHit(f.text, term);
      if (!h) continue;
      const value = f.weight * h;
      if (value > hitHere) {
        hitHere = value;
        hitField = f.name;
      }
    }
    if (!hitHere) return null;
    total += hitHere;
    // The label follows the strongest field the query touched anywhere.
    if (!best || fields.findIndex((f) => f.name === hitField) < fields.findIndex((f) => f.name === best)) {
      best = hitField;
    }
  }
  return { score: total, matchField: best };
}

/**
 * Search living nodes, and - when they are passed in - the living cards of the
 * context index. All terms of the query must be found (AND).
 * @param {Array} nodes
 * @param {string} query
 * @param {{limit?: number, entities?: Array}} [opts]
 * @returns {{node?: Object, entity?: Object, path: string, matchField: string}[]}
 */
export function search(nodes, query, opts = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const cards = Array.isArray(opts.entities) ? opts.entities : [];
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const limit = typeof opts.limit === "number" && opts.limit >= 0 ? opts.limit : 50;

  const scored = [];
  for (const node of list) {
    if (node.deletedAt) continue; // tombstones never surface
    const hit = scoreFields(
      [
        { name: "title", text: fold(node.title), weight: 100 },
        { name: "story", text: fold(node.story), weight: 20 },
        { name: "note", text: fold(node.note), weight: 10 },
      ],
      terms,
    );
    if (hit) scored.push({ node, sort: fold(node.title), ...hit });
  }
  for (const card of cards) {
    if (!card || card.deletedAt) continue;
    const hit = scoreFields(
      [
        { name: "entity", text: fold(card.name), weight: 100 },
        { name: "entityAlias", text: fold((card.aliases || []).join(" ")), weight: 60 },
        { name: "entityRelation", text: fold(card.relation), weight: 20 },
        { name: "entityNotes", text: fold(card.notes), weight: 10 },
      ],
      terms,
    );
    if (hit) scored.push({ entity: card, sort: fold(card.name), ...hit });
  }

  scored.sort((x, y) => {
    if (x.score !== y.score) return y.score - x.score;
    if (x.sort !== y.sort) return x.sort < y.sort ? -1 : 1;
    const ix = x.node ? x.node.id : x.entity.id;
    const iy = y.node ? y.node.id : y.entity.id;
    return ix < iy ? -1 : ix > iy ? 1 : 0;
  });

  return scored.slice(0, limit).map((s) =>
    s.node
      ? {
          node: s.node,
          path: ancestorsOf(list, s.node.id)
            .map((a) => a.title)
            .join(PATH_SEPARATOR),
          matchField: s.matchField,
        }
      : { entity: s.entity, path: "", matchField: s.matchField },
  );
}
