// ui/settings.js - the small set of switches this app has.
//
// What it does: skin, theme, language, which screen an unlock opens, the two
// exports and the one import,
// what the browser says about keeping the data - or, inside the native shell
// where there is no browser to ask, what the app itself keeps - when it was
// last saved, and the button that locks everything again.
//
// What it deliberately does NOT do: no account, no telemetry switch (there is
// nothing to switch off), no theme preview screen. The unencrypted export is
// behind a sheet that states plainly what it means. The sync group is a
// status line and two actions - no progress bars, no spinner, no dialog: a
// sync that fails is a quiet dot, never an interruption. The daily reminder
// only appears with sync on, is off until switched on, and says out loud what
// it cannot do on iOS outside the installed app. The widget group appears only
// where a native shell offers a widget, and holds the one switch in this app
// that moves text out of the encryption - off by default, and stated as what
// it is rather than as a feature. Both export handlers stamp
// doc.settings.exportedAt, which is what tells the outline that this vault is
// no longer the only copy of itself. The last row of the security group is the
// full deletion - server copy and device, named part by part behind an
// acknowledgement box, and it stops instead of half-deleting when the server
// copy cannot be reached.

import { el, text, icon, brandMark } from "./dom.js";
import { t, LOCALES, getLocale } from "../i18n.js";
import { exportEncrypted, importEncrypted, exportPlaintextMarkdown, suggestedVaultFileName } from "../portability.js";
import { openSheet, closeSheet } from "./sheet.js";
import { qrCard } from "./qrview.js";
import { relativeTime } from "./format.js";
import { widgetSupported } from "../badge.js";
import { inShell } from "../shell.js";
import { supportAvailable, openSupportSheet } from "./support.js";
import { methodAnchor, methodLabel } from "./policy.js";

const SKINS = ["slate", "register", "breath"];
const THEMES = ["dark", "light"];
const DEPTH = ["on", "off"];
// Where an unlock opens (doc.settings.landing, resolved in app.js
// `landingView`). The three values ARE the three screen names, which is what
// lets the labels be `t("<value>.title")` - the app's own name for each screen,
// the one on its header. A second set of names for screens that already have
// names is how a "Board" appears in settings for a screen called "The Ten".
// The list is repeated here rather than imported from app.js on purpose: app.js
// imports this module, and the skins above already live with the same small
// duplication for the same reason.
const LANDINGS = ["today", "outline", "map"];

function group(titleKey, children) {
  return el("div", { class: "group" }, [
    el("div", { class: "group-key" }, [text(t(titleKey))]),
    ...children,
  ]);
}

function segment(labelKey, values, active, labelFor, onPick) {
  return el("div", { style: { marginBottom: "10px" } }, [
    // .field-key, not .group-key: the label of one control must not shout as
    // loudly as the title of the group it sits in, or the screen flattens into
    // one long ladder of identical capitals.
    el("div", { class: "field-key" }, [text(t(labelKey))]),
    el(
      "div",
      { class: "seg", attrs: { role: "group", "aria-label": t(labelKey) } },
      values.map((v) =>
        el(
          "button",
          {
            attrs: { type: "button", "aria-pressed": v === active ? "true" : "false" },
            on: { click: () => onPick(v) },
          },
          [text(labelFor(v))],
        ),
      ),
    ),
  ]);
}

function row(labelKey, descKey, value, onClick, opts = {}) {
  return el(
    "button",
    {
      class: `setrow${opts.danger ? " is-danger" : ""}`,
      attrs: { type: "button", "aria-disabled": opts.disabled ? "true" : "false" },
      on: { click: onClick ? () => !opts.disabled && onClick() : undefined },
    },
    [
      el("span", {}, [
        el("span", { class: "setrow-label" }, [text(t(labelKey))]),
        descKey ? el("span", { class: "setrow-desc" }, [text(t(descKey))]) : null,
      ]),
      value ? el("span", { class: "setrow-value" }, [text(value)]) : icon("chevronRight", 18),
    ],
  );
}

/**
 * The method page, in the shape of a row. Same markup as `row` above so it
 * reads as its sibling, but built on the anchor from ui/policy.js: one module
 * decides where this document lives in a browser and inside the shell, and
 * every surface that offers it goes through that one decision.
 */
