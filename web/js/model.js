// model.js - pure tree functions over the node list of a tenfold document.
//
// What it does: create nodes, walk the tree, move/reorder/soft-delete nodes,
// derive the prioritisation score, build the short "today" list and merge two
// documents node by node. Every mutating function returns a NEW array and
// touches `updatedAt` only on nodes that actually changed.
//
// What it deliberately does NOT do: no IO, no DOM, no crypto, no network, no
// imports at all. It never removes a node physically - deletions are
// tombstones so a later merge still knows about them. Wall-clock time is only
// read through an injectable `opts.now`, so every result is reproducible.

/** Statuses that count as "still to be done". */
const OPEN_STATUSES = new Set(["open", "doing"]);

/** Marker used by mergeDocs when it has to keep two divergent texts. */
export const CONFLICT_MARKER = "--- abweichende Fassung ---";

/** Maximum length of the today list (contract). */
const TODAY_LIMIT = 7;

const DAY_MS = 86400000;

function nowOf(opts) {
  return opts && typeof opts.now === "number" ? opts.now : Date.now();
}

function newId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for exotic environments; never used in a browser secure context.
  const b = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function byId(nodes, id) {
  for (const n of nodes) if (n.id === id) return n;
  return undefined;
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build a fresh node. Every field of the contract gets a defined value so no
 * consumer has to guard against `undefined`.
 * @param {Object} [partial]
 * @returns {Object} Node
 */
export function createNode(partial = {}) {
  const created = num(partial.createdAt) ?? nowOf(partial);
  return {
    id: typeof partial.id === "string" && partial.id ? partial.id : newId(),
    parentId: typeof partial.parentId === "string" ? partial.parentId : null,
    rank: num(partial.rank) ?? 0,
    title: typeof partial.title === "string" ? partial.title : "",
    note: typeof partial.note === "string" ? partial.note : "",
    status: OPEN_STATUSES.has(partial.status) || partial.status === "done" || partial.status === "parked"
      ? partial.status
      : "open",
    impact: num(partial.impact),
    confidence: num(partial.confidence),
    effort: num(partial.effort),
    due: num(partial.due),
    effortMinutes: num(partial.effortMinutes),
    doneWhen: typeof partial.doneWhen === "string" ? partial.doneWhen : "",
    origin: partial.origin === "llm" ? "llm" : "manual",
    llmOptout: partial.llmOptout === true,
    createdAt: created,
    updatedAt: num(partial.updatedAt) ?? created,
    deletedAt: num(partial.deletedAt),
  };
}

/**
 * Living children of a parent, ordered by rank (id as stable tiebreak).
 * Tombstones are never returned.
 */
export function childrenOf(nodes, parentId) {
  const pid = parentId === undefined ? null : parentId;
  return nodes
    .filter((n) => n.parentId === pid && !n.deletedAt)
    .sort((a, b) => a.rank - b.rank || cmpStr(a.id, b.id));
}

/**
 * Ancestor chain, root first, the node itself excluded.
 * Tombstoned ancestors ARE included: they are structural, and `isOptedOut`
 * must still see them. Guarded against corrupt cyclic parent links.
 */
export function ancestorsOf(nodes, id) {
  const out = [];
  const seen = new Set([id]);
  let cur = byId(nodes, id);
  while (cur && cur.parentId !== null && cur.parentId !== undefined) {
    if (seen.has(cur.parentId)) break;
    seen.add(cur.parentId);
    const parent = byId(nodes, cur.parentId);
    if (!parent) break;
    out.push(parent);
    cur = parent;
  }
  return out.reverse();
}

/**
 * All descendants of a node in breadth-first order, tombstones included
 * (softDelete and the cycle guard both need the complete subtree).
 */
export function descendantsOf(nodes, id) {
  const byParent = new Map();
  for (const n of nodes) {
    const key = n.parentId === undefined ? null : n.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(n);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.rank - b.rank || cmpStr(a.id, b.id));
  const out = [];
  const seen = new Set([id]);
  const queue = [...(byParent.get(id) || [])];
  while (queue.length) {
    const n = queue.shift();
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    for (const c of byParent.get(n.id) || []) queue.push(c);
  }
  return out;
}

/** A node is a leaf when it has no living children. */
export function isLeaf(nodes, id) {
  return childrenOf(nodes, id).length === 0;
}

function clampIndex(v, max) {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : max;
  if (n < 0) return 0;
  if (n > max) return max;
  return n;
}

/**
 * Move a node under a new parent at a new rank.
 * Throws on any cycle (onto itself or under one of its own descendants) and on
 * unknown ids. Both the old and the new sibling row are renumbered densely to
 * 0..n-1 so ranks stay consistent.
 */
export function moveNode(nodes, id, newParentId, newRank, opts = {}) {
  const now = nowOf(opts);
  const node = byId(nodes, id);
  if (!node) throw new Error(`moveNode: unknown node ${id}`);
  if (node.deletedAt) throw new Error(`moveNode: node ${id} is deleted`);
  const pid = newParentId === undefined ? null : newParentId;
  if (pid !== null) {
    if (pid === id) throw new Error("moveNode: cycle - a node cannot be its own parent");
    if (!byId(nodes, pid)) throw new Error(`moveNode: unknown parent ${pid}`);
    if (descendantsOf(nodes, id).some((d) => d.id === pid)) {
      throw new Error("moveNode: cycle - cannot move a node under its own descendant");
    }
  }

  const oldParentId = node.parentId === undefined ? null : node.parentId;
  const targetRow = childrenOf(nodes, pid).filter((n) => n.id !== id);
  targetRow.splice(clampIndex(newRank, targetRow.length), 0, node);

  const ranks = new Map();
  targetRow.forEach((n, i) => ranks.set(n.id, i));
  if (oldParentId !== pid) {
    childrenOf(nodes, oldParentId)
      .filter((n) => n.id !== id)
      .forEach((n, i) => ranks.set(n.id, i));
  }

  return nodes.map((n) => {
    const parentChanged = n.id === id && oldParentId !== pid;
    const rank = ranks.get(n.id);
    const rankChanged = rank !== undefined && n.rank !== rank;
    if (!parentChanged && !rankChanged) return n;
    return {
      ...n,
      parentId: parentChanged ? pid : n.parentId,
      rank: rank !== undefined ? rank : n.rank,
      updatedAt: now,
    };
  });
}

/**
 * Reorder the living children of `parentId`. Ids listed in `orderedIds` come
 * first in exactly that order, any child left out keeps its relative position
 * behind them. Throws when an id is not a living child of that parent.
 */
export function reorder(nodes, parentId, orderedIds, opts = {}) {
  const now = nowOf(opts);
  const pid = parentId === undefined ? null : parentId;
  const current = childrenOf(nodes, pid);
  const known = new Set(current.map((n) => n.id));
  const wanted = [];
  const seen = new Set();
  for (const id of orderedIds || []) {
    if (!known.has(id)) throw new Error(`reorder: ${id} is not a living child of ${String(pid)}`);
    if (seen.has(id)) throw new Error(`reorder: duplicate id ${id}`);
    seen.add(id);
    wanted.push(id);
  }
  const rest = current.filter((n) => !seen.has(n.id)).map((n) => n.id);
  const ranks = new Map();
  [...wanted, ...rest].forEach((id, i) => ranks.set(id, i));
  return nodes.map((n) => {
    const rank = ranks.get(n.id);
    if (rank === undefined || n.rank === rank) return n;
    return { ...n, rank, updatedAt: now };
  });
}

/**
 * Tombstone a node and its whole subtree. Nothing is physically removed - a
 * later merge has to be able to tell "deleted" from "never seen".
 * Already tombstoned nodes are left untouched (keeps updatedAt honest).
 */
export function softDelete(nodes, id, opts = {}) {
  const now = nowOf(opts);
  const node = byId(nodes, id);
  if (!node) throw new Error(`softDelete: unknown node ${id}`);
  const targets = new Set([id, ...descendantsOf(nodes, id).map((n) => n.id)]);
  return nodes.map((n) => {
    if (!targets.has(n.id) || n.deletedAt) return n;
    return { ...n, deletedAt: now, updatedAt: now };
  });
}

/** True when the node itself or any ancestor carries `llmOptout`. */
export function isOptedOut(nodes, id) {
  const node = byId(nodes, id);
  if (!node) return false;
  if (node.llmOptout === true) return true;
  return ancestorsOf(nodes, id).some((a) => a.llmOptout === true);
}

/**
 * impact * confidence / effort. null when any of the three is missing or when
 * effort is 0 (division by zero is not a ranking).
 */
export function score(node) {
  if (!node) return null;
  const i = num(node.impact);
  const c = num(node.confidence);
  const e = num(node.effort);
  if (i === null || c === null || e === null || e === 0) return null;
  return (i * c) / e;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The short list of things to actually do now. Rules:
 *  - only living, still-open nodes (status open or doing)
 *  - only LEAVES: a node with living children is a goal, not a task
 *  - order: overdue first, then due today, then belonging to one of the top
 *    three root nodes (by rank), then score descending
 *  - at most 7 entries
 * `opts.now` is injectable; the function never reads the clock on its own when
 * a value is given.
 */
export function todayList(nodes, opts = {}) {
  const now = nowOf(opts);
  const dayStart = startOfDay(now);
  const dayEnd = dayStart + DAY_MS;
  const limit = Math.max(0, Math.min(TODAY_LIMIT, opts.limit === undefined ? TODAY_LIMIT : opts.limit));

  const topThree = new Set(childrenOf(nodes, null).slice(0, 3).map((n) => n.id));
  const rootIdOf = (node) => {
    const chain = ancestorsOf(nodes, node.id);
    return chain.length ? chain[0].id : node.id;
  };

  const candidates = nodes.filter(
    (n) => !n.deletedAt && OPEN_STATUSES.has(n.status) && isLeaf(nodes, n.id),
  );

  const dueGroup = (n) => {
    if (n.due === null || n.due === undefined) return 2;
    if (n.due < dayStart) return 0;
    if (n.due < dayEnd) return 1;
    return 2;
  };

  const decorated = candidates.map((n) => ({
    n,
    group: dueGroup(n),
    top: topThree.has(rootIdOf(n)) ? 0 : 1,
    sc: score(n),
  }));

  decorated.sort((x, y) => {
    if (x.group !== y.group) return x.group - y.group;
    if (x.top !== y.top) return x.top - y.top;
    const sx = x.sc === null ? -Infinity : x.sc;
    const sy = y.sc === null ? -Infinity : y.sc;
    if (sx !== sy) return sy - sx;
    const dx = x.n.due === null || x.n.due === undefined ? Infinity : x.n.due;
    const dy = y.n.due === null || y.n.due === undefined ? Infinity : y.n.due;
    if (dx !== dy) return dx - dy;
    if (x.n.createdAt !== y.n.createdAt) return x.n.createdAt - y.n.createdAt;
    return cmpStr(x.n.id, y.n.id);
  });

  return decorated.slice(0, limit).map((d) => d.n);
}

// --- merge ------------------------------------------------------------------

function canonical(node) {
  const keys = Object.keys(node).sort();
  const obj = {};
  for (const k of keys) obj[k] = node[k];
  return JSON.stringify(obj);
}

/**
 * Pick the surviving version of one node. Deterministic and independent of the
 * argument order:
 *  1. younger `updatedAt` wins (so a tombstone never beats a younger real edit)
 *  2. on an exact tie a tombstone wins over a living version (a delete that
 *     happened at the same millisecond is the more conservative outcome)
 *  3. still tied: the canonical JSON string decides, which only depends on the
 *     two values, not on which side was passed first
 */
function pickWinner(x, y) {
  if (x.updatedAt > y.updatedAt) return [x, y];
  if (y.updatedAt > x.updatedAt) return [y, x];
  const xd = !!x.deletedAt;
  const yd = !!y.deletedAt;
  if (xd !== yd) return xd ? [x, y] : [y, x];
  return canonical(x) <= canonical(y) ? [x, y] : [y, x];
}

/**
 * Merge one node that exists on both sides. When BOTH sides were edited after
 * creation and the texts differ, the loser's text is appended to the winner's
 * note instead of being dropped. Without vector clocks "edited after creation"
 * (`updatedAt > createdAt`) is the honest approximation of "changed since the
 * last common state": a pristine copy carries no divergent intent.
 */
function mergeNode(x, y) {
  const [win, lose] = pickWinner(x, y);
  const bothEdited = x.updatedAt > x.createdAt && y.updatedAt > y.createdAt;
  const textDiffers = win.title !== lose.title || win.note !== lose.note;
  if (!bothEdited || !textDiffers) return win;

  const parts = [];
  if (lose.title !== win.title && lose.title) parts.push(lose.title);
  if (lose.note !== win.note && lose.note) parts.push(lose.note);
  if (!parts.length) return win;

  const block = `${CONFLICT_MARKER}\n${parts.join("\n")}`;
  if (win.note.includes(block)) return win;
  // The winner's updatedAt is kept on purpose: merging must be repeatable and
  // must not make the merged copy look younger than any real edit.
  return { ...win, note: win.note ? `${win.note}\n\n${block}` : block };
}

function newestUpdatedAt(doc) {
  let max = -Infinity;
  for (const n of doc.nodes || []) if (n.updatedAt > max) max = n.updatedAt;
  return max;
}

function mergeSettings(a, b) {
  const sa = a.settings && typeof a.settings === "object" ? a.settings : {};
  const sb = b.settings && typeof b.settings === "object" ? b.settings : {};
  const out = {};
  const keys = [...new Set([...Object.keys(sa), ...Object.keys(sb)])].sort();
  const aNewer = newestUpdatedAt(a) > newestUpdatedAt(b);
  const tie = newestUpdatedAt(a) === newestUpdatedAt(b);
  for (const k of keys) {
    const inA = Object.prototype.hasOwnProperty.call(sa, k);
    const inB = Object.prototype.hasOwnProperty.call(sb, k);
    if (inA && !inB) out[k] = sa[k];
    else if (inB && !inA) out[k] = sb[k];
    else if (JSON.stringify(sa[k]) === JSON.stringify(sb[k])) out[k] = sa[k];
    else if (tie) out[k] = JSON.stringify(sa[k]) <= JSON.stringify(sb[k]) ? sa[k] : sb[k];
    else out[k] = aNewer ? sa[k] : sb[k];
  }
  return out;
}

/**
 * Merge two documents node by node. Same inputs always give the same output,
 * and mergeDocs(a, b) equals mergeDocs(b, a). The node array of the result is
 * sorted by id so the result is canonical; ordering inside the tree lives in
 * `rank`, not in the array order.
 */
export function mergeDocs(a, b) {
  const da = a && typeof a === "object" ? a : { schema: 1, nodes: [], settings: {} };
  const db = b && typeof b === "object" ? b : { schema: 1, nodes: [], settings: {} };
  const mapA = new Map((da.nodes || []).map((n) => [n.id, n]));
  const mapB = new Map((db.nodes || []).map((n) => [n.id, n]));
  const ids = [...new Set([...mapA.keys(), ...mapB.keys()])].sort(cmpStr);
  const nodes = ids.map((id) => {
    const x = mapA.get(id);
    const y = mapB.get(id);
    if (x && !y) return x;
    if (y && !x) return y;
    return mergeNode(x, y);
  });
  return {
    schema: Math.max(da.schema || 1, db.schema || 1),
    nodes,
    settings: mergeSettings(da, db),
  };
}
