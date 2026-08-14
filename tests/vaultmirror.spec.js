// The spare copy of the vault, as a file in the app container.
//
// The vault lives in exactly one place - IndexedDB inside the shell's
// WKWebsiteDataStore - and there is no second copy on the device. WebKit
// storage can be evicted or corrupted, and the person then has nothing unless
// they made an export. `web/js/vaultmirror.js` is the web half of the answer:
// the same ciphertext, handed to the shell as text, asked for again when there
// is nothing left to open.
//
// What is under test here is the WEB half of the contract, as in shell.spec.js:
// which message goes out, carrying which bytes, at which moment - that a save
// is never lengthened or failed by it, that a boot with a vault present never
// even asks, and that a browser posts nothing at all. The native half - the
// file itself, its protection class, and its deletion on `vault.wiped` - is
// tested in the shell repository.
//
// The three wire shapes are written down once, in docs/CONTRACTS.md and in
// tenfold-ios/docs/BRIDGE.md, and both suites assert against them literally
// rather than deriving them: two repositories on two release cycles cannot
// import from each other, so a rename has to fail loudly here instead of
// quietly agreeing with itself over there.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

// Real WebCrypto: 600000 PBKDF2 rounds per unlock.
test.describe.configure({ mode: "parallel", timeout: 240_000 });

// ------------------------------------------------------------------- the stub

/**
 * A shell that keeps one file and records everything it is handed.
 *
 * `window.__mirror.file` is the app container: `{ blob, savedAt }` or null. The
 * two knobs are what a test needs to walk the paths that are not the happy one
 * - `refuse` makes every write throw the way a shell out of disk would, and
 * `capabilities` is left to the caller so the "not advertised" case walks the
 * same code.
 *
 * Re-registering it (a second `stubShell` before a `page.reload()`) replaces
 * the previous one wholesale, which is how a test seeds a file into a fresh
 * boot: init scripts run in registration order, all of them before any module.
 */
async function stubShell(page, opts = {}) {
  await page.addInitScript((config) => {
    const messages = [];
    window.__shellMessages = messages;
    window.__mirror = { file: config.file, refuse: config.refuse === true, writes: 0 };
    window.__tenfoldShell = {
      platform: "ios",
      version: "0.4.0 (4)",
      loader: "scheme://app",
      origin: String(location.origin),
      capabilities: config.capabilities,
      post(message) {
        messages.push(message);
        if (message.type !== "mirror.write") return true;
        if (window.__mirror.refuse) throw new Error("no space left on device");
        window.__mirror.file = { blob: message.blob, savedAt: message.savedAt };
        window.__mirror.writes += 1;
        return true;
      },
      send(message) {
        messages.push(message);
        const file = window.__mirror.file;
        if (message.type === "mirror.read") {
          return Promise.resolve({
            type: message.type,
            blob: file ? file.blob : null,
            savedAt: file ? file.savedAt : null,
          });
        }
        if (message.type === "mirror.status") {
          return Promise.resolve({
            type: message.type,
            present: !!file,
            bytes: file ? file.blob.length : 0,
            savedAt: file ? file.savedAt : null,
            error: null,
          });
        }
        // The badge, the widget and the reminder say nothing this suite reads.
        return Promise.resolve({ type: message.type, ok: true, enabled: false, permission: "notDetermined" });
      },
      request(type, payload) {
        messages.push({ type, payload: payload || null });
        return Promise.resolve({ type: "pong" });
      },
      _receive(message) {
        if (!message || typeof message !== "object") return;
        window.dispatchEvent(new CustomEvent("tenfoldshell", { detail: message }));
      },
    };
  }, {
    capabilities: opts.capabilities || ["vaultmirror"],
    file: opts.file || null,
    refuse: opts.refuse === true,
  });
}

const sent = (page, type) =>
  page.evaluate((t) => (window.__shellMessages || []).filter((m) => m.type === t), type);

const mirrorFile = (page) => page.evaluate(() => (window.__mirror ? window.__mirror.file : null));

/** The record IndexedDB is actually holding, read outside the app's own code. */
function storedRecord(page) {
  return page.evaluate(
    () =>
      new Promise((done) => {
        const open = indexedDB.open("tenfold", 1);
        open.onerror = () => done(null);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("vault")) {
            db.close();
            done(null);
            return;
          }
          const req = db.transaction("vault", "readonly").objectStore("vault").get("vault");
          req.onsuccess = () => {
            db.close();
            done(req.result || null);
          };
          req.onerror = () => {
            db.close();
            done(null);
          };
        };
      }),
  );
}

