// The app inside the native shell.
//
// tenfold ships twice from one source: as a web app, and bundled inside a thin
// iOS shell (the tenfold-ios repository) that injects `window.__tenfoldShell`
// before any of these modules run. Where the shell is present, two features
// change transport without changing a single screen:
//
//   - the daily reminder becomes a LOCAL notification, scheduled by
//     UNUserNotificationCenter. No VAPID key, no subscription, no /api/push
//     call - and the test that matters most in this file is the one asserting
//     that last part, because a reminder that quietly kept talking to the
//     server would be a privacy regression nobody would see.
//   - the badge count, which WKWebView has no Badging API for, crosses the
//     bridge instead, and brings the widget's two counters with it.
//
// The shell here is a stub. It records every message and answers the way the
// real one does; what is under test is the WEB half of the contract - which
// message goes out, with which fields, and which network call does NOT happen.
// The native half is tested in tenfold-ios/Tests/Unit. The wire shape is
// written down once, in tenfold-ios/docs/BRIDGE.md, and both suites assert
// against it literally rather than deriving it, because a rename in either
// repository has to fail loudly instead of quietly agreeing with itself.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Real WebCrypto: 600000 PBKDF2 rounds per unlock.
test.describe.configure({ mode: "parallel", timeout: 240_000 });

/** The sentence the shell is handed, in the language the app is showing. */
const NOTICE = { title: "tenfold", body: "Your question is waiting." };

// ------------------------------------------------------------------- the stub

/**
 * Install a stand-in for the native shell, before the app's modules run.
 *
 * It answers like the real one (see the Swift in
 * tenfold-ios/Sources/Bridge/Reminders.swift) and keeps every message in
 * `window.__shellMessages` so a test can read what crossed.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{capabilities?: string[], permission?: string, refuse?: boolean}} [opts]
 */
async function stubShell(page, opts = {}) {
  await page.addInitScript((config) => {
    const messages = [];
    window.__shellMessages = messages;
    window.__shellState = { enabled: false, hour: 8, permission: config.permission };

    function answer(message) {
      const s = window.__shellState;
      if (message.type === "reminder.schedule") {
        // The real shell asks the operating system for authorization inside
        // this call. `refuse` is the person tapping "Don't Allow".
        if (config.refuse) s.permission = "denied";
        if (s.permission === "denied") {
          return { type: "reminder.scheduled", ok: false, permission: "denied", hour: s.hour };
        }
        s.permission = "granted";
        s.enabled = true;
        s.hour = message.hour;
        return { type: "reminder.scheduled", ok: true, permission: "granted", hour: s.hour };
      }
      if (message.type === "reminder.cancel") {
        s.enabled = false;
        return { type: "reminder.cancelled", ok: true };
      }
      if (message.type === "reminder.status") {
        return { type: "reminder.status", enabled: s.enabled, hour: s.hour, permission: s.permission };
      }
      return { ok: false };
    }

    let nextId = 1;
    window.__tenfoldShell = {
      platform: "ios",
      version: "0.2.0 (2)",
      loader: "scheme://app",
      origin: String(location.origin),
      capabilities: config.capabilities,
      post(message) {
        messages.push(message);
        return true;
      },
      send(message) {
        messages.push(message);
        const id = `s${nextId++}`;
        return Promise.resolve({ ...answer(message), replyTo: id });
      },
      request(type, payload) {
        messages.push({ type, payload: payload || null });
        return Promise.resolve({ type: "pong", replyTo: `s${nextId++}` });
      },
      _receive() {},
    };
  }, {
    capabilities: opts.capabilities || ["reminder", "badge", "widget"],
    permission: opts.permission || "notDetermined",
    refuse: !!opts.refuse,
  });
}

/**
 * Take the Badging API away, the way WKWebView does not have it.
 *
 * `delete` would not work: the methods live on Navigator.prototype, so the
 * instance property has to be defined as undefined instead. Borrowed verbatim
 * from quickwins.spec.js, which learnt it the hard way.
 */
async function removeBadgeApi(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, writable: true, value: undefined });
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, writable: true, value: undefined });
  });
}

/**
 * Record every URL the page fetches.
 *
 * A `page.route` interception would only see what reaches the network layer;
 * this sees the call itself, which is the thing being denied - the assertion
 * is that push.js never even asks.
 */
async function spyFetch(page) {
  await page.addInitScript(() => {
    window.__fetches = [];
    const original = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
      window.__fetches.push(String(url));
      return original.apply(this, arguments);
    };
  });
}

