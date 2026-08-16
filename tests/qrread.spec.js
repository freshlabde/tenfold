// Reading a QR code back out of a photograph (stage 3c, the iOS path).
//
// The encoder was proven against fixed vectors and an independent reader. The
// READER has to be proven against pictures, because that is what it is given:
// a symbol at some size, at some angle, on something that is not paper white,
// lit unevenly, with a few modules wrong. Every case below draws the symbol
// with tests/qrdraw.js - deterministic, seeded, no Math.random - hands the
// pixels to decodeImage and demands the exact payload back.
//
// Four things are proven here that a round trip alone would not show:
//   1. The error CORRECTION works. Modules are flipped inside the capacity of
//      level M and the payload still comes back; flipped far past it, the
//      answer is null and never a different string. A decoder that guesses
//      would adopt the wrong vault.
//   2. The geometry survives rotation - including the diagonal, where a
//      horizontal scanline measures a module a factor of root two too wide.
//   3. The adopt screen now offers the scan button with no BarcodeDetector in
//      the page at all, and a photograph fed through its file input runs the
//      real adopt call against the test server.
//   4. Nothing in the new modules can reach the network or keep a picture.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PHONE = { width: 390, height: 844 };

/** A pairing-code-shaped id: 26 symbols of the sync alphabet. */
const FAKE_ID = "abcdefghjkmnpqrstvwxyz2345";

/**
 * One pairing URL per version 3 to 6 - the range a real pairing link lands in.
 * The sizes are asserted in the first test, so a mistyped length here shows up
 * as a failure instead of quietly testing version 4 four times.
 */
const PAYLOAD = {
  3: `http://a.io/#s=${FAKE_ID}`,
  4: `https://tenfold.example/#s=${FAKE_ID}`,
  5: `https://tenfold.example/pairing/device/#s=${FAKE_ID}`,
  6: `https://tenfold.example/pairing/device/handover/second/kitchen/table/#s=${FAKE_ID}`,
};

/** Draw a payload with the given options and read it back, all in the page. */
async function roundTrip(page, payload, opts) {
  return page.evaluate(
    async ({ value, options }) => {
      const qr = await import("/web/js/qr.js");
      const draw = await import("/tests/qrdraw.js");
      const { decodeImage } = await import("/web/js/qrread.js");
      const matrix = qr.qrMatrix(value);
      const image = draw.renderMatrix(matrix, options);
      return {
        text: decodeImage(image),
        size: matrix.length,
        width: image.width,
        height: image.height,
      };
    },
    { value: payload, options: opts },
  );
}

