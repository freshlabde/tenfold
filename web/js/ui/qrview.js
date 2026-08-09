// ui/qrview.js - the QR code as something a camera can read.
//
// What it does: turns a string into one SVG whose whole symbol is a single
// path element. It carries the four-module quiet zone the standard asks for
// and sits on a white card, dark on light, in every skin and both themes -
// a scanner needs contrast, not the look of the app.
//
// What it deliberately does NOT do: no per-module DOM nodes (a version 4
// symbol would be a thousand rects), no canvas, no image encoding, no network.
// It cannot fail loudly either: a payload the encoder refuses returns null and
// the caller simply shows the code and the link, which is what worked before.

import { el, sel } from "./dom.js";
import { qrMatrix, qrPath } from "../qr.js";

/** Quiet zone in modules, as the standard prescribes. */
const QUIET = 4;

/**
 * The symbol itself, as one SVG. Separate from the card because the emergency
 * sheet needs the same geometry at a different size and on real paper - the
 * class is the only thing that differs, and the quiet zone must not be
 * transcribed twice.
 * @param {string} value the text the code carries
 * @param {string} label accessible name, already translated
 * @param {string} [cls] the class the caller styles it with
 * @returns {SVGElement|null} null when the value does not fit
 */
export function qrSvg(value, label, cls = "qr") {
  if (typeof value !== "string" || value === "") return null;
  let matrix;
  try {
    matrix = qrMatrix(value);
  } catch {
    return null;
  }
  const span = matrix.length + QUIET * 2;
  return sel(
    "svg",
    {
      class: cls,
      attrs: {
        viewBox: `0 0 ${span} ${span}`,
        role: "img",
        "aria-label": label || "",
        // Integer coordinates on an integer grid: no anti-aliased edges
        // between neighbouring modules, which is what a scanner trips over.
        "shape-rendering": "crispEdges",
      },
    },
    [sel("path", { attrs: { d: qrPath(matrix, QUIET) } })],
  );
}

/**
 * @param {string} value the text the code carries
 * @param {string} label accessible name, already translated
 * @returns {HTMLElement|null} the white card, or null when the value does not fit
 */
export function qrCard(value, label) {
  const svg = qrSvg(value, label, "qr");
  if (!svg) return null;
  return el("div", { class: "qrcard" }, [svg]);
}