function methodRow() {
  return methodAnchor("setrow", [
    el("span", {}, [
      el("span", { class: "setrow-label" }, [text(methodLabel())]),
      el("span", { class: "setrow-desc" }, [text(t("settings.methodDesc"))]),
    ]),
    icon("chevronRight", 18),
  ]);
}

function persistenceLabel(ctx) {
  const p = ctx.persisted;
  if (!p) return t("settings.persistence.unsupported");
  if (!p.supported) return t("settings.persistence.unsupported");
  return p.persisted ? t("settings.persistence.granted") : t("settings.persistence.denied");
}

/**
 * The storage row, which says something different inside the native shell.
 *
 * All three browser answers name a browser - what it keeps, what it may clear,
 * what it declines to say - and inside the shell there is no browser to name.
 * The Storage API is the wrong question there as well: it asks whether an
 * origin's data may be evicted under pressure, and the shell's web view uses
 * `WKWebsiteDataStore.default()`, so the sealed vault lives in the app's own
 * container (tenfold-ios/docs/DECISIONS.md D5). Nothing evicts it; deleting
 * the app deletes the container with it.
 *
 * So the shell gets one sentence that is true rather than three that are about
 * something else, and it is stated, not asked: there is no answer to refresh,
 * which is why the row does nothing when it is pressed there. What it does NOT
 * say is that the vault is a file anybody could copy out - the mirror in the
 * app container is a separate change and has not been built.
 *
 * The browser and PWA text is untouched, down to the byte.
 */
function persistenceRow(ctx) {
  if (inShell()) {
    return row(
      "settings.persistence",
      "settings.persistenceShellDesc",
      t("settings.persistence.shell"),
      null,
      { disabled: true },
    );
  }
  return row("settings.persistence", "settings.persistenceDesc", persistenceLabel(ctx), () =>
    ctx.refreshPersistence().then(() => ctx.render()),
  );
}

/** Phase to dot modifier. Four states are enough: on, working, stalled, off. */
function dotClass(phase) {
  if (phase === "idle") return "syncdot is-on";
  if (phase === "syncing") return "syncdot is-working";
  if (phase === "off") return "syncdot";
  return "syncdot is-stalled";
}

/** The status row: a dot, a label, and when it last got through. */
function syncStatusRow(ctx) {
  const status = ctx.sync.status;
  const when = status.lastSyncedAt
    ? t("sync.lastSynced", { ago: relativeTime(status.lastSyncedAt, ctx.now()) })
    : t("sync.lastSyncedNever");
  return el("div", { class: "setrow", attrs: { "aria-disabled": "true" } }, [
    el("span", {}, [
      el("span", { class: "setrow-label" }, [
        el("span", { class: dotClass(status.phase) }),
        text(t(`sync.state.${status.phase}`)),
      ]),
      el("span", { class: "setrow-desc" }, [text(when)]),
    ]),
  ]);
}

/**
 * The pairing sheet: the link as a QR code first, because holding a camera at
 * a screen beats typing thirty characters on a phone - then the grouped code
 * and the link itself, which stay the paths that need no camera at all.
 */
function pairingSheet(ctx) {
  const code = ctx.sync.pairingCode();
  const url = ctx.sync.pairingUrl();
  const grid = el(
    "div",
    { class: "keygrid", attrs: { role: "group", "aria-label": t("sync.pairing.title") } },
    code.split("-").map((g) => el("span", {}, [text(g)])),
  );
  const link = el("input", {
    class: "input is-mono is-url",
    attrs: { type: "text", readonly: "readonly", "aria-label": t("sync.pairing.link"), spellcheck: "false" },
  });
  link.value = url;
  link.addEventListener("focus", () => link.select());

  // The QR carries the link, not the bare code: the native camera app of the
  // other device opens it, and the fragment adopts the vault on arrival.
  const card = qrCard(url, t("sync.pairing.qrLabel"));

  const body = el("div", {}, [
    el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("sync.pairing.body"))]),
    card,
    card ? el("p", { class: "qrhint" }, [text(t("sync.pairing.qrHint"))]) : null,
    grid,
    el("div", { class: "field" }, [
      el("span", { class: "field-label" }, [text(t("sync.pairing.link"))]),
      link,
    ]),
    el("p", { class: "field-hint" }, [text(t("sync.pairing.warn"))]),
  ]);
  const footer = el("div", { class: "sheet-foot" }, [
    el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => closeSheet() } }, [
      text(t("common.close")),
    ]),
    el(
      "button",
      {
        class: "btn is-primary",
        attrs: { type: "button" },
        on: {
          click: async () => {
            try {
              await navigator.clipboard.writeText(code);
              ctx.toast(t("sync.pairing.copied"));
            } catch {
              // No clipboard permission: the code is on screen, which is the point.
            }
          },
        },
      },
      [text(t("sync.pairing.copy"))],
    ),
  ]);
  ctx.openSheet({ title: t("sync.pairing.title"), body, footer });
}