test.describe("still-image decoder", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await page.goto("/tests/fixture.html");
  });

  test("a pairing URL survives the round trip at versions 3 to 6", async ({ page }) => {
    for (const [version, payload] of Object.entries(PAYLOAD)) {
      const r = await roundTrip(page, payload, { module: 8 });
      expect(r.size, `payload for version ${version} is that version`).toBe(
        17 + Number(version) * 4,
      );
      expect(r.text, `version ${version}`).toBe(payload);
    }
  });

  test("module sizes from four to twelve pixels all read", async ({ page }) => {
    for (const module of [4, 5, 6, 8, 10, 12]) {
      const r = await roundTrip(page, PAYLOAD[4], { module });
      expect(r.text, `module ${module}px`).toBe(PAYLOAD[4]);
    }
  });

  test("the symbol is read at any angle, the diagonal included", async ({ page }) => {
    // 45 degrees is the case that catches a naive reader: a horizontal
    // scanline through a finder pattern reports runs that are a factor of
    // root two too long, so a module width taken from it gives the wrong
    // version. Every 15 degrees, all the way round.
    for (let degrees = 0; degrees < 360; degrees += 15) {
      const r = await roundTrip(page, PAYLOAD[5], { module: 6, rotate: degrees });
      expect(r.text, `rotated ${degrees} degrees`).toBe(PAYLOAD[5]);
    }
  });

  test("a symbol photographed from the side is straightened out", async ({ page }) => {
    const cases = await page.evaluate(
      async ({ value }) => {
        const qr = await import("/web/js/qr.js");
        const draw = await import("/tests/qrdraw.js");
        const { decodeImage } = await import("/web/js/qrread.js");
        const matrix = qr.qrMatrix(value);
        const span = (matrix.length + 8) * 7;
        const out = [];
        for (const k of [0.04, 0.08, 0.12]) {
          // The top edge narrower than the bottom: looking up at a screen.
          out.push({
            name: `top ${k}`,
            text: decodeImage(
              draw.renderMatrix(matrix, {
                module: 7,
                corners: [
                  [span * k, 0],
                  [span * (1 - k), 0],
                  [span, span],
                  [0, span],
                ],
              }),
            ),
          });
          // And the left edge shorter than the right: standing beside it.
          out.push({
            name: `side ${k}`,
            text: decodeImage(
              draw.renderMatrix(matrix, {
                module: 7,
                corners: [
                  [0, span * k],
                  [span, 0],
                  [span, span],
                  [0, span * (1 - k)],
                ],
              }),
            ),
          });
        }
        return out;
      },
      { value: PAYLOAD[4] },
    );
    for (const item of cases) expect(item.text, item.name).toBe(PAYLOAD[4]);
  });

  test("grain, uneven light and a paper that is not white are all survivable", async ({ page }) => {
    const grey = { paper: 234, ink: 46 };
    for (const seed of [1, 2, 3]) {
      const r = await roundTrip(page, PAYLOAD[4], { module: 8, ...grey, noise: 18, seed });
      expect(r.text, `speckle, seed ${seed}`).toBe(PAYLOAD[4]);
    }
    for (const gradient of [0.2, 0.35, 0.5]) {
      const r = await roundTrip(page, PAYLOAD[4], { module: 8, ...grey, gradient });
      expect(r.text, `lit unevenly, ${gradient}`).toBe(PAYLOAD[4]);
    }
    // A shadow across the frame is what the tile-based threshold exists for:
    // one level for the whole picture cannot separate this.
    const hard = await roundTrip(page, PAYLOAD[5], {
      module: 7,
      paper: 250,
      ink: 30,
      gradient: 0.55,
      noise: 10,
      seed: 4,
    });
    expect(hard.text).toBe(PAYLOAD[5]);
  });

  test("a thin quiet zone and a dark surround do not stop the read", async ({ page }) => {
    for (const quiet of [1, 2, 3, 4]) {
      const light = await roundTrip(page, PAYLOAD[4], { module: 8, quiet });
      expect(light.text, `quiet zone ${quiet}, light surround`).toBe(PAYLOAD[4]);
      const dark = await roundTrip(page, PAYLOAD[4], { module: 8, quiet, margin: "dark" });
      expect(dark.text, `quiet zone ${quiet}, dark surround`).toBe(PAYLOAD[4]);
    }
  });

  test("everything at once: small, tilted, grey, grainy", async ({ page }) => {
    const results = await page.evaluate(
      async ({ value }) => {
        const qr = await import("/web/js/qr.js");
        const draw = await import("/tests/qrdraw.js");
        const { decodeImage } = await import("/web/js/qrread.js");
        const matrix = qr.qrMatrix(value);
        const span = (matrix.length + 8) * 7;
        const out = [];
        for (let seed = 1; seed <= 5; seed += 1) {
          out.push(
            decodeImage(
              draw.renderMatrix(matrix, {
                module: 7,
                corners: [
                  [span * 0.07, span * 0.02],
                  [span * 0.97, 0],
                  [span, span * 0.95],
                  [0, span],
                ],
                paper: 236,
                ink: 44,
                gradient: 0.25,
                noise: 8 + seed * 2,
                seed,
              }),
            ),
          );
        }
        return out;
      },
      { value: PAYLOAD[4] },
    );
    for (const text of results) expect(text).toBe(PAYLOAD[4]);
  });

  // --------------------------------------------------------- error correction

  test("wrong modules within the level M capacity are repaired", async ({ page }) => {
    // Version 4 at level M is two blocks of 32 data plus 18 parity codewords,
    // so each block carries nine correctable codeword errors. Flipping up to
    // eight modules can spoil at most eight codewords - inside capacity even
    // if every one of them lands in the same block.
    const results = await page.evaluate(
      async ({ value }) => {
        const qr = await import("/web/js/qr.js");
        const draw = await import("/tests/qrdraw.js");
        const dec = await import("/tests/qrdecode.js");
        const { decodeImage, decodeMatrix } = await import("/web/js/qrread.js");
        const matrix = qr.qrMatrix(value);
        const reserved = dec.reservedMap(matrix.length, 4);
        const out = [];
        for (const count of [1, 3, 5, 8]) {
          for (const seed of [11, 22, 33]) {
            const broken = draw.flipModules(matrix, reserved, count, seed);
            out.push({
              count,
              seed,
              // Once as a bare matrix, once through the whole picture path.
              matrix: decodeMatrix(broken),
              image: decodeImage(draw.renderMatrix(broken, { module: 8 })),
              // The damage is real: the modules genuinely differ.
              changed: broken.reduce(
                (n, row, r) => n + row.filter((v, c) => v !== matrix[r][c]).length,
                0,
              ),
            });
          }
        }
        return out;
      },
      { value: PAYLOAD[4] },
    );

    for (const r of results) {
      expect(r.changed, `${r.count} flips, seed ${r.seed}`).toBe(r.count);
      expect(r.matrix, `matrix with ${r.count} flips, seed ${r.seed}`).toBe(PAYLOAD[4]);
      expect(r.image, `photo with ${r.count} flips, seed ${r.seed}`).toBe(PAYLOAD[4]);
    }
  });

  test("damage past the capacity gives null, never a different string", async ({ page }) => {
    const results = await page.evaluate(
      async ({ value }) => {
        const qr = await import("/web/js/qr.js");
        const draw = await import("/tests/qrdraw.js");
        const dec = await import("/tests/qrdecode.js");
        const { decodeImage, decodeMatrix } = await import("/web/js/qrread.js");
        const matrix = qr.qrMatrix(value);
        const reserved = dec.reservedMap(matrix.length, 4);
        const out = [];
        for (const count of [40, 70, 120]) {
          for (let seed = 1; seed <= 6; seed += 1) {
            const broken = draw.flipModules(matrix, reserved, count, seed);
            out.push({
              count,
              seed,
              matrix: decodeMatrix(broken),
              image: decodeImage(draw.renderMatrix(broken, { module: 8 })),
            });
          }
        }
        return out;
      },
      { value: PAYLOAD[4] },
    );

    for (const r of results) {
      expect(r.matrix, `matrix, ${r.count} flips, seed ${r.seed}`).toBeNull();
      expect(r.image, `photo, ${r.count} flips, seed ${r.seed}`).toBeNull();
    }
  });

  test("nothing in the frame is null, and it comes back quickly", async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { decodeImage } = await import("/web/js/qrread.js");
      const width = 1400;
      const height = 1050;
      const data = new Uint8ClampedArray(width * height * 4);
      // A flat grey wall with a little grain, deterministically.
      let state = 99;
      for (let i = 0; i < width * height; i += 1) {
        state = (state * 1664525 + 1013904223) >>> 0;
        const v = 190 + (state % 20);
        data[i * 4] = v;
        data[i * 4 + 1] = v;
        data[i * 4 + 2] = v;
        data[i * 4 + 3] = 255;
      }
      const started = performance.now();
      const text = decodeImage({ data, width, height });
      return { text, ms: performance.now() - started };
    });
    expect(r.text).toBeNull();
    // The whole point of the fallback is that it feels like a scan, not a wait.
    expect(r.ms).toBeLessThan(4000);
  });

  test("rubbish in gives null out and never an exception", async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { decodeImage, decodeMatrix } = await import("/web/js/qrread.js");
      const out = [];
      const push = (name, fn) => {
        try {
          out.push({ name, value: fn(), threw: false });
        } catch (err) {
          out.push({ name, value: String(err), threw: true });
        }
      };
      push("null", () => decodeImage(null));
      push("undefined", () => decodeImage(undefined));
      push("number", () => decodeImage(42));
      push("empty object", () => decodeImage({}));
      push("zero sized", () => decodeImage({ data: new Uint8ClampedArray(0), width: 0, height: 0 }));
      push("matrix null", () => decodeMatrix(null));
      push("matrix empty", () => decodeMatrix([]));
      push("matrix ragged", () => decodeMatrix([[true], [true, false]]));
      push("matrix wrong size", () =>
        decodeMatrix(Array.from({ length: 20 }, () => new Array(20).fill(false))),
      );
      push("matrix all light", () =>
        decodeMatrix(Array.from({ length: 33 }, () => new Array(33).fill(false))),
      );
      return out;
    });
    for (const item of r) {
      expect(item.threw, `${item.name} threw`).toBe(false);
      expect(item.value, item.name).toBeNull();
    }
  });
});

