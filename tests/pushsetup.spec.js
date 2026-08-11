// The daily reminder where the decision is actually made: at vault creation.
//
// The owner's sentence, and the whole reason this spec exists: nobody switches
// a reminder on later in the settings. So the first run asks - right after the
// backup question, and only on the branch that said yes to the server copy,
// because a subscription needs that vault's write token. What cannot be asked
// in an iOS browser tab is picked up once, later, inside the installed app.
//
// What is real here and what is not: the vault, the sync id, the POST to
// /api/push/subscribe, what the server writes to disk and the dispatch that
// pokes a local sink are all real. Two things are stood in for, because a
// headless browser has neither: the browser's own push machinery (app.js does
// not even register a service worker under webdriver) and the answer to "am I
// the installed app", which push.js exposes as one overridable probe.
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Must match playwright.config.js webServer.env.
const DATA_DIR = join(tmpdir(), "tenfold-test-data");
const VAULT_DIR = join(DATA_DIR, "vaults");

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// Real WebCrypto: 600000 PBKDF2 rounds per unlock, and every test builds a vault.
test.describe.configure({ mode: "parallel", timeout: 240_000 });

// Every test in this file presses a button that asks for notification
// permission. Granting it up front is what a phone does after the tap.
test.use({ permissions: ["notifications"] });

// ------------------------------------------------------------------ stand-ins

/** A stand-in push service: one URL that can be pointed at and poked. */
async function pushSink() {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({
        url: req.url,
        authorization: req.headers.authorization || "",
        bodyLength: Buffer.concat(chunks).length,
      });
      res.writeHead(201).end();
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  return {
    received,
    url: `http://127.0.0.1:${port}/sink`,
    close: () => new Promise((done) => server.close(done)),
  };
}

/**
 * The browser half of web push, stood in for. A headless Chromium has no push
 * service to register with, so pushManager.subscribe would fail before the
 * app's own code ever ran. Everything downstream of this - the endpoint, the
 * hour, the token, the server, the disk - is the real thing.
 */