const messages = (page) => page.evaluate(() => window.__shellMessages || []);
const sent = async (page, type) => (await messages(page)).filter((m) => m.type === type);
const pushCalls = (page) =>
  page.evaluate(() => (window.__fetches || []).filter((u) => u.indexOf("/api/push") !== -1));

// ------------------------------------------------------------------- the walk

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

/** Walk the first run up to - and not past - the reminder step. */
async function walkToReminder(page) {
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 60000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start empty/ }).click();
  // Sync on: that is where the reminder row lives in settings, and the step
  // after this one is the reminder question.
  await page.getByRole("button", { name: "Keep an encrypted copy on the server" }).click();
  await expect(page.locator(".eyebrow")).toHaveText("Reminder");
}

async function enterApp(page) {
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 60000 });
}

/** The first run, answered "not now" at the reminder, into the outline. */
async function setupVault(page) {
  await walkToReminder(page);
  await page.getByRole("button", { name: "Not now" }).click();
  await enterApp(page);
}

async function openSettings(page) {
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await expect(page.locator(".h-title")).toHaveText("Settings");
}

async function addRoots(page, titles) {
  await page.getByRole("button", { name: /Write the first one|New entry/ }).click();
  for (const title of titles) {
    await page.locator(".composer input").fill(title);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
}

// Anchored regexes, not strings: Playwright's `hasText` matches a plain string
// case-insensitively, so "daily reminder" would also match the "Daily
// reminder" row and the two states of this row would be indistinguishable.
const reminderRow = (page) => page.locator(".setrow-label").filter({ hasText: /^Turn on the daily reminder$/ });
const reminderOnRow = (page) => page.locator(".setrow-label").filter({ hasText: /^Daily reminder$/ });

// -------------------------------------------------------- the settings row

test("the settings reminder schedules through the shell, with the hour and the app's own sentence", async ({
  page,
}) => {
  await stubShell(page);
  await spyFetch(page);
  await freshApp(page);
  await setupVault(page);
  await openSettings(page);

  // The row is offered at all: in a browser tab on this platform it would be,
  // but the point is that the shell answers "supported" without a Service
  // Worker, a PushManager or a Notification object anywhere in the web view.
  await reminderRow(page).click();
  await expect(page.locator(".sheet-title")).toHaveText("Daily reminder");

  await page.getByLabel("Hour").fill("7");
  await page.locator(".sheet-foot").getByRole("button", { name: "Turn on the daily reminder" }).click();
  await expect(page.locator(".toast")).toContainText("07:00");

  const scheduled = await sent(page, "reminder.schedule");
  expect(scheduled).toHaveLength(1);
  // The whole message, asserted literally: this is a cross-repository wire
  // contract, and a field renamed on one side must fail here rather than be
  // quietly ignored by a tolerant reader on the other.
  expect(scheduled[0]).toEqual({ type: "reminder.schedule", hour: 7, title: NOTICE.title, body: NOTICE.body });

  // The reminder is local. Nothing was asked of the server - not the VAPID
  // key, not a subscription, nothing.
  expect(await pushCalls(page)).toEqual([]);
});

test("turning the reminder off cancels it in the shell and asks the server nothing", async ({ page }) => {
  await stubShell(page);
  await spyFetch(page);
  await freshApp(page);
  await setupVault(page);
  await openSettings(page);

  await reminderRow(page).click();
  await page.locator(".sheet-foot").getByRole("button", { name: "Turn on the daily reminder" }).click();
  await expect(page.locator(".toast")).toContainText("08:00");

  // The row now reads as on, and carries the hour.
  await expect(reminderOnRow(page)).toBeVisible();
  await reminderOnRow(page).click();
  await page.locator(".sheet-foot").getByRole("button", { name: "Turn it off" }).click();
  await expect(page.locator(".toast")).toHaveText("Reminder off.");

  expect(await sent(page, "reminder.cancel")).toEqual([{ type: "reminder.cancel" }]);
  expect(await pushCalls(page)).toEqual([]);

  // And the shell is the authority afterwards: the row is back to its off form.
  await expect(reminderRow(page)).toBeVisible();
});

test("refusing the iOS prompt arrives as the app's own blocked message, not as a shell error", async ({ page }) => {
  await stubShell(page, { refuse: true });
  await spyFetch(page);
  await freshApp(page);
  await setupVault(page);
  await openSettings(page);

  await reminderRow(page).click();
  await page.locator(".sheet-foot").getByRole("button", { name: "Turn on the daily reminder" }).click();

  // push.error.denied - the same sentence a browser refusal produces. The
  // mapping is the contract: the shell says "denied", push.js throws the code
  // the settings screen already knows how to translate, and no new vocabulary
  // is invented for a refusal that means exactly what it always meant.
  await expect(page.locator(".toast")).toContainText("blocked");
  expect(await pushCalls(page)).toEqual([]);

  // A refusal is not a scheduled reminder: the row goes to its disabled form.
  await expect(page.locator(".setrow").filter({ hasText: "blocked" })).toHaveCount(1);
});

test("a permission already refused in iOS Settings disables the row before it is pressed", async ({ page }) => {
  // The other half of the mapping: `refresh()` reads the shell's four-word
  // permission and hands the settings screen the three-word one it expects, so
  // the row can be honest without being pressed. This is the case a browser
  // cannot produce - the person turned notifications off in the OS, not here.
  await stubShell(page, { permission: "denied" });
  await freshApp(page);
  await setupVault(page);
  await openSettings(page);

  await expect(page.locator(".setrow").filter({ hasText: "blocked" })).toHaveCount(1);
  await expect(reminderRow(page)).toHaveCount(0);
  expect(await sent(page, "reminder.schedule")).toEqual([]);
});

// ------------------------------------------------------------ the setup step

test("the setup reminder step takes the same shell path as the settings row", async ({ page }) => {
  await stubShell(page);
  await spyFetch(page);
  await freshApp(page);
  await walkToReminder(page);

  // Unchanged UI: the same step, the same hour field, the same primary button.
  await expect(page.locator(".h-title")).toHaveText("One line a day");
  await page.getByLabel("Hour").fill("6");
  await page.getByRole("button", { name: "Turn on the daily reminder" }).click();
  await expect(page.locator(".toast")).toContainText("06:00");

  const scheduled = await sent(page, "reminder.schedule");
  expect(scheduled).toEqual([
    { type: "reminder.schedule", hour: 6, title: NOTICE.title, body: NOTICE.body },
  ]);
  expect(await pushCalls(page)).toEqual([]);

  await enterApp(page);

  // The once-only bookkeeping still happens, exactly as on the web: both
  // answers to this step write it, so the offer sheet never comes back.
  const offered = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return ctx.doc.settings.pushOffered;
  });
  expect(offered).toBe(true);
});

