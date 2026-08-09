// ui/leaf.js - one step, in full.
//
// What it does: shows the title and the story - that is the screen - and lets
// everything else be secondary. What a node actually carries (finished-when,
// note, due, effort) is set as a short ledger of glyph rows underneath;
// whatever it does NOT carry is a single row of quiet add chips, never a box
// that says "not set". The ancestry is not repeated here, it is the breadcrumb
// at the top. Created and state sink to one mono microline at the very bottom.
// Exactly one cast action sits in the bar: done.
//
// What it deliberately does NOT do: no editing in place. Changing a value
// opens the editor sheet (focused on the field that was tapped), so a stray tap
// on a phone cannot silently rewrite a due date. Deleting always goes through
// the undo toast. The name hint is one line that can be dismissed - never a
// modal, never a second time. No empty field ever renders as a card: an empty
// field is an offer, and an offer is a chip.

import { el, text, icon, depthMark } from "./dom.js";
import { t, getLocale } from "../i18n.js";
import { formatDate, dueLabel, relativeTime } from "./format.js";
import { storyDepth } from "../model.js";
import { detectNames, foldName } from "../entities.js";
import { entityChips } from "./entity.js";

/** A minute of slack: below it, "created" and "edited" are the same event. */
const EDIT_GRACE = 60000;

/**
 * One ledger row: a glyph in the rail, a value next to it. Short values sit on
 * the line itself (mono, with an optional accent remark); prose gets a small
 * key above it, because a paragraph is not self-describing the way a date is.
 */
function fact(glyph, { value, remark, key, prose }) {
  const body = el("div", { class: "fact-body" });
  if (key) body.appendChild(el("span", { class: "fact-key" }, [text(t(key))]));
  if (value) {
    body.appendChild(
      el("span", { class: "fact-line" }, [
        el("span", { class: "fact-val" }, [text(value)]),
        remark ? el("span", { class: "fact-remark" }, [text(remark)]) : null,
      ]),
    );
  }
  if (prose) body.appendChild(el("p", { class: "fact-prose" }, [text(prose)]));
  return el("div", { class: "fact" }, [
    el("span", { class: "fact-glyph", attrs: { "aria-hidden": "true" } }, [icon(glyph, 17)]),
    body,
  ]);
}

/** A quiet offer to fill one field. Opens the editor on that field. */
function addChip(ctx, node, glyph, labelKey, focus) {
  return el(
    "button",
    {
      class: "chip is-add is-field",
      attrs: { type: "button", "aria-label": t("leaf.add", { what: t(labelKey) }) },
      on: { click: () => ctx.editNode(node, focus) },
    },
    [icon(glyph, 14), text(t(labelKey))],
  );
}

function crumb(ctx, node) {
  const chain = ctx.ancestors(node.id);
  const box = el("nav", { class: "crumb", attrs: { "aria-label": t("common.back") } }, [
    el(
      "button",
      {
        class: "crumb-back",
        attrs: { type: "button", "aria-label": t("a11y.back") },
        on: { click: () => ctx.back() },
      },
      [icon("chevronLeft", 16)],
    ),
  ]);
  // The way out to the ten, first and always - the focus screen has carried it
  // since the beginning, and a leaf that hid it made the same row of pills mean
  // two different things one tap apart. This row is also the ONLY place the
  // ancestry is stated; the old "belongs to" card said the same thing twice.
  box.appendChild(
    el(
      "button",
      { class: "crumb-pill", attrs: { type: "button" }, on: { click: () => ctx.go("outline", null, { replace: true }) } },
      [text(t("focus.root"))],
    ),
  );
  const shown = chain.slice(-1);
  shown.forEach((a) => {
    box.appendChild(el("span", { class: "crumb-caret", attrs: { "aria-hidden": "true" } }, [icon("chevronRight", 11)]));
    box.appendChild(
      el("button", { class: "crumb-pill", attrs: { type: "button" }, on: { click: () => ctx.go("focus", a.id) } }, [
        text(a.title),
      ]),
    );
  });
  box.appendChild(el("span", { style: { flex: "1 1 auto" }, attrs: { "aria-hidden": "true" } }));
  box.appendChild(
    el(
      "button",
      {
        class: "iconbtn",
        attrs: { type: "button", "aria-label": t("a11y.menu") },
        on: { click: () => ctx.openRowMenu(node) },
      },
      [icon("dots", 20)],
    ),
  );
  return box;
}

