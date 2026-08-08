// ui/langswitch.js - the small language row on the lock and setup screens.
//
// What it does: the three native language names, the active one accented.
// Works before the vault exists - the choice goes through ctx.setLanguage,
// which falls back to localStorage-only presentation prefs when no document
// is open yet.
//
// What it deliberately does NOT do: no flags, no dropdown, no detection
// logic - detection lives in i18n.js, this is only the explicit override.

import { el, text } from "./dom.js";
import { LOCALES, getLocale, t } from "../i18n.js";

const NATIVE = { en: "English", de: "Deutsch", es: "Español" };

export function langSwitch(ctx) {
  const box = el("div", {
    class: "lang-switch",
    attrs: { role: "group", "aria-label": t("settings.language") },
  });
  LOCALES.forEach((code) => {
    const active = getLocale() === code;
    box.appendChild(
      el(
        "button",
        {
          class: `lang-opt${active ? " is-active" : ""}`,
          attrs: { type: "button", lang: code, "aria-pressed": active ? "true" : "false" },
          on: { click: () => ctx.setLanguage(code) },
        },
        [text(NATIVE[code] || code)],
      ),
    );
  });
  return box;
}
