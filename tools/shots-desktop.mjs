// tools/shots-desktop.mjs - the wide tier, so it can be looked at.
//
//   node tools/serve.js &
//   node tools/shots-desktop.mjs
//
// Writes design/screens/48-desktop-outline.png, 49-desktop-map.png,
// 50-desktop-leaf.png and 51-desktop-settings.png at 1280x900 - the window the
// width discipline was written for. The vault is seeded with eight goals, five
// of them broken down, and one step carrying everything a step can carry, so
// the columns are argued against real text and not against three words.
//
// The map shot is taken in the mode the app actually opens in (the mind map),
// because that is what a user sees; it is the one screen that takes the whole
// frame. Not part of the test suite - this is for looking.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";
const DESK = { width: 1280, height: 900 };

const GOALS = [
  "Pay off the remaining debt",
  "Make the company sellable",
  "Run ten kilometres again",
  "Sort things out with Anna",
  "See my father regularly",
  "A back that stops hurting",
  "Spanish up to B2",
  "Will and provisions settled",
];
const PARTS = [
  [0, ["Renegotiate the monthly rate", "Cancel every subscription"]],
  [2, ["Book the physio for the knee", "Two easy runs a week", "Buy shoes after a gait analysis"]],
  [3, ["A weekend away together", "Say the thing I keep not saying"]],
  [4, ["Call him on Sundays", "Lunch once a month"]],
  [6, ["Twenty minutes of vocabulary", "Find an evening course"]],
];

const STORY = `Why it matters: my knee gives out after four kilometres and I stop running for weeks afterwards.
What I tried: new shoes, less mileage, an app that counts cadence. None of it held.
What blocks me: I book nothing because the practice only answers before nine.
Done when: I have run thirty minutes three times in one week without pain.`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: DESK, deviceScaleFactor: 2 });
const problems = [];
page.on("pageerror", (e) => problems.push(`PAGEERROR ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`CONSOLE ${m.text()}`);
});

const shot = async (name) => {
  await page.waitForTimeout(500);
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
await page.waitForSelector(".head");

// --- the content ------------------------------------------------------------
const leafId = await page.evaluate(
  async ({ goals, parts, story }) => {
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
    // One step that carries everything a step can carry - the leaf shot needs
    // a full ledger, not an empty page.
    const leaf = partIds.get(2)[0];
    ctx.updateNode(leaf, {
      story,
      note: "The practice only answers between eight and nine. Ask for Dr. Reiter, she knows the history.",
      doneWhen: "The appointment is in the calendar and confirmed by mail.",
      due: Date.parse("2026-09-18T09:00:00"),
      effortMinutes: 25,
      impact: 4,
      confidence: 3,
      effort: 2,
    });
    const reiter = ctx.addEntity({ name: "Dr. Reiter", kind: "person", relation: "the physio" });
    ctx.linkEntity(leaf, reiter);
    const anna = ctx.addEntity({ name: "Anna", kind: "person", relation: "my sister" });
    ctx.linkEntity(partIds.get(3)[0], anna);
    ctx.setStatus(partIds.get(0)[1], "done");
    ctx.go("outline", null, { replace: true });
    return leaf;
  },
  { goals: GOALS, parts: PARTS, story: STORY },
);
await page.waitForTimeout(400);

// --- 48: the outline --------------------------------------------------------
await shot("48-desktop-outline");

// --- 49: the map, the one screen that takes the whole frame -----------------
await page.getByRole("button", { name: "Open the map" }).click();
await page.waitForSelector(".map-scene.is-ready");
await page.waitForTimeout(1200);
await shot("49-desktop-map");
await page.getByRole("button", { name: "Close", exact: true }).click();
await page.waitForTimeout(500);

// --- 50: a step with everything on it ---------------------------------------
await page.evaluate(async (id) => {
  const { ctx } = await import("/web/js/app.js");
  ctx.go("leaf", id);
}, leafId);
await page.waitForSelector(".leaf-title");
await shot("50-desktop-leaf");

// --- 51: settings, the longest form in the app ------------------------------
await page.evaluate(async () => {
  const { ctx } = await import("/web/js/app.js");
  ctx.go("outline", null, { replace: true });
});
await page.waitForTimeout(400);
await page.getByRole("button", { name: "Open settings" }).click();
await page.waitForSelector(".setrow, .scroll");
await shot("51-desktop-settings");

console.log(problems.length ? `PROBLEMS: ${problems.join(" | ")}` : "no console errors");
await browser.close();
