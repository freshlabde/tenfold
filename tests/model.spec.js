// Playwright specs for web/js/model.js (plus the pure parts of search.js and
// portability.js). Everything runs in a real Chromium page so the modules are
// exercised as ES modules, exactly as the app loads them.
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/fixture.html");
});

// Every spec builds its nodes with fixed timestamps (`mk`) so no assertion
// depends on the wall clock.

test("createNode fills every contract field with a defined value", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import("/web/js/model.js");
    const n = m.createNode({ title: "Ziel", createdAt: 1000 });
    return { node: n, keys: Object.keys(n).sort() };
  });
  expect(r.keys).toEqual([
    "confidence", "createdAt", "deletedAt", "doneWhen", "due", "effort",
    "effortMinutes", "id", "impact", "llmOptout", "note", "origin",
    "parentId", "rank", "status", "title", "updatedAt",
  ]);
  expect(r.node.parentId).toBeNull();
  expect(r.node.status).toBe("open");
  expect(r.node.deletedAt).toBeNull();
  expect(r.node.createdAt).toBe(1000);
  expect(r.node.updatedAt).toBe(1000);
  expect(typeof r.node.id).toBe("string");
  expect(r.node.id.length).toBeGreaterThan(10);
});

test("childrenOf sorts by rank and hides tombstones", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import("/web/js/model.js");
    const T0 = 1700000000000;
    const mk = (p) => m.createNode({ createdAt: T0, updatedAt: T0, ...p });
    const nodes = [
      mk({ id: "c", parentId: "root", rank: 2, title: "C" }),
      mk({ id: "a", parentId: "root", rank: 0, title: "A" }),
      mk({ id: "b", parentId: "root", rank: 1, title: "B", deletedAt: T0 }),
      mk({ id: "root", rank: 0, title: "Root" }),
    ];
    return { ids: m.childrenOf(nodes, "root").map((n) => n.id) };
  });
  expect(r.ids).toEqual(["a", "c"]);
});

test("moveNode refuses a node onto itself", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import("/web/js/model.js");
    const nodes = [m.createNode({ id: "a", createdAt: 1, updatedAt: 1 })];
    try {
      m.moveNode(nodes, "a", "a", 0, { now: 2 });
      return { threw: false, message: "" };
    } catch (e) {
      return { threw: true, message: String(e.message) };
    }
  });
  expect(r.threw).toBe(true);
  expect(r.message).toContain("cycle");
});

test("moveNode refuses a move under a direct or indirect descendant", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import("/web/js/model.js");
    const T0 = 1700000000000;
    const mk = (p) => m.createNode({ createdAt: T0, updatedAt: T0, ...p });
    const nodes = [
      mk({ id: "a" }),
      mk({ id: "b", parentId: "a" }),
      mk({ id: "c", parentId: "b" }),
      mk({ id: "d", parentId: "c" }),
    ];
    const attempt = (id, parent) => {
      try {
        m.moveNode(nodes, id, parent, 0, { now: T0 + 1 });
        return "no-throw";
      } catch (e) {
        return String(e.message);
      }
    };
    return {
      direct: attempt("a", "b"),
      indirect: attempt("a", "d"),
      legal: attempt("d", "a"),
      unchanged: nodes.map((n) => n.parentId),
    };
  });
  expect(r.direct).toContain("cycle");
  expect(r.indirect).toContain("cycle");
  expect(r.legal).toBe("no-throw");
  // The input array must never be mutated.
  expect(r.unchanged).toEqual([null, "a", "b", "c"]);
});

test("moveNode renumbers old and new sibling row and touches only changed nodes", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import("/web/js/model.js");
    const T0 = 1700000000000;
    const mk = (p) => m.createNode({ createdAt: T0, updatedAt: T0, ...p });
    const nodes = [
      mk({ id: "p1" }),
      mk({ id: "p2", rank: 1 }),
      mk({ id: "x", parentId: "p1", rank: 0 }),
      mk({ id: "y", parentId: "p1", rank: 1 }),
      mk({ id: "z", parentId: "p1", rank: 2 }),
      mk({ id: "q", parentId: "p2", rank: 0 }),
      mk({ id: "s", parentId: "p2", rank: 1 }),
    ];
    const out = m.moveNode(nodes, "x", "p2", 1, { now: T0 + 5 });
    const info = {};
    for (const n of out) info[n.id] = { p: n.parentId, r: n.rank, u: n.updatedAt };
    return {
      info,
      oldRow: m.childrenOf(out, "p1").map((n) => [n.id, n.rank]),
      newRow: m.childrenOf(out, "p2").map((n) => [n.id, n.rank]),
    };
  });
  expect(r.newRow).toEqual([["q", 0], ["x", 1], ["s", 2]]);
  expect(r.oldRow).toEqual([["y", 0], ["z", 1]]);
  // y moved 1 -> 0 and z 2 -> 1, both changed; q kept rank 0 and must NOT be touched.
  expect(r.info.q.u).toBe(1700000000000);
  expect(r.info.y.u).toBe(1700000000005);
  expect(r.info.z.u).toBe(1700000000005);
  expect(r.info.x.u).toBe(1700000000005);
  expect(r.info.p1.u).toBe(1700000000000);
});

