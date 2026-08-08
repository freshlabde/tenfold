// Playwright specs for web/js/store.js - real IndexedDB in a real browser.
// Each test runs in its own browser context, so the databases do not collide.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/fixture.html");
  await page.evaluate(async () => {
    const s = await import("/web/js/store.js");
    await s.clearAll();
  });
});

test("save, load and clear round trip", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const s = await import("/web/js/store.js");
    const empty = await s.loadVault();
    const emptyStamp = await s.lastSavedAt();

    const vault = {
      magic: "TENFOLD1",
      version: 1,
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600000, salt: "c2FsdA" },
      wrappers: [{ label: "passphrase", nonce: "bm9uY2U", wrapped: "d3JhcHBlZA" }],
      blob: "Y2lwaGVydGV4dA",
    };
    await s.saveVault(vault, { now: 1234567890 });
    const loaded = await s.loadVault();
    const stamp = await s.lastSavedAt();

    // overwrite: still exactly one record
    await s.saveVault({ ...vault, blob: "bmV3" }, { now: 1234567999 });
    const second = await s.loadVault();
    const stamp2 = await s.lastSavedAt();

    await s.clearAll();
    const afterClear = await s.loadVault();
    const stampAfterClear = await s.lastSavedAt();

    return {
      empty,
      emptyStamp,
      same: JSON.stringify(loaded) === JSON.stringify(vault),
      detached: loaded !== vault,
      stamp,
      secondBlob: second.blob,
      stamp2,
      afterClear,
      stampAfterClear,
    };
  });
  expect(r.empty).toBeNull();
  expect(r.emptyStamp).toBeNull();
  expect(r.same).toBe(true);
  expect(r.detached).toBe(true);
  expect(r.stamp).toBe(1234567890);
  expect(r.secondBlob).toBe("bmV3");
  expect(r.stamp2).toBe(1234567999);
  expect(r.afterClear).toBeNull();
  expect(r.stampAfterClear).toBeNull();
});

test("the data survives a page reload", async ({ page }) => {
  await page.evaluate(async () => {
    const s = await import("/web/js/store.js");
    await s.saveVault({ magic: "TENFOLD1", version: 1, wrappers: [], blob: "YWJj" }, { now: 42 });
  });
  await page.reload();
  const r = await page.evaluate(async () => {
    const s = await import("/web/js/store.js");
    const v = await s.loadVault();
    return { blob: v ? v.blob : null, stamp: await s.lastSavedAt() };
  });
  expect(r.blob).toBe("YWJj");
  expect(r.stamp).toBe(42);
});

test("saveVault refuses anything that looks like plaintext", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const s = await import("/web/js/store.js");
    const attempt = async (value) => {
      try {
        await s.saveVault(value, { now: 1 });
        return "no-throw";
      } catch (e) {
        return String(e.message);
      }
    };
    return {
      doc: await attempt({ schema: 1, nodes: [{ id: "x", title: "secret" }] }),
      wrapped: await attempt({ magic: "TENFOLD1", doc: { nodes: [] } }),
      settings: await attempt({ magic: "TENFOLD1", settings: { lang: "de" } }),
      notAnObject: await attempt("plain string"),
      nothing: await attempt(null),
      stillEmpty: await s.loadVault(),
    };
  });
  expect(r.doc).toContain("only the encrypted vault");
  expect(r.wrapped).toContain("only the encrypted vault");
  expect(r.settings).toContain("only the encrypted vault");
  expect(r.notAnObject).toContain("plain object");
  expect(r.nothing).toContain("plain object");
  expect(r.stillEmpty).toBeNull();
});

test("requestPersistence reports what the browser actually said", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const s = await import("/web/js/store.js");
    const real = await s.requestPersistence();
    return { real, hasApi: !!(navigator.storage && navigator.storage.persist) };
  });
  expect(typeof r.real.persisted).toBe("boolean");
  expect(r.real.supported).toBe(r.hasApi);
});

test("store.js writes nothing but the vault record", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const s = await import("/web/js/store.js");
    await s.saveVault({ magic: "TENFOLD1", version: 1, wrappers: [], blob: "eA" }, { now: 7 });
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("tenfold");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const storeNames = [...db.objectStoreNames];
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction("vault", "readonly");
      const req = tx.objectStore("vault").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return { storeNames, count: all.length, keys: Object.keys(all[0]).sort(), dump: JSON.stringify(all) };
  });
  expect(r.storeNames).toEqual(["vault"]);
  expect(r.count).toBe(1);
  expect(r.keys).toEqual(["id", "lastSavedAt", "vault"]);
  // the raw database dump must not contain any tree data
  expect(r.dump).not.toContain("title");
  expect(r.dump).not.toContain("nodes");
});

test("store.js states the no-plaintext rule in its own source", async () => {
  const src = await readFile(new URL("../web/js/store.js", import.meta.url), "utf8");
  expect(src).toContain("NEVER WRITE PLAINTEXT INTO INDEXEDDB");
});
