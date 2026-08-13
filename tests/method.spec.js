// The method page: one public document, three languages, and the link into it.
//
// Four things are pinned here that a reading of the diff would not catch:
//
//   1. THE PAGE LOADS NOTHING, the same rule the policy is held to. A document
//      that pulls in a font is a document that can render naked and a page
//      that phones somewhere while the product's whole argument is that it
//      does not. The source is scanned for any foreign origin at all.
//   2. ALL THREE LANGUAGES STAND ON ONE URL and the toggle really switches
//      them, so the address somebody sends to a friend is one address.
//   3. THE ATTRIBUTION IS PART OF THE DOCUMENT. Hull by name and 1969 by year,
//      in every language. The method is not ours and the page has to say so
//      even after somebody rewrites a paragraph.
//   4. THE ABOUT LINK FOLLOWS THE POLICY LINE, NOT THE TIP JAR: present in the
//      browser and inside the native shell alike. The contrast is asserted
//      here on purpose, so nobody can "fix" it into the tip jar's behaviour
//      without a red test.
//
// The new questions live in the same file because they came out of the same
// piece of work: the catalogue grew, and the picking that depends on its
// length has to stay exactly as deterministic as it was.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PHONE = { width: 390, height: 844 };
const LANGS = ["de", "en", "es"];

// The two hrefs, written out here a second time on purpose - this file and
// web/js/ui/policy.js are the two independent statements of where the link
// goes, and an edit to either alone fails the suite.
const METHOD_PATH = "./method.html";
const METHOD_URL = "https://tenfold.kairatools.com/method.html";

/** The keys added to the catalogue by this piece of work. */
const NEW_QUESTIONS = [17, 18, 19, 20, 21, 22, 23, 24, 25, 26];

/** The shell, reduced to what shell.js accepts as present. */
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

// ------------------------------------------------------------- the document

test("the page is served, and it carries all three languages", async ({ request }) => {
  const res = await request.get("/web/method.html");
  expect(res.status()).toBe(200);
  const html = await res.text();

  for (const lang of LANGS) {
    expect(html, `${lang} block`).toContain(`id="doc-${lang}" lang="${lang}"`);
  }

  // Whose method this is. Once per language in the body, once per footer, and
  // the year with it: an attribution that survives a rewrite of the prose.
  expect((html.match(/Raymond Hull/g) || []).length).toBeGreaterThanOrEqual(6);
  expect((html.match(/How to Get What You Want/g) || []).length).toBeGreaterThanOrEqual(6);
  expect((html.match(/1969/g) || []).length).toBeGreaterThanOrEqual(6);

  // This is one of the two pages in this project that SHOULD be indexed.
  expect(html).not.toMatch(/noindex/i);
  expect(res.headers()["x-robots-tag"]).toBeUndefined();
});

