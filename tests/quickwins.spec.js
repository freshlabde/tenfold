// The two quiet PWA surfaces: the badge on the icon and the share target.
//
// Badge: the number is the one the Today rule ranks first (open leaves that are
// overdue or due today), it follows a change immediately, and a browser without
// the Badging API is a no-op rather than an exception.
//
// Share: the platform POSTs a shared item at the app, the service worker parks
// it in a bucket of its own and redirects to the app root, the next unlock
// offers it, filing it creates the node where it was asked to go, and the
// bucket is empty afterwards - as it is after a dismissal and after a wipe.
// The shared text never appears in a URL: that is what method POST buys.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

test.describe.configure({ mode: "parallel", timeout: 240_000 });

// ------------------------------------------------------------------ helpers

/**
 * A page with the Badging API replaced by a recorder. Installed BEFORE any
 * script of the app runs, so the very first call is captured; desktop Chromium
 * has the real API, and a real badge on the runner's dock helps nobody.
 */
async function stubBadge(page) {
  await page.addInitScript(() => {
    window.__badge = [];
    Object.defineProperty(navigator, "setAppBadge", {
      configurable: true,
      writable: true,
      value: (n) => {
        window.__badge.push(n === undefined ? "flag" : n);
        return Promise.resolve();
      },
    });
    Object.defineProperty(navigator, "clearAppBadge", {
      configurable: true,
      writable: true,
      value: () => {
        window.__badge.push("clear");
        return Promise.resolve();
      },
    });
  });
}

/** The same page with no Badging API at all - most desktops, every tab. */
async function removeBadgeApi(page) {
  await page.addInitScript(() => {
    // The methods live on Navigator.prototype, so `delete navigator.x` would
    // not touch them; an own property of undefined is what a browser without
    // the API looks like to a feature test.
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: undefined });
    window.__badge = [];
  });
}

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
  await page.waitForSelector(".keygrid", { timeout: 60000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start empty/ }).click();
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

/** Add children under the root currently open in the focus screen. */
async function addChildren(page, titles) {
  await page.getByRole("button", { name: /Add the first part|Sub-goal/ }).click();
  for (const title of titles) {
    await page.locator(".composer input").fill(title);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
}

/** The last number the app put on the icon ("clear" counts as zero). */
const lastBadge = (page) =>
  page.evaluate(() => {
    const calls = window.__badge || [];
    return calls.length ? calls[calls.length - 1] : null;
  });

/** Park an item exactly the way sw.js does, without needing a worker. */
async function stashShare(page, item) {
  await page.evaluate(async (value) => {
    const cache = await caches.open("tenfold-share-inbox");
    await cache.put(
      `${location.origin}/tenfold-share-inbox`,
      new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }),
    );
  }, item);
}

const shareBucket = (page) =>
  page.evaluate(async () => {
    if (!(await caches.has("tenfold-share-inbox"))) return null;
    const cache = await caches.open("tenfold-share-inbox");
    const hit = await cache.match(`${location.origin}/tenfold-share-inbox`);
    return hit ? await hit.json() : null;
  });

/**
 * Lock the vault from inside the app. The point is not the lock screen but the
 * flush that comes with it: the autosave is debounced by 600 ms, and a reload
 * fired straight after a mutation can outrun it - which cost this suite two
 * "the node is gone" failures before it was written down.
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

/**
 * Wait for whichever screen the unlock landed on, and end up on the outline.
 *
 * An unlock no longer always opens The Ten: the app opens where the work is,
 * and a vault with something due or an unanswered daily question opens Today
 * (app.js `somethingWaits`, tests/landing.spec.js). Every vault in this file
 * has goals in it, so most of these unlocks land on Today - which is beside the
 * point of a badge test or a share test, so this closes it again and hands back
 * the outline they were written against.
 */
async function afterUnlock(page) {
  await inTheApp(page);
  if ((await page.locator(".h-title").textContent()) === "Today") {
    await page.locator(".head-actions").getByRole("button", { name: "Close" }).click();
  }
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 60000 });
}

