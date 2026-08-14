// Where the app opens.
//
// An unlock used to go to The Ten, always. It now opens where the work is: if
// something is due now, or the day's question is still unanswered, it opens
// Today; otherwise The Ten. The rule is one function in app.js
// (`somethingWaits`) and it asks badge.js the same two questions the icon and
// the home-screen widget are fed from - `badgeCount` and `questionWaits` - so
// there is exactly one definition of "something is waiting" in the app. The
// last test in this file is what holds that: it reads the two calls straight
// out of badge.js and asserts they agree with the screen that appeared. If the
// badge could ever say "nothing" while the app opened Today, one of the two
// would be lying and nobody would notice, because nobody looks at an icon and a
// screen in the same second.
//
// Two things are exempt, and both are checked here as well. An explicit
// `pendingView` - a notification, a share - is somebody's own tap and outranks
// anything computed from a document. And a first run never lands on Today: a
// vault made ninety seconds ago has nothing due, so the only thing that could
// be "waiting" is the daily question, and the question card over "Nothing calls
// for today" is the worst possible first screen this app could show.
//
// Since the start-screen setting (doc.settings.landing) the rule above is the
// DEFAULT rather than the only answer, and the second half of this file is
// about that: The Ten and the map can be asked for outright, "Today" stays the
// rule rather than the screen, the map steps aside on a vault with nothing on
// it, and a notification still beats all three. The one test that matters most
// is the one that asserts the field is ABSENT after an ordinary setup - it is
// the guard for everybody who never opens settings, and if it ever goes red the
// default has moved under somebody who did not ask for it.
import { test, expect } from "@playwright/test";

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

// Real WebCrypto: 600000 PBKDF2 rounds per unlock, and every test unlocks.
test.describe.configure({ mode: "parallel", timeout: 240_000 });

// ------------------------------------------------------------------ helpers

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

/** The first run up to the starting-point question, which the caller answers. */
async function walkToTemplate(page) {
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 60000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
}

async function setupVault(page) {
  await walkToTemplate(page);
  await page.getByRole("button", { name: /Start empty/ }).click();
  await page.getByRole("button", { name: "Not now" }).click();
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 60000 });
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
 * Lock from inside the app rather than by reloading: the autosave is debounced
 * by 600 ms and `ctx.lock()` flushes it, so nothing written a moment ago is
 * still in the air when the vault is sealed.
 */
async function lockNow(page) {
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    await ctx.lock();
  });
  await page.waitForSelector(".lock-title");
}

async function unlock(page) {
  await page.waitForSelector(".lock-title");
  await page.locator(".lock input").fill(PASS);
  await page.getByRole("button", { name: /Unlock/ }).click();
}

/** Put today's question away, the way the card's own button does. */
async function dismissQuestion(page) {
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.locator(".qcard")).toBeVisible();
  await page.getByRole("button", { name: "Not today" }).click();
  await expect(page.locator(".qcard")).toHaveCount(0);
  await page.locator(".head-actions").getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
}

/** Give the first leaf a due date. The seam the badge tests use, not a sleep. */
async function makeSomethingDue(page) {
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const leaf = ctx.doc.nodes.find((n) => !n.deletedAt);
    const noon = new Date();
    noon.setHours(9, 0, 0, 0);
    ctx.updateNode(leaf.id, { due: noon.getTime() });
  });
}

/**
 * A screen change is one View Transition, and while it runs the real DOM is
 * replaced by snapshots that swallow every hit test - a click issued into one
 * is retried against whatever the new screen put at those coordinates.
 */
async function settled(page) {
  await page.waitForFunction(() =>
    !document
      .getAnimations()
      .some((a) => String((a.effect && a.effect.pseudoElement) || "").includes("view-transition")),
  );
}

/** What the document says the start screen is - undefined until somebody picks. */
function landingSetting(page) {
  return page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return ctx.doc.settings.landing;
  });
}

/**
 * Pick a start screen through the real control, from the outline.
 *
 * Deliberately not `ctx.setSettings({ landing })`: the segment in settings is
 * half of what is being shipped here, and a test that writes the field itself
 * would still pass with three buttons that do nothing. The names are the
 * screens' own header titles, which is the point of the control.
 */
