// The wide tier: what a desktop window is allowed to do to a phone layout.
//
// What is checked here: the frame grows to a tablet canvas and stays centred;
// the reading column inside it does NOT grow with it (a row twice as long is
// not twice as readable); the map is the exception and takes every pixel; a
// sheet is capped and centred instead of spanning the frame; and below the
// breakpoint the phone is byte-for-byte the screen it always was.
import { test, expect } from "@playwright/test";

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };
const DESK = { width: 1280, height: 900 };

// The measure a reading surface may reach (--content-max is 660) plus room for
// rounding and a scrollbar. Nothing on a text screen may be wider than this.
const COLUMN_CAP = 700;

test.describe.configure({ mode: "parallel", timeout: 90_000 });

// The helpers below are copies, not imports: no spec in this suite imports
// from another, and a shared fixture module would tie this wave to the map's.

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

async function addRoots(page, titles) {
  await page.getByRole("button", { name: /Write the first one|New entry/ }).click();
  for (const title of titles) {
    await page.locator(".composer input").fill(title);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
}

/** A screen change is one View Transition; while it runs the real DOM is
 *  replaced by snapshots that swallow every hit test. */
async function settled(page) {
  await page.waitForFunction(() =>
    !document
      .getAnimations()
      .some((a) => String((a.effect && a.effect.pseudoElement) || "").includes("view-transition")),
  );
}

/** Widen the window and let the layout settle before anything is measured. */
async function widen(page) {
  await page.setViewportSize(DESK);
  await settled(page);
  await expect(page.locator(".frame")).toHaveJSProperty("clientWidth", 800);
}

const TITLES = ["Pay off the remaining debt", "Make the company sellable", "Run ten kilometres again"];

test("the wide tier grows the frame to a tablet canvas and keeps it centred", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES);
  await widen(page);

  const frame = await page.locator(".frame").boundingBox();
  // At least iPad width, and still a device rather than the whole window.
  expect(frame.width).toBeGreaterThanOrEqual(768);
  expect(frame.width).toBeLessThanOrEqual(820);
  expect(Math.abs(frame.x + frame.width / 2 - DESK.width / 2)).toBeLessThan(2);

  // The window's full height minus the two 24px insets the device edge needs.
  expect(frame.height).toBe(DESK.height - 48);
  const radius = await page.locator(".frame").evaluate((n) => getComputedStyle(n).borderTopLeftRadius);
  expect(parseFloat(radius)).toBeGreaterThan(0);

  const overflow = await page.evaluate(() => document.body.scrollWidth - document.body.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // On a tall monitor the raised cap is what is doing the work: the old rule
  // stopped at 884 and left the rest of the screen empty.
  await page.setViewportSize({ width: 1440, height: 1200 });
  await settled(page);
  const tall = await page.locator(".frame").boundingBox();
  expect(tall.height).toBe(1100);
});

test("a wider frame does not make a wider row", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES);
  await widen(page);

  const frame = await page.locator(".frame").boundingBox();
  const head = await page.locator(".head").boundingBox();
  const row = await page.locator(".row").first().boundingBox();
  const bar = await page.locator(".bar").boundingBox();

  // The measure holds for the header, the list and the action bar alike.
  expect(head.width).toBeLessThanOrEqual(COLUMN_CAP);
  expect(row.width).toBeLessThanOrEqual(COLUMN_CAP);
  expect(bar.width).toBeLessThanOrEqual(COLUMN_CAP);
  // Not merely narrow - narrower than the frame it sits in, and centred in it.
  expect(head.width).toBeLessThan(frame.width - 40);
  expect(Math.abs(head.x + head.width / 2 - (frame.x + frame.width / 2))).toBeLessThan(2);
  expect(Math.abs(bar.x + bar.width / 2 - (frame.x + frame.width / 2))).toBeLessThan(2);
});

test("the map is the exception and takes the whole wide frame", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES);
  await widen(page);

  await page.getByRole("button", { name: "Open the map" }).click();
  await expect(page.locator(".map-canvas")).toBeVisible();
  await expect(page.locator(".map-scene.is-ready")).toHaveCount(1);
  await settled(page);

  const frame = await page.locator(".frame").boundingBox();
  const canvas = await page.locator(".map-canvas").boundingBox();
  expect(canvas.width).toBeGreaterThanOrEqual(frame.width - 2);
  // The scene really was re-measured into the wider box, not left on the
  // placeholder viewBox the SVG ships with.
  const viewBox = await page.locator(".map-canvas").getAttribute("viewBox");
  expect(parseFloat(viewBox.split(" ")[2])).toBeGreaterThanOrEqual(frame.width - 2);
});

test("a sheet on the wide tier is capped and centred", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES);
  await widen(page);

  await page.locator(".row-shell").first().locator(".row").click();
  await settled(page);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".sheet .input").first()).toBeVisible();

  const frame = await page.locator(".frame").boundingBox();
  // The row menu it replaced is still retracting in the DOM, so the open one
  // has to be named explicitly.
  const sheet = await page.locator(".sheet.is-open").boundingBox();
  expect(sheet.width).toBeLessThanOrEqual(600);
  expect(Math.abs(sheet.x + sheet.width / 2 - (frame.x + frame.width / 2))).toBeLessThan(2);
});

test("below the breakpoint the phone frame is untouched", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES);

  const frame = await page.locator(".frame").boundingBox();
  const head = await page.locator(".head").boundingBox();
  // Full bleed: the frame is the window and the header is the frame.
  expect(frame.width).toBe(PHONE.width);
  expect(frame.x).toBe(0);
  expect(head.width).toBe(PHONE.width);
  const radius = await page.locator(".frame").evaluate((n) => getComputedStyle(n).borderTopLeftRadius);
  expect(parseFloat(radius)).toBe(0);
});
