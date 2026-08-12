// Playwright specs for web/js/crypto.js.
//
// What these tests do: exercise the real Chromium WebCrypto implementation via
// page.evaluate, so nothing can pass here that would fail in a browser.
// What they deliberately do not do: reach into module internals - only the
// exported contract is tested, plus the vault JSON, which is part of the format.
//
// PBKDF2 with 600000 rounds costs real time and some tests derive a dozen keys,
// so the per-test timeout is raised above the Playwright default.

import { test, expect } from "@playwright/test";

const CANARY = "GEHEIMER-KANARIENVOGEL-42";
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Page-side helpers, installed before every test so specs stay readable. */
function installHelpers() {
  window.tf = {
    doc(title) {
      return {
        schema: 1,
        settings: { lang: "de", theme: "dark" },
        nodes: [
          {
            id: "n1", parentId: null, rank: 0, title, note: "note one", status: "open",
            impact: 5, confidence: 4, effort: 2, due: null, effortMinutes: 30,
            doneWhen: "shipped", origin: "manual", llmOptout: false,
            createdAt: 1, updatedAt: 2, deletedAt: null,
          },
          {
            id: "n2", parentId: "n1", rank: 0, title: "child", note: "", status: "doing",
            impact: null, confidence: null, effort: null, due: 1700000000000,
            effortMinutes: null, doneWhen: "", origin: "llm", llmOptout: true,
            createdAt: 3, updatedAt: 4, deletedAt: null,
          },
        ],
      };
    },
    /** Runs fn and reports whether it threw, without letting a value escape untyped. */
    async caught(fn) {
      try {
        const value = await fn();
        return { threw: false, value: String(JSON.stringify(value ?? null)).slice(0, 200) };
      } catch (err) {
        return { threw: true, name: err.name, message: String(err.message) };
      }
    },
    latin1(bytes) {
      let out = "";
      for (const b of bytes) out += String.fromCharCode(b);
      return out;
    },
    hex(bytes) {
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    },
  };
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(installHelpers);
  await page.goto("/tests/fixture.html");
});

test("1 roundtrip: createVault, seal, open returns the identical document", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = await import("/web/js/crypto.js");
    const { doc } = window.tf;
    const { vault, recoveryKey, masterKey } = await c.createVault({
      passphrase: "correct horse battery",
    });
    const d = doc("plan the year");
    const blob = await c.seal(masterKey, d);
    const back = await c.open(masterKey, blob);
    return {
      magic: vault.magic,
      version: vault.version,
      wrapperKinds: vault.wrappers.map((w) => w.kind).sort(),
      blobIsBytes: blob instanceof Uint8Array,
      identical: JSON.stringify(back) === JSON.stringify(d),
      recoveryShape: /^[A-Z0-9]{4}(-[A-Z0-9]{4}){6}$/.test(recoveryKey),
      jsonSerialisable: JSON.parse(JSON.stringify(vault)).magic === "TENFOLD1",
    };
  });
  expect(r.magic).toBe("TENFOLD1");
  expect(r.version).toBe(1);
  expect(r.wrapperKinds).toEqual(["passphrase", "recovery"]);
  expect(r.blobIsBytes).toBe(true);
  expect(r.identical).toBe(true);
  expect(r.recoveryShape).toBe(true);
  expect(r.jsonSerialisable).toBe(true);
});

test("2 every wrapper opens the vault on its own", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = await import("/web/js/crypto.js");
    const { doc } = window.tf;
    const pass = "correct horse battery";
    let { vault, recoveryKey, masterKey } = await c.createVault({ passphrase: pass });
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    vault = await c.addRawKeyWrapper(vault, masterKey, rawKey, "iphone");

    const d = doc("only one secret");
    vault = await c.sealIntoVault(vault, masterKey, d);
    const want = JSON.stringify(d);

    const viaPass = await c.unlockWithPassphrase(vault, pass);
    const viaRec = await c.unlockWithRecoveryKey(vault, recoveryKey);
    const viaRaw = await c.unlockWithRawKey(vault, rawKey);

    return {
      pass: JSON.stringify(await c.openFromVault(vault, viaPass)) === want,
      rec: JSON.stringify(await c.openFromVault(vault, viaRec)) === want,
      raw: JSON.stringify(await c.openFromVault(vault, viaRaw)) === want,
      // A raw wrapper must also accept a plain ArrayBuffer, which is what the
      // WebAuthn PRF extension hands back.
      rawAsArrayBuffer: !!(await c.unlockWithRawKey(vault, rawKey.buffer)),
      kinds: vault.wrappers.map((w) => w.kind).sort(),
      labels: vault.wrappers.map((w) => w.label).sort(),
    };
  });
  expect(r.pass).toBe(true);
  expect(r.rec).toBe(true);
  expect(r.raw).toBe(true);
  expect(r.rawAsArrayBuffer).toBe(true);
  expect(r.kinds).toEqual(["passphrase", "raw", "recovery"]);
  expect(r.labels).toEqual(["iphone", "passphrase", "recovery"]);
});