/**
 * The same wait without the tidying up. For the share tests, where a sheet
 * comes up over whichever screen the unlock landed on and the Close button
 * underneath it is - correctly - not reachable.
 */
async function inTheApp(page) {
  await expect(page.locator(".h-title")).toHaveText(/^(Today|The Ten)$/, { timeout: 60000 });
}

// --------------------------------------------------------------------- badge

test("the badge counts the open leaves that are overdue or due today", async ({ page }) => {
  await stubBadge(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed"]);
  await page.locator(".row").first().click();
  await addChildren(page, ["Call the physio", "Book the MRI", "Read the report"]);

  // Two of the three are due (one overdue, one today), the third is undated.
  const ids = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const leaves = ctx.doc.nodes.filter((n) => n.parentId !== null);
    const byTitle = (title) => leaves.find((n) => n.title === title).id;
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    ctx.updateNode(byTitle("Call the physio"), { due: today.getTime() - 3 * 86400000 });
    ctx.updateNode(byTitle("Book the MRI"), { due: today.getTime() });
    return { physio: byTitle("Call the physio"), mri: byTitle("Book the MRI") };
  });

  await expect.poll(() => lastBadge(page)).toBe(2);

  // The rule the badge uses is the rule the screen uses - not a second one.
  const fromModel = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const { dueNowCount, todayList } = await import("/web/js/model.js");
    const now = Date.now();
    return {
      count: dueNowCount(ctx.doc.nodes, { now }),
      dueInList: todayList(ctx.doc.nodes, { now }).filter((n) => n.due !== null).length,
    };
  });
  expect(fromModel.count).toBe(2);
  expect(fromModel.dueInList).toBe(2);

  // Finishing one of them takes the icon down with it, immediately.
  await page.evaluate(async (id) => {
    const { ctx } = await import("/web/js/app.js");
    ctx.setStatus(id, "done");
  }, ids.physio);
  await expect.poll(() => lastBadge(page)).toBe(1);

  // And finishing the last due one clears the badge rather than showing a nought.
  await page.evaluate(async (id) => {
    const { ctx } = await import("/web/js/app.js");
    ctx.setStatus(id, "done");
  }, ids.mri);
  await expect.poll(() => lastBadge(page)).toBe("clear");
});

test("the badge is set again on unlock, and a lock does not take it away", async ({ page }) => {
  await stubBadge(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Ship the thing"]);
  await page.locator(".row").first().click();
  await addChildren(page, ["Tag the build"]);
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const leaf = ctx.doc.nodes.find((n) => n.parentId !== null);
    const today = new Date();
    today.setHours(9, 0, 0, 0);
    ctx.updateNode(leaf.id, { due: today.getTime() });
  });
  await expect.poll(() => lastBadge(page)).toBe(1);

  // Locking deliberately leaves the count where it is: it is content-free, and
  // a badge that disappears the moment the app locks is no badge at all.
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    await ctx.lock();
  });
  await page.waitForSelector(".lock-title");
  expect(await lastBadge(page)).toBe(1);

  // A reload wipes the recorder; the unlock has to put the number back.
  await page.reload();
  expect(await lastBadge(page)).toBe(null);
  await unlock(page);
  await afterUnlock(page);
  await expect.poll(() => lastBadge(page)).toBe(1);
});

test("a browser without the Badging API is a no-op, not an error", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Still works"]);
  await page.locator(".row").first().click();
  await addChildren(page, ["A step"]);

  const state = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const { supported, setBadge } = await import("/web/js/badge.js");
    const leaf = ctx.doc.nodes.find((n) => n.parentId !== null);
    ctx.updateNode(leaf.id, { due: Date.now() });
    return { supported: supported(), applied: setBadge(ctx.doc), calls: window.__badge.length };
  });
  expect(state.supported).toBe(false);
  expect(state.applied).toBe(0);
  expect(state.calls).toBe(0);
  expect(errors).toEqual([]);
  // The app itself is untouched by the missing API.
  await expect(page.locator(".row-title")).toHaveText(["A step"]);
});

// --------------------------------------------------------------------- share

