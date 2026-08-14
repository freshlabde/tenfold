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

    // Built exactly the way ReminderStatus.payload() does in
    // tenfold-ios/Sources/Bridge/Reminders.swift: the reply ECHOES the
    // request's type, always carries `enabled` and `permission`, carries
    // `hour` only when something is actually pending (a zero there would read
    // as midnight), and carries `ok` only for an outcome.
    function statusPayload(type, ok) {
      const s = window.__shellState;
      const reply = { type: type, enabled: s.enabled, permission: s.permission };
      if (s.enabled) reply.hour = s.hour;
      if (ok !== undefined) reply.ok = ok;
      return reply;
    }

    function answer(message) {
      const s = window.__shellState;
      if (message.type === "reminder.schedule") {
        // The real shell asks the operating system for authorization inside
        // this call. `refuse` is the person tapping "Don't Allow".
        if (config.refuse) s.permission = "denied";
        if (s.permission === "denied") return statusPayload(message.type, false);
        s.permission = "granted";
        s.enabled = true;
        s.hour = message.hour;
        return statusPayload(message.type, true);
      }
      if (message.type === "reminder.cancel") {
        s.enabled = false;
        return statusPayload(message.type, true);
      }
      if (message.type === "reminder.status") {
        return statusPayload(message.type);
      }
      return { type: message.type, ok: false };
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
      // The real one, not a no-op: this is how the native side delivers a
      // message the page did not ask for, and wave 2c has one - share.incoming.
      // Copied from the injected source in
      // tenfold-ios/Sources/Bridge/ShellBridge.swift: a message carrying
      // `replyTo` resolves a pending promise, everything else is dispatched as
      // a `tenfoldshell` CustomEvent on window.
      _receive(message) {
        if (!message || typeof message !== "object") return;
        window.dispatchEvent(new CustomEvent("tenfoldshell", { detail: message }));
      },
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

  // Exactly three keys with the title opt-in off, which is the default and is
  // what this test runs with. The assertion is the privacy contract in
  // executable form: the widget is drawn by a process outside the vault and
  // shown on a home screen anybody can read over a shoulder, so a fourth field
  // that nobody asked for must break a test rather than ship. The one field
  // that MAY appear - topTitle, behind the settings switch - has its own tests
  // below and its own shape in the allow-list at the end of this file.
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
  // One entry per message type, and every SHAPE that type may take. Only
  // widget.state has two, and the second one exists solely because somebody
  // switched the title on: with the opt-in off - as in this test - the three
  // key shape is the only one that may appear.
  const allowed = {
    "reminder.schedule": [["body", "hour", "title", "type"]],
    "reminder.cancel": [["type"]],
    "reminder.status": [["type"]],
    "badge.set": [["count", "type"]],
    // The page telling the shell it may let go of its own copy of a share.
    // No fields: the shell knows what it sent.
    "share.stored": [["type"]],
    "widget.state": [
      ["due", "questionWaits", "type"],
      ["due", "questionWaits", "topTitle", "type"],
    ],
  };
  for (const message of all) {
    expect(Object.keys(allowed)).toContain(message.type);
    expect(allowed[message.type]).toContainEqual(Object.keys(message).sort());
  }
  // And in this run, with the opt-in untouched, no title crossed at all.
  for (const message of all.filter((m) => m.type === "widget.state")) {
    expect(message.topTitle).toBe(undefined);
  }
  for (const message of all.filter((m) => m.type === "reminder.schedule")) {
    expect(message.title).toBe(NOTICE.title);
    expect(message.body).toBe(NOTICE.body);
  }
  expect(JSON.stringify(all)).not.toContain("CANARY-SHELL-7731");
  expect(JSON.stringify(all)).not.toContain(PASS);
});

// ------------------------------------------------- the share sheet's hand-off
//
// iOS has no share target, so the native shell carries one: a Share Extension
// writes an item into an App Group, and the shell hands it to the page as
// `share.incoming`. What is under test here is that the web app files it
// through the EXISTING share inbox - the same Cache bucket, the same
// post-unlock offer sheet, the same wipe rules that the Android share target
// has used since it shipped. The native half (the extension, the App Group
// slot, the hand-over) is tested in tenfold-ios/Tests/Unit.

/** Lock from inside the app, flushing the debounced save on the way out. */
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
  // Either of the two, on purpose: an unlock opens where the work is, so a
  // vault with something due or an unanswered daily question comes back on
  // Today rather than The Ten (app.js `somethingWaits`, tests/landing.spec.js).
  // Nothing in this file is about which of the two won - and the share offer
  // below rides on top of whichever it was - so this waits for the app to be
  // open and no more. `toOutline` is for the tests that then read the list.
  await expect(page.locator(".h-title")).toHaveText(/^(Today|The Ten)$/, { timeout: 60000 });
}

