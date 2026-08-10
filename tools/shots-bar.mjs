// tools/shots-bar.mjs - the three-control bottom bar, so the camera can be
// judged next to the two words instead of imagined.
//
//   node tools/serve.js &
//   node tools/shots-bar.mjs
//
// Writes, at phone size (390x844):
//   design/screens/60-bar-three.png        the outline with ten goals: "New
//                                          entry" disabled by the cap, the
//                                          camera between it and "Put in order"
//   design/screens/61-bar-three-focus.png  a focus screen with the same bar
//   design/screens/62-bar-icons-closeup.png  the bar alone at device scale 3,
//                                          the glyph proof - plus, camera and
//                                          scales have to read as one family
//
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

const PARTS = ["Book the MRI", "Find a physio", "Stop running on tarmac"];

const browser = await chromium.launch();
const problems = [];

async function open(scale) {
  const page = await browser.newPage({ viewport: PHONE, deviceScaleFactor: scale });
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
  // The camera exists only where assistance is switched on. A base URL that
  // answers nothing is enough - nothing is sent in these shots.
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    ctx.setLlm({ mode: "local", baseUrl: "http://127.0.0.1:7797/v1", model: "test-vision" });
  });
  await page.evaluate(
    async ({ goals, parts }) => {
      const { ctx } = await import("/web/js/app.js");
      for (const title of goals) ctx.commitCompose(title, null, "stay");
      ctx.cancelCompose();
      const first = ctx.childrenOf(null)[0];
      for (const title of parts) ctx.commitCompose(title, first.id, "stay");
      ctx.cancelCompose();
      ctx.go("outline", null, { replace: true });
    },
    { goals: GOALS, parts: PARTS },
  );
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const t = document.getElementById("toast");
    if (t) t.remove();
  });
  return page;
}

// ------------------------------------------------------------------ the shots

const page = await open(2);

const outlineBar = await page.evaluate(() => {
  const bar = document.querySelector(".bar");
  const kids = [...bar.children];
  return {
    controls: kids.length,
    labels: kids.map((k) => (k.textContent || k.getAttribute("aria-label") || "").trim()),
    widths: kids.map((k) => +k.getBoundingClientRect().width.toFixed(1)),
    addDisabled: kids[0].disabled,
    camDisabled: kids[1].disabled,
    textLine: document.querySelectorAll(".import-entry").length,
  };
});
await page.screenshot({ path: "design/screens/60-bar-three.png" });
console.log("wrote 60-bar-three", JSON.stringify(outlineBar));

await page.locator(".row").first().click();
await page.waitForSelector(".hero-title");
await page.waitForTimeout(500);
const focusBar = await page.evaluate(() => {
  const kids = [...document.querySelector(".bar").children];
  return {
    controls: kids.length,
    labels: kids.map((k) => (k.textContent || k.getAttribute("aria-label") || "").trim()),
    widths: kids.map((k) => +k.getBoundingClientRect().width.toFixed(1)),
  };
});
await page.screenshot({ path: "design/screens/61-bar-three-focus.png" });
console.log("wrote 61-bar-three-focus", JSON.stringify(focusBar));

// The glyph proof: the bar alone, at three device pixels per CSS pixel, which
// is what the phone this is drawn for actually has.
const close = await open(3);
await close.locator(".bar").screenshot({ path: "design/screens/62-bar-icons-closeup.png" });
console.log("wrote 62-bar-icons-closeup");

console.log(problems.length ? `PROBLEMS: ${problems.join(" | ")}` : "no console errors");
await browser.close();