async function chooseStartScreen(page, label) {
  await settled(page);
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await expect(page.locator(".h-title")).toHaveText("Settings");
  const seg = page.getByRole("group", { name: "Start screen" });
  await seg.getByRole("button", { name: label, exact: true }).click();
  await expect(seg.getByRole("button", { name: label, exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator(".head-actions").getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
}

const landed = (page) => page.locator(".h-title");

// -------------------------------------------------------------- the two ways

test("with nothing waiting the app opens The Ten", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail properly", "Get the knee fixed"]);
  // A list with goals in it but nothing dated, and the question answered for
  // the day: this is the state where there is genuinely nothing to do now, and
  // The Ten is where somebody would want to think rather than act.
  await dismissQuestion(page);

  await lockNow(page);
  await unlock(page);
  await expect(landed(page)).toHaveText("The Ten", { timeout: 60000 });
});

test("with the day's question still unanswered the app opens Today", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail properly"]);
  // Nothing is dated here at all. The question alone is enough - it is half of
  // what the widget calls waiting, so it has to be half of this too.

  await lockNow(page);
  await unlock(page);
  await expect(landed(page)).toHaveText("Today", { timeout: 60000 });
  await expect(page.locator(".qcard")).toBeVisible();

  // The outline is underneath, so the close button lands where it always does.
  await page.locator(".head-actions").getByRole("button", { name: "Close" }).click();
  await expect(landed(page)).toHaveText("The Ten");
});

test("with something due the app opens Today even once the question is away", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Ship the thing"]);
  await dismissQuestion(page);
  await makeSomethingDue(page);

  await lockNow(page);
  await unlock(page);
  await expect(landed(page)).toHaveText("Today", { timeout: 60000 });
  // The due step is the reason, and it is on the screen rather than only in a
  // count: no question card here, the question was put away.
  await expect(page.locator(".qcard")).toHaveCount(0);
  await expect(page.locator(".row-title")).toHaveText(["Ship the thing"]);
});

// ------------------------------------------------------------- the two exemptions

test("an explicit view from the notification wins over the rule", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Sort the paperwork"]);
  await dismissQuestion(page);
  await lockNow(page);

  // Nothing is waiting, so the rule would say The Ten. The notification says
  // Today, and a person's own tap outranks anything computed from a document.
  await page.goto("/web/index.html?view=today");
  await unlock(page);
  await expect(landed(page)).toHaveText("Today", { timeout: 60000 });

  // And the parameter is spent: the next unlock obeys the rule again.
  expect(await page.evaluate(() => location.search)).toBe("");
  await lockNow(page);
  await unlock(page);
  await expect(landed(page)).toHaveText("The Ten", { timeout: 60000 });
});

test("the first run lands on The Ten, never on Today", async ({ page }) => {
  await freshApp(page);
  await walkToTemplate(page);
  // The frame, deliberately: it seeds eight goals, so by the time the intro is
  // read the daily question IS waiting and the rule alone would open Today -
  // over an empty list, with "Nothing calls for today" under the card, as the
  // first thing somebody sees after handing this app a passphrase.
  await page.getByRole("button", { name: /Start with a frame/ }).click();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.locator(".prose")).toBeVisible();
  await page.getByRole("button", { name: "Begin" }).click();

  await expect(landed(page)).toHaveText("The Ten", { timeout: 60000 });
  await expect(page.locator(".row-title").first()).toBeVisible();

  // The exemption is the first run and nothing more: the same vault, unlocked
  // a second time, obeys the rule and opens Today.
  await lockNow(page);
  await unlock(page);
  await expect(landed(page)).toHaveText("Today", { timeout: 60000 });
});

// ------------------------------------------------------------------- one rule

test("the landing is the badge's own arithmetic, not a second opinion", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail properly"]);

  /** What badge.js says, asked exactly as badge.js is asked for the icon. */
  const waiting = () =>
    page.evaluate(async () => {
      const { ctx } = await import("/web/js/app.js");
      const badge = await import("/web/js/badge.js");
      const now = Date.now();
      return {
        due: badge.badgeCount(ctx.doc, { now }),
        question: badge.questionWaits(ctx.doc, { now }),
      };
    });

  // Question waiting -> Today, and badge.js says so too.
  await lockNow(page);
  await unlock(page);
  await expect(landed(page)).toHaveText("Today", { timeout: 60000 });
  expect(await waiting()).toEqual({ due: 0, question: true });

  // Put it away and lock: now badge.js says nothing is waiting, and the app
  // has to agree. This is the pair that must never come apart.
  await page.getByRole("button", { name: "Not today" }).click();
  await expect(page.locator(".qcard")).toHaveCount(0);
  expect(await waiting()).toEqual({ due: 0, question: false });

  await lockNow(page);
  await unlock(page);
  await expect(landed(page)).toHaveText("The Ten", { timeout: 60000 });
  expect(await waiting()).toEqual({ due: 0, question: false });
});

// ------------------------------------------------------- the start screen setting

