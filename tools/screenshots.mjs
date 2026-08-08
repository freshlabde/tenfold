// tools/screenshots.mjs - drive the real app and write review screenshots.
//
//   node tools/serve.js &
//   node tools/screenshots.mjs
//
// Writes design/screens/*.png at the reference iPhone size (390x844 CSS px,
// 2x device pixels). Not part of the test suite - this is for looking at.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";

const ROOTS = [
  "Pay off the remaining debt",
  "Make the company sellable",
  "Run ten kilometres again",
  "Sort things out with Anna",
  "See my father regularly",
  "A back that stops hurting",
  "Spanish up to B2",
  "Will and provisions settled",
  "Finish the workshop",
  "Less screen time in the evening",
];
const PARTS = [
  "Build a base: three times a week, thirty minutes",
  "Stabilise the knee",
  "Buy shoes after a gait analysis",
  "Enter the ten kilometres in September",
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const problems = [];
page.on("pageerror", (e) => problems.push(`PAGEERROR ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`CONSOLE ${m.text()}`);
});

const shot = async (name) => {
  await page.waitForTimeout(260);
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

await page.goto(`${BASE}/web/index.html`);

// --- first run --------------------------------------------------------------
await shot("00-first-run");
await page.getByRole("button", { name: "Set up the vault" }).click();
await page.locator('input[type="password"]').first().fill(PASS);
await page.locator('input[type="password"]').nth(1).fill(PASS);
await shot("01-setup-passphrase");
await page.getByRole("button", { name: /Create the vault/ }).click();
await page.waitForSelector(".keygrid", { timeout: 30000 });
await shot("02-setup-recovery-key");
await page.locator(".check").click();
await page.getByRole("button", { name: "Continue" }).click();
await shot("03-setup-starting-point");

// --- empty outline ----------------------------------------------------------
await page.getByRole("button", { name: /Start empty/ }).click();
await shot("04-outline-empty");

// --- filled outline ---------------------------------------------------------
await page.getByRole("button", { name: /Write the first one/ }).click();
await compose(ROOTS);
await shot("05-outline-filled");

// --- focus ------------------------------------------------------------------
await page.locator(".row-shell").nth(2).locator(".row").click();
await page.getByRole("button", { name: /Add the first part/ }).click();
await compose(PARTS);
await shot("06-focus");

// --- leaf -------------------------------------------------------------------
await page.locator(".list.is-kids .row-shell").nth(2).locator(".row").click();
await shot("07-leaf");

// --- editor sheet -----------------------------------------------------------
await page.getByRole("button", { name: "Edit", exact: true }).click();
await page.waitForTimeout(400);
await shot("08-editor-sheet");
await page.getByRole("button", { name: "Cancel" }).click();
await page.waitForTimeout(300);
await page.locator(".crumb-back").click();
await page.locator(".crumb-pill").first().click();

// --- duel -------------------------------------------------------------------
await page.getByRole("button", { name: "Put in order" }).click();
await shot("09-duel");
{
  const box = await page.locator(".beam").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 44, cy, { steps: 8 });
  await page.mouse.move(cx + 68, cy, { steps: 8 });
  await shot("10-duel-midswipe");
  await page.mouse.up();
}
for (let i = 0; i < 40; i += 1) {
  const b = page.getByRole("button", { name: "Choose B" });
  if (!(await b.count())) break;
  await b.click();
}
await shot("11-duel-result");
await page.getByRole("button", { name: "Take this order" }).click();

// --- search -----------------------------------------------------------------
await page.getByRole("button", { name: "Open search" }).click();
await page.locator(".searchbar input").fill("knee");
await shot("12-search");
await page.locator(".searchbar input").press("Escape");

// --- settings + about -------------------------------------------------------
await page.getByRole("button", { name: "Open settings" }).click();
await shot("13-settings");
await page.getByRole("button", { name: "About tenfold" }).click();
await shot("14-about");
// Closing About returns to settings, which is where the lock button lives.
await page.getByRole("button", { name: "Close" }).click();

// --- lock -------------------------------------------------------------------
await page.getByRole("button", { name: /Lock now/ }).click();
await page.waitForTimeout(2800); // let the toast retract
await shot("15-lock");

// --- skins and themes on the filled outline ---------------------------------
await page.locator(".lock input").fill(PASS);
await page.getByRole("button", { name: /Unlock/ }).click();
await page.waitForSelector(".h-title", { timeout: 30000 });

const variants = [
  ["slate", "light", "16-skin-slate-light"],
  ["register", "dark", "17-skin-register-dark"],
  ["register", "light", "18-skin-register-light"],
  ["breath", "dark", "19-skin-breath-dark"],
  ["breath", "light", "20-skin-breath-light"],
];
const LABEL = { slate: "Slate", register: "Register", breath: "Breath", dark: "Dark", light: "Light" };
for (const [skin, theme, name] of variants) {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: LABEL[skin], exact: true }).click();
  await page.getByRole("button", { name: LABEL[theme], exact: true }).click();
  await page.getByRole("button", { name: "Close" }).click();
  await shot(name);
}
// Back to the default so the last screenshot set matches the shipped default.
await page.getByRole("button", { name: "Open settings" }).click();
await page.getByRole("button", { name: "Slate", exact: true }).click();
await page.getByRole("button", { name: "Dark", exact: true }).click();
await page.getByRole("button", { name: "Close" }).click();

console.log(problems.length ? `PROBLEMS: ${problems.join(" | ")}` : "no console errors");
await browser.close();
