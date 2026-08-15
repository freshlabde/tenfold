// The tip jar inside the native shell: the web half of the seventh wave.
//
// An external payment link for a tip is an App Store rejection, so the browser
// tip jar (ui/support.js, PayPal and two crypto addresses) does not exist
// inside the shell. The shell answers that with three consumable in-app
// purchases, and `web/js/tips.js` plus `web/js/ui/tips.js` are the page's half
// of it: which message goes out, what comes back, and what each outcome puts on
// screen.
//
// The shell here is a stub. It answers the way the real one does - the same
// reply shape, the same four codes, the same four states, the three fixture
// offers `StubTipStore` uses - and records every message so a test can read
// what crossed. What is under test is the WEB half. The native half (RevenueCat,
// StoreKit, the sort, the absence of any purchase artefact) is tested in
// tenfold-ios/Tests/Unit/TipJarTests.
//
// The wire shape is written down once, in tenfold-ios/docs/BRIDGE.md, and both
// suites assert against it literally rather than deriving it: two repositories
// on two release cycles cannot import from each other, so a rename has to fail
// loudly here instead of quietly agreeing with itself over there.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

// The three product identifiers, written out here a second time ON PURPOSE, the
// way bio.spec.js pins CAP_BIO: this file and
// tenfold-ios/Sources/Bridge/TipJar.swift are two independent statements of
// what they are, and they have to be typed identically into App Store Connect
// on activation day.
const ESPRESSO = "es.freshlab.tenfold.tip.espresso";
const DOUBLE = "es.freshlab.tenfold.tip.double";
const CAKE = "es.freshlab.tenfold.tip.cake";

// The three offers, in the order the shell sorts them: cheapest first, because
// the sheet is an invitation and not an upsell.
//
// The prices are Danish on purpose. `price` is a string the App Store built and
// this side never formats one; a page that ran it through a NumberFormatter
// would turn "19 kr" into something else long before it got anything wrong in a
// currency anybody would notice.
const OFFERS = [
  { id: ESPRESSO, title: "Ein Espresso", price: "19 kr", currency: "DKK" },
  { id: DOUBLE, title: "Ein doppelter", price: "39 kr", currency: "DKK" },
  { id: CAKE, title: "Kaffee und Kuchen", price: "79 kr", currency: "DKK" },
];

// Real WebCrypto: 600000 PBKDF2 rounds per unlock.
test.describe.configure({ mode: "parallel", timeout: 240_000 });

// ------------------------------------------------------------------- the stub

/**
 * A shell with a store behind it, or without one.
 *
 * `window.__tips` is that store: the offers it will answer with (null makes the
 * fetch refuse with `offersCode`), and one scripted outcome per product - the
 * same arrangement `StubTipStore` uses on the other side, where the outcome is
 * tied to the product rather than to a counter so that a test can name what it
 * expects.
 *
 * `send()` is the real envelope: the message's own fields stay at the top level
 * and only an `id` is added, in that order, so a message carrying its own `id`
 * would overwrite the routing id exactly as it would in the shell.
 */
