// The privacy policy: one public page, three languages, and the link into it.
//
// Three things are pinned here that a reading of the diff would not catch:
//
//   1. THE PAGE LOADS NOTHING. A policy that pulls in a stylesheet or a font is
//      a policy that can render naked and a page that phones somewhere while
//      telling you nobody is counting. The source is scanned for any foreign
//      origin at all, and the served CSP is asserted, because the app's strict
//      header would silently strip this page of its own inline style.
//   2. ALL THREE LANGUAGES STAND ON ONE URL, and the toggle really switches
//      them. Three files would have drifted apart the first time a server rule
//      changed; one file only helps if the switch works.
//   3. THE LINK IS THE MIRROR IMAGE OF THE TIP JAR. Both live at the foot of
//      the About screen, and their rules are opposite: the espresso line is
//      absent inside the native shell and during the first-run intro, the
//      policy link is present in every mode and in the intro too. The contrast
//      is asserted in one spec on purpose, so nobody can "fix" one of them into
//      the other's behaviour without a red test.
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
const POLICY_PATH = "./privacy.html";
const POLICY_URL = "https://tenfold.kairatools.com/privacy.html";

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
  const res = await request.get("/web/privacy.html");
  expect(res.status()).toBe(200);
  const html = await res.text();

  // One document per language, each marked with its own lang attribute.
  for (const lang of LANGS) {
    expect(html, `${lang} block`).toContain(`id="doc-${lang}" lang="${lang}"`);
  }

  // Who is speaking, and where to write. Once per language plus the footers.
  expect((html.match(/FRESHLAB IBERIA SL/g) || []).length).toBeGreaterThanOrEqual(6);
  expect((html.match(/info@freshlab\.es/g) || []).length).toBeGreaterThanOrEqual(6);
  expect(html).toContain("mailto:info@freshlab.es");

  // The date stamp, in each language's own way of writing it.
  expect(html).toContain("13 August 2026");
  expect(html).toContain("13. August 2026");
  expect(html).toContain("13 de agosto de 2026");

  // This is the one page in the project that SHOULD be indexed.
  expect(html).not.toMatch(/noindex/i);
  expect(res.headers()["x-robots-tag"]).toBeUndefined();
});

