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
  // The backup step asks before anything is uploaded; sync stays off here.
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
  // settled() covers view transitions only - the camera spring (glideTo) is
  // none, so a box read straight after it is stale by the time the click
  // lands, and on a slow runner (CI) the miss window is wide: the tap fell
  // on empty sky and cleared instead of selected, twice, in two different
  // hardening attempts. Wait until the element's box actually holds still.
  // The sky's idle drift moves well under a pixel per 120ms, so it passes
  // the tolerance; the 3s ceiling keeps a dead element from hanging the spec.
  let prev = null;
  const until = Date.now() + 3000;
  for (;;) {
    const box = await locator.boundingBox();
    if (
      (prev &&
        box &&
        Math.abs(box.x - prev.x) < 0.6 &&
        Math.abs(box.y - prev.y) < 0.6) ||
      Date.now() > until
    ) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return;
    }
    prev = box;
    await page.waitForTimeout(120);
  }
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
  expect(sw).toContain('const VERSION = "tenfold-v56"');
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

  // And the ten still carry their rank - now in a filled chip in the family
  // hue, the same object the outline puts in front of a row, so the figure is
  // read as a priority and not as a count.
  await expect(page.locator(".mm-node.is-d0 .mm-chip")).toHaveCount(10);
  await expect(page.locator(".mm-node.is-lead")).toHaveCount(1);
  const figures = await page
    .locator(".mm-node.is-d0 .mm-chip-num")
    .evaluateAll((list) => list.map((n) => n.textContent));
  expect(figures.slice().sort((a, b) => Number(a) - Number(b))).toEqual([
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
  ]);

  // The three voices are actually three: a goal is set clearly larger than a
  // part, and a part clearly larger than what hangs under it.
  const size = (s) =>
    page.locator(s).first().evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
  const [d0, d1] = [await size(".mm-title.is-d0"), await size(".mm-title.is-d1")];
  expect(d0).toBeGreaterThan(d1 * 1.2);
  expect(d1).toBeGreaterThan(12);
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

/**
 * The owner's report, as a document: one goal whose part carries five steps of
 * its own, repeated at the front and at the back of the ten so that the same
 * shape lands once on the right branch and once on the left. Whatever the row
 * load does with the split, one of the two is on each side.
 */
async function deepBothSides(page) {
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const add = (title, parentId) => {
      ctx.commitCompose(title, parentId, "stay");
      const kids = ctx.childrenOf(parentId);
      return kids[kids.length - 1].id;
    };
    const deep = (goalTitle) => {
      const goal = add(goalTitle, null);
      const part = add("The relationship with my father", goal);
      for (const step of [
        "Call him every Sunday evening",
        "Drive over for lunch once a month",
        "Go through the old photographs",
        "Talk about the time after the company",
        "Plan his eightieth birthday properly",
      ]) {
        add(step, part);
      }
      add("Do not forget Anna's birthday", goal);
      add("Speak to my brother again", goal);
    };
    deep("The people who are close to me");
    for (const title of ["Pay off the debt", "Make the company sellable", "Run ten kilometres"]) {
      const goal = add(title, null);
      add("A first part under it", goal);
      add("A second part under it", goal);
    }
    deep("The people I work with every day");
    ctx.setSettings({ mapMode: "tree" });
    ctx.go("outline", null, { replace: true });
  });
  await expect(page.locator(".row-shell")).toHaveCount(5);
}

