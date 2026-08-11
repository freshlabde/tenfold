// ui/pushoffer.js - the daily reminder, offered once where the first run could
// not ask for it.
//
// What it does: the first run asks about the reminder right after the backup
// question, but on iOS that step can only be honest about the fact that a tab
// receives nothing. This sheet is the second half of that promise: the first
// time the app is unlocked as the INSTALLED app, with sync on and no reminder
// running, it asks the same question with the same words and the same enable
// path the settings row uses.
//
// What it deliberately does NOT do: it never appears twice. Both answers write
// `settings.pushOffered` into the sealed document, so the decision travels with
// the vault to every device instead of living in one browser. It never opens
// over the About intro or over another sheet - app.js orders that - and it adds
// no setting of its own: the settings group stays the place to change the hour.

import { el, text } from "./dom.js";
import { openSheet, closeSheet } from "./sheet.js";
import { t } from "../i18n.js";

/** "at 08:00" - the hour in the plain 24 hour form every locale can read. */
function hourLabel(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

/**
 * @param {Element} layer the overlay host
 * @param {Object} ctx the app context
 */
export function openPushOffer(layer, ctx) {
  const status = ctx.push.status;

  const field = el("input", {
    class: "input",
    attrs: {
      type: "number",
      min: "0",
      max: "23",
      step: "1",
      inputmode: "numeric",
      "aria-label": t("push.hour"),
    },
  });
  field.value = String(status.hour);

  // Settled for good, in the sealed document rather than in this browser.
  const settle = () => ctx.setSettings({ pushOffered: true }, { now: true });

  const body = el("div", {}, [
    el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("push.body"))]),
    el("div", { class: "field" }, [
      el("span", { class: "field-label" }, [text(t("push.hour"))]),
      field,
      el("p", { class: "field-hint" }, [text(t("push.hourHint"))]),
    ]),
  ]);

  const turnOn = async () => {
    const raw = Number(field.value);
    const hour = Math.max(0, Math.min(23, Math.trunc(Number.isFinite(raw) ? raw : 8)));
    closeSheet();
    try {
      await ctx.push.enable(hour);
      ctx.toast(t("push.on", { time: hourLabel(hour) }));
    } catch (err) {
      // A refused permission is an answer too: the toast says what happened,
      // the question is settled, and the settings row stays the way back.
      ctx.toast(t(`push.error.${err && err.code ? err.code : "server"}`));
    }
    await ctx.push.refresh();
    settle();
  };

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
    el("button", { class: "btn is-primary", attrs: { type: "button" }, on: { click: turnOn } }, [
      text(t("push.enable")),
    ]),
  ]);

  // Closing with the X settles nothing, the same rule the share offer follows:
  // only the two buttons say something, so an accidental dismissal gets the
  // question back at the next unlock rather than losing it for ever.
  return openSheet(layer, { title: t("push.title"), body, footer });
}
