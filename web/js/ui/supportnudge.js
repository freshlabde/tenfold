// ui/supportnudge.js - the one time this app asks for anything unprompted.
//
// What it does: after a vault has been in use for a week, and only if its owner
// never went looking for the tip jar on their own, one sheet asks whether
// tenfold is worth an espresso. It is the last thing in the after-unlock chain,
// so anything that actually arrived from outside gets the moment first.
//
// What it deliberately does NOT do: it never appears twice. Both buttons write
// `settings.supportNudged` into the sealed document with an immediate seal, the
// same way the reminder offer settles its question - a reload 200 ms later must
// not ask again. It never exists inside the native shell: `supportAvailable()`
// is false there, and a sheet pointing at an external payment page is the same
// App Store rejection as the link it points at. It adds no setting, no counter
// and no second chance: the settings row and the About line stay the way in for
// anybody who changes their mind.
//
// The X is not an answer. Closing the sheet settles nothing, exactly as the
// share and reminder offers behave, so an accidental dismissal gets the
// question back at the NEXT unlock rather than losing it for good. app.js sees
// to it that "next unlock" means next unlock and not next screen change.

import { el, text } from "./dom.js";
import { openSheet, closeSheet } from "./sheet.js";
import { t } from "../i18n.js";
import { openSupportSheet, supportAvailable } from "./support.js";

/**
 * @param {Element} layer the overlay host
 * @param {Object} ctx the app context
 * @returns {Element|null} the sheet, or null where there is nothing to offer
 */
export function openSupportNudge(layer, ctx) {
  // The guard sits here as well as in app.js: this sheet leads to a payment
  // page, and the shell rule has to hold without the next caller having read
  // the chain that normally protects it.
  if (!supportAvailable()) return null;

  // Settled for good, in the sealed document rather than in this browser, so
  // the decision travels with the vault to every device.
  const settle = (patch) => ctx.setSettings({ supportNudged: true, ...patch }, { now: true });

  const body = el("div", {}, [
    // The tip jar's own words. One voice for the question and the answer, and
    // one string to keep true in three languages.
    el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("support.body"))]),
  ]);

  const footer = el("div", { class: "sheet-foot" }, [
    el(
      "button",
      {
        class: "btn-ghost",
        attrs: { type: "button" },
        on: {
          click: () => {
            closeSheet();
            settle();
          },
        },
      },
      [text(t("common.notNow"))],
    ),
    el(
      "button",
      {
        class: "btn is-primary",
        attrs: { type: "button" },
        on: {
          click: () => {
            // Both flags in ONE write: the jar is about to open, and letting
            // openSupportSheet record that separately would mean two seals of
            // the same vault racing each other over one decision.
            settle({ supportOpened: true });
            // No closeSheet first - openSheet swaps one sheet for the next
            // without the closed/opened flap that would cost the history entry.
            openSupportSheet(ctx);
          },
        },
      },
      [text(t("support.row"))],
    ),
  ]);

  return openSheet(layer, { title: t("supportNudge.title"), body, footer });
}
