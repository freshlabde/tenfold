// Face ID inside the native shell: the web half of the fourth envelope.
//
// There is no WebAuthn in a WKWebView, so on that platform the browser's
// biometric path does not exist and somebody types their passphrase every time.
// The shell answers that with a key of its own: 32 bytes in the Keychain behind
// the current biometric enrolment, handed to this page, which wraps the master
// key with them exactly as it wraps it with a PRF output today.
//
// The shell here is a stub. It answers the way the real one does - the same
// five refusal codes, the same base64url encoding, the same "always a new key"
// rule for create - and records every message so a test can read what crossed.
// What is under test is the WEB half: which message goes out with which fields,
// what lands in the vault file, and what each of the five refusals does to the
// screen. The native half (Keychain, LocalAuthentication, the ordering of
// authenticate-then-read) is tested in tenfold-ios/Tests/Unit/BioKeyTests.
//
// The wire shape is written down once, in tenfold-ios/docs/BRIDGE.md, and both
// suites assert against it literally rather than deriving it: two repositories
// on two release cycles cannot import from each other, so a rename has to fail
// loudly here instead of quietly agreeing with itself over there.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Real WebCrypto: 600000 PBKDF2 rounds per unlock.
test.describe.configure({ mode: "parallel", timeout: 240_000 });

// ------------------------------------------------------------------- the stub

/**
 * Install a stand-in for the native shell, before the app's modules run.
 *
 * `window.__bio` is the Keychain: one key per vault id, plus the two knobs a
 * test needs - what the hardware reports, and what the next unwrap should
 * refuse with. Everything it answers is built the way
 * tenfold-ios/Sources/Bridge/BioKey.swift builds it.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{capabilities?: string[], available?: boolean, enrolled?: boolean}} [opts]
 */
async function stubShell(page, opts = {}) {
  await page.addInitScript((config) => {
    const messages = [];
    window.__shellMessages = messages;
    window.__bio = {
      available: config.available,
      enrolled: config.enrolled,
      biometryType: config.available ? "faceID" : "none",
      /** vaultId -> base64url key. The Keychain, one item per vault. */
      keys: {},
      /** Forces the next unwrap to refuse with this code. */
      unwrapCode: null,
      created: 0,
      deleted: 0,
      wiped: [],
    };

    function b64u(bytes) {
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    function answer(m) {
      const s = window.__bio;
      if (m.type === "bio.available") {
        // A reading, not an outcome: no `ok` on this one.
        return {
          type: m.type,
          available: s.available,
          enrolled: s.enrolled,
          biometryType: s.biometryType,
        };
      }
      if (m.type === "bio.createKey") {
        if (!s.available || !s.enrolled) return { type: m.type, ok: false, code: "failed" };
        // Always a new key, always replacing - the honest reading of "make me
        // a key", and what BioKey.swift does.
        const key = b64u(crypto.getRandomValues(new Uint8Array(32)));
        s.keys[m.vaultId] = key;
        s.created += 1;
        return { type: m.type, ok: true, key };
      }
      if (m.type === "bio.unwrapKey") {
        if (s.unwrapCode) {
          const code = s.unwrapCode;
          if (code === "invalidated" || code === "missing") delete s.keys[m.vaultId];
          return { type: m.type, ok: false, code };
        }
        const key = s.keys[m.vaultId];
        if (!key) return { type: m.type, ok: false, code: "missing" };
        return { type: m.type, ok: true, key };
      }
      if (m.type === "bio.deleteKey") {
        delete s.keys[m.vaultId];
        s.deleted += 1;
        return { type: m.type, ok: true };
      }
      if (m.type === "vault.wiped") {
        delete s.keys[m.vaultId];
        s.wiped.push(m.vaultId);
        return { type: m.type, ok: true };
      }
      // Badge, widget and the reminder say nothing back that this suite reads.
      // The reminder's two status fields are carried anyway, so push.js meets
      // the shape it expects rather than a truthy stub it has to guess at.
      return { type: m.type, ok: true, enabled: false, permission: "notDetermined" };
    }

    let nextId = 1;
    window.__tenfoldShell = {
      platform: "ios",
      version: "0.3.0 (3)",
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
      _receive(message) {
        if (!message || typeof message !== "object") return;
        window.dispatchEvent(new CustomEvent("tenfoldshell", { detail: message }));
      },
    };
  }, {
    capabilities: opts.capabilities || ["reminder", "badge", "widget", "bio"],
    available: opts.available !== false,
    enrolled: opts.enrolled !== false,
  });
}

/** The Badging API is not in a WKWebView; take it away so the shell path runs. */
async function removeBadgeApi(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, writable: true, value: undefined });
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, writable: true, value: undefined });
  });
}

