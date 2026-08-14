// The espresso question: the one thing this app ever asks for on its own.
//
// The rule it has to obey is quieter than the feature: after a week of real use
// ONE sheet asks whether tenfold is worth a coffee, and only where nobody found
// the tip jar by themselves. Everything below is a way for that to go wrong -
// asking a fresh vault, asking twice, asking somebody who already gave, asking
// inside the iOS shell where an external payment link is an App Store
// rejection, or elbowing in front of something that actually arrived from
// outside the app.
//
// Time is not slept through. The vault's age is a stamp in the sealed document
// (`settings.createdAt`), so a week is bought by writing the stamp a week back
// through the app's own setSettings - the same seam every other flag uses.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };
const DAY = 86400000;

// Real WebCrypto: 600000 PBKDF2 rounds per unlock, and every test unlocks twice.
test.describe.configure({ mode: "parallel", timeout: 240_000 });

// ------------------------------------------------------------------ stand-ins

/**
 * The smallest thing shell.js accepts as a native shell - an object with a
 * `post` function - which is exactly the condition supportAvailable() tests.
 */
async function stubShell(page) {
  await page.addInitScript(() => {
    window.__tenfoldShell = {
      platform: "ios",
      capabilities: ["reminder", "badge", "widget"],
      post() {
        return true;
      },
      send(message) {
        return Promise.resolve({ type: message.type, ok: true, enabled: false, permission: "denied" });
      },
      request() {
        return Promise.resolve({ type: "pong" });
      },
      _receive() {},
    };
  });
}

/** Whether this window is the installed home-screen app - push.js's own seam. */
async function setInstalled(page, value) {
  await page.evaluate(async (installed) => {
    const push = await import("/web/js/push.js");
    push.setInstalledProbe(() => installed);
  }, value);
}

/** A stand-in for the browser's push machinery, so the reminder can be offered. */
async function stubBrowserPush(page, endpoint) {
  await page.addInitScript((url) => {
    let current = null;
    const reg = {
      pushManager: {
        getSubscription: async () => current,
        subscribe: async () => {
          current = { endpoint: url, unsubscribe: async () => ((current = null), true) };
          return current;
        },
      },
    };
    Object.defineProperty(navigator.serviceWorker, "ready", {
      configurable: true,
      get: () => Promise.resolve(reg),
    });
    navigator.serviceWorker.getRegistration = async () => reg;
  }, endpoint);
}

/** Park a shared item exactly the way sw.js does, without needing a worker. */
async function stashShare(page, item) {
  await page.evaluate(async (value) => {
    const cache = await caches.open("tenfold-share-inbox");
    await cache.put(
      `${location.origin}/tenfold-share-inbox`,
      new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }),
    );
  }, item);
}

// -------------------------------------------------------------------- helpers

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

/** The first run, no server copy, into the outline. */
async function setupVault(page) {
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 60000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start empty/ }).click();
  await page.getByRole("button", { name: "Not now" }).click();
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 60000 });
}

/** Lock from inside the app: ctx.lock() awaits the seal, so nothing is in flight. */
async function lockNow(page) {
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    await ctx.lock();
  });
  await expect(page.locator(".lock-title")).toHaveText("Locked");
}

async function unlock(page) {
  await expect(page.locator(".lock-title")).toHaveText("Locked");
  // The screen swap runs as a transition, which replaces the DOM one frame
  // later. Typing into the node that is about to be thrown away leaves an
  // empty field and a click that submits nothing - which is exactly how this
  // helper failed before the wait was here.
  await page.waitForTimeout(600);
  await page.locator(".lock input").fill(PASS);
  await page.locator(".lock input").press("Enter");
  // An unlock no longer always opens The Ten: the app opens where the work is,
  // so a vault with something due or an unanswered daily question opens Today
  // instead (app.js `somethingWaits`, tests/landing.spec.js). The espresso
  // question is offered over whichever of the two it landed on - that is the
  // point of `offerAfterUnlock` running on both paths - so this helper only
  // waits for the app to be open, and does not care which screen won.
  await expect(page.locator(".h-title")).toHaveText(/^(Today|The Ten)$/, { timeout: 90000 });
}