test("every level of the mind map is its own column, on both branches", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await deepBothSides(page);
  await openMind(page);

  // The owner's complaint, as a measurement. A row's ANCHORED text edge - where
  // its title starts on the right branch, where it ends on the left - is what a
  // reader lines the levels up by, and depth two used to land on the same one
  // as depth one: the nodes were there, the level was not. Both branches are
  // checked, because right-aligned text is where an indent is easiest to lose.
  const rows = await page.locator(".mm-node").evaluateAll((list) =>
    list.map((g) => {
      const dot = g.querySelector(".mm-dot");
      const title = g.querySelector(".mm-title");
      const box = title.getBoundingClientRect();
      const x = Number(dot.getAttribute("cx"));
      return { depth: Number([...g.classList].find((c) => /^is-d\d$/.test(c)).slice(4)),
        side: x < 0 ? -1 : 1,
        // A coordinate that grows OUTWARD on either branch, so one comparison
        // covers both: the start of the text on the right, the negated end of
        // it on the left.
        reach: x < 0 ? -box.right : box.left };
    }),
  );
  for (const side of [1, -1]) {
    const at = (d) => rows.filter((r) => r.side === side && r.depth === d).map((r) => r.reach);
    const [ones, twos] = [at(1), at(2)];
    expect(ones.length, `depth one on side ${side}`).toBeGreaterThan(0);
    expect(twos.length, `depth two on side ${side}`).toBeGreaterThan(0);
    // Every depth-two row starts a clear column further out than every
    // depth-one row - not a hairline, a step a reader cannot miss. The floor is
    // sixteen device-independent pixels because the geometry this replaced
    // came out at about twelve and that is what the owner could not see; the
    // shipped step renders at a little over nineteen, the same on both
    // branches, which is the mirroring this also guards.
    expect(Math.min(...twos) - Math.max(...ones), `side ${side} indent`).toBeGreaterThan(16);
  }

  // And the step is only half of it: a parent puts down ONE rail and every one
  // of its children elbows off that rail, which is what says the five steps
  // belong to the part above them rather than standing beside it. One rail per
  // node that has children, one stub per child, one spine per branch side.
  expect(rows.length).toBe(27); // five goals, twelve parts, ten steps
  // Seven nodes have children: the five goals, and the one part under each of
  // the two deep goals.
  expect(await page.locator(".mm-rail").count()).toBe(7);
  expect(await page.locator(".mm-rail.is-d0").count()).toBe(5);
  expect(await page.locator(".mm-rail.is-d1").count()).toBe(2);
  expect(await page.locator(".mm-spine").count()).toBe(2);
  expect(await page.locator(".mm-link.is-trunk").count()).toBe(5);
  expect(await page.locator(".mm-link.is-d0").count()).toBe(12);
  expect(await page.locator(".mm-link.is-d1").count()).toBe(10);
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

// ---------------------------------------------------------------------------
// The context cards in the sky. A card is an n:m link - one person, many steps,
// across families - which is the one thing the mind map structurally cannot
// draw, so it lives here and nowhere else. What is checked below: the toggle
// and that it is remembered, one diamond per living card and one thread per
// link, that a name is text and never markup, that every card carries its name
// however crowded the sky, the two-step gesture (the first tap selects the card
// and lights its threads, the second opens the card sheet), that a sensitive
// card puts NOTHING but its name on the screen, and that the cards buy no
// animation frame when motion is not wanted.

/**
 * A vault in the shape the question was asked about: two families with parts,
 * one card linked into BOTH of them, one card with a single link, one card
 * nobody has linked yet - and, unless told otherwise, a deleted card that must
 * not reach the sky.
 * @returns {Promise<void>}
 */
async function cardTree(page, opts = {}) {
  await page.evaluate(async (o) => {
    const { ctx } = await import("/web/js/app.js");
    const add = (title, parentId) => {
      ctx.commitCompose(title, parentId, "stay");
      const kids = ctx.childrenOf(parentId);
      return kids[kids.length - 1].id;
    };
    const anna = add("Sort things out with Anna", null);
    const father = add("See my father regularly", null);
    const a1 = add("A weekend away together", anna);
    const a2 = add("Say the thing I keep not saying", anna);
    const f1 = add("Call him on Sundays", father);

    // The cross-link: one person, three steps, two families.
    const shared = ctx.addEntity({ name: o.sharedName, kind: "person", relation: "my sister" });
    ctx.linkEntity(a1, shared);
    ctx.linkEntity(a2, shared);
    ctx.linkEntity(f1, shared);
    // One link only.
    const one = ctx.addEntity({ name: "The bank", kind: "org" });
    ctx.linkEntity(a1, one);
    // And one nobody has linked.
    ctx.addEntity({ name: "The workshop", kind: "place" });
    if (o.sensitive) {
      const s = ctx.addEntity({
        name: "Doctor Vogt",
        kind: "person",
        relation: "my orthopaedist",
        notes: "Told me the disc will not heal on its own.",
        sensitivity: "high",
      });
      ctx.linkEntity(f1, s);
    }
    if (o.deleted) {
      const gone = ctx.addEntity({ name: "Someone who left", kind: "person" });
      ctx.deleteEntity(gone);
    }
    ctx.setSettings({ mapMode: "sky" });
    ctx.go("outline", null, { replace: true });
  }, { sharedName: opts.sharedName || "Anna", sensitive: !!opts.sensitive, deleted: !!opts.deleted });
  await page.waitForTimeout(200);
}

test("the sky draws one diamond per living card and one thread per link", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await cardTree(page, { deleted: true });
  await openMap(page);

  // Three living cards - the tombstoned one is not on the map.
  await expect(page.locator(".map-card")).toHaveCount(3);
  // Four links: three on the shared card, one on the single one. The unlinked
  // card has none and says so by floating loose.
  await expect(page.locator(".map-card-link")).toHaveCount(4);
  await expect(page.locator(".map-card.is-loose")).toHaveCount(1);
  // ONE shape for every kind: a hollow diamond, a path, nothing else. The
  // per-kind outlines are gone - the kind is on the card, not in the geometry.
  await expect(page.locator(".map-card path.map-card-mark")).toHaveCount(3);
  await expect(page.locator(".map-card circle.map-card-mark, .map-card rect.map-card-mark")).toHaveCount(0);
  const shapes = await page
    .locator(".map-card-mark")
    .evaluateAll((list) => list.map((n) => n.getAttribute("d")));
  expect(new Set(shapes).size).toBe(1);

  // The default is the question the cards answer: one card is linked twice, so
  // the sky opens with them - without anybody having chosen anything.
  expect(
    await page.evaluate(async () => (await import("/web/js/app.js")).ctx.doc.settings.mapCards),
  ).toBeUndefined();
  await expect(page.locator(".h-sub")).toHaveText("2 goals · 3 parts · 3 cards");
});

