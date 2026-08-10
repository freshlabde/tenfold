// tools/shots-swipe-delete.mjs - the left swipe, caught mid-drag.
//
//   PORT=7712 TENFOLD_DATA=/tmp/tenfold-shot-data node tools/serve.js &
//   BASE=http://127.0.0.1:7712 node tools/shots-swipe-delete.mjs
//
// Writes design/screens/57-swipe-delete.png at the reference iPhone size: a row
// pulled left, the trash affordance lit on the right edge in the danger
// register, the row underneath it still legible. The pointer is held down while
// the shot is taken and released past nothing - the browser is closed instead,
// so the shot never commits the deletion it is illustrating.
// Not part of the test suite - this is for looking.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";
const TITLES = [
  "Pay off the remaining debt",
  "Make the company sellable",
  "Run ten kilometres again",
  "Sort things out with Anna",
  "See my father regularly",
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const problems = [];
page.on("pageerror", (e) => problems.push(`PAGEERROR ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`CONSOLE ${m.text()}`);
});

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
await page.getByRole("button", { name: "Not now" }).click();
await page.getByRole("button", { name: "Begin" }).click();

// --- a list worth swiping in ------------------------------------------------
await page.getByRole("button", { name: /Write the first one|New entry/ }).click();
for (const title of TITLES) {
  await page.locator(".composer input").fill(title);
  await page.locator(".composer input").press("Enter");
}
await page.locator(".composer input").press("Escape");
await page.waitForTimeout(500);
await page.evaluate(() => {
  const t = document.getElementById("toast");
  if (t) t.remove();
});

// --- hold a row mid-pull ----------------------------------------------------
const shell = page.locator(".row-shell").nth(2);
const box = await shell.locator(".row").boundingBox();
const y = box.y + box.height / 2;
const x = box.x + box.width - 40;
// Just past the commit distance: the affordance is fully up, which is the
// moment the gesture is worth showing.
await page.mouse.move(x, y);
await page.mouse.down();
await page.mouse.move(x - 50, y, { steps: 8 });
await page.mouse.move(x - 104, y, { steps: 8 });
await page.waitForTimeout(120);

await page.screenshot({ path: "design/screens/57-swipe-delete.png" });
console.log("wrote 57-swipe-delete");

console.log(problems.length ? problems : "no console problems");
await browser.close();