/** From wherever the unlock landed to the outline, by Today's own close button. */
async function toOutline(page) {
  if ((await page.locator(".h-title").textContent()) === "Today") {
    await page.locator(".head-actions").getByRole("button", { name: "Close" }).click();
  }
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 60000 });
}

/** What the shell does when its App Group slot had something in it. */
async function pushShare(page, item) {
  await page.evaluate((value) => {
    window.__tenfoldShell._receive({ type: "share.incoming", ...value });
  }, item);
}

const shareBucket = (page) =>
  page.evaluate(async () => {
    if (!(await caches.has("tenfold-share-inbox"))) return null;
    const cache = await caches.open("tenfold-share-inbox");
    const hit = await cache.match(`${location.origin}/tenfold-share-inbox`);
    return hit ? await hit.json() : null;
  });

test("a share handed over by the shell is parked, and offered at the next unlock", async ({ page }) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed"]);

  // The handshake the shell waits for before it gives up its own copy. Without
  // it a cold launch would deliver into a page whose listener does not exist
  // yet and the item would be lost - see tenfold-ios/docs/BRIDGE.md.
  expect(await page.evaluate(() => window.__tenfoldShareReady)).toBe(true);

  // Locked, which is the ordinary case: somebody shares something into tenfold
  // while it is in the background, and the app is opened later.
  await lockNow(page);

  const secret = "CANARY-SHARE-IOS-9214 the brace the physio recommended";
  await pushShare(page, {
    title: "A brace worth trying",
    text: secret,
    url: "https://a.invalid/brace",
    ts: Date.now(),
  });

  // Parked, not shown: there is no open document to file anything into, and a
  // sheet over the lock screen would be a leak rather than a feature.
  await expect.poll(async () => (await shareBucket(page)) !== null).toBe(true);
  expect(await page.locator(".sheet").count()).toBe(0);

  await unlock(page);

  // The existing sheet, unchanged - the same one an Android share opens.
  const sheet = page.locator(".sheet");
  await expect(sheet.locator(".sheet-title")).toHaveText("Shared with tenfold");
  await expect(sheet).toContainText("A brace worth trying");
  await expect(sheet).toContainText(secret);

  // Filed under the goal, through the ordinary mutate path, and the parking
  // space is emptied afterwards.
  await sheet.getByRole("button", { name: "Get the knee fixed" }).click();
  await expect.poll(() => shareBucket(page)).toBe(null);
  const filed = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return ctx.doc.nodes.map((n) => ({ title: n.title, note: n.note || "", origin: n.origin }));
  });
  const node = filed.find((n) => n.title === "A brace worth trying");
  expect(node).toBeTruthy();
  expect(node.note).toContain(secret);
  expect(node.origin).toBe("manual");

  // The shell is told it may let go of its own copy - and told nothing else:
  // the acknowledgement carries no fields, so the shared text cannot ride back
  // out on it.
  const acks = await sent(page, "share.stored");
  expect(acks.length).toBeGreaterThan(0);
  expect(Object.keys(acks[0])).toEqual(["type"]);

  // And nothing of the share went back out over the bridge.
  expect(JSON.stringify(await messages(page))).not.toContain(secret);
});

test("a share that carries nothing readable is dropped rather than parked", async ({ page }) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);

  await pushShare(page, { title: "   ", text: "", url: "", ts: Date.now() });
  // Nothing parked and no sheet: an offer showing nothing is a worse answer
  // than no offer. The same rule sw.js follows for an empty POST.
  await page.waitForTimeout(300);
  expect(await shareBucket(page)).toBe(null);
  expect(await page.locator(".sheet").count()).toBe(0);
});

test("the bucket key is an https URL even where the origin is not", async ({ page }) => {
  // Measured, not preferred: cache.put() rejects with a TypeError unless the
  // request URL's scheme is http or https, and inside the native shell the
  // origin is tenfold-app://app. Without the fallback the item could not be
  // parked at all on iOS - see tenfold-ios/docs/DECISIONS.md D12.
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const { shareKey, shareKeyFor } = await import("/web/js/shareinbox.js");
    return {
      here: shareKey(),
      web: shareKeyFor("https://tenfold.kairatools.com"),
      shell: shareKeyFor("tenfold-app://app"),
      opaque: shareKeyFor(""),
    };
  });
  expect(r.here).toBe("http://127.0.0.1:7711/tenfold-share-inbox");
  expect(r.web).toBe("https://tenfold.kairatools.com/tenfold-share-inbox");
  expect(r.shell).toBe("https://shell.tenfold.invalid/tenfold-share-inbox");
  expect(r.opaque).toBe("https://shell.tenfold.invalid/tenfold-share-inbox");
  // .invalid is reserved precisely so it can never resolve to anything real,
  // and nothing ever fetches this key - it is a Cache key, not an address.
  expect(r.shell).toContain(".invalid/");
});

