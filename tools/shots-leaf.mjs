// tools/shots-leaf.mjs - the leaf screen in its three real states.
//
//   node tools/serve.js &
//   node tools/shots-leaf.mjs [tag]
//
// Writes design/screens/35-leaf-empty-<skin>[-light].png, 36-leaf-full-... and
// 37-leaf-done-... at the reference iPhone size. A tag argument prefixes the
// names instead (`node tools/shots-leaf.mjs before`), which is how a redesign
// gets a pair to argue with. Not part of the test suite - this is for looking.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";
const TAG = process.argv[2] || "";
// dark is the default look, so it carries the plain name; light is the variant.
const name = (state, skin, theme) =>
  `${TAG ? `${TAG}-` : `${{ empty: 35, full: 36, done: 37 }[state]}-`}leaf-${state}-${skin}${
    theme === "light" ? "-light" : ""
  }`;
const SHOTS = [
  ["slate", "dark"],
  ["register", "dark"],
  ["breath", "dark"],
  ["slate", "light"],
  ["register", "light"],
];

const STORY = `Why it matters: my knee gives out after four kilometres and I stop running for weeks afterwards.
What I tried: new shoes, less mileage, an app that counts cadence. None of it held.
What blocks me: I book nothing because the practice only answers before nine.
Done when: I have run thirty minutes three times in one week without pain.`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const problems = [];
page.on("pageerror", (e) => problems.push(`PAGEERROR ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`CONSOLE ${m.text()}`);
});

const shot = async (name) => {
  await page.waitForTimeout(320);
  await page.evaluate(() => { const t = document.getElementById("toast"); if (t) t.remove(); });
  await page.screenshot({ path: `design/screens/${name}.png` });
  console.log("wrote", name);
};

const setSkin = async (skin, theme) => {
  await page.evaluate(
    ([s, th]) => {
      document.documentElement.setAttribute("data-skin", s);
      document.documentElement.setAttribute("data-theme", th);
    },
    [skin, theme],
  );
};

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
await page.waitForSelector(".screen");

// --- vault ------------------------------------------------------------------
await page.getByRole("button", { name: "Set up the vault" }).click();
await page.locator('input[type="password"]').first().fill(PASS);
await page.locator('input[type="password"]').nth(1).fill(PASS);
await page.getByRole("button", { name: /Create the vault/ }).click();
await page.waitForSelector(".keygrid", { timeout: 60000 });
await page.locator(".check").click();
await page.getByRole("button", { name: "Continue" }).click();
await page.getByRole("button", { name: /Start empty/ }).click();
await page.getByRole("button", { name: "Begin" }).click();

// --- a goal with two steps --------------------------------------------------
await page.getByRole("button", { name: /Write the first one|New entry/ }).click();
await page.locator(".composer input").fill("Run ten kilometres again");
await page.locator(".composer input").press("Enter");
await page.locator(".composer input").press("Escape");
await page.locator(".row-shell").first().locator(".row").click();
await page.getByRole("button", { name: /Add the first part/ }).click();
for (const p of ["Book the physio for the knee", "Buy shoes after a gait analysis"]) {
  await page.locator(".composer input").fill(p);
  await page.locator(".composer input").press("Enter");
}
await page.locator(".composer input").press("Escape");

// --- state 1: a step with nothing on it -------------------------------------
await page.locator(".list.is-kids .row-shell").first().locator(".row").click();
for (const [skin, theme] of SHOTS) {
  await setSkin(skin, theme);
  await shot(name("empty", skin, theme));
}
await setSkin("slate", "dark");

// --- state 2: everything filled ---------------------------------------------
await page.getByRole("button", { name: "Edit", exact: true }).click();
await page.locator(".sheet .textarea").nth(0).fill(STORY);
await page.locator(".sheet .textarea").nth(1).fill(
  "The practice only answers between eight and nine. Ask for Dr. Reiter, she knows the history.",
);
await page.locator(".sheet .textarea").nth(2).fill("The appointment is in the calendar and confirmed by mail.");
await page.locator('.sheet input[type="date"]').fill("2026-09-18");
await page.locator('.sheet input[type="number"]').fill("25");
await page.getByRole("button", { name: "Save" }).click();
await page.waitForTimeout(400);

// a linked card, so the chips row is populated
await page.getByRole("button", { name: /Link a card/ }).click();
await page.waitForTimeout(200);
const add = page.getByRole("button", { name: /Write the first one|New card|Add/ }).first();
if (await add.count()) await add.click();
await page.waitForTimeout(200);
if (await page.locator(".sheet .input").count()) {
  await page.locator(".sheet .input").first().fill("Dr. Reiter");
  const save = page.getByRole("button", { name: "Save" });
  if (await save.count()) await save.click();
}
await page.waitForTimeout(400);
// back to the leaf if a sheet or another screen took over
if (!(await page.locator(".leaf-title").count())) {
  await page.goBack();
  await page.waitForTimeout(300);
}

for (const [skin, theme] of SHOTS) {
  await setSkin(skin, theme);
  await shot(name("full", skin, theme));
}
await setSkin("slate", "dark");

// --- state 3: done ----------------------------------------------------------
if (await page.getByRole("button", { name: "Mark as done" }).count()) {
  await page.getByRole("button", { name: "Mark as done" }).click();
  await page.waitForTimeout(500);
  for (const [skin, theme] of [["slate", "dark"], ["register", "dark"]]) {
    await setSkin(skin, theme);
    await shot(name("done", skin, theme));
  }
}

console.log(problems.length ? problems : "no console problems");
await browser.close();
