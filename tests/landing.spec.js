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