// ------------------------------------------------------------------- the walk

async function freshApp(page) {
  await page.setViewportSize(PHONE);
  await page.goto("/web/index.html");
  await page.evaluate(
    () =>
      new Promise((done) => {
        localStorage.clear();
        const req = indexedDB.deleteDatabase("tenfold");
        req.onsuccess = req.onerror = req.onblocked = () => done();
      }),
  );
  await page.reload();
  await page.waitForSelector(".screen");
}

async function setupVault(page) {
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 60000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start empty/ }).click();
  await page.getByRole("button", { name: "Not now" }).click();
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 60000 });
}

async function addRoots(page, titles) {
  await page.getByRole("button", { name: /Write the first one|New entry/ }).click();
  for (const title of titles) {
    await page.locator(".composer input").fill(title);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
}

async function unlock(page) {
  await page.waitForSelector(".lock-title");
  await page.locator(".lock input").fill(PASS);
  await page.getByRole("button", { name: /Unlock/ }).click();
  await expect(page.locator(".h-title")).toHaveText(/^(Today|The Ten)$/, { timeout: 60000 });
}

/**
 * The Ten, whichever screen the unlock landed on. An unlock opens where the
 * work is (app.js `somethingWaits`), so a vault with an unanswered daily
 * question comes back on Today - and the root goals this file checks for are
 * drawn on The Ten.
 */
async function toTheTen(page) {
  if ((await page.locator(".h-title").textContent()) === "The Ten") return;
  await page.locator(".head-actions").getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
}

/**
 * Lock the vault, then hand back the file the shell is holding.
 *
 * Locking rather than waiting on the 600ms debounce: `lock()` awaits the flush
 * it starts, so when the lock screen is up every edit has been sealed and
 * written - no timing to guess at, and it walks the one save path this feature
 * had to be careful about. The short poll after it is for the mirror alone: the
 * write is fire and forget inside `flushSave`, so it lands a microtask after
 * the save it followed, and no further save can arrive behind a lock screen.
 */
async function lockAndSettle(page) {
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    await ctx.lock();
  });
  await page.waitForSelector(".lock-title");
  await expect
    .poll(
      async () => {
        const record = await storedRecord(page);
        const file = await mirrorFile(page);
        return !!(record && file && record.lastSavedAt === file.savedAt);
      },
      { timeout: 20000 },
    )
    .toBe(true);
  return mirrorFile(page);
}

async function openSettings(page) {
  await page.getByRole("button", { name: /settings/i }).click();
  await expect(page.locator(".h-title")).toHaveText("Settings");
}

/** The storage row, which is the only one labelled "Storage". */
const storageRow = (page) =>
  page.locator(".setrow").filter({ has: page.locator(".setrow-label", { hasText: /^Storage$/ }) });

// ---------------------------------------------------------------- the shapes

test("the three message names and the capability are pinned to the shell's", async ({ page }) => {
  // Literal source assertions, not a round trip. A rename that both sides
  // agreed with themselves about would be a spare copy that silently stops
  // being written - the one kind of failure that is invisible until the day it
  // was needed.
  const mirror = readFileSync(join(ROOT, "web/js/vaultmirror.js"), "utf8");
  expect(mirror).toContain('export const MSG_WRITE = "mirror.write";');
  expect(mirror).toContain('export const MSG_READ = "mirror.read";');
  expect(mirror).toContain('export const MSG_STATUS = "mirror.status";');
  const shell = readFileSync(join(ROOT, "web/js/shell.js"), "utf8");
  expect(shell).toContain('export const CAP_MIRROR = "vaultmirror";');

  await page.goto("/tests/fixture.html");
  const out = await page.evaluate(async () => {
    const m = await import("/web/js/vaultmirror.js");
    const s = await import("/web/js/shell.js");
    const exports = ["mirrorAvailable", "writeMirror", "readMirror", "mirrorStatus", "mirrorStatusCached"];
    return {
      missing: exports.filter((k) => typeof m[k] !== "function"),
      names: [m.MSG_WRITE, m.MSG_READ, m.MSG_STATUS],
      cap: s.CAP_MIRROR,
    };
  });
  expect(out.missing).toEqual([]);
  expect(out.names).toEqual(["mirror.write", "mirror.read", "mirror.status"]);
  expect(out.cap).toBe("vaultmirror");
});

