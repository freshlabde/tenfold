// prioritize.js - the duel machine that turns "these ten matter" into a
// strict order, one pairwise decision at a time.
//
// What it does: binary insertion sort driven by the user. Every state is a
// plain JSON-serialisable object, `choose` returns a NEW state and mutates
// nothing. Ten items need at most 25 comparisons instead of the 45 of a naive
// round robin.
//
// What it deliberately does NOT do: no randomness at all - the pair sequence
// must be reproducible for the tests and for a user who resumes a session - and
// no DOM, no storage, no timers, no clock.

function ceilLog2(n) {
  if (n <= 1) return 0;
  let bits = 0;
  let v = n - 1;
  while (v > 0) {
    bits += 1;
    v >>= 1;
  }
  return bits;
}

function normalizeItems(items) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  const seen = new Set();
  for (const it of list) {
    if (!it || typeof it.id !== "string" || !it.id) {
      throw new TypeError("startDuel: every item needs a non-empty string id");
    }
    if (seen.has(it.id)) throw new Error(`startDuel: duplicate id ${it.id}`);
    seen.add(it.id);
    // Duplicate titles are fine - the duel is keyed by id.
    out.push({ id: it.id, title: typeof it.title === "string" ? it.title : "" });
  }
  return out;
}

/**
 * Take the next item from the queue and open a fresh binary search window, or
 * finish. Also closes the current insertion when its window collapsed.
 */
function advance(state) {
  let s = state;
  for (;;) {
    if (s.current !== null && s.lo === s.hi) {
      const order = [...s.order];
      order.splice(s.lo, 0, s.current);
      s = { ...s, order, current: null, lo: 0, hi: 0 };
      continue;
    }
    if (s.current === null && s.queue.length > 0) {
      const [next, ...rest] = s.queue;
      s = { ...s, current: next, queue: rest, lo: 0, hi: s.order.length };
      continue;
    }
    return s;
  }
}

/**
 * Start a duel over the given items. The first item seeds the sorted list, the
 * rest are inserted in the order they were handed in - deterministic by
 * construction.
 * @param {{id: string, title?: string}[]} items
 * @returns {Object} DuelState
 */
export function startDuel(items) {
  const list = normalizeItems(items);
  const state = {
    items: list,
    order: list.length ? [list[0].id] : [],
    queue: list.slice(1).map((i) => i.id),
    current: null,
    lo: 0,
    hi: 0,
    comparisons: 0,
    history: [],
  };
  return advance(state);
}

function itemOf(state, id) {
  for (const it of state.items) if (it.id === id) return it;
  return { id, title: "" };
}

/**
 * The pair the user has to decide right now, or null when the duel is done.
 * `a` is the already ranked incumbent, `b` the item being placed.
 */
export function currentPair(state) {
  if (!state || state.current === null || state.current === undefined) return null;
  const mid = (state.lo + state.hi) >> 1;
  return { a: itemOf(state, state.order[mid]), b: itemOf(state, state.current) };
}

/** True when no decision is left. */
export function isDone(state) {
  return currentPair(state) === null;
}

/**
 * Record a decision. Pure: returns a new state, the old one stays valid (which
 * makes undo a matter of keeping the previous object).
 */
export function choose(state, winnerId) {
  const pair = currentPair(state);
  if (!pair) throw new Error("choose: the duel is already finished");
  if (winnerId !== pair.a.id && winnerId !== pair.b.id) {
    throw new Error(`choose: ${String(winnerId)} is not part of the current pair`);
  }
  const mid = (state.lo + state.hi) >> 1;
  const next = {
    ...state,
    lo: winnerId === pair.a.id ? mid + 1 : state.lo,
    hi: winnerId === pair.a.id ? state.hi : mid,
    comparisons: state.comparisons + 1,
    history: [...state.history, { a: pair.a.id, b: pair.b.id, winner: winnerId }],
  };
  return advance(next);
}

/**
 * The ranking, best first. While the duel is running this is the best known
 * order: everything already placed, then the item under consideration, then
 * the untouched queue.
 */
export function result(state) {
  if (!state) return [];
  const tail = state.current === null || state.current === undefined ? [] : [state.current];
  return [...state.order, ...tail, ...state.queue];
}

/**
 * Honest estimate of the workload: comparisons made, and the total assuming
 * every remaining binary search runs into its worst case.
 * @returns {{done: number, estimatedTotal: number}}
 */
export function progress(state) {
  if (!state) return { done: 0, estimatedTotal: 0 };
  let remaining = 0;
  let size = state.order.length;
  if (state.current !== null && state.current !== undefined) {
    remaining += ceilLog2(state.hi - state.lo + 1);
    size += 1;
  }
  for (let i = 0; i < state.queue.length; i += 1) {
    remaining += ceilLog2(size + 1);
    size += 1;
  }
  return { done: state.comparisons, estimatedTotal: state.comparisons + remaining };
}
