// The two public documents on a phone with a notch, and the way out of them.
//
// Both faults this file pins were reported from a real iPhone and neither was
// visible on a desktop, which is why they are measured here rather than
// looked at.
//
//   1. THE STATUS BAR SAT ON THE PAGE. privacy.html and method.html both carry
//      viewport-fit=cover, and both live inside the installed app's scope, so
//      opening one from About keeps the standalone window - whose viewport
//      extends under the clock and the battery. Neither page read
//      env(safe-area-inset-*), so the wordmark was under the time and the
//      language buttons under the battery. A headless browser has no notch, so
//      the insets are read through --sa-* custom properties that this file can
//      set: the rules have to REACT, which is the part a screenshot on a
//      desktop can never show.
//   2. THE PAGES WERE DEAD ENDS. The app opens them in a tab of their own (and
//      in Safari inside the native shell), so there is no back gesture that
//      leads anywhere. Two exits now, one at the top and one at the very
//      bottom - a document several thousand pixels long needs one at the end
//      too - and both point at the app root.
//
// The wording is deliberately "Back to tenfold" and not "back to the app": in
// the browser the link returns to the app, in Safari it opens it, and only the
// first phrasing is true in both.
import { test, expect } from "@playwright/test";

const PHONE = { width: 390, height: 844 };
/** The iPhone 14 Pro insets, as the numbers the rules are checked against. */
const NOTCH = { top: 47, bottom: 34 };
const PAGES = ["/method.html", "/privacy.html"];
/** The one destination: the app root, in whichever layout the page is served. */
const HOME = "./";

const LABELS = {
  en: "Back to tenfold",
  de: "Zurück zu tenfold",
  es: "Volver a tenfold",
};

/** Write the notch into the properties both pages read their insets through. */
async function wearTheNotch(page) {
  await page.evaluate((sa) => {
    const root = document.documentElement.style;
    root.setProperty("--sa-top", `${sa.top}px`);
    root.setProperty("--sa-bot", `${sa.bottom}px`);
    root.setProperty("--sa-left", "0px");
    root.setProperty("--sa-right", "0px");
  }, NOTCH);
}

// -------------------------------------------------------------- safe area

for (const path of PAGES) {
  test(`${path} keeps its header out of the status bar`, async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto(path);
    await page.waitForSelector(".langs button");

    // The meta really asks for the covered viewport - without it the inset is
    // reported as zero and every rule below is dead code on the device.
    const viewport = await page.getAttribute('meta[name="viewport"]', "content");
    expect(viewport).toContain("viewport-fit=cover");

    const insets = () =>
      page.evaluate(() => {
        const top = getComputedStyle(document.querySelector(".top"));
        const body = getComputedStyle(document.body);
        return {
          headerTop: parseFloat(top.paddingTop),
          bottom: parseFloat(body.paddingBottom),
          left: parseFloat(body.paddingLeft),
          right: parseFloat(body.paddingRight),
        };
      });

    // Flat first, then with the notch on: the padding has to FOLLOW the
    // insets, not merely be large enough by luck on one device. All four
    // sides, because a phone in landscape has two of them on the sides.
    const flat = await insets();
    await wearTheNotch(page);
    const notched = await insets();
    expect(notched.headerTop - flat.headerTop).toBeCloseTo(NOTCH.top, 1);
    expect(notched.bottom - flat.bottom).toBeCloseTo(NOTCH.bottom, 1);

    await page.evaluate(() => {
      document.documentElement.style.setProperty("--sa-left", "44px");
      document.documentElement.style.setProperty("--sa-right", "44px");
    });
    const sideways = await insets();
    expect(sideways.left - flat.left).toBeCloseTo(44, 1);
    expect(sideways.right - flat.right).toBeCloseTo(44, 1);
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--sa-left", "0px");
      document.documentElement.style.setProperty("--sa-right", "0px");
    });

    // Nothing the page draws reaches into the top 60px of a notched screen.
    // Measured over every element the header carries, not over the header box.
    const intruders = await page.evaluate(() => {
      const parts = [
        ...document.querySelectorAll(
          ".top .brand, .top .back, .langs button, main article:not([hidden]) h1",
        ),
      ];
      return parts
        .map((n) => {
          const r = n.getBoundingClientRect();
          return { text: (n.innerText || "").trim().slice(0, 24), top: r.top, height: r.height };
        })
        .filter((n) => n.height > 0 && n.top < 60);
    });
    expect(intruders).toEqual([]);

    // The strip the status bar is drawn on is opaque and exactly the inset
    // tall, so prose scrolling past it stays legible instead of sliding under
    // a translucent bar.
    const shield = await page.evaluate(() => {
      const n = document.querySelector(".shield");
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { top: r.top, height: r.height, bg: getComputedStyle(n).backgroundColor };
    });
    expect(shield).not.toBeNull();
    expect(shield.top).toBe(0);
    expect(shield.height).toBeCloseTo(NOTCH.top, 1);
    expect(shield.bg).not.toBe("rgba(0, 0, 0, 0)");

    // The toggle is still a toggle: full size, clear of the inset, and it
    // still switches the document.
    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll(".langs button")].map((n) => {
        const r = n.getBoundingClientRect();
        return { top: r.top, height: r.height, width: r.width };
      }),
    );
    expect(buttons.length).toBe(3);
    for (const b of buttons) {
      expect(b.top).toBeGreaterThanOrEqual(NOTCH.top);
      expect(b.height).toBeGreaterThanOrEqual(34);
      expect(b.width).toBeGreaterThanOrEqual(34);
    }
    await page.locator('.langs button[data-lang="de"]').click();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
  });
}

