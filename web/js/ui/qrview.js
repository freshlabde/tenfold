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
 * @param {string} value the text the code carries
 * @param {string} label accessible name, already translated
 * @returns {HTMLElement|null} the white card, or null when the value does not fit
 */
export function qrCard(value, label) {
  if (typeof value !== "string" || value === "") return null;
  let matrix;
  try {
    matrix = qrMatrix(value);
  } catch {
    return null;
  }
  const span = matrix.length + QUIET * 2;
  const svg = sel(
    "svg",
    {
      class: "qr",
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
  return el("div", { class: "qrcard" }, [svg]);
}