async function stubBrowserPush(page, endpoint) {
  await page.addInitScript((url) => {
    let current = null;
    const reg = {
      pushManager: {
        getSubscription: async () => current,
        subscribe: async (opts) => {
          current = {
            endpoint: url,
            options: { applicationServerKey: opts.applicationServerKey },
            unsubscribe: async () => {
              current = null;
              return true;
            },
          };
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

/** The other stand-in: whether this window is the installed home-screen app. */
async function setInstalled(page, value) {
  await page.evaluate(async (installed) => {
    const push = await import("/web/js/push.js");
    push.setInstalledProbe(() => installed);
  }, value);
}

// ------------------------------------------------------------------- helpers

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

/** Walk the first run up to - and not past - the backup question. */
async function walkToBackup(page) {
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 60000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start empty/ }).click();
  await expect(page.locator(".eyebrow")).toHaveText("Backup");
}

/** Past the About intro and into the outline. */
async function enterApp(page) {
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 60000 });
}

async function unlock(page) {
  await page.locator(".lock input").fill(PASS);
  await page.getByRole("button", { name: /Unlock/ }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 60000 });
}

/** The sync id off the stored vault - non-secret metadata, so this is honest. */
async function syncIdOf(page) {
  return page.evaluate(async () => {
    const store = await import("/web/js/store.js");
    const vault = await store.loadVault();
    return vault && vault.sync ? vault.sync.id : null;
  });
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

async function storedSubs(id) {
  try {
    return JSON.parse(await readFile(join(VAULT_DIR, id, "push.json"), "utf8"));
  } catch {
    return null;
  }
}

/** The same conversion push.js does, run in the suite's own time zone. */
function toUtcHour(localHour) {
  const d = new Date();
  d.setHours(localHour, 0, 0, 0);
  return d.getUTCHours();
}

const reminderStep = (page) => page.locator(".eyebrow").filter({ hasText: "Reminder" });
const offerSheet = (page) => page.locator(".sheet-title").filter({ hasText: "Daily reminder" });

// --------------------------------------------------------------------- specs

test("the copy branch offers the reminder, and turning it on really subscribes", async ({
  page,
  request,
}) => {
  const sink = await pushSink();
  try {
    await stubBrowserPush(page, sink.url);
    await freshApp(page);
    await walkToBackup(page);
    await page.getByRole("button", { name: "Keep an encrypted copy on the server" }).click();

    // The new step, immediately after the backup question.
    await expect(reminderStep(page)).toBeVisible({ timeout: 60000 });
    await expect(page.locator(".h-title")).toHaveText("One line a day");
    const turnOn = page.getByRole("button", { name: "Turn on the daily reminder" });
    await expect(turnOn).toHaveClass(/is-primary/);
    await expect(page.getByRole("button", { name: "Not now" })).toBeVisible();

    // The hour is the settings default until somebody changes it.
    const hour = page.getByLabel("Hour");
    await expect(hour).toHaveValue("8");
    await hour.fill("7");
    await turnOn.click();
    await enterApp(page);

    const id = await syncIdOf(page);
    expect(id).toMatch(/^[a-z0-9]{26}$/);

    // The server stored what the browser handed over: one endpoint, one hour.
    await expect.poll(async () => (await storedSubs(id))?.subs?.length ?? 0, { timeout: 30000 }).toBe(1);
    const stored = await storedSubs(id);
    expect(stored.subs[0].endpoint).toBe(sink.url);
    expect(stored.subs[0].hourUtc).toBe(toUtcHour(7));
    // Nothing readable travelled with it.
    expect(JSON.stringify(stored)).not.toContain("p256dh");

    // And it is a subscription the daily round can actually use.
    const dispatched = await request.post("/api/push/dispatch", { data: { hourUtc: toUtcHour(7) } });
    expect(dispatched.status()).toBe(200);
    await expect.poll(() => sink.received.length, { timeout: 15000 }).toBeGreaterThan(0);
    expect(sink.received[0].bodyLength).toBe(0);
    expect(sink.received[0].authorization).toContain("vapid");

    // The question is settled for this vault, on this device and every other.
    await expect.poll(async () => (await docSettings(page)).pushOffered, { timeout: 30000 }).toBe(true);
  } finally {
    await sink.close();
  }
});

test("Not now finishes the first run with no subscription and the question settled", async ({
  page,
}) => {
  const sink = await pushSink();
  try {
    await stubBrowserPush(page, sink.url);
    await freshApp(page);
    await walkToBackup(page);
    await page.getByRole("button", { name: "Keep an encrypted copy on the server" }).click();
    await expect(reminderStep(page)).toBeVisible({ timeout: 60000 });
    await page.getByRole("button", { name: "Not now" }).click();
    await enterApp(page);

    const id = await syncIdOf(page);
    expect(id).toMatch(/^[a-z0-9]{26}$/);
    await expect.poll(async () => (await docSettings(page)).pushOffered, { timeout: 30000 }).toBe(true);
    // Nothing was registered, and nothing was asked of the browser.
    expect(await storedSubs(id)).toBeNull();
  } finally {
    await sink.close();
  }
});

test("declining the backup skips the reminder step entirely", async ({ page }) => {
  await stubBrowserPush(page, "http://127.0.0.1:9/never");
  await freshApp(page);
  await walkToBackup(page);
  await page.getByRole("button", { name: "Not now" }).click();
  // The very next screen is the About intro, exactly as before this wave: the
  // thirty other specs that walk the first run this way stay untouched.
  await expect(page.getByRole("button", { name: "Begin" })).toBeVisible({ timeout: 60000 });
  await expect(reminderStep(page)).toHaveCount(0);
  await enterApp(page);

  expect(await syncIdOf(page)).toBeNull();
  // No decision was recorded, because none was asked for.
  expect((await docSettings(page)).pushOffered).toBeUndefined();
});

test.describe("on an iPhone", () => {
  test.use({ userAgent: IPHONE_UA });

  test("a browser tab is told the truth and nothing is recorded", async ({ page }) => {
    await stubBrowserPush(page, "http://127.0.0.1:9/never");
    await freshApp(page);
    await setInstalled(page, false);
    await walkToBackup(page);
    await page.getByRole("button", { name: "Keep an encrypted copy on the server" }).click();

    await expect(reminderStep(page)).toBeVisible({ timeout: 60000 });
    // No hour to set, no permission to ask for: one honest sentence and a way on.
    await expect(page.getByText("added to the home screen")).toBeVisible();
    await expect(page.getByLabel("Hour")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Turn on the daily reminder" })).toHaveCount(0);
    await page.getByRole("button", { name: "I will do it in the app" }).click();
    await enterApp(page);

    // Deliberately unsettled: the installed app is where this gets asked again.
    expect((await docSettings(page)).pushOffered).toBeUndefined();
  });

  test("the installed app offers it once after the unlock, and never again", async ({ page }) => {
    const sink = await pushSink();
    try {
      await stubBrowserPush(page, sink.url);
      await freshApp(page);
      await setInstalled(page, false);
      await walkToBackup(page);
      await page.getByRole("button", { name: "Keep an encrypted copy on the server" }).click();
      await expect(reminderStep(page)).toBeVisible({ timeout: 60000 });
      await page.getByRole("button", { name: "I will do it in the app" }).click();
      await enterApp(page);
      // In the tab, nothing offers itself.
      await expect(offerSheet(page)).toHaveCount(0);
      const id = await syncIdOf(page);

      // Now the same vault, opened from the home screen.
      await page.waitForTimeout(1500);
      await page.reload();
      await expect(page.locator(".lock-title")).toHaveText("Locked");
      await setInstalled(page, true);
      await unlock(page);

      await expect(offerSheet(page)).toBeVisible({ timeout: 30000 });
      await page.getByLabel("Hour").fill("6");
      await page.locator(".sheet-foot").getByRole("button", { name: "Turn on the daily reminder" }).click();

      await expect.poll(async () => (await storedSubs(id))?.subs?.length ?? 0, { timeout: 30000 }).toBe(1);
      expect((await storedSubs(id)).subs[0].hourUtc).toBe(toUtcHour(6));
      await expect.poll(async () => (await docSettings(page)).pushOffered, { timeout: 30000 }).toBe(true);

      // Second unlock: settled means settled.
      await page.reload();
      await expect(page.locator(".lock-title")).toHaveText("Locked");
      await setInstalled(page, true);
      await unlock(page);
      await page.waitForTimeout(2000);
      await expect(offerSheet(page)).toHaveCount(0);
    } finally {
      await sink.close();
    }
  });

  test("Not now on the offer dismisses it for good", async ({ page }) => {
    await stubBrowserPush(page, "http://127.0.0.1:9/never");
    await freshApp(page);
    await setInstalled(page, false);
    await walkToBackup(page);
    await page.getByRole("button", { name: "Keep an encrypted copy on the server" }).click();
    await expect(reminderStep(page)).toBeVisible({ timeout: 60000 });
    await page.getByRole("button", { name: "I will do it in the app" }).click();
    await enterApp(page);
    const id = await syncIdOf(page);

    await page.waitForTimeout(1500);
    await page.reload();
    await expect(page.locator(".lock-title")).toHaveText("Locked");
    await setInstalled(page, true);
    await unlock(page);
    await expect(offerSheet(page)).toBeVisible({ timeout: 30000 });
    await page.locator(".sheet-foot").getByRole("button", { name: "Not now" }).click();
    await expect(offerSheet(page)).toHaveCount(0);
    await expect.poll(async () => (await docSettings(page)).pushOffered, { timeout: 30000 }).toBe(true);
    expect(await storedSubs(id)).toBeNull();

    await page.reload();
    await expect(page.locator(".lock-title")).toHaveText("Locked");
    await setInstalled(page, true);
    await unlock(page);
    await page.waitForTimeout(2000);
    await expect(offerSheet(page)).toHaveCount(0);
  });

  test("with sync off there is nothing to offer", async ({ page }) => {
    await stubBrowserPush(page, "http://127.0.0.1:9/never");
    await freshApp(page);
    await setInstalled(page, true);
    await walkToBackup(page);
    await page.getByRole("button", { name: "Not now" }).click();
    await enterApp(page);
    expect(await syncIdOf(page)).toBeNull();

    await page.waitForTimeout(1500);
    await page.reload();
    await expect(page.locator(".lock-title")).toHaveText("Locked");
    await setInstalled(page, true);
    await unlock(page);
    await page.waitForTimeout(2000);
    // No write token, no subscription, so no question - the settings row is
    // where sync gets turned on, and the reminder follows it there.
    await expect(offerSheet(page)).toHaveCount(0);
    expect((await docSettings(page)).pushOffered).toBeUndefined();
  });
});