test("reorder produces a dense 0..n-1 rank row", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import("/web/js/model.js");
    const T0 = 1700000000000;
    const mk = (p) => m.createNode({ createdAt: T0, updatedAt: T0, ...p });
    const nodes = [
      mk({ id: "root" }),
      mk({ id: "a", parentId: "root", rank: 5 }),
      mk({ id: "b", parentId: "root", rank: 9 }),
      mk({ id: "c", parentId: "root", rank: 12 }),
    ];
    const out = m.reorder(nodes, "root", ["c", "a", "b"], { now: T0 + 1 });
    let threw = false;
    try {
      m.reorder(out, "root", ["nope"], { now: T0 + 2 });
    } catch {
      threw = true;
    }
    return {
      row: m.childrenOf(out, "root").map((n) => [n.id, n.rank]),
      threw,
    };
  });
  expect(r.row).toEqual([["c", 0], ["a", 1], ["b", 2]]);
  expect(r.threw).toBe(true);
});

test("softDelete tombstones the whole subtree and nothing else", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import("/web/js/model.js");
    const T0 = 1700000000000;
    const mk = (p) => m.createNode({ createdAt: T0, updatedAt: T0, ...p });
    const nodes = [
      mk({ id: "a" }),
      mk({ id: "a1", parentId: "a" }),
      mk({ id: "a1x", parentId: "a1" }),
      mk({ id: "a1xy", parentId: "a1x" }),
      mk({ id: "b" }),
      mk({ id: "b1", parentId: "b" }),
    ];
    const out = m.softDelete(nodes, "a", { now: T0 + 7 });
    const del = {};
    for (const n of out) del[n.id] = n.deletedAt;
    return { del, count: out.length, inputStillLive: nodes.every((n) => n.deletedAt === null) };
  });
  expect(r.count).toBe(6); // nothing removed physically
  expect(r.del.a).toBe(1700000000007);
  expect(r.del.a1).toBe(1700000000007);
  expect(r.del.a1x).toBe(1700000000007);
  expect(r.del.a1xy).toBe(1700000000007);
  expect(r.del.b).toBeNull();
  expect(r.del.b1).toBeNull();
  expect(r.inputStillLive).toBe(true);
});

test("isOptedOut is inherited across several levels", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import("/web/js/model.js");
    const T0 = 1700000000000;
    const mk = (p) => m.createNode({ createdAt: T0, updatedAt: T0, ...p });
    const nodes = [
      mk({ id: "root", llmOptout: true }),
      mk({ id: "l1", parentId: "root" }),
      mk({ id: "l2", parentId: "l1" }),
      mk({ id: "l3", parentId: "l2" }),
      mk({ id: "other" }),
      mk({ id: "other1", parentId: "other" }),
      mk({ id: "self", llmOptout: true }),
    ];
    return {
      root: m.isOptedOut(nodes, "root"),
      l3: m.isOptedOut(nodes, "l3"),
      other1: m.isOptedOut(nodes, "other1"),
      self: m.isOptedOut(nodes, "self"),
      missing: m.isOptedOut(nodes, "ghost"),
    };
  });
  expect(r.root).toBe(true);
  expect(r.l3).toBe(true);
  expect(r.other1).toBe(false);
  expect(r.self).toBe(true);
  expect(r.missing).toBe(false);
});

test("score handles the edges: null inputs and effort zero", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import("/web/js/model.js");
    const s = (p) => m.score(m.createNode({ createdAt: 1, updatedAt: 1, ...p }));
    return {
      normal: s({ impact: 4, confidence: 3, effort: 2 }),
      noImpact: s({ confidence: 3, effort: 2 }),
      noConfidence: s({ impact: 4, effort: 2 }),
      noEffort: s({ impact: 4, confidence: 3 }),
      zeroEffort: s({ impact: 4, confidence: 3, effort: 0 }),
      nullNode: m.score(null),
    };
  });
  expect(r.normal).toBe(6);
  expect(r.noImpact).toBeNull();
  expect(r.noConfidence).toBeNull();
  expect(r.noEffort).toBeNull();
  expect(r.zeroEffort).toBeNull();
  expect(r.nullNode).toBeNull();
});

