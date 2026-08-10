// model.js - pure tree functions over the node list of a tenfold document.
//
// What it does: create nodes and context entities, walk the tree,
// move/reorder/soft-delete nodes, derive the prioritisation score, build the
// short "today" list, upgrade a schema-1 document to schema 2 and merge two
// documents item by item. Every mutating function returns a NEW array and
// touches `updatedAt` only on items that actually changed.
//
// What it deliberately does NOT do: no IO, no DOM, no crypto, no network, no
// imports at all. It never removes an item physically - deletions are
// tombstones so a later merge still knows about them. Wall-clock time is only
// read through an injectable `opts.now`, so every result is reproducible.

/** Statuses that count as "still to be done". */
const OPEN_STATUSES = new Set(["open", "doing"]);

/** The document schema this module writes. */
export const SCHEMA = 2;

/** The four kinds a context card can have (contract, schema 2). */
export const ENTITY_KINDS = ["person", "place", "org", "topic"];

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

function str(v) {
  return typeof v === "string" ? v : "";
}

/** A list of unique, non-empty id strings - defensive against corrupt input. */
function idList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    if (typeof x === "string" && x && !out.includes(x)) out.push(x);
  }
  return out;
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
    story: str(partial.story),
    entityRefs: idList(partial.entityRefs),
    origin: partial.origin === "llm" ? "llm" : "manual",
    llmOptout: partial.llmOptout === true,
    createdAt: created,
    updatedAt: num(partial.updatedAt) ?? created,
    deletedAt: num(partial.deletedAt),
  };
}

/**
 * Build a fresh context entity - one card of the private index. Same rules as
 * createNode: every contract field carries a defined value.
 * @param {Object} [partial]
 * @returns {Object} Entity
 */
export function createEntity(partial = {}) {
  const created = num(partial.createdAt) ?? nowOf(partial);
  const aliases = [];
  if (Array.isArray(partial.aliases)) {
    for (const a of partial.aliases) {
      const value = str(a).trim();
      if (value && !aliases.includes(value)) aliases.push(value);
    }
  }
  return {
    id: typeof partial.id === "string" && partial.id ? partial.id : newId(),
    name: str(partial.name),
    aliases,
    kind: ENTITY_KINDS.includes(partial.kind) ? partial.kind : "person",
    relation: str(partial.relation),
    notes: str(partial.notes),
    sensitivity: partial.sensitivity === "high" ? "high" : "normal",
    createdAt: created,
    updatedAt: num(partial.updatedAt) ?? created,
    deletedAt: num(partial.deletedAt),
  };
}

/**
 * How much context a node already carries, 0..1. Presence only - length is
 * not quality, and a marker that rewards typing would be a nag.
 * @param {Object} node
 * @returns {number}
 */
export function storyDepth(node) {
  if (!node) return 0;
  let d = 0;
  if (str(node.story).trim()) d += 0.4;
  if (str(node.doneWhen).trim()) d += 0.2;
  if (idList(node.entityRefs).length) d += 0.2;
  if (str(node.note).trim()) d += 0.2;
  return Math.round(d * 100) / 100;
}

/** True when a node still carries the shape of schema 1. */
function nodeNeedsUpgrade(n) {
  return typeof n.story !== "string" || !Array.isArray(n.entityRefs);
}

/**
 * Bring a document up to the current schema, in memory only. Schema 1 knows
 * neither `story`/`entityRefs` on a node nor `entities` at all; both are
 * filled with empty defaults and nothing else is touched. Unknown fields
 * (something a newer version wrote) are preserved, so an upgrade on an old
 * device cannot silently delete what a new one added.
 *
 * Idempotent: a document that is already schema 2 comes back unchanged, by
 * reference, so callers can run this after every open without cost.
 * @param {Object} doc
 * @returns {Object} Doc
 */