async function stubShell(page, opts = {}) {
  await page.addInitScript((config) => {
    const messages = [];
    window.__shellMessages = messages;
    window.__tips = {
      offers: config.offers,
      offersCode: config.offersCode,
      offersOk: config.offersOk !== false,
      outcomes: config.outcomes || {},
      buys: 0,
    };
    let nextId = 1;
    window.__tenfoldShell = {
      platform: "ios",
      version: "0.7.0 (7)",
      loader: "scheme://app",
      origin: String(location.origin),
      capabilities: config.capabilities,
      post(message) {
        messages.push(message);
        return true;
      },
      send(message) {
        const envelope = { id: `s${nextId++}` };
        const flat = Object.assign(envelope, message);
        messages.push(flat);
        const store = window.__tips;
        const head = { type: message.type, replyTo: flat.id };

        if (message.type === "tips.offers") {
          if (!store.offersOk || !store.offers) {
            return Promise.resolve({ ...head, ok: false, code: store.offersCode });
          }
          return Promise.resolve({ ...head, ok: true, offers: store.offers });
        }
        if (message.type === "tips.buy") {
          store.buys += 1;
          const scripted = store.outcomes[message.product];
          if (!scripted) {
            // An unknown but well-formed identifier: the flow ran and found
            // nothing, which is `ok: true` with a state, not a refusal.
            return Promise.resolve({ ...head, ok: true, state: "failed", code: "unknownProduct" });
          }
          if (scripted.ok === false) {
            return Promise.resolve({ ...head, ok: false, code: scripted.code });
          }
          const reply = { ...head, ok: true, state: scripted.state };
          if (scripted.code) reply.code = scripted.code;
          return Promise.resolve(reply);
        }
        // Badge, widget and the reminder say nothing this suite reads. The
        // reminder's two status fields are carried anyway, so push.js meets the
        // shape it expects rather than a truthy stub it has to guess at.
        return Promise.resolve({ ...head, ok: true, enabled: false, permission: "notDetermined" });
      },
      request() {
        return Promise.resolve({ type: "pong" });
      },
      _receive() {},
    };
  }, {
    capabilities: opts.capabilities || ["reminder", "badge", "widget", "tips"],
    offers: opts.offers === undefined ? OFFERS : opts.offers,
    offersCode: opts.offersCode || "unknownProduct",
    offersOk: opts.offersOk,
    outcomes: opts.outcomes,
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

/** Walk the first run to a usable outline. */
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
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
}

/** Settings, from a fresh app inside whichever shell was stubbed. */
async function settings(page) {
  await freshApp(page);
  await setupVault(page);
  await page.getByRole("button", { name: "Open settings" }).click();
}

/** Every tips.* message the page has sent so far. */
const tipMessages = (page) =>
  page.evaluate(() => (window.__shellMessages || []).filter((m) => String(m.type).startsWith("tips.")));

// ------------------------------------------------------------ the wire itself

test("the two message names, the capability and the product ids are these", async ({ page }) => {
  // Both halves of the pin. The other one is
  // tenfold-ios/Sources/Bridge/TipJar.swift, which declares the same strings
  // and is asserted by its own unit tests.
  expect(await readFile(join(ROOT, "web/js/shell.js"), "utf8")).toContain(
    'export const CAP_TIPS = "tips";',
  );

  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const tips = await import("/web/js/tips.js");
    const shell = await import("/web/js/shell.js");
    return {
      names: [tips.MSG_OFFERS, tips.MSG_BUY],
      cap: shell.CAP_TIPS,
      codes: tips.CODES,
      states: tips.STATES,
      // In a plain browser there is no shell and so no store. Nothing here may
      // throw on that path, and nothing may be sent.
      available: tips.tipsAvailable(),
      offers: await tips.loadOffers(),
      bought: await tips.buy("es.freshlab.tenfold.tip.espresso"),
    };
  });

  expect(r.names).toEqual(["tips.offers", "tips.buy"]);
  expect(r.cap).toBe("tips");
  // The four codes and the four states, in the order BRIDGE.md lists them.
  expect(r.codes).toEqual(["unavailable", "unknownProduct", "network", "failed"]);
  expect(r.states).toEqual(["purchased", "cancelled", "pending", "failed"]);
  expect(r.available).toBe(false);
  expect(r.offers).toEqual({ offers: null, code: "unavailable" });
  expect(r.bought).toEqual({ state: "failed", code: "unavailable" });
});

test("without the capability nothing is ever sent, in either direction", async ({ page }) => {
  // A shell that is real in every other way: it just has no store compiled in,
  // which is every build of the app before activation day.
  await stubShell(page, { capabilities: ["reminder", "badge", "widget", "bio"] });
  await page.goto("/tests/fixture.html");

  const r = await page.evaluate(async () => {
    const tips = await import("/web/js/tips.js");
    const { inShell } = await import("/web/js/shell.js");
    const ui = await import("/web/js/ui/tips.js");
    let opened = "not called";
    try {
      opened = ui.openTipSheet({
        openSheet: () => {
          throw new Error("the sheet was built without a store behind it");
        },
        toast: () => {},
      });
    } catch (e) {
      opened = `threw: ${e.message}`;
    }
    return {
      inShell: inShell(),
      available: tips.tipsAvailable(),
      offers: await tips.loadOffers(),
      bought: await tips.buy("es.freshlab.tenfold.tip.espresso"),
      opened,
      sent: window.__shellMessages.map((m) => m.type),
      sheets: document.querySelectorAll(".sheet").length,
    };
  });

  expect(r.inShell).toBe(true);
  expect(r.available).toBe(false);
  expect(r.offers).toEqual({ offers: null, code: "unavailable" });
  expect(r.bought).toEqual({ state: "failed", code: "unavailable" });
  expect(r.opened).toBe(null);
  expect(r.sheets).toBe(0);
  // The whole point of the capability being a property of the configuration:
  // a build with no store is asked nothing at all.
  expect(r.sent.filter((t) => t.startsWith("tips."))).toEqual([]);
});

