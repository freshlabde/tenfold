// tools/shots-map.mjs - the map screens, on their own.
//
//   node tools/serve.js &
//   node tools/shots-map.mjs
//
// Writes design/screens/26..28 at the reference iPhone size (390x844 CSS px,
// 2x device pixels). Separate from screenshots.mjs because the map is the one
// screen worth re-shooting on its own while it is being tuned: it needs a tree
// with real depth under two of the goals, and it needs a second and a third
// pass (light theme, one branch focused) that the full run has no place for.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";

// Which of the eight frame goals get parts, and what those parts are called.
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

// --- a vault with the frame of eight, and parts under two of them -----------
await page.goto(`${BASE}/web/index.html`);
await page.getByRole("button", { name: "Set up the vault" }).click();
await page.locator('input[type="password"]').first().fill(PASS);
await page.locator('input[type="password"]').nth(1).fill(PASS);
await page.getByRole("button", { name: /Create the vault/ }).click();
await page.waitForSelector(".keygrid", { timeout: 30000 });
await page.locator(".check").click();
await page.getByRole("button", { name: "Continue" }).click();
await page.getByRole("button", { name: "Start with a frame" }).click();
// The first run explains itself once before it hands the list over.
await page.getByRole("button", { name: "Begin" }).click();
await page.waitForSelector(".row-shell");

for (const [index, parts] of BRANCHES) {
  await page.locator(".row-shell").nth(index).locator(".row").click();
  await page.getByRole("button", { name: /Add the first part/ }).click();
  await compose(parts);
  await page.locator(".crumb-pill").first().click();
}
// One level deeper under the first branch, so a focused family has a third
// ring to show rather than a flat fan.
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

// --- the sky, dark and light ------------------------------------------------
const openMap = async () => {
  await page.getByRole("button", { name: "Open the map" }).click();
  await page.waitForSelector(".map-scene.is-ready");
  await page.waitForTimeout(900);
};

// Report once whether the runtime actually took the tinted path, so a silent
// fallback to the plain accent cannot go unnoticed in a review.
console.log(
  "relative colour:",
  await page.evaluate(() => CSS.supports("color", "oklch(from white l c h)")),
);

await openMap();
await shot("26-map-v2-dark");

// --- one family, close up ---------------------------------------------------
{
  const orb = page.locator(".map-tree > .map-body.is-d0").first().locator("> .map-hit");
  const box = await orb.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1100);
  await shot("28-map-v2-focus");
}

await page.getByRole("button", { name: "Close", exact: true }).click();
await page.waitForTimeout(500);
await skin("Slate", "Light");
await openMap();
await shot("27-map-v2-light");
await page.getByRole("button", { name: "Close", exact: true }).click();
await skin("Slate", "Dark");

console.log(problems.length ? `PROBLEMS: ${problems.join(" | ")}` : "no console errors");
await browser.close();