test("3 wrong passphrase throws and yields no partial plaintext", async ({ page }) => {
  const r = await page.evaluate(async (canary) => {
    const c = await import("/web/js/crypto.js");
    const { doc, caught } = window.tf;
    const { vault, masterKey } = await c.createVault({ passphrase: "right one" });
    const sealed = await c.sealIntoVault(vault, masterKey, doc(canary));
    const bad = await caught(() => c.unlockWithPassphrase(sealed, "wrong one"));
    const nearMiss = await caught(() => c.unlockWithPassphrase(sealed, "right onE"));
    const empty = await caught(() => c.unlockWithPassphrase(sealed, ""));
    // A vault that has no passphrase wrapper at all must answer exactly the same.
    const noPassWrapper = JSON.parse(JSON.stringify(sealed));
    noPassWrapper.wrappers = noPassWrapper.wrappers.filter((w) => w.kind !== "passphrase");
    const absent = await caught(() => c.unlockWithPassphrase(noPassWrapper, "right one"));
    return {
      bad,
      nearMiss,
      empty,
      absent,
      leaks: bad.threw ? bad.message.includes(canary) : true,
      mentionsWrapperKind: bad.threw ? /passphrase|recovery|raw|wrapper/i.test(bad.message) : true,
      sameMessage: bad.threw && absent.threw && bad.message === absent.message,
    };
  }, CANARY);
  expect(r.bad.threw).toBe(true);
  expect(r.bad.name).toBe("VaultUnlockError");
  expect(r.nearMiss.threw).toBe(true);
  expect(r.empty.threw).toBe(true);
  expect(r.absent.threw).toBe(true);
  expect(r.leaks).toBe(false);
  expect(r.mentionsWrapperKind).toBe(false);
  expect(r.sameMessage).toBe(true);
});

test("4 wrong recovery key throws", async ({ page }) => {
  const r = await page.evaluate(async (alphabet) => {
    const c = await import("/web/js/crypto.js");
    const { caught } = window.tf;
    const { vault, recoveryKey } = await c.createVault({ passphrase: "right one" });
    // Same shape, different content: rotate the first symbol inside the alphabet.
    const other = alphabet[(alphabet.indexOf(recoveryKey[0]) + 7) % alphabet.length];
    const wrong = other + recoveryKey.slice(1);
    return {
      differs: wrong !== recoveryKey,
      wrongKey: await caught(() => c.unlockWithRecoveryKey(vault, wrong)),
      wrongShape: await caught(() => c.unlockWithRecoveryKey(vault, "NOPE")),
      // Contains a character the alphabet excludes on purpose.
      confusable: await caught(() => c.unlockWithRecoveryKey(vault, recoveryKey.replace(/[A-Z]/, "I"))),
      empty: await caught(() => c.unlockWithRecoveryKey(vault, "")),
      notAString: await caught(() => c.unlockWithRecoveryKey(vault, null)),
      // The passphrase must not be usable as a recovery key and vice versa.
      crossed: await caught(() => c.unlockWithPassphrase(vault, recoveryKey)),
    };
  }, ALPHABET);
  expect(r.differs).toBe(true);
  expect(r.wrongKey.threw).toBe(true);
  expect(r.wrongKey.name).toBe("VaultUnlockError");
  expect(r.wrongShape.threw).toBe(true);
  expect(r.confusable.threw).toBe(true);
  expect(r.empty.threw).toBe(true);
  expect(r.notAString.threw).toBe(true);
  expect(r.crossed.threw).toBe(true);
});

test("5 recovery key input tolerates case, missing hyphens and stray spaces", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = await import("/web/js/crypto.js");
    const { doc } = window.tf;
    const { vault, recoveryKey, masterKey } = await c.createVault({ passphrase: "pw" });
    const sealed = await c.sealIntoVault(vault, masterKey, doc("tolerant input"));
    const variants = {
      exact: recoveryKey,
      lower: recoveryKey.toLowerCase(),
      noHyphen: recoveryKey.replace(/-/g, ""),
      spaces: "  " + recoveryKey.replace(/-/g, " ") + "  ",
      mixed: recoveryKey.toLowerCase().replace(/-/g, " . "),
    };
    const out = { normalisedAlike: true, formatRoundtrip: false };
    for (const [name, value] of Object.entries(variants)) {
      const key = await c.unlockWithRecoveryKey(sealed, value);
      out[name] = (await c.openFromVault(sealed, key)).nodes[0].title === "tolerant input";
      if (c.normaliseRecoveryKey(value) !== recoveryKey.replace(/-/g, "")) {
        out.normalisedAlike = false;
      }
    }
    out.formatRoundtrip = c.formatRecoveryKey(variants.lower) === recoveryKey;
    return out;
  });
  expect(r).toEqual({
    exact: true,
    lower: true,
    noHyphen: true,
    spaces: true,
    mixed: true,
    normalisedAlike: true,
    formatRoundtrip: true,
  });
});