// ------------------------------------------------------------ the way back

for (const path of PAGES) {
  test(`${path} offers a way back at the top and at the end`, async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto(path);
    await page.waitForSelector(".langs button");

    const links = page.locator("a.back");
    await expect(links).toHaveCount(2);

    // Both point at the app root, and neither opens a third tab: this one is
    // a way back, so it replaces what is on screen.
    for (const which of ["top", "bottom"]) {
      const link = page.locator(`a.back[data-back="${which}"]`);
      await expect(link).toHaveCount(1);
      await expect(link).toHaveAttribute("href", HOME);
      expect(await link.getAttribute("target")).toBeNull();
      // innerText, not textContent: all three labels live in the anchor and
      // the two that are not current carry `hidden`, so only one is rendered
      // and only one reaches the accessibility tree.
      expect((await link.innerText()).trim()).toBe(LABELS.en);
    }

    // Where they stand: the first inside the header, the second at the very
    // end of the document rather than halfway down it.
    const place = await page.evaluate(() => {
      const top = document.querySelector('a.back[data-back="top"]');
      const bottom = document.querySelector('a.back[data-back="bottom"]');
      return {
        topInHeader: !!top.closest("header.top"),
        topAboveMain: top.getBoundingClientRect().top < document.querySelector("main").getBoundingClientRect().top,
        bottomOffset: bottom.getBoundingClientRect().bottom + window.scrollY,
        docHeight: document.body.scrollHeight,
        tapHeight: bottom.getBoundingClientRect().height,
      };
    });
    expect(place.topInHeader).toBe(true);
    expect(place.topAboveMain).toBe(true);
    expect(place.tapHeight).toBeGreaterThanOrEqual(34);
    // Within one screen of the bottom of a page that is many screens long.
    expect(place.docHeight - place.bottomOffset).toBeLessThan(PHONE.height);

    // It really goes home. index.html is what the app root serves.
    await page.locator('a.back[data-back="bottom"]').click();
    await page.waitForLoadState();
    expect(new URL(page.url()).pathname).not.toContain(path.slice(1));
    await expect(page.locator("#app")).toHaveCount(1);
  });

  test(`${path} names the way back in all three languages`, async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto(path);
    await page.waitForSelector(".langs button");

    for (const [code, label] of Object.entries(LABELS)) {
      await page.locator(`.langs button[data-lang="${code}"]`).click();
      const shown = await page.evaluate(() =>
        [...document.querySelectorAll("a.back")].map((n) => n.innerText.trim()),
      );
      expect(shown, code).toEqual([label, label]);
      // Exactly one label per link is on screen - the other two are hidden,
      // not merely invisible, so a screen reader reads one of them.
      const visible = await page.evaluate(() =>
        [...document.querySelectorAll("a.back [data-l]")].filter((n) => !n.hidden).length,
      );
      expect(visible, code).toBe(2);
    }
  });
}

test("the two documents carry the same header, still, after the fix", async ({ page }) => {
  // The pair rule: whatever one page's header does the other's does too, so a
  // fix to one can never quietly leave the other under the status bar.
  const shape = [];
  for (const path of PAGES) {
    await page.setViewportSize(PHONE);
    await page.goto(path);
    await page.waitForSelector(".langs button");
    await wearTheNotch(page);
    shape.push(
      await page.evaluate(() => {
        const top = getComputedStyle(document.querySelector(".top"));
        const body = getComputedStyle(document.body);
        return [
          top.paddingTop,
          top.paddingBottom,
          body.paddingLeft,
          body.paddingRight,
          getComputedStyle(document.querySelector(".shield")).height,
          document.querySelectorAll("a.back").length,
        ].join("|");
      }),
    );
  }
  expect(shape[0]).toBe(shape[1]);
});