const messages = (page) => page.evaluate(() => window.__shellMessages || []);
const sent = async (page, type) => (await messages(page)).filter((m) => m.type === type);
const bioState = (page) => page.evaluate(() => window.__bio);

/** What the vault file says about itself, read through the app's own module. */
const vaultFacts = (page) =>
  page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const c = await import("/web/js/crypto.js");
    return {
      vid: c.vaultId(ctx.vault),
      kinds: ctx.vault.wrappers.map((w) => w.kind).sort(),
      labels: ctx.vault.wrappers.map((w) => w.label),
    };
  });

/** The same, read back out of IndexedDB - the part that survives a reload. */
const storedFacts = (page) =>
  page.evaluate(async () => {
    const { loadVault } = await import("/web/js/store.js");
    const c = await import("/web/js/crypto.js");
    const vault = await loadVault();
    return vault
      ? { vid: c.vaultId(vault), kinds: vault.wrappers.map((w) => w.kind).sort() }
      : null;
  });

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

async function openSettings(page) {
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await expect(page.locator(".h-title")).toHaveText("Settings");
}

async function lockNow(page) {
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    await ctx.lock();
  });
  await page.waitForSelector(".lock-title");
}

/**
 * Type the passphrase and press Unlock.
 *
 * The fill is retried until the value sticks, which is not paranoia: a refused
 * biometric attempt repaints the lock screen through a view transition, and a
 * value typed into the element that transition is about to replace is lost -
 * the button then submits an empty field and does nothing at all. Measured on
 * the invalidated path, where the repaint is the whole point.
 */
async function unlockWithPassphrase(page) {
  const field = page.locator(".lock input");
  await expect(field).toBeVisible();
  await expect
    .poll(async () => {
      await field.fill(PASS);
      return field.inputValue();
    })
    .toBe(PASS);
  // The click can be swallowed the same way the fill can: the repaint that
  // follows a refused biometric attempt replaces the button between hit test
  // and dispatch, and a lost click looks exactly like a slow PBKDF2 (this
  // spec failed twice in a row in a full 13-worker run and passed alone every
  // time). Press until the screen actually turns over.
  await expect
    .poll(
      async () => {
        if (await page.locator(".h-title").count()) return true;
        // Re-fill before every attempt: the repaint clears the field as well
        // as replacing the button, and a click on an empty field is silently
        // ignored by the app - which is exactly what the failure snapshot
        // showed (locked screen, empty passphrase box, button pressed).
        if (await field.count()) await field.fill(PASS).catch(() => {});
        const button = page.getByRole("button", { name: /^Unlock$/ });
        if (await button.count()) await button.click().catch(() => {});
        return page.locator(".h-title").count().then((n) => n > 0);
      },
      { timeout: 120_000, intervals: [2000] },
    )
    .toBe(true);
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 60000 });
}

/** Anchored: the row's two states must not match each other's text. */
const bioRow = (page) =>
  page.locator(".setrow-label").filter({ hasText: /^Unlock with face or fingerprint$/ });
const againRow = (page) =>
  page.locator(".setrow-label").filter({ hasText: /^Set up face or fingerprint again$/ });
const shellButton = (page) => page.locator('[data-bio="shell"]');
const prfButton = (page) => page.locator('[data-bio="unlock"]');
const bioNote = (page) => page.locator('[data-bio="note"]');

/** Turn it on from the settings row, and wait until the vault carries it. */
async function enableFromSettings(page) {
  await openSettings(page);
  await expect(bioRow(page)).toBeVisible({ timeout: 15000 });
  await bioRow(page).click();
  await expect(page.locator(".toast")).toContainText("can now open the vault");
}

// ------------------------------------------------------------ the settings row

