// QR pairing (stage 3c).
//
// The encoder in web/js/qr.js is our own, so it has to be proven rather than
// trusted. This suite does that on four independent legs:
//
//   1. FIXED MATRICES. Two payloads are pinned module by module. The version 1
//      one ("A1") is hand-derivable: its data codewords are written out in the
//      comment below and asserted separately, and its landmarks (finders,
//      timing, dark module, format bits) are checked against the standard.
//   2. AN INDEPENDENT READER (tests/qrdecode.js) walks each symbol back the
//      other way and returns the payload. It shares no code with the encoder,
//      derives the reserved map from the pattern geometry instead of the
//      drawing routine, and proves the parity by evaluating the codeword
//      polynomial at the roots of the generator - the definition of the code -
//      instead of repeating a division.
//   3. PUBLISHED VECTORS. The 15-bit format strings for level M and the 18-bit
//      version strings for versions 7 to 10 come from the standard's tables,
//      not from our BCH routine.
//   4. STRUCTURE. Dimensions, finder corners, timing alternation, the dark
//      module, both format copies agreeing, and the version boundaries landing
//      exactly on the published byte capacities.
//
// Chromium ships no BarcodeDetector on this platform - it was probed, and
// window.BarcodeDetector is undefined even with the shape-detection flags - so
// there is no decode round trip through a foreign decoder here. Legs 1 to 4
// are what stands in for it. The scanner tests below stub the detector, which
// is also what lets them prove the camera is released.
import { test, expect } from "@playwright/test";

const PHONE = { width: 390, height: 844 };
const PASS = "correct horse battery staple";

// A pairing-code-shaped id: 26 symbols of the sync alphabet.
const FAKE_ID = "abcdefghjkmnpqrstvwxyz2345";

/**
 * Version 1, level M, byte mode, payload "A1". Derived by hand:
 *   mode 0100 | count 00000010 | 'A' 01000001 | '1' 00110001 | terminator 0000
 *   -> 64, 36, 19, 16, then the pad bytes 236, 17 to sixteen codewords.
 * The landmarks of the matrix below are checked against the standard in
 * "the fixed version 1 matrix carries the landmarks the standard prescribes".
 */
const A1_MATRIX = [
  "111111100101101111111",
  "100000101000001000001",
  "101110100111001011101",
  "101110100101101011101",
  "101110101101101011101",
  "100000100011001000001",
  "111111101010101111111",
  "000000000100000000000",
  "101010100110100010010",
  "110100010001010101001",
  "111110110101011101101",
  "000010000001110111000",
  "011000111101011100101",
  "000000001000001000110",
  "111111100110100010011",
  "100000100010001000111",
  "101110101110101010101",
  "101110100001010101010",
  "101110101011011101101",
  "100000100011110111010",
  "111111101101011101111",
];

const A1_CODEWORDS = [64, 36, 19, 16, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17];

/** A pairing URL of the shape this app produces: 53 bytes, version 4. */
const URL_PAYLOAD = "https://tenfold.example/#s=abcdefghjkmnpqrstvwxyz2345";

const URL_MATRIX = [
  "111111101111000010111101001111111",
  "100000101001101001101111101000001",
  "101110100011011110110011101011101",
  "101110101110100100101011001011101",
  "101110100000100010011110101011101",
  "100000100110000110110000001000001",
  "111111101010101010101010101111111",
  "000000001011100111000001100000000",
  "101101110101101111111100001001011",
  "101011011101110011111101001101101",
  "011100100111110010100111010111011",
  "000001001111100011011001111101011",
  "111111101010001110011010010111010",
  "001100011100101001011010110100010",
  "010100110011111000111000101111100",
  "010010011001100100010101111011100",
  "001011110000101000001101011011100",
  "101011000111110100001111101011011",
  "011110101001001110101100100110110",
  "100100001100100011101000101010011",
  "111011111100010110011101100001100",
  "100101000111100111010011011000001",
  "001100101000001100101111011111011",
  "010110010000011100100011010001000",
  "101001111011000011100010111110010",
  "000000001000111100010101100011000",
  "111111101100011001110011101010000",
  "100000101010111001100111100011100",
  "101110100001000011110111111110111",
  "101110101100101010000001000100101",
  "101110101001010111100111101100000",
  "100000100111100001111010101110001",
  "111111101001101001101101000010100",
];

