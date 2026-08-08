// tools/make-icons.js - rasterise the two icon SVGs into the PNG sizes the
// web app manifest asks for. Run manually after the SVGs change:
//
//   node tools/make-icons.js
//
// Uses the Playwright browser that is already a dev dependency, so no image
// library is added to the project. Writes only into web/icons/.
import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS = resolve(HERE, "..", "web", "icons");

const JOBS = [
  { svg: "icon.svg", out: "icon-192.png", size: 192 },
  { svg: "icon.svg", out: "icon-512.png", size: 512 },
  { svg: "icon-maskable.svg", out: "icon-192-maskable.png", size: 192 },
  { svg: "icon-maskable.svg", out: "icon-512-maskable.png", size: 512 },
];

const browser = await chromium.launch();
for (const job of JOBS) {
  const svg = await readFile(resolve(ICONS, job.svg), "utf8");
  const page = await browser.newPage({ viewport: { width: job.size, height: job.size } });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${job.size}px;height:${job.size}px}</style>${svg}`,
    { waitUntil: "load" },
  );
  const png = await page.screenshot({ omitBackground: true });
  await writeFile(resolve(ICONS, job.out), png);
  await page.close();
  console.log(`wrote ${job.out} (${job.size}x${job.size})`);
}
await browser.close();
