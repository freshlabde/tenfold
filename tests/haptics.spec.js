// Touch feedback, and the five moments that earn it.
//
// The native shell has had a complete haptic bridge since wave 2a - a closed
// four-word vocabulary, a mapping onto UIKit, unit tests, a launch-argument
// self-test - and until now not one caller on the web side. This file is the
// other half: `web/js/haptics.js` names the five moments, maps each onto a kind
// the shell accepts, and posts. Nothing else in the app knows the message shape.
//
// What is under test is the WEB half of the contract, as in shell.spec.js: which
// message goes out, with which kind, at which moment - and, just as important,
// that NOTHING goes out where there is no shell or no capability. The native
// half is tested in tenfold-ios/Tests/Unit/HapticsTests.swift. The wire shape
// and the four names are written down once, in tenfold-ios/docs/BRIDGE.md, and
// both suites assert against them literally rather than deriving them: the shell
// REJECTS a kind it does not recognise, so a rename that both sides agreed with
// themselves about would be silence, not a failure.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

// Real WebCrypto: 600000 PBKDF2 rounds per unlock.
test.describe.configure({ mode: "parallel", timeout: 240_000 });

// ------------------------------------------------------------------- the stub

/**
 * A shell that records what it is posted and nothing more.
 *
 * Deliberately thinner than the one in shell.spec.js: a haptic is fire and
 * forget, there is no reply to imitate, and the capability list is left to the
 * caller so the "not advertised" case can be walked with the same code. Only
 * the `haptic` capability is advertised by default, so nothing else in the app
 * posts anything and the recorder holds haptics alone.
 */
async function stubShell(page, capabilities = ["haptic"]) {
  await page.addInitScript((caps) => {
    const messages = [];
    window.__shellMessages = messages;
    window.__tenfoldShell = {
      platform: "ios",
      version: "0.2.0 (2)",
      loader: "scheme://app",
      origin: String(location.origin),
      capabilities: caps,
      post(message) {
        messages.push(message);
        return true;
      },
      send(message) {
        messages.push(message);
        return Promise.resolve({ type: message.type, ok: true });
      },
      request(type, payload) {
        messages.push({ type, payload: payload || null });
        return Promise.resolve({ type: "pong" });
      },
      _receive(message) {
        if (!message || typeof message !== "object") return;
        window.dispatchEvent(new CustomEvent("tenfoldshell", { detail: message }));
      },
    };
  }, capabilities);
}

const haptics = (page) =>
  page.evaluate(() => (window.__shellMessages || []).filter((m) => m.type === "haptic"));

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

async function addRoots(page, titles) {
  await page.getByRole("button", { name: /Write the first one|New entry/ }).click();
  for (const title of titles) {
    await page.locator(".composer input").fill(title);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
}

async function addParts(page, titles) {
  await page.getByRole("button", { name: /Add the first part|New part|New entry/ }).click();
  for (const title of titles) {
    await page.locator(".composer input").fill(title);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
}

/**
 * Where to take hold of a row, once that point really belongs to the row.
 * Borrowed from swipedelete.spec.js, which learnt it the hard way: while a View
 * Transition or a closing sheet is over the page, a raw pointer press hit-tests
 * against the overlay and the row never sees the drag.
 */
async function grab(page, shell, distance) {
  const id = await shell.getAttribute("data-id");
  const box = await shell.locator(".row").boundingBox();
  const y = box.y + box.height / 2;
  const x = distance < 0 ? box.x + box.width - 40 : box.x + 30;
  await page.waitForFunction(
    ([px, py, wanted]) => {
      const hit = document.elementFromPoint(px, py);
      const el = hit && hit.closest(".row-shell");
      return !!el && el.dataset.id === wanted;
    },
    [x, y, id],
  );
  return { x, y };
}

async function swipe(page, shell, distance) {
  const { x, y } = await grab(page, shell, distance);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + distance * 0.45, y, { steps: 6 });
  await page.mouse.move(x + distance, y, { steps: 6 });
  await page.mouse.up();
}

// ------------------------------------------------------------ the vocabulary

test("the vocabulary is the four names the bridge accepts, and nothing else", async ({ page }) => {
  // The literal, as bio.spec.js pins CAP_BIO: the other half of this assertion
  // is in tenfold-ios, and a rename on either side has to fail rather than
  // agree quietly with itself.
  expect(readFileSync(join(ROOT, "web/js/shell.js"), "utf8")).toContain(
    'export const CAP_HAPTIC = "haptic";',
  );

  await page.goto("/web/index.html");
  const pinned = await page.evaluate(async () => {
    const haptics = await import("/web/js/haptics.js");
    const shell = await import("/web/js/shell.js");
    return { kinds: Object.values(haptics.KINDS), capability: shell.CAP_HAPTIC };
  });
  // Literally, in the bridge's own order. An unknown kind is refused on the
  // other side, so a fifth name invented here would simply never be felt.
  expect(pinned.kinds).toEqual(["impact-light", "impact-medium", "success", "warning"]);
  expect(pinned.capability).toBe("haptic");
});

// ------------------------------------------------------------- the five moments

test("committing a decision in the duel is the committed-action tap", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma"]);

  await page.getByRole("button", { name: "Put in order" }).click();
  await expect(page.locator(".duel-card")).toHaveCount(2);
  expect(await haptics(page)).toEqual([]);

  // One decision, and only the pair that is really on screen counts - the
  // sender sits past both of the guards in `commit`.
  const card = page.locator(".duel-card.is-b");
  const node = await card.elementHandle();
  await card.click();
  await page.waitForFunction((el) => !el.isConnected, node);

  expect(await haptics(page)).toEqual([{ type: "haptic", kind: "impact-medium" }]);
});

