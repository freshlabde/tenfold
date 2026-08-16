// The export inside the native shell: the web half of `fileexport`.
//
// The bug this wave fixes, stated so the tests below read as its negation: in
// a shell without this capability, `ctx.download`'s anchor click dies against
// the navigation guard (a blob: URL is not the app origin), no file exists
// anywhere, and the page still toasted "File written." - a backup reporting
// success without existing. With `fileexport` advertised, the bytes cross the
// bridge as `file.export` and the shell raises the iOS share sheet; the toast
// now waits for that ack in every world.
//
// The shell here is a stub, the same arrangement tips.spec.js uses: the same
// envelope, a scripted answer, and a message log a test can read. What is
// under test is the WEB half - which message goes out, what its fields carry,
// and which toast each answer produces. The native half (temp file, share
// sheet, cleanup) is tested in tenfold-ios/Tests/Unit/FileExportTests.
//
// The wire shape is written down in tenfold-ios/docs/BRIDGE.md and pinned
// literally on both sides, the way every bridge message is: two repositories
// on two release cycles cannot import from each other.
import { test, expect } from "@playwright/test";

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

// Pinned by hand, the way bio.spec.js pins CAP_BIO: this string and
// tenfold-ios/Sources/Bridge/FileExport.swift are two independent statements
// of the name, and a drift has to fail here rather than agree with itself.
const CAP = "fileexport";
const TYPE = "file.export";

test.describe.configure({ mode: "parallel", timeout: 240_000 });

/** A shell whose `file.export` answers as scripted. */
async function stubShell(page, opts = {}) {
  await page.addInitScript((config) => {
    const messages = [];
    window.__shellMessages = messages;
    let nextId = 1;
    window.__tenfoldShell = {
      platform: "ios",
      version: "0.7.0 (17)",
      loader: "scheme://app",
      origin: String(location.origin),
      capabilities: config.capabilities,
      post(message) {
        messages.push(message);
        return true;
      },
      send(message) {
        const envelope = { id: `s${nextId++}` };
        const flat = Object.assign(envelope, message);
        messages.push(flat);
        const head = { type: message.type, replyTo: flat.id };
        if (message.type === "file.export") {
          return Promise.resolve({ ...head, ok: config.exportOk !== false });
        }
        return Promise.resolve({ ...head, ok: true, enabled: false, permission: "notDetermined" });
      },
      request() {
        return Promise.resolve({ type: "pong" });
      },
      _receive() {},
    };
  }, {
    capabilities: opts.capabilities || ["reminder", "badge", "widget", CAP],
    exportOk: opts.exportOk,
  });
}

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
  await page.waitForSelector(".keygrid", { timeout: 30000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start empty/ }).click();
  await page.getByRole("button", { name: "Not now" }).click();
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
}

async function openSettings(page) {
  await page.getByRole("button", { name: "Open settings" }).click();
}

function exportRow(page) {
  return page.getByRole("button", { name: /Export the encrypted vault/ });
}

test("with the capability, the bytes cross the bridge and the toast waits for the ack", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await openSettings(page);

  await exportRow(page).click();
  await expect(page.locator(".toast")).toHaveText("File written.");

  const message = await page.evaluate(
    (type) => window.__shellMessages.find((m) => m.type === type),
    TYPE,
  );
  expect(message).toBeTruthy();
  // The suggested browser filename, unchanged: tenfold-YYYY-MM-DD.tenfold.
  expect(message.name).toMatch(/^tenfold-\d{4}-\d{2}-\d{2}\.tenfold$/);
  // What crosses is the vault FILE - ciphertext with its envelope - and never
  // the document. Parseable, and carrying none of the plaintext markers the
  // shell's own mirror gate refuses.
  const parsed = JSON.parse(message.text);
  for (const key of ["nodes", "doc", "plaintext", "settings"]) {
    expect(Object.prototype.hasOwnProperty.call(parsed, key)).toBe(false);
  }
});

test("a refusing shell produces the failure toast and no success stamp", async ({ page }) => {
  await stubShell(page, { exportOk: false });
  await freshApp(page);
  await setupVault(page);
  await openSettings(page);

  await exportRow(page).click();
  await expect(page.locator(".toast")).toHaveText("Export failed. Nothing was written.");

  // The un-exported marker logic hangs off doc.settings.exportedAt; the row
  // above it is the visible witness that nothing was stamped.
  await expect(page.getByText("File written.")).toHaveCount(0);
});

test("a shell without the capability keeps the browser anchor path", async ({ page }) => {
  await stubShell(page, { capabilities: ["reminder", "badge", "widget"] });
  await freshApp(page);
  await setupVault(page);
  await openSettings(page);

  const download = page.waitForEvent("download");
  await exportRow(page).click();
  expect(await (await download).path()).toBeTruthy();
  await expect(page.locator(".toast")).toHaveText("File written.");

  const crossed = await page.evaluate(
    (type) => window.__shellMessages.some((m) => m.type === type),
    TYPE,
  );
  expect(crossed).toBe(false);
});
