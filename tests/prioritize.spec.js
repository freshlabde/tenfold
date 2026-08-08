// Playwright specs for web/js/prioritize.js - the duel machine.
// The "user" is a deterministic oracle: it knows a desired ranking and always
// picks the item that stands earlier in it. If the machine is correct, the
// result must reproduce that ranking exactly.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/fixture.html");
});

test("ten items are sorted correctly in at most 25 comparisons", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const p = await import("/web/js/prioritize.js");
    // Desired ranking, best first. The oracle answers by this list.
    const desired = ["g", "b", "j", "a", "e", "i", "c", "h", "d", "f"];
    // Input order is deliberately different from the desired one.
    const items = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id) => ({
      id,
      title: `item ${id}`,
    }));
    const rankOf = (id) => desired.indexOf(id);

    let state = p.startDuel(items);
    const firstProgress = p.progress(state);
    let guard = 0;
    const pairs = [];
    while (p.currentPair(state) && guard < 200) {
      const { a, b } = p.currentPair(state);
      pairs.push([a.id, b.id]);
      const winner = rankOf(a.id) < rankOf(b.id) ? a.id : b.id;
      const before = state;
      state = p.choose(state, winner);
      // purity: the previous state object is untouched
      if (before === state) throw new Error("choose returned the same object");
      if (before.comparisons + 1 !== state.comparisons) throw new Error("comparison counter broken");
      guard += 1;
    }
    const prog = p.progress(state);
    return {
      result: p.result(state),
      comparisons: state.comparisons,
      pairs: pairs.length,
      done: p.isDone(state),
      estimatedTotalAtStart: firstProgress.estimatedTotal,
      doneAtStart: firstProgress.done,
      finalProgress: prog,
      desired,
    };
  });
  expect(r.result).toEqual(r.desired);
  expect(r.done).toBe(true);
  expect(r.comparisons).toBeLessThanOrEqual(25);
  expect(r.comparisons).toBe(r.pairs);
  expect(r.doneAtStart).toBe(0);
  expect(r.estimatedTotalAtStart).toBe(25);
  expect(r.finalProgress.estimatedTotal).toBe(r.comparisons);
  // clearly better than the 45 comparisons of a naive all-pairs duel
  expect(r.comparisons).toBeLessThan(45);
});

test("the duel is reproducible - same input, same pair sequence", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const p = await import("/web/js/prioritize.js");
    const items = "abcdefghij".split("").map((id) => ({ id, title: id }));
    const run = () => {
      let s = p.startDuel(items);
      const seq = [];
      while (p.currentPair(s)) {
        const { a, b } = p.currentPair(s);
        seq.push(`${a.id}|${b.id}`);
        s = p.choose(s, a.id); // always prefer the incumbent
      }
      return { seq, result: p.result(s) };
    };
    const one = run();
    const two = run();
    return { equalSeq: one.seq.join(",") === two.seq.join(","), one: one.result, two: two.result };
  });
  expect(r.equalSeq).toBe(true);
  expect(r.one).toEqual(r.two);
});

test("prioritize.js uses neither Math.random nor the clock", async () => {
  const src = await readFile(new URL("../web/js/prioritize.js", import.meta.url), "utf8");
  expect(src).not.toContain("Math.random");
  expect(src).not.toContain("Date.now");
});

test("edge cases: zero, one and two items", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const p = await import("/web/js/prioritize.js");
    const zero = p.startDuel([]);
    const one = p.startDuel([{ id: "solo", title: "Solo" }]);
    let two = p.startDuel([{ id: "x", title: "X" }, { id: "y", title: "Y" }]);
    const pair = p.currentPair(two);
    const twoProgress = p.progress(two);
    two = p.choose(two, "y");

    let threw = "";
    try {
      p.choose(two, "x");
    } catch (e) {
      threw = String(e.message);
    }
    let badWinner = "";
    const fresh = p.startDuel([{ id: "x" }, { id: "y" }]);
    try {
      p.choose(fresh, "nope");
    } catch (e) {
      badWinner = String(e.message);
    }
    let dupes = "";
    try {
      p.startDuel([{ id: "x" }, { id: "x" }]);
    } catch (e) {
      dupes = String(e.message);
    }
    return {
      zero: { pair: p.currentPair(zero), result: p.result(zero), progress: p.progress(zero) },
      one: { pair: p.currentPair(one), result: p.result(one), progress: p.progress(one) },
      twoPair: { a: pair.a.id, b: pair.b.id },
      twoProgress,
      twoResult: p.result(two),
      twoDone: p.isDone(two),
      threw,
      badWinner,
      dupes,
    };
  });
  expect(r.zero.pair).toBeNull();
  expect(r.zero.result).toEqual([]);
  expect(r.zero.progress).toEqual({ done: 0, estimatedTotal: 0 });
  expect(r.one.pair).toBeNull();
  expect(r.one.result).toEqual(["solo"]);
  expect(r.one.progress).toEqual({ done: 0, estimatedTotal: 0 });
  expect(r.twoPair).toEqual({ a: "x", b: "y" });
  expect(r.twoProgress).toEqual({ done: 0, estimatedTotal: 1 });
  expect(r.twoResult).toEqual(["y", "x"]);
  expect(r.twoDone).toBe(true);
  expect(r.threw).toContain("finished");
  expect(r.badWinner).toContain("not part of the current pair");
  expect(r.dupes).toContain("duplicate id");
});

test("duplicate titles do not confuse the duel", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const p = await import("/web/js/prioritize.js");
    const items = [
      { id: "1", title: "Sport" },
      { id: "2", title: "Sport" },
      { id: "3", title: "Sport" },
    ];
    const desired = ["3", "1", "2"];
    let s = p.startDuel(items);
    while (p.currentPair(s)) {
      const { a, b } = p.currentPair(s);
      s = p.choose(s, desired.indexOf(a.id) < desired.indexOf(b.id) ? a.id : b.id);
    }
    return { result: p.result(s), comparisons: s.comparisons };
  });
  expect(r.result).toEqual(["3", "1", "2"]);
  expect(r.comparisons).toBeLessThanOrEqual(3);
});

test("progress shrinks monotonically towards the real total", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const p = await import("/web/js/prioritize.js");
    const desired = "abcdefghij".split("");
    const items = ["j", "i", "h", "g", "f", "e", "d", "c", "b", "a"].map((id) => ({ id, title: id }));
    let s = p.startDuel(items);
    const totals = [p.progress(s).estimatedTotal];
    const dones = [p.progress(s).done];
    while (p.currentPair(s)) {
      const { a, b } = p.currentPair(s);
      s = p.choose(s, desired.indexOf(a.id) < desired.indexOf(b.id) ? a.id : b.id);
      totals.push(p.progress(s).estimatedTotal);
      dones.push(p.progress(s).done);
    }
    return { totals, dones, result: p.result(s), desired };
  });
  expect(r.result).toEqual(r.desired);
  // the estimate is an upper bound and never grows
  for (let i = 1; i < r.totals.length; i += 1) {
    expect(r.totals[i]).toBeLessThanOrEqual(r.totals[i - 1]);
    expect(r.dones[i]).toBe(r.dones[i - 1] + 1);
  }
  expect(r.totals[r.totals.length - 1]).toBe(r.dones[r.dones.length - 1]);
});
