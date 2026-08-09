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

/** Open the map screen (whatever mode it starts in). */
async function openMapRaw(page) {
  // The click must not fall into a still-running view transition of the
  // PREVIOUS navigation: Playwright then retries it, and the retry lands on
  // whatever the new header put at those coordinates - which is the mode
  // toggle, silently switching the map to the constellation.
  await settled(page);
  await page.getByRole("button", { name: "Open the map" }).click();
  await expect(page.locator(".map-canvas")).toBeVisible();
  await expect(page.locator(".map-scene.is-ready")).toHaveCount(1);
  await settled(page);
}

/** Open the map in the CONSTELLATION. The mind map is the default now, so
 *  the sky specs switch over explicitly first. */
async function openMap(page) {
  await openMapRaw(page);
  const sky = page.getByRole("button", { name: "Constellation" });
  if ((await sky.getAttribute("aria-pressed")) !== "true") {
    await sky.click();
    await settled(page);
  }
  await expect(page.locator(".map-scene.is-ready")).toHaveCount(1);
  await expect(page.locator(".map-tree > .map-body").first()).toBeVisible();
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
  // The mind map is the default reading now.
  await expect(page.locator(".mm-tree.is-ready")).toHaveCount(1);
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
  expect(sw).toContain('const VERSION = "tenfold-v24"');
  expect(sw).toContain('"./js/ui/map.js"');
  expect(sw).toContain('"./js/ui/mindmap.js"');
});

// ---------------------------------------------------------------------------
// The second reading: the mind map. The constellation is the atmosphere, this
// is the structural view, and its whole promise is that every title is there to
// be read without a zoom. What is checked below is that promise (one node per
// living node, every title on screen as text), that the choice survives a lock,
// that a tap goes straight through to the node instead of coming closer first,
// and that nothing on this screen ever moves.

/** Open the map - the mind map IS the default reading now. */
async function openMind(page) {
  await openMapRaw(page);
  await expect(page.locator(".mm-tree.is-ready")).toHaveCount(1);
  await settled(page);
}

test("the map header carries the two readings, and the choice is remembered", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES.slice(0, 4));
  await openMapRaw(page);

  // The mind map is where the screen starts now (owner decision), and it
  // says so.
  const sky = page.getByRole("button", { name: "Constellation" });
  const tree = page.getByRole("button", { name: "Mind map" });
  await expect(tree).toHaveAttribute("aria-pressed", "true");
  await expect(sky).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".mm-tree.is-ready")).toHaveCount(1);

  await sky.click();
  await expect(page.locator(roots).first()).toBeVisible();
  await expect(page.locator(".mm-tree")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Constellation" })).toHaveAttribute("aria-pressed", "true");
  // It lives in the document, not in the session: the setting is sealed with
  // everything else, which is what makes it survive a lock.
  expect(await page.evaluate(async () => (await import("/web/js/app.js")).ctx.doc.settings.mapMode)).toBe(
    "sky",
  );

  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Lock now" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");

  await page.getByRole("button", { name: "Open the map" }).click();
  await expect(page.locator(roots)).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Constellation" })).toHaveAttribute("aria-pressed", "true");

  // And back the other way, so neither mode is a one-way door.
  await page.getByRole("button", { name: "Mind map" }).click();
  await expect(page.locator(".mm-tree.is-ready")).toHaveCount(1);
  await expect(page.locator(roots)).toHaveCount(0);
});

test("the mind map draws every living node, and every title in full", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES);
  // Parts under two of them, so the count covers more than the ten.
  for (const [index, parts] of [
    [0, ["Three walks a week", "A dentist appointment"]],
    [4, ["Call him on Sundays"]],
  ]) {
    await page.locator(".row-shell").nth(index).locator(".row").click();
    await page.getByRole("button", { name: /Add the first part/ }).click();
    for (const part of parts) {
      await page.locator(".composer input").fill(part);
      await page.locator(".composer input").press("Enter");
    }
    await page.locator(".composer input").press("Escape");
    await page.locator(".crumb-pill").first().click();
  }

  await openMind(page);
  await expect(page.locator(".mm-node")).toHaveCount(13);
  await expect(page.locator(".mm-centre-label")).toHaveText("The Ten");

  // Every title is on the screen, whole: a node's lines joined back together
  // are exactly its title, and no line ends in an ellipsis.
  const shown = await page.locator(".mm-node").evaluateAll((list) =>
    list.map((g) => [...g.querySelectorAll(".mm-title")].map((n) => n.textContent).join(" ")),
  );
  const wanted = [...TITLES, "Three walks a week", "A dentist appointment", "Call him on Sundays"];
  expect(shown.slice().sort()).toEqual(wanted.slice().sort());

  // And the ten still carry their rank, in the same figures as the outline.
  const figures = await page
    .locator(".mm-node.is-d0 .mm-rank")
    .evaluateAll((list) => list.map((n) => n.textContent));
  expect(figures.slice().sort((a, b) => Number(a) - Number(b))).toEqual([
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
  ]);
});