/** Age the vault by moving its birthday back. The seam, not a sleep. */
async function ageVault(page, days) {
  await page.evaluate(async (d) => {
    const { ctx } = await import("/web/js/app.js");
    ctx.setSettings({ createdAt: Date.now() - d * 86400000 }, { now: true });
  }, days);
}

/** The sealed settings, opened the way the app opens them. */
async function docSettings(page) {
  return page.evaluate(async (pass) => {
    const store = await import("/web/js/store.js");
    const crypto = await import("/web/js/crypto.js");
    const vault = await store.loadVault();
    if (!vault) return null;
    const key = await crypto.unlockWithPassphrase(vault, pass);
    const doc = await crypto.openFromVault(vault, key);
    return doc.settings || {};
  }, PASS);
}

const nudge = (page) => page.locator(".sheet-title").filter({ hasText: "Enjoying tenfold?" });
const jar = (page) => page.locator(".sheet-title").filter({ hasText: "Buy me an espresso" });
const shareSheet = (page) => page.locator(".sheet-title").filter({ hasText: "Shared with tenfold" });
const reminderSheet = (page) => page.locator(".sheet-title").filter({ hasText: "Daily reminder" });

/** Long enough for the whole after-unlock chain to have had its turn. */
async function settle(page) {
  await page.waitForTimeout(2000);
}

// ----------------------------------------------------------------- the anchor

test("a fresh vault carries a birthday and is asked nothing", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);

  // The stamp is written at creation, which is the one moment that knows it.
  const settings = await docSettings(page);
  expect(typeof settings.createdAt).toBe("number");
  expect(Math.abs(Date.now() - settings.createdAt)).toBeLessThan(5 * 60000);

  await lockNow(page);
  await unlock(page);
  await settle(page);
  await expect(nudge(page)).toHaveCount(0);
  expect((await docSettings(page)).supportNudged).toBeUndefined();
});

test("six days is not a week", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await ageVault(page, 6);
  await lockNow(page);
  await unlock(page);
  await settle(page);
  await expect(nudge(page)).toHaveCount(0);
});

test("a vault older than the stamp is dated by the oldest thing in it", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);

  // A document from before this feature existed: no stamp at all, and one goal
  // written a month ago. The backfill on unlock has to find that date rather
  // than call the vault new, or every existing vault would be asked a week
  // after the update instead of a week after it was really started.
  await lockNow(page);
  await page.evaluate(async ({ pass, at }) => {
    const store = await import("/web/js/store.js");
    const cryptoMod = await import("/web/js/crypto.js");
    const model = await import("/web/js/model.js");
    const vault = await store.loadVault();
    const key = await cryptoMod.unlockWithPassphrase(vault, pass);
    const doc = await cryptoMod.openFromVault(vault, key);
    const settings = { ...doc.settings };
    delete settings.createdAt;
    const older = {
      ...doc,
      settings,
      nodes: [...doc.nodes, model.createNode({ title: "Written a month ago", createdAt: at, updatedAt: at })],
    };
    await store.saveVault(await cryptoMod.sealIntoVault(vault, key, older));
  }, { pass: PASS, at: Date.now() - 30 * DAY });

  await page.reload();
  await expect(page.locator(".lock-title")).toHaveText("Locked");
  await unlock(page);
  await expect(nudge(page)).toBeVisible({ timeout: 30000 });
  // And the backfilled stamp is that node's date, not today.
  await expect
    .poll(async () => (await docSettings(page)).createdAt, { timeout: 30000 })
    .toBeLessThan(Date.now() - 29 * DAY);
});

// ------------------------------------------------------------- the two answers