test("the policy loads nothing from anywhere", async () => {
  const html = await readFile(join(ROOT, "web", "privacy.html"), "utf8");

  // No foreign origin of any kind, in an attribute or in prose. The same rule
  // the entry document is held to.
  expect(html).not.toMatch(/https?:\/\//i);
  // Nothing that pulls a resource in: no stylesheet, no font, no image, no
  // script file, no import.
  expect(html).not.toMatch(/<link\b/i);
  expect(html).not.toMatch(/<img\b/i);
  expect(html).not.toMatch(/<iframe\b/i);
  expect(html).not.toMatch(/@import/i);
  expect(html).not.toMatch(/<script[^>]+src=/i);
  expect(html).not.toMatch(/url\(\s*["']?(?!data:)[a-z0-9./]/i);

  // The only href that leaves this page is the contact address; the only other
  // one is the way back into the app.
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) {
    expect(href === "./" || href.startsWith("mailto:"), `unexpected href ${href}`).toBe(true);
  }

  // No inline event attribute; the toggle is wired with addEventListener.
  expect(html.replace(/<!--[\s\S]*?-->/g, "")).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
});

test("the policy carries its own CSP and the app keeps the strict one", async ({ request }) => {
  // Served at the root, which is where a deployment serves it - and the only
  // path where the security headers apply at all.
  const policy = await request.get("/privacy.html");
  expect(policy.status()).toBe(200);
  const csp = policy.headers()["content-security-policy"];
  // Everything refused by default, its own two inline blocks allowed, and no
  // way to load anything: no connect-src, no img-src, no font-src.
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("style-src 'unsafe-inline'");
  expect(csp).toContain("script-src 'unsafe-inline'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("connect-src");

  // The app's own document is untouched by the exception above.
  const app = await request.get("/index.html");
  const appCsp = app.headers()["content-security-policy"];
  expect(appCsp).toContain("default-src 'self'");
  expect(appCsp).not.toContain("unsafe-inline");
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
  await page.goto("/privacy.html");

  // The inline style really applied: a blocked <style> would leave the body on
  // the browser default, and this page would ship as naked markup. Both
  // variants are pinned - the dark voice the app speaks in, and the light one
  // a system preference switches to.
  const body = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await body()).toBe("rgb(15, 17, 21)");
  await page.emulateMedia({ colorScheme: "light" });
  expect(await body()).toBe("rgb(228, 230, 234)");
  await page.emulateMedia({ colorScheme: "dark" });

  for (const lang of LANGS) {
    await page.locator(`.langs button[data-lang="${lang}"]`).click();

    // Exactly one document on screen, and it is the one that was asked for.
    const visible = await page.evaluate(() =>
      [...document.querySelectorAll("main article")]
        .filter((a) => !a.hidden)
        .map((a) => a.id),
    );
    expect(visible).toEqual([`doc-${lang}`]);

    // The page says which language it is in, for a screen reader and for a
    // search engine alike.
    await expect(page.locator("html")).toHaveAttribute("lang", lang);
    await expect(page.locator(`.langs button[data-lang="${lang}"]`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const pressed = await page.locator('.langs button[aria-pressed="true"]').count();
    expect(pressed).toBe(1);
    // The address carries the choice, so a link can point at one language.
    expect(new URL(page.url()).searchParams.get("lang")).toBe(lang);
  }

  // The headings that must exist in every language, whatever else changes.
  await page.locator('.langs button[data-lang="es"]').click();
  await expect(page.locator("#doc-es")).toContainText("FRESHLAB IBERIA SL");
  await expect(page.locator("#doc-es")).toContainText("RGPD");
  await page.locator('.langs button[data-lang="de"]').click();
  await expect(page.locator("#doc-de")).toContainText("DSGVO");
  await page.locator('.langs button[data-lang="en"]').click();
  await expect(page.locator("#doc-en")).toContainText("GDPR");

  expect(problems).toEqual([]);
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
    await page.goto("/privacy.html");
    const visible = await page.evaluate(() =>
      [...document.querySelectorAll("main article")].filter((a) => !a.hidden).map((a) => a.id),
    );
    expect(visible, locale).toEqual([expected]);
    await context.close();
  }
});

// -------------------------------------------------------------- and the link

test("the About screen links the policy in both modes, where the tip jar exists in one", async ({
  page,
  context,
}) => {
  // The browser. Both lines stand, the policy above the espresso.
  await freshApp(page);
  await page.getByRole("button", { name: /What is this/ }).click();

  const link = page.locator("a.policy-line");
  await expect(link).toHaveCount(1);
  await expect(link).toHaveText("Privacy policy");
  await expect(link).toHaveAttribute("href", POLICY_PATH);
  await expect(link).toHaveAttribute("target", "_blank");
  const rel = await link.getAttribute("rel");
  expect(rel).toContain("noopener");
  expect(rel).toContain("noreferrer");
  await expect(page.locator(".support-line")).toHaveCount(1);

  // Order: after the claim, and immediately above the tip jar.
  const order = await page.evaluate(() => {
    const kids = [...document.querySelector(".prose").children];
    return {
      claim: kids.findIndex((n) => n.classList.contains("claim")),
      policy: kids.findIndex((n) => n.classList.contains("policy-line")),
      support: kids.findIndex((n) => n.classList.contains("support-line")),
      last: kids.length - 1,
    };
  });
  expect(order.policy).toBe(order.claim + 1);
  expect(order.support).toBe(order.policy + 1);
  expect(order.support).toBe(order.last);

  // It opens the page, in a tab of its own.
  const opened = await Promise.all([context.waitForEvent("page"), link.click()]);
  const tab = opened[0];
  await tab.waitForLoadState();
  expect(tab.url()).toContain("/web/privacy.html");
  await expect(tab.locator("#doc-en h1")).toHaveText("Privacy policy");
  await tab.close();
});

test("inside the shell the policy link stays and points at the public page", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await page.getByRole("button", { name: /What is this/ }).click();

  // The opposite rule to the tip jar: the payment line is gone, the policy
  // link is not. An absolute address, because a same-origin target="_blank"
  // is inert in the shell - the navigation policy allows it and the UI
  // delegate then refuses the second web view, so the tap does nothing.
  await expect(page.locator(".support-line")).toHaveCount(0);
  const link = page.locator("a.policy-line");
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("href", POLICY_URL);
  await expect(link).toHaveAttribute("target", "_blank");

  // The two strings live in exactly one module.
  const source = await readFile(join(ROOT, "web", "js", "ui", "policy.js"), "utf8");
  expect(source).toContain(POLICY_URL);
  expect(source).toContain(POLICY_PATH);
});

test("the intro shows the policy link where it deliberately shows no tip jar", async ({ page }) => {
  await freshApp(page);
  // The first-run intro is the About screen with a Begin button. Somebody is
  // deciding whether to trust this app with their goals: not the moment to ask
  // for money, exactly the moment to offer the policy.
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
  await expect(page.locator("a.policy-line")).toHaveCount(1);
});

test("the link is named in all three catalogues", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const i18n = await import("/web/js/i18n.js");
    const out = {};
    for (const locale of ["en", "de", "es"]) {
      i18n.setLocale(locale);
      out[locale] = i18n.t("about.policy");
    }
    i18n.setLocale("en");
    return out;
  });
  expect(r.en).toBe("Privacy policy");
  expect(r.de).toBe("Datenschutz");
  expect(r.es).toBe("Privacidad");
  // A missing key renders as the key itself.
  for (const value of Object.values(r)) expect(value).not.toMatch(/^about\./);
});

test("the service worker does not precache the policy", async () => {
  // Deliberate: the shell list is what the app needs to open without a
  // network. A policy is a public document that has to be current, and a
  // cached policy is a stale policy.
  const sw = await readFile(join(ROOT, "web", "sw.js"), "utf8");
  expect(sw).not.toContain("privacy.html");
});