test("every title in the mind map is inside the frame and big enough to read", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES);
  await openMind(page);

  const stage = await page.locator(".map-stage").boundingBox();
  const lines = await page.locator(".mm-title").evaluateAll((list) =>
    list.map((n) => {
      const r = n.getBoundingClientRect();
      return { x: r.x, right: r.right, h: r.height, text: n.textContent };
    }),
  );
  expect(lines.length).toBeGreaterThanOrEqual(10);
  for (const line of lines) {
    expect(line.x, `off the left edge: ${line.text}`).toBeGreaterThan(stage.x - 1);
    expect(line.right, `off the right edge: ${line.text}`).toBeLessThan(stage.x + stage.width + 1);
    // The whole point of the mode: no zoom needed. Rendered, after the camera,
    // a title has to stay above the size at which it stops being a title.
    expect(line.h, `too small to read: ${line.text}`).toBeGreaterThan(8.5);
  }
});

test("in the mind map a tap opens the node, with no zoom step in between", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES.slice(0, 4));
  await page.locator(".row-shell").nth(2).locator(".row").click();
  await page.getByRole("button", { name: /Add the first part/ }).click();
  await page.locator(".composer input").fill("Build a base");
  await page.locator(".composer input").press("Enter");
  await page.locator(".composer input").press("Escape");
  await page.locator(".crumb-pill").first().click();

  await openMind(page);
  // A part with nothing under it is a leaf, and a tap lands on the leaf screen
  // itself - not on a zoomed-in branch that still has to be tapped again.
  const part = page.locator('.mm-node.is-d1 [data-hit]').first();
  await tap(page, part);
  await expect(page.locator(".leaf-title")).toHaveText("Build a base");

  // And a goal opens its own screen the same way, in one tap.
  await page.locator(".crumb-pill").first().click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  await openMind(page);
  await tap(page, page.locator('.mm-node.is-d0 [data-hit]').first());
  await expect(page.locator(".hero-title")).toHaveText(TITLES[0]);
});

test("XSS canary: a title in the mind map is text inside the SVG, never markup", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  const payload = "<img src=x onerror=1>";
  await addRoots(page, [payload]);
  await openMind(page);

  const lines = page.locator(".mm-title");
  const shape = await lines.evaluateAll((list) =>
    list.map((node) => ({
      ns: node.namespaceURI,
      kids: node.childNodes.length,
      kind: node.firstChild ? node.firstChild.nodeType : 0,
      value: node.textContent,
    })),
  );
  expect(shape.length).toBeGreaterThan(0);
  for (const line of shape) {
    expect(line.ns).toBe("http://www.w3.org/2000/svg");
    expect(line.kids).toBe(1);
    expect(line.kind).toBe(3); // TEXT_NODE, and only that
  }
  expect(shape.map((l) => l.value).join(" ")).toBe(payload);
  expect(await page.locator(".map-canvas img").count()).toBe(0);
  expect(await page.locator("img").count()).toBe(0);
  expect(await page.evaluate(() => window.XSS)).toBeUndefined();
});

test("the mind map holds still - no animation frame ever runs", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma"]);
  await openMind(page);

  const first = await page.locator(".map-scene").getAttribute("transform");
  await page.waitForTimeout(500);
  const probe = await page.evaluate(() => window.__tfMap);
  expect(probe.frames).toBe(0);
  expect(probe.loop).toBe(false);
  expect(await page.locator(".map-scene").getAttribute("transform")).toBe(first);
});

