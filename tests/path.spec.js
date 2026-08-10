// The whole path, and the colour of a due date.
//
// Two owner reports from the phone are pinned here. First: a step named "M&V"
// three levels down said nothing on the daily question card, so the card and
// the Today rows now carry the complete chain, root goal first, and a root goal
// carries none. Second: the start screen said nothing at all about overdue
// steps while the icon already counted them - so the outline gets one quiet
// line, and the due phrase on a row is no longer the same grey as the rest.
// The singular of that phrase ("1 Tage überfällig") was wrong in all three
// languages and is pinned here too.
import { test, expect } from "@playwright/test";

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };
const DAY = 86400000;

test.describe.configure({ mode: "parallel", timeout: 240_000 });

// ------------------------------------------------------------------ helpers

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

/** Hang `titles` under the node with that title, through the normal mutate path. */
async function addUnder(page, parentTitle, titles) {
  await page.evaluate(
    async ({ parentTitle: parent, titles: kids }) => {
      const { ctx } = await import("/web/js/app.js");
      const node = ctx.doc.nodes.find((n) => n.title === parent && !n.deletedAt);
      ctx.addChildren(
        node.id,
        kids.map((title) => ({ title })),
      );
    },
    { parentTitle, titles },
  );
}

/** A story on a node - enough to keep it away from the daily question. */
async function tellStory(page, titles) {
  await page.evaluate(async (list) => {
    const { ctx } = await import("/web/js/app.js");
    for (const title of list) {
      const node = ctx.doc.nodes.find((n) => n.title === title && !n.deletedAt);
      ctx.updateNode(node.id, { story: "Something already written down about this." });
    }
  }, titles);
}

/** Due date in whole days from today; negative is overdue. */
async function setDue(page, title, offsetDays) {
  await page.evaluate(
    async ({ title: wanted, offsetDays: offset }) => {
      const { ctx } = await import("/web/js/app.js");
      const node = ctx.doc.nodes.find((n) => n.title === wanted && !n.deletedAt);
      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      ctx.updateNode(node.id, { due: noon.getTime() + offset * 86400000 });
    },
    { title, offsetDays },
  );
}

/**
 * What `color: var(--accent)` computes to on this page right now. The accent is
 * a token per skin and theme, so the test asks the browser instead of hardcoding
 * a hex that would be wrong in five of the six combinations.
 */
const accentColor = (page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });

const colorOf = (page, selector) =>
  page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).color, selector);

// -------------------------------------------------------- the path on a card

test("the question card names the whole path a deep step hangs in", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Huerta con kayra"]);
  await addUnder(page, "Huerta con kayra", ["Little tasks"]);
  await addUnder(page, "Little tasks", ["M&V"]);
  // Everything above the deep step has a story, so the thinnest node - the one
  // the question is asked about - is the one three levels down.
  await tellStory(page, ["Huerta con kayra", "Little tasks"]);

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.locator(".h-title")).toHaveText("Today");

  await expect(page.locator(".qcard-node")).toHaveText("M&V");
  // Root goal first, the breadcrumb caret between, nothing left out.
  await expect(page.locator(".qcard-path")).toHaveText("Huerta con kayra › Little tasks");
});

test("a root goal on the question card carries no path line", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail properly"]);

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.locator(".qcard-node")).toHaveText("Learn to sail properly");
  // Not empty, not a stray separator: absent.
  await expect(page.locator(".qcard-path")).toHaveCount(0);
});

// ------------------------------------------------- the path and colour on a row