// ------------------------------------------------------------------ the sheet

async function freshAdoptStep(page) {
  await page.setViewportSize(PHONE);
  await page.goto("/web/index.html");
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
  await page.getByRole("button", { name: "Open from another device" }).click();
  await expect(page.locator(".h-title")).toHaveText("Open an existing vault");
}

/** A PNG of the pairing QR, built in the page and carried out as bytes. */
async function qrPng(page, payload, opts = {}) {
  const dataUrl = await page.evaluate(
    async ({ value, options }) => {
      const qr = await import("/web/js/qr.js");
      const draw = await import("/tests/qrdraw.js");
      const image = draw.renderMatrix(qr.qrMatrix(value), options);
      return draw.toCanvas(image).toDataURL("image/png");
    },
    { value: payload, options: opts },
  );
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

test.describe("the photo scan path", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeEach(async ({ page }) => {
    // The whole point: a browser with no BarcodeDetector must still offer a
    // camera path. Chromium has none here anyway; deleting it makes the
    // premise explicit and keeps the test true if a future build adds one.
    await page.addInitScript(() => {
      delete window.BarcodeDetector;
    });
  });

  test("the adopt step shows the scan button without a BarcodeDetector", async ({ page }) => {
    await freshAdoptStep(page);
    expect(await page.evaluate(() => "BarcodeDetector" in window)).toBe(false);

    await expect(page.getByRole("button", { name: "Scan code" })).toBeVisible();
    // Behind it: the native camera, through a file input asking for the back
    // camera. Not a live preview - that is what this platform cannot do.
    const input = page.locator("input.photoscan-file");
    await expect(input).toHaveCount(1);
    await expect(input).toHaveAttribute("accept", "image/*");
    await expect(input).toHaveAttribute("capture", "environment");
    // And the typed path is exactly as it was.
    await expect(page.locator(".input.is-mono")).toBeVisible();
    await expect(page.getByRole("button", { name: /Fetch the vault/ })).toBeVisible();
  });

  test("a photograph of the code fills the field and runs the adopt call", async ({ page }) => {
    await freshAdoptStep(page);
    const png = await qrPng(page, `https://example.test/#s=${FAKE_ID}`, {
      module: 9,
      paper: 240,
      ink: 40,
      noise: 6,
      seed: 5,
    });

    await page.locator("input.photoscan-file").setInputFiles({
      name: "code.png",
      mimeType: "image/png",
      buffer: png,
    });

    // The code lands in the typed field and the adopt call really runs - the
    // id is not on this server, so the honest answer comes back.
    await expect(page.locator(".field-error")).toHaveText("No vault found for that code.", {
      timeout: 60000,
    });
    expect(await page.locator(".input.is-mono").inputValue()).toBe(FAKE_ID);
    // The reading sheet closed itself on the hit, and the picture was let go.
    await expect(page.locator(".sheet")).toHaveCount(0);
    expect(await page.locator("input.photoscan-file").inputValue()).toBe("");
  });

  test("a photo the reader cannot use says so and leaves the typed path alone", async ({ page }) => {
    await freshAdoptStep(page);
    // A picture with no symbol in it at all.
    const blank = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 240;
      canvas.height = 240;
      const g = canvas.getContext("2d");
      g.fillStyle = "#b8b8b8";
      g.fillRect(0, 0, 240, 240);
      return canvas.toDataURL("image/png");
    });

    await page.locator("input.photoscan-file").setInputFiles({
      name: "wall.png",
      mimeType: "image/png",
      buffer: Buffer.from(blank.split(",")[1], "base64"),
    });

    await expect(page.locator(".sheet .field-hint")).toHaveText(
      "Could not read the code from the photo. Try again closer and straight-on - or point the iPhone camera app at the code; the link opens tenfold directly.",
      { timeout: 60000 },
    );
    // Both ways out are offered, and neither has touched the document.
    await expect(page.locator(".sheet-foot").getByRole("button", { name: "Take another photo" })).toBeEnabled();
    await page.locator(".sheet-foot").getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".sheet")).toHaveCount(0);

    await page.locator(".input.is-mono").fill(FAKE_ID);
    await page.getByRole("button", { name: /Fetch the vault/ }).click();
    await expect(page.locator(".field-error")).toHaveText("No vault found for that code.", {
      timeout: 60000,
    });
  });

  test("a foreign QR code is not mistaken for a pairing code", async ({ page }) => {
    await freshAdoptStep(page);
    const png = await qrPng(page, "https://example.test/something/else", { module: 9 });
    await page.locator("input.photoscan-file").setInputFiles({
      name: "other.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect(page.locator(".sheet .field-hint")).toHaveText(
      "Could not read the code from the photo. Try again closer and straight-on - or point the iPhone camera app at the code; the link opens tenfold directly.",
      { timeout: 60000 },
    );
    expect(await page.locator(".input.is-mono").inputValue()).toBe("");
  });
});

