// ui/settings.js - the small set of switches this app has.
//
// What it does: skin, theme, language, the two exports and the one import,
// what the browser says about keeping the data, when it was last saved, and
// the button that locks everything again.
//
// What it deliberately does NOT do: no account, no telemetry switch (there is
// nothing to switch off), no theme preview screen. The unencrypted export is
// behind a sheet that states plainly what it means. The sync group is a
// status line and two actions - no progress bars, no spinner, no dialog: a
// sync that fails is a quiet dot, never an interruption.

import { el, text, icon } from "./dom.js";
import { t, LOCALES, getLocale } from "../i18n.js";
import { exportEncrypted, importEncrypted, exportPlaintextMarkdown, suggestedVaultFileName } from "../portability.js";
import { openSheet, closeSheet } from "./sheet.js";
import { relativeTime } from "./format.js";

const SKINS = ["slate", "register", "breath"];
const THEMES = ["dark", "light"];

function group(titleKey, children) {
  return el("div", { class: "group" }, [
    el("div", { class: "group-key" }, [text(t(titleKey))]),
    ...children,
  ]);
}

function segment(labelKey, values, active, labelFor, onPick) {
  return el("div", { style: { marginBottom: "10px" } }, [
    el("div", { class: "group-key", style: { paddingBottom: "6px" } }, [text(t(labelKey))]),
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

function persistenceLabel(ctx) {
  const p = ctx.persisted;
  if (!p) return t("settings.persistence.unsupported");
  if (!p.supported) return t("settings.persistence.unsupported");
  return p.persisted ? t("settings.persistence.granted") : t("settings.persistence.denied");
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

/** The pairing sheet: the grouped code, and the same code as a link. */
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

  const body = el("div", {}, [
    el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("sync.pairing.body"))]),
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
    row("sync.disable", "sync.disableDesc", null, () => disableSheet(ctx), { danger: true }),
  ]);
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
        el("div", { class: "eyebrow" }, [text(t("app.name"))]),
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
    ]),
    group("settings.group.data", [
      row("settings.export", "settings.exportDesc", null, () => {
        ctx.download(exportEncrypted(ctx.vault), suggestedVaultFileName(ctx.now()));
        ctx.toast(t("toast.exported"));
      }),
      row("settings.import", "settings.importDesc", null, importSheet),
      row("settings.exportPlain", "settings.exportPlainDesc", null, () => plaintextSheet(ctx)),
      row("settings.persistence", "settings.persistenceDesc", persistenceLabel(ctx), () => ctx.refreshPersistence().then(() => ctx.render())),
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
    group("settings.group.security", [
      row("settings.lock", "settings.lockDesc", null, () => ctx.lock(false), { danger: true }),
    ]),
    group("settings.group.app", [
      row("settings.about", "settings.aboutDesc", null, () => ctx.go("about")),
      row("settings.version", null, ctx.version, null, { disabled: true }),
    ]),
  ]);

  return el("section", { class: "screen" }, [head, body]);
}