test("6 a single flipped byte in payload.ct makes open throw", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = await import("/web/js/crypto.js");
    const { doc, caught } = window.tf;
    const { vault, masterKey } = await c.createVault({ passphrase: "pw" });
    const sealed = await c.sealIntoVault(vault, masterKey, doc("intact"));
    const okBefore = (await c.openFromVault(sealed, masterKey)).nodes[0].title === "intact";

    const flip = (v, field) => {
      const copy = JSON.parse(JSON.stringify(v));
      const bytes = c.b64uDecode(copy.payload[field]);
      bytes[Math.floor(bytes.length / 2)] ^= 0x01;
      copy.payload[field] = c.b64uEncode(bytes);
      return copy;
    };
    const ctFlipped = await caught(() => c.openFromVault(flip(sealed, "ct"), masterKey));
    const nonceFlipped = await caught(() => c.openFromVault(flip(sealed, "nonce"), masterKey));

    // Same again on the standalone blob returned by seal(): body, tag, header.
    const body = await c.seal(masterKey, doc("intact"));
    body[30] ^= 0x80;
    const bodyFlipped = await caught(() => c.open(masterKey, body));

    const tag = await c.seal(masterKey, doc("intact"));
    tag[tag.length - 1] ^= 0x01;
    const tagFlipped = await caught(() => c.open(masterKey, tag));

    const magic = await c.seal(masterKey, doc("intact"));
    magic[0] ^= 0x20;
    const magicFlipped = await caught(() => c.open(masterKey, magic));

    const good = await c.seal(masterKey, doc("intact"));
    const truncated = await caught(() => c.open(masterKey, good.slice(0, 12)));
    const empty = await caught(() => c.open(masterKey, new Uint8Array(0)));

    return { okBefore, ctFlipped, nonceFlipped, bodyFlipped, tagFlipped, magicFlipped,
             truncated, empty };
  });
  expect(r.okBefore).toBe(true);
  expect(r.ctFlipped.threw).toBe(true);
  expect(r.ctFlipped.name).toBe("VaultIntegrityError");
  expect(r.nonceFlipped.threw).toBe(true);
  expect(r.bodyFlipped.threw).toBe(true);
  expect(r.tagFlipped.threw).toBe(true);
  expect(r.magicFlipped.threw).toBe(true);
  expect(r.truncated.threw).toBe(true);
  expect(r.empty.threw).toBe(true);
});

test("7 tampering with header parameters is caught by the AAD binding", async ({ page }) => {
  const r = await page.evaluate(async (canary) => {
    const c = await import("/web/js/crypto.js");
    const { doc, caught } = window.tf;
    const pass = "pw";
    const { vault, masterKey } = await c.createVault({ passphrase: pass });
    const sealed = await c.sealIntoVault(vault, masterKey, doc(canary));
    const clone = () => JSON.parse(JSON.stringify(sealed));
    const idx = sealed.wrappers.findIndex((w) => w.kind === "passphrase");
    const unlockThenOpen = (v) =>
      caught(async () => c.openFromVault(v, await c.unlockWithPassphrase(v, pass)));

    // a) iterations lowered far below the floor - a downgrade attack.
    const lowered = clone();
    lowered.wrappers[idx].kdf.iterations = 1000;

    // b) iterations lowered but still inside the accepted range, so the cheap
    //    guard cannot short-circuit and the AEAD tag has to catch it.
    const lowered2 = clone();
    lowered2.wrappers[idx].kdf.iterations = 100000;

    // c) salt swapped for another random one.
    const resalted = clone();
    resalted.wrappers[idx].kdf.salt = c.b64uEncode(crypto.getRandomValues(new Uint8Array(16)));

    // d) label rewritten only. The derived key is bit-for-bit unchanged, so
    //    nothing but the AAD can detect this.
    const relabelled = clone();
    relabelled.wrappers[idx].label = "not-the-passphrase";

    // e) wrapper id rewritten only. Same reasoning as (d).
    const reidentified = clone();
    reidentified.wrappers[idx].id = crypto.randomUUID();

    // f) hash downgraded.
    const rehashed = clone();
    rehashed.wrappers[idx].kdf.hash = "SHA-512";

    // g) version bumped in the vault header.
    const reversioned = clone();
    reversioned.version = 2;

    // h) proof that the payload carries AAD at all: decrypting the stored
    //    nonce+ct without additionalData must fail with the correct master key.
    const rawNoAad = await caught(() =>
      crypto.subtle.decrypt(
        { name: "AES-GCM", iv: c.b64uDecode(sealed.payload.nonce) },
        masterKey,
        c.b64uDecode(sealed.payload.ct),
      ),
    );

    return {
      declaredIterations: sealed.wrappers[idx].kdf.iterations,
      lowered: await unlockThenOpen(lowered),
      lowered2: await unlockThenOpen(lowered2),
      resalted: await unlockThenOpen(resalted),
      relabelled: await unlockThenOpen(relabelled),
      reidentified: await unlockThenOpen(reidentified),
      rehashed: await unlockThenOpen(rehashed),
      reversioned: await caught(() => c.unlockWithPassphrase(reversioned, pass)),
      rawNoAad,
      // Control: the untouched vault still opens and still holds the canary.
      control: (await unlockThenOpen(sealed)).value.includes(canary),
    };
  }, CANARY);
  expect(r.declaredIterations).toBe(600000);
  expect(r.lowered.threw).toBe(true);
  expect(r.lowered2.threw).toBe(true);
  expect(r.lowered2.name).toBe("VaultUnlockError");
  expect(r.resalted.threw).toBe(true);
  expect(r.relabelled.threw).toBe(true);
  expect(r.relabelled.name).toBe("VaultUnlockError");
  expect(r.reidentified.threw).toBe(true);
  expect(r.reidentified.name).toBe("VaultUnlockError");
  expect(r.rehashed.threw).toBe(true);
  expect(r.reversioned.threw).toBe(true);
  expect(r.rawNoAad.threw).toBe(true);
  expect(r.control).toBe(true);
});

