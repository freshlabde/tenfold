// tools/shots-tiers.mjs - the three importance bands at the two counts that
// matter, so the edges can be judged instead of imagined.
//
//   node tools/serve.js &
//   node tools/shots-tiers.mjs
//
// Writes, at phone size (390x844):
//   design/screens/58-tiers-eight.png    eight plain goals, slate dark - the
//                                        owner's real count
//   design/screens/59-tiers-ten-fit.png  ten plain goals, slate dark - the fit
//                                        proof: rank one and rank ten both
//                                        whole on one screen, nothing to
//                                        scroll in either direction
//
// Plain one-line goals on purpose: a sub-line or a gauge changes the height of
// a single row, and these two shots are about what the BANDS do to it. The
// mixed list with done, parked and broken-down goals is 54-rank-ramp-*.
// Not part of the test suite; this is for looking.
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

// Ten first, then two goals removed: one vault, one PBKDF2 run, and the eight
// is literally the ten with two entries gone - which is how it happens.
const SHOTS = [
  { name: "59-tiers-ten-fit", count: 10 },
  { name: "58-tiers-eight", count: 8 },
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

await page.evaluate(async (prefs) => (await import("/web/js/app.js")).ctx.setSettings(prefs), {
  skin: "slate",
  theme: "dark",
});

for (const { name, count } of SHOTS) {
  // Fill up to the wanted count, or drop from the foot of the list down to it.
  await page.evaluate(
    async (goals) => {
      const { ctx } = await import("/web/js/app.js");
      const have = ctx.childrenOf(null);
      if (have.length > goals.length) {
        // One per frame: two deletions in the same tick cancel each other's
        // view transition and the skipped one rejects into the console.
        for (const node of have.slice(goals.length)) {
          ctx.deleteNode(node);
          await new Promise((r) => setTimeout(r, 250));
        }
      } else {
        for (const title of goals.slice(have.length)) ctx.commitCompose(title, null, "stay");
        ctx.cancelCompose();
      }
      ctx.go("outline", null, { replace: true });
    },
    GOALS.slice(0, count),
  );
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const t = document.getElementById("toast");
    if (t) t.remove();
  });
  const fit = await page.evaluate(() => {
    const s = document.querySelector(".scroll");
    const rows = [...document.querySelectorAll(".list.is-ranked > .row-shell > .row")];
    return {
      rows: rows.length,
      heights: rows.map((r) => +r.getBoundingClientRect().height.toFixed(1)),
      firstTop: +rows[0].getBoundingClientRect().top.toFixed(1),
      lastBottom: +rows[rows.length - 1].getBoundingClientRect().bottom.toFixed(1),
      overflow: s.scrollHeight - s.clientHeight,
      viewport: window.innerHeight,
    };
  });
  await page.screenshot({ path: `design/screens/${name}.png` });
  console.log("wrote", name, JSON.stringify(fit));
}

console.log(problems.length ? `PROBLEMS: ${problems.join(" | ")}` : "no console errors");
await browser.close();
