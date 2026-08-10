// tools/shots-path.mjs - the two things the owner could not see from the phone:
// which goal a deep step belongs to, and that something is overdue at all.
//
//   node tools/serve.js &
//   node tools/shots-path.mjs
//
// Writes design/screens/55-question-path.png (the daily question about a step
// three levels down, with its whole chain under the name) and
// 56-outline-due-hint.png (the start screen with the due line above the ten).
// Not part of the test suite; this is for looking.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

const GOALS = [
  "Huerta con kayra",
  "Make the company sellable",
  "Run ten kilometres again",
  "Spanish up to B2",
  "Sort things out with Anna",
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
  async ({ goals }) => {
    const { ctx } = await import("/web/js/app.js");
    const add = (title, parentId) => {
      ctx.commitCompose(title, parentId, "stay");
      const kids = ctx.childrenOf(parentId);
      return kids[kids.length - 1].id;
    };

    const rootIds = goals.map((title) => add(title, null));
    const huerta = rootIds[0];
    const little = add("Little tasks", huerta);
    const mv = add("M&V", little);
    add("Repair the pump", little);
    const seeds = add("Order the seeds", huerta);
    const beds = add("Water the beds", huerta);

    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    const day = 86400000;
    ctx.updateNode(mv, { due: noon.getTime() - day });
    ctx.updateNode(seeds, { due: noon.getTime() });
    ctx.updateNode(beds, { due: noon.getTime() });

    // Everything except the deep step has been written about, so the daily
    // question lands on the one node whose name says nothing on its own.
    for (const node of ctx.doc.nodes) {
      if (node.id === mv) continue;
      ctx.updateNode(node.id, { story: "Already written down, in a sentence or two." });
    }
    ctx.go("outline", null, { replace: true });
  },
  { goals: GOALS },
);
await page.waitForTimeout(500);
await page.evaluate(() => {
  const t = document.getElementById("toast");
  if (t) t.remove();
});

await page.screenshot({ path: "design/screens/56-outline-due-hint.png" });
console.log("wrote 56-outline-due-hint");

await page.getByRole("button", { name: "Today", exact: true }).click();
await page.waitForSelector(".qcard");
await page.waitForTimeout(500);
await page.screenshot({ path: "design/screens/55-question-path.png" });
console.log("wrote 55-question-path");

console.log(problems.length ? `PROBLEMS: ${problems.join(" | ")}` : "no console errors");
await browser.close();
