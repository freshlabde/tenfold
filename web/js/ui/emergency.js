// ui/emergency.js - the emergency sheet: the recovery key, on paper.
//
// What it does: builds one printable page carrying the recovery key twice -
// as the grouped text a human transcribes, and as a QR code a camera reads -
// plus the date it was made, three lines that say what the key is for and how
// carefully it has to be kept, and a ruled blank for a passphrase hint written
// by hand. The page is appended to the document, window.print() is called, and
// afterprint takes it away again. On iOS Safari that same dialog offers "Save
// to Files" and AirPrint, which is exactly the point: a PDF in a folder or a
// sheet in a drawer, and nothing in the photo library.
//
// What it deliberately does NOT do: it holds no state, keeps no copy, and does
// not exist in the DOM for a millisecond longer than the print dialog. It is
// offered on the setup step only - the key is shown once in the life of a
// vault, and this sheet cannot resurrect it afterwards. No new dependency: the
// print flow is the browser's, the QR is our own encoder, the layout is CSS.

import { el, sel, text, icon } from "./dom.js";
import { t, getLocale } from "../i18n.js";
import { qrSvg } from "./qrview.js";
import { CAP_PRINT, shellSend, shellWith } from "../shell.js";

/** The id of the printable region, so there is never a second one. */
const PAPER_ID = "paper";

/**
 * The date the sheet was made, spelled out. A long month is deliberate: this
 * is read years later, possibly by somebody who did not print it, and 03/04
 * means two different days on two sides of an ocean.
 */
function longDate(ts) {
  try {
    return new Intl.DateTimeFormat(getLocale(), {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

/** How many groups of the key sit on one printed line. */
const GROUPS_PER_ROW = 4;

/**
 * The key as it is read aloud and typed back in: groups of four, separated by
 * hyphens, broken into fixed rows rather than left to wrap. A wrap depends on
 * the font the printer happens to have and would put the fold in a different
 * place on every machine; a copied key is read one row at a time, and the row
 * has to be the same one twice.
 */
function keyBlock(grouped) {
  const groups = grouped.split("-").filter(Boolean);
  const rows = [];
  for (let i = 0; i < groups.length; i += GROUPS_PER_ROW) {
    rows.push(groups.slice(i, i + GROUPS_PER_ROW));
  }
  return el(
    "div",
    { class: "paper-key" },
    rows.map((row, r) =>
      el(
        "div",
        { class: "paper-key-row" },
        row.map((g, i) => {
          const last = r === rows.length - 1 && i === row.length - 1;
          return el("span", { class: "paper-key-g" }, [
            text(g),
            last ? null : el("span", { class: "paper-key-sep" }, [text("-")]),
          ]);
        }),
      ),
    ),
  );
}

function note(n, key) {
  return el("li", { class: "paper-note" }, [
    el("span", { class: "paper-num", attrs: { "aria-hidden": "true" } }, [text(String(n))]),
    el("span", { class: "paper-note-text" }, [text(t(key))]),
  ]);
}

/**
 * Build the sheet. Pure: it takes the grouped key and a timestamp and returns
 * a detached node, which is what makes it screenshottable and testable without
 * a printer anywhere in sight.
 * @param {string} groupedKey the recovery key, already grouped with hyphens
 * @param {number} [now]
 * @returns {HTMLElement}
 */
export function emergencySheet(groupedKey, now = Date.now()) {
  const grouped = typeof groupedKey === "string" ? groupedKey : "";
  // The QR carries the key exactly as it is printed above it - same string,
  // same hyphens - so what a camera reads and what a hand copies cannot drift.
  const code = qrSvg(grouped, t("setup.key.sheet.qrLabel"), "paper-qr");

  return el(
    "section",
    {
      id: PAPER_ID,
      class: "paper",
      attrs: { role: "document", "aria-label": t("setup.key.sheet.title") },
    },
    [
      el("header", { class: "paper-head" }, [
        el("div", { class: "paper-brand" }, [icon("mark", 15), text(t("app.name"))]),
        el("div", { class: "paper-date" }, [text(t("setup.key.sheet.created", { date: longDate(now) }))]),
      ]),
      el("h1", { class: "paper-title" }, [text(t("setup.key.sheet.title"))]),
      el("p", { class: "paper-lede" }, [text(t("setup.key.sheet.lede"))]),

      el("div", { class: "paper-panel" }, [
        el("div", { class: "paper-panel-main" }, [
          el("div", { class: "paper-label" }, [text(t("setup.key.sheet.keyLabel"))]),
          keyBlock(grouped),
        ]),
        code
          ? el("figure", { class: "paper-code" }, [
              code,
              el("figcaption", { class: "paper-code-cap" }, [text(t("setup.key.sheet.qrCaption"))]),
            ])
          : null,
      ]),

      el("ol", { class: "paper-notes" }, [
        note(1, "setup.key.sheet.line1"),
        note(2, "setup.key.sheet.line2"),
        note(3, "setup.key.sheet.line3"),
      ]),

      el("div", { class: "paper-field" }, [
        el("div", { class: "paper-label" }, [text(t("setup.key.sheet.hint"))]),
        el("div", { class: "paper-rule" }),
        el("div", { class: "paper-rule" }),
      ]),

      el("footer", { class: "paper-foot" }, [text(t("setup.key.sheet.foot"))]),
    ],
  );
}

/** Take the printable region away, whether or not it is there. */
export function removeEmergencySheet() {
  const node = document.getElementById(PAPER_ID);
  if (node && node.parentNode) node.parentNode.removeChild(node);
}

/**
 * Build the sheet, print it, and remove it again. The region enters the
 * document one frame before the dialog and leaves on afterprint; the timeout
 * is the belt for the browsers whose afterprint is a promise rather than a
 * fact - without it a cancelled dialog could leave the key in the DOM.
 * @param {string} groupedKey
 * @returns {HTMLElement} the region, for the caller that wants to look at it
 */
export function printEmergencySheet(groupedKey) {
  removeEmergencySheet();
  const paper = emergencySheet(groupedKey);
  document.body.appendChild(paper);

  let timer = 0;
  const clean = () => {
    window.removeEventListener("afterprint", clean);
    if (timer) clearTimeout(timer);
    removeEmergencySheet();
  };
  window.addEventListener("afterprint", clean);
  timer = setTimeout(clean, 120000);

  // In the shell, window.print() is a WKWebView no-op - the button did
  // nothing at all until the `print` capability existed. The shell's panel is
  // the dialog there, and it carries "Save to PDF": the drawer and the folder,
  // same as Safari's. afterprint never fires in a web view, so cleanup rides
  // the reply (the panel is up; its formatter renders lazily, which is what
  // the 120-second belt above is sized for) - and a refusal or a dead shell
  // cleans immediately rather than leaving the key parked in the DOM.
  if (shellWith(CAP_PRINT)) {
    shellSend({ type: "page.print" })
      .then((reply) => {
        if (!reply || !reply.ok) clean();
      })
      .catch(clean);
    return paper;
  }

  try {
    window.print();
  } catch {
    // No print support at all: the key is on screen behind this button, which
    // is the state the step was in before the sheet existed.
    clean();
  }
  return paper;
}