test("todayList: only open leaves, correct order, capped at 7", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import("/web/js/model.js");
    const NOW = new Date(2026, 4, 20, 12, 0, 0).getTime();
    const DAY = 86400000;
    const T0 = NOW - 30 * DAY;
    const mk = (p) => m.createNode({ createdAt: T0, updatedAt: T0, ...p });

    const nodes = [
      // three top roots plus a fourth one outside the top three
      mk({ id: "r1", rank: 0, title: "Root 1" }),
      mk({ id: "r2", rank: 1, title: "Root 2" }),
      mk({ id: "r3", rank: 2, title: "Root 3" }),
      mk({ id: "r4", rank: 3, title: "Root 4" }),
      // r1 has a child, so r1 itself is a goal and must not appear
      mk({ id: "t_overdue", parentId: "r1", title: "overdue", due: NOW - 2 * DAY, impact: 1, confidence: 1, effort: 5 }),
      mk({ id: "t_today", parentId: "r1", title: "today", due: NOW, impact: 1, confidence: 1, effort: 5 }),
      mk({ id: "t_hi", parentId: "r2", title: "top3 high score", impact: 5, confidence: 5, effort: 1 }),
      mk({ id: "t_lo", parentId: "r3", title: "top3 low score", impact: 1, confidence: 1, effort: 5 }),
      mk({ id: "t_out", parentId: "r4", title: "outside top3 high score", impact: 5, confidence: 5, effort: 1 }),
      // excluded: done, parked, deleted
      mk({ id: "t_done", parentId: "r2", title: "done", status: "done" }),
      mk({ id: "t_parked", parentId: "r2", title: "parked", status: "parked" }),
      mk({ id: "t_del", parentId: "r2", title: "deleted", deletedAt: T0 }),
      // a node with only a deleted child counts as a leaf again
      mk({ id: "t_pseudo_goal", parentId: "r3", title: "pseudo goal", impact: 2, confidence: 2, effort: 1 }),
      mk({ id: "t_pseudo_child", parentId: "t_pseudo_goal", title: "dead child", deletedAt: T0 }),
    ];

    const list = m.todayList(nodes, { now: NOW });

    // cap check with many candidates
    const many = [mk({ id: "R", rank: 0, title: "R" })];
    for (let i = 0; i < 12; i += 1) {
      many.push(mk({ id: `n${i}`, parentId: "R", title: `n${i}`, impact: 5, confidence: 5, effort: 1 }));
    }
    return {
      ids: list.map((n) => n.id),
      capped: m.todayList(many, { now: NOW }).length,
      // no node with living children may appear
      hasGoals: list.some((n) => m.childrenOf(nodes, n.id).length > 0),
    };
  });
  // r4 is a root leaf itself (no living children) - it is open, so it may appear;
  // the important part is the ordering rule below.
  expect(r.hasGoals).toBe(false);
  expect(r.capped).toBe(7);
  expect(r.ids.slice(0, 2)).toEqual(["t_overdue", "t_today"]);
  // then top-three membership beats a higher score outside the top three
  const rest = r.ids.slice(2);
  expect(rest.indexOf("t_hi")).toBeLessThan(rest.indexOf("t_out"));
  expect(rest.indexOf("t_pseudo_goal")).toBeLessThan(rest.indexOf("t_out"));
  expect(rest.indexOf("t_lo")).toBeLessThan(rest.indexOf("t_out"));
  // score decides inside the top three
  expect(rest.indexOf("t_hi")).toBeLessThan(rest.indexOf("t_pseudo_goal"));
  expect(rest.indexOf("t_pseudo_goal")).toBeLessThan(rest.indexOf("t_lo"));
  expect(r.ids).not.toContain("t_done");
  expect(r.ids).not.toContain("t_parked");
  expect(r.ids).not.toContain("t_del");
  expect(r.ids).not.toContain("r1");
});

test("mergeDocs: node only in a, node only in b", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import("/web/js/model.js");
    const mk = (p) => m.createNode({ createdAt: 100, updatedAt: 100, ...p });
    const a = { schema: 1, nodes: [mk({ id: "onlyA", title: "A" })], settings: {} };
    const b = { schema: 1, nodes: [mk({ id: "onlyB", title: "B" })], settings: {} };
    const out = m.mergeDocs(a, b);
    return { ids: out.nodes.map((n) => n.id), titles: out.nodes.map((n) => n.title) };
  });
  expect(r.ids).toEqual(["onlyA", "onlyB"]);
  expect(r.titles).toEqual(["A", "B"]);
});

