// questions.js - the daily question, decided by the calendar and by the list.
//
// What it does: holds a fixed catalogue of calm coaching questions (i18n keys
// only - no text lives here) and picks exactly one of them per day, together
// with the goal it is asked about. The goal is the open node that carries the
// least context so far; the question is derived from the date and that node's
// id. Same day, same list, same question - on every device, without any state
// being stored for it.
//
// What it deliberately does NOT do: no randomness, no clock of its own
// (`opts.now` is injectable), no LLM, no network, no DOM, no storage. It does
// not rank, nag or score - it asks one question and is done.

import { ancestorsOf, childrenOf, storyDepth } from "./model.js";

/** Statuses that still count as "in front of you". */
const OPEN_STATUSES = new Set(["open", "doing"]);

/**
 * The catalogue. `key` is the question as it is asked, `label` the short tag
 * the answer is filed under in the node's story - the same labelled-line style
 * the story guide uses, so a story stays readable however it was written.
 */
export const QUESTIONS = [
  { key: "question.q1", label: "question.l1" },
  { key: "question.q2", label: "question.l2" },
  { key: "question.q3", label: "question.l3" },
  { key: "question.q4", label: "question.l4" },
  { key: "question.q5", label: "question.l5" },
  { key: "question.q6", label: "question.l6" },
  { key: "question.q7", label: "question.l7" },
  { key: "question.q8", label: "question.l8" },
  { key: "question.q9", label: "question.l9" },
  { key: "question.q10", label: "question.l10" },
  { key: "question.q11", label: "question.l11" },
  { key: "question.q12", label: "question.l12" },
  { key: "question.q13", label: "question.l13" },
  { key: "question.q14", label: "question.l14" },
  { key: "question.q15", label: "question.l15" },
  { key: "question.q16", label: "question.l16" },
];

function nowOf(opts) {
  return opts && typeof opts.now === "number" ? opts.now : Date.now();
}

/**
 * The local calendar day as YYYYMMDD. Local, not UTC: "today" is the day the
 * person is living in, not the one the server is in.
 * @param {number} [now]
 * @returns {string}
 */
export function dayKey(now) {
  const d = new Date(typeof now === "number" ? now : Date.now());
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** FNV-1a, 32 bit. Small, stable across engines, and not a security primitive. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Which question belongs to one day and one node. Deterministic: the same pair
 * always gives the same entry of the catalogue, and no state is written.
 * @param {string} day YYYYMMDD
 * @param {string} nodeId
 * @returns {{key: string, label: string, index: number}}
 */
export function questionFor(day, nodeId) {
  const index = hash(`${day}:${nodeId}`) % QUESTIONS.length;
  return { ...QUESTIONS[index], index };
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The open node whose story is thinnest. Ties are broken by the rank of the
 * root the node belongs to (place one first), then by the node's own rank, its
 * age and finally its id - so the answer never depends on array order.
 * @param {Array} nodes
 * @returns {Object|null}
 */
export function thinnestNode(nodes) {
  const roots = childrenOf(nodes, null);
  const rootIndex = new Map(roots.map((n, i) => [n.id, i]));
  const rootRank = (node) => {
    const chain = ancestorsOf(nodes, node.id);
    const rootId = chain.length ? chain[0].id : node.id;
    const i = rootIndex.get(rootId);
    return i === undefined ? roots.length : i;
  };

  const open = nodes.filter((n) => !n.deletedAt && OPEN_STATUSES.has(n.status));
  if (!open.length) return null;

  const decorated = open.map((n) => ({ n, depth: storyDepth(n), root: rootRank(n) }));
  decorated.sort((x, y) => {
    if (x.depth !== y.depth) return x.depth - y.depth;
    if (x.root !== y.root) return x.root - y.root;
    if (x.n.rank !== y.n.rank) return x.n.rank - y.n.rank;
    if (x.n.createdAt !== y.n.createdAt) return x.n.createdAt - y.n.createdAt;
    return cmpStr(x.n.id, y.n.id);
  });
  return decorated[0].n;
}

/**
 * The whole daily question, or null when there is nothing to ask about (empty
 * list) or the question was already put away for today.
 * @param {Array} nodes
 * @param {{now?: number, dismissed?: string}} [opts]
 * @returns {{day: string, node: Object, key: string, label: string}|null}
 */
export function dailyQuestion(nodes, opts = {}) {
  const day = dayKey(nowOf(opts));
  if (typeof opts.dismissed === "string" && opts.dismissed === day) return null;
  const node = thinnestNode(nodes || []);
  if (!node) return null;
  return { day, node, ...questionFor(day, node.id) };
}
