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
// There are two authenticators behind that one button and never both: the
// browser's WebAuthn PRF credential, or - inside the native shell, where
// WebAuthn does not exist - the key the shell keeps behind Face ID. The slot,
// the label and the automatic first attempt are identical, because to the
// person in front of it this is one feature.
//
// The shell path can refuse in five ways and only two of them are worth a word:
// too many failed attempts, and an enrolment that changed. Those get one quiet
// line under the button - a line, not a banner and not a sheet, and it does not
// come back on the next screen. The other three (cancelled, missing, anything
// else) leave the passphrase field focused and say nothing at all.
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
/** i18n key of the one quiet line the biometric path may leave, or null. */
let notice = null;

export function reset() {
  mode = "pass";
  failed = false;
  busy = false;
  prompted = false;
  notice = null;
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

  // The device's own authenticator, when this device armed one. The button is
  // above the field because it is the shorter way in; the field below it never
  // goes away.
  //
  // Two possible sources, checked in this order and never both: inside the
  // shell webauthn.supported() is false by construction, so the second branch
  // cannot fire there - and the shell path is absent in a browser, where there
  // is no capability to find.
  const useShell =
    !isKey && ctx.shellBio.supported && ctx.shellBio.enabled && !ctx.shellBio.hidden;
  const usePrf = !isKey && ctx.biometric.supported && ctx.biometric.enrolled;
  const biometric = useShell
    ? shellBioButton(ctx, input)
    : usePrf
      ? biometricButton(ctx, input)
      : null;

  // One line, in the same muted voice as the subtitle above it. It says what
  // happened to a way in that used to work; it is not a call to action, and it
  // is gone the next time this screen is built.
  const bioNote = notice ? el("p", { class: "lock-sub", dataset: { bio: "note" } }, [text(t(notice))]) : null;

  queueMicrotask(() => input.focus());

  return el("section", { class: "screen" }, [
    el("div", { class: "lock" }, [
      el("div", { class: "lock-mark" }, [icon("mark", 34)]),
      el("h1", { class: "lock-title" }, [text(t("lock.title"))]),
      el("p", { class: "lock-sub" }, [
        text(ctx.autoLocked ? t("lock.autoLocked", { minutes: ctx.idleMinutes }) : t("lock.sub")),
      ]),
      biometric,
      bioNote,
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

/**
 * The same button, one layer down: the shell holds the key behind the device's
 * own Face ID or Touch ID. Same slot, same neutral label, same single automatic
 * attempt - and five possible refusals, of which exactly two are said out loud.
 *
 *   cancelled   the person dismissed the sheet. Silence: cancelling is not an
 *               error, and the passphrase field is already there.
 *   failed      anything else that went wrong. Silence, same reasoning.
 *   lockedOut   biometry wants the device passcode before it works again. One
 *               line, because inviting another try would be a lie.
 *   invalidated the enrolled face changed, so this envelope is dead. One line
 *               that says the passphrase is needed once, and the offer to set
 *               it up again waits in settings - it is not a sheet, not a nag,
 *               and it does not repeat.
 *   missing     there is no key for this vault: the feature is off, whatever
 *               the vault file still says. The button goes, silently, and the
 *               dead wrapper is cleaned away after the passphrase unlock.
 */
function shellBioButton(ctx, field) {
  const button = el(
    "button",
    { class: "btn is-primary is-big is-wide", attrs: { type: "button" }, dataset: { bio: "shell" } },
    [icon("unlock", 18), text(t("webauthn.unlock"))],
  );

  let running = false;
  const attempt = async () => {
    if (running || busy) return;
    running = true;
    try {
      await ctx.unlockShellBio();
      ctx.enterApp();
    } catch (err) {
      running = false;
      const code = err && err.code ? err.code : "failed";
      notice = code === "lockedOut" ? "bio.lockedOut" : code === "invalidated" ? "bio.invalidated" : null;
      if (notice || code === "missing") {
        // Either there is something new to read, or the button has just stopped
        // being an offer this screen may keep making.
        ctx.render();
        return;
      }
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