test("the setup step offers the hour in the shell rather than the iOS apology", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await walkToReminder(page);

  // In an iOS browser TAB this step says a tab receives nothing and offers no
  // hour (pushsetup.spec.js covers that). In the shell the same platform can
  // do it, so the question is asked properly - usableHere() has to answer for
  // the context, not for the user-agent string.
  await expect(page.getByLabel("Hour")).toBeVisible();
  await expect(page.getByRole("button", { name: "I will do it in the app" })).toHaveCount(0);
});

// -------------------------------------------------------------- badge, widget

test("the badge count crosses the bridge where the Badging API is missing", async ({ page }) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed"]);
  await page.locator(".row").first().click();
  await page.getByRole("button", { name: /Add the first part|Sub-goal/ }).click();
  for (const title of ["Call the physio", "Book the MRI", "Read the report"]) {
    await page.locator(".composer input").fill(title);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");

  const ids = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const leaves = ctx.doc.nodes.filter((n) => n.parentId !== null);
    const byTitle = (title) => leaves.find((n) => n.title === title).id;
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    ctx.updateNode(byTitle("Call the physio"), { due: noon.getTime() - 3 * 86400000 });
    ctx.updateNode(byTitle("Book the MRI"), { due: noon.getTime() });
    return { physio: byTitle("Call the physio") };
  });

  const lastBadge = async () => {
    const list = await sent(page, "badge.set");
    return list.length ? list[list.length - 1].count : null;
  };
  await expect.poll(lastBadge).toBe(2);

  // The same rule the Today screen uses - one count, not a second opinion.
  const fromModel = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const { dueNowCount } = await import("/web/js/model.js");
    return dueNowCount(ctx.doc.nodes, { now: Date.now() });
  });
  expect(fromModel).toBe(2);

  await page.evaluate(async (id) => {
    const { ctx } = await import("/web/js/app.js");
    ctx.setStatus(id, "done");
  }, ids.physio);
  await expect.poll(lastBadge).toBe(1);

  // Zero, not a separate clear verb: one message, one meaning.
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const leaf = ctx.doc.nodes.find((n) => n.title === "Book the MRI");
    ctx.setStatus(leaf.id, "done");
  });
  await expect.poll(lastBadge).toBe(0);
});