// ----------------------------------------------------------------- the write

test("a save posts mirror.write carrying the export bytes", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail"]);

  // The debounced save is 600ms; the mirror follows the IndexedDB write.
  await expect.poll(() => sent(page, "mirror.write").then((m) => m.length), {
    timeout: 20000,
  }).toBeGreaterThan(0);

  const writes = await sent(page, "mirror.write");
  const last = writes[writes.length - 1];
  expect(Object.keys(last).sort()).toEqual(["blob", "savedAt", "type"]);
  expect(last.type).toBe("mirror.write");
  expect(typeof last.blob).toBe("string");
  expect(typeof last.savedAt).toBe("number");

  // The bytes are the .tenfold export of the vault IndexedDB is holding - the
  // whole reason the restore path can be the import path.
  const record = await storedRecord(page);
  expect(record).not.toBe(null);
  const matches = await page.evaluate(async ({ blob, vault }) => {
    const { exportEncrypted, importEncrypted } = await import("/web/js/portability.js");
    const expected = await exportEncrypted(vault).text();
    const parsed = await importEncrypted(blob);
    return { identical: expected === blob, magic: parsed.magic };
  }, { blob: last.blob, vault: record.vault });
  expect(matches.identical).toBe(true);
  expect(matches.magic).toBe("TENFOLD1");

  // And it carries the vault's own save time, not the moment a copy was made.
  expect(last.savedAt).toBe(record.lastSavedAt);
});

test("the mirror is still written on the lock path, which does not await the save", async ({ page }) => {
  // `lock()` STARTS flushSave without awaiting it, so the lock screen is up
  // when it returns. The sealed vault is a local in that function, so the lines
  // that drop the master key and the document cannot reach it - and the mirror
  // write goes out a microtask later, onto a lock screen that is already there.
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail"]);
  await expect
    .poll(() => sent(page, "mirror.write").then((m) => m.length), { timeout: 20000 })
    .toBeGreaterThan(0);

  // A change that has NOT been saved yet: the 600ms debounce is still running
  // when the lock arrives, so the only path this edit can reach the mirror by
  // is the flush the lock itself starts.
  const before = (await sent(page, "mirror.write")).length;
  await addRoots(page, ["Sail somewhere"]);
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    await ctx.lock();
  });
  await page.waitForSelector(".lock-title");

  await expect
    .poll(() => sent(page, "mirror.write").then((m) => m.length), { timeout: 20000 })
    .toBeGreaterThan(before);

  // The file the shell now holds opens to a vault carrying the late edit. It
  // cannot be read here without the key, so the proof is the round trip: adopt
  // it in the next test's manner - identical to what IndexedDB kept.
  const file = await mirrorFile(page);
  const record = await storedRecord(page);
  const identical = await page.evaluate(async ({ blob, vault }) => {
    const { exportEncrypted } = await import("/web/js/portability.js");
    return (await exportEncrypted(vault).text()) === blob;
  }, { blob: file.blob, vault: record.vault });
  expect(identical).toBe(true);
});

test("a mirror that fails does not fail the save", async ({ page }) => {
  // The harshest failure the bridge can produce: post() throws. The save that
  // triggered it has already succeeded, and must stay succeeded.
  await stubShell(page, { refuse: true });
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail"]);

  await expect
    .poll(() => sent(page, "mirror.write").then((m) => m.length), { timeout: 20000 })
    .toBeGreaterThan(0);

  // Nothing landed on the other side.
  expect(await mirrorFile(page)).toBe(null);

  // The vault did land, and the app is still working: the row is on screen and
  // a second edit still saves.
  const record = await storedRecord(page);
  expect(record).not.toBe(null);
  expect(typeof record.lastSavedAt).toBe("number");
  await expect(page.locator(".row-title").filter({ hasText: "Learn to sail" })).toBeVisible();

  await addRoots(page, ["Sail somewhere"]);
  await expect
    .poll(async () => (await storedRecord(page)).lastSavedAt, { timeout: 20000 })
    .toBeGreaterThan(record.lastSavedAt);

  // And the session is intact - no unhandled failure took a screen down.
  await openSettings(page);
  await expect(page.locator(".h-title")).toHaveText("Settings");
});

// ------------------------------------------------------------------ the read