test("a share the app could not park is not acknowledged, so the shell keeps it", async ({ page }) => {
  // The other half of the same measurement. If the Cache write throws, the
  // page must stay silent: the shell empties its App Group slot on
  // share.stored and on nothing else, so an acknowledgement here would be the
  // difference between "offered again next launch" and "gone".
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);

  await page.evaluate(() => {
    // Break the bucket the way a non-http(s) key does.
    caches.open = () => Promise.reject(new TypeError("no cache storage here"));
  });
  await pushShare(page, { title: "Will not park", text: "", url: "", ts: Date.now() });
  await page.waitForTimeout(500);

  expect(await sent(page, "share.stored")).toEqual([]);
});

test("the share hand-off message name is pinned to the one the shell sends", async ({ page }) => {
  // The other half of this assertion is in
  // tenfold-ios/Tests/Unit/ShareHandoverTests.swift. Two repositories, no
  // shared import: a rename would stop shares arriving without breaking a
  // build on either side.
  const source = readFileSync(join(ROOT, "web/js/shareinbox.js"), "utf8");
  expect(source).toContain('export const SHELL_MESSAGE = "share.incoming";');
  expect(source).toContain('export const SHELL_STORED_MESSAGE = "share.stored";');

  await page.goto("/tests/fixture.html");
  const names = await page.evaluate(async () => {
    const inbox = await import("/web/js/shareinbox.js");
    return [inbox.SHELL_MESSAGE, inbox.SHELL_STORED_MESSAGE];
  });
  expect(names).toEqual(["share.incoming", "share.stored"]);
});

// ---------------------------------------------------- the widget's opt-in title

const titleSwitch = (page) => page.getByRole("group", { name: "Show the top goal's name" });

const lastWidgetState = async (page) => {
  const list = await sent(page, "widget.state");
  return list.length ? list[list.length - 1] : null;
};

test("the title switch appears only where the shell offers a widget", async ({ page }) => {
  // A capability the shell does not advertise is a feature the web app must
  // not offer. Not a disabled row - an offer the app cannot keep is worse than
  // no offer at all.
  await stubShell(page, { capabilities: ["reminder", "badge"] });
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await openSettings(page);
  await expect(titleSwitch(page)).toHaveCount(0);
  await expect(page.locator(".group-key").filter({ hasText: /^Home screen widget$/ })).toHaveCount(0);
});

test("switching the title on sends it, switching it off takes it away again", async ({ page }) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed", "Learn to sail"]);

  // Off by default: this is the one setting in the app that moves text out of
  // the encryption, and it starts off.
  expect((await lastWidgetState(page)).topTitle).toBe(undefined);

  await openSettings(page);
  await expect(titleSwitch(page)).toHaveCount(1);
  await titleSwitch(page).getByRole("button", { name: "Show" }).click();

  // The rank-1 goal, and only its title. The switch changes the home screen in
  // the same tick, through the ordinary save funnel.
  await expect.poll(async () => (await lastWidgetState(page)).topTitle).toBe("Get the knee fixed");
  const withTitle = await lastWidgetState(page);
  expect(Object.keys(withTitle).sort()).toEqual(["due", "questionWaits", "topTitle", "type"]);

  // The second goal never travels. One title, never a list.
  expect(JSON.stringify(await messages(page))).not.toContain("Learn to sail");

  await titleSwitch(page).getByRole("button", { name: "Hide" }).click();
  // The absent field IS the clear: the shell stores one value, so a message
  // without the key leaves no title in the App Group.
  await expect.poll(async () => (await lastWidgetState(page)).topTitle).toBe(undefined);
  await expect
    .poll(async () => Object.keys(await lastWidgetState(page)).sort())
    .toEqual(["due", "questionWaits", "type"]);
});