function disableSheet(ctx) {
  const body = el("div", {}, [
    el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("sync.disableConfirm"))]),
  ]);
  const footer = el("div", { class: "sheet-foot" }, [
    el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => closeSheet() } }, [
      text(t("common.cancel")),
    ]),
    el(
      "button",
      {
        class: "btn is-primary",
        attrs: { type: "button" },
        on: {
          click: async () => {
            closeSheet();
            await ctx.sync.disable();
            ctx.toast(t("sync.disabled"));
            ctx.render();
          },
        },
      },
      [text(t("sync.disable"))],
    ),
  ]);
  ctx.openSheet({ title: t("sync.disable"), body, footer });
}

/** "at 08:00" - the hour, in the plain 24 hour form every locale can read. */
function hourLabel(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

/**
 * The reminder sheet: what it does, what it costs in honesty, and the hour.
 * Turning it on asks the browser for permission at the moment of the press,
 * which is the only moment a permission prompt is not an ambush.
 */
function reminderSheet(ctx) {
  const status = ctx.push.status;
  const field = el("input", {
    class: "input",
    attrs: { type: "number", min: "0", max: "23", step: "1", inputmode: "numeric", "aria-label": t("push.hour") },
  });
  field.value = String(status.hour);

  const body = el("div", {}, [
    el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("push.body"))]),
    el("div", { class: "field" }, [
      el("span", { class: "field-label" }, [text(t("push.hour"))]),
      field,
      el("p", { class: "field-hint" }, [text(t("push.hourHint"))]),
    ]),
    el("p", { class: "field-hint" }, [text(t("push.ios"))]),
    // The icon counter rides on the same permission: iOS only badges a web
    // app once notifications are authorised, so a user who skips the reminder
    // silently loses the badge too - say so where the decision is made.
    el("p", { class: "field-hint" }, [text(t("push.badge"))]),
  ]);

  const apply = async () => {
    const hour = Number(field.value);
    closeSheet();
    try {
      await ctx.push.enable(Number.isFinite(hour) ? hour : 8);
      ctx.toast(t("push.on", { time: hourLabel(Math.max(0, Math.min(23, Math.trunc(hour)))) }));
    } catch (err) {
      ctx.toast(t(`push.error.${err && err.code ? err.code : "server"}`));
    }
    await ctx.push.refresh();
    ctx.render();
  };

  const footer = el("div", { class: "sheet-foot" }, [
    status.enabled
      ? el(
          "button",
          {
            class: "btn",
            attrs: { type: "button" },
            on: {
              click: async () => {
                closeSheet();
                await ctx.push.disable();
                await ctx.push.refresh();
                ctx.toast(t("push.off"));
                ctx.render();
              },
            },
          },
          [text(t("push.disable"))],
        )
      : el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => closeSheet() } }, [
          text(t("common.cancel")),
        ]),
    el("button", { class: "btn is-primary", attrs: { type: "button" }, on: { click: apply } }, [
      text(status.enabled ? t("common.save") : t("push.enable")),
    ]),
  ]);
  ctx.openSheet({ title: t("push.title"), body, footer });
}

/** The reminder row. Only exists with sync on - the server needs the vault. */
function reminderRow(ctx) {
  const status = ctx.push.status;
  if (!status.supported) {
    return row("push.title", "push.unsupported", null, null, { disabled: true });
  }
  if (status.permission === "denied") {
    return row("push.title", "push.error.denied", null, null, { disabled: true });
  }
  return status.enabled
    ? row("push.title", "push.onDesc", hourLabel(status.hour), () => reminderSheet(ctx))
    : row("push.enable", "push.enableDesc", null, () => reminderSheet(ctx));
}