test("8 no plaintext leak: the canary appears nowhere in the vault bytes", async ({ page }) => {
  const r = await page.evaluate(async (canary) => {
    const c = await import("/web/js/crypto.js");
    const { doc, latin1 } = window.tf;
    const { vault, masterKey, recoveryKey } = await c.createVault({ passphrase: "pw" });
    const d = doc(canary);
    d.nodes[1].note = canary + " again";
    d.nodes[1].doneWhen = canary;
    d.settings.hint = canary;

    let sealed = await c.sealIntoVault(vault, masterKey, d);
    sealed = await c.addRawKeyWrapper(
      sealed,
      masterKey,
      crypto.getRandomValues(new Uint8Array(32)),
      "iphone",
    );

    const json = JSON.stringify(sealed);
    const hits = [];
    if (json.includes(canary)) hits.push("json");

    // Walk every value in the vault; search it as text and, where it decodes,
    // as raw bytes. Nothing anywhere may contain the canary.
    const walk = (value, path) => {
      if (typeof value === "string") {
        if (value.includes(canary)) hits.push("string:" + path);
        try {
          if (latin1(c.b64uDecode(value)).includes(canary)) hits.push("bytes:" + path);
        } catch {
          // Not base64url; already searched as text above.
        }
      } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) walk(v, path + "/" + k);
      }
    };
    walk(sealed, "");

    if (latin1(await c.seal(masterKey, d)).includes(canary)) hits.push("blob");
    if (latin1(new TextEncoder().encode(json)).includes(canary)) hits.push("jsonBytes");
    if (recoveryKey.includes(canary)) hits.push("recoveryKey");
    // Also check a fragment, in case something stored a truncated title.
    if (json.includes("KANARIENVOGEL")) hits.push("fragment");
    // The vault must not carry document field names either. Markers are kept at
    // five characters or more so a random base64url run cannot match by chance.
    for (const marker of ["nodes", "settings", "doneWhen", "llmOptout"]) {
      if (JSON.stringify(sealed.payload).includes(marker)) hits.push("meta:" + marker);
    }

    return { hits, jsonLength: json.length, canaryLength: canary.length };
  }, CANARY);
  expect(r.hits).toEqual([]);
  expect(r.jsonLength).toBeGreaterThan(100);
});

test("9 two seal() calls over the same document produce different ciphertext", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = await import("/web/js/crypto.js");
    const { doc, hex } = window.tf;
    const { masterKey } = await c.createVault({ passphrase: "pw" });
    const d = doc("same input");
    const a = await c.seal(masterKey, d);
    const b = await c.seal(masterKey, d);
    const nonceOf = (blob) => hex(blob.slice(10, 22));

    // Ten draws in total, to catch a nonce that only changes every other call.
    const nonces = new Set([nonceOf(a), nonceOf(b)]);
    const ciphertexts = new Set([hex(a.slice(22)), hex(b.slice(22))]);
    for (let i = 0; i < 8; i += 1) {
      const blob = await c.seal(masterKey, d);
      nonces.add(nonceOf(blob));
      ciphertexts.add(hex(blob.slice(22)));
    }
    return {
      sameLength: a.length === b.length,
      distinctNonces: nonces.size,
      distinctCiphertexts: ciphertexts.size,
      headerStable: hex(a.slice(0, 10)) === hex(b.slice(0, 10)),
      bothOpen:
        JSON.stringify(await c.open(masterKey, a)) === JSON.stringify(await c.open(masterKey, b)),
    };
  });
  expect(r.sameLength).toBe(true);
  expect(r.distinctNonces).toBe(10);
  expect(r.distinctCiphertexts).toBe(10);
  expect(r.headerStable).toBe(true);
  expect(r.bothOpen).toBe(true);
});