test("the row appears only where the shell offers biometry, and never beside the browser one", async ({
  page,
}) => {
  // A capability the shell does not advertise is a feature the web app must not
  // offer. And the browser's own path must be gone in here regardless: WebAuthn
  // does not exist in a WKWebView, so a row promising it would be a switch that
  // can never be turned on.
  await stubShell(page, { capabilities: ["reminder", "badge", "widget"] });
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await openSettings(page);

  await expect(bioRow(page)).toHaveCount(0);
  await expect(againRow(page)).toHaveCount(0);
  expect(await sent(page, "bio.available")).toEqual([]);

  const probe = await page.evaluate(async () => {
    const webauthn = await import("/web/js/webauthn.js");
    const bio = await import("/web/js/bio.js");
    return { prf: webauthn.supported(), shell: bio.supported() };
  });
  // Chromium under test HAS the WebAuthn API surface; the shell branch is what
  // takes it away, and it is stated rather than inferred.
  expect(probe.prf).toBe(false);
  expect(probe.shell).toBe(false);
});

test("hardware with nothing enrolled says so and offers nothing to press", async ({ page }) => {
  // Two facts, two answers: `available` without `enrolled` is a phone whose
  // owner has not set Face ID up. The honest line is "do that first", not a
  // button that fails.
  await stubShell(page, { enrolled: false });
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await openSettings(page);

  await expect(page.locator(".setrow").filter({ hasText: "Set up face or fingerprint on this device first" })).toHaveCount(1, {
    timeout: 15000,
  });
  await expect(page.locator(".setrow").filter({ hasText: "Set up face or fingerprint on this device first" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(await sent(page, "bio.createKey")).toEqual([]);
});

test("no biometric hardware at all draws no row", async ({ page }) => {
  await stubShell(page, { available: false, enrolled: false });
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await openSettings(page);

  // The capability is advertised per device, so a shell that has it can still
  // answer "no hardware here" - and then there is nothing to draw.
  await expect(page.locator(".setrow").filter({ hasText: /face or fingerprint/i })).toHaveCount(0);
  const asked = await sent(page, "bio.available");
  expect(asked.length).toBeGreaterThan(0);
  expect(Object.keys(asked[0])).toEqual(["type"]);
});

test("turning it on mints a key, writes the fourth wrapper and persists it", async ({ page }) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await enableFromSettings(page);

  const facts = await vaultFacts(page);
  expect(facts.kinds).toEqual(["passphrase", "recovery", "shell-bio-v1"]);
  // Per device, so another device disabling cannot revoke this one.
  expect(facts.labels.some((l) => l.startsWith("shell-bio:"))).toBe(true);

  // The whole message, asserted literally: a cross-repository wire contract.
  const created = await sent(page, "bio.createKey");
  expect(created).toEqual([{ type: "bio.createKey", vaultId: facts.vid }]);
  expect(facts.vid).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  expect((await bioState(page)).created).toBe(1);

  // Saved, not just held: the wrapper has to be there after a reload, or the
  // next launch would offer a button with nothing behind it.
  const stored = await storedFacts(page);
  expect(stored.kinds).toEqual(["passphrase", "recovery", "shell-bio-v1"]);
  expect(stored.vid).toBe(facts.vid);

  // The row now reads as on.
  await expect(page.locator(".setrow-value").filter({ hasText: /^On$/ })).toHaveCount(1);
});

test("turning it off takes the wrapper out and the key with it", async ({ page }) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await enableFromSettings(page);
  const vid = (await vaultFacts(page)).vid;

  await bioRow(page).click();
  await expect(page.locator(".sheet-title")).toHaveText("Turn this off?");
  await page.locator(".sheet-foot").getByRole("button", { name: "Turn off" }).click();
  await expect(page.locator(".toast")).toHaveText("Turned off on this device.");

  expect(await sent(page, "bio.deleteKey")).toEqual([{ type: "bio.deleteKey", vaultId: vid }]);
  const facts = await vaultFacts(page);
  expect(facts.kinds).toEqual(["passphrase", "recovery"]);
  // The passphrase and the recovery key were never touched: still two of them.
  expect((await storedFacts(page)).kinds).toEqual(["passphrase", "recovery"]);
  expect(Object.keys((await bioState(page)).keys)).toEqual([]);
});

// -------------------------------------------------------------- the lock screen

test("the lock screen offers the button and the key opens the vault", async ({ page }) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await enableFromSettings(page);
  const vid = (await vaultFacts(page)).vid;

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await lockNow(page);

  // Same slot as the browser path, and it fires itself once - that is the
  // answer to "a reload locks the vault immediately".
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 60000 });

  const unwrapped = await sent(page, "bio.unwrapKey");
  expect(unwrapped.length).toBe(1);
  expect(Object.keys(unwrapped[0]).sort()).toEqual(["reason", "type", "vaultId"]);
  expect(unwrapped[0].vaultId).toBe(vid);
  // Ready-localised, from the page, and inside the shell's limit.
  expect(unwrapped[0].reason).toBe("Unlock your list.");
  expect(unwrapped[0].reason.length).toBeLessThanOrEqual(300);

  // Nothing of the vault rode along, and no passphrase crossed.
  expect(JSON.stringify(await messages(page))).not.toContain(PASS);
});