test("mergeDocs: the younger updatedAt wins, both directions", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import("/web/js/model.js");
    const mk = (p) => m.createNode({ createdAt: 100, ...p });
    const older = { schema: 1, nodes: [mk({ id: "x", title: "old", updatedAt: 200 })], settings: {} };
    const newer = { schema: 1, nodes: [mk({ id: "x", title: "new", updatedAt: 300 })], settings: {} };
    return {
      aNewer: m.mergeDocs(newer, older).nodes[0].title,
      bNewer: m.mergeDocs(older, newer).nodes[0].title,
    };
  });
  expect(r.aNewer).toBe("new");
  expect(r.bNewer).toBe("new");
});

test("mergeDocs keeps the losing text instead of dropping it", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import("/web/js/model.js");
    const mk = (p) => m.createNode({ createdAt: 100, ...p });
    // both sides were edited after creation -> real conflict
    const a = { schema: 1, nodes: [mk({ id: "x", title: "Version A", note: "note A", updatedAt: 200 })], settings: {} };
    const b = { schema: 1, nodes: [mk({ id: "x", title: "Version B", note: "note B", updatedAt: 300 })], settings: {} };
    const ab = m.mergeDocs(a, b);
    const ba = m.mergeDocs(b, a);
    // one side untouched since creation -> no conflict block
    const pristine = { schema: 1, nodes: [mk({ id: "y", title: "original", updatedAt: 100 })], settings: {} };
    const edited = { schema: 1, nodes: [mk({ id: "y", title: "edited", updatedAt: 500 })], settings: {} };
    const clean = m.mergeDocs(pristine, edited);
    return {
      title: ab.nodes[0].title,
      note: ab.nodes[0].note,
      sameBothWays: JSON.stringify(ab) === JSON.stringify(ba),
      marker: m.CONFLICT_MARKER,
      updatedAt: ab.nodes[0].updatedAt,
      cleanNote: clean.nodes[0].note,
      cleanTitle: clean.nodes[0].title,
      idempotent: JSON.stringify(m.mergeDocs(ab, ab)) === JSON.stringify(ab),
    };
  });
  expect(r.title).toBe("Version B");
  expect(r.note).toContain(r.marker);
  expect(r.note).toContain("Version A");
  expect(r.note).toContain("note A");
  expect(r.note).toContain("note B");
  expect(r.sameBothWays).toBe(true);
  expect(r.updatedAt).toBe(300);
  expect(r.cleanTitle).toBe("edited");
  expect(r.cleanNote).toBe("");
  expect(r.idempotent).toBe(true);
});

test("mergeDocs: a tombstone never beats a younger real edit", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import("/web/js/model.js");
    const mk = (p) => m.createNode({ createdAt: 100, ...p });
    const deleted = { schema: 1, nodes: [mk({ id: "x", title: "gone", updatedAt: 200, deletedAt: 200 })], settings: {} };
    const edited = { schema: 1, nodes: [mk({ id: "x", title: "alive", updatedAt: 400 })], settings: {} };
    const olderEdit = { schema: 1, nodes: [mk({ id: "x", title: "stale", updatedAt: 150 })], settings: {} };
    const resurrect = m.mergeDocs(deleted, edited).nodes[0];
    const resurrectSwapped = m.mergeDocs(edited, deleted).nodes[0];
    const stays = m.mergeDocs(deleted, olderEdit).nodes[0];
    return {
      resurrect: { deletedAt: resurrect.deletedAt, title: resurrect.title },
      swapped: { deletedAt: resurrectSwapped.deletedAt, title: resurrectSwapped.title },
      stays: { deletedAt: stays.deletedAt, title: stays.title },
    };
  });
  expect(r.resurrect.deletedAt).toBeNull();
  expect(r.resurrect.title).toBe("alive");
  expect(r.swapped.deletedAt).toBeNull();
  expect(r.stays.deletedAt).toBe(200);
});

test("mergeDocs is order independent even on an updatedAt tie", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import("/web/js/model.js");
    const mk = (p) => m.createNode({ createdAt: 100, ...p });
    const a = {
      schema: 1,
      nodes: [mk({ id: "x", title: "left", updatedAt: 500 }), mk({ id: "z", title: "z", updatedAt: 100 })],
      settings: { lang: "de" },
    };
    const b = {
      schema: 1,
      nodes: [mk({ id: "x", title: "right", updatedAt: 500 }), mk({ id: "w", title: "w", updatedAt: 100 })],
      settings: { theme: "dark" },
    };
    const ab = JSON.stringify(m.mergeDocs(a, b));
    const ba = JSON.stringify(m.mergeDocs(b, a));
    const twice = JSON.stringify(m.mergeDocs(a, b));
    return { equal: ab === ba, stable: ab === twice, ids: m.mergeDocs(a, b).nodes.map((n) => n.id), settings: m.mergeDocs(a, b).settings };
  });
  expect(r.equal).toBe(true);
  expect(r.stable).toBe(true);
  expect(r.ids).toEqual(["w", "x", "z"]);
  expect(r.settings).toEqual({ lang: "de", theme: "dark" });
});