test("a lock leaves the title where it is, exactly like the badge count", async ({ page }) => {
  // The honest behaviour, and the one most likely to be questioned: somebody
  // who put their top goal on the home screen asked for a surface that is
  // there while the app is not. tenfold locks after fifteen minutes and on
  // every reload, so a title that vanished with the lock would be blank almost
  // all of the time - which is not the thing they switched on. Turning the
  // switch off clears it; a lock does not.
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed"]);
  await openSettings(page);
  await titleSwitch(page).getByRole("button", { name: "Show" }).click();
  await expect.poll(async () => (await lastWidgetState(page)).topTitle).toBe("Get the knee fixed");

  await lockNow(page);
  expect((await lastWidgetState(page)).topTitle).toBe("Get the knee fixed");
});

test("wiping the vault takes the widget back to nothing", async ({ page }) => {
  // After a wipe there is no next save to correct the home screen with, so the
  // wipe path says so explicitly. Without this a device whose vault no longer
  // exists would keep a goal on its home screen.
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed"]);
  await openSettings(page);
  await titleSwitch(page).getByRole("button", { name: "Show" }).click();
  await expect.poll(async () => (await lastWidgetState(page)).topTitle).toBe("Get the knee fixed");

  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    await ctx.wipeLocalVault();
  });

  await expect.poll(async () => (await lastWidgetState(page))).toEqual({
    type: "widget.state",
    due: 0,
    questionWaits: false,
  });
});

test("the title is the rank-1 goal, trimmed and capped", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const badge = await import("/web/js/badge.js");
    const doc = (nodes, on) => ({ nodes, settings: { widgetTitle: on } });
    const two = [
      { id: "b", parentId: null, rank: 1, title: "Second" },
      { id: "a", parentId: null, rank: 0, title: "  First  " },
    ];
    return {
      max: badge.WIDGET_TITLE_MAX,
      off: badge.topTitle(doc(two, false)),
      rankOne: badge.topTitle(doc(two, true)),
      empty: badge.topTitle(doc([], true)),
      untitled: badge.topTitle(doc([{ id: "a", parentId: null, rank: 0, title: "" }], true)),
      long: badge.topTitle(doc([{ id: "a", parentId: null, rank: 0, title: "x".repeat(500) }], true)),
      noDoc: badge.topTitle(null),
    };
  });
  expect(r.max).toBe(80);
  // The switch is the gate, and it is read from the document rather than from
  // anywhere the shell could reach.
  expect(r.off).toBe("");
  // Rank order, not array order: the same ordered list the outline draws.
  expect(r.rankOne).toBe("First");
  expect(r.empty).toBe("");
  expect(r.untitled).toBe("");
  expect(r.noDoc).toBe("");
  // Capped before it ever crosses the bridge: the least exposed title is the
  // shortest one that still means something.
  expect(r.long.length).toBe(80);
  expect(r.long.endsWith("…")).toBe(true);
});

test("the warning about the title exists in all three catalogues", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const { LOCALES } = await import("/web/js/i18n.js");
    const out = {};
    for (const locale of LOCALES) {
      const cat = (await import(`/web/js/locales/${locale}.js`))[locale];
      out[locale] = {
        group: cat["settings.group.widget"],
        label: cat["settings.widgetTitle"],
        on: cat["settings.widgetTitle.on"],
        off: cat["settings.widgetTitle.off"],
        desc: cat["settings.widgetTitleDesc"],
        warn: cat["settings.widgetTitleWarn"],
      };
    }
    return out;
  });
  for (const locale of ["en", "de", "es"]) {
    for (const [key, value] of Object.entries(r[locale])) {
      expect(typeof value, `${locale}.${key}`).toBe("string");
      expect(value.length, `${locale}.${key}`).toBeGreaterThan(0);
    }
    // The warning has to be a warning, not a feature description: it names
    // where the text ends up, and it is long enough to have said it.
    expect(r[locale].warn.length, `${locale} warning`).toBeGreaterThan(80);
  }
  expect(r.en.warn).toContain("outside the encryption");
  expect(r.de.warn).toContain("außerhalb der Verschlüsselung");
  expect(r.es.warn).toContain("fuera del cifrado");
});

// ------------------------------------------------------ the shell's own lock
//
// The web app locks itself after fifteen minutes without activity. The shell
// keeps a second, much shorter deadline that the page could not keep for
// itself: how long the app has been away from the foreground, measured
// natively, because a backgrounded web view is not a clock - its timers are
// throttled, it may be suspended outright, and the wall time it can read after
// being woken says nothing about what the operating system did in between.
//
// When that deadline passes the shell pushes `vault.lock` at the page, the
// same way it pushes `share.incoming`, and holds a privacy veil over the web
// view until the JavaScript that took the message returns. So the assertion
// that matters most here is not that the app ends up locked - it is that it is
// ALREADY locked in the same tick the message was delivered in. Anything that
// waited for a frame or a promise would hand the veil back over the list.

