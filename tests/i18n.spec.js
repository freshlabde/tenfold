// i18n: the three catalogues must stay interchangeable.
//
// English is the source of truth, so every key that exists in en must exist in
// de and es - and nothing beyond. The fallback chain [requested] -> en has to
// hold for an empty value as well as for a missing one, because a half
// finished translation pass leaves both.
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/fixture.html");
});

test("all locales carry exactly the same key set", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { keysOf, LOCALES } = await import("/web/js/i18n.js");
    const sets = {};
    for (const l of LOCALES) sets[l] = keysOf(l);
    return { locales: LOCALES, sets };
  });

  expect(r.locales).toEqual(["en", "de", "es"]);
  const en = r.sets.en;
  expect(en.length).toBeGreaterThan(100);
  for (const locale of r.locales) {
    const missing = en.filter((k) => !r.sets[locale].includes(k));
    const extra = r.sets[locale].filter((k) => !en.includes(k));
    expect(missing, `${locale} is missing keys`).toEqual([]);
    expect(extra, `${locale} has keys English does not have`).toEqual([]);
  }
});

test("no catalogue value contains markup or a stray placeholder", async ({ page }) => {
  const bad = await page.evaluate(async () => {
    const { LOCALES } = await import("/web/js/i18n.js");
    const mods = await Promise.all(LOCALES.map((l) => import(`/web/js/locales/${l}.js`)));
    const out = [];
    LOCALES.forEach((l, i) => {
      const cat = mods[i][l];
      for (const [k, v] of Object.entries(cat)) {
        if (typeof v !== "string") out.push(`${l}:${k} is not a string`);
        else if (/<[a-z/!]/i.test(v)) out.push(`${l}:${k} contains markup`);
        else if (/\{\s*\}/.test(v)) out.push(`${l}:${k} has an empty placeholder`);
      }
    });
    return out;
  });
  expect(bad).toEqual([]);
});

test("fallback: unknown locale, missing key and interpolation", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const i18n = await import("/web/js/i18n.js");
    const out = {};

    i18n.setLocale("de");
    out.deLocale = i18n.getLocale();

    // An unknown locale must not throw and must not leave the app stateless.
    i18n.setLocale("kl");
    out.unknownLocale = i18n.getLocale();

    i18n.setLocale("en");
    out.known = i18n.t("app.name");
    out.missing = i18n.t("this.key.does.not.exist");
    out.interpolated = i18n.t("outline.sub", { open: 3, total: 10 });
    out.unfilled = i18n.t("outline.sub", {});
    return out;
  });

  expect(r.deLocale).toBe("de");
  expect(r.unknownLocale).toBe("en");
  expect(r.known).toBe("tenfold");
  // A missing key returns the key itself: visible in the UI, not silently empty.
  expect(r.missing).toBe("this.key.does.not.exist");
  expect(r.interpolated).toContain("3");
  expect(r.interpolated).toContain("10");
  // An unfilled placeholder stays literal rather than turning into "undefined".
  expect(r.unfilled).toContain("{open}");
});

test("a locale with a missing key falls back to the English text", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const i18n = await import("/web/js/i18n.js");
    const de = (await import("/web/js/locales/de.js")).de;
    const en = (await import("/web/js/locales/en.js")).en;
    const key = "about.claim.p1";
    const backup = de[key];
    delete de[key];
    i18n.setLocale("de");
    const viaFallback = i18n.t(key);
    de[key] = "";
    const viaEmpty = i18n.t(key);
    de[key] = backup;
    i18n.setLocale("en");
    return { viaFallback, viaEmpty, english: en[key] };
  });
  expect(r.viaFallback).toBe(r.english);
  expect(r.viaEmpty).toBe(r.english);
});

test("detectLocale only ever returns a supported locale", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { detectLocale, LOCALES } = await import("/web/js/i18n.js");
    return { picked: detectLocale(), locales: LOCALES };
  });
  expect(r.locales).toContain(r.picked);
});

test("relative time speaks proper singulars in every locale", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const i18n = await import("/web/js/i18n.js");
    const { relativeTime } = await import("/web/js/ui/format.js");
    const MIN = 60 * 1000;
    const HOUR = 60 * MIN;
    const DAY = 24 * HOUR;
    const now = 1780000000000;
    const out = {};
    for (const loc of ["en", "de", "es"]) {
      i18n.setLocale(loc);
      out[loc] = {
        // Below two minutes "just now" answers, so the smallest minute figure
        // the template ever shows is 2 - the singular matters for hour and day.
        minute: relativeTime(now - 2.4 * MIN, now),
        hour: relativeTime(now - HOUR, now),
        day: relativeTime(now - DAY, now),
        days: relativeTime(now - 2 * DAY, now),
      };
    }
    i18n.setLocale("en");
    return out;
  });
  // German declines the noun - the case the {n} template got wrong ("vor 1
  // Tage"): singular units have keys of their own.
  expect(r.de).toEqual({ minute: "vor 2 Minuten", hour: "vor 1 Stunde", day: "vor 1 Tag", days: "vor 2 Tagen" });
  expect(r.en).toEqual({ minute: "2 minutes ago", hour: "1 hour ago", day: "1 day ago", days: "2 days ago" });
  expect(r.es).toEqual({ minute: "hace 2 minutos", hour: "hace 1 hora", day: "hace 1 día", days: "hace 2 días" });
});
