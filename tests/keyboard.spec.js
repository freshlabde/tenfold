// The keyboard, and the sheet that has to get out from under it.
//
// Owner report: "Click auf Tell the Story - Eingabefeld taucht hinter Keyboard
// auf. Ich muss rauf scrollen." On iOS the software keyboard is drawn OVER the
// page instead of shrinking it, so a sheet pinned to the bottom of the frame
// keeps sitting exactly where the keys now are. ui/sheet.js watches the visual
// viewport and lifts the sheet by whatever is covering the bottom.
//
// What can honestly be tested here, and what cannot: Playwright raises no
// keyboard, and no browser flag makes Chromium behave like WKWebView. So the
// arithmetic is factored out as a pure function and checked directly, and the
// wiring is checked against a MOCKED visual viewport installed before the app
// loads - the same object shape the API has, with a height this file controls.
// That covers the formula, the transform, the release and the focused field.
// It does not cover a real iOS keyboard, which stays a device check.
import { test, expect } from "@playwright/test";

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };
/** What an iPhone keyboard takes off the bottom, roughly, in CSS pixels. */
const KEYBOARD = 336;

test.describe.configure({ mode: "parallel", timeout: 90_000 });

// ------------------------------------------------------------------ the mock

/**
 * Replace window.visualViewport with an object of the same shape whose height
 * this file sets. Installed as an init script so it is in place before any
 * module reads the property.
 */
async function mockViewport(page) {
  await page.addInitScript(() => {
    const bus = new EventTarget();
    const vv = {
      height: 0,
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
      get width() {
        return window.innerWidth;
      },
      addEventListener: (...args) => bus.addEventListener(...args),
      removeEventListener: (...args) => bus.removeEventListener(...args),
      dispatchEvent: (ev) => bus.dispatchEvent(ev),
    };
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      get() {
        // Until a test says otherwise, the visual viewport is the layout one -
        // which is the truth on a desktop with no keyboard anywhere.
        if (!vv.height) vv.height = window.innerHeight;
        return vv;
      },
    });
    window.__keyboard = {
      show(px, offsetTop = 0) {
        vv.height = window.innerHeight - px;
        vv.offsetTop = offsetTop;
        bus.dispatchEvent(new Event("resize"));
      },
      hide() {
        vv.height = window.innerHeight;
        vv.offsetTop = 0;
        bus.dispatchEvent(new Event("resize"));
      },
    };
  });
}

/** No visual viewport at all - every browser that predates the API. */
async function noViewportApi(page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => undefined });
  });
}

/** The frame, the overlay layer and the real stylesheets, without the app. */
async function bareFrame(page) {
  await page.setViewportSize(PHONE);
  await page.goto("/tests/fixture.html");
  await page.addStyleTag({ url: "/web/css/tokens.css" });
  await page.addStyleTag({ url: "/web/css/app.css" });
  await page.evaluate(() => {
    document.documentElement.dataset.skin = "slate";
    document.documentElement.dataset.theme = "dark";
    const frame = document.createElement("div");
    frame.className = "frame";
    const layer = document.createElement("div");
    layer.id = "layer";
    layer.className = "layer";
    frame.appendChild(layer);
    document.body.appendChild(frame);
  });
}

/** The translateY a browser actually computed, in pixels. */
async function liftOf(page) {
  return page.locator(".sheet").evaluate((node) => {
    const value = getComputedStyle(node).transform;
    if (!value || value === "none") return 0;
    const parts = value.slice(value.indexOf("(") + 1, -1).split(",");
    const lift = -Math.round(Number(parts[parts.length - 1]));
    // Negative zero is a real value in JavaScript and fails a plain equality
    // against 0. "Not lifted" is one number here, not two.
    return lift === 0 ? 0 : lift;
  });
}

/**
 * Wait until the sheet has stopped moving. Both the way in and the lift ride
 * the same transform transition, so a measurement taken one frame too early
 * reads a number that belongs to neither state.
 */
async function settled(page) {
  await page.locator(".sheet").evaluate(async (node) => {
    // Two frames first: the sheet is appended flat and only gets its is-open
    // class on the next frame, so a transition asked for too early is not
    // running yet and getAnimations would answer "nothing to wait for".
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    await Promise.allSettled(node.getAnimations().map((a) => a.finished));
  });
}

// -------------------------------------------------------------- the formula