/** Exactly what the bridge dispatches when its away-deadline has passed. */
const VAULT_LOCK = { type: "vault.lock", reason: "background", awaySeconds: 87 };

/** What ctx says about itself, read from the page. */
const appFacts = (page) =>
  page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return { view: ctx.view.name, doc: ctx.doc === null ? null : ctx.doc.nodes.length, savedAt: ctx.savedAt };
  });

test("the shell's deadline closes the vault before the message it arrived on returns", async ({
  page,
}) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed"]);

  const now = await page.evaluate(async (message) => {
    const { ctx } = await import("/web/js/app.js");
    const { SHELL_MESSAGE } = await import("/web/js/vaultlock.js");
    window.__tenfoldShell._receive(message);
    // Read back in the SAME tick, with nothing awaited in between. This is the
    // whole test: the veil comes down when this function returns.
    return {
      name: SHELL_MESSAGE,
      lockScreen: !!document.querySelector(".lock-title"),
      goalStillOnScreen: document.body.innerText.includes("Get the knee fixed"),
      docGone: ctx.doc === null,
      view: ctx.view.name,
    };
  }, VAULT_LOCK);

  // The name is pinned literally: it is a cross-repository wire contract, and
  // a rename on either side would stop the vault locking rather than break a
  // build.
  expect(now.name).toBe("vault.lock");
  expect(now.lockScreen).toBe(true);
  expect(now.goalStillOnScreen).toBe(false);
  expect(now.docGone).toBe(true);
  expect(now.view).toBe("lock");

  // A second one, and a malformed one, on a screen with nothing left to close:
  // silence, and above all no exception travelling back across the bridge.
  await page.evaluate((message) => {
    window.__tenfoldShell._receive(message);
    window.__tenfoldShell._receive({ type: "vault.lock" });
  }, VAULT_LOCK);
  await expect(page.locator(".lock-title")).toBeVisible();

  // And the vault is intact: the passphrase opens it, with the goal in it.
  await unlock(page);
  await toOutline(page);
  await expect(page.locator(".row-title").first()).toHaveText("Get the knee fixed");
});

test("an edit still inside the autosave window survives the background lock", async ({ page }) => {
  // The lock flushes the debounced save before it drops the master key, and it
  // has to keep doing that now that the drop happens synchronously: the seal
  // is started first and is holding the key and the document by the time the
  // lines below it take both away. Without that ordering a lock arriving 200ms
  // after a rename would silently throw the rename away.
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed"]);

  const renamed = "CANARY-INFLIGHT-4471 the knee, seen to";
  const before = (await appFacts(page)).savedAt;
  await page.evaluate(
    async ({ title, message }) => {
      const { ctx } = await import("/web/js/app.js");
      const node = ctx.doc.nodes.find((n) => n.title === "Get the knee fixed");
      ctx.updateNode(node.id, { title });
      // Nothing awaited between the edit and the message: the 600ms autosave
      // has certainly not fired, so this is an edit that exists only in memory.
      window.__tenfoldShell._receive(message);
    },
    { title: renamed, message: VAULT_LOCK },
  );

  await expect(page.locator(".lock-title")).toBeVisible();
  // The seal has to have reached IndexedDB before the page is thrown away,
  // and it says so itself rather than being waited out.
  await expect.poll(async () => (await appFacts(page)).savedAt).toBeGreaterThan(before);

  await page.reload();
  await unlock(page);
  const titles = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return ctx.doc.nodes.map((n) => n.title);
  });
  expect(titles).toContain(renamed);
});

test("a lock arriving when there is nothing to close changes nothing", async ({ page }) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);

  // Before there is a vault at all. Nothing is open, nothing can be closed,
  // and the first-run screen must not be swapped for a lock screen asking for
  // a passphrase that does not exist yet.
  await page.evaluate((message) => window.__tenfoldShell._receive(message), VAULT_LOCK);
  await expect(page.getByRole("button", { name: "Set up the vault" })).toBeVisible();

  // Mid first run, on the recovery key. A document IS open here - the vault
  // was created two steps ago - so "is something open" is not the same
  // question as "is the app in use". This is the screen that must never be
  // taken away: it is the only time the recovery key is ever shown.
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 60000 });

  await page.evaluate((message) => window.__tenfoldShell._receive(message), VAULT_LOCK);
  await expect(page.locator(".keygrid")).toBeVisible();
  const facts = await appFacts(page);
  expect(facts.view).toBe("setup");
  expect(facts.doc).not.toBe(null);

  // And the run still finishes from where it was standing.
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: /Start empty/ })).toBeVisible();
});