/**
 * The one quiet question about a name that keeps coming up here. Only a name
 * that appears in THIS node is offered - a hint about something on another
 * screen would be noise.
 */
function nameHint(ctx, node) {
  const settings = ctx.doc.settings || {};
  const candidates = detectNames(ctx.doc.nodes, ctx.entities, {
    locale: getLocale(),
    dismissed: settings.dismissedNames,
  });
  if (!candidates.length) return null;
  const here = `${node.title || ""}\n${node.story || ""}`;
  const hit = candidates.find((c) => foldName(here).includes(foldName(c.name)));
  if (!hit) return null;

  return el("div", { class: "hintrow" }, [
    el(
      "button",
      {
        class: "hintchip",
        attrs: { type: "button" },
        on: { click: () => ctx.editEntity(null, { name: hit.name, link: node.id }) },
      },
      [text(t("entities.whoIs", { name: hit.name }))],
    ),
    el(
      "button",
      {
        class: "iconbtn is-small",
        attrs: { type: "button", "aria-label": t("entities.dismiss") },
        on: { click: () => ctx.dismissName(hit.name) },
      },
      [icon("close", 15)],
    ),
  ]);
}

/**
 * The assistance block. It exists only when assistance is switched on at all -
 * in "off" mode not one of these elements is built. A step that is kept away
 * from the model has no assist entry; a step that inherits that decision says
 * where it came from and offers no switch, because the switch belongs to the
 * goal it was thrown on. Ghost throughout: the accent on this screen belongs
 * to the one cast action in the bar.
 */
function assistBlock(ctx, node) {
  if (!ctx.llmOn) return null;
  const keep = ctx.optout(node.id);
  const box = el("section", { class: "assist-foot", dataset: { llm: "leaf" } });

  if (!keep.own && !keep.inherited) {
    box.appendChild(
      el(
        "button",
        {
          class: "leaf-act",
          attrs: { type: "button" },
          on: { click: () => ctx.assist(node) },
        },
        [icon("target", 15), text(t("llm.assist"))],
      ),
    );
  }

  if (keep.inherited) {
    box.appendChild(
      el("p", { class: "field-hint" }, [text(t("llm.optoutInherited", { title: keep.source }))]),
    );
  } else {
    box.appendChild(
      el(
        "button",
        {
          class: "leaf-act",
          attrs: { type: "button" },
          on: { click: () => ctx.toggleOptout(node) },
        },
        [icon("lock", 15), text(keep.own ? t("llm.optoutOff") : t("llm.optout"))],
      ),
    );
  }
  return box;
}

