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
  // The budget is wide enough that a real goal survives it whole.
  await expect(page.locator(".map-labeltext").last()).toHaveText(TITLES[9]);
});

test("a name too long for the sky is cut on a word, never inside one", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  // Over the budget, and the boundary falls in the middle of "afternoon".
  await addRoots(page, ["Buy the shoes after a gait analysis on Tuesday afternoon"]);
  await openMap(page);

  const shown = await page.locator(".map-labeltext").first().textContent();
  expect(shown.endsWith("…")).toBe(true);
  // Whatever was kept is a run of whole words off the front of the title.
  const kept = shown.slice(0, -1);
  expect("Buy the shoes after a gait analysis on Tuesday afternoon".startsWith(kept)).toBe(true);
  expect(kept.endsWith(" ")).toBe(false);
  // The cut sits at a space in the original, so no word was sliced in half.
  expect("Buy the shoes after a gait analysis on Tuesday afternoon"[kept.length]).toBe(" ");
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

test("rank is legible before any label is: size, light and a numeral", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES);
  await openMap(page);

  // 1 - the size ladder. Rank one is more than twice rank ten, and every step
  // down the list is a step down in size; a flat sky is the bug this guards.
  const radii = await page
    .locator(`${roots} > .map-disc`)
    .evaluateAll((list) => list.map((c) => Number(c.getAttribute("r"))));
  expect(radii).toHaveLength(10);
  expect(radii[0] / radii[9]).toBeGreaterThan(2.15);
  for (let i = 1; i < radii.length; i += 1) expect(radii[i]).toBeLessThan(radii[i - 1]);

  // 2 - the light ladder, on the same accent: the share of accent in a body's
  // fill falls with its rank, and the two ends are far apart.
  const mix = await page.locator(roots).evaluateAll((list) =>
    list.map((g) => Number(getComputedStyle(g).getPropertyValue("--rm").replace("%", ""))),
  );
  for (let i = 1; i < mix.length; i += 1) expect(mix[i]).toBeLessThan(mix[i - 1]);
  expect(mix[0] - mix[9]).toBeGreaterThan(40);

  // 3 - the numeral. On every root, in rank order, and a number rather than a
  // translated string - no locale owns it.
  await expect(page.locator(`${roots} > .map-rank`)).toHaveCount(10);
  const figures = await page
    .locator(`${roots} > .map-rank`)
    .evaluateAll((list) => list.map((n) => n.textContent));
  expect(figures).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
});

test("ten families, ten hues, and never a colour written by the script", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES);
  await openMap(page);

  // One family class per root, all ten different, read off the rank.
  const fams = await page.locator(roots).evaluateAll((list) =>
    list.map((g) => [...g.classList].find((c) => c.startsWith("is-fam"))),
  );
  expect(fams).toEqual([
    "is-fam0", "is-fam1", "is-fam2", "is-fam3", "is-fam4",
    "is-fam5", "is-fam6", "is-fam7", "is-fam8", "is-fam9",
  ]);

  // The class resolves to ten distinct tints out of the data palette.
  const tints = await page.locator(roots).evaluateAll((list) =>
    list.map((g) => getComputedStyle(g).getPropertyValue("--tint").trim()),
  );
  expect(new Set(tints).size).toBe(10);

  // And the module itself never names one: the only inline style on a body is
  // the ladder's numbers plus the halo's fragment id.
  const inline = await page.locator(roots).evaluateAll((list) =>
    list.map((g) => g.getAttribute("style") || ""),
  );
  for (const style of inline) {
    expect(style).not.toMatch(/#[0-9a-f]{3}|rgb|oklch|hsl/i);
  }
});

test("the family palette is calm, and it is defined per theme", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES.slice(0, 3));

  const read = () =>
    page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      const out = [];
      for (let i = 1; i <= 10; i += 1) out.push(s.getPropertyValue(`--data-${i}`).trim());
      return out;
    });

  const dark = await read();
  expect(dark.filter(Boolean)).toHaveLength(10);
  // Low chroma is the whole bargain: this is a data palette that still has to
  // live inside a calm room. Everything sits on ONE lightness and ONE chroma.
  for (const value of dark) expect(value).toMatch(/^oklch\(\.735 \.062 \d+\)$/);

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  const light = await read();
  for (const value of light) expect(value).toMatch(/^oklch\(\.545 \.075 \d+\)$/);
  // Same hues, different ink: on paper a family has to read as ink, not light.
  expect(light).not.toEqual(dark);
});

test("a part inherits its family's tint and its family's light", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES.slice(0, 4));
  // The last of the four gets the parts, so the family it inherits from is
  // demonstrably not the default one.
  await page.locator(".row-shell").nth(3).locator(".row").click();
  await page.getByRole("button", { name: /Add the first part/ }).click();
  await page.locator(".composer input").fill("A part");
  await page.locator(".composer input").press("Enter");
  await page.locator(".composer input").press("Escape");
  await page.locator(".crumb-pill").first().click();

  await openMap(page);
  const read = (locator) =>
    locator.evaluate((g) => {
      const s = getComputedStyle(g);
      return { tint: s.getPropertyValue("--tint").trim(), rm: s.getPropertyValue("--rm").trim() };
    });
  const root = await read(page.locator(`${roots} >> nth=3`));
  const part = await read(page.locator(".map-body.is-d1").first());
  expect(part).toEqual(root);
  // And the family really is off the default, so this proves inheritance
  // rather than everybody falling back to the same first hue.
  const first = await read(page.locator(`${roots} >> nth=0`));
  expect(root.tint).not.toBe(first.tint);
});

test("the map is in the service worker shell", async () => {
  const sw = await readFile(join(ROOT, "web/sw.js"), "utf8");
  expect(sw).toContain('const VERSION = "tenfold-v17"');
  expect(sw).toContain('"./js/ui/map.js"');
});
