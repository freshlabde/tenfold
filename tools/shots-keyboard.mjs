// tools/shots-keyboard.mjs - the sheet, above the keyboard.
//
//   PORT=7713 TENFOLD_DATA=/tmp/tenfold-shot-data node tools/serve.js &
//   BASE=http://127.0.0.1:7713 node tools/shots-keyboard.mjs
//
// Writes design/screens/74-sheet-above-keyboard.png at the reference iPhone
// size: the story guide open on its first question, with a keyboard standing
// where an iPhone would put it.
//
// The keyboard is DRAWN, and the drawing is the honest part of this picture.
// No desktop browser raises a software keyboard, so the visual viewport is
// mocked the way the spec mocks it - the sheet is lifted by the app's own code
// reacting to a real resize event - and a plate is then painted over the
// bottom 336 pixels so the picture shows what the phone would show. The lift
// is the app's; the keys are a prop.
// Not part of the test suite - this is for looking.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };
const KEYBOARD = 336;

const browser = await chromium.launch();
const problems = [];

const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2 });

await context.addInitScript(() => {
  const bus = new EventTarget();
  const vv = {
    height: 0,
    offsetTop: 0,
    offsetLeft: 0,
    pageTop: 0,
    pageLeft: 0,
    scale: 1,
    get width() {
      return window.innerWidth;
    },
    addEventListener: (...args) => bus.addEventListener(...args),
    removeEventListener: (...args) => bus.removeEventListener(...args),
    dispatchEvent: (ev) => bus.dispatchEvent(ev),
  };
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    get() {
      if (!vv.height) vv.height = window.innerHeight;
      return vv;
    },
  });
  window.__keyboard = {
    show(px) {
      vv.height = window.innerHeight - px;
      bus.dispatchEvent(new Event("resize"));
    },
  };
});

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

await page.getByRole("button", { name: /Write the first one|New entry/ }).click();
await page.locator(".composer input").fill("Spanish up to B2");
await page.locator(".composer input").press("Enter");
await page.locator(".composer input").press("Escape");
await page.locator(".row-shell").first().locator(".row").click();
await page.locator(".hero-card").click();
await page.waitForSelector(".leaf-title");

// The report, verbatim: "Click auf Tell the Story".
await page.getByRole("button", { name: "Tell the story" }).click();
await page.waitForSelector(".guide-q");
await page.locator(".sheet textarea").focus();
await page.locator(".sheet textarea").fill("Because the move is in September.");

await page.evaluate((px) => window.__keyboard.show(px), KEYBOARD);
await page.waitForTimeout(500);

const geometry = await page.evaluate((px) => {
  const sheet = document.querySelector(".sheet");
  const field = document.querySelector(".sheet textarea");
  return {
    lift: getComputedStyle(sheet).transform,
    sheetBottom: Math.round(sheet.getBoundingClientRect().bottom),
    fieldBottom: Math.round(field.getBoundingClientRect().bottom),
    keys: window.innerHeight - px,
  };
}, KEYBOARD);
console.log(`transform: ${geometry.lift}`);
console.log(`keyboard line: ${geometry.keys}px`);
console.log(`sheet bottom: ${geometry.sheetBottom}px · field bottom: ${geometry.fieldBottom}px`);

// The prop: a plate of keys where iOS would draw them.
await page.evaluate(
  ({ px, rows }) => {
    const toast = document.getElementById("toast");
    if (toast) toast.remove();
    const pad = document.createElement("div");
    pad.setAttribute(
      "style",
      `position:fixed;left:0;right:0;bottom:0;height:${px}px;z-index:99;background:#1c1c1e;` +
        "border-top:1px solid rgba(255,255,255,.12);display:flex;flex-direction:column;" +
        "justify-content:center;gap:10px;padding:12px 6px 28px;",
    );
    for (const row of rows) {
      const line = document.createElement("div");
      line.setAttribute("style", "display:flex;justify-content:center;gap:6px;");
      for (const key of row) {
        const cap = document.createElement("div");
        cap.setAttribute(
          "style",
          "min-width:30px;height:42px;border-radius:5px;background:#3a3a3c;color:#fff;" +
            "font:400 17px/42px -apple-system,system-ui,sans-serif;text-align:center;" +
            "box-shadow:0 1px 0 rgba(0,0,0,.5);",
        );
        cap.textContent = key;
        line.appendChild(cap);
      }
      pad.appendChild(line);
    }
    document.body.appendChild(pad);
  },
  { px: KEYBOARD, rows: [[..."qwertyuiop"], [..."asdfghjkl"], ["⇧", ..."zxcvbnm", "⌫"]] },
);

await page.screenshot({ path: "design/screens/74-sheet-above-keyboard.png" });
console.log("wrote 74-sheet-above-keyboard");

await context.close();
console.log(problems.length ? problems : "no console problems");
await browser.close();