test("search is accent and case insensitive and ranks title before note", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const s = await import("/web/js/search.js");
    const m = await import("/web/js/model.js");
    const mk = (p) => m.createNode({ createdAt: 1, updatedAt: 1, ...p });
    const nodes = [
      mk({ id: "root", title: "Gesundheit" }),
      mk({ id: "kid", parentId: "root", title: "Übung planen" }),
      mk({ id: "grand", parentId: "kid", title: "Laufschuhe", note: "für die Übung im Park" }),
      mk({ id: "acc", title: "Cafetería öffnen", note: "Anmeldung" }),
      mk({ id: "dead", title: "Übung geheim", deletedAt: 5 }),
      mk({ id: "mid", title: "Frühübung", note: "" }),
    ];
    const hits = s.search(nodes, "ÜBUNG");
    return {
      ids: hits.map((h) => h.node.id),
      fields: hits.map((h) => h.matchField),
      path: hits.find((h) => h.node.id === "grand").path,
      cafe: s.search(nodes, "cafeteria").map((h) => h.node.id),
      partial: s.search(nodes, "schuh").map((h) => h.node.id),
      empty: s.search(nodes, "   ").length,
      none: s.search(nodes, "zzzz").length,
    };
  });
  expect(r.ids).not.toContain("dead");
  // title hits first: "Übung planen" (word start) then "Frühübung" (mid word), note hit last
  expect(r.ids).toEqual(["kid", "mid", "grand"]);
  expect(r.fields).toEqual(["title", "title", "note"]);
  expect(r.path).toBe("Gesundheit › Übung planen");
  expect(r.cafe).toEqual(["acc"]);
  expect(r.partial).toEqual(["grand"]);
  expect(r.empty).toBe(0);
  expect(r.none).toBe(0);
});

test("portability: encrypted round trip and markdown export", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const p = await import("/web/js/portability.js");
    const m = await import("/web/js/model.js");
    const vault = { magic: "TENFOLD1", version: 1, wrappers: [{ label: "passphrase", salt: "abc" }], blob: "ZGF0YQ" };
    const blob = p.exportEncrypted(vault);
    const back = await p.importEncrypted(new File([await blob.text()], "x.tenfold"));

    const bad = async (content) => {
      try {
        await p.importEncrypted(new File([content], "x.tenfold"));
        return "no-throw";
      } catch (e) {
        return String(e.message);
      }
    };

    const mk = (o) => m.createNode({ createdAt: 1, updatedAt: 1, ...o });
    const doc = {
      schema: 1,
      settings: {},
      nodes: [
        mk({ id: "r", title: "Gesund werden", rank: 0 }),
        mk({ id: "c", parentId: "r", title: "Laufen", status: "doing", due: Date.UTC(2026, 0, 15, 12) }),
        mk({ id: "d", parentId: "r", title: "Geheim", deletedAt: 9 }),
      ],
    };
    const md = await p.exportPlaintextMarkdown(doc).text();
    return {
      roundTrip: JSON.stringify(back) === JSON.stringify(vault),
      ext: p.VAULT_EXTENSION,
      name: p.suggestedVaultFileName(Date.UTC(2026, 7, 8, 12)),
      notJson: await bad("this is not json"),
      noMagic: await bad(JSON.stringify({ version: 1, wrappers: [] })),
      noWrappers: await bad(JSON.stringify({ magic: "TENFOLD1", version: 1, wrappers: [] })),
      md,
    };
  });
  expect(r.roundTrip).toBe(true);
  expect(r.ext).toBe(".tenfold");
  expect(r.name).toBe("tenfold-2026-08-08.tenfold");
  expect(r.notJson).toContain("valid JSON");
  expect(r.noMagic).toContain("magic");
  expect(r.noWrappers).toContain("wrappers");
  expect(r.md).toContain("- [ ] Gesund werden");
  expect(r.md).toContain("  - [~] Laufen");
  expect(r.md).toContain("status: doing");
  expect(r.md).toContain("due: 2026-01-15");
  expect(r.md).not.toContain("Geheim");
});