test("with nothing shared the cards stay off until they are asked for", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    ctx.commitCompose("Alpha", null, "stay");
    const goal = ctx.childrenOf(null)[0].id;
    ctx.commitCompose("A part", goal, "stay");
    const part = ctx.childrenOf(goal)[0].id;
    const card = ctx.addEntity({ name: "Anna", kind: "person" });
    ctx.linkEntity(part, card);
    ctx.setSettings({ mapMode: "sky" });
    ctx.go("outline", null, { replace: true });
  });
  await page.waitForTimeout(200);
  await openMap(page);

  // Nothing is shared by two steps, so there is no cross-link to see and the
  // sky stays what it was. The switch is there, and it says so.
  await expect(page.locator(".map-card")).toHaveCount(0);
  await expect(page.locator(".h-sub")).toHaveText("1 goal · 1 part");
  const toggle = page.getByRole("button", { name: "Show the context cards" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(page.locator(".map-card")).toHaveCount(1);
  await expect(page.locator(".h-sub")).toHaveText("1 goal · 1 part · 1 card");
});

test("the card toggle is remembered in the document, like the mode", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await cardTree(page);
  await openMap(page);

  const toggle = page.getByRole("button", { name: "Show the context cards" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(page.locator(".map-card")).toHaveCount(0);
  await expect(page.locator(".h-sub")).toHaveText("2 goals · 3 parts");
  expect(
    await page.evaluate(async () => (await import("/web/js/app.js")).ctx.doc.settings.mapCards),
  ).toBe(false);

  // An explicit "no" outlives the default that would say yes: it is sealed with
  // the rest of the document, so it survives a lock as the mode does.
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Lock now" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");

  await openMapRaw(page);
  await expect(page.locator(".map-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Show the context cards" }).click();
  await expect(page.locator(".map-card")).toHaveCount(3);
});

test("a card is a different species: no family hue, no colour from the script", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await cardTree(page);
  await openMap(page);

  // The diamonds are all one size, and that size is smaller than the smallest
  // goal on the screen - a card carries no rank, so it may not read as one.
  const rings = await page
    .locator(".map-card path.map-card-mark")
    .evaluateAll((list) => list.map((n) => n.getBBox().width));
  expect(new Set(rings.map((r) => Math.round(r * 10))).size).toBe(1);
  expect(Math.max(...rings)).toBeLessThan(24);
  const goals = await page
    .locator(`${roots} > .map-disc`)
    .evaluateAll((list) => list.map((c) => Number(c.getAttribute("r"))));
  expect(Math.min(...goals)).toBeGreaterThan(12);

  // The one neutral on this screen, out of the tokens, and hollow: a card is
  // never filled, whatever the theme.
  const look = await page.locator(".map-card-mark").first().evaluate((n) => {
    const s = getComputedStyle(n);
    return { fill: s.fill, stroke: s.stroke, token: getComputedStyle(document.documentElement).getPropertyValue("--map-card").trim() };
  });
  expect(look.fill).toBe("none");
  expect(look.token).not.toBe("");
  // And the module writes no colour of its own on a card, exactly as with a body.
  const inline = await page.locator(".map-card").evaluateAll((list) =>
    list.map((g) => g.getAttribute("style") || ""),
  );
  for (const style of inline) expect(style).not.toMatch(/#[0-9a-f]{3}|rgb|oklch|hsl/i);
});

test("XSS canary: a card name is text inside the SVG label, never markup", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  const payload = "<img src=x onerror=1>";
  await cardTree(page, { sharedName: payload });
  await openMap(page);

  const label = page.locator(".map-label.is-card .map-labeltext").first();
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
  expect(await page.locator("img").count()).toBe(0);
  expect(await page.evaluate(() => window.XSS)).toBeUndefined();
});