test("an offer that arrives broken is dropped rather than drawn", async ({ page }) => {
  await stubShell(page, {
    offers: [
      OFFERS[0],
      { id: DOUBLE, title: "Ein doppelter", price: "", currency: "DKK" },
      { id: "", title: "Nothing", price: "1 kr", currency: "DKK" },
      OFFERS[2],
    ],
  });
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const tips = await import("/web/js/tips.js");
    return await tips.loadOffers();
  });
  // Two survive, in the order they arrived. A row with no price is a button
  // that cannot be paid, which is worse than a row that is not there.
  expect(r.code).toBe(null);
  expect(r.offers.map((o) => o.id)).toEqual([ESPRESSO, CAKE]);

  // And a list that is empty after all of that is reported as a broken shell,
  // never as a claim about a store: `ok: true` with no offers is a promise the
  // bridge made and did not keep.
  await page.evaluate(() => {
    window.__tips.offers = [{ id: "", title: "", price: "" }];
  });
  const empty = await page.evaluate(async () => (await import("/web/js/tips.js")).loadOffers());
  expect(empty).toEqual({ offers: null, code: "failed" });
});

// ------------------------------------------------------------- the settings row

test("in a browser there is no tip row and the espresso row is the web one", async ({ page }) => {
  await settings(page);

  const rows = page.locator(".setrow", { hasText: "Buy me an espresso" });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("One or two euros, if this is worth it to you.");
  await rows.click();
  // The browser sheet: three addresses, no offers, nothing asked of a shell
  // that is not there.
  await expect(page.locator(".sheet .addr")).toHaveCount(2);
  await expect(page.locator(".tip-list")).toHaveCount(0);
});

test("inside a shell without the capability there is no espresso row at all", async ({ page }) => {
  await stubShell(page, { capabilities: ["reminder", "badge", "widget"] });
  await settings(page);

  // Neither one: the browser jar is gated on !inShell() and the shell jar on a
  // capability this build does not advertise.
  await expect(page.locator(".setrow", { hasText: "espresso" })).toHaveCount(0);
  await expect(page.locator(".setrow", { hasText: "Version" })).toHaveCount(1);
  expect(await tipMessages(page)).toEqual([]);
});

test("with the capability the row is there, and it opens the offers", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await stubShell(page);
  await settings(page);

  const row = page.locator(".setrow", { hasText: "Buy me an espresso" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("A one-off tip through the App Store. Nothing is unlocked.");
  // The same neighbours the web row has: the app group, above the version.
  const neighbours = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".setrow")];
    const i = rows.findIndex((r) => r.textContent.includes("Buy me an espresso"));
    const label = (n) => (n ? n.querySelector(".setrow-label").textContent : null);
    return { before: label(rows[i - 1]), after: label(rows[i + 1]) };
  });
  expect(neighbours).toEqual({ before: "The method", after: "Version" });

  await row.click();
  const sheet = page.locator(".sheet");
  await expect(sheet.locator(".sheet-title")).toHaveText("Buy me an espresso");
  // No external payment link anywhere near this sheet.
  await expect(sheet.locator("a")).toHaveCount(0);

  const offers = sheet.locator(".tip-list .setrow");
  await expect(offers).toHaveCount(3);
  // Cheapest first, in the order the shell sent them: the sort is the shell's
  // and this side never runs a second one.
  expect(await offers.locator(".setrow-label").allTextContents()).toEqual([
    "Ein Espresso",
    "Ein doppelter",
    "Kaffee und Kuchen",
  ]);
  // The price strings exactly as the store built them. A formatter on this side
  // would be a second opinion about a value with one correct answer.
  expect(await offers.locator(".tip-price").allTextContents()).toEqual(["19 kr", "39 kr", "79 kr"]);
  // Nothing is claimed while three real rows are on screen.
  await expect(sheet.locator(".tip-note")).toBeEmpty();
  await expect(sheet).toContainText("Paying unlocks nothing, and this app keeps no receipt.");

  // Exactly one question was asked, and it was the offers one.
  const sent = await tipMessages(page);
  expect(sent.map((m) => m.type)).toEqual(["tips.offers"]);
  expect(Object.keys(sent[0]).sort()).toEqual(["id", "type"]);

  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------- the purchase