test("swiping a step to finished is the success", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);
  await page.locator(".row-shell").first().locator(".row").click();
  await addParts(page, ["Call the practice"]);
  expect(await haptics(page)).toEqual([]);

  await swipe(page, page.locator(".list.is-kids .row-shell").first(), 140);
  await expect(page.locator("#toast.is-open")).toContainText("Marked as done");

  expect(await haptics(page)).toEqual([{ type: "haptic", kind: "success" }]);
});

test("swiping a row to delete is the warning, not the same feeling as the finish", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma"]);
  expect(await haptics(page)).toEqual([]);

  await swipe(page, page.locator(".row-shell").first(), -140);
  await expect(page.locator("#toast.is-open")).toContainText("Deleted.");

  const sent = await haptics(page);
  expect(sent).toEqual([{ type: "haptic", kind: "warning" }]);
  // The point of choosing a different kind: a hand must be able to tell a
  // delete from a finish without looking.
  expect(sent[0].kind).not.toBe("success");
});

test("the long press that lifts a row is the light tick, and it comes before the move", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma", "Delta"]);

  const row = page.locator(".row-shell").nth(3).locator(".row");
  const box = await row.boundingBox();
  const x = box.x + 120;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(650); // past the long-press threshold

  // The whole point of this one: the finger has not moved yet, the list has not
  // moved yet, and the answer is already there. That is the only way a press
  // being long enough can be communicated at all.
  expect(await haptics(page)).toEqual([{ type: "haptic", kind: "impact-light" }]);

  await page.mouse.move(x, y - 60, { steps: 10 });
  await page.mouse.move(x, y - 120, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(".row-title")).toHaveText(["Alpha", "Delta", "Beta", "Gamma"]);
  // The reorder itself adds nothing: one lift, one answer.
  expect(await haptics(page)).toHaveLength(1);
});

test("a successful unlock is the success, and a refused one is silence", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  // An empty vault on purpose: nothing due, no question, so the unlock lands on
  // The Ten and the only message in the recorder is the one under test.
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    await ctx.lock();
  });
  await page.waitForSelector(".lock-title");
  expect(await haptics(page)).toEqual([]);

  // A wrong passphrase never opens a document, so it must never be felt.
  await page.locator(".lock input").fill("not the passphrase");
  await page.getByRole("button", { name: /Unlock/ }).click();
  await expect(page.locator(".field-error")).toBeVisible({ timeout: 60000 });
  expect(await haptics(page)).toEqual([]);

  await page.locator(".lock input").fill(PASS);
  await page.getByRole("button", { name: /Unlock/ }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 60000 });

  expect(await haptics(page)).toEqual([{ type: "haptic", kind: "success" }]);
});

// --------------------------------------------------------------- and silence

test("a shell that does not advertise the capability is sent nothing", async ({ page }) => {
  // The state the shell is actually in today: the bridge takes `haptic`, the
  // capability list does not name it yet. The web app must post into no void.
  await stubShell(page, ["reminder", "badge", "widget"]);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);

  await swipe(page, page.locator(".row-shell").first(), -140);
  await expect(page.locator("#toast.is-open")).toContainText("Deleted.");

  expect(await haptics(page)).toEqual([]);
});

test("in a browser it is exactly nothing, and never an error", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);

  // Every one of the five, in a page where `window.__tenfoldShell` does not
  // exist: the module is called, decides there is no shell, and returns.
  await swipe(page, page.locator(".row-shell").first(), -140);
  await expect(page.locator("#toast.is-open")).toContainText("Deleted.");
  const direct = await page.evaluate(async () => {
    const h = await import("/web/js/haptics.js");
    h.decisionCommitted();
    h.stepFinished();
    h.rowDeleted();
    h.rowLifted();
    h.vaultUnlocked();
    return typeof window.__tenfoldShell;
  });

  expect(direct).toBe("undefined");
  expect(errors).toEqual([]);
});
