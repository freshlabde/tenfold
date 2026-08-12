// The undo toast: where it stands, how big it is, and how it goes away.
//
// The owner's report was one line and three faults: "After delete Undo Button
// über put in order. Lässt sich nicht wegwischen. Kleiner und nicht Button
// sperren". The pill covered the bottom action bar for the full eight seconds
// it was offering the undo - and eight seconds is exactly the window in which
// someone who just deleted the wrong thing reaches for the bar - there was no
// way to put it away early, and it was a full-width banner for two words.
//
// What is asserted here is therefore geometry and gesture, not wording: the
// toast and the bar never share a pixel, the bar is not merely visible but
// actually operable while a toast is up, a swipe puts the pill away without
// deciding anything, and Undo still means undo.
import { test, expect } from "@playwright/test";

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

test.describe.configure({ mode: "parallel", timeout: 90_000 });

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

/** Delete the first goal through the row menu - the path with no gesture in it. */
async function deleteFirstRow(page) {
  await page.locator(".row-shell").first().locator(".row").click({ button: "right" });
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator("#toast.is-open")).toContainText("Deleted.");
  await expect(page.locator(".sheet")).toHaveCount(0);
}

/** Pull the toast sideways from a point on its text, not on its button. */
async function swipeToast(page, distance) {
  const box = await page.locator("#toast").boundingBox();
  const y = box.y + box.height / 2;
  const x = distance < 0 ? box.x + box.width - 12 : box.x + 12;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + distance * 0.4, y, { steps: 5 });
  await page.mouse.move(x + distance, y, { steps: 5 });
  await page.mouse.up();
}

test("the toast stands above the bar, and the bar still works underneath it", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma"]);

  await deleteFirstRow(page);

  const toast = await page.locator("#toast").boundingBox();
  const bar = await page.locator(".bar").boundingBox();

  // Not one shared pixel, and a visible gap rather than a kiss.
  expect(toast.y + toast.height).toBeLessThanOrEqual(bar.y);
  expect(bar.y - (toast.y + toast.height)).toBeGreaterThanOrEqual(4);

  // The bar is whole: both its buttons are on the glass, not half under a pill.
  const order = page.getByRole("button", { name: "Put in order" });
  await expect(order).toBeVisible();
  const orderBox = await order.boundingBox();
  expect(orderBox.y + orderBox.height).toBeLessThanOrEqual(844);
  expect(orderBox.y).toBeGreaterThanOrEqual(toast.y + toast.height);

  // Smaller: a pill, not a banner. It is well inside the gutter box it used to
  // fill, and it is one line high.
  expect(toast.width).toBeLessThan(PHONE.width * 0.75);
  expect(toast.height).toBeLessThan(56);

  // The undo plate may be small; the thing a thumb hits may not. The hit area
  // is grown back past the 44px minimum with a pseudo, so what counts is what
  // elementFromPoint answers just outside the plate.
  const reach = await page.evaluate(() => {
    const btn = document.querySelector("#toast button");
    const box = btn.getBoundingClientRect();
    const x = box.x + box.width / 2;
    const hits = (y) => {
      const el = document.elementFromPoint(x, y);
      return !!el && (el === btn || btn.contains(el));
    };
    let top = box.y;
    let bottom = box.y + box.height;
    while (hits(top - 1) && box.y - top < 20) top -= 1;
    while (hits(bottom + 1) && bottom - (box.y + box.height) < 20) bottom += 1;
    return { plate: box.height, tap: bottom - top };
  });
  expect(reach.tap).toBeGreaterThanOrEqual(44);

  // And the point of all of it: the button under the toast still does its job.
  // Visible is not the same as reachable - a pill with pointer events on top of
  // it would pass every assertion above and still swallow this click.
  await order.click();
  await expect(page.locator(".duel-card").first()).toBeVisible({ timeout: 15000 });
});

test("a horizontal swipe puts the toast away early - and decides nothing", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma"]);

  await deleteFirstRow(page);
  await expect(page.locator(".row-title")).toHaveText(["Beta", "Gamma"]);

  const started = Date.now();
  await swipeToast(page, 120);

  // Gone long before the eight seconds are up.
  await expect(page.locator("#toast.is-open")).toHaveCount(0, { timeout: 4000 });
  expect(Date.now() - started).toBeLessThan(6000);

  // Wiping the receipt away is not the same as taking the delete back: the row
  // stays deleted, and nothing else moved.
  await expect(page.locator(".row-title")).toHaveText(["Beta", "Gamma"]);

  // The pill is back in its resting place, not stranded off to the side where
  // the next toast would have to travel in from.
  const parked = await page.evaluate(() => document.querySelector("#toast").style.transform);
  expect(parked === "" || parked === "none").toBe(true);
});

test("the other direction dismisses too, and a short pull springs back", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma"]);

  // A pull that does not reach the commit distance leaves the toast standing:
  // an eight-second undo must not be lost to a nudge.
  await deleteFirstRow(page);
  const box = await page.locator("#toast").boundingBox();
  const y = box.y + box.height / 2;
  const x = box.x + 12;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 14, y, { steps: 4 });
  await page.mouse.move(x + 24, y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  await expect(page.locator("#toast.is-open")).toHaveCount(1);
  const back = await page.evaluate(() => document.querySelector("#toast").style.transform);
  expect(back === "" || back === "none").toBe(true);

  // Left is as good as right - the gesture has no preferred side.
  await swipeToast(page, -120);
  await expect(page.locator("#toast.is-open")).toHaveCount(0, { timeout: 4000 });
});

test("undo still restores, from the pill it became", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma"]);

  await deleteFirstRow(page);
  await expect(page.locator(".row-title")).toHaveText(["Beta", "Gamma"]);

  // The tap lands on Undo and is read as a tap, not as the start of a swipe.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".row-title")).toHaveText(["Alpha", "Beta", "Gamma"]);
});

test("with less movement asked for, the swipe still clears the toast", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma"]);

  await deleteFirstRow(page);

  // Same geometry contract with the animations off.
  const toast = await page.locator("#toast").boundingBox();
  const bar = await page.locator(".bar").boundingBox();
  expect(toast.y + toast.height).toBeLessThanOrEqual(bar.y);

  await swipeToast(page, 120);
  // No spring to wait out: the pill is simply not there any more.
  await expect(page.locator("#toast.is-open")).toHaveCount(0, { timeout: 2000 });
  await expect(page.locator(".row-title")).toHaveText(["Beta", "Gamma"]);
});