test("the method page loads nothing from anywhere", async () => {
  const html = await readFile(join(ROOT, "web", "method.html"), "utf8");

  // No foreign origin of any kind, in an attribute or in prose. In particular
  // no link to whoever last wrote a thread about any of this.
  expect(html).not.toMatch(/https?:\/\//i);
  expect(html).not.toMatch(/<link\b/i);
  expect(html).not.toMatch(/<img\b/i);
  expect(html).not.toMatch(/<iframe\b/i);
  expect(html).not.toMatch(/@import/i);
  expect(html).not.toMatch(/<script[^>]+src=/i);
  expect(html).not.toMatch(/url\(\s*["']?(?!data:)[a-z0-9./]/i);

  // Two hrefs only: back into the app, and across to the policy.
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) {
    const ok = href === "./" || href === "./privacy.html";
    expect(ok, `unexpected href ${href}`).toBe(true);
  }

  // No inline event attribute; the toggle is wired with addEventListener.
  expect(html.replace(/<!--[\s\S]*?-->/g, "")).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
});

test("the two public documents link to each other", async () => {
  const method = await readFile(join(ROOT, "web", "method.html"), "utf8");
  const privacy = await readFile(join(ROOT, "web", "privacy.html"), "utf8");
  // Once per language, in both directions.
  expect((method.match(/href="\.\/privacy\.html"/g) || []).length).toBe(3);
  expect((privacy.match(/href="\.\/method\.html"/g) || []).length).toBe(3);
});

test("the toggle shows one language at a time, under the real CSP", async ({ page }) => {
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });

  await page.setViewportSize(PHONE);
  await page.emulateMedia({ colorScheme: "dark" });
  // The production path, so the page runs with the header a deployment sends.
  await page.goto("/method.html");

  // The inline style really applied: a blocked <style> would leave the body on
  // the browser default, and this page would ship as naked markup.
  const body = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await body()).toBe("rgb(15, 17, 21)");
  await page.emulateMedia({ colorScheme: "light" });
  expect(await body()).toBe("rgb(228, 230, 234)");
  await page.emulateMedia({ colorScheme: "dark" });

  for (const lang of LANGS) {
    await page.locator(`.langs button[data-lang="${lang}"]`).click();

    const visible = await page.evaluate(() =>
      [...document.querySelectorAll("main article")]
        .filter((a) => !a.hidden)
        .map((a) => a.id),
    );
    expect(visible).toEqual([`doc-${lang}`]);

    await expect(page.locator("html")).toHaveAttribute("lang", lang);
    await expect(page.locator(`.langs button[data-lang="${lang}"]`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const pressed = await page.locator('.langs button[aria-pressed="true"]').count();
    expect(pressed).toBe(1);
    // The address carries the choice, so a link can point at one language.
    expect(new URL(page.url()).searchParams.get("lang")).toBe(lang);

    // The attribution and the cross-link stand in every language.
    await expect(page.locator(`#doc-${lang}`)).toContainText("Raymond Hull");
    await expect(page.locator(`#doc-${lang}`)).toContainText("1969");
    await expect(page.locator(`#doc-${lang} .foot a`)).toHaveAttribute("href", "./privacy.html");
  }

  // The sections that must exist in every language, whatever else changes.
  await page.locator('.langs button[data-lang="en"]').click();
  await expect(page.locator("#doc-en h1")).toHaveText("The method");
  await expect(page.locator("#doc-en")).toContainText("The paper ritual");
  await page.locator('.langs button[data-lang="de"]').click();
  await expect(page.locator("#doc-de h1")).toHaveText("Die Methode");
  await expect(page.locator("#doc-de")).toContainText("Das Ritual auf Papier");
  await page.locator('.langs button[data-lang="es"]').click();
  await expect(page.locator("#doc-es h1")).toHaveText("El método");
  await expect(page.locator("#doc-es")).toContainText("El ritual en papel");

  expect(problems).toEqual([]);
});

test("an explicit lang in the address wins over the browser's own", async ({ browser }) => {
  const context = await browser.newContext({ locale: "de-DE", viewport: PHONE });
  const page = await context.newPage();
  await page.goto("/method.html?lang=es");
  const visible = await page.evaluate(() =>
    [...document.querySelectorAll("main article")].filter((a) => !a.hidden).map((a) => a.id),
  );
  expect(visible).toEqual(["doc-es"]);
  await context.close();
});

test("the browser's own language decides which document opens first", async ({ browser }) => {
  for (const [locale, expected] of [
    ["de-DE", "doc-de"],
    ["es-ES", "doc-es"],
    ["en-GB", "doc-en"],
    // A language this page does not speak falls back to English, never to a
    // blank screen.
    ["fr-FR", "doc-en"],
  ]) {
    const context = await browser.newContext({ locale, viewport: PHONE });
    const page = await context.newPage();
    await page.goto("/method.html");
    const visible = await page.evaluate(() =>
      [...document.querySelectorAll("main article")].filter((a) => !a.hidden).map((a) => a.id),
    );
    expect(visible, locale).toEqual([expected]);
    await context.close();
  }
});

test("the service worker does not precache the method page", async () => {
  // Deliberate, and the same rule the policy is under: the shell list is what
  // the app needs to open without a network. These two are public documents
  // that have to be current, and a cached copy is a stale copy.
  const sw = await readFile(join(ROOT, "web", "sw.js"), "utf8");
  expect(sw).not.toContain("method.html");
});

// -------------------------------------------------------------- and the link

test("the About screen links the method in the browser, and opens it", async ({
  page,
  context,
}) => {
  await freshApp(page);
  await page.getByRole("button", { name: /What is this/ }).click();

  const link = page.locator("a.method-line");
  await expect(link).toHaveCount(1);
  await expect(link).toHaveText("The method");
  await expect(link).toHaveAttribute("href", METHOD_PATH);
  await expect(link).toHaveAttribute("target", "_blank");
  const rel = await link.getAttribute("rel");
  expect(rel).toContain("noopener");
  expect(rel).toContain("noreferrer");

  // It opens the page, in a tab of its own.
  const opened = await Promise.all([context.waitForEvent("page"), link.click()]);
  const tab = opened[0];
  await tab.waitForLoadState();
  expect(tab.url()).toContain("/web/method.html");
  await expect(tab.locator("#doc-en h1")).toHaveText("The method");
  await tab.close();
});

test("inside the shell the method link stays and points at the public page", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await page.getByRole("button", { name: /What is this/ }).click();

  // The opposite rule to the tip jar: the payment line is gone, both document
  // links are not. An absolute address, because a same-origin target="_blank"
  // is inert in the shell.
  await expect(page.locator(".support-line")).toHaveCount(0);
  const link = page.locator("a.method-line");
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("href", METHOD_URL);
  await expect(link).toHaveAttribute("target", "_blank");

  // The two strings live in exactly one module.
  const source = await readFile(join(ROOT, "web", "js", "ui", "policy.js"), "utf8");
  expect(source).toContain(METHOD_URL);
  expect(source).toContain(METHOD_PATH);
});

test("the intro shows the method link where it deliberately shows no tip jar", async ({ page }) => {
  await freshApp(page);
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill("correct horse battery staple");
  await page.locator('input[type="password"]').nth(1).fill("correct horse battery staple");
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 30000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start empty/ }).click();
  await page.getByRole("button", { name: "Not now" }).click();

  await expect(page.getByRole("button", { name: "Begin" })).toBeVisible();
  await expect(page.locator(".support-line")).toHaveCount(0);
  await expect(page.locator("a.method-line")).toHaveCount(1);
});

