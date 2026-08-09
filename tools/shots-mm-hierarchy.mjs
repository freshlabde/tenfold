// tools/shots-mm-hierarchy.mjs - the mind map's three voices, on the owner's
// own tree.
//
//   node tools/serve.js &
//   node tools/shots-mm-hierarchy.mjs
//
// Writes design/screens/41-mm-hierarchy-*.png at the reference iPhone size
// (390x844 CSS px, 2x device pixels). The tree is the one from the fit wave:
// nine German goals, parts under seven of them, grandchildren under two and one
// branch deeper still - the shape in which a goal used to disappear among its
// own parts, which is the whole thing these shots have to answer for.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:7710";
const PASS = "correct horse battery staple";

const GOALS = [
  "Schulden bei der Bank endlich vollständig abbezahlen",
  "Die Firma verkaufsfähig aufstellen und übergeben",
  "Wieder zehn Kilometer am Stück laufen können",
  "Die Sache mit Anna in Ruhe klären",
  "Meinen Vater regelmäßig jede Woche besuchen",
  "Ein Rücken, der morgens nicht mehr wehtut",
  "Spanisch bis zum Niveau B2 sprechen lernen",
  "Testament und Vorsorgevollmacht endlich regeln",
  "Die Werkstatt im Keller fertig einrichten",
];
const PARTS = [
  [0, ["Monatliche Rate mit der Bank neu verhandeln", "Alle Abos und Verträge durchgehen und kündigen", "Einen Tilgungsplan bis Ende nächsten Jahres aufstellen"]],
  [1, ["Buchhaltung der letzten drei Jahre prüfen lassen", "Nachfolger für die Produktionsleitung finden", "Bewertungsgutachten beim Steuerberater beauftragen"]],
  [2, ["Zweimal pro Woche eine lockere Runde am Fluss laufen", "Ordentliche Laufschuhe mit Laufbandanalyse kaufen"]],
  [4, ["Jeden Sonntagabend anrufen, ohne Ausnahme", "Einmal im Monat zum Mittagessen hinfahren"]],
  [5, ["Rückenübungen jeden Morgen vor dem Frühstück", "Termin bei der Orthopädin ausmachen"]],
  [6, ["Jeden Tag zwanzig Minuten Vokabeln wiederholen", "Einen Konversationskurs am Abend suchen"]],
  [8, ["Werkbank und Regale aufbauen und verschrauben", "Alte Farbeimer und Reste zum Wertstoffhof bringen"]],
];
const GRAND = [
  [0, ["Unterlagen für das Gespräch bei der Bank zusammenstellen", "Termin mit dem Berater der Sparkasse vereinbaren"]],
  [8, ["Suche nach Anfänger-Tutorial für Motorenreparatur (Vespa)", "Passendes Werkzeug für die Vespa zusammenstellen"]],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const problems = [];
page.on("pageerror", (e) => problems.push(`PAGEERROR ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`CONSOLE ${m.text()}`);
});

await page.goto(`${BASE}/web/index.html`);
await page.getByRole("button", { name: "Set up the vault" }).click();
await page.locator('input[type="password"]').first().fill(PASS);
await page.locator('input[type="password"]').nth(1).fill(PASS);
await page.getByRole("button", { name: /Create the vault/ }).click();
await page.waitForSelector(".keygrid", { timeout: 30000 });
await page.locator(".check").click();
await page.getByRole("button", { name: "Continue" }).click();
await page.getByRole("button", { name: /Start empty/ }).click();
await page.getByRole("button", { name: "Begin" }).click();
await page.waitForSelector(".h-title");

await page.evaluate(
  async ({ goals, parts, grand }) => {
    const { ctx } = await import("/web/js/app.js");
    const add = (title, parentId) => {
      ctx.commitCompose(title, parentId, "stay");
      const kids = ctx.childrenOf(parentId);
      return kids[kids.length - 1].id;
    };
    const rootIds = goals.map((title) => add(title, null));
    const firstPart = new Map();
    for (const [index, titles] of parts) {
      firstPart.set(index, titles.map((title) => add(title, rootIds[index]))[0]);
    }
    for (const [index, titles] of grand) {
      const kids = titles.map((title) => add(title, firstPart.get(index)));
      const deeper = add("Ersatzteilliste für den Vergaser der Vespa zusammenstellen und bestellen", kids[0]);
      for (let i = 0; i < 3; i += 1) add(`Teilbestellung Nummer ${i + 1} beim Händler aufgeben`, deeper);
    }
    // One goal finished, so the green seal is in every shot.
    ctx.setStatus(rootIds[3], "done");
    ctx.setSettings({ mapMode: "tree" });
    ctx.go("outline", null, { replace: true });
  },
  { goals: GOALS, parts: PARTS, grand: GRAND },
);
await page.waitForSelector(".row-shell");
// The undo toast of that setStatus would sit across the bottom of every shot.
await page.waitForFunction(() => !document.querySelector(".toast.is-open"), null, { timeout: 20000 });

const skin = async (name, theme) => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await page.getByRole("button", { name: theme, exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForTimeout(300);
};

const shot = async (name) => {
  await page.getByRole("button", { name: "Open the map" }).click();
  await page.waitForSelector(".mm-tree.is-ready");
  await page.waitForTimeout(1100);
  await page.screenshot({ path: `design/screens/${name}.png` });
  console.log("wrote", name);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForTimeout(300);
};

await shot("41-mm-hierarchy-slate-dark");
await skin("Register", "Dark");
await shot("41-mm-hierarchy-register-dark");
await skin("Register", "Light");
await shot("41-mm-hierarchy-register-light");
await skin("Breath", "Dark");
await shot("41-mm-hierarchy-breath-dark");
await skin("Slate", "Light");
await shot("41-mm-hierarchy-slate-light");

console.log(problems.length ? `PROBLEMS: ${problems.join(" | ")}` : "no console errors");
await browser.close();
