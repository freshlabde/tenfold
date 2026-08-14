// Biometric unlock: the platform authenticator as one more envelope on the
// vault (web/js/webauthn.js, WebAuthn PRF over the raw wrapper crypto.js has
// carried since wave 1).
//
// These specs drive the real app against Chromium's VIRTUAL authenticator, set
// up through the CDP WebAuthn domain. That authenticator does support the PRF
// extension (`hasPrf: true` on addVirtualAuthenticator), and it answers with 32
// bytes both at create() and at get() time - so the whole chain, enrolment
// through unlock, is exercised for real here, not merely structurally.
//
// One platform rule shapes every test below: WebAuthn refuses IP-address
// origins ("SecurityError: This is an invalid domain"), and the suite's baseURL
// is http://127.0.0.1. The same server answers on localhost, which is both a
// secure context and a valid relying-party id, so these specs navigate there.
import { test, expect } from "@playwright/test";

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

// Real WebCrypto: 600000 PBKDF2 rounds per unlock, and these specs unlock twice.
test.describe.configure({ mode: "parallel", timeout: 120_000 });

/** The same origin as baseURL, but by name - see the note at the top. */
function appOrigin(baseURL) {
  return baseURL.replace("127.0.0.1", "localhost");
}

/**
 * A user-verifying platform authenticator with PRF. Returns its id plus the
 * session, so a test can flip user verification on and off mid-flight.
 */
async function addAuthenticator(page, { isUserVerified = true } = {}) {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      isUserVerified,
      automaticPresenceSimulation: true,
    },
  });
  return { client, authenticatorId };
}

async function freshApp(page, baseURL, { keepStorage = false } = {}) {
  await page.setViewportSize(PHONE);
  await page.goto(`${appOrigin(baseURL)}/web/index.html`);
  await page.evaluate(
    (keep) =>
      new Promise((done) => {
        if (!keep) localStorage.clear();
        const req = indexedDB.deleteDatabase("tenfold");
        req.onsuccess = req.onerror = req.onblocked = () => done();
      }),
    keepStorage,
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
  await page.getByRole("button", { name: /Start with a frame/ }).click();
  // The backup step asks before anything is uploaded; sync stays off here.
  await page.getByRole("button", { name: "Not now" }).click();
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
}

/**
 * The vault is open - and that is all this file ever needs to know.
 *
 * An unlock opens where the work is: the frame above seeds eight goals, so the
 * daily question is waiting and these unlocks come back on Today rather than on
 * The Ten (app.js `somethingWaits`, tests/landing.spec.js). Which of the two it
 * was is beside the point of an authenticator test; that the passphrase or the
 * credential got in at all is the whole point.
 */
async function inTheApp(page) {
  await expect(page.locator(".h-title")).toHaveText(/^(Today|The Ten)$/, { timeout: 60000 });
}

async function openSettings(page) {
  await page.getByRole("button", { name: /settings/i }).click();
  await expect(page.locator(".h-title")).toHaveText("Settings");
}

/** Walk the settings row that turns the enrolment on. */
async function enrol(page) {
  await openSettings(page);
  const row = page.getByRole("button", { name: "Unlock with face or fingerprint" });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByText("This device can now open the vault.")).toBeVisible();
}

test("the module reports honestly and unlocks nothing without a pointer", async ({ page, baseURL }) => {
  // Structure and failure modes, without any authenticator in the browser.
  await page.goto(`${appOrigin(baseURL)}/tests/fixture.html`);
  const out = await page.evaluate(async () => {
    localStorage.clear();
    const wa = await import("/web/js/webauthn.js");
    const exports = ["supported", "platformAvailable", "platformAvailableCached", "enrolled", "wrapperLabel", "enrol", "unlock", "revoke", "forget"];
    const missing = exports.filter((k) => typeof wa[k] !== "function");
    const results = {
      missing,
      supported: wa.supported(),
      cachedBeforeAsking: wa.platformAvailableCached(),
      available: await wa.platformAvailable(),
      label: wa.wrapperLabel(),
      enrolledWithoutVault: wa.enrolled(null),
      pointerInStorage: localStorage.getItem("tenfold.webauthn"),
    };
    try {
      await wa.unlock({ magic: "TENFOLD1", version: 1, wrappers: [], payload: null });
      results.unlockThrew = "no";
    } catch (err) {
      results.unlockThrew = err.name;
    }
    return results;
  });

  expect(out.missing).toEqual([]);
  expect(out.supported).toBe(true); // the API exists in Chromium
  expect(out.cachedBeforeAsking).toBe(null); // nothing assumed before asking
  expect(out.available).toBe(false); // no authenticator in this browser
  expect(out.label).toBe(null);
  expect(out.enrolledWithoutVault).toBe(false);
  expect(out.unlockThrew).toBe("WebAuthnUnavailableError");
  // Nothing was written anywhere by merely asking.
  expect(out.pointerInStorage).toBe(null);
});