// ------------------------------------------- the lock screen and the settings

/** Through the first run, into an unlocked vault. */
async function setupVault(page) {
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill("correct horse battery staple");
  await page.locator('input[type="password"]').nth(1).fill("correct horse battery staple");
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 60000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start empty/ }).click();
  await page.getByRole("button", { name: "Not now" }).click();
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
}

async function lockNow(page) {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /Lock now/ }).click();
  await page.waitForSelector(".lock-foot");
}

test("the lock screen offers the method, and opens it", async ({ page, context }) => {
  await freshApp(page);
  await setupVault(page);
  await lockNow(page);

  // The screen a stranger meets when a phone is handed to them: it has to be
  // able to say what this app is without anything being unlocked.
  const link = page.locator(".lock-foot a.btn-ghost");
  await expect(link).toHaveCount(1);
  await expect(link).toHaveText("The method");
  await expect(link).toHaveAttribute("href", METHOD_PATH);
  await expect(link).toHaveAttribute("target", "_blank");
  const rel = await link.getAttribute("rel");
  expect(rel).toContain("noopener");

  // The reading pair, and only the reading pair. The recovery key used to
  // share this row and now stands under the button it substitutes for; the
  // assertion below is what keeps it from drifting back in.
  const row = await page.evaluate(() =>
    [...document.querySelector(".lock-foot").children].map((n) => n.tagName + ":" + n.textContent),
  );
  expect(row.length).toBe(2);
  expect(row[0]).toBe("A:The method");
  expect(row[1]).toContain("About");

  const opened = await Promise.all([context.waitForEvent("page"), link.click()]);
  const tab = opened[0];
  await tab.waitForLoadState();
  expect(tab.url()).toContain("/web/method.html");
  await tab.close();
});

test("inside the shell the lock screen keeps the entry, at the public address", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await lockNow(page);

  const link = page.locator(".lock-foot a.btn-ghost");
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("href", METHOD_URL);
  await expect(link).toHaveAttribute("target", "_blank");
});