test("cancelled and failed fall back to the passphrase without a word", async ({ page }) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await enableFromSettings(page);
  await page.getByRole("button", { name: "Close", exact: true }).click();

  // Dismissing the sheet is not an error. The field is right there, focused,
  // and the button stays - trying again is exactly the right move.
  await page.evaluate(() => {
    window.__bio.unwrapCode = "cancelled";
  });
  await lockNow(page);
  await expect(shellButton(page)).toBeVisible();
  await expect(bioNote(page)).toHaveCount(0);
  await expect(page.locator(".field-error")).toHaveText("");
  await expect(page.locator(".lock input")).toBeFocused();

  // Anything else that went wrong: the same silence, for the same reason.
  await page.evaluate(() => {
    window.__bio.unwrapCode = "failed";
  });
  await shellButton(page).click();
  await expect(bioNote(page)).toHaveCount(0);
  await expect(shellButton(page)).toBeVisible();

  // And the passphrase still opens it, which is the whole point of the silence.
  await page.evaluate(() => {
    window.__bio.unwrapCode = null;
  });
  await unlockWithPassphrase(page);
});

test("lockedOut says so, and keeps the button", async ({ page }) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await enableFromSettings(page);
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await page.evaluate(() => {
    window.__bio.unwrapCode = "lockedOut";
  });
  await lockNow(page);

  // One line, because inviting another try would be a lie: the device wants
  // its passcode first.
  await expect(bioNote(page)).toContainText("passcode");
  await expect(bioNote(page)).toContainText("passphrase opens the list");
  // The wrapper is untouched - this is a state that ends, not a loss.
  await expect(shellButton(page)).toBeVisible();
  expect((await vaultFacts(page)).kinds).toContain("shell-bio-v1");
});

test("invalidated says the enrolment changed, and the offer comes back in settings", async ({
  page,
}) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await enableFromSettings(page);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const vid = (await vaultFacts(page)).vid;

  await page.evaluate(() => {
    window.__bio.unwrapCode = "invalidated";
  });
  await lockNow(page);

  // A quiet line, not a sheet and not a banner: the passphrase is needed once.
  await expect(bioNote(page)).toContainText("changed");
  await expect(bioNote(page)).toContainText("passphrase");
  // The button is gone: it cannot work again until the wrapper is rebuilt.
  await expect(shellButton(page)).toHaveCount(0);

  await page.evaluate(() => {
    window.__bio.unwrapCode = null;
  });
  await unlockWithPassphrase(page);

  // The dead wrapper is cleaned away lazily, here, where there is a master key
  // and a save on the way - never on a lock screen that can save nothing.
  await expect.poll(async () => (await vaultFacts(page)).kinds).toEqual(["passphrase", "recovery"]);
  await expect.poll(async () => (await storedFacts(page)).kinds).toEqual(["passphrase", "recovery"]);
  // And the marker on the other side goes too, so the next question answers
  // "missing" rather than repeating that a face changed.
  await expect.poll(async () => (await sent(page, "bio.deleteKey")).length).toBe(1);
  expect((await sent(page, "bio.deleteKey"))[0]).toEqual({ type: "bio.deleteKey", vaultId: vid });

  // The re-offer: one row, in the place somebody goes to look for it.
  await openSettings(page);
  await expect(againRow(page)).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".setrow").filter({ hasText: "The enrolment on this device changed" })).toHaveCount(1);

  // And it works: a new key, a new wrapper.
  await againRow(page).click();
  await expect(page.locator(".toast")).toContainText("can now open the vault");
  expect((await vaultFacts(page)).kinds).toEqual(["passphrase", "recovery", "shell-bio-v1"]);
  expect((await bioState(page)).created).toBe(2);
  // The offer is back to its ordinary wording once it has been taken up.
  await expect(againRow(page)).toHaveCount(0);
});