test("after a week it asks once, and Not now is for good", async ({ page }) => {
  const errors = [];
  // "Transition was skipped" is the browser aborting a view transition when the
  // next render or a navigation overtakes it. motion.js swallows it on
  // `vt.finished`; the rejection that reaches here comes off `vt.ready`, which
  // nothing awaits. It predates this feature and says nothing about it, so it
  // is named and ignored rather than allowed to hide a real exception.
  page.on("pageerror", (e) => {
    if (!String(e).includes("Transition was skipped")) errors.push(String(e));
  });
  await freshApp(page);
  await setupVault(page);
  await ageVault(page, 8);
  await lockNow(page);
  await unlock(page);

  await expect(nudge(page)).toBeVisible({ timeout: 30000 });
  const sheet = page.locator(".sheet");
  // The tip jar's own words, and the two ways out.
  await expect(sheet).toContainText("tenfold costs nothing");
  await expect(sheet.locator(".sheet-foot .btn-ghost")).toHaveText("Not now");
  await expect(sheet.locator(".sheet-foot .btn.is-primary")).toHaveText("Buy me an espresso");
  // A question, not a checkout: no address and no payment link on this sheet.
  await expect(sheet.locator(".addr")).toHaveCount(0);
  await expect(sheet.locator("a.btn")).toHaveCount(0);

  await sheet.locator(".sheet-foot .btn-ghost").click();
  await expect(nudge(page)).toHaveCount(0);
  await expect.poll(async () => (await docSettings(page)).supportNudged, { timeout: 30000 }).toBe(true);

  // A fast reload must not get the question back: the flag was sealed at once.
  await page.reload();
  await expect(page.locator(".lock-title")).toHaveText("Locked");
  await unlock(page);
  await settle(page);
  await expect(nudge(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the espresso button opens the jar and settles the question", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await ageVault(page, 8);
  await lockNow(page);
  await unlock(page);

  await expect(nudge(page)).toBeVisible({ timeout: 30000 });
  await page.locator(".sheet-foot .btn.is-primary").click();

  // The real tip jar, with the three ways to pay.
  await expect(jar(page)).toBeVisible();
  await expect(page.locator(".sheet .addr")).toHaveCount(2);
  await expect(page.locator(".sheet a.btn")).toHaveAttribute("href", "https://www.paypal.me/freshlab");

  await expect.poll(async () => (await docSettings(page)).supportNudged, { timeout: 30000 }).toBe(true);
  expect((await docSettings(page)).supportOpened).toBe(true);

  await page.reload();
  await expect(page.locator(".lock-title")).toHaveText("Locked");
  await unlock(page);
  await settle(page);
  await expect(nudge(page)).toHaveCount(0);
});

test("the X postpones to the next unlock and does not ask twice in one session", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await ageVault(page, 8);
  await lockNow(page);
  await unlock(page);
  await expect(nudge(page)).toBeVisible({ timeout: 30000 });

  // Closing with the X settles nothing - the same rule the share and reminder
  // offers follow. Only the two buttons are an answer.
  await page.locator(".sheet-head .iconbtn").click();
  await expect(nudge(page)).toHaveCount(0);
  await settle(page);
  expect((await docSettings(page)).supportNudged).toBeUndefined();

  // Nothing brings it back inside this session, even when the whole
  // after-unlock chain runs again.
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    await ctx.enterApp();
  });
  await settle(page);
  await expect(nudge(page)).toHaveCount(0);

  // The next unlock does bring it back, which is what "postponed" means.
  await lockNow(page);
  await unlock(page);
  await expect(nudge(page)).toBeVisible({ timeout: 30000 });
});

// ------------------------------------------------------------- who is not asked

test("somebody who found the tip jar first is never asked", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);

  // Day one, of their own accord, through the settings row.
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".setrow", { hasText: "Buy me an espresso" }).click();
  await expect(jar(page)).toBeVisible();
  await page.locator(".sheet-foot .btn").click();
  await expect.poll(async () => (await docSettings(page)).supportOpened, { timeout: 30000 }).toBe(true);

  await ageVault(page, 30);
  await lockNow(page);
  await unlock(page);
  await settle(page);
  await expect(nudge(page)).toHaveCount(0);
  expect((await docSettings(page)).supportNudged).toBeUndefined();
});

test("inside the shell nothing asks, at any age", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await ageVault(page, 30);
  await lockNow(page);

  // The same vault, now opened by the iOS app. A nudge towards PayPal here is
  // the same rejection as the link it leads to; the shell gets an in-app
  // purchase of its own, which is a different feature.
  await stubShell(page);
  await page.reload();
  await expect(page.locator(".lock-title")).toHaveText("Locked");
  await unlock(page);
  await settle(page);
  await expect(nudge(page)).toHaveCount(0);
  await expect(page.locator(".sheet")).toHaveCount(0);
  expect((await docSettings(page)).supportNudged).toBeUndefined();
});