// ------------------------------------------------------------- source rules

/** Strip comments so prose about a rule cannot trip the rule. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("the reader never reaches the network and keeps no picture", async () => {
  const reader = stripComments(await readFile(join(ROOT, "web/js/qrread.js"), "utf8"));
  for (const rx of [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /sendBeacon/,
    /new\s+WebSocket/,
    /localStorage/,
    /sessionStorage/,
    /indexedDB/,
    /toDataURL/,
    /toBlob/,
  ]) {
    expect(rx.test(reader), `qrread.js matches ${rx}`).toBe(false);
  }

  const sheet = stripComments(await readFile(join(ROOT, "web/js/ui/photoscan.js"), "utf8"));
  for (const rx of [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /sendBeacon/,
    /new\s+WebSocket/,
    /localStorage/,
    /sessionStorage/,
    /indexedDB/,
    /toDataURL/,
    /toBlob/,
    /getImageData/,
  ]) {
    expect(rx.test(sheet), `photoscan.js matches ${rx}`).toBe(false);
  }
  // The picture is let go in exactly one place, like the camera in scan.js.
  expect((sheet.match(/input\.value = ""/g) || []).length).toBe(1);
});

test("the reader borrows the encoder's field instead of copying it", async () => {
  const reader = await readFile(join(ROOT, "web/js/qrread.js"), "utf8");
  // No second GF(256) table, no second block table: they are imported, so a
  // corrected codeword is checked in the field its parity was written in.
  expect(reader).toMatch(/from "\.\/qr\.js"/);
  expect(stripComments(reader)).not.toMatch(/0x11d/);
  expect(stripComments(reader)).not.toMatch(/ec:\s*\d+,\s*groups/);
});

test("both new modules are in the service worker shell", async () => {
  const sw = await readFile(join(ROOT, "web/sw.js"), "utf8");
  expect(sw).toContain('const VERSION = "tenfold-v70"');
  expect(sw).toContain('"./js/qrread.js"');
  expect(sw).toContain('"./js/ui/photoscan.js"');
});
