// tools/shots-support.mjs - the tip jar, as it actually stands on a phone.
//
//   PORT=7712 TENFOLD_DATA=/tmp/tenfold-shot-data node tools/serve.js &
//   BASE=http://127.0.0.1:7712 node tools/shots-support.mjs
//
// Writes design/screens/66-support-sheet.png at the reference iPhone size. The
// sheet is reached from the About screen, before any vault exists, which is
// also the proof that it needs nothing unlocked. Nothing is paid and nothing
// is opened: this is a picture of the offer.
// Not part of the test suite - this is for looking.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PHONE = { width: 390, height: 844 };

const browser = await chromium.launch();
const problems = [];

const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2 });
const page = await context.newPage();
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

await page.getByRole("button", { name: /What is this/ }).click();
await page.locator(".support-line").click();
await page.waitForSelector(".sheet-title");
await page.waitForTimeout(700);
// How much of the sheet the phone actually shows, printed rather than guessed:
// the picture is of the top, and the scroll below it is part of the honest
// answer to "how long is this thing".
const reach = await page.locator(".sheet-body").evaluate((n) => ({
  visible: n.clientHeight,
  total: n.scrollHeight,
}));
console.log(`sheet body: ${reach.visible}px visible of ${reach.total}px`);
await page.evaluate(() => {
  const el = document.getElementById("toast");
  if (el) el.remove();
});
await page.screenshot({ path: "design/screens/66-support-sheet.png" });
console.log("wrote 66-support-sheet");

await context.close();
console.log(problems.length ? problems : "no console problems");
await browser.close();
