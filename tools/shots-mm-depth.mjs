// tools/shots-mm-depth.mjs - the level the owner could not see.
//
//   node tools/serve.js &
//   node tools/shots-mm-depth.mjs before      (or: after)
//
// Writes design/screens/45-mm-depth-<stage>.png plus a left-heavy variant and
// one register shot, at the reference iPhone size (390x844 CSS px, 2x).
//
// The tree is the owner's own report, rebuilt exactly: one goal about the
// people close to him, a part under it that carries FIVE steps of its own (one
// of them finished), and sibling parts on the same goal - the shape in which
// depth two came out reading as one flat list with depth one. The second shot
// puts that same goal on the LEFT branch, where the right-aligned text used to
// swallow the indent whole.
//
// It also prints the measured column of every depth, per branch side, so the
// indent can be read as a number and not only looked at.
//
// 45-mm-depth-alt-centred-parent.png beside these is the arrangement that lost:
// the same tree with a parent still standing in the MIDDLE of its children. It
// is kept because the reason it lost is only visible in the picture - the goal
// ends up below its own first part's whole block, seventh in its own family.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";
const STAGE = process.argv[2] || "before";

/** The goal from the report, with the branch that went missing. */
const DEEP = {
  goal: "Die Menschen, die mir nahe sind",
  parts: [
    {
      title: "Die Beziehung zu meinem Vater verbessern",
      kids: [
        ["Jeden Sonntagabend anrufen, ohne Ausnahme", "done"],
        ["Einmal im Monat zum Mittagessen hinfahren", "open"],
        ["Die alten Fotos gemeinsam durchgehen", "open"],
        ["Uber die Zeit nach der Firma sprechen", "open"],
        ["Seinen achtzigsten Geburtstag richtig planen", "open"],
      ],
    },
    { title: "Annas Geburtstag nicht wieder vergessen", kids: [] },
    { title: "Mit meinem Bruder endlich wieder reden", kids: [] },
  ],
};

/** The rest of the vault, so the deep goal lives in a real tree and not alone. */
const OTHERS = [
  ["Schulden bei der Bank endlich vollstandig abbezahlen", [
    "Monatliche Rate mit der Bank neu verhandeln",
    "Alle Abos und Vertrage durchgehen und kundigen",
    "Einen Tilgungsplan bis Ende nachsten Jahres aufstellen",
  ]],
  ["Die Firma verkaufsfahig aufstellen und ubergeben", [
    "Buchhaltung der letzten drei Jahre prufen lassen",
    "Nachfolger fur die Produktionsleitung finden",
  ]],
  ["Wieder zehn Kilometer am Stuck laufen konnen", [
    "Zweimal pro Woche eine lockere Runde am Fluss laufen",
    "Ordentliche Laufschuhe mit Laufbandanalyse kaufen",
  ]],
  ["Ein Rucken, der morgens nicht mehr wehtut", [
    "Ruckenubungen jeden Morgen vor dem Fruhstuck",
    "Termin bei der Orthopadin ausmachen",
  ]],
  ["Spanisch bis zum Niveau B2 sprechen lernen", [
    "Jeden Tag zwanzig Minuten Vokabeln wiederholen",
    "Einen Konversationskurs am Abend suchen",
  ]],
  ["Die Werkstatt im Keller fertig einrichten", [
    "Werkbank und Regale aufbauen und verschrauben",
    "Alte Farbeimer und Reste zum Wertstoffhof bringen",
  ]],
];

const browser = await chromium.launch();
const problems = [];

async function fresh() {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => problems.push(`PAGEERROR ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`CONSOLE ${m.text()}`);
  });
  await page.goto(`${BASE}/web/index.html`);
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
  await page.waitForSelector(".h-title");
  return { context, page };
}

/** @param {number} at where in the ten the deep goal is ranked */
async function build(page, at) {
  await page.evaluate(
    async ({ deep, others, at: index }) => {
      const { ctx } = await import("/web/js/app.js");
      const add = (title, parentId) => {
        ctx.commitCompose(title, parentId, "stay");
        const kids = ctx.childrenOf(parentId);
        return kids[kids.length - 1].id;
      };
      const plan = others.slice();
      plan.splice(index, 0, null);
      for (const entry of plan) {
        if (entry === null) {
          const goal = add(deep.goal, null);
          for (const part of deep.parts) {
            const p = add(part.title, goal);
            for (const [title, status] of part.kids) {
              const id = add(title, p);
              if (status === "done") ctx.setStatus(id, "done");
            }
          }
          continue;
        }
        const goal = add(entry[0], null);
        for (const part of entry[1]) add(part, goal);
      }
      ctx.setSettings({ mapMode: "tree" });
      ctx.go("outline", null, { replace: true });
    },
    { deep: DEEP, others: OTHERS, at },
  );
  await page.waitForSelector(".row-shell");
  await page.waitForFunction(() => !document.querySelector(".toast.is-open"), null, { timeout: 20000 });
}

async function skin(page, name, theme) {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await page.getByRole("button", { name: theme, exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForTimeout(300);
}

async function shot(page, name) {
  await page.getByRole("button", { name: "Open the map" }).click();
  await page.waitForSelector(".mm-tree.is-ready");
  await page.waitForTimeout(1100);
  await page.screenshot({ path: `design/screens/${name}.png` });
  console.log("wrote", name);
}

/** The columns, as measured on the finished SVG - one number per depth+side. */
async function columns(page, label) {
  const rows = await page.locator(".mm-node").evaluateAll((list) =>
    list.map((g) => {
      const dot = g.querySelector(".mm-dot");
      const d = [...g.classList].find((c) => /^is-d\d$/.test(c));
      const title = g.querySelector(".mm-title");
      const box = title ? title.getBoundingClientRect() : null;
      return {
        d: d ? Number(d.slice(4)) : -1,
        x: dot ? Number(dot.getAttribute("cx")) : 0,
        left: box ? box.left : 0,
        right: box ? box.right : 0,
      };
    }),
  );
  const by = new Map();
  for (const r of rows) {
    const key = `${r.x < 0 ? "L" : "R"} d${r.d}`;
    const hit = by.get(key) || { xs: new Set(), ends: [] };
    hit.xs.add(Math.round(r.x * 10) / 10);
    hit.ends.push(Math.round((r.x < 0 ? r.left : r.right) * 10) / 10);
    by.set(key, hit);
  }
  console.log(`\n-- ${label}`);
  for (const key of [...by.keys()].sort()) {
    const hit = by.get(key);
    const ends = hit.ends.slice().sort((a, b) => a - b);
    console.log(
      `${key}  dot x = ${[...hit.xs].join(", ")}   text end px ${ends[0]}..${ends[ends.length - 1]}`,
    );
  }
}

// 1 - the deep goal ranked second: right branch, the shot from the report.
{
  const { context, page } = await fresh();
  await build(page, 1);
  await shot(page, `45-mm-depth-${STAGE}`);
  await columns(page, `${STAGE} right-side`);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await skin(page, "Register", "Light");
  await shot(page, `45-mm-depth-register-${STAGE}`);
  await context.close();
}

// 2 - the same goal ranked last: it falls to the LEFT branch, where the text is
// right-aligned and the indent had nowhere to show.
{
  const { context, page } = await fresh();
  await build(page, OTHERS.length);
  await shot(page, `45-mm-depth-left-${STAGE}`);
  await columns(page, `${STAGE} left-side`);
  await context.close();
}

console.log(problems.length ? `\nPROBLEMS: ${problems.join(" | ")}` : "\nno console errors");
await browser.close();