/**
 * The home-screen widget's one switch: may it show the name of the top goal?
 *
 * Where this lives is the point. The widget is drawn by the native shell, but
 * the decision belongs inside the vault - it travels with the document to
 * every device, it survives a reinstall, and there is exactly one place to
 * look for the answer. A native settings screen would have been a second
 * source of truth for the one setting in this app that moves text out of the
 * encryption.
 *
 * The whole group is absent without a widget to configure - in a browser, or
 * on a shell too old to advertise the capability. A disabled row would be an
 * offer the app cannot keep.
 *
 * Off by default, and the two hints under it say plainly what "on" means: not
 * "improves your home screen" but "puts this goal's name where anybody looking
 * at the phone can read it". Somebody may well want exactly that. They should
 * want it knowing.
 */
function widgetGroup(ctx) {
  if (!widgetSupported()) return null;
  const settings = (ctx.doc && ctx.doc.settings) || {};
  return group("settings.group.widget", [
    segment(
      "settings.widgetTitle",
      DEPTH,
      settings.widgetTitle === true ? "on" : "off",
      (v) => t(`settings.widgetTitle.${v}`),
      (v) => ctx.setSettings({ widgetTitle: v === "on" }),
    ),
    el("p", { class: "field-hint", style: { padding: "0 2px" } }, [text(t("settings.widgetTitleDesc"))]),
    el("p", { class: "field-hint", style: { padding: "0 2px" } }, [text(t("settings.widgetTitleWarn"))]),
  ]);
}

/** The whole sync group: off = one row, on = status, pairing code, off switch. */
function syncGroup(ctx) {
  if (!ctx.sync.enabled) {
    return group("settings.group.sync", [
      row("sync.enable", "sync.enableDesc", null, async () => {
        ctx.toast(t("sync.enabling"));
        await ctx.sync.enable();
        ctx.render();
      }),
    ]);
  }
  return group("settings.group.sync", [
    syncStatusRow(ctx),
    row("sync.pairing", "sync.pairingDesc", null, () => pairingSheet(ctx)),
    reminderRow(ctx),
    row("sync.disable", "sync.disableDesc", null, () => disableSheet(ctx), { danger: true }),
  ]);
}

// ----------------------------------------------------------------- security

/**
 * Turning the enrolment off again. The passphrase and the recovery key are
 * untouched, and so is every other device: each credential carries its own
 * wrapper label, so this removes exactly one envelope.
 */
function biometricOffSheet(ctx) {
  const body = el("div", {}, [
    el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("webauthn.removeBody"))]),
  ]);
  const footer = el("div", { class: "sheet-foot" }, [
    el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => closeSheet() } }, [
      text(t("common.cancel")),
    ]),
    el(
      "button",
      {
        class: "btn is-primary",
        attrs: { type: "button" },
        on: {
          click: async () => {
            closeSheet();
            await ctx.biometric.remove();
            ctx.toast(t("webauthn.removed"));
            ctx.render();
          },
        },
      },
      [text(t("webauthn.remove"))],
    ),
  ]);
  ctx.openSheet({ title: t("webauthn.removeTitle"), body, footer });
}

/**
 * The row only exists where the platform says it has a user-verifying
 * authenticator of its own. Whether that authenticator also does PRF is only
 * knowable once the prompt has run, so enrolment is allowed to fail and says
 * so in one line instead of pretending.
 */
function biometricRow(ctx) {
  if (!ctx.biometric.supported) return null;
  const known = ctx.biometric.availableCached;
  if (known === null) {
    // Not asked yet: ask, and repaint once if the answer turns out to be yes.
    ctx.biometric.available().then((ok) => {
      if (ok && ctx.view.name === "settings") ctx.repaint();
    });
    return null;
  }
  if (known !== true) return null;
  if (ctx.biometric.enrolled) {
    return row("webauthn.title", "webauthn.onDesc", t("webauthn.on"), () => biometricOffSheet(ctx));
  }
  return row("webauthn.title", "webauthn.desc", null, async () => {
    try {
      await ctx.biometric.enrol();
      ctx.toast(t("webauthn.enrolled"));
    } catch {
      ctx.toast(t("webauthn.failed"));
    }
    ctx.render();
  });
}

/**
 * Turning the shell's biometric envelope off. The words are the same ones the
 * browser path uses - the passphrase and the recovery key are untouched, other
 * devices keep their own - because to the person reading them it is the same
 * sentence. What differs underneath: the key leaves the device's Keychain too.
 */
