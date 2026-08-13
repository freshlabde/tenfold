// The tip jar: three ways to buy the author a coffee, and the one place it
// must not appear.
//
// Two things are under test here that are not ordinary UI behaviour:
//
//   1. THE ADDRESSES. A wrong character in a Bitcoin or an Ethereum address is
//      money handed to nobody, and no reviewer catches it by reading a diff.
//      So the literals are pinned byte for byte in this file, and a source scan
//      asserts they exist in exactly ONE module - a second copy is the way the
//      two would drift apart.
//   2. THE SHELL RULE. Inside the native iOS shell an external payment link is
//      an App Store rejection, so none of this may exist there: not the
//      settings row, not the About line, and not the sheet itself, which
//      refuses to open even when called directly.
import { test, expect } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

// The literals. Written out here a second time ON PURPOSE: this file and
// web/js/ui/support.js are the two independent statements of what the addresses
// are, and an edit to either one alone fails the suite.
const PAYPAL_URL = "https://www.paypal.me/freshlab";
const BITCOIN_ADDRESS = "bc1qzzvx2s3lqjv70p0rs2t99xfj86amvmzxscdeay";
const EVM_ADDRESS = "0x76620dE4af43494864A270d7f9bE448F1a46BBea";

// Real WebCrypto: 600000 PBKDF2 rounds per unlock.
test.describe.configure({ mode: "parallel", timeout: 180_000 });

/**
 * A stand-in for the native shell, installed before the app's modules run.
 *
 * Deliberately the smallest thing `shell.js` accepts as present - an object
 * with a `post` function - because that is exactly the condition the support
 * module tests. The full stub lives in tests/shell.spec.js and is not needed
 * for a feature that only ever asks "is there a shell at all".
 */
async function stubShell(page) {
  await page.addInitScript(() => {
    window.__shellMessages = [];
    window.__tenfoldShell = {
      platform: "ios",
      capabilities: ["reminder", "badge", "widget"],
      post(message) {
        window.__shellMessages.push(message);
        return true;
      },
      send(message) {
        window.__shellMessages.push(message);
        return Promise.resolve({ type: message.type, ok: true, enabled: false, permission: "denied" });
      },
      request(type) {
        return Promise.resolve({ type: "pong" });
      },
      _receive() {},
    };
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

/** Walk the first run to a usable outline, checking the intro on the way. */
async function setupVault(page) {
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 30000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start empty/ }).click();
  await page.getByRole("button", { name: "Not now" }).click();
  // The About text is shown once as the intro. Nobody is asked for money while
  // they are still deciding whether to trust the app with their goals, so the
  // line is absent here even in the browser.
  await expect(page.getByRole("button", { name: "Begin" })).toBeVisible();
  await expect(page.locator(".support-line")).toHaveCount(0);
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
}

// ------------------------------------------------------- the addresses first

test("the payment details are exactly these three strings", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const s = await import("/web/js/ui/support.js");
    return {
      paypal: s.PAYPAL_URL,
      btc: s.BITCOIN_ADDRESS,
      evm: s.EVM_ADDRESS,
      btcUri: s.BITCOIN_URI,
      evmUri: s.EVM_URI,
    };
  });

  expect(r.paypal).toBe(PAYPAL_URL);
  expect(r.btc).toBe(BITCOIN_ADDRESS);
  expect(r.evm).toBe(EVM_ADDRESS);
  // Lengths as a second, independent guard: a dropped character changes one of
  // these even when the eye reads the two strings as the same.
  expect(r.btc.length).toBe(42);
  expect(r.evm.length).toBe(42);
  // The EIP-55 checksum IS the mixed case. Lower-casing the address would
  // still be a valid address and would throw away the one guard a wallet has.
  expect(r.evm).not.toBe(r.evm.toLowerCase());
  // The wallet URIs carry the address unchanged, prefix and nothing else.
  expect(r.btcUri).toBe(`bitcoin:${BITCOIN_ADDRESS}`);
  expect(r.evmUri).toBe(`ethereum:${EVM_ADDRESS}`);
});

test("each address is written out in exactly one module", async () => {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  };
  await walk(join(ROOT, "web", "js"));
  files.push(join(ROOT, "web", "sw.js"));
  expect(files.length).toBeGreaterThan(15);

  for (const needle of [PAYPAL_URL, BITCOIN_ADDRESS, EVM_ADDRESS]) {
    const carriers = [];
    for (const file of files) {
      if ((await readFile(file, "utf8")).includes(needle)) carriers.push(file.replace(ROOT, ""));
    }
    expect(carriers, `${needle} must live in exactly one module`).toEqual(["/web/js/ui/support.js"]);
  }
});