/** Matrix -> the same row-strings the fixtures above are written in. */
async function rows(page, text) {
  return page.evaluate(async (value) => {
    const qr = await import("/web/js/qr.js");
    return qr.qrMatrix(value).map((row) => row.map((v) => (v ? "1" : "0")).join(""));
  }, text);
}

// --------------------------------------------------------------- the encoder

test.describe("encoder", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/tests/fixture.html");
  });

  test("the fixed version 1 matrix is reproduced exactly", async ({ page }) => {
    expect(await rows(page, "A1")).toEqual(A1_MATRIX);
  });

  test("the fixed version 4 matrix is reproduced exactly", async ({ page }) => {
    expect(await rows(page, URL_PAYLOAD)).toEqual(URL_MATRIX);
  });

  test("the fixed version 1 matrix carries the landmarks the standard prescribes", async () => {
    const m = A1_MATRIX;
    const size = m.length;
    expect(size).toBe(21);
    for (const row of m) expect(row.length).toBe(21);

    // Three finders, and deliberately none in the fourth corner.
    const finder = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"];
    const patch = (r0, c0) => m.slice(r0, r0 + 7).map((row) => row.slice(c0, c0 + 7));
    expect(patch(0, 0)).toEqual(finder);
    expect(patch(0, size - 7)).toEqual(finder);
    expect(patch(size - 7, 0)).toEqual(finder);
    expect(patch(size - 7, size - 7)).not.toEqual(finder);

    // Separators: the row and the column of light modules that fence each
    // finder off. The timing lines start beyond them, at index 8.
    expect(m[7].slice(0, 8)).toBe("00000000");
    for (let r = 0; r < 8; r += 1) expect(m[r][7], `separator row ${r}`).toBe("0");
    expect(m[7].slice(size - 8)).toBe("00000000");

    // Timing: alternating, dark on even indices, between the finders.
    for (let i = 8; i < size - 8; i += 1) {
      expect(m[6][i], `row 6 col ${i}`).toBe(i % 2 === 0 ? "1" : "0");
      expect(m[i][6], `row ${i} col 6`).toBe(i % 2 === 0 ? "1" : "0");
    }

    // The one module that is dark in every symbol ever printed.
    expect(m[size - 8][8]).toBe("1");

    // Format information, first copy, against the published level M string
    // for mask 0: bit i sits at row i, column 8 for i = 0..5.
    const formatM0 = "101010000010010";
    const bit = (i) => formatM0[14 - i];
    for (let i = 0; i <= 5; i += 1) expect(m[i][8], `format bit ${i}`).toBe(bit(i));
    expect(m[7][8]).toBe(bit(6));
    expect(m[8][8]).toBe(bit(7));
    expect(m[8][7]).toBe(bit(8));
    for (let i = 9; i < 15; i += 1) expect(m[8][14 - i], `format bit ${i}`).toBe(bit(i));
  });

  test("the hand-derived data codewords of \"A1\" come back out of the symbol", async ({ page }) => {
    const r = await page.evaluate(async (fixture) => {
      const dec = await import("/tests/qrdecode.js");
      const matrix = fixture.map((row) => row.split("").map((ch) => ch === "1"));
      return dec.decode(matrix);
    }, A1_MATRIX);
    expect(r.version).toBe(1);
    expect(r.mode).toBe(4);
    expect(r.len).toBe(2);
    expect(r.text).toBe("A1");
    expect(r.data).toEqual(A1_CODEWORDS);
    expect(r.badBlocks).toEqual([]);
  });

  test("the independent reader gets every payload back, with clean parity", async ({ page }) => {
    // One payload per version: the lengths are the published byte capacities
    // at level M, so each pair straddles a version boundary.
    const payloads = [
      "A1",
      URL_PAYLOAD,
      "tenfold",
      "x".repeat(14),
      "y".repeat(15),
      "x".repeat(26),
      "y".repeat(27),
      "x".repeat(42),
      "y".repeat(62),
      "x".repeat(84),
      "y".repeat(106),
      "x".repeat(122),
      "y".repeat(152),
      "x".repeat(180),
      "y".repeat(213),
      "Grüße aus München - a few multi-byte characters",
    ];
    const results = await page.evaluate(async (list) => {
      const qr = await import("/web/js/qr.js");
      const dec = await import("/tests/qrdecode.js");
      return list.map((value) => {
        const matrix = qr.qrMatrix(value);
        const read = dec.decode(matrix);
        return {
          value,
          text: read.text,
          version: read.version,
          size: read.size,
          badBlocks: read.badBlocks,
          mode: read.mode,
          formatFirst: read.format.first,
          formatSecond: read.format.second,
          mask: read.format.mask,
          versionInfo: read.versionInfo,
          // Every codeword the symbol can hold is consumed by the blocks:
          // nothing is left over, so the interleaving is complete.
          leftover: read.streamLength - read.consumed,
        };
      });
    }, payloads);

    for (const r of results) {
      expect(r.text, `payload of length ${r.value.length}`).toBe(r.value);
      expect(r.badBlocks, `parity of length ${r.value.length}`).toEqual([]);
      expect(r.mode).toBe(4);
      expect(r.size).toBe(17 + r.version * 4);
      expect(r.mask).toBeGreaterThanOrEqual(0);
      // Both copies of the format information say the same thing.
      expect(r.formatFirst).toBe(r.formatSecond);
      expect(r.leftover).toBe(0);
      if (r.version >= 7) expect(r.versionInfo.length).toBe(18);
      else expect(r.versionInfo).toBe("");
    }
  });

  test("versions are chosen at the published byte capacities of level M", async ({ page }) => {
    const capacities = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
    const sizes = await page.evaluate(async (caps) => {
      const qr = await import("/web/js/qr.js");
      const out = [];
      for (let i = 0; i < caps.length; i += 1) {
        out.push({
          atLimit: qr.qrMatrix("x".repeat(caps[i])).length,
          overLimit: i + 1 < caps.length ? qr.qrMatrix("x".repeat(caps[i] + 1)).length : null,
        });
      }
      return out;
    }, capacities);

    for (let i = 0; i < capacities.length; i += 1) {
      const version = i + 1;
      expect(sizes[i].atLimit, `${capacities[i]} bytes fit version ${version}`).toBe(17 + version * 4);
      if (sizes[i].overLimit !== null) {
        expect(sizes[i].overLimit, `${capacities[i] + 1} bytes need version ${version + 1}`).toBe(
          17 + (version + 1) * 4,
        );
      }
    }
  });

  test("a payload past version 10 is refused rather than truncated", async ({ page }) => {
    const thrown = await page.evaluate(async () => {
      const qr = await import("/web/js/qr.js");
      try {
        qr.qrMatrix("x".repeat(214));
        return null;
      } catch (err) {
        return err.name;
      }
    });
    expect(thrown).toBe("RangeError");
  });

  test("format and version information match the published tables", async ({ page }) => {
    const r = await page.evaluate(async () => {
      const qr = await import("/web/js/qr.js");
      const dec = await import("/tests/qrdecode.js");
      const bin = (v, n) => v.toString(2).padStart(n, "0");
      return {
        formats: [0, 1, 2, 3, 4, 5, 6, 7].map((m) => bin(qr.formatBits(m), 15)),
        published: dec.FORMAT_M,
        versions: [7, 8, 9, 10].map((v) => bin(qr.versionBits(v), 18)),
        publishedVersions: [7, 8, 9, 10].map((v) => dec.VERSION_STRINGS[v]),
      };
    });
    expect(r.formats).toEqual(r.published);
    expect(r.versions).toEqual(r.publishedVersions);
  });

  test("the version information block is written into both of its corners", async ({ page }) => {
    const r = await page.evaluate(async () => {
      const qr = await import("/web/js/qr.js");
      const dec = await import("/tests/qrdecode.js");
      const out = [];
      for (const [version, length] of [[7, 122], [8, 152], [9, 180], [10, 213]]) {
        const m = qr.qrMatrix("x".repeat(length));
        const size = m.length;
        // The block below the top-right finder and its transposed twin at the
        // bottom left must agree, module for module.
        let mirrored = true;
        for (let i = 0; i < 18; i += 1) {
          const a = size - 11 + (i % 3);
          const b = Math.floor(i / 3);
          if (m[b][a] !== m[a][b]) mirrored = false;
        }
        out.push({ version, read: dec.readVersionInfo(m), expected: dec.VERSION_STRINGS[version], mirrored });
      }
      return out;
    });
    for (const item of r) {
      expect(item.read, `version ${item.version}`).toBe(item.expected);
      expect(item.mirrored, `version ${item.version} mirrored`).toBe(true);
    }
  });

  test("the chosen mask is the one with the lowest penalty", async ({ page }) => {
    const r = await page.evaluate(async (payloads) => {
      const qr = await import("/web/js/qr.js");
      const dec = await import("/tests/qrdecode.js");
      return payloads.map((value) => {
        const matrix = qr.qrMatrix(value);
        const version = (matrix.length - 17) / 4;
        const chosen = dec.readFormat(matrix).mask;
        const scores = [];
        for (let mask = 0; mask < 8; mask += 1) {
          scores.push(dec.penaltyScore(dec.withMask(matrix, chosen, mask, version)));
        }
        return { value, chosen, scores };
      });
    }, ["A1", URL_PAYLOAD, "x".repeat(106), "y".repeat(152)]);

    for (const item of r) {
      const best = Math.min(...item.scores);
      expect(item.scores[item.chosen], `payload ${item.value.slice(0, 12)}`).toBe(best);
      // Ties go to the lowest index, which is what the encoder does.
      expect(item.chosen).toBe(item.scores.indexOf(best));
    }
  });

  test("the encoder is pure: same text in, same matrix out, nothing shared", async ({ page }) => {
    const same = await page.evaluate(async () => {
      const qr = await import("/web/js/qr.js");
      const a = qr.qrMatrix("A1");
      const b = qr.qrMatrix("A1");
      // Mutating one result must not reach the other.
      a[0][0] = !a[0][0];
      const c = qr.qrMatrix("A1");
      return JSON.stringify(b) === JSON.stringify(c);
    });
    expect(same).toBe(true);
  });

  test("the SVG path covers exactly the dark modules", async ({ page }) => {
    const r = await page.evaluate(async (payload) => {
      const qr = await import("/web/js/qr.js");
      const matrix = qr.qrMatrix(payload);
      const d = qr.qrPath(matrix, 4);
      const size = matrix.length;
      const drawn = [];
      for (let i = 0; i < size; i += 1) drawn.push(new Array(size).fill(false));
      let commands = 0;
      for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
        commands += 1;
        const col = Number(m[1]) - 4;
        const row = Number(m[2]) - 4;
        const run = Number(m[3]);
        if (Number(m[4]) !== run) return { mismatch: "run length" };
        for (let k = 0; k < run; k += 1) drawn[row][col + k] = true;
      }
      // Nothing outside those commands is in the string.
      const residue = d.replace(/M\d+ \d+h\d+v1h-\d+z/g, "");
      return {
        equal: JSON.stringify(drawn) === JSON.stringify(matrix),
        residue,
        commands,
        modules: matrix.flat().filter(Boolean).length,
      };
    }, URL_PAYLOAD);
    expect(r.mismatch).toBeUndefined();
    expect(r.residue).toBe("");
    expect(r.equal).toBe(true);
    // Runs are merged, so there are fewer commands than dark modules.
    expect(r.commands).toBeLessThan(r.modules);
  });
});