test("missing is treated as off: no word, no button, and the wrapper is cleaned away", async ({
  page,
}) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await enableFromSettings(page);
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await page.evaluate(() => {
    window.__bio.unwrapCode = "missing";
  });
  await lockNow(page);

  // The feature is off, whatever the vault file still says. Nothing is said,
  // because nothing happened to the person: the passphrase field is the screen.
  await expect(shellButton(page)).toHaveCount(0);
  await expect(bioNote(page)).toHaveCount(0);

  await page.evaluate(() => {
    window.__bio.unwrapCode = null;
  });
  await unlockWithPassphrase(page);
  await expect.poll(async () => (await vaultFacts(page)).kinds).toEqual(["passphrase", "recovery"]);

  // Turned off, not half off: the settings row is back to its offer form.
  await openSettings(page);
  await expect(bioRow(page)).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".setrow-value").filter({ hasText: /^On$/ })).toHaveCount(0);
});

test("the browser's biometric button never appears inside the shell", async ({ page }) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await enableFromSettings(page);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(() => {
    window.__bio.unwrapCode = "cancelled";
  });
  await lockNow(page);

  // One biometric button on this screen, and it is the shell's.
  await expect(shellButton(page)).toHaveCount(1);
  await expect(prfButton(page)).toHaveCount(0);
  const enrolled = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return { prf: ctx.biometric.supported, shell: ctx.shellBio.supported };
  });
  expect(enrolled.prf).toBe(false);
  expect(enrolled.shell).toBe(true);
});

// ------------------------------------------------- what the lock screen promises
//
// `lock.sub` says nothing on this device can read the list without the
// passphrase. That was true of three wrappers. It stopped being true with the
// fourth: a face on this device now opens the vault, and a screen that offers
// that as a button while promising it cannot exist is lying to the one person
// it is talking to. The second sentence is not a softening of the first - it
// keeps the part that is still true everywhere else, which is that no other
// device has any way in but the passphrase.
//
// The two sentences are decided by the same two booleans the button is built
// from, which is the point: there is no second way to ask whether this device
// can open the vault, so the screen cannot end up offering one and denying the
// other.

const lockSub = (page) => page.locator(".lock-sub").first();

test("without a biometric wrapper the lock screen keeps its promise", async ({ page }) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await lockNow(page);

  // Nothing armed: there is no button, and the original sentence is the true
  // one. Byte for byte the sentence the web app has always shown.
  await expect(shellButton(page)).toHaveCount(0);
  await expect(prfButton(page)).toHaveCount(0);
  await expect(lockSub(page)).toHaveText(
    "The list is sealed. Nothing on this device can read it without the passphrase.",
  );
});

test("once a face can open the vault the lock screen stops claiming it cannot", async ({ page }) => {
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await enableFromSettings(page);
  await page.getByRole("button", { name: "Close", exact: true }).click();

  // Cancelled, so the automatic attempt leaves the screen up to be read. The
  // button is still on offer after it - cancelling is not an error - which is
  // exactly the state in which the old sentence contradicted the screen it was
  // printed on.
  await page.evaluate(() => {
    window.__bio.unwrapCode = "cancelled";
  });
  await lockNow(page);

  await expect(shellButton(page)).toBeVisible();
  await expect(lockSub(page)).toHaveText(
    "The list is sealed. On this device it also opens with your face or fingerprint; anywhere else, only the passphrase opens it.",
  );

  // Wait for the automatic attempt to have actually been MADE before the
  // refusal is lifted. The prompt fires one frame after the screen is painted,
  // and every assertion above passes whether or not that frame has happened
  // yet - so lifting the refusal on the assertions alone is a race the test
  // loses by unlocking itself.
  await expect.poll(async () => (await sent(page, "bio.unwrapKey")).length).toBe(1);

  // And the honesty is per device, not per vault: turning the wrapper off puts
  // the original promise back, because it is true again.
  await page.evaluate(() => {
    window.__bio.unwrapCode = null;
  });
  await unlockWithPassphrase(page);
  await openSettings(page);
  await expect(bioRow(page)).toBeVisible({ timeout: 15000 });
  await bioRow(page).click();
  await expect(page.locator(".sheet-title")).toHaveText("Turn this off?");
  await page.locator(".sheet-foot").getByRole("button", { name: "Turn off" }).click();
  await expect.poll(async () => (await vaultFacts(page)).kinds).toEqual(["passphrase", "recovery"]);
  // The sheet slides out rather than vanishing, and it carries a Close button
  // of its own while it does - two on the screen at once is a strict-mode
  // violation, not a flake.
  await expect(page.locator(".sheet")).toHaveCount(0);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await lockNow(page);
  await expect(lockSub(page)).toHaveText(
    "The list is sealed. Nothing on this device can read it without the passphrase.",
  );
});

