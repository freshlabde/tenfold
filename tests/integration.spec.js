// Integration: the full chain crypto -> store -> portability.
// The three modules were built independently against docs/CONTRACTS.md;
// this spec is the proof that they actually fit together.
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/fixture.html");
});

test("full chain: create, seal, save, reload, unlock, export, import", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = await import("/web/js/crypto.js");
    const s = await import("/web/js/store.js");
    const p = await import("/web/js/portability.js");

    const doc = {
      schema: 1,
      nodes: [
        {
          id: "n1", parentId: null, rank: 0,
          title: "CANARY-INTEGRATION-77", note: "", status: "open",
          impact: 4, confidence: 4, effort: 2, due: null, effortMinutes: null,
          doneWhen: "", origin: "manual", llmOptout: false,
          createdAt: 1000, updatedAt: 1000, deletedAt: null,
        },
      ],
      settings: { lang: "en" },
    };

    // 1. create a vault and seal the document into it
    const { vault, recoveryKey, masterKey } = await c.createVault({ passphrase: "correct horse battery staple" });
    const sealed = await c.sealIntoVault(vault, masterKey, doc);

    // 2. persist through store.js (must accept the VaultFile shape)
    await s.clearAll();
    await s.saveVault(sealed);
    const loaded = await s.loadVault();
    if (!loaded) return { fail: "loadVault returned null" };

    // 3. unlock the reloaded vault with each secret and read the doc back
    const k1 = await c.unlockWithPassphrase(loaded, "correct horse battery staple");
    const doc1 = await c.openFromVault(loaded, k1);
    const k2 = await c.unlockWithRecoveryKey(loaded, recoveryKey);
    const doc2 = await c.openFromVault(loaded, k2);

    // 4. plaintext leak check across the persisted bytes
    const persisted = JSON.stringify(loaded);
    const leak = persisted.includes("CANARY-INTEGRATION-77");

    // 5. portability round trip
    const blob = p.exportEncrypted(loaded);
    const file = new File([blob], "test.tenfold");
    const imported = await p.importEncrypted(file);
    const k3 = await c.unlockWithPassphrase(imported, "correct horse battery staple");
    const doc3 = await c.openFromVault(imported, k3);

    await s.clearAll();
    return {
      title1: doc1.nodes[0].title,
      title2: doc2.nodes[0].title,
      title3: doc3.nodes[0].title,
      leak,
    };
  });

  expect(r.fail).toBeUndefined();
  expect(r.title1).toBe("CANARY-INTEGRATION-77");
  expect(r.title2).toBe("CANARY-INTEGRATION-77");
  expect(r.title3).toBe("CANARY-INTEGRATION-77");
  expect(r.leak).toBe(false);
});