function shellBioOffSheet(ctx) {
  const body = el("div", {}, [
    el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("webauthn.removeBody"))]),
  ]);
  const footer = el("div", { class: "sheet-foot" }, [
    el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => closeSheet() } }, [
      text(t("common.cancel")),
    ]),
    el(
      "button",
      {
        class: "btn is-primary",
        attrs: { type: "button" },
        on: {
          click: async () => {
            closeSheet();
            await ctx.shellBio.remove();
            ctx.toast(t("webauthn.removed"));
            ctx.render();
          },
        },
      },
      [text(t("webauthn.remove"))],
    ),
  ]);
  ctx.openSheet({ title: t("webauthn.removeTitle"), body, footer });
}

/**
 * The same row, for the shell's own path. It exists only where the shell
 * advertises the capability, which it does only where the device has the
 * hardware - so this never draws a switch that can never be turned on.
 *
 * Two facts, two answers: no hardware means no row at all; hardware with
 * nothing enrolled means a row that says so and does nothing, because "set Face
 * ID up first" is an honest sentence and a dead button is not.
 *
 * After an enrolment change the row is the whole re-offer. One line, in the
 * place somebody goes to look for it, rather than a sheet that interrupts the
 * unlock they were in the middle of.
 */
function shellBioRow(ctx) {
  if (!ctx.shellBio.supported) return null;
  const known = ctx.shellBio.availableCached;
  if (known === null) {
    // Not asked yet: ask, and repaint once if the answer turns out to be yes.
    ctx.shellBio.available().then((a) => {
      if (a && a.available && ctx.view.name === "settings") ctx.repaint();
    });
    return null;
  }
  if (!known.available) return null;
  if (ctx.shellBio.enabled) {
    return row("webauthn.title", "webauthn.onDesc", t("webauthn.on"), () => shellBioOffSheet(ctx));
  }
  if (!known.enrolled) {
    return row("webauthn.title", "bio.notEnrolled", null, null, { disabled: true });
  }
  const again = ctx.shellBio.setupAgain;
  return row(again ? "bio.setupAgain" : "webauthn.title", again ? "bio.setupAgainDesc" : "webauthn.desc", null, async () => {
    try {
      await ctx.shellBio.enable();
      ctx.toast(t("webauthn.enrolled"));
    } catch {
      ctx.toast(t("webauthn.failed"));
    }
    ctx.render();
  });
}

/**
 * What is offered when the server copy could not be removed: nothing has
 * happened yet, and the honest choice is either to try again later or to wipe
 * this device only - knowing that the copy up there stays.
 */
function deleteFailedSheet(ctx, code) {
  const body = el("div", {}, [
    el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t(`danger.failed.${code}`))]),
    el("p", { class: "check-text" }, [text(t("danger.failed.body"))]),
  ]);
  const footer = el("div", { class: "sheet-foot" }, [
    el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => closeSheet() } }, [
      text(t("common.cancel")),
    ]),
    el(
      "button",
      {
        class: "btn is-primary",
        attrs: { type: "button" },
        on: {
          click: async () => {
            closeSheet();
            await ctx.wipeLocalVault();
            ctx.toast(t("danger.localDone"));
          },
        },
      },
      [text(t("danger.failed.localOnly"))],
    ),
  ]);
  ctx.openSheet({ title: t("danger.failed.title"), body, footer });
}

/**
 * The full deletion. Everything that dies is named before anything happens -
 * the server copy, this device, and the honest sentence about the other paired
 * devices, which keep their local list and would create a NEW server copy if
 * they ever pushed again. The confirmation is the same acknowledgement box the
 * recovery key uses: a checkbox, not a countdown - a timer that runs while a
 * person reads is theatre, a box they have to tick is a decision.
 */
