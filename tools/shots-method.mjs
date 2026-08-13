// tools/shots-method.mjs - the method page as it actually stands.
//
//   PORT=7712 TENFOLD_DATA=/tmp/tenfold-shot-data node tools/serve.js &
//   BASE=http://127.0.0.1:7712 node tools/shots-method.mjs
//
// Writes design/screens/77-method.png at the reference iPhone size, from the
// production path (/method.html), so the picture is of the page with the CSP a
// deployment really sends: a blocked inline style would be visible here as
// naked markup. All three toggles are exercised on the way, and English is what
// stays on screen.
// Not part of the test suite - this is for looking.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PHONE = { width: 390, height: 844 };

const browser = await chromium.launch();
const problems = [];

const context = await browser.newContext({
  viewport: PHONE,
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const page = await context.newPage();
page.on("pageerror", (e) => problems.push(`PAGEERROR ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`CONSOLE ${m.text()}`);
});

await page.goto(`${BASE}/method.html`);
await page.waitForSelector(".langs button");

for (const lang of ["de", "es", "en"]) {
  await page.locator(`.langs button[data-lang="${lang}"]`).click();
  const id = await page.evaluate(
    () => [...document.querySelectorAll("main article")].filter((a) => !a.hidden).map((a) => a.id)[0],
  );
  console.log(`${lang} -> ${id}`);
}

// How much of the document a phone shows without scrolling, printed rather
// than guessed: this document is long by nature and it is worth knowing where
// the fold falls.
const reach = await page.evaluate(() => ({
  visible: document.documentElement.clientHeight,
  total: document.body.scrollHeight,
}));
console.log(`page: ${reach.visible}px visible of ${reach.total}px`);

await page.waitForTimeout(200);
await page.screenshot({ path: "design/screens/77-method.png" });
console.log("wrote 77-method");

await context.close();
console.log(problems.length ? problems : "no console problems");
await browser.close();
