// tools/shots-sky-cards.mjs - the constellation with its context cards.
//
//   node tools/serve.js &
//   node tools/shots-sky-cards.mjs
//
// Writes design/screens/44-sky-cards-{dark,light,focus}.png plus
// 46-cards-diamond.png and 47-cards-selected.png at the reference iPhone size.
// The vault it builds is the shape the question was asked about: one card
// linked into TWO different families (the thing the mind map cannot draw), one
// card with a single link, and one card nobody has linked yet.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";

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
  [2, ["Two easy runs a week", "Buy proper shoes"]],
  [3, ["A weekend away together", "Say the thing I keep not saying"]],
  [4, ["Call him on Sundays", "Lunch once a month"]],
  [6, ["Twenty minutes of vocabulary", "Find an evening course"]],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const problems = [];
page.on("pageerror", (e) => problems.push(`PAGEERROR ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`CONSOLE ${m.text()}`);
});

const shot = async (name) => {
  await page.waitForTimeout(800);
  await page.screenshot({ path: `design/screens/${name}.png` });
  console.log("wrote", name);
};

await page.goto(`${BASE}/web/index.html`);
await page.getByRole("button", { name: "Set up the vault" }).click();
await page.locator('input[type="password"]').first().fill(PASS);
await page.locator('input[type="password"]').nth(1).fill(PASS);
await page.getByRole("button", { name: /Create the vault/ }).click();
await page.waitForSelector(".keygrid", { timeout: 30000 });
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
    // Anna: one person, three steps, two families - the cross-link.
    const anna = ctx.addEntity({ name: "Anna", kind: "person", relation: "my sister" });
    ctx.linkEntity(partIds.get(3)[0], anna);
    ctx.linkEntity(partIds.get(3)[1], anna);
    ctx.linkEntity(partIds.get(4)[1], anna);
    // The bank: one link only.
    const bank = ctx.addEntity({ name: "The bank", kind: "org" });
    ctx.linkEntity(partIds.get(0)[0], bank);
    // And one nobody has linked yet.
    ctx.addEntity({ name: "The workshop", kind: "place" });
    ctx.setSettings({ mapMode: "sky" });
    ctx.go("outline", null, { replace: true });
  },
  { goals: GOALS, parts: PARTS },
);
await page.waitForTimeout(400);

const openMap = async () => {
  await page.getByRole("button", { name: "Open the map" }).click();
  await page.waitForSelector(".map-scene.is-ready");
  await page.waitForTimeout(900);
};

await openMap();
console.log(
  "cards:",
  await page.locator(".map-card").count(),
  "threads:",
  await page.locator(".map-card-link").count(),
  "sub:",
  await page.locator(".h-sub").textContent(),
);
await shot("44-sky-cards-dark");

// The family Anna reaches into, focused: her ring has to keep its light while
// the families she is not in step back.
{
  const orb = page.locator(".map-tree > .map-body.is-d0").nth(3).locator("> .map-hit");
  const box = await orb.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1200);
  await shot("44-sky-cards-focus");
}

// The card species itself: one diamond for every kind, every name on screen
// without anything being focused - and then one card selected, which lights it
// and its threads and lets the rest of the sky step back.
{
  await page.getByRole("button", { name: "Show everything" }).click();
  await page.waitForTimeout(900);
  await shot("46-cards-diamond");

  const card = page.locator(".map-card[data-card]").first().locator("> .map-hit");
  const box = await card.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1000);
  console.log("selected:", await page.locator(".map-card.is-selected").count());
  await shot("47-cards-selected");
  await page.getByRole("button", { name: "Show everything" }).click();
  await page.waitForTimeout(600);
}

await page.getByRole("button", { name: "Close", exact: true }).click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: "Open settings" }).click();
await page.getByRole("button", { name: "Light", exact: true }).click();
await page.getByRole("button", { name: "Close", exact: true }).click();
await openMap();
await shot("44-sky-cards-light");

console.log(problems.length ? `PROBLEMS: ${problems.join(" | ")}` : "no console errors");
await browser.close();
