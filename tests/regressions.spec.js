// Regressions reported from real desktop use on 2026-08-08:
//
// 1. A plain mouse hover swiped rows away (pointermove without pointerdown
//    used stale start coordinates), leaving only the amber check layer
//    visible - titles gone in both themes.
// 2. The language could not be chosen before the vault exists: the lock and
//    setup screens had no switch and the app silently used browser detection.
//
// Plus the guard the wave-2 report asked for: the hand-maintained service
// worker precache list must never drift from the files actually on disk.
import { test, expect } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

async function freshApp(page, viewport = PHONE) {
  await page.setViewportSize(viewport);
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

async function setupVault(page, { frame = false } = {}) {
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 30000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: frame ? /Start with a frame/ : /Start empty/ }).click();
  // First entry into a vault offers the About text once; dismiss it.
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
}

test("the About intro appears exactly once per vault", async ({ page }) => {
  await freshApp(page);
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 30000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start empty/ }).click();

  // The intro: the About prose with a single Begin action.
  await expect(page.locator(".prose")).toBeVisible();
  await expect(page.locator(".prose .prose-list li").first()).toBeVisible();
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");

  // Lock and unlock again: straight to the outline, no second intro.
  await page.reload();
  await page.waitForSelector(".lock-title");
  await page.locator('input[type="password"]').fill(PASS);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 30000 });
});

test("a mouse hover over rows never swipes them away", async ({ page }) => {
  // Desktop-sized viewport: this is a mouse-only regression.
  await freshApp(page, { width: 1100, height: 800 });
  await setupVault(page, { frame: true });

  const rows = page.locator(".row");
  const count = await rows.count();
  expect(count).toBeGreaterThan(3);

  // Sweep the pointer across several rows the way a trackpad user would.
  for (let i = 0; i < Math.min(count, 5); i++) {
    const box = await rows.nth(i).boundingBox();
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2, { steps: 8 });
  }
  await page.waitForTimeout(150);

  for (let i = 0; i < Math.min(count, 5); i++) {
    const transform = await rows.nth(i).evaluate((el) => getComputedStyle(el).transform);
    expect(transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)").toBe(true);
  }
  const behinds = page.locator(".row-behind");
  for (let i = 0; i < Math.min(await behinds.count(), 5); i++) {
    const opacity = await behinds.nth(i).evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(opacity)).toBe(0);
  }
  // And every title is still readable.
  await expect(page.locator(".row-title").first()).toBeVisible();
});

test("the language can be chosen on the setup screen before any vault exists", async ({ page }) => {
  await freshApp(page);
  const switcher = page.locator(".lang-switch");
  await expect(switcher).toBeVisible();

  await switcher.getByRole("button", { name: "Español" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  // The welcome headline is now Spanish, not detection-driven.
  await expect(page.locator(".lock-title")).not.toHaveText(/Ten things|Zehn Dinge/);

  // The choice survives a reload while still locked/unset.
  await page.reload();
  await page.waitForSelector(".screen");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");

  // And it is folded into the vault created afterwards.
  await page.locator(".lang-switch").getByRole("button", { name: "English" }).click();
  await setupVault(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("the language switch is also on the lock screen", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await page.getByRole("button", { name: /settings/i }).click().catch(() => {});
  // Lock via the settings row; fall back to reload which lands on the lock screen.
  await page.reload();
  await page.waitForSelector(".lock-title");
  await expect(page.locator(".lang-switch")).toBeVisible();
  await page.locator(".lang-switch").getByRole("button", { name: "Deutsch" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
});

test("abuse limits: creation cap and rate limit apply to tunnel clients", async ({ request }) => {
  // A forged cf-connecting-ip marks the request as coming through the tunnel,
  // so the limits apply (plain loopback without the header is exempt).
  const vault = { magic: "TENFOLD1", version: 1, wrappers: [{ kind: "passphrase" }], payload: { nonce: "x", ct: "y" } };
  const id = () => {
    const alphabet = "abcdefghjkmnpqrstvwxyz23456789".replace(/[ilou01]/g, "");
    let s = "";
    for (let i = 0; i < 26; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  };

  // Creation cap: 10 fresh ids per IP per day, the 11th is refused.
  const creator = { "cf-connecting-ip": "203.0.113.7" };
  let refused = false;
  for (let i = 0; i < 11; i++) {
    const r = await request.put(`/api/vault/${id()}`, {
      headers: { ...creator, "X-Sync-Token": "test-token-16-chars-long", "X-If-Version": "0" },
      data: { vault },
    });
    if (i < 10) expect(r.status()).toBe(200);
    else refused = r.status() === 429;
  }
  expect(refused).toBe(true);

  // Rate limit: 60 API requests per minute per IP, the 61st is refused.
  const reader = { "cf-connecting-ip": "203.0.113.8" };
  let limited = false;
  for (let i = 0; i < 61; i++) {
    const r = await request.get(`/api/vault/${"a".repeat(26)}`, { headers: reader });
    if (i === 60) limited = r.status() === 429;
    else expect([404, 200]).toContain(r.status());
  }
  expect(limited).toBe(true);

  // Loopback without the header stays exempt (the whole rest of the suite
  // depends on this, but assert it explicitly once).
  const r = await request.get(`/api/vault/${"a".repeat(26)}`);
  expect(r.status()).toBe(404);
});

test("the service worker precache list matches the files on disk", async () => {
  const sw = await readFile(join(ROOT, "web/sw.js"), "utf8");
  const listed = [...sw.matchAll(/"\.\/([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== "");

  const walk = async (dir, prefix = "") => {
    const out = [];
    for (const entry of await readdir(join(ROOT, "web", dir), { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...(await walk(join(dir, entry.name), rel)));
      else out.push(rel);
    }
    return out;
  };
  const disk = [
    "index.html",
    "manifest.webmanifest",
    ...(await walk("css")),
    ...(await walk("js")),
    ...(await walk("icons")),
  ].filter((p) => !p.endsWith(".DS_Store"));

  const missingFromSw = disk.filter((p) => !listed.includes(p));
  const staleInSw = listed.filter((p) => p !== "index.html" && !disk.includes(p));
  expect(missingFromSw, `add to sw.js SHELL: ${missingFromSw.join(", ")}`).toEqual([]);
  expect(staleInSw, `remove from sw.js SHELL: ${staleInSw.join(", ")}`).toEqual([]);
});
