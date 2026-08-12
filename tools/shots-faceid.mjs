// tools/shots-faceid.mjs - the fourth envelope, both surfaces of it.
//
//   PORT=7712 TENFOLD_DATA=/tmp/tenfold-shot-data node tools/serve.js &
//   BASE=http://127.0.0.1:7712 node tools/shots-faceid.mjs
//
// Writes design/screens/71-faceid-enable.png (the security group inside the
// shell, with the row that arms Face ID) and 72-faceid-lock.png (the lock
// screen with the biometric button above the passphrase field) at the reference
// iPhone size.
//
// The shell is a stub - the same one tests/bio.spec.js installs - because the
// real one lives in another repository and needs a simulator. What the pictures
// therefore show is honest about the WEB half and nothing more: the row, the
// button, the words. The system's own Face ID sheet is drawn by iOS and appears
// in no screenshot taken here; tenfold-ios/docs/screens/w3-faceid-prompt.png is
// where that one lives.
//
// The lock shot is taken after a cancelled prompt, which is why the button is
// still on screen: the automatic first attempt has run and been dismissed, and
// cancelling says nothing and takes nothing away.
// Not part of the test suite - this is for looking.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

const browser = await chromium.launch();
const problems = [];

const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => problems.push(`PAGEERROR ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`CONSOLE ${m.text()}`);
});

// The shell, as far as the page can tell: capabilities including `bio`, a
// device with Face ID enrolled, and a Keychain that is a plain object.
await page.addInitScript(() => {
  window.__bio = { keys: {}, unwrapCode: null };
  const b64u = (bytes) => {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const answer = (m) => {
    const s = window.__bio;
    if (m.type === "bio.available") {
      return { type: m.type, available: true, enrolled: true, biometryType: "faceID" };
    }
    if (m.type === "bio.createKey") {
      const key = b64u(crypto.getRandomValues(new Uint8Array(32)));
      s.keys[m.vaultId] = key;
      return { type: m.type, ok: true, key };
    }
    if (m.type === "bio.unwrapKey") {
      if (s.unwrapCode) return { type: m.type, ok: false, code: s.unwrapCode };
      const key = s.keys[m.vaultId];
      return key ? { type: m.type, ok: true, key } : { type: m.type, ok: false, code: "missing" };
    }
    if (m.type === "bio.deleteKey" || m.type === "vault.wiped") {
      delete s.keys[m.vaultId];
      return { type: m.type, ok: true };
    }
    return { type: m.type, ok: true, enabled: false, permission: "notDetermined" };
  };
  let n = 1;
  window.__tenfoldShell = {
    platform: "ios",
    version: "0.3.0 (3)",
    loader: "scheme://app",
    origin: String(location.origin),
    capabilities: ["reminder", "badge", "widget", "bio"],
    post: () => true,
    send: (m) => Promise.resolve({ ...answer(m), replyTo: `s${n++}` }),
    request: () => Promise.resolve({ type: "pong", replyTo: `s${n++}` }),
    _receive(m) {
      if (m && typeof m === "object") window.dispatchEvent(new CustomEvent("tenfoldshell", { detail: m }));
    },
  };
  // No Badging API in a WKWebView, so the badge takes the bridge as well.
  Object.defineProperty(navigator, "setAppBadge", { configurable: true, writable: true, value: undefined });
  Object.defineProperty(navigator, "clearAppBadge", { configurable: true, writable: true, value: undefined });
});

await page.goto(`${BASE}/web/index.html`);
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

// The first run, no server copy.
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
await page.waitForSelector(".h-title");

// One goal, so the app is not empty behind the screens.
await page.getByRole("button", { name: /Write the first one|New entry/ }).click();
await page.locator(".composer input").fill("Get the knee fixed");
await page.locator(".composer input").press("Enter");
await page.locator(".composer input").press("Escape");

const dropToast = () =>
  page.evaluate(() => {
    const el = document.getElementById("toast");
    if (el) el.remove();
  });

// ------------------------------------------------------- the security surface

await page.getByRole("button", { name: "Open settings", exact: true }).click();
await page.waitForSelector(".h-title");
const row = page.locator(".setrow").filter({ hasText: "Unlock with face or fingerprint" });
await row.waitFor({ timeout: 15000 });
await row.scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
console.log(`row: ${(await row.textContent()).replace(/\s+/g, " ").trim()}`);
await dropToast();
await page.screenshot({ path: "design/screens/71-faceid-enable.png" });
console.log("wrote 71-faceid-enable");

// ------------------------------------------------------------ the lock screen

await row.click();
await page.waitForTimeout(600);
console.log(
  `wrappers: ${await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return ctx.vault.wrappers.map((w) => w.kind).join(", ");
  })}`,
);

// Cancelled, so the screen stays where somebody can look at it: the automatic
// attempt has run, the sheet was dismissed, and nothing was said about it.
await page.evaluate(() => {
  window.__bio.unwrapCode = "cancelled";
});
await page.evaluate(async () => {
  const { ctx } = await import("/web/js/app.js");
  await ctx.lock();
});
await page.waitForSelector(".lock-title");
await page.waitForSelector('[data-bio="shell"]');
await page.waitForTimeout(600);
await dropToast();
await page.screenshot({ path: "design/screens/72-faceid-lock.png" });
console.log("wrote 72-faceid-lock");

await context.close();
console.log(problems.length ? problems : "no console problems");
await browser.close();