// ------------------------------------------------------------------- the order

// The reminder is only ever pending after an unlock on iOS: everywhere else
// the first run asks it outright and settles it there. So the one place all
// three offers can be eligible at once is an iPhone, and this is that phone.
test.describe("on an iPhone", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });

  test("the chain order holds: share first, reminder next, espresso last", async ({ page }) => {
    await stubBrowserPush(page, "http://127.0.0.1:9/never");
    await freshApp(page);
    await setInstalled(page, false);

    // The server-copy branch, because the reminder offer needs a write token -
    // and the reminder question deferred to the installed app, which is what
    // leaves it pending.
    await page.getByRole("button", { name: "Set up the vault" }).click();
    await page.locator('input[type="password"]').first().fill(PASS);
    await page.locator('input[type="password"]').nth(1).fill(PASS);
    await page.getByRole("button", { name: /Create the vault/ }).click();
    await page.waitForSelector(".keygrid", { timeout: 60000 });
    await page.locator(".check").click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /Start empty/ }).click();
    await page.getByRole("button", { name: "Keep an encrypted copy on the server" }).click();
    await expect(page.locator(".eyebrow").filter({ hasText: "Reminder" })).toBeVisible({ timeout: 60000 });
    await page.getByRole("button", { name: "I will do it in the app" }).click();
    await page.getByRole("button", { name: "Begin" }).click();
    await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 60000 });

    await ageVault(page, 8);
    await stashShare(page, { title: "From another app", text: "Read this later", url: "", ts: Date.now() });
    await lockNow(page);
    await setInstalled(page, true);
    await unlock(page);

    // All three are eligible. The one that came from outside the app wins.
    await expect(shareSheet(page)).toBeVisible({ timeout: 30000 });
    await expect(reminderSheet(page)).toHaveCount(0);
    await expect(nudge(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Discard" }).click();
    await settle(page);
    // Nothing rushes into the gap it leaves: the rest waits for the next unlock.
    await expect(page.locator(".sheet")).toHaveCount(0);

    // Second unlock: no share left, so the reminder has its turn - still ahead
    // of the espresso question.
    await lockNow(page);
    await setInstalled(page, true);
    await unlock(page);
    await expect(reminderSheet(page)).toBeVisible({ timeout: 30000 });
    await expect(nudge(page)).toHaveCount(0);
    await page.locator(".sheet-foot").getByRole("button", { name: "Not now" }).click();
    await expect.poll(async () => (await docSettings(page)).pushOffered, { timeout: 30000 }).toBe(true);

    // Third unlock: everything else is answered, and only now does the app ask
    // for itself.
    await lockNow(page);
    await setInstalled(page, true);
    await unlock(page);
    await expect(nudge(page)).toBeVisible({ timeout: 30000 });
  });
});

test("the chain is written in that order in the source", async () => {
  const app = await readFile(join(ROOT, "web", "js", "app.js"), "utf8");
  const chain = app.slice(app.indexOf("async function offerAfterUnlock()"));
  const body = chain.slice(0, chain.indexOf("\n}"));
  expect(body).toMatch(/offerShare\(\)[\s\S]*offerPush\(\)[\s\S]*offerSupport\(\)/);
});

// ------------------------------------------------------------------ the words

test("the question is asked in all three languages", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const i18n = await import("/web/js/i18n.js");
    const out = {};
    for (const locale of ["en", "de", "es"]) {
      i18n.setLocale(locale);
      out[locale] = { title: i18n.t("supportNudge.title"), body: i18n.t("support.body") };
    }
    i18n.setLocale("en");
    return out;
  });

  expect(r.en.title).toBe("Enjoying tenfold?");
  expect(r.de.title).toBe("Gefällt dir tenfold?");
  expect(r.es.title).toBe("¿Te gusta tenfold?");
  // Spanish opens its questions as well as closing them.
  expect(r.es.title.startsWith("¿")).toBe(true);
  for (const locale of ["en", "de", "es"]) {
    expect(r[locale].title.endsWith("?")).toBe(true);
    // A missing key renders as the key itself.
    expect(r[locale].title).not.toMatch(/^supportNudge\./);
    expect(r[locale].body.length).toBeGreaterThan(40);
  }
});