test("a Today row carries the whole chain and says overdue in colour", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Huerta con kayra"]);
  await addUnder(page, "Huerta con kayra", ["Little tasks"]);
  await addUnder(page, "Little tasks", ["M&V"]);
  await setDue(page, "M&V", -1);

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.locator(".row-title")).toHaveText(["M&V"]);

  // The sub-line: the complete path, then the state of the date - and the
  // singular that the phrase used to get wrong.
  await expect(page.locator(".row-sub")).toHaveText("Huerta con kayra › Little tasks · 1 day overdue");
  await expect(page.locator(".row-path")).toHaveText("Huerta con kayra › Little tasks");
  await expect(page.locator(".row-due")).toHaveText("1 day overdue");
  await expect(page.locator(".row-due")).toHaveClass(/is-overdue/);

  // And it is actually visible as a warning: the accent, not the muted grey
  // the path beside it is set in.
  const accent = await accentColor(page);
  expect(await colorOf(page, ".row-due")).toBe(accent);
  expect(await colorOf(page, ".row-path")).not.toBe(accent);
});

test("a step due today is marked as well, in the same register", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Ship the thing"]);
  await addUnder(page, "Ship the thing", ["Tag the build"]);
  await setDue(page, "Tag the build", 0);

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.locator(".row-due")).toHaveText("today");
  await expect(page.locator(".row-due")).toHaveClass(/is-today/);
  // Pulled back from the accent, but not the ordinary grey of the line either.
  const due = await colorOf(page, ".row-due");
  const sub = await page.evaluate(() => getComputedStyle(document.querySelector(".row-sub")).color);
  expect(due).not.toBe(sub);
});

test("one day late is singular in all three languages", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const said = await page.evaluate(async () => {
    const { dueLabel } = await import("/web/js/ui/format.js");
    const { setLocale } = await import("/web/js/i18n.js");
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    const now = noon.getTime();
    const out = {};
    for (const locale of ["en", "de", "es"]) {
      setLocale(locale);
      out[locale] = {
        one: dueLabel(now - 86400000, now),
        two: dueLabel(now - 2 * 86400000, now),
      };
    }
    setLocale("en");
    return out;
  });

  expect(said.en.one).toBe("1 day overdue");
  expect(said.de.one).toBe("1 Tag überfällig");
  expect(said.es.one).toBe("1 día de retraso");
  // The plural is untouched - this is a singular fix, not a rewording.
  expect(said.en.two).toBe("2 days overdue");
  expect(said.de.two).toBe("2 Tage überfällig");
  expect(said.es.two).toBe("2 días de retraso");
});

// ------------------------------------------------------- the hint on the outline

test("the outline says what is overdue and leads to Today", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Huerta con kayra"]);
  await addUnder(page, "Huerta con kayra", ["Water the beds", "Order the seeds", "Fix the hose"]);
  await setDue(page, "Water the beds", -3);
  await setDue(page, "Order the seeds", 0);
  await setDue(page, "Fix the hose", 0);

  await expect(page.locator(".h-title")).toHaveText("The Ten");
  // Both groups, each with its own count, on one line.
  await expect(page.locator(".duehint")).toHaveText("1 step overdue · 2 due today");

  // The same number the icon carries - one rule, two readings.
  const counts = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const { dueCounts, dueNowCount } = await import("/web/js/model.js");
    const now = Date.now();
    return { split: dueCounts(ctx.doc.nodes, { now }), total: dueNowCount(ctx.doc.nodes, { now }) };
  });
  expect(counts.split).toEqual({ overdue: 1, today: 2, total: 3 });
  expect(counts.total).toBe(3);

  // It is the way into the short list, the same route the header button takes.
  await page.locator(".duehint").click();
  await expect(page.locator(".h-title")).toHaveText("Today");
});

test("with nothing due the hint is not in the DOM at all", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Huerta con kayra"]);
  await addUnder(page, "Huerta con kayra", ["Water the beds"]);

  await expect(page.locator(".row-title").first()).toHaveText("Huerta con kayra");
  await expect(page.locator(".duehint")).toHaveCount(0);

  // A date in the future is not "now" either.
  await setDue(page, "Water the beds", 5);
  await expect(page.locator(".row-title").first()).toHaveText("Huerta con kayra");
  await expect(page.locator(".duehint")).toHaveCount(0);

  // And when it comes due, the line appears without a reload.
  await setDue(page, "Water the beds", -1);
  await expect(page.locator(".duehint")).toHaveText("1 step overdue");
});