test("without the setting the rule is what runs, and the field is not there", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail properly"]);

  // The guard for everybody who never opens settings: an ordinary vault carries
  // no landing field at all, and both branches of the rule still fire on it.
  expect(await landingSetting(page)).toBeUndefined();

  await dismissQuestion(page);
  await lockNow(page);
  await unlock(page);
  await expect(landed(page)).toHaveText("The Ten", { timeout: 60000 });

  await makeSomethingDue(page);
  await lockNow(page);
  await unlock(page);
  await expect(landed(page)).toHaveText("Today", { timeout: 60000 });

  expect(await landingSetting(page)).toBeUndefined();
});

test("Today is the rule and not the screen: with nothing waiting it opens The Ten", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail properly"]);
  await dismissQuestion(page);
  await chooseStartScreen(page, "Today");
  expect(await landingSetting(page)).toBe("today");

  // Chosen outright, and it still does not open an empty Today - Today means
  // "open where the work is", which with nothing due and the question answered
  // is The Ten. settings.landingDesc is where that is said out loud.
  await lockNow(page);
  await unlock(page);
  await expect(landed(page)).toHaveText("The Ten", { timeout: 60000 });
});

test("The Ten, chosen, wins over something waiting", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Ship the thing"]);
  await makeSomethingDue(page);
  await chooseStartScreen(page, "The Ten");
  expect(await landingSetting(page)).toBe("outline");

  // Something IS due and the question is unanswered, so the rule would open
  // Today. The setting is unconditional, which is the whole reason it exists.
  await lockNow(page);
  await unlock(page);
  await expect(landed(page)).toHaveText("The Ten", { timeout: 60000 });
});

test("the map, chosen, opens with the outline underneath it", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail properly", "Get the knee fixed"]);
  await chooseStartScreen(page, "Map");
  expect(await landingSetting(page)).toBe("map");

  // The question is still waiting here, so this is the map winning over the
  // rule as well as over The Ten.
  await lockNow(page);
  await unlock(page);
  await expect(landed(page)).toHaveText("Map", { timeout: 60000 });
  await expect(page.locator(".map-canvas")).toBeVisible();
  await expect(page.locator(".map-scene.is-ready")).toHaveCount(1);

  // Same arrangement Today gets: the close button is ctx.back(), and what is
  // behind it is the outline, never the lock screen.
  await settled(page);
  await page.locator(".head-actions").getByRole("button", { name: "Close" }).click();
  await expect(landed(page)).toHaveText("The Ten");
});

test("the map steps aside on a vault with nothing on it", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  // No roots at all. The map is not broken there - it draws a centre mark and
  // "Nothing on the map yet" - but it is a reading of a list with nothing to
  // read, and its own hint says to write the ten, which only the outline can do.
  await chooseStartScreen(page, "Map");

  await lockNow(page);
  await unlock(page);
  await expect(landed(page)).toHaveText("The Ten", { timeout: 60000 });
  // The choice is untouched: it is the vault that is empty, not the setting.
  expect(await landingSetting(page)).toBe("map");

  // One goal is enough for the map to mean something, and then it is shown.
  await addRoots(page, ["Learn to sail properly"]);
  await lockNow(page);
  await unlock(page);
  await expect(landed(page)).toHaveText("Map", { timeout: 60000 });
});

test("a notification still wins over a chosen start screen", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Sort the paperwork"]);
  await chooseStartScreen(page, "The Ten");
  await lockNow(page);

  // A person's own tap outranks a preference they set last month, exactly as it
  // outranks arithmetic over their document.
  await page.goto("/web/index.html?view=today");
  await unlock(page);
  await expect(landed(page)).toHaveText("Today", { timeout: 60000 });

  // And the parameter is spent: the next unlock obeys the setting again.
  await lockNow(page);
  await unlock(page);
  await expect(landed(page)).toHaveText("The Ten", { timeout: 60000 });
});

test("the choice is sealed into the document and outlives the page", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail properly"]);
  await chooseStartScreen(page, "Map");
  await lockNow(page);

  // Not just a lock: the whole page goes. What comes back can only have come
  // out of the sealed vault, which is where a setting in doc.settings belongs -
  // it travels with the document to every device, not with this browser.
  await page.reload();
  await unlock(page);
  await expect(landed(page)).toHaveText("Map", { timeout: 60000 });
  expect(await landingSetting(page)).toBe("map");

  // And the control shows the choice it made, so somebody can change it back.
  await settled(page);
  await page.locator(".head-actions").getByRole("button", { name: "Close" }).click();
  await expect(landed(page)).toHaveText("The Ten");
  await settled(page);
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  const seg = page.getByRole("group", { name: "Start screen" });
  await expect(seg.getByRole("button", { name: "Map", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(seg.getByRole("button", { name: "Today", exact: true })).toHaveAttribute("aria-pressed", "false");
});
