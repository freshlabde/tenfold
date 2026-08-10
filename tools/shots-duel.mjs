// tools/shots-duel.mjs - the duel after the arrows landed on the cards.
//
//   node tools/serve.js &
//   node tools/shots-duel.mjs
//
// Writes design/screens/52-duel-arrows.png (idle, both arrows visible) and
// 53-duel-drag.png (mid-drag, the right arrow answering) at the reference
// iPhone size. Not part of the test suite - this is for looking.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";
const GOALS = ["Run ten kilometres again", "Sort things out with Anna"];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const problems = [];
page.on("pageerror", (e) => problems.push(`PAGEERROR ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`CONSOLE ${m.text()}`);
});

const shot = async (name) => {
  await page.evaluate(() => {
    const t = document.getElementById("toast");
    if (t) t.remove();
  });
  await page.screenshot({ path: `design/screens/${name}.png` });
  console.log("wrote", name);
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
await page.getByRole("button", { name: "Not now" }).click();
await page.getByRole("button", { name: "Begin" }).click();

// --- two goals, so the duel has a pair --------------------------------------
await page.getByRole("button", { name: /Write the first one|New entry/ }).click();
for (const g of GOALS) {
  await page.locator(".composer input").fill(g);
  await page.locator(".composer input").press("Enter");
}
await page.locator(".composer input").press("Escape");

await page.getByRole("button", { name: "Put in order" }).click();
await page.waitForSelector(".duel-card.is-a .duel-arrow-glyph");

// --- idle: both arrows at rest ----------------------------------------------
// The drift is a four-second loop; it is paused for the frame so the two
// arrows are caught at the same point of their cycle in every run.
await page.evaluate(() => {
  for (const a of document.querySelectorAll(".duel-arrow")) a.style.animationPlayState = "paused";
});
await page.waitForTimeout(320);
await shot("52-duel-arrows");

// --- mid-drag: the right arrow filling --------------------------------------
{
  const box = await page.locator(".beam").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy, { steps: 8 });
  // Short of the commit distance (88), so the frame shows a decision being
  // answered rather than one already taken.
  await page.mouse.move(cx + 52, cy, { steps: 8 });
  await page.waitForTimeout(260);
  await shot("53-duel-drag");
  await page.mouse.up();
}

console.log(problems.length ? problems : "no console problems");
await browser.close();
