// tools/shots-copyloop.mjs - the copy loop, both halves of it.
//
//   PORT=7712 TENFOLD_DATA=/tmp/tenfold-shot-data node tools/serve.js &
//   BASE=http://127.0.0.1:7712 node tools/shots-copyloop.mjs
//
// Writes design/screens/69-copy-loop.png (the prompt on its way out, with the
// line that says what travels with it) and 70-paste-preview.png (the answer on
// its way back, before a single node is written) at the reference iPhone size.
// The vault is created for real and the goal is written through the ordinary
// composer, so this is the sheet as it actually arrives.
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

// One goal, two steps under it, written the ordinary way.
await page.getByRole("button", { name: /Write the first one|New entry/ }).click();
await page.locator(".composer input").fill("Get the knee fixed");
await page.locator(".composer input").press("Enter");
await page.locator(".composer input").press("Escape");
await page.locator(".row").first().click();
await page.getByRole("button", { name: /Add the first part/ }).click();
for (const title of ["Book the MRI", "Call the physio"]) {
  await page.locator(".composer input").fill(title);
  await page.locator(".composer input").press("Enter");
}
await page.locator(".composer input").press("Escape");

// A story, so the prompt has something to carry besides a title.
await page.evaluate(async () => {
  const { ctx } = await import("/web/js/app.js");
  const root = ctx.doc.nodes.find((n) => n.title === "Get the knee fixed");
  ctx.updateNode(root.id, {
    story: "Running hurts after ten minutes. The referral has been on the desk since March.",
  });
});

await page.locator(".hero-card").click();
await page.waitForSelector(".leaf-title");

const dropToast = () =>
  page.evaluate(() => {
    const el = document.getElementById("toast");
    if (el) el.remove();
  });

// ------------------------------------------------------------- the way out

await page.locator('[data-ai="copy"]').click();
await page.waitForSelector('[data-ai="prompt"]');
await page.waitForTimeout(500);
console.log(`title: ${await page.locator(".sheet-title").textContent()}`);
const reach = await page.locator(".sheet-body").evaluate((n) => ({
  visible: n.clientHeight,
  total: n.scrollHeight,
}));
console.log(`sheet body: ${reach.visible}px visible of ${reach.total}px`);
await dropToast();
await page.screenshot({ path: "design/screens/69-copy-loop.png" });
console.log("wrote 69-copy-loop");

// ------------------------------------------------------------- the way back

await page.locator('[data-ai="paste-open"]').click();
await page.locator('[data-ai="answer"]').fill(
  [
    "Call the practice on Monday morning",
    "  Ask for the earliest MRI slot",
    "  Write the date on the fridge",
    "Take the referral out of the desk drawer",
    "Book two swims this week",
    "  Pack the bag on Sunday evening",
  ].join("\n"),
);
await page.locator('[data-ai="look"]').click();
await page.waitForSelector('[data-ai="preview-item"]');
await page.waitForTimeout(400);
console.log(`preview lines: ${await page.locator('[data-ai="preview-item"]').count()}`);
await dropToast();
await page.screenshot({ path: "design/screens/70-paste-preview.png" });
console.log("wrote 70-paste-preview");

await context.close();
console.log(problems.length ? problems : "no console problems");
await browser.close();
