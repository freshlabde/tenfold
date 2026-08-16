// The emergency sheet inside the native shell: the web half of `print`.
//
// The bug, stated so the tests read as its negation: `window.print()` is a
// no-op in a WKWebView, so "Save the emergency sheet" did exactly nothing in
// the shell - no dialog, no error, and the one page that gets you back into
// your list could not be made. With the `print` capability advertised the
// page sends `page.print` and the shell raises the iOS print panel; without
// it (older shell, every browser) the window.print() path stands unchanged.
//
// Same stub arrangement as fileexport.spec.js; the native half (the panel,
// the formatter, the reply) is pinned in tenfold-ios Tests/Unit.
import { test, expect } from "@playwright/test";

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };
const CAP = "print";
const TYPE = "page.print";

test.describe.configure({ mode: "parallel", timeout: 240_000 });

async function stubShell(page, opts = {}) {
  await page.addInitScript((config) => {
    const messages = [];
    window.__shellMessages = messages;
    let nextId = 1;
    window.__tenfoldShell = {
      platform: "ios",
      version: "0.7.0 (18)",
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
        if (message.type === "page.print") {
          return Promise.resolve({ ...head, ok: config.printOk !== false });
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
    printOk: opts.printOk,
  });
}

/** Walk setup as far as the recovery-key step, where the button lives. */
async function keyStep(page) {
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
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 30000 });
}

test("with the capability, the sheet is built and page.print crosses the bridge", async ({ page }) => {
  await stubShell(page);
  await keyStep(page);

  await page.getByRole("button", { name: "Save the emergency sheet" }).click();

  const crossed = await page.evaluate(
    (type) => window.__shellMessages.some((m) => m.type === type),
    TYPE,
  );
  expect(crossed).toBe(true);
  // The reply said ok, so the paper stays for the panel's lazy formatter -
  // the 120-second belt is its cleanup, not this test's business. What IS its
  // business: the region exists, and it carries the key and the QR.
  await expect(page.locator("#paper")).toHaveCount(1);
  await expect(page.locator("#paper svg").first()).toBeVisible({ visible: false });
});

test("a refusing shell takes the paper down instead of parking the key in the DOM", async ({ page }) => {
  await stubShell(page, { printOk: false });
  await keyStep(page);

  await page.getByRole("button", { name: "Save the emergency sheet" }).click();
  await expect(page.locator("#paper")).toHaveCount(0);
});

test("a shell without the capability keeps the window.print path", async ({ page }) => {
  await stubShell(page, { capabilities: ["reminder", "badge", "widget"] });
  await keyStep(page);

  // window.print() blocks in headless Chromium; stub it to a visible fact.
  await page.evaluate(() => {
    window.__printed = 0;
    window.print = () => { window.__printed += 1; };
  });
  await page.getByRole("button", { name: "Save the emergency sheet" }).click();
  expect(await page.evaluate(() => window.__printed)).toBe(1);

  const crossed = await page.evaluate(
    (type) => window.__shellMessages.some((m) => m.type === type),
    TYPE,
  );
  expect(crossed).toBe(false);
});