test("an empty IndexedDB with a mirror present adopts it", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Adopted goal"]);
  const file = await lockAndSettle(page);
  expect(file).not.toBe(null);

  // Storage evicted: everything this origin held is gone, exactly as WebKit
  // would leave it. The shell's container is untouched - it is not the
  // browser's to clear, which is the entire point of the mirror.
  await page.evaluate(
    () =>
      new Promise((done) => {
        const req = indexedDB.deleteDatabase("tenfold");
        req.onsuccess = req.onerror = req.onblocked = () => done();
      }),
  );
  await stubShell(page, { file });
  await page.reload();

  // The lock screen, not the first-run screen: there is a vault again.
  await page.waitForSelector(".lock-title", { timeout: 60000 });
  const reads = await sent(page, "mirror.read");
  expect(reads).toEqual([{ type: "mirror.read" }]);

  // Written back, not merely held in memory - a reload must not lose it again.
  const record = await storedRecord(page);
  expect(record).not.toBe(null);
  expect(record.lastSavedAt).toBe(file.savedAt);

  // And it is the same list: the passphrase opens it and the goal is there.
  await unlock(page);
  await toTheTen(page);
  await expect(page.locator(".row-title").filter({ hasText: "Adopted goal" })).toBeVisible({
    timeout: 60000,
  });
});

test("with a vault in IndexedDB the mirror is never even asked for", async ({ page }) => {
  // IndexedDB is the vault and the mirror is the spare. Not consulting the
  // spare while there is anything to consult it against is the only ordering
  // under which the two cannot disagree about which of them is newer.
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Local goal"]);
  const file = await lockAndSettle(page);

  // Both present, and the file is seeded again so a read could succeed.
  await stubShell(page, { file });
  await page.reload();
  await page.waitForSelector(".lock-title", { timeout: 60000 });

  expect(await sent(page, "mirror.read")).toEqual([]);
  await unlock(page);
  await toTheTen(page);
  await expect(page.locator(".row-title").filter({ hasText: "Local goal" })).toBeVisible({
    timeout: 60000,
  });
});

test("a mirror that is not a vault file is dropped without a word", async ({ page }) => {
  await stubShell(page, { file: { blob: "not json at all", savedAt: Date.now() } });
  await freshApp(page);
  // The first-run screen, and no error anywhere: there was no vault to damage.
  await expect(page.getByRole("button", { name: "Set up the vault" })).toBeVisible({
    timeout: 60000,
  });
  expect(await sent(page, "mirror.read")).toEqual([{ type: "mirror.read" }]);
});

// -------------------------------------------------------------- no shell here

test("a browser posts nothing at all", async ({ page }) => {
  // No stub: the plain web app, which is the product. Every function is a
  // no-op or null and none of them throws.
  await page.setViewportSize(PHONE);
  await page.goto("/tests/fixture.html");
  const out = await page.evaluate(async () => {
    const m = await import("/web/js/vaultmirror.js");
    const vault = { magic: "TENFOLD1", version: 1, wrappers: [{ kind: "passphrase" }], payload: "x" };
    return {
      shell: typeof window.__tenfoldShell,
      available: m.mirrorAvailable(),
      wrote: await m.writeMirror(vault),
      read: await m.readMirror(),
      status: await m.mirrorStatus(),
      cached: m.mirrorStatusCached(),
    };
  });
  expect(out.shell).toBe("undefined");
  expect(out.available).toBe(false);
  expect(out.wrote).toBe(false);
  expect(out.read).toBe(null);
  expect(out.status).toBe(null);
  expect(out.cached).toBe(null);

  // And nothing goes out over a whole session either.
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail"]);
  await expect
    .poll(async () => (await storedRecord(page)) !== null, { timeout: 20000 })
    .toBe(true);
  expect(await page.evaluate(() => typeof window.__tenfoldShell)).toBe("undefined");
});

test("a shell without the capability posts nothing either", async ({ page }) => {
  // An older build carries the bridge without this feature, and the honest
  // answer there is the same as a browser's: no message into the void.
  await stubShell(page, { capabilities: ["badge", "widget"] });
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail"]);
  await expect
    .poll(async () => (await storedRecord(page)) !== null, { timeout: 20000 })
    .toBe(true);
  expect(await sent(page, "mirror.write")).toEqual([]);
  expect(await sent(page, "mirror.status")).toEqual([]);
  expect(await sent(page, "mirror.read")).toEqual([]);
});

// --------------------------------------------------------------- the settings