/**
 * The four groups the foot of the lock screen is built from, top to bottom.
 * The redesign moved entries BETWEEN these groups; it moved none of them off
 * the screen, and the two tests below are what say so.
 */
const FOOT_GROUPS = [".lock-alt", ".lock-foot", ".lang-switch", ".lock-reset"];

/** Every entry in those groups, measured, in the order it is painted. */
function readFoot(page, groups) {
  return page.evaluate(
    (sels) =>
      sels.flatMap((sel) =>
        [...document.querySelector(sel).children].map((n) => {
          const r = n.getBoundingClientRect();
          return {
            group: sel,
            tag: n.tagName,
            text: (n.textContent || "").trim(),
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          };
        }),
      ),
    groups,
  );
}

test("the foot of the lock screen keeps every entry, grouped by kind", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await lockNow(page);

  const foot = await readFoot(page, FOOT_GROUPS);
  const say = (sel) => foot.filter((n) => n.group === sel).map((n) => n.text);

  // Four kinds, four places, nothing lost. The recovery key is an action and
  // sits with the button; the two documents are reading and sit together; the
  // languages are a setting; the wipe is destructive and is last.
  expect(say(".lock-alt")).toEqual(["Use the recovery key"]);
  expect(say(".lock-foot")).toEqual(["The method", "About"]);
  expect(say(".lang-switch")).toEqual(["English", "Deutsch", "Español"]);
  expect(say(".lock-reset")).toEqual(["Delete the vault and start over"]);

  // In that order down the screen, and the wipe furthest from the rest: the
  // gap in front of it is the whole point of moving it.
  const tops = foot.map((n) => n.top);
  expect([...tops].sort((a, b) => a - b)).toEqual(tops);
  const reset = foot.find((n) => n.group === ".lock-reset");
  const langs = foot.filter((n) => n.group === ".lang-switch");
  const lastLang = Math.max(...langs.map((n) => n.bottom));
  expect(reset.top - lastLang).toBeGreaterThan(10);

  // Every one of them is a real tap target and every one of them still works.
  for (const entry of foot) {
    expect(entry.height, entry.text).toBeGreaterThanOrEqual(34);
    expect(entry.width, entry.text).toBeGreaterThan(0);
  }
  await expect(page.locator(".lock-alt button")).toBeEnabled();
  await expect(page.locator(".lock-reset button")).toBeEnabled();

  // The action still is the action: it swaps the field for the recovery key
  // and back, from where it now stands.
  await page.locator(".lock-alt button").click();
  await expect(page.locator("input.is-mono")).toHaveCount(1);
  await expect(page.locator(".lock-alt button")).toHaveText("Use the passphrase");
  await page.locator(".lock-alt button").click();
  await expect(page.locator("input.is-mono")).toHaveCount(0);
});

test("the lock foot fits a 360px phone, in all three languages", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await freshApp(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await setupVault(page);
  await lockNow(page);

  for (const [code, native] of [
    ["en", "English"],
    ["de", "Deutsch"],
    ["es", "Español"],
  ]) {
    await page.locator(`.lang-switch button[lang="${code}"]`).click();
    await page.waitForSelector(".lock-foot");
    await expect(page.locator(`.lang-switch button[lang="${code}"]`)).toHaveText(native);

    const kids = await readFoot(page, FOOT_GROUPS);
    const box = await page.evaluate(
      (sels) => ({
        docWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        rows: sels.map((sel) => {
          const r = document.querySelector(sel).getBoundingClientRect();
          return { sel, left: r.left, right: r.right };
        }),
      }),
      FOOT_GROUPS,
    );
    box.kids = kids;

    // Measured, not eyeballed: nothing sticks out of its row, entries in one
    // row do not overlap each other, and the page does not scroll sideways.
    expect(box.docWidth, code).toBeLessThanOrEqual(box.viewport);
    for (const kid of box.kids) {
      const row = box.rows.find((r) => r.sel === kid.group);
      expect(kid.left, `${code}: ${kid.text} starts left of ${kid.group}`).toBeGreaterThanOrEqual(
        row.left - 0.5,
      );
      expect(kid.right, `${code}: ${kid.text} runs past ${kid.group}`).toBeLessThanOrEqual(
        row.right + 0.5,
      );
    }
    for (const sel of [".lock-foot", ".lang-switch"]) {
      const kids = box.kids.filter((k) => k.group === sel);
      for (let i = 1; i < kids.length; i += 1) {
        expect(kids[i].left, `${code}: ${sel} entries overlap`).toBeGreaterThanOrEqual(
          kids[i - 1].right - 0.5,
        );
      }
    }
    // One line each. A label that wrapped would make its entry taller than a
    // single tap target, which is the shape the owner asked not to see - and
    // "Delete the vault and start over" in German is the longest string on
    // the screen, so it is the one that would break first.
    for (const kid of box.kids) {
      expect(kid.height, `${code}: "${kid.text}" wrapped to a second line`).toBeLessThan(48);
    }
  }
});