test("10 addRawKeyWrapper and removeWrapper: a revoked wrapper no longer opens", async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const c = await import("/web/js/crypto.js");
    const { doc, caught } = window.tf;
    const pass = "pw";
    const { vault, masterKey } = await c.createVault({ passphrase: pass });
    const phone = crypto.getRandomValues(new Uint8Array(32));
    const laptop = crypto.getRandomValues(new Uint8Array(32));

    const withPhone = await c.addRawKeyWrapper(vault, masterKey, phone, "iphone");
    const withBoth = await c.addRawKeyWrapper(withPhone, masterKey, laptop, "macbook");
    const sealed = await c.sealIntoVault(withBoth, masterKey, doc("devices"));

    const phoneWorks = !!(await c.unlockWithRawKey(sealed, phone));
    const originalUnchanged = vault.wrappers.length === 2;

    const revoked = await c.removeWrapper(sealed, "iphone");
    const phoneAfter = await caught(() => c.unlockWithRawKey(revoked, phone));
    const laptopAfter = !!(await c.unlockWithRawKey(revoked, laptop));
    const passAfter = !!(await c.unlockWithPassphrase(revoked, pass));
    const contentAfter =
      (await c.openFromVault(revoked, await c.unlockWithRawKey(revoked, laptop))).nodes[0].title ===
      "devices";

    // Removing every wrapper is refused: an unopenable vault is data loss.
    let stripped = await c.removeWrapper(sealed, "iphone");
    stripped = await c.removeWrapper(stripped, "macbook");
    stripped = await c.removeWrapper(stripped, "recovery");
    const lastOne = await caught(() => c.removeWrapper(stripped, "passphrase"));

    return {
      phoneWorks,
      originalUnchanged,
      phoneAfter,
      laptopAfter,
      passAfter,
      contentAfter,
      labelsAfterRevoke: revoked.wrappers.map((w) => w.label).sort(),
      // "raw:<label>" addresses the same wrapper as the bare label.
      prefixLabels: (await c.removeWrapper(sealed, "raw:macbook")).wrappers
        .map((w) => w.label)
        .sort(),
      dup: await caught(() => c.addRawKeyWrapper(sealed, masterKey, laptop, "iphone")),
      missing: await caught(() => c.removeWrapper(sealed, "nosuchlabel")),
      badLength: await caught(() => c.addRawKeyWrapper(sealed, masterKey, new Uint8Array(16), "x")),
      noLabel: await caught(() => c.addRawKeyWrapper(sealed, masterKey, laptop, "")),
      lastOne,
      listed: c.listWrappers(sealed).map((w) => w.kind + ":" + w.label).sort(),
      listedHasSecrets: c.listWrappers(sealed).some((w) => "ct" in w || "kdf" in w || "nonce" in w),
    };
  });
  expect(r.phoneWorks).toBe(true);
  expect(r.originalUnchanged).toBe(true);
  expect(r.phoneAfter.threw).toBe(true);
  expect(r.phoneAfter.name).toBe("VaultUnlockError");
  expect(r.laptopAfter).toBe(true);
  expect(r.passAfter).toBe(true);
  expect(r.contentAfter).toBe(true);
  expect(r.labelsAfterRevoke).toEqual(["macbook", "passphrase", "recovery"]);
  expect(r.prefixLabels).toEqual(["iphone", "passphrase", "recovery"]);
  expect(r.dup.threw).toBe(true);
  expect(r.missing.threw).toBe(true);
  expect(r.badLength.threw).toBe(true);
  expect(r.noLabel.threw).toBe(true);
  expect(r.lastOne.threw).toBe(true);
  expect(r.listed).toEqual([
    "passphrase:passphrase",
    "raw:iphone",
    "raw:macbook",
    "recovery:recovery",
  ]);
  expect(r.listedHasSecrets).toBe(false);
});

test("11 rotateMasterKey: old secrets are dead, raw wrappers are gone, content survives", async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const c = await import("/web/js/crypto.js");
    const { doc, caught } = window.tf;
    const oldPass = "old passphrase";
    const newPass = "new passphrase";
    let { vault, recoveryKey: oldRecovery, masterKey } = await c.createVault({
      passphrase: oldPass,
    });
    const phone = crypto.getRandomValues(new Uint8Array(32));
    vault = await c.addRawKeyWrapper(vault, masterKey, phone, "stolen-phone");
    vault = await c.addRawKeyWrapper(
      vault,
      masterKey,
      crypto.getRandomValues(new Uint8Array(32)),
      "macbook",
    );
    const d = doc("survives rotation");
    vault = await c.sealIntoVault(vault, masterKey, d);

    const oldPayloadCt = vault.payload.ct;
    const oldWrapperCts = vault.wrappers.map((w) => w.ct);
    const oldSalts = vault.wrappers.map((w) => w.kdf.salt);

    const rotated = await c.rotateMasterKey(vault, masterKey, { passphrase: newPass });

    const newPassKey = await c.unlockWithPassphrase(rotated.vault, newPass);
    const contentSurvived =
      JSON.stringify(await c.openFromVault(rotated.vault, newPassKey)) === JSON.stringify(d);

    return {
      contentSurvived,
      oldPassOnNew: await caught(() => c.unlockWithPassphrase(rotated.vault, oldPass)),
      oldRecOnNew: await caught(() => c.unlockWithRecoveryKey(rotated.vault, oldRecovery)),
      stolenPhoneOnNew: await caught(() => c.unlockWithRawKey(rotated.vault, phone)),
      oldMasterOnNew: await caught(() => c.openFromVault(rotated.vault, masterKey)),
      newPassOnOld: await caught(() => c.unlockWithPassphrase(vault, newPass)),
      newRecWorks: !!(await c.unlockWithRecoveryKey(rotated.vault, rotated.recoveryKey)),
      newMasterOpens:
        (await c.openFromVault(rotated.vault, rotated.masterKey)).nodes[0].title ===
        "survives rotation",
      kinds: rotated.vault.wrappers.map((w) => w.kind).sort(),
      rawGone: rotated.vault.wrappers.every((w) => w.kind !== "raw"),
      recoveryChanged: rotated.recoveryKey !== oldRecovery,
      payloadReencrypted: rotated.vault.payload.ct !== oldPayloadCt,
      wrapperCtsFresh: rotated.vault.wrappers.every((w) => !oldWrapperCts.includes(w.ct)),
      saltsFresh: rotated.vault.wrappers.every((w) => !oldSalts.includes(w.kdf.salt)),
      oldVaultUntouched: vault.wrappers.length === 4 && vault.payload.ct === oldPayloadCt,
    };
  });
  expect(r.contentSurvived).toBe(true);
  expect(r.oldPassOnNew.threw).toBe(true);
  expect(r.oldPassOnNew.name).toBe("VaultUnlockError");
  expect(r.oldRecOnNew.threw).toBe(true);
  expect(r.stolenPhoneOnNew.threw).toBe(true);
  expect(r.oldMasterOnNew.threw).toBe(true);
  expect(r.newPassOnOld.threw).toBe(true);
  expect(r.newRecWorks).toBe(true);
  expect(r.newMasterOpens).toBe(true);
  expect(r.kinds).toEqual(["passphrase", "recovery"]);
  expect(r.rawGone).toBe(true);
  expect(r.recoveryChanged).toBe(true);
  expect(r.payloadReencrypted).toBe(true);
  expect(r.wrapperCtsFresh).toBe(true);
  expect(r.saltsFresh).toBe(true);
  expect(r.oldVaultUntouched).toBe(true);
});