// ------------------------------------------------------------ the sheet UI

test.describe("pairing sheet", () => {
  test.describe.configure({ timeout: 240_000 });

  test("the sheet shows a QR that carries the pairing link, next to the code", async ({ page }) => {
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

    await page.getByRole("button", { name: "Set up the vault" }).click();
    await page.locator('input[type="password"]').first().fill(PASS);
    await page.locator('input[type="password"]').nth(1).fill(PASS);
    await page.getByRole("button", { name: /Create the vault/ }).click();
    await page.waitForSelector(".keygrid", { timeout: 60000 });
    await page.locator(".check").click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /Start empty/ }).click();
    await page.getByRole("button", { name: "Begin" }).click();
    await expect(page.locator(".h-title")).toHaveText("The Ten");

    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("button", { name: /Turn on sync/ }).click();
    await expect(page.locator(".setrow-label").filter({ hasText: "In sync" })).toBeVisible({
      timeout: 30000,
    });
    await page.getByRole("button", { name: /Pairing code/ }).click();

    // The old contents are untouched: the grouped code and the link input.
    const groups = await page.locator(".sheet .keygrid span").allTextContents();
    expect(groups.length).toBeGreaterThan(5);
    const link = await page.locator(".sheet input").inputValue();
    expect(link).toContain(`#s=${groups.join("")}`);

    // And above them, one SVG carrying exactly that link.
    const svg = page.locator(".sheet .qrcard svg.qr");
    await expect(svg).toBeVisible();
    await expect(page.locator(".sheet .qrhint")).toHaveText("Scan with the other device's camera");
    // The QR sits before the code grid in document order.
    const qrFirst = await page.evaluate(() => {
      const card = document.querySelector(".sheet .qrcard");
      const grid = document.querySelector(".sheet .keygrid");
      return !!(card && grid) && (card.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    expect(qrFirst).toBe(true);

    const decoded = await page.evaluate(async () => {
      const dec = await import("/tests/qrdecode.js");
      const svgEl = document.querySelector(".sheet .qrcard svg.qr");
      const d = svgEl.querySelector("path").getAttribute("d");
      const span = Number(svgEl.getAttribute("viewBox").split(" ")[2]);
      const size = span - 8;
      const matrix = [];
      for (let i = 0; i < size; i += 1) matrix.push(new Array(size).fill(false));
      for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
        const col = Number(m[1]) - 4;
        const row = Number(m[2]) - 4;
        for (let k = 0; k < Number(m[3]); k += 1) matrix[row][col + k] = true;
      }
      const read = dec.decode(matrix);
      return { text: read.text, badBlocks: read.badBlocks, quiet: span - size };
    });
    expect(decoded.badBlocks).toEqual([]);
    expect(decoded.text).toBe(link);
    // Four modules of quiet zone on each side, as the standard asks.
    expect(decoded.quiet).toBe(8);
  });
});

