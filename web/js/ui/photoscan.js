// ui/photoscan.js - the scan path for the phones that have no BarcodeDetector.
//
// What it does: opens the native camera through a file input, takes the one
// picture it gets back, shrinks it to something a decoder can work with, and
// hands it to our own reader in web/js/qrread.js. When the whole frame yields
// nothing it tries the middle of it once more at twice the scale, because a
// code held at arm's length ends up small in the centre of a photograph. On a
// hit the pairing id goes into the typed field and the adopt flow runs, exactly
// as it does on the live-scanner path.
//
// This exists because iOS Safari has no BarcodeDetector at all, so the live
// scanner in scan.js can never appear there and the owner of an iPhone was
// left with typing thirty-two characters.
//
// What it deliberately does NOT do: the picture never leaves the device -
// there is no fetch here, no upload, no storage, no data URL handed to
// anything. It is decoded in a canvas and dropped. Everything this flow holds
// on to - the chosen file, the decoded bitmap, the canvas - is let go in
// exactly ONE place (`release` below), which the hit path, every failure and
// the sheet's onClose all call, so no picture outlives the sheet.

import { el, text, clear } from "./dom.js";
import { t } from "../i18n.js";
import { closeSheet } from "./sheet.js";
import { normaliseSyncId } from "../sync.js";
import { decodeImage } from "../qrread.js";

/** Longest edge the photo is scaled to. Sharp enough, small enough to be quick. */
export const MAX_EDGE = 1400;

/** The second attempt looks at the middle half of the frame, twice as big. */
const CROP_FRACTION = 0.5;

/**
 * The fallback needs a canvas and a file input, which is every browser that
 * can run this app. It is deliberately not a capability probe with a hole in
 * it: where there is no camera the picker offers the photo library instead,
 * and that reads a screenshot just as well.
 */
export function photoScanSupported() {
  return (
    typeof document !== "undefined" &&
    typeof document.createElement === "function" &&
    typeof HTMLCanvasElement !== "undefined"
  );
}

/** A pairing code out of whatever the symbol carried, or "" when it is foreign. */
function readCode(raw) {
  if (typeof raw !== "string" || !raw) return "";
  try {
    return normaliseSyncId(raw);
  } catch {
    return "";
  }
}

/**
 * The picture, decoded, upright. `imageOrientation: "from-image"` matters here
 * for the same reason it matters for the image import: a photo taken in
 * portrait carries its rotation in EXIF, and a canvas that ignores it hands
 * the decoder a sideways symbol.
 */
async function decodeFile(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall through to the element path rather than failing on a codec quirk.
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("unreadable"));
    };
    img.src = url;
  });
}

/**
 * A part of the source, drawn at most MAX_EDGE across. Smoothing is left on
 * and set to high: scaling a photograph down without it drops every second
 * pixel, and a QR module that is four pixels wide does not survive that.
 */
function frameOf(source, box) {
  const w = source.width || source.naturalWidth || 0;
  const h = source.height || source.naturalHeight || 0;
  if (!w || !h) return null;
  const sx = box ? box.x : 0;
  const sy = box ? box.y : 0;
  const sw = box ? box.w : w;
  const sh = box ? box.h : h;
  if (sw < 8 || sh < 8) return null;

  const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * One photograph in, a pairing code or "" out. Never throws.
 * @param {File|Blob} file
 * @returns {Promise<string>}
 */
export async function readPhoto(file) {
  let source = null;
  try {
    source = await decodeFile(file);
    const full = frameOf(source, null);
    if (full) {
      const hit = readCode(decodeImage(full));
      if (hit) return hit;
    }
    // Second look: the middle of the frame at twice the scale. A code
    // photographed from a step back is small and central, and the extra pixels
    // per module are exactly what the first pass was short of.
    const w = source.width || source.naturalWidth || 0;
    const h = source.height || source.naturalHeight || 0;
    const cw = Math.round(w * CROP_FRACTION);
    const ch = Math.round(h * CROP_FRACTION);
    const crop = frameOf(source, {
      x: Math.round((w - cw) / 2),
      y: Math.round((h - ch) / 2),
      w: cw,
      h: ch,
    });
    if (crop) {
      const hit = readCode(decodeImage(crop));
      if (hit) return hit;
    }
    return "";
  } catch {
    return "";
  } finally {
    if (source && typeof source.close === "function") source.close();
  }
}

/**
 * The sheet that runs while the photo is being read, and says so calmly when
 * it could not be.
 */
function openReadingSheet(ctx, input, file, onCode) {
  let done = false;

  const note = el("p", { class: "field-hint" }, [text(t("sync.scan.reading"))]);
  const body = el("div", {}, [note]);

  const retake = el("button", {
    class: "btn",
    attrs: { type: "button", disabled: "disabled" },
  });
  retake.appendChild(text(t("sync.scan.retake")));

  /**
   * The single point where this flow lets go. Idempotent on purpose - it runs
   * again when the sheet closes after a hit, and that must be harmless.
   * Clearing the input matters twice over: it drops the browser's reference to
   * the picture, and it lets the same photo fire a change event again.
   */
  const release = () => {
    done = true;
    input.value = "";
  };

  const footer = el("div", { class: "sheet-foot" }, [
    el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => closeSheet() } }, [
      text(t("common.cancel")),
    ]),
    retake,
  ]);
  retake.addEventListener("click", () => {
    release();
    closeSheet();
    input.click();
  });

  ctx.openSheet({ title: t("sync.scan.title"), body, footer, onClose: release });

  (async () => {
    const code = await readPhoto(file);
    if (done) return;
    release();
    if (code) {
      closeSheet();
      onCode(code);
      return;
    }
    clear(note);
    note.appendChild(text(t("sync.scan.failed")));
    retake.removeAttribute("disabled");
  })();
}

/**
 * The button and the input behind it. They are returned separately because the
 * button belongs next to the code field and the input belongs out of the way;
 * the caller puts each where it goes.
 *
 * @param {Object} ctx the app context (openSheet)
 * @param {(code: string) => void} onCode called once, with a normalised id
 * @returns {{button: HTMLElement, input: HTMLElement}}
 */
export function photoScanControl(ctx, onCode) {
  const input = el("input", {
    class: "sr-only photoscan-file",
    attrs: { type: "file", accept: "image/*", capture: "environment" },
  });
  const button = el(
    "button",
    {
      class: "btn-ghost",
      attrs: { type: "button" },
      on: { click: () => input.click() },
    },
    [text(t("sync.scan.action"))],
  );
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    openReadingSheet(ctx, input, file, onCode);
  });
  return { button, input };
}