test("12 PBKDF2 really runs 600000 rounds and the parameters are sound", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const c = await import("/web/js/crypto.js");
    const { vault, recoveryKey, masterKey } = await c.createVault({ passphrase: "pw" });
    const withRaw = await c.addRawKeyWrapper(
      vault,
      masterKey,
      crypto.getRandomValues(new Uint8Array(32)),
      "iphone",
    );
    const rotated = await c.rotateMasterKey(vault, masterKey, { passphrase: "pw2" });
    const all = [...withRaw.wrappers, ...rotated.vault.wrappers];
    const pbkdf2 = all.filter((w) => w.kdf.name === "PBKDF2");

    // The declared cost must also be the cost actually paid: 600000 rounds are
    // measurably slower than 1000 in the same engine.
    const timeDerive = async (iterations) => {
      const base = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("pw"),
        "PBKDF2",
        false,
        ["deriveBits"],
      );
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const t0 = performance.now();
      await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations },
        base,
        256,
      );
      return performance.now() - t0;
    };
    const cheap = await timeDerive(1000);
    const declared = await timeDerive(c.PBKDF2_ITERATIONS);

    return {
      exported: c.PBKDF2_ITERATIONS,
      iterations: [...new Set(pbkdf2.map((w) => w.kdf.iterations))],
      hashes: [...new Set(pbkdf2.map((w) => w.kdf.hash))],
      saltBytes: [...new Set(pbkdf2.map((w) => c.b64uDecode(w.kdf.salt).length))],
      saltsDistinct: new Set(pbkdf2.map((w) => w.kdf.salt)).size === pbkdf2.length,
      noncesDistinct: new Set(all.map((w) => w.nonce)).size === all.length,
      nonceBytes: [...new Set(all.map((w) => c.b64uDecode(w.nonce).length))],
      payloadNonceBytes: c.b64uDecode(withRaw.payload.nonce).length,
      rawKdf: withRaw.wrappers.filter((w) => w.kind === "raw").map((w) => w.kdf.name),
      magic: c.MAGIC,
      costRatio: declared / Math.max(cheap, 0.05),
      recoveryEntropyBits: Math.floor(recoveryKey.replace(/-/g, "").length * Math.log2(30)),
    };
  });
  expect(r.exported).toBe(600000);
  expect(r.iterations).toEqual([600000]);
  expect(r.hashes).toEqual(["SHA-256"]);
  expect(r.saltBytes).toEqual([16]);
  expect(r.saltsDistinct).toBe(true);
  expect(r.noncesDistinct).toBe(true);
  expect(r.nonceBytes).toEqual([12]);
  expect(r.payloadNonceBytes).toBe(12);
  expect(r.rawKdf).toEqual(["HKDF"]);
  expect(r.magic).toBe("TENFOLD1");
  expect(r.costRatio).toBeGreaterThan(20);
  expect(r.recoveryEntropyBits).toBeGreaterThanOrEqual(128);
});

