// ui/editor.js - the edit sheet for one node.
//
// What it does: the full field set of a node - title, note, definition of done,
// due date, effort in minutes, state - in one bottom sheet, with a single save
// that hands a patch to the context.
//
// What it deliberately does NOT do: no partial autosave while typing (a half
// typed title should not be what survives a lock), no markdown, no rich text,
// no innerHTML. Values are read from the inputs at save time and nowhere else.

import { el, text, icon, clear } from "./dom.js";
import { openSheet, closeSheet } from "./sheet.js";
import { t } from "../i18n.js";
import { dateInputValue, dateInputToTs } from "./format.js";

const STATUSES = ["open", "doing", "done", "parked"];

function field(labelKey, control) {
  const id = `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return el("div", { class: "field" }, [
    el("label", { class: "field-label", attrs: { for: id } }, [text(t(labelKey))]),
    control,
  ]);
}

export function openEditor(layer, ctx, node) {
  const title = el("input", {
    class: "input",
    attrs: { type: "text", placeholder: t("editor.titlePlaceholder"), autocomplete: "off" },
  });
  title.value = node.title || "";

  const note = el("textarea", {
    class: "textarea",
    attrs: { placeholder: t("editor.notePlaceholder"), rows: "4" },
  });
  note.value = node.note || "";

  const doneWhen = el("textarea", {
    class: "textarea",
    attrs: { placeholder: t("editor.doneWhenPlaceholder"), rows: "2" },
  });
  doneWhen.value = node.doneWhen || "";
  doneWhen.style.minHeight = "64px";

  const due = el("input", { class: "input", attrs: { type: "date" } });
  due.value = dateInputValue(node.due);

  const effort = el("input", {
    class: "input",
    attrs: { type: "number", inputmode: "numeric", min: "0", step: "5", placeholder: t("editor.effortPlaceholder") },
  });
  effort.value = typeof node.effortMinutes === "number" ? String(node.effortMinutes) : "";

  let status = STATUSES.includes(node.status) ? node.status : "open";
  const seg = el(
    "div",
    { class: "seg", attrs: { role: "group", "aria-label": t("editor.statusLabel") } },
    STATUSES.map((s) =>
      el(
        "button",
        {
          attrs: { type: "button", "aria-pressed": s === status ? "true" : "false" },
          on: {
            click: (ev) => {
              status = s;
              seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", "false"));
              ev.currentTarget.setAttribute("aria-pressed", "true");
            },
          },
        },
        [text(t(`status.${s}`))],
      ),
    ),
  );

  const error = el("div", { class: "field-error", attrs: { hidden: "hidden" } });

  const body = el("div", {}, [
    field("editor.title", title),
    error,
    field("editor.noteLabel", note),
    field("editor.doneWhenLabel", doneWhen),
    field("editor.dueLabel", due),
    field("editor.effortLabel", effort),
    el("div", { class: "field" }, [
      el("span", { class: "field-label" }, [text(t("editor.statusLabel"))]),
      seg,
    ]),
  ]);

  const save = () => {
    const value = title.value.trim();
    if (!value) {
      clear(error);
      error.removeAttribute("hidden");
      error.appendChild(text(t("editor.needsTitle")));
      title.focus();
      return;
    }
    const minutes = Number.parseInt(effort.value, 10);
    ctx.updateNode(node.id, {
      title: value,
      note: note.value,
      doneWhen: doneWhen.value,
      due: dateInputToTs(due.value),
      effortMinutes: Number.isFinite(minutes) ? minutes : null,
      status,
    });
    closeSheet();
    ctx.toast(t("toast.saved"));
  };

  const footer = el("div", { class: "sheet-foot" }, [
    el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => closeSheet() } }, [
      text(t("common.cancel")),
    ]),
    el("button", { class: "btn is-primary", attrs: { type: "button" }, on: { click: save } }, [
      icon("check", 17),
      text(t("common.save")),
    ]),
  ]);

  openSheet(layer, { title: t("editor.editTitle"), body, footer });
  queueMicrotask(() => title.focus());
}
