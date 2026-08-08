// ui/lock.js - the screen in front of the vault.
//
// What it does: takes the passphrase, or the recovery key when the passphrase
// is gone, and hands it to the context. Also the only route to the About text
// from outside the vault - somebody must be able to read what this app does
// before typing a secret into it.
//
// What it deliberately does NOT do: it does not say whether a passphrase was
// "almost" right, does not count attempts on screen, does not remember what
// was typed, and never keeps the entered secret in a variable after the call.

import { el, text, icon, clear } from "./dom.js";
import { t } from "../i18n.js";
import { langSwitch } from "./langswitch.js";

let mode = "pass";
let failed = false;
let busy = false;

export function reset() {
  mode = "pass";
  failed = false;
  busy = false;
}

export function render(ctx) {
  const isKey = mode === "key";
  const input = el("input", {
    class: `input${isKey ? " is-mono" : ""}`,
    attrs: {
      type: isKey ? "text" : "password",
      placeholder: isKey ? t("lock.keyPlaceholder") : t("lock.passPlaceholder"),
      "aria-label": isKey ? t("lock.keyLabel") : t("lock.passLabel"),
      autocomplete: isKey ? "off" : "current-password",
      autocapitalize: "none",
      spellcheck: "false",
      enterkeyhint: "go",
    },
  });

  const err = el("div", { class: "field-error" }, failed ? [text(t("lock.wrong"))] : []);

  const unlock = el(
    "button",
    { class: "btn is-primary is-big is-wide", attrs: { type: "button" } },
    [icon("unlock", 18), text(t("common.unlock"))],
  );

  const submit = async () => {
    if (busy) return;
    const secret = input.value;
    if (!secret) return;
    busy = true;
    clear(unlock);
    unlock.appendChild(text(t("setup.pass.working")));
    unlock.setAttribute("disabled", "disabled");
    await new Promise((r) => requestAnimationFrame(() => r()));
    try {
      await ctx.unlock(secret, isKey ? "recovery" : "pass");
      input.value = "";
      failed = false;
      busy = false;
      ctx.enterApp();
    } catch {
      busy = false;
      failed = true;
      input.value = "";
      ctx.render();
    }
  };

  unlock.addEventListener("click", submit);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") submit();
  });

  const toggle = el(
    "button",
    {
      class: "btn-ghost",
      attrs: { type: "button" },
      on: {
        click: () => {
          mode = isKey ? "pass" : "key";
          failed = false;
          ctx.render();
        },
      },
    },
    [text(isKey ? t("lock.usePass") : t("lock.useKey"))],
  );

  const about = el(
    "button",
    { class: "btn-ghost", attrs: { type: "button" }, on: { click: () => ctx.go("about") } },
    [text(t("common.about"))],
  );

  queueMicrotask(() => input.focus());

  return el("section", { class: "screen" }, [
    el("div", { class: "lock" }, [
      el("div", { class: "lock-mark" }, [icon("lock", 30)]),
      el("h1", { class: "lock-title" }, [text(t("lock.title"))]),
      el("p", { class: "lock-sub" }, [
        text(ctx.autoLocked ? t("lock.autoLocked", { minutes: ctx.idleMinutes }) : t("lock.sub")),
      ]),
      el("div", { class: "field" }, [input]),
      err,
    ]),
    el("div", { class: "bar", style: { gridAutoFlow: "row" } }, [unlock]),
    el("div", { class: "lock-foot" }, [toggle, about]),
    langSwitch(ctx),
  ]);
}