test("buying sends the exact wire message, and thanks for it", async ({ page }) => {
  await stubShell(page, { outcomes: { [ESPRESSO]: { state: "purchased" } } });
  await settings(page);
  await page.locator(".setrow", { hasText: "Buy me an espresso" }).click();
  await expect(page.locator(".tip-list .setrow")).toHaveCount(3);

  await page.locator(".tip-list .setrow").first().click();

  // Purchased: the sheet closes and the toast thanks. Nothing else changes,
  // anywhere, because nothing is unlocked by paying.
  await expect(page.locator("#toast")).toContainText("Thank you.");
  await expect(page.locator(".sheet")).toHaveCount(0);

  const sent = await tipMessages(page);
  expect(sent.map((m) => m.type)).toEqual(["tips.offers", "tips.buy"]);
  const buy = sent[1];
  // THE FIELD IS `product`, NOT `id`. `send()` copies the message's own fields
  // over the envelope it just built, so a product identifier under `id` would
  // overwrite the reply-routing id and every purchase would hang on both sides
  // with no error anywhere.
  expect(Object.keys(buy).sort()).toEqual(["id", "product", "type"]);
  expect(buy.product).toBe(ESPRESSO);
  expect(buy.id).not.toBe(ESPRESSO);
  expect(typeof buy.id).toBe("string");
});

test("a cancelled purchase is answered with silence", async ({ page }) => {
  await stubShell(page, {
    outcomes: { [DOUBLE]: { state: "cancelled" }, [ESPRESSO]: { state: "purchased" } },
  });
  await settings(page);
  await page.locator(".setrow", { hasText: "Buy me an espresso" }).click();
  await expect(page.locator(".tip-list .setrow")).toHaveCount(3);

  await page.locator(".tip-list .setrow").nth(1).click();
  await expect.poll(async () => (await tipMessages(page)).length).toBe(2);

  // Somebody opened a payment sheet and changed their mind. That is an outcome,
  // not an error: no toast, no note, and the sheet stays exactly where it was.
  await expect(page.locator("#toast")).not.toHaveClass(/is-open/);
  await expect(page.locator(".sheet")).toHaveCount(1);
  await expect(page.locator(".tip-note")).toBeEmpty();
  await expect(page.locator(".tip-list .setrow")).toHaveCount(3);

  // And the way back from a mind changed twice is the row already on screen.
  await page.locator(".tip-list .setrow").first().click();
  await expect(page.locator("#toast")).toContainText("Thank you.");
  await expect(page.locator(".sheet")).toHaveCount(0);
});

test("a deferred purchase is not thanked for", async ({ page }) => {
  await stubShell(page, { outcomes: { [CAKE]: { state: "pending" } } });
  await settings(page);
  await page.locator(".setrow", { hasText: "Buy me an espresso" }).click();
  await expect(page.locator(".tip-list .setrow")).toHaveCount(3);

  await page.locator(".tip-list .setrow").nth(2).click();
  // Ask to Buy, or a payment method that needs a step elsewhere. It may complete
  // days later and this app will never find out, so the honest line is where it
  // is rather than what it did.
  await expect(page.locator("#toast")).toContainText("It is with the App Store.");
  await expect(page.locator(".sheet")).toHaveCount(0);
});

