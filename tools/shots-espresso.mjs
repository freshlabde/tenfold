// tools/shots-espresso.mjs - the espresso question as a week-old vault gets it.
//
//   PORT=7712 TENFOLD_DATA=/tmp/tenfold-shot-data node tools/serve.js &
//   BASE=http://127.0.0.1:7712 node tools/shots-espresso.mjs
//
// Writes design/screens/68-espresso-hero.png at the reference iPhone size. The
// vault is created for real and then dated eight days back through the app's
// own setSettings - the same seam the spec uses - so this is the sheet as it
// arrives after an ordinary unlock, not a mock of it.
// Not part of the test suite - this is for looking.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";
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

// The first run, no server copy.
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
await page.waitForSelector(".h-title");

// A week of use, bought honestly: the vault's birthday moves, nothing else.
await page.evaluate(async () => {
  const { ctx } = await import("/web/js/app.js");
  ctx.seedTemplate(["Get the knee fixed", "Ship the first release", "Learn to sail"]);
  ctx.setSettings({ createdAt: Date.now() - 8 * 86400000 }, { now: true });
  await ctx.lock();
});
await page.waitForSelector(".lock-title");
await page.waitForTimeout(600);
await page.locator(".lock input").fill(PASS);
await page.locator(".lock input").press("Enter");

await page.waitForSelector(".sheet-title", { timeout: 60000 });
await page.waitForTimeout(700);
const reach = await page.locator(".sheet-body").evaluate((n) => ({
  visible: n.clientHeight,
  total: n.scrollHeight,
}));
console.log(`sheet body: ${reach.visible}px visible of ${reach.total}px`);
console.log(`title: ${await page.locator(".sheet-title").textContent()}`);
await page.evaluate(() => {
  const el = document.getElementById("toast");
  if (el) el.remove();
});
await page.screenshot({ path: "design/screens/68-espresso-hero.png" });
console.log("wrote 68-espresso-hero");

await context.close();
console.log(problems.length ? problems : "no console problems");
await browser.close();