test("the honest sentence exists in all three catalogues and says where it applies", async ({
  page,
}) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const { LOCALES } = await import("/web/js/i18n.js");
    const out = {};
    for (const locale of LOCALES) {
      const cat = (await import(`/web/js/locales/${locale}.js`))[locale];
      out[locale] = { plain: cat["lock.sub"], bio: cat["lock.subBio"] };
    }
    return out;
  });
  for (const locale of ["en", "de", "es"]) {
    expect(typeof r[locale].bio, locale).toBe("string");
    // Not a copy of the sentence it replaces, and long enough to have said
    // both halves - what this device can do, and what no other device can.
    expect(r[locale].bio, locale).not.toBe(r[locale].plain);
    expect(r[locale].bio.length, locale).toBeGreaterThan(60);
  }
  expect(r.en.bio).toContain("On this device");
  expect(r.de.bio).toContain("Auf diesem Gerät");
  expect(r.es.bio).toContain("En este dispositivo");
});

// --------------------------------------------------------------- the vault dies

test("wiping the vault tells the shell which vault died", async ({ page }) => {
  // Before this message the shell could not see a wipe at all: a badge of zero
  // is an ordinary Tuesday. It clears the Keychain key, the widget state with
  // the badge, and the share slot - three things that would otherwise outlive
  // the vault they belong to.
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await enableFromSettings(page);
  const vid = (await vaultFacts(page)).vid;
  expect(Object.keys((await bioState(page)).keys)).toEqual([vid]);

  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    await ctx.wipeLocalVault();
  });

  const wiped = await sent(page, "vault.wiped");
  expect(wiped).toEqual([{ type: "vault.wiped", vaultId: vid }]);
  // Sent BEFORE the vault went, or it could not have been named.
  expect((await bioState(page)).wiped).toEqual([vid]);
  expect(Object.keys((await bioState(page)).keys)).toEqual([]);
  // And the pointer on this device is gone with it.
  expect(await page.evaluate(() => localStorage.getItem("tenfold.shellbio"))).toBeNull();
});

// ---------------------------------------------------------------- the contract

test("the bio message names are pinned to the ones the shell answers to", async ({ page }) => {
  // The other half of this assertion is in
  // tenfold-ios/Tests/Unit/BioMessageTests.swift, which pins the same five
  // strings from the Swift side. No shared import exists or can exist.
  const source = readFileSync(join(ROOT, "web/js/bio.js"), "utf8");
  expect(source).toContain('export const MSG_AVAILABLE = "bio.available";');
  expect(source).toContain('export const MSG_CREATE = "bio.createKey";');
  expect(source).toContain('export const MSG_UNWRAP = "bio.unwrapKey";');
  expect(source).toContain('export const MSG_DELETE = "bio.deleteKey";');
  expect(source).toContain('export const MSG_WIPED = "vault.wiped";');
  expect(readFileSync(join(ROOT, "web/js/shell.js"), "utf8")).toContain(
    'export const CAP_BIO = "bio";',
  );

  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const bio = await import("/web/js/bio.js");
    const shell = await import("/web/js/shell.js");
    const c = await import("/web/js/crypto.js");
    return {
      names: [bio.MSG_AVAILABLE, bio.MSG_CREATE, bio.MSG_UNWRAP, bio.MSG_DELETE, bio.MSG_WIPED],
      cap: shell.CAP_BIO,
      codes: bio.CODES,
      kind: c.SHELL_BIO_KIND,
      // In a plain browser there is no shell, so there is no feature. Nothing
      // here may throw on that path.
      supported: bio.supported(),
      enabled: bio.enabled(null),
      cached: bio.availableCached(),
      availableInBrowser: await bio.available(),
    };
  });
  expect(r.names).toEqual([
    "bio.available",
    "bio.createKey",
    "bio.unwrapKey",
    "bio.deleteKey",
    "vault.wiped",
  ]);
  expect(r.cap).toBe("bio");
  // The five codes, in the order BRIDGE.md lists them as outcomes.
  expect(r.codes).toEqual(["cancelled", "lockedOut", "invalidated", "missing", "failed"]);
  expect(r.kind).toBe("shell-bio-v1");
  expect(r.supported).toBe(false);
  expect(r.enabled).toBe(false);
  expect(r.cached).toBe(null);
  expect(r.availableInBrowser).toEqual({ available: false, enrolled: false, biometryType: "none" });
});