test("the foot clears the home indicator on a notched phone", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await lockNow(page);

  // No headless browser has a notch, so the inset is written into the property
  // the app reads it through and the layout is measured against it.
  await page.evaluate(() => document.documentElement.style.setProperty("--sa-bot", "34px"));
  await page.waitForTimeout(50);

  const r = await page.evaluate(() => {
    const reset = document.querySelector(".lock-reset").getBoundingClientRect();
    const bar = document.querySelector(".bar").getBoundingClientRect();
    const alt = document.querySelector(".lock-alt").getBoundingClientRect();
    return {
      resetBottom: reset.bottom,
      frame: document.querySelector(".frame").getBoundingClientRect().bottom,
      // The action and the alternative to it belong together: the bar's own
      // home-indicator padding used to open a 34px hole between them.
      gap: alt.top - bar.bottom,
    };
  });

  // The last entry on the screen ends above the band the home indicator sits
  // in - it is the entry that used to sit closest to it.
  expect(r.frame - r.resetBottom).toBeGreaterThanOrEqual(34);
  expect(r.gap).toBeLessThan(16);
});

test("the wipe still asks first, from its new place", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await lockNow(page);

  // Quiet and last is not the same as easy: the one irreversible entry on the
  // screen still goes through the sheet, and cancelling leaves the vault.
  await page.locator(".lock-reset button").click();
  await expect(page.locator(".sheet")).toBeVisible();
  await expect(page.locator(".sheet-title")).toHaveText("Start over?");
  await expect(page.getByRole("button", { name: "Delete on this device" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".lock-foot")).toBeVisible();
});

test("the settings offer the method as a sibling of About", async ({ page, context }) => {
  await freshApp(page);
  await setupVault(page);
  await page.getByRole("button", { name: "Settings" }).click();

  const link = page.locator("a.setrow");
  await expect(link).toHaveCount(1);
  await expect(link.locator(".setrow-label")).toHaveText("The method");
  await expect(link).toHaveAttribute("href", METHOD_PATH);
  await expect(link).toHaveAttribute("target", "_blank");

  // Directly under the About row, in the same group, wearing the same plate.
  const order = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".setrow")];
    const label = (n) => (n.querySelector(".setrow-label") || {}).textContent;
    const about = rows.findIndex((n) => label(n) === "About tenfold");
    const method = rows.findIndex((n) => label(n) === "The method");
    return { about, method, sameParent: rows[about].parentElement === rows[method].parentElement };
  });
  expect(order.method).toBe(order.about + 1);
  expect(order.sameParent).toBe(true);

  const opened = await Promise.all([context.waitForEvent("page"), link.click()]);
  const tab = opened[0];
  await tab.waitForLoadState();
  expect(tab.url()).toContain("/web/method.html");
  await tab.close();
});

test("inside the shell the settings row stays, at the public address", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await page.getByRole("button", { name: "Settings" }).click();

  // The tip jar is the contrast again: absent in the shell, where this row is
  // not, because a public document is not a payment.
  const link = page.locator("a.setrow");
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("href", METHOD_URL);
});