test("with reduced motion the mind map is built and readable straight away", async ({ browser }) => {
  const context = await browser.newContext({ viewport: PHONE, reducedMotion: "reduce" });
  const page = await context.newPage();
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma"]);
  await openMind(page);

  await expect(page.locator(".mm-node")).toHaveCount(3);
  // The build cascade is not shortened here, it is gone: the duration and the
  // per-branch delay are both read off the token that reduced motion collapses,
  // so a single millisecond is the whole animation.
  const timing = await page.locator(".mm-branch").first().evaluate((g) => {
    const s = getComputedStyle(g);
    return { dur: s.animationDuration, delay: s.animationDelay };
  });
  expect(timing.dur).toBe("0.001s");
  expect(timing.delay).toBe("0s");
  // And nothing is left mid-fade.
  await expect
    .poll(() =>
      page
        .locator(".mm-branch")
        .evaluateAll((list) => list.every((g) => Number(getComputedStyle(g).opacity) === 1)),
    )
    .toBe(true);
  const probe = await page.evaluate(() => window.__tfMap);
  expect(probe.frames).toBe(0);

  await tap(page, page.locator('.mm-node [data-hit]').first());
  await expect(page.locator(".hero-title")).toHaveText("Alpha");
  await context.close();
});

test("the mind map inherits the family hues and writes no colour of its own", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES);
  await openMind(page);

  const fams = await page.locator(".mm-branch").evaluateAll((list) =>
    list.map((g) => [...g.classList].find((c) => c.startsWith("is-fam"))),
  );
  expect(fams).toEqual([
    "is-fam0", "is-fam1", "is-fam2", "is-fam3", "is-fam4",
    "is-fam5", "is-fam6", "is-fam7", "is-fam8", "is-fam9",
  ]);
  const tints = await page.locator(".mm-branch").evaluateAll((list) =>
    list.map((g) => getComputedStyle(g).getPropertyValue("--tint").trim()),
  );
  expect(new Set(tints).size).toBe(10);
  const inline = await page.locator(".mm-branch").evaluateAll((list) =>
    list.map((g) => g.getAttribute("style") || ""),
  );
  for (const style of inline) expect(style).not.toMatch(/#[0-9a-f]{3}|rgb|oklch|hsl/i);
});

test("below the third level the mind map sums up, exactly as the sky does", async ({ page }) => {
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
    const deep = add("Level four", id);
    add("Level four b", id);
    add("Level five", deep);
    add("Level five b", deep);
    add("Level six", add("Level five c", deep));
    ctx.setSettings({ mapMode: "tree" });
    ctx.go("outline", null, { replace: true });
  });
  await page.waitForTimeout(300);
  await openMind(page);

  await expect(page.locator(".mm-node.is-d3")).toHaveCount(1);
  await expect(page.locator(".mm-node.is-d4")).toHaveCount(0);
  await expect(page.locator(".mm-more")).toHaveText("+6");
});

/**
 * The owner's own list, in the shape that broke: nine German goals, sixteen
 * parts under seven of them, two grandchildren under two of those, and one
 * branch that goes deeper still - the row that carries a +n badge and reaches
 * furthest out. Built through the app's own compose path, so it is the same
 * document the map would have read from the vault.
 */
const GERMAN_GOALS = [
  "Schulden bei der Bank endlich vollständig abbezahlen",
  "Die Firma verkaufsfähig aufstellen und übergeben",
  "Wieder zehn Kilometer am Stück laufen können",
  "Die Sache mit Anna in Ruhe klären",
  "Meinen Vater regelmäßig jede Woche besuchen",
  "Ein Rücken, der morgens nicht mehr wehtut",
  "Spanisch bis zum Niveau B2 sprechen lernen",
  "Testament und Vorsorgevollmacht endlich regeln",
  "Die Werkstatt im Keller fertig einrichten",
];
const GERMAN_PARTS = [
  [0, ["Monatliche Rate mit der Bank neu verhandeln", "Alle Abos und Verträge durchgehen und kündigen", "Einen Tilgungsplan bis Ende nächsten Jahres aufstellen"]],
  [1, ["Buchhaltung der letzten drei Jahre prüfen lassen", "Nachfolger für die Produktionsleitung finden", "Bewertungsgutachten beim Steuerberater beauftragen"]],
  [2, ["Zweimal pro Woche eine lockere Runde am Fluss laufen", "Ordentliche Laufschuhe mit Laufbandanalyse kaufen"]],
  [4, ["Jeden Sonntagabend anrufen, ohne Ausnahme", "Einmal im Monat zum Mittagessen hinfahren"]],
  [5, ["Rückenübungen jeden Morgen vor dem Frühstück", "Termin bei der Orthopädin ausmachen"]],
  [6, ["Jeden Tag zwanzig Minuten Vokabeln wiederholen", "Einen Konversationskurs am Abend suchen"]],
  [8, ["Werkbank und Regale aufbauen und verschrauben", "Alte Farbeimer und Reste zum Wertstoffhof bringen"]],
];
const GERMAN_GRAND = [
  [0, ["Unterlagen für das Gespräch bei der Bank zusammenstellen", "Termin mit dem Berater der Sparkasse vereinbaren"]],
  [8, ["Suche nach Anfänger-Tutorial für Motorenreparatur (Vespa)", "Passendes Werkzeug für die Vespa zusammenstellen"]],
];