test("nothing the shell is handed about biometry can carry vault content", async ({ page }) => {
  // Every bio message this repository may send, and every field each one may
  // carry. A key crosses here - the shell's own 32 bytes, on their way to being
  // used once - and nothing else does: no label, no passphrase, no title.
  await stubShell(page);
  await removeBadgeApi(page);
  await freshApp(page);
  await setupVault(page);
  await page.getByRole("button", { name: /Write the first one|New entry/ }).click();
  await page.locator(".composer input").fill("CANARY-BIO-5512");
  await page.locator(".composer input").press("Enter");
  await page.locator(".composer input").press("Escape");
  await enableFromSettings(page);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await lockNow(page);
  // The shell's biometric button fires itself once, so the app comes straight
  // back - onto Today rather than The Ten, because this vault has a goal in it
  // and the daily question is therefore waiting (app.js `somethingWaits`,
  // tests/landing.spec.js). Which screen it was is beside the point here: what
  // this test reads is the message log, not the DOM.
  await expect(page.locator(".h-title")).toHaveText(/^(Today|The Ten)$/, { timeout: 60000 });
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    await ctx.wipeLocalVault();
  });

  const allowed = {
    "bio.available": [["type"]],
    "bio.createKey": [["type", "vaultId"]],
    "bio.unwrapKey": [["reason", "type", "vaultId"]],
    "bio.deleteKey": [["type", "vaultId"]],
    "vault.wiped": [["type", "vaultId"]],
  };
  const all = (await messages(page)).filter((m) => allowed[m.type]);
  expect(all.length).toBeGreaterThan(0);
  for (const message of all) {
    expect(allowed[message.type]).toContainEqual(Object.keys(message).sort());
  }
  const json = JSON.stringify(all);
  expect(json).not.toContain("CANARY-BIO-5512");
  expect(json).not.toContain(PASS);
  // The vault identifier is the only thing that repeats across them, and it is
  // a random name for a file - not derived from anything, and not a secret.
  const vids = new Set(all.filter((m) => m.vaultId).map((m) => m.vaultId));
  expect(vids.size).toBe(1);
});

test("the new sentences exist in all three catalogues", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const { LOCALES } = await import("/web/js/i18n.js");
    const out = {};
    for (const locale of LOCALES) {
      const cat = (await import(`/web/js/locales/${locale}.js`))[locale];
      out[locale] = {
        reason: cat["bio.reason"],
        lockedOut: cat["bio.lockedOut"],
        invalidated: cat["bio.invalidated"],
        notEnrolled: cat["bio.notEnrolled"],
        setupAgain: cat["bio.setupAgain"],
        setupAgainDesc: cat["bio.setupAgainDesc"],
      };
    }
    return out;
  });
  for (const locale of ["en", "de", "es"]) {
    for (const [key, value] of Object.entries(r[locale])) {
      expect(typeof value, `${locale}.${key}`).toBe("string");
      expect(value.length, `${locale}.${key}`).toBeGreaterThan(0);
    }
    // The prompt sentence is what a person reads on a system sheet with their
    // face in front of it: short, and well inside the 300 the shell cuts at.
    expect(r[locale].reason.length, `${locale} reason`).toBeLessThan(60);
    // The two that explain a loss have to explain it, not label it.
    expect(r[locale].invalidated.length, `${locale} invalidated`).toBeGreaterThan(80);
    expect(r[locale].lockedOut.length, `${locale} lockedOut`).toBeGreaterThan(60);
  }
  expect(r.en.invalidated).toContain("passphrase");
  expect(r.de.invalidated).toContain("Passphrase");
  expect(r.es.invalidated).toContain("frase de paso");
});