test("the widget learns two counters and nothing else", async ({ page }) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["CANARY-WIDGET-4417"]);

  const states = await sent(page, "widget.state");
  expect(states.length).toBeGreaterThan(0);
  const last = states[states.length - 1];

  // Exactly three keys. This assertion is the privacy contract in executable
  // form: the widget is drawn by a process outside the vault and shown on a
  // home screen anybody can read over a shoulder, so a fourth field must break
  // a test rather than ship.
  expect(Object.keys(last).sort()).toEqual(["due", "questionWaits", "type"]);
  expect(typeof last.due).toBe("number");
  expect(typeof last.questionWaits).toBe("boolean");

  // A goal exists and today's question has not been put away, so it waits.
  expect(last.questionWaits).toBe(true);

  // Nothing of the goal travelled with it.
  expect(JSON.stringify(states)).not.toContain("CANARY-WIDGET-4417");
});

test("putting the question away for today stops the widget claiming it waits", async ({ page }) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed"]);

  const waits = async () => {
    const list = await sent(page, "widget.state");
    return list.length ? list[list.length - 1].questionWaits : null;
  };
  await expect.poll(waits).toBe(true);

  // The Today screen writes `dailyDismissed`; the widget reads the same fact
  // through questions.dailyQuestion rather than keeping a flag of its own.
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const { dayKey } = await import("/web/js/questions.js");
    ctx.setSettings({ dailyDismissed: dayKey(Date.now()) });
  });
  await expect.poll(waits).toBe(false);
});

// -------------------------------------------------------------- the contract

test("a shell that advertises nothing is a browser", async ({ page }) => {
  // The capability list is the whole gate. A bridge with no reminder in it
  // must leave the web path exactly as it was - an older shell build is the
  // realistic case, and it has to degrade rather than post into the void.
  await stubShell(page, { capabilities: [] });
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed"]);

  expect(await messages(page)).toEqual([]);

  const probes = await page.evaluate(async () => {
    const push = await import("/web/js/push.js");
    const badge = await import("/web/js/badge.js");
    return { supported: push.pushSupported(), badge: badge.supported() };
  });
  // Chromium under test has the three push APIs, so `supported` stays true on
  // its own merits; the badge does not, and that is the honest answer with no
  // capability behind it.
  expect(probes.badge).toBe(false);
  expect(probes.supported).toBe(true);
});

test("the capability names are pinned to the ones the shell advertises", async ({ page }) => {
  // Two repositories, two release cycles, no shared import. A rename here
  // would silently switch a feature off rather than break a build, so the
  // strings are asserted literally on both sides - the other half of this
  // assertion is in tenfold-ios/Tests/Unit/BridgeMessageTests.swift.
  const source = readFileSync(join(ROOT, "web/js/shell.js"), "utf8");
  expect(source).toContain('export const CAP_REMINDER = "reminder";');
  expect(source).toContain('export const CAP_BADGE = "badge";');
  expect(source).toContain('export const CAP_WIDGET = "widget";');

  await page.goto("/tests/fixture.html");
  const names = await page.evaluate(async () => {
    const shell = await import("/web/js/shell.js");
    return [shell.CAP_REMINDER, shell.CAP_BADGE, shell.CAP_WIDGET];
  });
  expect(names).toEqual(["reminder", "badge", "widget"]);
});

test("nothing the shell is handed can carry vault content", async ({ page }) => {
  // The messages this repository is allowed to send, and every field each one
  // may carry. `title` and `body` on reminder.schedule are the app's own two
  // catalogue sentences, not the user's - which is why the test below asserts
  // their exact value rather than their type.
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["CANARY-SHELL-7731"]);
  await openSettings(page);
  await reminderRow(page).click();
  await page.locator(".sheet-foot").getByRole("button", { name: "Turn on the daily reminder" }).click();
  await expect(page.locator(".toast")).toContainText("08:00");

  const all = await messages(page);
  const allowed = {
    "reminder.schedule": ["body", "hour", "title", "type"],
    "reminder.cancel": ["type"],
    "reminder.status": ["type"],
    "badge.set": ["count", "type"],
    "widget.state": ["due", "questionWaits", "type"],
  };
  for (const message of all) {
    expect(Object.keys(allowed)).toContain(message.type);
    expect(Object.keys(message).sort()).toEqual(allowed[message.type]);
  }
  for (const message of all.filter((m) => m.type === "reminder.schedule")) {
    expect(message.title).toBe(NOTICE.title);
    expect(message.body).toBe(NOTICE.body);
  }
  expect(JSON.stringify(all)).not.toContain("CANARY-SHELL-7731");
  expect(JSON.stringify(all)).not.toContain(PASS);
});