test("the lift is what the keyboard covers, floored, capped and guarded", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const { liftFor, KEYBOARD_MIN, MAX_LIFT_RATIO } = await import("/web/js/ui/sheet.js");
    return {
      min: KEYBOARD_MIN,
      ratio: MAX_LIFT_RATIO,
      // Nothing covering anything: the sheet stays where it is.
      idle: liftFor(844, 844, 0),
      // An iPhone keyboard under a 844pt screen.
      keyboard: liftFor(844, 508, 0),
      // iOS scrolled the visual viewport down over the layout one to "reveal"
      // the field. What is covered is what is left BELOW the visual viewport,
      // so the offset counts as much as the height does.
      scrolled: liftFor(844, 508, 40),
      // A toolbar sliding away is not a keyboard.
      toolbar: liftFor(844, 800, 0),
      // Exactly at the floor, and one pixel under it.
      atFloor: liftFor(844, 784, 0),
      underFloor: liftFor(844, 785, 0),
      // Something went wrong: the cap keeps the sheet on the screen.
      absurd: liftFor(844, 40, 0),
      // Junk in, zero out - never NaN into a transform.
      nan: liftFor(NaN, 508, 0),
      undef: liftFor(844, undefined, undefined),
      zero: liftFor(0, 0, 0),
      negative: liftFor(844, 900, 0),
      noOffset: liftFor(844, 508, undefined),
      // Pinched to 2x and panned to the top of the page. Half the layout
      // viewport is genuinely below what is visible, and it is not a keyboard:
      // reading close up must not fling the sheet half way up the screen.
      zoomedTop: liftFor(844, 422, 0, 2),
      // The same zoom with a keyboard actually up. Still nothing: the two
      // cannot be told apart by subtraction, and leaving a zoomed page where
      // its reader put it is the safer of the two wrong answers.
      zoomedKeyboard: liftFor(844, 250, 0, 2),
      // A browser that reports a rounding artefact instead of exactly 1 is not
      // a zoomed page, and a sheet that refused to lift there would be a
      // keyboard sitting on the field.
      unzoomed: liftFor(844, 508, 0, 1.0000000000000002),
      // No scale reported at all: every browser that had this behaviour keeps
      // it, unchanged.
      noScale: liftFor(844, 508, 0, undefined),
    };
  });

  expect(r.min).toBe(60);
  expect(r.ratio).toBe(0.75);
  expect(r.idle).toBe(0);
  expect(r.keyboard).toBe(336);
  expect(r.scrolled).toBe(296);
  expect(r.toolbar).toBe(0);
  expect(r.atFloor).toBe(60);
  expect(r.underFloor).toBe(0);
  expect(r.absurd).toBe(633);
  expect(r.nan).toBe(0);
  expect(r.undef).toBe(0);
  expect(r.zero).toBe(0);
  expect(r.negative).toBe(0);
  // A missing offsetTop reads as no offset, not as a broken sum.
  expect(r.noOffset).toBe(336);
  expect(r.zoomedTop).toBe(0);
  expect(r.zoomedKeyboard).toBe(0);
  expect(r.unzoomed).toBe(336);
  expect(r.noScale).toBe(336);
});

// ------------------------------------------------------------- the sheet layer

test("a sheet rides above the mocked keyboard and comes back down", async ({ page }) => {
  await mockViewport(page);
  await bareFrame(page);

  await page.evaluate(async () => {
    const { openSheet } = await import("/web/js/ui/sheet.js");
    const { el } = await import("/web/js/ui/dom.js");
    const field = el("textarea", { class: "textarea", attrs: { rows: "4", id: "probe" } });
    openSheet(document.getElementById("layer"), { title: "Four questions", body: el("div", {}, [field]) });
  });
  await expect(page.locator(".sheet")).toBeVisible();
  await page.locator("#probe").focus();
  await settled(page);
  expect(await liftOf(page)).toBe(0);

  const before = await page.locator("#probe").boundingBox();
  expect(before.y + before.height).toBeGreaterThan(PHONE.height - KEYBOARD);

  await page.evaluate((px) => window.__keyboard.show(px), KEYBOARD);
  await expect.poll(() => liftOf(page)).toBe(KEYBOARD);

  // The point of the whole exercise: the field somebody types in is above the
  // line the keys start at, not behind them.
  const after = await page.locator("#probe").boundingBox();
  expect(after.y + after.height).toBeLessThanOrEqual(PHONE.height - KEYBOARD);
  const sheet = await page.locator(".sheet").boundingBox();
  expect(Math.round(sheet.y + sheet.height)).toBeLessThanOrEqual(PHONE.height - KEYBOARD);
  // And the sheet did not grow a head that leaves the frame while it is up.
  expect(sheet.y).toBeGreaterThanOrEqual(0);

  await page.evaluate(() => window.__keyboard.hide());
  await expect.poll(() => liftOf(page)).toBe(0);
});