// -------------------------------------------------------------- the scanner

/**
 * Installs a fake BarcodeDetector and a fake camera before the app boots.
 * The stream is a real MediaStream (a canvas capture), so track.stop() and
 * track.readyState are the browser's own - which is what makes the teardown
 * assertions worth anything.
 */
async function stubCamera(page, rawValue) {
  await page.addInitScript((value) => {
    window.__tracksStopped = 0;
    window.__detectCalls = 0;
    class FakeBarcodeDetector {
      constructor() {}
      static getSupportedFormats() {
        return Promise.resolve(["qr_code"]);
      }
      async detect() {
        window.__detectCalls += 1;
        // A couple of empty frames first, the way a real camera behaves.
        if (value === null || window.__detectCalls < 2) return [];
        return [{ rawValue: value, format: "qr_code" }];
      }
    }
    window.BarcodeDetector = FakeBarcodeDetector;
    const media = navigator.mediaDevices || {};
    media.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      canvas.getContext("2d").fillRect(0, 0, 64, 64);
      const stream = canvas.captureStream(5);
      window.__stream = stream;
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          window.__tracksStopped += 1;
          stop();
        };
      }
      return stream;
    };
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", { value: media, configurable: true });
    }
  }, rawValue);
}

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

test.describe("scanner", () => {
  test.describe.configure({ timeout: 120_000 });

  test("without a BarcodeDetector the scan button does not exist at all", async ({ page }) => {
    // This browser has none; the assertion is made explicit anyway, and the
    // property is deleted so the test still holds if a future build adds it.
    await page.addInitScript(() => {
      delete window.BarcodeDetector;
    });
    await freshAdoptStep(page);
    expect(await page.evaluate(() => "BarcodeDetector" in window)).toBe(false);
    await expect(page.getByRole("button", { name: "Scan code" })).toHaveCount(0);
    // The typed path is untouched.
    await expect(page.locator(".input.is-mono")).toBeVisible();
    await expect(page.getByRole("button", { name: /Fetch the vault/ })).toBeVisible();
  });

  test("with a detector the button appears and a hit runs the adopt flow", async ({ page }) => {
    await stubCamera(page, `https://example.test/#s=${FAKE_ID}`);
    await freshAdoptStep(page);

    const button = page.getByRole("button", { name: "Scan code" });
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.locator(".sheet .scanbox video")).toBeVisible();

    // The code lands in the typed field and the adopt call really runs - the
    // id is not on this server, so the honest answer comes back.
    await expect(page.locator(".field-error")).toHaveText("No vault found for that code.", {
      timeout: 30000,
    });
    expect(await page.locator(".input.is-mono").inputValue()).toBe(FAKE_ID);

    // The camera is off, and the sheet is gone.
    await expect(page.locator(".sheet")).toHaveCount(0);
    const camera = await page.evaluate(() => ({
      stopped: window.__tracksStopped,
      live: window.__stream.getTracks().filter((t) => t.readyState === "live").length,
    }));
    expect(camera.stopped).toBeGreaterThan(0);
    expect(camera.live).toBe(0);
  });

  test("closing the scanner stops the camera", async ({ page }) => {
    // A detector that never sees anything: the only way out is the close.
    await stubCamera(page, null);
    await freshAdoptStep(page);
    await page.getByRole("button", { name: "Scan code" }).click();
    await expect(page.locator(".sheet .scanbox video")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__detectCalls)).toBeGreaterThan(1);
    expect(await page.evaluate(() => window.__stream.getTracks().every((t) => t.readyState === "live"))).toBe(
      true,
    );

    await page.locator(".sheet-foot").getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".sheet")).toHaveCount(0);
    const camera = await page.evaluate(() => ({
      stopped: window.__tracksStopped,
      live: window.__stream.getTracks().filter((t) => t.readyState === "live").length,
    }));
    expect(camera.stopped).toBeGreaterThan(0);
    expect(camera.live).toBe(0);
    // And no frame is looked at after the close.
    const before = await page.evaluate(() => window.__detectCalls);
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => window.__detectCalls)).toBe(before);
  });

  test("a refused camera says so calmly and leaves the typed path alone", async ({ page }) => {
    await page.addInitScript(() => {
      window.BarcodeDetector = class {
        static getSupportedFormats() {
          return Promise.resolve(["qr_code"]);
        }
        async detect() {
          return [];
        }
      };
      const media = navigator.mediaDevices || {};
      media.getUserMedia = async () => {
        const err = new Error("denied");
        err.name = "NotAllowedError";
        throw err;
      };
      if (!navigator.mediaDevices) {
        Object.defineProperty(navigator, "mediaDevices", { value: media, configurable: true });
      }
    });
    await freshAdoptStep(page);
    await page.getByRole("button", { name: "Scan code" }).click();
    await expect(page.locator(".sheet .field-hint")).toHaveText(
      "No camera available here. Type the code instead - that works just as well.",
    );

    await page.locator(".sheet-foot").getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".sheet")).toHaveCount(0);
    await page.locator(".input.is-mono").fill(FAKE_ID);
    await page.getByRole("button", { name: /Fetch the vault/ }).click();
    await expect(page.locator(".field-error")).toHaveText("No vault found for that code.", {
      timeout: 30000,
    });
  });

  test("the scanner module never reaches the network or keeps a frame", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join, dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const source = (await readFile(join(root, "web/js/ui/scan.js"), "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const rx of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /new\s+WebSocket/, /toDataURL/, /toBlob/, /getImageData/, /localStorage/, /indexedDB/]) {
      expect(rx.test(source), `scan.js matches ${rx}`).toBe(false);
    }
    // The stream is torn down in exactly one place.
    expect((source.match(/track\.stop\(\)/g) || []).length).toBe(1);
    expect((source.match(/getTracks\(\)/g) || []).length).toBe(1);
  });
});
