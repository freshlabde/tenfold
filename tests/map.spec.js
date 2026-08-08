// The map: the whole tree as one animated scene.
//
// What is checked here: the way in from the outline header, that every living
// root really is on screen as a body, the two-step gesture (come closer, then
// open), the XSS canary on a label - a title is text inside the SVG and never
// markup - the three sizes a tree can have (none, one, ten), and the promise
// that with prefers-reduced-motion nothing moves at all: the map exposes a
// frame counter under navigator.webdriver, and that counter has to stay at
// zero. Finally the precache list, which a new file always threatens to break.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

const TITLES = [
  "Pay off the remaining debt",
  "Make the company sellable",
  "Run ten kilometres again",
  "Sort things out with Anna",
  "See my father regularly",
  "A back that stops hurting",
  "Spanish up to B2",
  "Will and provisions settled",
  "Finish the workshop",
  "Less screen time in the evening",
];

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

/**
 * A screen change is one View Transition, and while it runs the real DOM is
 * replaced by snapshots that swallow every hit test. Waiting for the
 * transition to be over is the difference between a click and a click into
 * nothing.
 */
async function settled(page) {
  await page.waitForFunction(() =>
    !document
      .getAnimations()
      .some((a) => String((a.effect && a.effect.pseudoElement) || "").includes("view-transition")),
  );
}

/** Open the map and wait until the layout has been fitted to the viewport. */
async function openMap(page) {
  await page.getByRole("button", { name: "Open the map" }).click();
  await expect(page.locator(".map-canvas")).toBeVisible();
  await expect(page.locator(".map-scene.is-ready")).toHaveCount(1);
  await settled(page);
}

/**
 * Tap a body or a label. Not locator.click(): a body drifts for as long as the
 * screen is open, so Playwright's stability check would never be satisfied -
 * and force:true would skip the hit-target check the transition needs. The
 * drift between reading the box and pressing is well under a pixel.
 */
async function tap(page, locator) {
  await settled(page);
  const box = await locator.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const roots = ".map-tree > .map-body.is-d0";

test("the map opens from the outline header and carries one body per root", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES);

  await openMap(page);
  await expect(page.locator(".h-title")).toHaveText("Map");
  await expect(page.locator(roots)).toHaveCount(10);
  // A root always carries its title; nothing below it does, unfocused.
  await expect(page.locator(".map-label")).toHaveCount(10);
  await expect(page.locator(".map-labeltext").first()).toHaveText(TITLES[0]);
  // Long goals are shortened, so a name can never turn into a wall of text.
  await expect(page.locator(".map-labeltext").last()).toHaveText("Less screen time in the e…");
});

test("the keyboard opens the map on a desktop", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);

  await page.locator("body").press("m");
  await expect(page.locator(".map-canvas")).toBeVisible();
  await expect(page.locator(roots)).toHaveCount(2);
});

test("the layout is deterministic - the same list draws the same sky", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES.slice(0, 6));

  const read = async () => {
    await openMap(page);
    const t = await page.locator(`${roots} > .map-disc`).evaluateAll((list) =>
      list.map((c) => c.parentNode.getAttribute("transform")),
    );
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.locator(".h-title")).toHaveText("The Ten");
    return t;
  };

  const a = await read();
  const b = await read();
  // The float means the two readings are not bit-identical, but the layout
  // underneath them must be: every body within its own drift amplitude.
  expect(a).toHaveLength(6);
  a.forEach((value, i) => {
    const [ax, ay] = value.replace(/[^-\d.,]/g, "").split(",").map(Number);
    const [bx, by] = b[i].replace(/[^-\d.,]/g, "").split(",").map(Number);
    expect(Math.abs(ax - bx)).toBeLessThan(12);
    expect(Math.abs(ay - by)).toBeLessThan(12);
  });
});

test("tapping a body comes closer, tapping it again opens it", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES.slice(0, 4));
  // Give the third goal parts, so the branch it zooms to is a real branch.
  await page.locator(".row-shell").nth(2).locator(".row").click();
  await page.getByRole("button", { name: /Add the first part/ }).click();
  for (const part of ["Build a base", "Stabilise the knee"]) {
    await page.locator(".composer input").fill(part);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
  await page.locator(".crumb-pill").first().click();

  await openMap(page);
  await expect(page.locator(".map-body.is-d1")).toHaveCount(2);

  const scene = page.locator(".map-scene");
  const before = await scene.getAttribute("transform");

  const orb = page.locator(`${roots} >> nth=2`).locator("> .map-hit");
  await tap(page, orb);

  // The camera moved, and the branch put its names on.
  await expect(page.locator(".map-label")).toHaveCount(6);
  await page.waitForTimeout(700);
  const after = await scene.getAttribute("transform");
  expect(after).not.toBe(before);

  // A second tap on the same body leaves the map for the real screen.
  await tap(page, orb);
  await expect(page.locator(".hero-title")).toHaveText(TITLES[2]);
});

test("tapping the name of a body opens it straight away", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);
  await openMap(page);

  await tap(page, page.locator('.map-label[data-label] > .map-labelhit').first());
  await expect(page.locator(".hero-title")).toHaveText("Alpha");
});

test("XSS canary: a title is text inside the SVG label, never markup", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  const payload = "<img src=x onerror=1>";
  await addRoots(page, [payload]);
  await openMap(page);

  const label = page.locator(".map-labeltext").first();
  await expect(label).toHaveText(payload);
  const shape = await label.evaluate((node) => ({
    ns: node.namespaceURI,
    kids: node.childNodes.length,
    kind: node.firstChild ? node.firstChild.nodeType : 0,
    value: node.textContent,
  }));
  expect(shape.ns).toBe("http://www.w3.org/2000/svg");
  expect(shape.kids).toBe(1);
  expect(shape.kind).toBe(3); // TEXT_NODE, and only that
  expect(shape.value).toBe(payload);
  expect(await page.locator(".map-canvas img").count()).toBe(0);
  expect(await page.locator("img").count()).toBe(0);
  expect(await page.evaluate(() => window.XSS)).toBeUndefined();
});