export function upgradeDoc(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { schema: SCHEMA, nodes: [], entities: [], settings: {} };
  }
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const entities = Array.isArray(doc.entities) ? doc.entities : null;
  const settingsOk = doc.settings && typeof doc.settings === "object" && !Array.isArray(doc.settings);
  if (doc.schema === SCHEMA && entities && settingsOk && !nodes.some(nodeNeedsUpgrade)) return doc;

  const fill = (item, base) => {
    const out = { ...base };
    for (const [k, v] of Object.entries(item)) {
      if (v !== undefined && !(k in out)) out[k] = v;
    }
    return out;
  };

  return {
    ...doc,
    schema: SCHEMA,
    nodes: nodes.map((n) => (nodeNeedsUpgrade(n) ? fill(n, createNode(n)) : n)),
    entities: (entities || []).map((e) => fill(e, createEntity(e))),
    settings: settingsOk ? doc.settings : {},
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
 * Everything the today rule is allowed to consider: living, still-open, and a
 * LEAF - a node with living children is a goal, not a task. Its own function
 * because two callers depend on the same answer (the list and the app badge),
 * and two definitions of "still to be done" would drift apart within a week.
 */
function openLeaves(nodes) {
  return nodes.filter((n) => !n.deletedAt && OPEN_STATUSES.has(n.status) && isLeaf(nodes, n.id));
}

/**
 * How urgent a due date is on the day `now` falls in: 0 overdue, 1 due today,
 * 2 later or not dated at all. The single definition of "calls for today".
 */
function dueGroupOf(node, now) {
  const dayStart = startOfDay(now);
  if (node.due === null || node.due === undefined) return 2;
  if (node.due < dayStart) return 0;
  if (node.due < dayStart + DAY_MS) return 1;
  return 2;
}

/**
 * How many open leaves are overdue or due today - the two groups the today
 * list ranks first, counted WITHOUT its cap of seven. This is what the app
 * badge shows: a number, never a title, and derived from exactly the same rule
 * the screen uses, so the badge can never claim something the list denies.
 * `opts.now` is injectable, as everywhere else in this module.
 */
export function dueNowCount(nodes, opts = {}) {
  const now = nowOf(opts);
  let count = 0;
  for (const node of openLeaves(nodes)) if (dueGroupOf(node, now) <= 1) count += 1;
  return count;
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
  const limit = Math.max(0, Math.min(TODAY_LIMIT, opts.limit === undefined ? TODAY_LIMIT : opts.limit));

  const topThree = new Set(childrenOf(nodes, null).slice(0, 3).map((n) => n.id));
  const rootIdOf = (node) => {
    const chain = ancestorsOf(nodes, node.id);
    return chain.length ? chain[0].id : node.id;
  };

  const candidates = openLeaves(nodes);

  const dueGroup = (n) => dueGroupOf(n, now);

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
 * Merge one item that exists on both sides. When BOTH sides were edited after
 * creation and the texts differ, the loser's text is appended to the winner's
 * long text field instead of being dropped. Without vector clocks "edited
 * after creation" (`updatedAt > createdAt`) is the honest approximation of
 * "changed since the last common state": a pristine copy carries no divergent
 * intent.
 */
function mergeItem(x, y, fields, sink) {
  const [win, lose] = pickWinner(x, y);
  const bothEdited = x.updatedAt > x.createdAt && y.updatedAt > y.createdAt;
  const differs = fields.some((f) => str(win[f]) !== str(lose[f]));
  if (!bothEdited || !differs) return win;

  const parts = [];
  for (const f of fields) {
    if (str(lose[f]) !== str(win[f]) && str(lose[f])) parts.push(str(lose[f]));
  }
  if (!parts.length) return win;

  const block = `${CONFLICT_MARKER}\n${parts.join("\n")}`;
  const kept = str(win[sink]);
  if (kept.includes(block)) return win;
  // The winner's updatedAt is kept on purpose: merging must be repeatable and
  // must not make the merged copy look younger than any real edit.
  return { ...win, [sink]: kept ? `${kept}\n\n${block}` : block };
}

/** A node: title, note and story diverge into the note. */
function mergeNode(x, y) {
  return mergeItem(x, y, ["title", "note", "story"], "note");
}

/** The same rule for a context card; its long text field is `notes`. */
function mergeEntity(x, y) {
  return mergeItem(x, y, ["name", "relation", "notes"], "notes");
}

function newestUpdatedAt(doc) {
  let max = -Infinity;
  for (const n of doc.nodes || []) if (n.updatedAt > max) max = n.updatedAt;
  for (const e of doc.entities || []) if (e.updatedAt > max) max = e.updatedAt;
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

/** One id-keyed collection merged with `one`, sorted by id. */
function mergeList(listA, listB, one) {
  const mapA = new Map((listA || []).map((n) => [n.id, n]));
  const mapB = new Map((listB || []).map((n) => [n.id, n]));
  const ids = [...new Set([...mapA.keys(), ...mapB.keys()])].sort(cmpStr);
  return ids.map((id) => {
    const x = mapA.get(id);
    const y = mapB.get(id);
    if (x && !y) return x;
    if (y && !x) return y;
    return one(x, y);
  });
}

/**
 * Merge two documents item by item - nodes and context entities under exactly
 * the same rule. Same inputs always give the same output, and mergeDocs(a, b)
 * equals mergeDocs(b, a). Both arrays of the result are sorted by id so the
 * result is canonical; ordering inside the tree lives in `rank`, not in the
 * array order.
 */
export function mergeDocs(a, b) {
  const empty = { schema: SCHEMA, nodes: [], entities: [], settings: {} };
  const da = a && typeof a === "object" ? a : empty;
  const db = b && typeof b === "object" ? b : empty;
  return {
    schema: Math.max(da.schema || 1, db.schema || 1),
    nodes: mergeList(da.nodes, db.nodes, mergeNode),
    entities: mergeList(da.entities, db.entities, mergeEntity),
    settings: mergeSettings(da, db),
  };
}