test("both wallet URIs fit the house encoder with room to spare", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const s = await import("/web/js/ui/support.js");
    const { qrMatrix, MAX_VERSION } = await import("/web/js/qr.js");
    const measure = (value) => {
      const bytes = new TextEncoder().encode(value).length;
      const size = qrMatrix(value).length;
      // A symbol of side 4v+17 is version v.
      return { bytes, size, version: (size - 17) / 4 };
    };
    return { btc: measure(s.BITCOIN_URI), evm: measure(s.EVM_URI), max: MAX_VERSION };
  });

  // Byte mode, level M. Version 4 carries 62 data bytes; both payloads are
  // around fifty, so neither needs the bare-address fallback.
  expect(r.btc.bytes).toBe(50);
  expect(r.evm.bytes).toBe(51);
  expect(r.btc.version).toBe(4);
  expect(r.evm.version).toBe(4);
  expect(r.btc.version).toBeLessThan(r.max);
  expect(r.evm.version).toBeLessThan(r.max);
});

// ------------------------------------------------------------ the web app

test("the About screen closes with the espresso line, and it opens the sheet", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await freshApp(page);

  // The About screen before any vault exists: the sheet must work with nothing
  // unlocked, because this is where somebody reads what the app is.
  await page.getByRole("button", { name: /What is this/ }).click();
  const line = page.locator(".support-line");
  await expect(line).toHaveCount(1);
  await expect(line).toHaveText("If tenfold helps you get what you want, you can buy me an espresso.");
  // It is the last thing on the screen, after the claim.
  const afterClaim = await page.evaluate(() => {
    const claim = document.querySelector(".prose .claim");
    const support = document.querySelector(".support-line");
    return {
      order: claim.compareDocumentPosition(support) & Node.DOCUMENT_POSITION_FOLLOWING ? "after" : "before",
      last: support === support.parentElement.lastElementChild,
    };
  });
  expect(afterClaim).toEqual({ order: "after", last: true });

  await line.click();
  const sheet = page.locator(".sheet");
  await expect(sheet.locator(".sheet-title")).toHaveText("Buy me an espresso");

  // Three ways, in order: PayPal, Bitcoin, the EVM address.
  const paypal = sheet.locator("a.btn");
  await expect(paypal).toHaveCount(1);
  await expect(paypal).toHaveAttribute("href", PAYPAL_URL);
  await expect(paypal).toHaveAttribute("target", "_blank");
  // noopener denies the payment page a handle on the window that holds a
  // decrypted vault; noreferrer keeps the app's address out of its logs.
  const rel = await paypal.getAttribute("rel");
  expect(rel).toContain("noopener");
  expect(rel).toContain("noreferrer");

  const labels = await sheet.locator(".support-label").allTextContents();
  expect(labels).toEqual(["Bitcoin", "USDT / USDC (ERC-20)"]);
  const addresses = await sheet.locator(".addr").allTextContents();
  expect(addresses).toEqual([BITCOIN_ADDRESS, EVM_ADDRESS]);

  // The chain warning, and the privacy line.
  await expect(sheet).toContainText("This address is on Ethereum.");
  await expect(sheet.locator(".support-privacy")).toContainText("nothing is counted");

  // Both symbols really drew something: the same shape the pairing QR specs
  // assert, one path with a real amount of geometry in it.
  const paths = await sheet.locator(".qrcard .qr path").evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute("d").length),
  );
  expect(paths.length).toBe(2);
  for (const length of paths) expect(length).toBeGreaterThan(100);

  // The white card hugs its symbol rather than spanning the sheet: two of
  // these at pairing size turn an aside into a crypto page. Asserted because
  // the rule that does it was silently dropped once by a stylesheet comment
  // that swallowed it, and nothing else in the suite would have noticed.
  const plate = await page.evaluate(() => {
    const card = document.querySelector(".support-block .qrcard").getBoundingClientRect().width;
    const body = document.querySelector(".sheet-body").getBoundingClientRect().width;
    return { card, body };
  });
  expect(plate.card).toBeLessThan(plate.body * 0.75);
  expect(plate.card).toBeGreaterThan(150);

  expect(errors).toEqual([]);
});