function deleteEverywhereSheet(ctx) {
  const box = el("input", { attrs: { type: "checkbox" } });
  const confirm = el(
    "button",
    { class: "btn is-primary", attrs: { type: "button", disabled: "disabled" } },
    [text(t("danger.confirm"))],
  );
  box.addEventListener("change", () => {
    if (box.checked) confirm.removeAttribute("disabled");
    else confirm.setAttribute("disabled", "disabled");
  });
  confirm.addEventListener("click", async () => {
    if (!box.checked) return;
    closeSheet();
    try {
      await ctx.deleteEverywhere();
    } catch (err) {
      if (err && err.name === "SyncError") {
        // The server refused or could not be reached, and nothing local has
        // been touched: the vault is still here, and so is the copy up there.
        // Say which of the two failed and offer the smaller action instead of
        // pretending the big one worked.
        const code = err.code === "offline" || err.code === "denied" ? err.code : "server";
        deleteFailedSheet(ctx, code);
        return;
      }
      // The server copy is gone by now; it is this device that would not let
      // go. One honest line, and the browser's own site-data switch as the way
      // to finish it.
      ctx.toast(t("danger.localFailed"));
      return;
    }
    ctx.toast(t("danger.done"));
  });

  const body = el("div", {}, [
    el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("danger.body"))]),
    el("p", { class: "check-text" }, [text(t(ctx.sync.enabled ? "danger.server" : "danger.serverNone"))]),
    el("p", { class: "check-text" }, [text(t("danger.device"))]),
    el("p", { class: "check-text" }, [text(t("danger.others"))]),
    el("p", { class: "check-text" }, [text(t("danger.final"))]),
    el("label", { class: "check" }, [
      box,
      el("span", { class: "check-box" }, [icon("check", 14)]),
      el("span", { class: "check-text" }, [text(t("danger.ack"))]),
    ]),
  ]);
  const footer = el("div", { class: "sheet-foot" }, [
    el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => closeSheet() } }, [
      text(t("common.cancel")),
    ]),
    confirm,
  ]);
  ctx.openSheet({ title: t("danger.title"), body, footer });
}

function plaintextSheet(ctx) {
  const body = el("div", {}, [
    el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("settings.exportPlainWarn"))]),
  ]);
  const footer = el("div", { class: "sheet-foot" }, [
    el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => closeSheet() } }, [
      text(t("common.cancel")),
    ]),
    el(
      "button",
      {
        class: "btn is-primary",
        attrs: { type: "button" },
        on: {
          click: () => {
            ctx.download(exportPlaintextMarkdown(ctx.doc), "tenfold-plaintext.md");
            closeSheet();
            // A file left this app, so the vault is no longer the only copy -
            // the outline's quiet "only in this browser" clause can go.
            ctx.setSettings({ exportedAt: ctx.now() });
            ctx.toast(t("toast.exported"));
          },
        },
      },
      [text(t("settings.exportPlainConfirm"))],
    ),
  ]);
  ctx.openSheet({ title: t("settings.exportPlain"), body, footer });
}