test("an empty tree still looks like a place", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await openMap(page);

  await expect(page.locator(roots)).toHaveCount(0);
  await expect(page.locator(".map-body.is-seed")).toHaveCount(1);
  await expect(page.locator(".map-hint")).toBeVisible();
  await expect(page.locator(".h-sub")).toHaveText("Nothing on the map yet");
});

test("a single root sits in the middle with its hint", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);
  await openMap(page);

  await expect(page.locator(roots)).toHaveCount(1);
  await expect(page.locator(".map-hint")).toBeVisible();
  await expect(page.locator(".map-labeltext")).toHaveText("Alpha");

  const box = await page.locator(`${roots} > .map-disc`).boundingBox();
  const stage = await page.locator(".map-stage").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  expect(Math.abs(cx - (stage.x + stage.width / 2))).toBeLessThan(40);
  expect(Math.abs(cy - (stage.y + stage.height / 2))).toBeLessThan(60);
});

test("ten roots and their parts all reach the screen", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES);
  await openMap(page);

  await expect(page.locator(roots)).toHaveCount(10);
  await expect(page.locator(".h-sub")).toHaveText("10 goals · 0 parts");

  // Every body is inside the canvas after the initial fit.
  const stage = await page.locator(".map-stage").boundingBox();
  const boxes = await page.locator(`${roots} > .map-disc`).evaluateAll((list) =>
    list.map((c) => c.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })),
  );
  for (const b of boxes) {
    expect(b.x).toBeGreaterThan(stage.x - 4);
    expect(b.x + b.w).toBeLessThan(stage.x + stage.width + 4);
    expect(b.y).toBeGreaterThan(stage.y - 4);
    expect(b.y + b.h).toBeLessThan(stage.y + stage.height + 4);
  }
});

test("the map animates when it may", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma"]);
  await openMap(page);

  await page.waitForTimeout(350);
  const probe = await page.evaluate(() => window.__tfMap);
  expect(probe.loop).toBe(true);
  expect(probe.frames).toBeGreaterThan(4);
});

test("with reduced motion the sky stands completely still", async ({ browser }) => {
  const context = await browser.newContext({ viewport: PHONE, reducedMotion: "reduce" });
  const page = await context.newPage();
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma"]);
  await openMap(page);

  const first = await page.locator(".map-tree > .map-body >> nth=0").getAttribute("transform");
  await page.waitForTimeout(500);
  const probe = await page.evaluate(() => window.__tfMap);
  // No animation frame ever ran: the counter is the proof.
  expect(probe.frames).toBe(0);
  expect(probe.loop).toBe(false);
  expect(await page.locator(".map-tree > .map-body >> nth=0").getAttribute("transform")).toBe(first);

  // And it is still a working screen, not a frozen one.
  const orb = page.locator(`${roots} >> nth=1`).locator("> .map-hit");
  await tap(page, orb);
  await tap(page, orb);
  await expect(page.locator(".hero-title")).toHaveText("Beta");
  await context.close();
});

test("the map stops its loop when the screen is left", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);
  await openMap(page);
  await page.waitForTimeout(200);

  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  await page.waitForTimeout(120);
  const a = await page.evaluate(() => window.__tfMap.frames);
  await page.waitForTimeout(250);
  const b = await page.evaluate(() => window.__tfMap.frames);
  expect(b).toBe(a);
});

test("wheel zooms, and the recentre button gives the whole sky back", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES.slice(0, 5));
  await openMap(page);

  const scene = page.locator(".map-scene");
  const scaleOf = async () => Number(/scale\(([\d.]+)\)/.exec(await scene.getAttribute("transform"))[1]);
  const start = await scaleOf();

  await page.mouse.move(195, 500);
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(150);
  expect(await scaleOf()).toBeGreaterThan(start * 1.5);

  await page.getByRole("button", { name: "Show everything" }).click();
  await page.waitForTimeout(700);
  expect(Math.abs((await scaleOf()) - start)).toBeLessThan(start * 0.1);
});

test("a fourth level is summed up on its level-three ancestor", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const add = (title, parentId) => {
      ctx.commitCompose(title, parentId, "stay");
      const kids = ctx.childrenOf(parentId);
      return kids[kids.length - 1].id;
    };
    let id = add("Root", null);
    for (const name of ["Level one", "Level two", "Level three"]) id = add(name, id);
    // Two more levels below the last drawn one: five hidden nodes in total.
    const deep = add("Level four", id);
    add("Level four b", id);
    add("Level five", deep);
    add("Level five b", deep);
    add("Level six", add("Level five c", deep));
    ctx.go("outline", null, { replace: true });
  });
  await page.waitForTimeout(300);
  await openMap(page);

  // Depth 0..3 are drawn, nothing below.
  await expect(page.locator(".map-body.is-d3")).toHaveCount(1);
  await expect(page.locator(".map-body.is-d4")).toHaveCount(0);
  await expect(page.locator(".map-more")).toHaveText("+6");
});

test("the map is in the service worker shell", async () => {
  const sw = await readFile(join(ROOT, "web/sw.js"), "utf8");
  expect(sw).toContain('const VERSION = "tenfold-v11"');
  expect(sw).toContain('"./js/ui/map.js"');
});
