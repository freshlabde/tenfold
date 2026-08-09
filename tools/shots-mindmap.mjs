// tools/shots-mindmap.mjs - the mind-map mode of the map screen.
//
//   node tools/serve.js &
//   node tools/shots-mindmap.mjs
//
// Writes design/screens/32..34 at the reference iPhone size (390x844 CSS px,
// 2x device pixels): the mind map dark, the same tree light, and a third pass
// on a deliberately three-level tree, which is the case the layout has to
// survive - two columns of real titles on a phone.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";

// The parts hung under two of the frame goals, and one level deeper under one
// of those - the shape a real list has after a month.
const BRANCHES = [
  [0, ["Three walks a week", "Back exercises every morning", "A dentist appointment"]],
  [3, ["Call my father on Sundays", "A weekend with Anna", "Write to Ines"]],
];
const DEEPER = ["Find the shoes", "Book the gait analysis"];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const problems = [];
page.on("pageerror", (e) => problems.push(`PAGEERROR ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`CONSOLE ${m.text()}`);
});

const shot = async (name) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `design/screens/${name}.png` });
  console.log("wrote", name);
};
const compose = async (titles) => {
  for (const t of titles) {
    await page.locator(".composer input").fill(t);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
};
const skin = async (name, theme) => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await page.getByRole("button", { name: theme, exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
};

await page.goto(`${BASE}/web/index.html`);
await page.getByRole("button", { name: "Set up the vault" }).click();
await page.locator('input[type="password"]').first().fill(PASS);
await page.locator('input[type="password"]').nth(1).fill(PASS);
await page.getByRole("button", { name: /Create the vault/ }).click();
await page.waitForSelector(".keygrid", { timeout: 30000 });
await page.locator(".check").click();
await page.getByRole("button", { name: "Continue" }).click();
await page.getByRole("button", { name: "Start with a frame" }).click();
await page.getByRole("button", { name: "Begin" }).click();
await page.waitForSelector(".row-shell");

for (const [index, parts] of BRANCHES) {
  await page.locator(".row-shell").nth(index).locator(".row").click();
  await page.getByRole("button", { name: /Add the first part/ }).click();
  await compose(parts);
  await page.locator(".crumb-pill").first().click();
}

const openMap = async () => {
  await page.getByRole("button", { name: "Open the map" }).click();
  await page.waitForSelector(".map-scene.is-ready");
  await page.waitForTimeout(900);
};

// --- the mind map, dark and light -------------------------------------------
await openMap();
await page.getByRole("button", { name: "Mind map" }).click();
await page.waitForSelector(".mm-tree.is-ready");
await shot("32-mindmap-dark");

await page.getByRole("button", { name: "Close", exact: true }).click();
await page.waitForTimeout(400);
await skin("Slate", "Light");
await openMap();
await shot("33-mindmap-light");
await page.getByRole("button", { name: "Close", exact: true }).click();
await skin("Slate", "Dark");

// --- three levels -----------------------------------------------------------
await page.locator(".row-shell").nth(BRANCHES[0][0]).locator(".row").click();
await page.locator(".list.is-kids .row-shell").first().locator(".row").click();
await page.getByRole("button", { name: "Sub-goal", exact: true }).click();
await page.waitForTimeout(600);
{
  const add = page.getByRole("button", { name: /Add the first part/ });
  if (await add.count()) await add.click();
}
await compose(DEEPER);
await page.locator(".crumb-pill").first().click();

await openMap();
await shot("34-mindmap-deep");

console.log(problems.length ? `PROBLEMS: ${problems.join(" | ")}` : "no console errors");
await browser.close();