test("a card answers the same two-step as a goal: select, then open", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await cardTree(page);
  await openMap(page);

  // Nothing is being looked at yet, so nothing is dimmed and no card is lit.
  await expect(page.locator(".map-cards.has-focus")).toHaveCount(0);
  await expect(page.locator(".map-card.is-selected")).toHaveCount(0);

  // FIRST tap on the diamond: it is selected. No sheet, no zoom - a card is not
  // a branch to come closer to, so the first half of the gesture is spent on
  // light: the card and its threads come up, the rest of the sky steps back.
  const anna = page.locator('.map-card[data-card]').first();
  await tap(page, anna.locator("> .map-hit"));
  await expect(page.locator(".sheet-title")).toHaveCount(0);
  await expect(page.locator(".map-card.is-selected")).toHaveCount(1);
  await expect(page.locator(".map-cards.has-focus")).toHaveCount(1);
  await expect(page.locator(".map-tree.has-focus")).toHaveCount(1);
  // Its threads are at full strength, the other card's are not. The light
  // fades in over one duration token, so this is read once it has arrived.
  await page.waitForTimeout(400);
  const opacity = await page.locator(".map-card-link").evaluateAll((list) =>
    list.map((n) => ({
      selected: !!n.parentNode.classList.contains("is-selected"),
      value: Number(getComputedStyle(n).opacity),
    })),
  );
  expect(opacity.filter((o) => o.selected).length).toBe(3);
  for (const o of opacity) {
    if (o.selected) expect(o.value).toBe(1);
    else expect(o.value).toBeLessThan(1);
  }
  // And the families it reaches into keep their light while the others recede.
  const litRoots = await page
    .locator(`${roots}`)
    .evaluateAll((list) => list.filter((g) => g.classList.contains("is-path")).length);
  expect(litRoots).toBe(2);

  // SECOND tap on the SAME card: the door. The card sheet, on the context
  // index - the same one the index and the chips under a step open.
  await tap(page, anna.locator("> .map-hit"));
  await expect(page.locator(".sheet-title")).toHaveText("Card");
  await expect(page.locator(".sheet .input").first()).toHaveValue("Anna");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".h-title")).toHaveText("Context");

  // And its name, which is the same two-step on the same hook. Closing the
  // index goes back to the map it was opened from - the Close of the SCREEN,
  // not the one the sheet leaves behind for a moment while it slides out.
  await page.locator("#app").getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".h-title")).toHaveText("Map");
  await expect(page.locator(".map-scene.is-ready")).toHaveCount(1);
  await settled(page);
  const name = page.locator(".map-label.is-card").first();
  await tap(page, name.locator(".map-labelhit"));
  await expect(page.locator(".sheet-title")).toHaveCount(0);
  await expect(page.locator(".map-card.is-selected")).toHaveCount(1);
  await tap(page, page.locator(".map-label.is-card").first().locator(".map-labelhit"));
  await expect(page.locator(".sheet-title")).toHaveText("Card");
});

test("a selection moves, and lets go on empty sky", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await cardTree(page);
  await openMap(page);

  const ids = await page
    .locator(".map-card[data-card]")
    .evaluateAll((list) => list.map((g) => g.getAttribute("data-card")));
  expect(ids.length).toBe(3);

  await tap(page, page.locator(`.map-card[data-card="${ids[0]}"] > .map-hit`));
  await expect(page.locator(`.map-card[data-card="${ids[0]}"]`)).toHaveClass(/is-selected/);
  // Another card takes the selection over rather than adding a second one.
  await tap(page, page.locator(`.map-card[data-card="${ids[1]}"] > .map-hit`));
  await expect(page.locator(".map-card.is-selected")).toHaveCount(1);
  await expect(page.locator(`.map-card[data-card="${ids[1]}"]`)).toHaveClass(/is-selected/);

  // Coming closer to a family replaces the selection: one focus at a time.
  await tap(page, page.locator(roots).first().locator("> .map-hit"));
  await expect(page.locator(".map-card.is-selected")).toHaveCount(0);
  await expect(page.locator(".map-tree.has-focus")).toHaveCount(1);

  // And a selection is let go the way a focus is: on empty sky, and by the
  // recentre button. The focus above set the camera gliding, and on a slow
  // machine (CI) a tap fired mid-glide lands where the card no longer is -
  // wait for the spring to rest first.
  await settled(page);
  await tap(page, page.locator(`.map-card[data-card="${ids[0]}"] > .map-hit`));
  await expect(page.locator(".map-card.is-selected")).toHaveCount(1);
  await page.getByRole("button", { name: "Show everything" }).click();
  await expect(page.locator(".map-card.is-selected")).toHaveCount(0);
  await expect(page.locator(".map-cards.has-focus")).toHaveCount(0);
});