test("a purchase that failed says which kind, and leaves the rows up", async ({ page }) => {
  await stubShell(page, {
    outcomes: {
      [ESPRESSO]: { state: "failed", code: "network" },
      [DOUBLE]: { state: "failed", code: "unknownProduct" },
      [CAKE]: { state: "purchased" },
    },
  });
  await settings(page);
  await page.locator(".setrow", { hasText: "Buy me an espresso" }).click();
  await expect(page.locator(".tip-list .setrow")).toHaveCount(3);

  // The one code where "try again" is honest advice.
  await page.locator(".tip-list .setrow").first().click();
  await expect(page.locator(".tip-note")).toHaveText(
    "The App Store could not be reached. Worth trying again in a moment.",
  );
  await expect(page.locator(".tip-list .setrow")).toHaveCount(3);

  // A configuration failure and a code failure must not read alike.
  await page.locator(".tip-list .setrow").nth(1).click();
  await expect(page.locator(".tip-note")).toHaveText("The App Store has no tips to offer right now.");

  // The note is not a dead end: the rows are still there and still work.
  await page.locator(".tip-list .setrow").nth(2).click();
  await expect(page.locator("#toast")).toContainText("Thank you.");
  await expect(page.locator(".sheet")).toHaveCount(0);
});

// ------------------------------------------------------- when there is no list

test("the three ways there can be no offers are three different sentences", async ({ page }) => {
  // "The store said there are none" - the day-one failure mode, and a person's
  // job in a web form rather than a bug in this app.
  await stubShell(page, { offersOk: false, offersCode: "unknownProduct" });
  await settings(page);
  await page.locator(".setrow", { hasText: "Buy me an espresso" }).click();
  await expect(page.locator(".tip-note")).toHaveText("The App Store has no tips to offer right now.");
  // No dead buttons: the sheet renders only offers that arrived.
  await expect(page.locator(".tip-list .setrow")).toHaveCount(0);
  await page.locator(".sheet .sheet-foot .btn").click();
  await expect(page.locator(".sheet")).toHaveCount(0);

  // "The store could not be reached."
  await page.evaluate(() => {
    window.__tips.offersCode = "network";
  });
  await page.locator(".setrow", { hasText: "Buy me an espresso" }).click();
  await expect(page.locator(".tip-note")).toHaveText(
    "The App Store could not be reached. Worth trying again in a moment.",
  );
  await page.locator(".sheet .sheet-foot .btn").click();
  await expect(page.locator(".sheet")).toHaveCount(0);

  // "The store could not be asked" - the residual, and what an unreadable
  // message or a shell that never answers comes back as.
  await page.evaluate(() => {
    window.__tips.offersCode = "failed";
  });
  await page.locator(".setrow", { hasText: "Buy me an espresso" }).click();
  await expect(page.locator(".tip-note")).toHaveText("The App Store could not be asked.");
  await expect(page.locator(".tip-list .setrow")).toHaveCount(0);
});

// ------------------------------------------------------------------- the words

test("the wording carries in all three languages", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const i18n = await import("/web/js/i18n.js");
    const keys = [
      "tips.rowDesc",
      "tips.body",
      "tips.loading",
      "tips.none",
      "tips.unreachable",
      "tips.failed",
      "tips.thanks",
      "tips.pending",
      "tips.nothing",
    ];
    const out = {};
    for (const locale of ["en", "de", "es"]) {
      i18n.setLocale(locale);
      out[locale] = {};
      for (const k of keys) out[locale][k] = i18n.t(k);
    }
    i18n.setLocale("en");
    return out;
  });

  expect(r.en["tips.thanks"]).toBe("Thank you.");
  expect(r.de["tips.thanks"]).toBe("Danke.");
  expect(r.es["tips.thanks"]).toBe("Gracias.");
  for (const locale of ["en", "de", "es"]) {
    // Every state names the App Store, because that is who is being asked and
    // who the person would go to if they wanted to know more.
    for (const k of ["tips.loading", "tips.none", "tips.unreachable", "tips.failed"]) {
      expect(r[locale][k]).toContain("App Store");
    }
    // A missing key renders as the key itself, which would pass a contains
    // check by accident. Nothing here may look like a key.
    for (const value of Object.values(r[locale])) expect(value).not.toMatch(/^tips\./);
  }
});