async function ownerTree(page) {
  await page.evaluate(
    async ({ goals, parts, grand }) => {
      const { ctx } = await import("/web/js/app.js");
      const add = (title, parentId) => {
        ctx.commitCompose(title, parentId, "stay");
        const kids = ctx.childrenOf(parentId);
        return kids[kids.length - 1].id;
      };
      const rootIds = goals.map((title) => add(title, null));
      const firstPart = new Map();
      for (const [index, titles] of parts) {
        firstPart.set(index, titles.map((title) => add(title, rootIds[index]))[0]);
      }
      for (const [index, titles] of grand) {
        const kids = titles.map((title) => add(title, firstPart.get(index)));
        // One level deeper under the first grandchild, with more below it: that
        // is the row that carries the +n badge, and the widest one in the tree.
        const deeper = add("Ersatzteilliste für den Vergaser der Vespa zusammenstellen und bestellen", kids[0]);
        for (let i = 0; i < 3; i += 1) add(`Teilbestellung Nummer ${i + 1} beim Händler aufgeben`, deeper);
      }
      ctx.setSettings({ mapMode: "tree" });
      ctx.go("outline", null, { replace: true });
    },
    { goals: GERMAN_GOALS, parts: GERMAN_PARTS, grand: GERMAN_GRAND },
  );
  await expect(page.locator(".row-shell")).toHaveCount(GERMAN_GOALS.length);
}

/** Every row of the mind map, inside the stage, and still readable. */
async function expectComplete(page, where) {
  const stage = await page.locator(".map-stage").boundingBox();
  const rows = await page.locator(".mm-node").evaluateAll((list) =>
    list.map((g) => {
      const r = g.getBoundingClientRect();
      const line = g.querySelector(".mm-title");
      return {
        left: r.left,
        right: r.right,
        h: line ? line.getBoundingClientRect().height : 0,
        text: g.textContent,
      };
    }),
  );
  expect(rows.length).toBeGreaterThan(20);
  for (const row of rows) {
    // Half a pixel of tolerance: a glyph's ink can overhang its advance width.
    expect(row.left, `${where}: off the left edge - ${row.text}`).toBeGreaterThan(stage.x - 0.5);
    expect(row.right, `${where}: off the right edge - ${row.text}`).toBeLessThan(
      stage.x + stage.width + 0.5,
    );
    expect(row.h, `${where}: too small to read - ${row.text}`).toBeGreaterThan(9);
  }
}

test("the mind map opens complete on a phone, whatever that phone is wide", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await ownerTree(page);

  // The narrow phone first, and fresh - this is the one that used to open with
  // a column outside the viewport, because the line budgets were fixed numbers
  // and only the camera was asked to make them fit.
  await page.setViewportSize({ width: 360, height: 780 });
  await openMind(page);
  await expectComplete(page, "360");

  // And the same tree on a wider stage: the scene is rebuilt against the new
  // budgets, so the map grows into the room instead of staying cut to the
  // narrow one.
  await page.setViewportSize(PHONE);
  await expect
    .poll(async () => (await page.locator(".map-stage").boundingBox()).width)
    .toBe(PHONE.width);
  await settled(page);
  await expectComplete(page, "390");
});

test("a two-goal tree in the mind map is not wrapped into stumps", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, [TITLES[0], TITLES[9]]);
  await openMind(page);

  // A stage-derived budget must never punish a small list: two goals still
  // stand on one line each, whole.
  const shown = await page.locator(".mm-node").evaluateAll((list) =>
    list.map((g) => [...g.querySelectorAll(".mm-title")].map((n) => n.textContent)),
  );
  expect(shown.map((lines) => lines.join(" ")).sort()).toEqual([TITLES[0], TITLES[9]].sort());
  expect(shown.every((lines) => lines.length <= 2)).toBe(true);
});

test("an empty vault in the mind map is the centre and nothing else", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await openMind(page);

  await expect(page.locator(".mm-node")).toHaveCount(0);
  await expect(page.locator(".mm-centre-label")).toHaveText("The Ten");
  await expect(page.locator(".map-hint")).toHaveText(
    "Write your ten. Each one branches off the centre here.",
  );
});