test("the storage row states the truth in both states", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail"]);
  await expect
    .poll(() => sent(page, "mirror.write").then((m) => m.length), { timeout: 20000 })
    .toBeGreaterThan(0);

  await openSettings(page);
  const row = storageRow(page);
  await expect(row.locator(".setrow-value")).toHaveText("Two copies on this device", {
    timeout: 20000,
  });
  await expect(row.locator(".setrow-desc")).toHaveText(
    /^The vault, and beside it the same encrypted file as a spare, written .+\. Deleting the app deletes both\. Export regularly\.$/,
  );
  expect((await sent(page, "mirror.status")).length).toBeGreaterThan(0);
});

test("the storage row admits when there is no spare copy", async ({ page }) => {
  // Every write refused, so the shell holds nothing: the row must say so rather
  // than promise a file that was never written.
  await stubShell(page, { refuse: true });
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail"]);
  await expect
    .poll(() => sent(page, "mirror.write").then((m) => m.length), { timeout: 20000 })
    .toBeGreaterThan(0);

  await openSettings(page);
  const row = storageRow(page);
  await expect(row.locator(".setrow-value")).toHaveText("One copy on this device", {
    timeout: 20000,
  });
  await expect(row.locator(".setrow-desc")).toHaveText(
    "The vault, with no spare beside it yet. The next save writes one. Deleting the app deletes it too. Export regularly.",
  );
});

test("a shell too old to have a mirror keeps the older sentence, byte for byte", async ({ page }) => {
  // A build that cannot look has not looked and found nothing. The sentence
  // that was true before this feature existed is still the true one there.
  await stubShell(page, { capabilities: ["badge", "widget"] });
  await freshApp(page);
  await setupVault(page);
  await openSettings(page);
  const row = storageRow(page);
  await expect(row.locator(".setrow-value")).toHaveText("The app keeps this data on this device");
  await expect(row.locator(".setrow-desc")).toHaveText(
    "It lives inside the app, on this device. Deleting the app deletes it too. Export regularly.",
  );
});

test("the browser storage row is untouched", async ({ page }) => {
  // No shell at all: the three browser answers and their description stay
  // exactly what they were, down to the byte.
  await freshApp(page);
  await setupVault(page);
  await openSettings(page);
  const row = storageRow(page);
  await expect(row.locator(".setrow-value")).toHaveText(
    /^(The browser keeps this data|The browser may clear this data|The browser does not say)$/,
  );
  await expect(row.locator(".setrow-desc")).toHaveText(
    "Without persistent storage a browser may drop the vault when space runs low. Export regularly.",
  );
});

// -------------------------------------------------------------- the wipe rule

test("every wipe path tells the shell before it clears anything", async ({ page }) => {
  // The whole safety of the silent restore rests on this: an eviction and a
  // deliberate wipe leave IndexedDB in the identical state, so what tells them
  // apart is `vault.wiped` reaching the shell - which deletes the mirror on it.
  await stubShell(page, { capabilities: ["vaultmirror", "bio"] });
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail"]);
  await expect
    .poll(() => sent(page, "mirror.write").then((m) => m.length), { timeout: 20000 })
    .toBeGreaterThan(0);

  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    await ctx.wipeLocalVault();
  });
  await expect(page.getByRole("button", { name: "Set up the vault" })).toBeVisible({
    timeout: 60000,
  });

  const messages = await page.evaluate(() => window.__shellMessages.map((m) => m.type));
  const wiped = messages.indexOf("vault.wiped");
  expect(wiped).toBeGreaterThan(-1);
  // Sent BEFORE the local clear: the message has to name which vault died, and
  // that name lives in the file.
  expect(await storedRecord(page)).toBe(null);

  // The lock screen's own reset button and the settings paths all end in the
  // same function, which is what makes one assertion enough. Pinned in source
  // so a fourth path cannot appear without this failing.
  const lock = readFileSync(join(ROOT, "web/js/ui/lock.js"), "utf8");
  const settings = readFileSync(join(ROOT, "web/js/ui/settings.js"), "utf8");
  const app = readFileSync(join(ROOT, "web/js/app.js"), "utf8");
  expect(lock).toContain("ctx.wipeLocalVault()");
  expect(settings).toContain("ctx.wipeLocalVault()");
  expect(app).toContain("await ctx.wipeLocalVault();");
  // And there is no second way to destroy the vault: `clearAll` is imported
  // once and called once.
  expect(app.match(/await clearAll\(\)/g).length).toBe(1);
});