test("a dimmed card name stays legible, and the selected one comes up bright", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await cardTree(page);
  await openMap(page);

  // Focus the family Anna is NOT tied into: her diamond steps back, but her
  // name may only step back to the legibility floor - a dimmed goal still has
  // its lit disc, a dimmed card has nothing but this name (owner report from
  // the phone: "Rauten haben keinen Namen").
  const annaId = await page
    .locator(".map-card[data-card]")
    .evaluateAll((list) => {
      const dim = list.find((g) => !g.classList.contains("is-path"));
      return (dim || list[0]).getAttribute("data-card");
    });
  const lastRoot = page.locator(roots).last();
  await tap(page, lastRoot.locator("> .map-hit"));
  await expect(page.locator(".map-tree.has-focus")).toHaveCount(1);
  const dimLabel = page.locator(".map-label.is-card.is-dim").first();
  if ((await dimLabel.count()) > 0) {
    // The fade transition runs ~var(--dur); read the SETTLED value.
    await page.waitForTimeout(450);
    const opacity = await dimLabel.evaluate((n) => parseFloat(getComputedStyle(n).opacity));
    expect(opacity).toBeGreaterThanOrEqual(0.5);
  }

  // The first tap selects - and the label itself carries the state, so the
  // name visibly answers which card was hit even where the diamond is small.
  await tap(page, page.locator(`.map-card[data-card="${annaId}"] > .map-hit`));
  await expect(page.locator(`.map-card[data-card="${annaId}"]`)).toHaveClass(/is-selected/);
  await expect(page.locator(".map-label.is-card.is-selected")).toHaveCount(1);
  await expect(
    page.locator(".map-label.is-card.is-selected"),
  ).not.toHaveClass(/is-dim/);
});

test("every card carries its name, however crowded the sky", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES);
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const goals = ctx.childrenOf(null);
    // Ten goals and eight cards: eighteen names, well past the twelve the old
    // heuristic used to hide them at.
    for (let i = 0; i < 8; i += 1) {
      const card = ctx.addEntity({ name: `Someone ${i}`, kind: "person" });
      ctx.linkEntity(goals[i % goals.length].id, card);
    }
    ctx.setSettings({ mapMode: "sky", mapCards: true });
    ctx.go("outline", null, { replace: true });
  });
  await page.waitForTimeout(200);
  await openMap(page);

  await expect(page.locator(".map-card")).toHaveCount(8);
  // Nothing is focused, and all eight names are on the screen anyway.
  await expect(page.locator(".map-cards.has-focus")).toHaveCount(0);
  await expect(page.locator(".map-label.is-card")).toHaveCount(8);
  await expect(page.locator(".map-label")).toHaveCount(18);
  const names = await page
    .locator(".map-label.is-card .map-labeltext")
    .evaluateAll((list) => list.map((n) => n.textContent));
  expect(new Set(names).size).toBe(8);
});

test("a sensitive card puts its name on the map and nothing else", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await cardTree(page, { sensitive: true });
  await openMap(page);

  const names = await page
    .locator(".map-label.is-card .map-labeltext")
    .evaluateAll((list) => list.map((n) => n.textContent));
  expect(names).toContain("Doctor Vogt");
  // The relation and the notes are on the card, not on a screen that can be
  // held up in a room - and the sensitive one looks like every other card.
  const canvas = await page.locator(".map-canvas").textContent();
  expect(canvas).not.toContain("orthopaedist");
  expect(canvas).not.toContain("disc will not heal");
  await expect(page.locator(".map-card")).toHaveCount(4);
});

test("with reduced motion the cards stand as still as everything else", async ({ browser }) => {
  const context = await browser.newContext({ viewport: PHONE, reducedMotion: "reduce" });
  const page = await context.newPage();
  await freshApp(page);
  await setupVault(page);
  await cardTree(page);
  await openMap(page);

  await expect(page.locator(".map-card")).toHaveCount(3);
  const first = await page.locator(".map-card").first().getAttribute("transform");
  await page.waitForTimeout(500);
  const probe = await page.evaluate(() => window.__tfMap);
  expect(probe.frames).toBe(0);
  expect(probe.loop).toBe(false);
  expect(await page.locator(".map-card").first().getAttribute("transform")).toBe(first);
  await context.close();
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