test("the worker catches a shared POST, parks it and redirects to the app", async ({ page }) => {
  await page.goto("/web/index.html");
  // The app does not register the worker under a test runner (a cached shell
  // would hide source changes), so this test registers it itself - and takes
  // it away again at the end, so nothing leaks into the next one.
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("./sw.js");
    // The worker calls clients.claim() when it activates, so this page ends up
    // controlled without a reload.
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  const secret = "CANARY-SHARE-31337 a thought worth keeping";
  const result = await page.evaluate(async (text) => {
    const form = new FormData();
    form.append("title", "A shared heading");
    form.append("text", text);
    form.append("url", "https://example.invalid/read-this");
    const res = await fetch("./share", { method: "POST", body: form });
    return {
      redirected: res.redirected,
      url: res.url,
      ok: res.ok,
      status: res.status,
      type: res.type,
      location: res.headers.get("location"),
      search: location.search,
    };
  }, secret);

  // The POST never became a URL: nothing of the text is in the address bar,
  // and what the browser is sent to is the app root.
  // Chromium follows a redirect a worker returns but does not raise the
  // `redirected` flag for it, so the proof is where the answer came FROM: the
  // request went to ./share and the response is the app root, served whole.
  expect(result.url.endsWith("/web/")).toBe(true);
  expect(result.status).toBe(200);
  expect(result.ok).toBe(true);
  expect(result.url).not.toContain("CANARY");
  expect(result.search).toBe("");

  const parked = await shareBucket(page);
  expect(parked.title).toBe("A shared heading");
  expect(parked.text).toBe(secret);
  expect(parked.url).toBe("https://example.invalid/read-this");
  expect(typeof parked.ts).toBe("number");

  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
  });
});

test("after unlock a shared item is offered and filed where it is sent", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed", "Learn to sail"]);

  const secret = "CANARY-SHARE-77 the physio recommended this one";
  await stashShare(page, {
    title: "A better exercise",
    text: secret,
    url: "https://example.invalid/exercise",
    ts: Date.now(),
  });

  // A reload is the honest way in: the app boots locked, exactly as it would
  // after the platform reopened it behind a share.
  await lockNow(page);
  await page.reload();
  await unlock(page);
  await inTheApp(page);

  const sheet = page.locator(".sheet");
  await expect(sheet).toBeVisible({ timeout: 15000 });
  await expect(sheet.locator(".sheet-title")).toHaveText("Shared with tenfold");
  await expect(sheet).toContainText("A better exercise");
  await expect(sheet).toContainText(secret);
  await expect(sheet).toContainText("https://example.invalid/exercise");

  // Where it goes is a choice, and the goals are the choices.
  await expect(sheet.getByRole("button", { name: "Add to the ten" })).toBeVisible();
  await sheet.getByRole("button", { name: "Get the knee fixed" }).click();

  const filed = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const parent = ctx.doc.nodes.find((n) => n.title === "Get the knee fixed");
    const kids = ctx.childrenOf(parent.id);
    return kids.map((n) => ({ title: n.title, note: n.note, origin: n.origin, parent: parent.id }));
  });
  expect(filed).toHaveLength(1);
  expect(filed[0].title).toBe("A better exercise");
  expect(filed[0].note).toContain(secret);
  expect(filed[0].note).toContain("https://example.invalid/exercise");
  // Typed by a person, in the end: nothing here came out of a model.
  expect(filed[0].origin).toBe("manual");

  // The parking space is empty, and the URL never carried a word of it.
  await expect.poll(() => shareBucket(page)).toBe(null);
  expect(await page.evaluate(() => location.search)).toBe("");
  expect(await page.evaluate(() => location.href)).not.toContain("CANARY");

  // And it is not offered a second time.
  await page.reload();
  await unlock(page);
  await inTheApp(page);
  await expect(page.locator(".sheet")).toHaveCount(0);
});