test("every surface names the document with the same string", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const i18n = await import("/web/js/i18n.js");
    const out = {};
    for (const locale of ["en", "de", "es"]) {
      i18n.setLocale(locale);
      out[locale] = i18n.t("about.method");
    }
    i18n.setLocale("en");
    return out;
  });
  // One key, four placements: the About line, the lock footer, the settings
  // row label, and whatever comes next.
  expect(r.en).toBe("The method");
  expect(r.de).toBe("Die Methode");
  expect(r.es).toBe("El método");

  const policy = await readFile(join(ROOT, "web", "js", "ui", "policy.js"), "utf8");
  const about = await readFile(join(ROOT, "web", "js", "ui", "about.js"), "utf8");
  const lock = await readFile(join(ROOT, "web", "js", "ui", "lock.js"), "utf8");
  const settings = await readFile(join(ROOT, "web", "js", "ui", "settings.js"), "utf8");
  // The key is written once, and the three screens pull it through policy.js.
  expect((policy.match(/about\.method/g) || []).length).toBe(1);
  for (const [name, src] of [["about", about], ["lock", lock], ["settings", settings]]) {
    expect(src, `${name} hard-codes the key`).not.toContain("about.method");
    expect(src, `${name} hard-codes an href`).not.toContain("method.html");
  }
});

test("the method link is named in all three catalogues", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const i18n = await import("/web/js/i18n.js");
    const out = {};
    for (const locale of ["en", "de", "es"]) {
      i18n.setLocale(locale);
      out[locale] = i18n.t("about.method");
    }
    i18n.setLocale("en");
    return out;
  });
  expect(r.en).toBe("The method");
  expect(r.de).toBe("Die Methode");
  expect(r.es).toBe("El método");
  for (const value of Object.values(r)) expect(value).not.toMatch(/^about\./);
});

// ----------------------------------------------------------- the questions

test("the new questions exist, in all three catalogues", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async (indices) => {
    const i18n = await import("/web/js/i18n.js");
    const q = await import("/web/js/questions.js");
    const out = { catalogue: q.QUESTIONS.length, text: {} };
    for (const locale of ["en", "de", "es"]) {
      i18n.setLocale(locale);
      out.text[locale] = indices.flatMap((i) => [i18n.t(`question.q${i}`), i18n.t(`question.l${i}`)]);
    }
    i18n.setLocale("en");
    // Every catalogue entry is a real pair of keys, not a gap.
    out.keys = q.QUESTIONS.map((entry) => `${entry.key}|${entry.label}`);
    return out;
  }, NEW_QUESTIONS);

  expect(r.catalogue).toBe(26);
  expect(new Set(r.keys).size).toBe(26);
  for (const locale of ["en", "de", "es"]) {
    for (const value of r.text[locale]) {
      // A missing key renders as the key itself.
      expect(value, `${locale}: ${value}`).not.toMatch(/^question\./);
      expect(value.length).toBeGreaterThan(3);
    }
  }
  // House style for the daily question: one sentence, and short enough to be
  // read in the card without wrapping into a paragraph.
  for (const value of r.text.en) expect(value.length).toBeLessThan(90);
});

test("the catalogues stay interchangeable after the additions", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const { keysOf, LOCALES } = await import("/web/js/i18n.js");
    return LOCALES.map((l) => keysOf(l).join("|"));
  });
  expect(new Set(r).size).toBe(1);
});

test("picking a question is still deterministic across the longer catalogue", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const q = await import("/web/js/questions.js");
    const day = "20260407";
    // Same day, same node, called repeatedly: one answer, and an index inside
    // the catalogue. Nothing is stored, so a second call cannot drift.
    const runs = Array.from({ length: 5 }, () => q.questionFor(day, "node-a"));
    return {
      keys: runs.map((x) => x.key),
      indices: runs.map((x) => x.index),
      other: q.questionFor(day, "node-b").key,
      nextDay: q.questionFor("20260408", "node-a").key,
      size: q.QUESTIONS.length,
    };
  });

  expect(new Set(r.keys).size).toBe(1);
  expect(new Set(r.indices).size).toBe(1);
  expect(r.indices[0]).toBeGreaterThanOrEqual(0);
  expect(r.indices[0]).toBeLessThan(r.size);
  // Different node and different day are different questions, which is the
  // whole point of hashing the pair rather than the date alone.
  expect(r.other).not.toBe(r.keys[0]);
  expect(r.nextDay).not.toBe(r.keys[0]);
});