test("the copy buttons put the exact addresses on the clipboard", async ({ page, context, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  await freshApp(page);
  await page.getByRole("button", { name: /What is this/ }).click();
  await page.locator(".support-line").click();
  const sheet = page.locator(".sheet");

  const copies = sheet.locator(".support-block .btn", { hasText: "Copy address" });
  await expect(copies).toHaveCount(2);

  for (const [index, expected] of [[0, BITCOIN_ADDRESS], [1, EVM_ADDRESS]]) {
    await copies.nth(index).click();
    await expect(page.locator("#toast")).toContainText("Address copied.");
    const got = await page.evaluate(() => navigator.clipboard.readText());
    // Byte for byte, case included: this is the string somebody pastes into a
    // wallet without ever looking at it again.
    expect(got).toBe(expected);
  }
});

test("the settings row sits by the version and opens the same sheet", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await page.getByRole("button", { name: "Open settings" }).click();

  const row = page.locator(".setrow", { hasText: "Buy me an espresso" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("One or two euros, if this is worth it to you.");

  // In the group about the app, under the two rows that say what this app is
  // (About and the method page) and above the version.
  const neighbours = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".setrow")];
    const i = rows.findIndex((r) => r.textContent.includes("Buy me an espresso"));
    const label = (n) => (n ? n.querySelector(".setrow-label").textContent : null);
    return { before: label(rows[i - 1]), after: label(rows[i + 1]) };
  });
  expect(neighbours).toEqual({ before: "The method", after: "Version" });

  await row.click();
  await expect(page.locator(".sheet-title")).toHaveText("Buy me an espresso");
  await expect(page.locator(".sheet .addr")).toHaveCount(2);
});

test("the wording carries in all three languages", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const i18n = await import("/web/js/i18n.js");
    const keys = ["support.row", "support.title", "support.about", "support.copy", "support.evm", "support.evmHint"];
    const out = {};
    for (const locale of ["en", "de", "es"]) {
      i18n.setLocale(locale);
      out[locale] = {};
      for (const k of keys) out[locale][k] = i18n.t(k);
    }
    i18n.setLocale("en");
    return out;
  });

  expect(r.en["support.row"]).toBe("Buy me an espresso");
  expect(r.de["support.row"]).toBe("Spendier einen Espresso");
  expect(r.es["support.row"]).toBe("Invítame a un café");
  // The chain label is a technical name and stays untranslated in all three;
  // the sentence explaining it does not.
  for (const locale of ["en", "de", "es"]) {
    expect(r[locale]["support.evm"]).toBe("USDT / USDC (ERC-20)");
    expect(r[locale]["support.evmHint"]).toContain("Ethereum");
    // A missing key renders as the key itself, which would pass a contains
    // check by accident. Nothing here may look like a key.
    for (const value of Object.values(r[locale])) expect(value).not.toMatch(/^support\./);
  }
});

// ------------------------------------------------------------- and the shell

test("inside the shell there is no row, no line, and no way into the sheet", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);

  // The module itself refuses, which is what makes the two absences below a
  // rule rather than two call sites that happen to agree.
  const refused = await page.evaluate(async () => {
    const s = await import("/web/js/ui/support.js");
    const { inShell } = await import("/web/js/shell.js");
    let opened = "not called";
    try {
      opened = s.openSupportSheet({
        openSheet: () => {
          throw new Error("the sheet was built inside the shell");
        },
        toast: () => {},
      });
    } catch (e) {
      opened = `threw: ${e.message}`;
    }
    return {
      inShell: inShell(),
      available: s.supportAvailable(),
      opened,
      aboutLine: s.supportAboutLine({}),
      sheets: document.querySelectorAll(".sheet").length,
    };
  });
  expect(refused.inShell).toBe(true);
  expect(refused.available).toBe(false);
  expect(refused.opened).toBe(null);
  expect(refused.aboutLine).toBe(null);
  expect(refused.sheets).toBe(0);

  // The About screen, reached the same way as in the browser test above.
  await page.getByRole("button", { name: /What is this/ }).click();
  await expect(page.locator(".prose .claim")).toBeVisible();
  await expect(page.locator(".support-line")).toHaveCount(0);
  await expect(page.locator("a[href*='paypal']")).toHaveCount(0);
  await page.getByRole("button", { name: "Close" }).first().click();

  // And the settings screen, which is the other entry point.
  await setupVault(page);
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.locator(".setrow", { hasText: "Version" })).toHaveCount(1);
  await expect(page.locator(".setrow", { hasText: "espresso" })).toHaveCount(0);
  await expect(page.locator(".sheet")).toHaveCount(0);
});
