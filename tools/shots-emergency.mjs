// tools/shots-emergency.mjs - the emergency sheet as it comes out of a printer.
//
//   node tools/serve.js &
//   node tools/shots-emergency.mjs [tag]
//
// Walks the first run to the recovery-key step, presses "Save the emergency
// sheet" with window.print() stubbed, then switches the page to print media so
// the region becomes the only thing on it. Writes
// design/screens/42-emergency-sheet.png. Not part of the test suite - this is
// for looking at the page before anybody prints one.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";
const TAG = process.argv[2] || "";
const NAME = TAG ? `${TAG}-emergency-sheet` : "42-emergency-sheet";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 820, height: 1240 }, deviceScaleFactor: 2 });
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

// The print dialog would block a headless run for ever; the region is what we
// came for, and it is built before print() is called.
await page.addInitScript(() => {
  window.print = () => {};
});
await page.evaluate(() => {
  window.print = () => {};
});

await page.getByRole("button", { name: "Set up the vault" }).click();
await page.locator('input[type="password"]').first().fill(PASS);
await page.locator('input[type="password"]').nth(1).fill(PASS);
await page.getByRole("button", { name: /Create the vault/ }).click();
await page.waitForSelector(".keygrid", { timeout: 60000 });
await page.getByRole("button", { name: "Save the emergency sheet" }).click();
await page.waitForSelector("#paper", { state: "attached" });

// Print media makes the app disappear and the sheet appear; the padding stands
// in for the 18mm page margin, which @page owns and a screenshot cannot see.
await page.emulateMedia({ media: "print" });
await page.addStyleTag({ content: "body { padding: 18mm; background: #fff; }" });
await page.waitForTimeout(250);
await page.screenshot({ path: `design/screens/${NAME}.png`, fullPage: true });
console.log("wrote", NAME);

console.log(problems.length ? problems : "no console problems");
await browser.close();
