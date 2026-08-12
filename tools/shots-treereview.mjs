// tools/shots-treereview.mjs - the whole list, on its way to a model.
//
//   PORT=7713 TENFOLD_DATA=/tmp/tenfold-shot-data node tools/serve.js &
//   BASE=http://127.0.0.1:7713 node tools/shots-treereview.mjs
//
// Writes design/screens/75-tree-review.png at the reference iPhone size: the
// review sheet as it arrives from the title of the outline screen, with the
// line that says what travels, the prompt, and the line that says this one
// comes back as reading rather than as steps.
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

// A list with a shape to it: one goal well under way, one only named, one
// resting. A review of three identical titles would show nothing.
const goals = [
  "Get the knee fixed",
  "Spanish up to B2",
  "A quieter month",
  "The loft, finished",
  "Sail the boat alone",
];
await page.getByRole("button", { name: /Write the first one|New entry/ }).click();
for (const title of goals) {
  await page.locator(".composer input").fill(title);
  await page.locator(".composer input").press("Enter");
}
await page.locator(".composer input").press("Escape");

await page.evaluate(async () => {
  const { ctx } = await import("/web/js/app.js");
  const byTitle = (title) => ctx.doc.nodes.find((n) => n.title === title);

  ctx.updateNode(byTitle("Get the knee fixed").id, {
    story:
      "Why now: Running hurts after ten minutes and the referral has been on the desk since March.\n\n" +
      "Tried already: Six weeks of the exercises from the physio sheet, and two weeks off entirely.\n\n" +
      "In the way: The practice only answers before nine, which is exactly when the school run is.",
  });
  ctx.updateNode(byTitle("A quieter month").id, { status: "parked" });
  ctx.updateNode(byTitle("Sail the boat alone").id, {
    story: "The boat was my father's and it has not left the mooring in two summers.",
  });

  const day = 86400000;
  const knee = byTitle("Get the knee fixed").id;
  ctx.importTree(knee, [
    { title: "Book the MRI", level: 0 },
    { title: "Call the physio", level: 0 },
    { title: "Swim twice a week", level: 0 },
  ]);
  const step = (title) => ctx.doc.nodes.find((n) => n.title === title);
  ctx.updateNode(step("Book the MRI").id, { due: Date.now() - day });
  ctx.updateNode(step("Call the physio").id, { status: "done" });
  ctx.updateNode(step("Swim twice a week").id, { due: Date.now() });
});

// No reload here: a reload locks the vault, and the point of the picture is
// the sheet, not the passphrase field.
await page.waitForSelector(".h-title-btn");
await page.waitForTimeout(300);

// The report, verbatim: "Click auf The Ten".
await page.locator(".h-title-btn").click();
await page.waitForSelector('[data-ai="tree-prompt"]');
await page.waitForTimeout(500);

console.log(`title: ${await page.locator(".sheet-title").textContent()}`);
console.log(`scope: ${await page.locator(".field-hint").first().textContent()}`);
const prompt = await page.locator('[data-ai="tree-prompt"]').inputValue();
console.log(`prompt: ${prompt.length} characters, ${prompt.split("\n").length} lines`);
console.log(`fenced demand present: ${prompt.includes("```")}`);
console.log(`paste row present: ${(await page.locator('[data-ai="paste-open"]').count()) > 0}`);

await page.evaluate(() => {
  const el = document.getElementById("toast");
  if (el) el.remove();
});
await page.screenshot({ path: "design/screens/75-tree-review.png" });
console.log("wrote 75-tree-review");

await context.close();
console.log(problems.length ? problems : "no console problems");
await browser.close();