test("closing takes the lift with it, and a second sheet starts flat", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mockViewport(page);
  await bareFrame(page);

  const open = async () =>
    page.evaluate(async () => {
      const { openSheet } = await import("/web/js/ui/sheet.js");
      const { el } = await import("/web/js/ui/dom.js");
      openSheet(document.getElementById("layer"), {
        title: "Four questions",
        body: el("div", {}, [el("textarea", { class: "textarea", attrs: { rows: "4", id: "probe" } })]),
      });
    });

  await open();
  await page.evaluate((px) => window.__keyboard.show(px), KEYBOARD);
  await expect.poll(() => liftOf(page)).toBe(KEYBOARD);

  await page.evaluate(async () => {
    const { closeSheet } = await import("/web/js/ui/sheet.js");
    closeSheet();
  });
  await expect(page.locator(".sheet")).toHaveCount(0);

  // The listeners went with it: a keyboard coming down over an empty layer
  // reaches nothing, and nothing throws for having been detached.
  await page.evaluate(() => window.__keyboard.hide());
  await open();
  await settled(page);
  expect(await liftOf(page)).toBe(0);
  expect(errors).toEqual([]);
});

test("a sheet opened while the keyboard is already up starts lifted", async ({ page }) => {
  await mockViewport(page);
  await bareFrame(page);

  // The order that actually happens on a phone: a field is focused somewhere,
  // the keys are up, and only then does a sheet arrive.
  await page.evaluate((px) => window.__keyboard.show(px), KEYBOARD);
  await page.evaluate(async () => {
    const { openSheet } = await import("/web/js/ui/sheet.js");
    const { el } = await import("/web/js/ui/dom.js");
    openSheet(document.getElementById("layer"), {
      title: "Four questions",
      body: el("div", {}, [el("textarea", { class: "textarea", attrs: { rows: "4", id: "probe" } })]),
    });
  });

  await settled(page);
  expect(await liftOf(page)).toBe(KEYBOARD);
  const sheet = await page.locator(".sheet").boundingBox();
  expect(Math.round(sheet.y + sheet.height)).toBeLessThanOrEqual(PHONE.height - KEYBOARD);
});

test("a browser without the visual viewport keeps exactly the behaviour it had", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await noViewportApi(page);
  await bareFrame(page);

  await page.evaluate(async () => {
    const { openSheet } = await import("/web/js/ui/sheet.js");
    const { el } = await import("/web/js/ui/dom.js");
    openSheet(document.getElementById("layer"), {
      title: "Four questions",
      body: el("div", {}, [el("textarea", { class: "textarea", attrs: { rows: "4", id: "probe" } })]),
    });
  });

  await expect(page.locator(".sheet")).toBeVisible();
  await settled(page);
  expect(await liftOf(page)).toBe(0);
  expect(await page.locator(".sheet").getAttribute("style") || "").not.toContain("--kb-lift");
  expect(errors).toEqual([]);
});

// -------------------------------------------------------------- the real sheet

test("the story guide inherits the lift, without knowing that it does", async ({ page }) => {
  await mockViewport(page);
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
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start empty/ }).click();
  await page.getByRole("button", { name: "Not now" }).click();
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");

  await page.getByRole("button", { name: /Write the first one|New entry/ }).click();
  await page.locator(".composer input").fill("Spanish up to B2");
  await page.locator(".composer input").press("Enter");
  await page.locator(".composer input").press("Escape");
  await page.locator(".row-shell").first().locator(".row").click();
  await page.locator(".hero-card").click();
  await expect(page.locator(".leaf-title")).toHaveText("Spanish up to B2");

  await page.getByRole("button", { name: "Tell the story" }).click();
  await expect(page.locator(".guide-q")).toContainText("matter now");
  await settled(page);
  expect(await liftOf(page)).toBe(0);

  await page.evaluate((px) => window.__keyboard.show(px), KEYBOARD);
  await expect.poll(() => liftOf(page)).toBe(KEYBOARD);

  const field = await page.locator(".sheet textarea").boundingBox();
  expect(field.y + field.height).toBeLessThanOrEqual(PHONE.height - KEYBOARD);
  // The title the owner could still see is where it always was: on the sheet,
  // above its own field, and not the only thing left over the keys.
  await expect(page.locator(".sheet-title")).toHaveText("Four questions");
});
