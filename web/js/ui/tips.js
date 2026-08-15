// ui/tips.js - the tip jar as it looks inside the native shell.
//
// What it does: one sheet with the three offers the App Store answered with,
// cheapest first, one line each, and a thank-you when one of them is paid.
//
// WHY IT IS ITS OWN MODULE and not a branch inside ui/support.js: that file's
// rule is that it does not exist inside the native shell, stated in its header,
// enforced by `supportAvailable()` and asserted three ways by
// tests/support.spec.js. A sheet that ONLY exists inside the shell, sitting in
// the module whose one invariant is that it never runs there, would make that
// header false and put an App Store rejection one accidental call away. Two
// modules, two predicates, one idea: the browser sheet is gated on
// `!inShell()`, this one on the `tips` capability, and they can never both be
// on offer.
//
// What it deliberately does NOT do:
//
//   - It renders no offer that did not arrive. There is no placeholder row, no
//     hard-coded name and no "from 1.99": a button that cannot be paid is worse
//     than a sentence saying there is nothing today.
//   - It never formats a price. The strings come from the App Store through
//     tips.js and are drawn exactly as they arrived - the store knows which
//     currency this person is in, which separator it uses and which side of the
//     number the symbol goes on, and this side does not.
//   - It says nothing when a purchase is cancelled. Somebody who opened a
//     payment sheet and changed their mind has told you something; a toast
//     acknowledging it would be the app arguing with a decision.
//   - It marks nobody as a supporter. Nothing is unlocked by paying and no
//     receipt is kept anywhere - see docs/CONTRACTS.md. The one flag it writes
//     is `settings.supportOpened`, which already exists, is written at the same
//     moment the browser sheet writes it, and means "went looking for the tip
//     jar" rather than "paid".

import { el, text, clear } from "./dom.js";
import { t } from "../i18n.js";
import { closeSheet } from "./sheet.js";
import { tipsAvailable, loadOffers, buy } from "../tips.js";

/**
 * Which sentence answers which refusal. Three states rather than one, because
 * "the store has nothing to offer", "the store could not be reached" and "the
 * store could not be asked" are different facts and only one of them is ever
 * true - and only the middle one makes "try again" honest advice.
 *
 * `unavailable` is a build with no store at all. It should be unreachable: the
 * capability is not advertised in that state, so `tipsAvailable()` is false and
 * this sheet does not open. It is mapped anyway, because a state that cannot
 * happen still needs a sentence the day it does.
 */
const NOTE_FOR = Object.freeze({
  unknownProduct: "tips.none",
  network: "tips.unreachable",
  failed: "tips.failed",
  unavailable: "tips.failed",
});

/**
 * The sheet.
 *
 * It opens straight away and fills in when the store answers: asking the App
 * Store is a round trip over somebody's network, and a settings row that does
 * nothing for a second and a half reads as a broken button.
 *
 * @param {Object} ctx the app context (openSheet, toast, setSettings, doc)
 * @returns {Element|null} the sheet, or null where there is no store behind it
 */
export function openTipSheet(ctx) {
  // The guard sits here as well as at the settings row. A sheet is reachable
  // from anywhere somebody wires a button to it later, and "there is a store
  // behind these rows" has to hold without that person having read this file.
  if (!tipsAvailable()) return null;

  // The same flag the browser sheet writes, at the same moment and for the same
  // reason: somebody who came here by themselves never needs the week-old
  // question. Written on OPENING rather than on paying, deliberately - it is a
  // fact about a screen somebody visited, and a flag that meant "paid" would be
  // the purchase artefact the shell promises not to leave.
  if (ctx && ctx.doc && !ctx.doc.settings.supportOpened && typeof ctx.setSettings === "function") {
    ctx.setSettings({ supportOpened: true }, { now: true });
  }

  const list = el("div", { class: "tip-list" }, []);
  const note = el("p", { class: "field-hint tip-note" }, [text(t("tips.loading"))]);

  /** One line, or nothing at all. The note is the only thing that ever moves. */
  const setNote = (key) => {
    clear(note);
    if (key) note.appendChild(text(t(key)));
  };

  // One purchase at a time. A second tap while the payment sheet is coming up
  // would start a second flow against a store that is already busy with the
  // first, and the person would be asked to pay twice for one decision.
  let busy = false;

  const purchase = async (offer) => {
    if (busy) return;
    busy = true;
    setNote(null);
    const outcome = await buy(offer.id);
    busy = false;

    if (outcome.state === "purchased") {
      closeSheet();
      ctx.toast(t("tips.thanks"));
      return;
    }
    if (outcome.state === "pending") {
      // Ask to Buy, or a payment method that needs a step elsewhere. It may
      // complete days later and this app will never find out, because nothing
      // is unlocked and so nothing is waiting. "It is with the App Store",
      // never "thank you".
      closeSheet();
      ctx.toast(t("tips.pending"));
      return;
    }
    // Cancelled: nothing at all. The sheet stays open, because the way back
    // from a mind changed twice is the row that is already on screen.
    if (outcome.state === "cancelled") return;
    if (!note.isConnected) return;
    setNote(NOTE_FOR[outcome.code] || "tips.failed");
  };

  /**
   * One offer: the store's own name for it, and the store's own price. The
   * settings plate rather than a button of its own - a tip is a row somebody
   * taps, not a checkout - and the price is the value on the right, where
   * every other row in this app puts the thing it is reporting.
   */
  const rowFor = (offer) =>
    el(
      "button",
      {
        class: "setrow",
        attrs: { type: "button" },
        on: { click: () => purchase(offer) },
      },
      [
        el("span", {}, [el("span", { class: "setrow-label" }, [text(offer.title)])]),
        el("span", { class: "tip-price" }, [text(offer.price)]),
      ],
    );

  const body = el("div", {}, [
    el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("tips.body"))]),
    list,
    note,
    el("p", { class: "field-hint support-privacy" }, [text(t("tips.nothing"))]),
  ]);

  const footer = el("div", { class: "sheet-foot" }, [
    el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => closeSheet() } }, [
      text(t("common.close")),
    ]),
  ]);

  const sheet = ctx.openSheet({ title: t("support.title"), body, footer });

  loadOffers().then((result) => {
    // Closed while the store was thinking. Nothing to draw into, and nothing
    // worth telling anybody about.
    if (!list.isConnected) return;
    if (!result.offers) {
      setNote(NOTE_FOR[result.code] || "tips.failed");
      return;
    }
    // In the order they arrived. The shell sorted them cheapest first and that
    // order is part of the contract; a second sort here would be a second
    // opinion about it.
    for (const offer of result.offers) list.appendChild(rowFor(offer));
    setNote(null);
  });

  return sheet;
}