test("a shared item that is discarded leaves nothing behind", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Only a goal"]);
  await stashShare(page, { title: "", text: "Nothing I want", url: "", ts: Date.now() });

  await lockNow(page);
  await page.reload();
  await unlock(page);
  await inTheApp(page);
  const sheet = page.locator(".sheet");
  await expect(sheet).toBeVisible({ timeout: 15000 });
  // No title came with it, so the first line of the text became one.
  await expect(sheet).toContainText("Nothing I want");

  await sheet.getByRole("button", { name: "Discard" }).click();
  await expect.poll(() => shareBucket(page)).toBe(null);

  const count = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return ctx.doc.nodes.filter((n) => !n.deletedAt).length;
  });
  expect(count).toBe(1);
});

test("wiping the vault empties the share bucket too", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await stashShare(page, { title: "Left over", text: "from before", url: "", ts: Date.now() });
  expect(await shareBucket(page)).not.toBe(null);

  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    await ctx.wipeLocalVault();
  });
  await expect.poll(() => shareBucket(page)).toBe(null);
});

test("shareToNode keeps everything that arrived, whatever arrived", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const out = await page.evaluate(async () => {
    const { shareToNode } = await import("/web/js/shareinbox.js");
    return {
      full: shareToNode({ title: "Head", text: "Body line\nsecond", url: "https://a.invalid/x" }),
      noTitle: shareToNode({ title: "", text: "First line\nrest of it", url: "" }),
      onlyUrl: shareToNode({ title: "", text: "", url: "https://a.invalid/y" }),
      urlIsTitle: shareToNode({ title: "", text: "", url: "https://a.invalid/z" }),
      long: shareToNode({ title: "x".repeat(500), text: "", url: "" }),
    };
  });
  expect(out.full.title).toBe("Head");
  expect(out.full.note).toContain("Body line\nsecond");
  expect(out.full.note).toContain("https://a.invalid/x");
  expect(out.noTitle.title).toBe("First line");
  expect(out.noTitle.note).toBe("rest of it");
  expect(out.onlyUrl.title).toBe("https://a.invalid/y");
  // A link that is already the heading is not repeated underneath it.
  expect(out.urlIsTitle.note).toBe("");
  // A heading that had to be cut keeps its full text in the note.
  expect(out.long.title.length).toBeLessThanOrEqual(200);
  expect(out.long.note.length).toBe(500);
});

test("a share POST with no worker in control is discarded by the server", async ({ request }) => {
  const canary = "CANARY-SERVER-9001-never-store-me";
  const res = await request.post("/share", {
    maxRedirects: 0,
    multipart: { title: "heading", text: canary, url: "https://example.invalid/z" },
  });
  expect(res.status()).toBe(303);
  expect(res.headers().location).toBe("/");
  expect(await res.text()).not.toContain(canary);
});

// ---------------------------------------------------------------- source rules

/** Strip comments so prose about a rule cannot satisfy or trip the rule. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("worker and app agree on the share bucket, and the manifest posts", async () => {
  const sw = stripComments(await readFile(join(ROOT, "web/sw.js"), "utf8"));
  const inbox = stripComments(await readFile(join(ROOT, "web/js/shareinbox.js"), "utf8"));
  const manifest = JSON.parse(await readFile(join(ROOT, "web/manifest.webmanifest"), "utf8"));

  // The one string the two halves cannot import from each other.
  expect(sw).toContain('const SHARE_CACHE = "tenfold-share-inbox"');
  expect(inbox).toContain('export const SHARE_CACHE = "tenfold-share-inbox"');
  // The bucket survives an activation, or an update between share and unlock
  // would eat the item.
  expect(sw).toMatch(/k !== SHARE_CACHE/);

  // POST is the whole privacy argument of this feature: with GET the shared
  // text would be query parameters, and the address bar and the history would
  // hold it. multipart, because that is what the share target spec defines for
  // POST, and the worker reads it with formData().
  expect(manifest.share_target.method).toBe("POST");
  expect(manifest.share_target.enctype).toBe("multipart/form-data");
  expect(manifest.share_target.action).toBe("./share");
  expect(manifest.share_target.params).toEqual({ title: "title", text: "text", url: "url" });

  // The worker badges in flag mode: no argument, because it cannot count what
  // it cannot decrypt.
  expect(sw).toMatch(/nav\.setAppBadge\(\)/);
  // And it still never reads a push payload.
  expect(sw).not.toMatch(/event\.data/);
});
