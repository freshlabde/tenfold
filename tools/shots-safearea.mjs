// tools/shots-safearea.mjs - the two pictures the safe-area fix is judged on.
//
//   PORT=7712 TENFOLD_DATA=/tmp/tenfold-shot-data node tools/serve.js &
//   BASE=http://127.0.0.1:7712 node tools/shots-safearea.mjs
//   BASE=http://127.0.0.1:7712 SUFFIX=-before node tools/shots-safearea.mjs
//
// Writes design/screens/78-method-safearea.png (the top of the method page on
// a notched viewport) and 79-lock-foot.png (the foot of the lock screen), both
// at the reference iPhone size.
//
// A headless browser has no notch, so env(safe-area-inset-*) is 0 everywhere
// and the bug would be invisible in a screenshot. Both pages read their insets
// through the --sa-* custom properties, which CAN be set from outside, so the
// notch is simulated by writing 47px/34px into them - the iPhone 14 Pro values
// - and drawing the status bar and home indicator on top as an overlay. The
// overlay is a picture of the hardware, not part of either page.
// Not part of the test suite - this is for looking.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const SUFFIX = process.env.SUFFIX || "";
const PHONE = { width: 390, height: 844 };
const TOP = 47;
const BOTTOM = 34;

const CHROME = `
  (function () {
    var css = document.createElement("style");
    css.textContent = ":root{--sa-top:${TOP}px;--sa-bot:${BOTTOM}px}" +
      "#hw-top{position:fixed;left:0;right:0;top:0;height:${TOP}px;z-index:9999;" +
      "display:flex;align-items:center;justify-content:space-between;" +
      "padding:0 30px 0 34px;pointer-events:none;" +
      "font:600 15px/1 -apple-system,system-ui,sans-serif;color:#fff;" +
      "text-shadow:0 0 3px rgba(0,0,0,.55)}" +
      "#hw-bot{position:fixed;left:50%;transform:translateX(-50%);bottom:8px;" +
      "width:140px;height:5px;border-radius:3px;background:#fff;opacity:.85;z-index:9999;pointer-events:none}";
    document.head.appendChild(css);
    var top = document.createElement("div");
    top.id = "hw-top";
    top.innerHTML = "<span>9:41</span><span>" +
      String.fromCharCode(0x25CF) + " " + String.fromCharCode(0x25AE) + String.fromCharCode(0x25AE) +
      String.fromCharCode(0x25AE) + "</span>";
    document.body.appendChild(top);
    var bot = document.createElement("div");
    bot.id = "hw-bot";
    document.body.appendChild(bot);
  })();
`;

const browser = await chromium.launch();
const problems = [];

async function shot(name, prepare) {
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
  await prepare(page);
  await page.evaluate(CHROME);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `design/screens/${name}${SUFFIX}.png` });
  console.log(`wrote ${name}${SUFFIX}`);
  await context.close();
}

// -------------------------------------------------- 78: the method page top

await shot("78-method-safearea", async (page) => {
  await page.goto(`${BASE}/method.html`);
  await page.waitForSelector(".langs button");
  await page.locator('.langs button[data-lang="en"]').click();
  await page.evaluate(() => window.scrollTo(0, 0));
});

// ------------------------------------------------- 79: the lock screen foot

const PASS = "correct horse battery staple";

await shot("79-lock-foot", async (page) => {
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

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /Lock now/ }).click();
  await page.waitForSelector(".lock-foot");
  // The "Locked." toast sits across the foot for its eight seconds; this
  // picture is of the foot, so it waits the toast out rather than shooting
  // through it.
  await page.waitForSelector(".toast.is-open", { state: "detached", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(9000);
});

console.log(problems.length ? problems : "no console problems");
await browser.close();
