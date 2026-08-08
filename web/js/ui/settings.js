// ui/settings.js - the small set of switches this app has.
//
// What it does: skin, theme, language, the two exports and the one import,
// what the browser says about keeping the data, when it was last saved, and
// the button that locks everything again.
//
// What it deliberately does NOT do: no account, no sync toggle, no telemetry
// switch (there is nothing to switch off), no theme preview screen. The
// unencrypted export is behind a sheet that states plainly what it means.

import { el, text, icon } from "./dom.js";
import { t, LOCALES } from "../i18n.js";
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
      segment("settings.language", LOCALES, settings.lang || "en", (v) => t(`settings.lang.${v}`), (v) =>
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