test("13 the shell-bio wrapper: roundtrip, wrong key, flipped byte, and the others survive", async ({
  page,
}) => {
  // The fourth envelope, put through the same battery as the third. The key
  // does not come from an authenticator here but from the native shell's
  // Keychain - which, to this module, is nothing but 32 bytes somebody handed
  // it, and that is exactly the point of testing it without one.
  const r = await page.evaluate(async () => {
    const c = await import("/web/js/crypto.js");
    const { doc, caught } = window.tf;
    const pass = "pw";
    const { vault, recoveryKey, masterKey } = await c.createVault({ passphrase: pass });
    // The stand-in for the shell: 32 bytes, base64url, 43 characters - the
    // encoding bio.createKey answers in.
    const kek = crypto.getRandomValues(new Uint8Array(32));
    const encoded = c.b64uEncode(kek);
    const other = crypto.getRandomValues(new Uint8Array(32));

    let next = await c.addShellBioWrapper(vault, masterKey, kek, "shell-bio:testdevice");
    next = await c.sealIntoVault(next, masterKey, doc("behind a face"));

    const opened = await c.unlockWithShellBioKey(next, kek);
    const roundtrip = (await c.openFromVault(next, opened)).nodes[0].title === "behind a face";

    // One flipped byte in the wrapper's own ciphertext.
    const flipped = JSON.parse(JSON.stringify(next));
    const idx = flipped.wrappers.findIndex((w) => w.kind === c.SHELL_BIO_KIND);
    const bytes = c.b64uDecode(flipped.wrappers[idx].ct);
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    flipped.wrappers[idx].ct = c.b64uEncode(bytes);

    // Removing it leaves the other three ways in exactly where they were.
    const without = await c.removeWrapper(next, "shell-bio:testdevice");

    return {
      roundtrip,
      encodedLength: encoded.length,
      kind: next.wrappers[idx].kind,
      kdf: next.wrappers[idx].kdf.name,
      info: next.wrappers[idx].kdf.info,
      kinds: next.wrappers.map((w) => w.kind).sort(),
      // Wrong key, wrong length, not bytes at all: one constant refusal.
      wrongKek: await caught(() => c.unlockWithShellBioKey(next, other)),
      shortKek: await caught(() => c.unlockWithShellBioKey(next, new Uint8Array(16))),
      notBytes: await caught(() => c.unlockWithShellBioKey(next, "not bytes")),
      flipped: await caught(() => c.unlockWithShellBioKey(flipped, kek)),
      // A vault that never had one answers the same way, in the same time.
      absent: await caught(() => c.unlockWithShellBioKey(without, kek)),
      // And the other three still open it.
      passStillWorks: !!(await c.unlockWithPassphrase(without, pass)),
      recoveryStillWorks: !!(await c.unlockWithRecoveryKey(without, recoveryKey)),
      contentAfterRemoval:
        (await c.openFromVault(without, await c.unlockWithPassphrase(without, pass))).nodes[0]
          .title === "behind a face",
      kindsAfterRemoval: without.wrappers.map((w) => w.kind).sort(),
    };
  });
  expect(r.roundtrip).toBe(true);
  expect(r.encodedLength).toBe(43);
  expect(r.kind).toBe("shell-bio-v1");
  expect(r.kdf).toBe("HKDF");
  expect(r.info).toBe("tenfold/shell-bio/v1");
  expect(r.kinds).toEqual(["passphrase", "recovery", "shell-bio-v1"]);
  expect(r.wrongKek.threw).toBe(true);
  expect(r.wrongKek.name).toBe("VaultUnlockError");
  expect(r.shortKek.threw).toBe(true);
  expect(r.notBytes.threw).toBe(true);
  expect(r.flipped.threw).toBe(true);
  expect(r.flipped.name).toBe("VaultUnlockError");
  expect(r.absent.threw).toBe(true);
  expect(r.passStillWorks).toBe(true);
  expect(r.recoveryStillWorks).toBe(true);
  expect(r.contentAfterRemoval).toBe(true);
  expect(r.kindsAfterRemoval).toEqual(["passphrase", "recovery"]);
});

test("14 the shell-bio wrapper holds no key material, and cannot be downgraded", async ({
  page,
}) => {
  const r = await page.evaluate(async (canary) => {
    const c = await import("/web/js/crypto.js");
    const { doc, caught, latin1 } = window.tf;
    const pass = "PASSPHRASE-CANARY-8831";
    const { vault, masterKey } = await c.createVault({ passphrase: pass });
    const kek = crypto.getRandomValues(new Uint8Array(32));
    let next = await c.addShellBioWrapper(vault, masterKey, kek, "shell-bio:testdevice");
    next = await c.sealIntoVault(next, masterKey, doc(canary));
    const idx = next.wrappers.findIndex((w) => w.kind === c.SHELL_BIO_KIND);
    const wrapper = next.wrappers[idx];

    // The master key in the clear, to search the wrapper's bytes for it. This
    // is the only place it is ever exported, and only so that a test can prove
    // it is not in the file.
    const masterRaw = new Uint8Array(await crypto.subtle.exportKey("raw", masterKey));
    const hay = [];
    const walk = (value) => {
      if (typeof value === "string") {
        hay.push(new TextEncoder().encode(value));
        try {
          hay.push(c.b64uDecode(value));
        } catch {
          // Not base64url; the text itself is already in the haystack.
        }
      } else if (value && typeof value === "object") {
        for (const v of Object.values(value)) walk(v);
      }
    };
    walk(wrapper);
    const contains = (needle) =>
      hay.some((bytes) => {
        if (needle.length > bytes.length) return false;
        outer: for (let i = 0; i <= bytes.length - needle.length; i += 1) {
          for (let j = 0; j < needle.length; j += 1) {
            if (bytes[i + j] !== needle[j]) continue outer;
          }
          return true;
        }
        return false;
      });

    const json = JSON.stringify(wrapper);

    // The downgrade: rewrite the wrapper as an ordinary raw one, info and all,
    // and hand the same 32 bytes to the raw unlock path. Nothing but the AAD
    // can catch this - the derived key of the rewritten wrapper is a real key,
    // it is the wrapper's own metadata that no longer matches what was sealed.
    const downgraded = JSON.parse(JSON.stringify(next));
    downgraded.wrappers[idx].kind = "raw";
    downgraded.wrappers[idx].kdf.info = "tenfold/raw-wrap/v1";

    // The same rewrite the other way round: a raw wrapper claiming to be one of
    // ours. It must not open through the shell path either. Built on a vault
    // that has no genuine shell-bio wrapper, or the unlock loop would simply
    // succeed on the real one and prove nothing about the forged one.
    const rawOnly = await c.addRawKeyWrapper(vault, masterKey, kek, "iphone");
    const promoted = JSON.parse(JSON.stringify(rawOnly));
    const rawIdx = promoted.wrappers.findIndex((w) => w.label === "iphone");
    promoted.wrappers[rawIdx].kind = c.SHELL_BIO_KIND;
    promoted.wrappers[rawIdx].kdf.info = "tenfold/shell-bio/v1";

    // Label and id rewrites, which change no derived byte at all.
    const relabelled = JSON.parse(JSON.stringify(next));
    relabelled.wrappers[idx].label = "shell-bio:someone-else";
    const reidentified = JSON.parse(JSON.stringify(next));
    reidentified.wrappers[idx].id = crypto.randomUUID();
    const resalted = JSON.parse(JSON.stringify(next));
    resalted.wrappers[idx].kdf.salt = c.b64uEncode(crypto.getRandomValues(new Uint8Array(16)));

    return {
      holdsMasterKey: contains(masterRaw),
      holdsKek: contains(kek),
      holdsPassphrase: json.includes(pass) || latin1(new TextEncoder().encode(json)).includes(pass),
      holdsCanary: json.includes(canary),
      // The KEK is 32 bytes of the shell's own randomness; a wrapper that
      // carried it would make the Keychain pointless.
      downgradeToRaw: await caught(() => c.unlockWithRawKey(downgraded, kek)),
      downgradeStillFailsOwnPath: await caught(() => c.unlockWithShellBioKey(downgraded, kek)),
      promotedRaw: await caught(() => c.unlockWithShellBioKey(promoted, kek)),
      relabelled: await caught(() => c.unlockWithShellBioKey(relabelled, kek)),
      reidentified: await caught(() => c.unlockWithShellBioKey(reidentified, kek)),
      resalted: await caught(() => c.unlockWithShellBioKey(resalted, kek)),
      // Control: untouched, it still opens.
      control: !!(await c.unlockWithShellBioKey(next, kek)),
    };
  }, CANARY);
  expect(r.holdsMasterKey).toBe(false);
  expect(r.holdsKek).toBe(false);
  expect(r.holdsPassphrase).toBe(false);
  expect(r.holdsCanary).toBe(false);
  expect(r.downgradeToRaw.threw).toBe(true);
  expect(r.downgradeStillFailsOwnPath.threw).toBe(true);
  expect(r.promotedRaw.threw).toBe(true);
  expect(r.relabelled.threw).toBe(true);
  expect(r.reidentified.threw).toBe(true);
  expect(r.resalted.threw).toBe(true);
  expect(r.control).toBe(true);
});

