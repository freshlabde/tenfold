// Swipe left to delete - the mirror of swipe right to finish.
//
// The owner's report was one line: "swiping left does nothing, build delete in".
// What matters here is not that a row disappears but that it disappears through
// the SAME door the row menu's Delete uses: one tombstoned subtree, one undo
// toast, no confirmation on any node kind. A destructive gesture with a second
// deletion rule behind it, or with the undo missing, would be the one thing
// this app cannot afford. The other two gestures - finish and reorder - have to
// survive the new one unchanged, which is why the right swipe is asserted here
// as well and not only in ui.spec.js.
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

/** Add parts to the node that is currently on the focus screen. */
async function addParts(page, titles) {
  await page.getByRole("button", { name: /Add the first part|New part|New entry/ }).click();
  for (const title of titles) {
    await page.locator(".composer input").fill(title);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
}

/**
 * Where to take hold of a row, once that point really belongs to the row. A
 * screen change is a View Transition and a closing sheet leaves its scrim up
 * for a moment; while either is over the page a raw pointer press hit-tests
 * against the overlay and the row never sees the drag. Locator clicks retry
 * until they land, the mouse API does not.
 *
 * A negative distance pulls left, which is why the grab point then sits near
 * the right edge: on a 390px screen a leftward pull that starts on the left
 * runs out of screen before it reaches the commit distance.
 */
async function grab(page, shell, distance) {
  const id = await shell.getAttribute("data-id");
  const box = await shell.locator(".row").boundingBox();
  const y = box.y + box.height / 2;
  const x = distance < 0 ? box.x + box.width - 40 : box.x + 30;
  await page.waitForFunction(
    ([px, py, wanted]) => {
      const hit = document.elementFromPoint(px, py);
      const el = hit && hit.closest(".row-shell");
      return !!el && el.dataset.id === wanted;
    },
    [x, y, id],
  );
  return { x, y };
}

/** Drag a row horizontally past `distance` and release. */
async function swipe(page, shell, distance) {
  const { x, y } = await grab(page, shell, distance);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + distance * 0.45, y, { steps: 6 });
  await page.mouse.move(x + distance, y, { steps: 6 });
  await page.mouse.up();
}

test("a left swipe past the commit distance deletes the row, and undo brings it back", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma"]);

  await swipe(page, page.locator(".row-shell").first(), -140);

  // The same quiet word the row menu leaves behind, with the way back next to it.
  await expect(page.locator("#toast.is-open")).toContainText("Deleted.");
  await expect(page.locator(".row-title")).toHaveText(["Beta", "Gamma"]);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".row-title")).toHaveText(["Alpha", "Beta", "Gamma"]);
});

test("a left swipe short of the commit distance deletes nothing and springs back", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);

  const shell = page.locator(".row-shell").first();
  const row = shell.locator(".row");
  const box = await row.boundingBox();
  const y = box.y + box.height / 2;
  const x = box.x + box.width - 40;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 30, y, { steps: 6 });
  await page.mouse.move(x - 62, y, { steps: 6 });

  // Mid-drag the danger affordance is the one that is lit, on the right.
  const behind = shell.locator(".row-behind");
  await expect(behind).toHaveClass(/is-delete/);
  expect(Number(await behind.evaluate((el) => getComputedStyle(el).opacity))).toBeGreaterThan(0);

  await page.mouse.up();
  await page.waitForTimeout(600);

  // Nothing was decided, nothing was said, and the row sits where it was.
  await expect(page.locator(".row-title")).toHaveText(["Alpha", "Beta"]);
  // Nothing was said at all: the toast element keeps its last text after it
  // closes, so what counts is that no toast is up.
  await expect(page.locator("#toast.is-open")).toHaveCount(0);
  const transform = await row.evaluate((el) => getComputedStyle(el).transform);
  expect(transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)").toBe(true);
  expect(Number(await behind.evaluate((el) => getComputedStyle(el).opacity))).toBe(0);
});

test("the right swipe still finishes a step", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);
  await page.locator(".row-shell").first().locator(".row").click();
  await addParts(page, ["Call the practice"]);

  await swipe(page, page.locator(".list.is-kids .row-shell").first(), 140);

  await expect(page.locator("#toast.is-open")).toContainText("Marked as done");
  await expect(page.locator(".list.is-kids .row.is-done")).toHaveCount(1);
});

test("a goal with parts goes exactly the way the row menu takes it", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);

  await page.locator(".row-shell").first().locator(".row").click();
  await addParts(page, ["Alpha step"]);
  await page.locator(".crumb-back").click();
  await page.locator(".row-shell").nth(1).locator(".row").click();
  await addParts(page, ["Beta step"]);
  await page.locator(".crumb-back").click();
  await expect(page.locator(".row-title")).toHaveText(["Alpha", "Beta"]);

  // --- the menu path, as the reference -------------------------------------
  // Right-click is how a row opens its menu; the Delete entry deletes on the
  // spot. There is no confirmation step between the two, not even for a goal
  // that takes a whole subtree with it - the toast is the safety net.
  await page.locator(".row-shell").first().locator(".row").click({ button: "right" });
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator("#toast.is-open")).toContainText("Deleted.");
  await expect(page.locator(".row-title")).toHaveText(["Beta"]);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".row-title")).toHaveText(["Alpha", "Beta"]);

  // --- the gesture, which must be indistinguishable from it ----------------
  await swipe(page, page.locator(".row-shell").nth(1), -140);
  // No sheet asked anything on the way.
  await expect(page.locator(".sheet")).toHaveCount(0);
  await expect(page.locator("#toast.is-open")).toContainText("Deleted.");
  await expect(page.locator(".row-title")).toHaveText(["Alpha"]);

  // Undo is clicked while its toast is still up - it is the only way back -
  // and it returns the goal WITH its part, not a stump.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".row-title")).toHaveText(["Alpha", "Beta"]);
  await page.locator(".row-shell").nth(1).locator(".row").click();
  await expect(page.locator(".list.is-kids .row-title")).toHaveText(["Beta step"]);
  await page.locator(".crumb-back").click();

  // Left standing, the part is gone with its goal: a tombstoned subtree does
  // not surface in search, which is where a stranded child would show up.
  await swipe(page, page.locator(".row-shell").nth(1), -140);
  await expect(page.locator(".row-title")).toHaveText(["Alpha"]);
  await page.getByRole("button", { name: "Open search" }).click();
  await page.locator(".searchbar input").fill("Beta step");
  await expect(page.locator(".searchbar input")).toHaveValue("Beta step");
  await expect(page.locator(".row-title")).toHaveCount(0);
});
