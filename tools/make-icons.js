// tools/make-icons.js - rasterise the two icon SVGs into the PNG sizes the
// web app manifest and the browser tab ask for. Run manually after the SVGs
// change:
//
//   node tools/make-icons.js
//
// Uses the Playwright browser that is already a dev dependency, so no image
// library is added to the project. Writes only into web/icons/.
//
// Three things here are deliberate:
//
//   - icons/icon.svg is transparent, because it is the mark itself. The
//     square icons a home screen and a tab want are not transparent, so the
//     plate is applied here at raster time. Its colours are the same two the
//     plate in icon-maskable.svg uses; that file is the source of truth, this
//     is a copy of two hex values, and they must move together.
//   - the mark is drawn at 90% inside the plated tiles. It already fills ~88%
//     of its own viewBox, so 90% leaves the margin an iOS squircle needs
//     without making the mark look lost.
//   - colorScheme is pinned to dark. icon.svg carries a prefers-color-scheme
//     rule so the favicon can darken against a light browser chrome, and
//     Playwright would otherwise default to light and bake that variant into
//     every PNG.
import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS = resolve(HERE, "..", "web", "icons");

const PLATE = "linear-gradient(180deg, #262B35, #141820)";

const JOBS = [
  // Plated here: the mark on the app's own surface, 90% of the tile.
  { svg: "icon.svg", out: "icon-192.png", size: 192, plate: true, scale: 0.9 },
  { svg: "icon.svg", out: "icon-512.png", size: 512, plate: true, scale: 0.9 },
  { svg: "icon.svg", out: "favicon-32.png", size: 32, plate: true, scale: 0.9 },
  // Already plated, and already inset to its safe zone, so drawn full-bleed.
  { svg: "icon-maskable.svg", out: "icon-192-maskable.png", size: 192, scale: 1 },
  { svg: "icon-maskable.svg", out: "icon-512-maskable.png", size: 512, scale: 1 },
];

const browser = await chromium.launch();
for (const job of JOBS) {
  const svg = await readFile(resolve(ICONS, job.svg), "utf8");
  const box = Math.round(job.size * job.scale);
  const page = await browser.newPage({
    viewport: { width: job.size, height: job.size },
    colorScheme: "dark",
  });
  await page.setContent(
    `<style>
       html, body { margin: 0; padding: 0; height: 100%; }
       body {
         background: ${job.plate ? PLATE : "transparent"};
         display: grid; place-items: center;
       }
       svg { display: block; width: ${box}px; height: ${box}px; }
     </style>${svg}`,
    { waitUntil: "load" },
  );
  const png = await page.screenshot({ omitBackground: !job.plate });
  await writeFile(resolve(ICONS, job.out), png);
  await page.close();
  console.log(`wrote ${job.out} (${job.size}x${job.size})`);
}
await browser.close();
