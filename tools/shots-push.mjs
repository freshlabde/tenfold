// tools/shots-push.mjs - the daily reminder, asked where it is decided.
//
//   PORT=7712 TENFOLD_DATA=/tmp/tenfold-shot-data node tools/serve.js &
//   BASE=http://127.0.0.1:7712 node tools/shots-push.mjs
//
// Writes design/screens/64-setup-reminder.png (the new first-run step, right
// after the backup question) and 65-push-offer-sheet.png (the one-time offer
// that catches up with an iPhone which set the vault up in a Safari tab), both
// at the reference iPhone size. Nothing is pressed that would register a real
// subscription - these are pictures of the question, not of the answer.
// Not part of the test suite - this is for looking.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const TITLES = [
  "Pay off the remaining debt",
  "Make the company sellable",
  "Run ten kilometres again",
  "Sort things out with Anna",
  "See my father regularly",
];

const browser = await chromium.launch();
const problems = [];

/** A page with a clean slate, watched for console noise. */
async function freshPage(options) {
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 2,
    permissions: ["notifications"],
    ...options,
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
  return { context, page };
}

/** Up to the backup question, which is where the new step hangs off. */
async function walkToBackup(page) {
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 60000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start empty/ }).click();
}

/** The installed-app probe, the one thing a desktop browser cannot answer. */
async function setInstalled(page, installed) {
  await page.evaluate(async (value) => {
    const push = await import("/web/js/push.js");
    push.setInstalledProbe(() => value);
  }, installed);
}

const dropToast = (page) =>
  page.evaluate(() => {
    const el = document.getElementById("toast");
    if (el) el.remove();
  });

// --- 64: the step ------------------------------------------------------------
{
  const { context, page } = await freshPage({});
  await walkToBackup(page);
  await page.getByRole("button", { name: "Keep an encrypted copy on the server" }).click();
  await page.getByRole("button", { name: "Turn on the daily reminder" }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(600);
  await dropToast(page);
  await page.screenshot({ path: "design/screens/64-setup-reminder.png" });
  console.log("wrote 64-setup-reminder");
  await context.close();
}

// --- 65: the offer -----------------------------------------------------------
{
  // The vault is set up in an iPhone browser tab, where the step can only say
  // that a tab receives nothing. The offer is what happens afterwards, on the
  // first unlock from the home screen.
  const { context, page } = await freshPage({ userAgent: IPHONE_UA });
  await setInstalled(page, false);
  await walkToBackup(page);
  await page.getByRole("button", { name: "Keep an encrypted copy on the server" }).click();
  await page.getByRole("button", { name: "I will do it in the app" }).waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "I will do it in the app" }).click();
  await page.getByRole("button", { name: "Begin" }).click();

  // A list worth being reminded about, so the sheet sits over something real.
  await page.getByRole("button", { name: /Write the first one|New entry/ }).click();
  for (const title of TITLES) {
    await page.locator(".composer input").fill(title);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
  await page.waitForTimeout(1500);

  await page.reload();
  await page.waitForSelector(".lock-title");
  await setInstalled(page, true);
  await page.locator(".lock input").fill(PASS);
  await page.getByRole("button", { name: /Unlock/ }).click();
  await page.waitForSelector(".sheet-title", { timeout: 60000 });
  await page.waitForTimeout(700);
  await dropToast(page);
  await page.screenshot({ path: "design/screens/65-push-offer-sheet.png" });
  console.log("wrote 65-push-offer-sheet");
  await context.close();
}

console.log(problems.length ? problems : "no console problems");
await browser.close();
