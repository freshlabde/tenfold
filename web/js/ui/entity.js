// ui/entity.js - the context index, and the two sheets that feed it.
//
// What it does: the screen that lists every card (who someone is to you, what
// has already happened, how sensitive it is), the sheet that creates or edits
// one, and the picker that links cards to a single node. Names, aliases,
// relations and notes are user content and travel exclusively as text nodes.
//
// What it deliberately does NOT do: it stores nothing itself - every change
// goes through the app context and lands in the sealed document. It never
// derives a card automatically; a detected name is only ever a prefilled
// suggestion the user confirms.

import { el, text, icon, clear, brandMark } from "./dom.js";
import { openSheet, closeSheet } from "./sheet.js";
import { t } from "../i18n.js";
import { ENTITY_KINDS } from "../model.js";
import { listEntities, entitiesForNode, nodesForEntity } from "../entities.js";

const SENSITIVITIES = ["normal", "high"];

function field(labelKey, control) {
  const id = `e-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return el("div", { class: "field" }, [
    el("label", { class: "field-label", attrs: { for: id } }, [text(t(labelKey))]),
    control,
  ]);
}

function segmented(labelKey, values, active, labelFor, onPick) {
  const seg = el(
    "div",
    { class: "seg", attrs: { role: "group", "aria-label": t(labelKey) } },
    values.map((v) =>
      el(
        "button",
        {
          attrs: { type: "button", "aria-pressed": v === active ? "true" : "false" },
          on: {
            click: (ev) => {
              onPick(v);
              seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", "false"));
              ev.currentTarget.setAttribute("aria-pressed", "true");
            },
          },
        },
        [text(labelFor(v))],
      ),
    ),
  );
  return el("div", { class: "field" }, [
    el("span", { class: "field-label" }, [text(t(labelKey))]),
    seg,
  ]);
}

/** One line under a card: what it is, and to whom. */
function cardSub(entity) {
  const parts = [t(`entities.kind.${entity.kind}`)];
  if (entity.relation) parts.push(entity.relation);
  return parts.join(" · ");
}

/**
 * The add/edit sheet.
 * @param {Element} layer
 * @param {Object} ctx
 * @param {Object|null} entity null = a new card
 * @param {{name?: string, link?: string}} [opts] prefilled name, node to link to
 */
export function openEntitySheet(layer, ctx, entity, opts = {}) {
  const existing = entity || null;

  const name = el("input", {
    class: "input",
    attrs: { type: "text", placeholder: t("entities.namePlaceholder"), autocomplete: "off" },
  });
  name.value = existing ? existing.name : opts.name || "";

  const aliases = el("input", {
    class: "input",
    attrs: { type: "text", placeholder: t("entities.aliasesPlaceholder"), autocomplete: "off" },
  });
  aliases.value = existing ? (existing.aliases || []).join(", ") : "";

  const relation = el("input", {
    class: "input",
    attrs: { type: "text", placeholder: t("entities.relationPlaceholder"), autocomplete: "off" },
  });
  relation.value = existing ? existing.relation : "";

  const notes = el("textarea", {
    class: "textarea",
    attrs: { rows: "4", placeholder: t("entities.notesPlaceholder"), spellcheck: "false" },
  });
  notes.value = existing ? existing.notes : "";

  let kind = existing && ENTITY_KINDS.includes(existing.kind) ? existing.kind : "person";
  let sensitivity = existing && existing.sensitivity === "high" ? "high" : "normal";

  const error = el("div", { class: "field-error", attrs: { hidden: "hidden" } });

  const body = el("div", {}, [
    field("entities.name", name),
    error,
    segmented("entities.kind", ENTITY_KINDS, kind, (v) => t(`entities.kind.${v}`), (v) => {
      kind = v;
    }),
    field("entities.relation", relation),
    field("entities.aliases", aliases),
    field("entities.notes", notes),
    segmented("entities.sensitivity", SENSITIVITIES, sensitivity, (v) => t(`entities.sensitivity.${v}`), (v) => {
      sensitivity = v;
    }),
    el("p", { class: "field-hint" }, [text(t("entities.sensitivityDesc"))]),
  ]);

  const save = () => {
    const value = name.value.trim();
    if (!value) {
      clear(error);
      error.removeAttribute("hidden");
      error.appendChild(text(t("entities.needsName")));
      name.focus();
      return;
    }
    const patch = {
      name: value,
      aliases: aliases.value.split(",").map((a) => a.trim()).filter(Boolean),
      kind,
      relation: relation.value.trim(),
      notes: notes.value,
      sensitivity,
    };
    const id = existing ? ctx.updateEntity(existing.id, patch) : ctx.addEntity(patch);
    if (!existing && opts.link && id) ctx.linkEntity(opts.link, id);
    closeSheet();
    ctx.toast(t("entities.saved"));
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

  if (existing) {
    body.appendChild(
      el(
        "button",
        {
          class: "setrow is-danger",
          attrs: { type: "button" },
          style: { marginTop: "18px" },
          on: {
            click: () => {
              ctx.deleteEntity(existing.id);
              closeSheet();
              ctx.toast(t("entities.deleted"));
            },
          },
        },
        [el("span", { class: "setrow-label" }, [text(t("common.delete"))]), icon("trash", 18)],
      ),
    );
  }

  openSheet(layer, {
    title: existing ? t("entities.editTitle") : t("entities.newTitle"),
    body,
    footer,
  });
  queueMicrotask(() => name.focus());
}

/**
 * The picker: link and unlink cards for one node, and create a new one from
 * here without leaving the step.
 */
export function openEntityPicker(layer, ctx, node) {
  const body = el("div", {});

  const paint = () => {
    clear(body);
    const current = ctx.nodeById(node.id) || node;
    const cards = listEntities(ctx.entities);
    // One line that carries the whole idea - the owner asked what these are
    // for: one card per person or thing, linkable to any number of steps.
    body.appendChild(
      el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("entities.linkHint"))]),
    );
    if (!cards.length) {
      body.appendChild(el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("entities.linkNone"))]));
    }
    for (const card of cards) {
      const linked = (current.entityRefs || []).includes(card.id);
      body.appendChild(
        el(
          "button",
          {
            class: "setrow",
            attrs: { type: "button", "aria-pressed": linked ? "true" : "false" },
            on: {
              click: () => {
                ctx.toggleEntityLink(current.id, card.id);
                paint();
              },
            },
          },
          [
            el("span", {}, [
              el("span", { class: "setrow-label" }, [text(card.name)]),
              el("span", { class: "setrow-desc" }, [text(cardSub(card))]),
            ]),
            linked ? icon("check", 18) : icon("plus", 18),
          ],
        ),
      );
    }
    body.appendChild(
      el(
        "button",
        {
          class: "setrow",
          attrs: { type: "button" },
          on: { click: () => openEntitySheet(layer, ctx, null, { link: node.id }) },
        },
        [el("span", { class: "setrow-label" }, [text(t("entities.add"))]), icon("plus", 18)],
      ),
    );
  };

  paint();
  openSheet(layer, { title: t("entities.linkTitle"), body });
}

/**
 * The chips under a step: the cards it is linked to, plus the way to add one.
 * `opts.hideWhenEmpty` returns null when nothing is linked - the leaf collects
 * every empty offer into one row of its own, and a lone "+" floating above it
 * was the same invitation twice.
 * @returns {Element|null}
 */
export function entityChips(ctx, node, opts = {}) {
  const cards = entitiesForNode(ctx.entities, node);
  if (!cards.length && opts.hideWhenEmpty) return null;
  const box = el("div", { class: "chips" });
  for (const card of cards) {
    box.appendChild(
      el(
        "button",
        {
          class: `chip${card.sensitivity === "high" ? " is-sensitive" : ""}`,
          attrs: { type: "button", "aria-label": t("a11y.openEntity", { name: card.name }) },
          on: { click: () => ctx.openEntity(card.id) },
        },
        [text(card.name)],
      ),
    );
  }
  box.appendChild(
    el(
      "button",
      {
        class: "chip is-add",
        attrs: { type: "button", "aria-label": t("entities.link") },
        on: { click: () => ctx.pickEntities(node) },
      },
      [icon("plus", 13), text(cards.length ? "" : t("entities.link"))],
    ),
  );
  return box;
}

function emptyState() {
  return el("div", { class: "empty" }, [
    el("div", { class: "empty-mark" }, [icon("mark", 30)]),
    el("p", { class: "empty-line" }, [text(t("entities.empty.line"))]),
    el("p", { class: "empty-hint" }, [text(t("entities.empty.hint"))]),
  ]);
}

export function render(ctx) {
  const cards = listEntities(ctx.entities);

  const head = el("div", { class: "head" }, [
    el("div", { class: "head-row" }, [
      el("div", {}, [
        brandMark(),
        el("h1", { class: "h-title" }, [text(t("entities.title"))]),
      ]),
      el("div", { class: "head-actions" }, [
        el(
          "button",
          {
            class: "iconbtn",
            attrs: { type: "button", "aria-label": t("entities.add") },
            on: { click: () => ctx.editEntity(null) },
          },
          [icon("plus", 20)],
        ),
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
    el("p", { class: "h-sub" }, [
      text(cards.length ? t("entities.count", { n: cards.length }) : t("entities.sub")),
    ]),
  ]);

  if (!cards.length) return el("section", { class: "screen" }, [head, emptyState()]);

  const list = el("div", { class: "scroll" });
  for (const card of cards) {
    const used = nodesForEntity(ctx.doc.nodes, card.id).length;
    list.appendChild(
      el(
        "button",
        {
          class: "setrow",
          attrs: { type: "button" },
          on: { click: () => ctx.editEntity(card.id) },
        },
        [
          el("span", {}, [
            el("span", { class: "setrow-label" }, [
              card.sensitivity === "high"
                ? el("span", { class: "dot-sensitive", attrs: { "aria-hidden": "true" } })
                : null,
              text(card.name),
            ]),
            el("span", { class: "setrow-desc" }, [text(cardSub(card))]),
          ]),
          el("span", { class: "m" }, [text(used ? t("entities.usedIn", { n: used }) : "")]),
        ],
      ),
    );
  }

  return el("section", { class: "screen" }, [head, list]);
}