test("without a platform authenticator the settings row does not exist", async ({ page, baseURL }) => {
  await freshApp(page, baseURL);
  await setupVault(page);
  await openSettings(page);
  // The security group is there, its biometric row is not.
  await expect(page.getByRole("button", { name: "Lock now" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Unlock with face or fingerprint" })).toHaveCount(0);
});

test("enrol, lock, and the authenticator opens the vault", async ({ page, baseURL }) => {
  await addAuthenticator(page);
  await freshApp(page, baseURL);
  await setupVault(page);
  await enrol(page);

  // The reload complaint: locked instantly, and back in without typing.
  await page.reload();
  await page.waitForSelector(".lock-title");
  // No passphrase is entered anywhere in this test.
  await inTheApp(page);
});

test("a cancelled prompt falls back to the passphrase without an error banner", async ({ page, baseURL }) => {
  // User verification off: every prompt is refused, exactly like a Touch ID
  // sheet the person dismisses. (Chromium's virtual authenticator does not
  // recover from this within a session - setUserVerified back to true keeps
  // failing - so this spec only ever asserts the failure path.)
  const { client, authenticatorId } = await addAuthenticator(page, { isUserVerified: true });
  await freshApp(page, baseURL);
  await setupVault(page);
  await enrol(page);

  await client.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
  await page.reload();
  await page.waitForSelector(".lock-title");

  const button = page.locator('[data-bio="unlock"]');
  await expect(button).toBeVisible();
  // Silence: no "that did not open the vault", no counter, no toast.
  await expect(page.locator(".field-error")).toHaveText("");
  await expect(page.locator("#toast")).not.toHaveClass(/is-open/);
  await expect(page.locator(".h-title")).toHaveCount(0);

  // Pressing it by hand fails the same quiet way, and leaves the field usable.
  await button.click();
  await page.waitForTimeout(300);
  await expect(page.locator(".field-error")).toHaveText("");
  await expect(page.locator(".lock-title")).toBeVisible();

  // The passphrase still opens it while the button sits right above the field.
  await page.locator('input[type="password"]').fill(PASS);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await inTheApp(page);
});

test("turning it off removes the button, and the passphrase still works", async ({ page, baseURL }) => {
  await addAuthenticator(page);
  await freshApp(page, baseURL);
  await setupVault(page);
  await enrol(page);

  // The row now reads as on, and offers the way out.
  await expect(page.getByRole("button", { name: /Unlock with face or fingerprint/ })).toContainText("On");
  await page.getByRole("button", { name: /Unlock with face or fingerprint/ }).click();
  await page.locator(".sheet").getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("Turned off on this device.")).toBeVisible();

  await page.reload();
  await page.waitForSelector(".lock-title");
  await expect(page.locator('[data-bio="unlock"]')).toHaveCount(0);

  await page.locator('input[type="password"]').fill(PASS);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await inTheApp(page);
});

test("a pointer from another device is ignored, not fatal", async ({ page, baseURL }) => {
  await addAuthenticator(page);
  await freshApp(page, baseURL);
  await setupVault(page);
  await enrol(page);

  // Two ways the local pointer can stop matching this vault. First: it is gone
  // (a cleared browser store, a different profile).
  await page.evaluate(() => localStorage.removeItem("tenfold.webauthn"));
  await page.reload();
  await page.waitForSelector(".lock-title");
  await expect(page.locator('[data-bio="unlock"]')).toHaveCount(0);

  // Second: a pointer that points at a credential this vault never enrolled.
  await page.evaluate(() =>
    localStorage.setItem(
      "tenfold.webauthn",
      JSON.stringify({ credentialId: "ZZZZZZZZZZZZZZZZ", salt: "AAAAAAAAAAAAAAAA" }),
    ),
  );
  await page.reload();
  await page.waitForSelector(".lock-title");
  await expect(page.locator('[data-bio="unlock"]')).toHaveCount(0);

  // The passphrase opens it in both cases.
  await page.locator('input[type="password"]').fill(PASS);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await inTheApp(page);
});

test("nothing key-like is written to local storage", async ({ page, baseURL }) => {
  await addAuthenticator(page);
  await freshApp(page, baseURL);
  await setupVault(page);
  await enrol(page);

  const stored = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      out[key] = localStorage.getItem(key);
    }
    return out;
  });

  const pointer = JSON.parse(stored["tenfold.webauthn"]);
  // Exactly two fields, both non-secret pointers.
  expect(Object.keys(pointer).sort()).toEqual(["credentialId", "salt"]);
  // The passphrase, the recovery key and anything that smells of a key are absent
  // from the whole of localStorage.
  const blob = JSON.stringify(stored);
  expect(blob).not.toContain(PASS);
  expect(blob.toLowerCase()).not.toContain("masterkey");
  expect(blob.toLowerCase()).not.toContain("wrapkey");
});
