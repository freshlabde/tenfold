// tools/shots-rank-ramp.mjs - the ranked top ten, in all six skin x theme
// combinations, so the loudness ramp can be judged instead of imagined.
//
//   node tools/serve.js &
//   node tools/shots-rank-ramp.mjs
//
// Writes design/screens/54-rank-ramp-<skin>-<theme>.png at phone size with ten
// goals, three of them broken down (so a gauge and a "2 of 5" appear on the
// ramp), one done and one parked - the two treatments that layer on top of the
// ramp and must survive it. Not part of the test suite; this is for looking.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

const GOALS = [
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
  [0, ["Renegotiate the monthly rate", "Cancel every subscription", "One extra payment a quarter"]],
  [2, ["Book the physio for the knee", "Two easy runs a week", "Buy shoes after a gait analysis"]],
  [6, ["Twenty minutes of vocabulary", "Find an evening course"]],
];

const COMBOS = [
  ["slate", "dark"],
  ["slate", "light"],
  ["register", "dark"],
  ["register", "light"],
  ["breath", "dark"],
  ["breath", "light"],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: PHONE, deviceScaleFactor: 2 });
const problems = [];
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
await page.waitForSelector(".head");

await page.evaluate(
  async ({ goals, parts }) => {
    const { ctx } = await import("/web/js/app.js");
    const add = (title, parentId) => {
      ctx.commitCompose(title, parentId, "stay");
      const kids = ctx.childrenOf(parentId);
      return kids[kids.length - 1].id;
    };
    const rootIds = goals.map((title) => add(title, null));
    const partIds = new Map();
    for (const [index, titles] of parts) {
      partIds.set(index, titles.map((title) => add(title, rootIds[index])));
    }
    ctx.setStatus(partIds.get(0)[0], "done");
    ctx.setStatus(partIds.get(2)[0], "done");
    // A finished goal and a parked one, both far enough down the ramp that
    // their own treatment has to hold against a quiet background.
    ctx.setStatus(rootIds[7], "done");
    ctx.setStatus(rootIds[8], "parked");
    ctx.go("outline", null, { replace: true });
  },
  { goals: GOALS, parts: PARTS },
);
await page.waitForTimeout(400);

for (const [skin, theme] of COMBOS) {
  await page.evaluate(
    async (prefs) => {
      const { ctx } = await import("/web/js/app.js");
      ctx.setSettings(prefs);
    },
    { skin, theme },
  );
  await page.waitForTimeout(450);
  await page.evaluate(() => {
    const t = document.getElementById("toast");
    if (t) t.remove();
  });
  const name = `54-rank-ramp-${skin}-${theme}`;
  await page.screenshot({ path: `design/screens/${name}.png` });
  console.log("wrote", name);
}

console.log(problems.length ? `PROBLEMS: ${problems.join(" | ")}` : "no console errors");
await browser.close();