export function render(ctx) {
  const settings = ctx.doc.settings || {};

  // Whether a push subscription exists is a fact of the browser, not of the
  // document, so it can only be read asynchronously. The row is drawn from the
  // last known state and repainted once - and only if - that turns out stale.
  if (ctx.sync.enabled) {
    ctx.push.refresh().then((changed) => {
      if (changed && ctx.view.name === "settings") ctx.repaint();
    });
  }

  const file = el("input", { class: "sr-only", attrs: { type: "file", accept: ".tenfold,application/json" } });
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      const vault = await importEncrypted(f);
      await ctx.setVault(vault);
      ctx.toast(t("toast.imported"));
    } catch {
      ctx.toast(t("toast.importFailed"));
    }
  });

  const importSheet = () => {
    const body = el("div", {}, [
      el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("settings.importConfirm"))]),
    ]);
    const footer = el("div", { class: "sheet-foot" }, [
      el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => closeSheet() } }, [
        text(t("common.cancel")),
      ]),
      el(
        "button",
        {
          class: "btn is-primary",
          attrs: { type: "button" },
          on: {
            click: () => {
              closeSheet();
              file.click();
            },
          },
        },
        [text(t("common.continue"))],
      ),
    ]);
    ctx.openSheet({ title: t("settings.import"), body, footer });
  };

  const head = el("div", { class: "head" }, [
    el("div", { class: "head-row" }, [
      el("div", {}, [
        brandMark(),
        el("h1", { class: "h-title" }, [text(t("settings.title"))]),
      ]),
      el("div", { class: "head-actions" }, [
        el(
          "button",
          {
            class: "iconbtn",
            attrs: { type: "button", "aria-label": t("common.close") },
            on: { click: () => ctx.back() },
          },
          [icon("close", 20)],
        ),
      ]),
    ]),
  ]);

  const body = el("div", { class: "scroll" }, [
    group("settings.group.look", [
      segment("settings.skin", SKINS, settings.skin || "slate", (v) => t(`settings.skin.${v}`), (v) =>
        ctx.setSettings({ skin: v }),
      ),
      segment("settings.theme", THEMES, settings.theme || "dark", (v) => t(`settings.theme.${v}`), (v) =>
        ctx.setSettings({ theme: v }),
      ),
      segment("settings.language", LOCALES, settings.lang || getLocale(), (v) => t(`settings.lang.${v}`), (v) =>
        ctx.setSettings({ lang: v }),
      ),
      // Which screen an unlock opens. It sits in this group rather than in one
      // of its own: a group heading for a single segment would make the
      // smallest switch in the app look like a subsystem, and what somebody
      // sees when the app opens is close enough to what the app looks like.
      segment("settings.landing", LANDINGS, settings.landing || "today", (v) => t(`${v}.title`), (v) =>
        ctx.setSettings({ landing: v }),
      ),
      // The honest line, and the reason this control needs one at all: "Today"
      // does not always open Today. It is the rule from app.js `somethingWaits`
      // - with nothing due and the question answered it opens The Ten, because
      // an empty Today is nobody's preferred start - and a person who picked
      // Today and got The Ten would otherwise think the setting was broken. The
      // same field-hint paragraph the story depth and the widget title use; a
      // description slot on `segment` would have been a layout component built
      // for one caller.
      el("p", { class: "field-hint", style: { padding: "0 2px" } }, [text(t("settings.landingDesc"))]),
    ]),
    group("settings.group.story", [
      row("entities.open", "entities.openDesc", null, () => ctx.go("entities")),
      segment(
        "story.depth",
        DEPTH,
        settings.storyDepth === false ? "off" : "on",
        (v) => t(`story.depth.${v}`),
        (v) => ctx.setSettings({ storyDepth: v === "on" }),
      ),
      el("p", { class: "field-hint", style: { padding: "0 2px" } }, [text(t("story.depthDesc"))]),
    ]),
    group("settings.group.data", [
      row("settings.export", "settings.exportDesc", null, () => {
        ctx.download(exportEncrypted(ctx.vault), suggestedVaultFileName(ctx.now()));
        // Same reasoning as the plaintext export: a copy now exists off-device.
        ctx.setSettings({ exportedAt: ctx.now() });
        ctx.toast(t("toast.exported"));
      }),
      row("settings.import", "settings.importDesc", null, importSheet),
      row("settings.exportPlain", "settings.exportPlainDesc", null, () => plaintextSheet(ctx)),
      persistenceRow(ctx),
      row(
        "settings.lastSaved",
        null,
        ctx.savedAt ? relativeTime(ctx.savedAt, ctx.now()) : t("settings.lastSavedNever"),
        null,
        { disabled: true },
      ),
      file,
    ]),
    syncGroup(ctx),
    // Next to the reminder, which is the app's other outside surface - and
    // deliberately NOT inside the sync group above it: a widget is a local
    // fact about a local list and has nothing to do with a server.
    widgetGroup(ctx),
    // An assistance group stood here until v1.1: a mode switch (off/local/
    // cloud), a provider, a model, an API key and a connection test. It went
    // with the relay it configured. The copy loop that replaced it has nothing
    // to set up, so this screen has nothing to say about it.
    group("settings.group.security", [
      // Never both: webauthn.supported() is false inside the shell, and the
      // capability behind the second one does not exist in a browser.
      biometricRow(ctx),
      shellBioRow(ctx),
      row("settings.lock", "settings.lockDesc", null, () => ctx.lock(false), { danger: true }),
      // The last row of the whole screen that does anything: the way out of
      // this app that leaves nothing behind. It sits at the bottom of the
      // security group because that is where a danger zone belongs - reachable,
      // never in the way of something ordinary.
      row("danger.delete", "danger.deleteDesc", null, () => deleteEverywhereSheet(ctx), { danger: true }),
    ]),
    group("settings.group.app", [
      row("settings.about", "settings.aboutDesc", null, () => ctx.go("about")),
      // A sibling of the row above, not a feature: the same document the About
      // screen and the lock screen link, reached from the place somebody who
      // already uses the app goes looking. A real anchor rather than a row that
      // navigates, because the destination is a page outside this app.
      methodRow(),
      // The tip jar, next to the version rather than anywhere near the data:
      // it is a fact about the app, not a switch. Absent inside the native
      // shell, where an external payment link is not allowed to exist.
      supportAvailable() ? row("support.row", "support.rowDesc", null, () => openSupportSheet(ctx)) : null,
      row("settings.version", null, `${ctx.version} \u00b7 ${ctx.cacheVersion}`, null, { disabled: true }),
    ]),
  ]);

  return el("section", { class: "screen" }, [head, body]);
}