export function render(ctx, id) {
  const node = ctx.nodeById(id);
  if (!node) {
    ctx.go("outline", null, { replace: true });
    return el("section", { class: "screen" });
  }
  const now = ctx.now();
  const isDone = node.status === "done";
  const showDepth = (ctx.doc.settings || {}).storyDepth !== false;
  const told = String(node.story || "").trim();
  const doneWhen = String(node.doneWhen || "").trim();
  const note = String(node.note || "").trim();
  const hasDue = typeof node.due === "number";
  const hasEffort = typeof node.effortMinutes === "number";

  // Prose first, machine values after: the ledger reads downwards from what
  // was written to what was measured, and ends where the mono microline picks
  // the rail back up.
  const facts = [
    doneWhen ? fact("flag", { key: "leaf.doneWhen", prose: doneWhen }) : null,
    note ? fact("note", { key: "leaf.note", prose: note }) : null,
    hasDue
      ? fact("calendar", { value: formatDate(node.due), remark: dueLabel(node.due, now) })
      : null,
    hasEffort ? fact("gauge", { value: t("leaf.minutes", { n: node.effortMinutes }) }) : null,
  ].filter(Boolean);

  const cards = entityChips(ctx, node, { hideWhenEmpty: true });

  // Everything the step does not carry, collected in one row - including the
  // offer to link a card when none is linked yet.
  const offers = [
    doneWhen ? null : addChip(ctx, node, "flag", "leaf.doneWhen", "doneWhen"),
    note ? null : addChip(ctx, node, "note", "leaf.note", "note"),
    hasDue ? null : addChip(ctx, node, "calendar", "leaf.due", "due"),
    hasEffort ? null : addChip(ctx, node, "gauge", "leaf.effort", "effort"),
    cards
      ? null
      : el(
          "button",
          {
            class: "chip is-add is-field",
            attrs: { type: "button", "aria-label": t("entities.link") },
            on: { click: () => ctx.pickEntities(node) },
          },
          [icon("plus", 14), text(t("entities.link"))],
        ),
  ].filter(Boolean);

  // Trivia, and it looks like trivia: when the step was written down, where it
  // stands, and - only if it was ever touched again - when that was.
  const micro = [t("leaf.createdAt", { date: formatDate(node.createdAt) }), t(`status.${node.status}`)];
  if (typeof node.updatedAt === "number" && node.updatedAt - node.createdAt > EDIT_GRACE) {
    micro.push(t("leaf.edited", { when: relativeTime(node.updatedAt, now) }));
  }

  const doneBtn = el(
    "button",
    {
      class: "btn is-primary is-big is-wide",
      attrs: { type: "button" },
      on: { click: () => ctx.setStatus(node.id, isDone ? "open" : "done") },
    },
    [icon(isDone ? "arrowLeft" : "check", 18), text(isDone ? t("leaf.markOpen") : t("leaf.markDone"))],
  );

  const alt = el("div", { class: "leaf-alt" }, [
    el("button", { class: "btn-ghost", attrs: { type: "button" }, on: { click: () => ctx.editNode(node) } }, [
      text(t("common.edit")),
    ]),
    el("button", { class: "btn-ghost", attrs: { type: "button" }, on: { click: () => ctx.go("focus", node.id) } }, [
      text(t("focus.addChild")),
    ]),
    el("button", { class: "btn-ghost", attrs: { type: "button" }, on: { click: () => ctx.deleteNode(node) } }, [
      text(t("common.delete")),
    ]),
  ]);

  return el("section", { class: "screen" }, [
    crumb(ctx, node),
    el("div", { class: "scroll is-leaf" }, [
      el("div", { class: "leaf-head" }, [
        el("h1", { class: "leaf-title" }, [text(node.title)]),
        // The rail mark: a finished step wears the one green check the rows
        // wear, an open one its story-depth ring.
        isDone
          ? el("span", { class: "leaf-seal", attrs: { "aria-hidden": "true" } }, [icon("check", 14)])
          : showDepth
            ? depthMark(storyDepth(node))
            : null,
      ]),
      told ? el("div", { class: "leaf-story" }, [text(node.story)]) : null,
      el(
        "button",
        {
          class: "leaf-act",
          attrs: { type: "button" },
          on: { click: () => ctx.startStoryGuide(node) },
        },
        [icon("speech", 15), text(told ? t("story.continue") : t("story.tell"))],
      ),
      nameHint(ctx, node),
      facts.length ? el("div", { class: "facts" }, facts) : null,
      cards,
      offers.length ? el("div", { class: "chips is-offers" }, offers) : null,
      assistBlock(ctx, node),
      el("p", { class: "microline" }, [text(micro.join(" · "))]),
    ]),
    el("div", { class: "leaf-bar" }, [doneBtn, alt]),
  ]);
}
