// tools/shots-readme.mjs - the four images the README table shows, in one run,
// from one seeded vault, so they can never drift apart from each other.
//
//   node tools/serve.js &
//   node tools/shots-readme.mjs
//
// Writes, at the reference iPhone size (390x844 CSS px, 2x device pixels):
//   design/screens/05-outline-filled.png   the ten, with the three importance
//                                          bands and the three-control bar
//   design/screens/06-focus.png            one goal broken into its parts
//   design/screens/09-duel.png             one comparison of the ordering duel
//   design/screens/63-readme-mindmap.png   the whole tree as the mind map, the
//                                          map screen's default reading
//
// The first three names are the ones tools/screenshots.mjs also writes; both
// tools drive the real app against the same demo goals, so re-running either
// produces the current UI. Not part of the test suite - this is for looking.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

const ROOTS = [
  "Pay off the remaining debt",
  "Make the company sellable",
  "Run ten kilometres again",
  "Sort things out with Anna",
  "See my father regularly",
  "A back that stops hurting",
  "Spanish up to B2",
  "Will and provisions settled",
  "Finish the workshop",
  "Less screen time in the evening",
];
// Parts under "Run ten kilometres again" (the focus shot) and under two more
// goals, so the mind map has something to draw: a tree with one branch is a
// list with extra lines.
const PARTS = [
  "Build a base: three times a week, thirty minutes",
  "Stabilise the knee",
  "Buy shoes after a gait analysis",
  "Enter the ten kilometres in September",
];
const BRANCHES = [
  [0, ["Talk to the bank", "One extra payment a month"]],
  [3, ["Call my father on Sundays", "A weekend away together"]],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: PHONE, deviceScaleFactor: 2 });
const problems = [];
page.on("pageerror", (e) => problems.push(`PAGEERROR ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`CONSOLE ${m.text()}`);
});

const shot = async (name) => {
  await page.waitForTimeout(500);
  // A toast from the previous step is not part of the screen being shown.
  await page.evaluate(() => document.getElementById("toast")?.remove());
  await page.screenshot({ path: `design/screens/${name}.png` });
  console.log("wrote", name);
};
const compose = async (titles) => {
  for (const title of titles) {
    await page.locator(".composer input").fill(title);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
};

// --- a fresh vault ----------------------------------------------------------
await page.goto(`${BASE}/web/index.html`);
await page.evaluate(
  () =>
    new Promise((done) => {
      localStorage.clear();
      const req = indexedDB.deleteDatabase("tenfold");
      req.onsuccess = req.onerror = req.onblocked = () => done();
    }),
);
await page.reload();
await page.getByRole("button", { name: "Set up the vault" }).click();
await page.locator('input[type="password"]').first().fill(PASS);
await page.locator('input[type="password"]').nth(1).fill(PASS);
await page.getByRole("button", { name: /Create the vault/ }).click();
await page.waitForSelector(".keygrid", { timeout: 60000 });
await page.locator(".check").click();
await page.getByRole("button", { name: "Continue" }).click();
await page.getByRole("button", { name: /Start empty/ }).click();
// The backup question is the last setup step; this run declines it, so the
// outline carries the "only in this browser" clause the app really shows.
await page.getByRole("button", { name: "Not now", exact: true }).click();
await page.getByRole("button", { name: "Begin" }).click();
await page.waitForSelector(".head");

// --- the ten ----------------------------------------------------------------
await page.getByRole("button", { name: /Write the first one/ }).click();
await compose(ROOTS);
await shot("05-outline-filled");

// --- one goal, broken down --------------------------------------------------
await page.locator(".row-shell").nth(2).locator(".row").click();
await page.getByRole("button", { name: /Add the first part/ }).click();
await compose(PARTS);
await shot("06-focus");
await page.locator(".crumb-pill").first().click();

for (const [index, parts] of BRANCHES) {
  await page.locator(".row-shell").nth(index).locator(".row").click();
  await page.getByRole("button", { name: /Add the first part/ }).click();
  await compose(parts);
  await page.locator(".crumb-pill").first().click();
}

// --- the duel ---------------------------------------------------------------
await page.getByRole("button", { name: "Put in order" }).click();
await page.waitForSelector(".duel-card");
await shot("09-duel");
await page.getByRole("button", { name: /Stop and keep/ }).click();
await page.waitForSelector(".head");

// --- the map, in its default reading: the mind map --------------------------
await page.getByRole("button", { name: "Open the map" }).click();
await page.waitForSelector(".mm-tree.is-ready", { timeout: 30000 });
await page.waitForTimeout(900);
await shot("63-readme-mindmap");

console.log(problems.length ? `PROBLEMS: ${problems.join(" | ")}` : "no console errors");
await browser.close();