test("15 the vault carries an identifier of its own, and keeps it", async ({ page }) => {
  // The name the shell uses for a Keychain item. It has to exist for a vault
  // that never met a server (so: not the sync id), it has to be readable with
  // the vault locked (so: not inside the payload), and it has to survive a
  // rotation (so: carried, not regenerated).
  const r = await page.evaluate(async () => {
    const c = await import("/web/js/crypto.js");
    const { doc } = window.tf;
    const { vault, masterKey } = await c.createVault({ passphrase: "pw" });
    const id = c.vaultId(vault);

    const sealed = await c.sealIntoVault(vault, masterKey, doc("keeps its name"));
    const rotated = await c.rotateMasterKey(sealed, masterKey, { passphrase: "pw2" });

    // A vault from before this existed: no id, and one is minted on demand
    // rather than silently on read.
    const legacy = JSON.parse(JSON.stringify(vault));
    delete legacy.vid;
    const adopted = c.withVaultId(legacy);

    // An id that is not one is not accepted just because it is a string.
    const forged = JSON.parse(JSON.stringify(vault));
    forged.vid = "not/a/valid id";

    return {
      id,
      shape: c.VAULT_ID_PATTERN.source,
      matches: c.VAULT_ID_PATTERN.test(id),
      length: id.length,
      survivesSave: c.vaultId(sealed) === id,
      survivesRotation: c.vaultId(rotated.vault) === id,
      survivesJson: c.vaultId(JSON.parse(JSON.stringify(sealed))) === id,
      legacyHasNone: c.vaultId(legacy),
      mintedForLegacy: c.VAULT_ID_PATTERN.test(c.vaultId(adopted)),
      mintedIsDifferent: c.vaultId(adopted) !== id,
      idempotent: c.withVaultId(sealed) === sealed,
      forgedRejected: c.vaultId(forged),
      distinctPerVault:
        c.vaultId((await c.createVault({ passphrase: "pw" })).vault) !== id,
      // It is metadata, not a secret, and it is not derived from anything.
      notInPayload: !JSON.stringify(sealed.payload).includes(id),
    };
  });
  expect(r.matches).toBe(true);
  expect(r.length).toBe(22);
  expect(r.survivesSave).toBe(true);
  expect(r.survivesRotation).toBe(true);
  expect(r.survivesJson).toBe(true);
  expect(r.legacyHasNone).toBe(null);
  expect(r.mintedForLegacy).toBe(true);
  expect(r.mintedIsDifferent).toBe(true);
  expect(r.idempotent).toBe(true);
  expect(r.forgedRejected).toBe(null);
  expect(r.distinctPerVault).toBe(true);
  expect(r.notInPayload).toBe(true);
});
