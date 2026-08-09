// ui/lock.js - the screen in front of the vault.
//
// What it does: takes the passphrase, or the recovery key when the passphrase
// is gone, and hands it to the context. Also the only route to the About text
// from outside the vault - somebody must be able to read what this app does
// before typing a secret into it.
//
// When this device has enrolled its own authenticator, the first thing on the
// screen is the biometric button, and it fires itself once - that is the answer
// to "a reload locks the vault immediately": reload, one touch, back in.
//
// What it deliberately does NOT do: it does not say whether a passphrase was
// "almost" right, does not count attempts on screen, does not remember what
// was typed, and never keeps the entered secret in a variable after the call.
// A cancelled or failed biometric prompt says nothing at all - it just leaves
// the passphrase field focused, because cancelling is not an error.

import { el, text, icon, clear } from "./dom.js";
import { t } from "../i18n.js";
import { langSwitch } from "./langswitch.js";

let mode = "pass";
let failed = false;
let busy = false;
/** The automatic prompt fires once per arrival on this screen, never per paint. */
let prompted = false;

export function reset() {
  mode = "pass";
  failed = false;
  busy = false;
  prompted = false;
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

  // The device's own authenticator, when this device enrolled one. The button
  // is above the field because it is the shorter way in; the field below it
  // never goes away.
  const biometric = !isKey && ctx.biometric.enrolled ? biometricButton(ctx, input) : null;

  queueMicrotask(() => input.focus());

  return el("section", { class: "screen" }, [
    el("div", { class: "lock" }, [
      el("div", { class: "lock-mark" }, [icon("mark", 34)]),
      el("h1", { class: "lock-title" }, [text(t("lock.title"))]),
      el("p", { class: "lock-sub" }, [
        text(ctx.autoLocked ? t("lock.autoLocked", { minutes: ctx.idleMinutes }) : t("lock.sub")),
      ]),
      biometric,
      el("div", { class: "field" }, [input]),
      err,
    ]),
    el("div", { class: "bar", style: { gridAutoFlow: "row" } }, [unlock]),
    el("div", { class: "lock-foot" }, [toggle, about]),
    langSwitch(ctx),
    // The way out when the passphrase is truly gone and no key exists:
    // wipe this device's copy and start over. Deliberately quiet - it is
    // an escape hatch, not an invitation.
    el("div", { class: "lock-reset" }, [
      el(
        "button",
        { class: "btn-ghost", attrs: { type: "button" }, on: { click: () => confirmReset(ctx) } },
        [text(t("lock.reset"))],
      ),
    ]),
  ]);
}

/**
 * The biometric way in. One button, one neutral label - naming Face ID or
 * Touch ID would be wrong on half the devices that can do this - and one
 * automatic attempt when the screen appears.
 */
function biometricButton(ctx, field) {
  const button = el(
    "button",
    { class: "btn is-primary is-big is-wide", attrs: { type: "button" }, dataset: { bio: "unlock" } },
    [icon("unlock", 18), text(t("webauthn.unlock"))],
  );

  let running = false;
  const attempt = async () => {
    if (running || busy) return;
    running = true;
    try {
      await ctx.unlockBiometric();
      ctx.enterApp();
    } catch {
      // Cancelled, dismissed, a credential this vault does not know: the
      // passphrase is right there, and nothing is said about it.
      running = false;
      if (field && field.isConnected) field.focus();
    }
  };

  button.addEventListener("click", attempt);
  if (!prompted) {
    prompted = true;
    // One frame later, so the screen is painted behind the system prompt.
    requestAnimationFrame(() => attempt());
  }
  return el("div", { class: "lock-bio" }, [button]);
}

/** The wipe is irreversible on this device - say so in plain words first. */
function confirmReset(ctx) {
  const body = el("div", {}, [
    el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("lock.reset.body"))]),
    el("p", { class: "check-text" }, [text(t("lock.reset.syncNote"))]),
  ]);
  const footer = el("div", { class: "sheet-foot" }, [
    el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => ctx.closeSheet() } }, [
      text(t("common.cancel")),
    ]),
    el(
      "button",
      {
        class: "btn is-primary",
        attrs: { type: "button" },
        on: { click: () => ctx.wipeLocalVault() },
      },
      [text(t("lock.reset.confirm"))],
    ),
  ]);
  ctx.openSheet({ title: t("lock.reset.title"), body, footer });
}
