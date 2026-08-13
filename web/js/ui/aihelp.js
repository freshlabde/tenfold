// ui/aihelp.js - the copy loop, as a sheet.
//
// What it does: two halves of one round trip. On the way out it shows the
// prompt this app built for the goal that is open, says in one line what
// travels with it, and hands it to the clipboard or the share menu. On the way
// back it takes whatever was pasted - the whole chat, prose and all - reads the
// list out of it, and shows what would be created before anything is.
//
// The same sheet has a second mode with only one half. Opened from the outline
// title it carries the WHOLE list out as a review prompt - and stops there: no
// paste row, no parser, no preview, no Apply, because that answer is prose to
// read and not steps to import. The line where the paste row would be says so.
//
// What it deliberately does NOT do: it never talks to a model, it never
// installs anything, it knows no provider and holds no key - the person owns
// that half of the loop and always will. It never writes to the document
// either: the pasted lines become nodes through the ordinary mutate path, with
// origin "llm", and only on the press of Apply. Vorschlag, nie Ausfuehrung:
// what a model wrote is a proposal until somebody looked at it.

import { el, text, icon, clear } from "./dom.js";
import { openSheet, closeSheet } from "./sheet.js";
import { t, getLocale } from "../i18n.js";
import { buildPrompt, buildTreePrompt, parseAnswer } from "../aihelp.js";

/** How many of the lines the preview writes out before it counts the rest. */
export const PREVIEW_LINES = 8;

/**
 * The entry point, or nothing at all. A step that is kept away from any model
 * collects no model-made children either, so it has no way into this sheet -
 * the same rule the prompt builder enforces one layer down.
 *
 * Deliberately NOT gated by whether a relay is configured: the copy loop needs
 * no server, no key and no address. It is the one route to a model that works
 * on a plane, in a browser with the network off, and on a machine where this
 * app is the only thing installed.
 *
 * @param {Object} ctx the app context
 * @param {Object} node the node the prompt would be about
 * @returns {HTMLElement|null}
 */
export function aihelpEntry(ctx, node) {
  const keep = ctx.optout(node.id);
  if (keep.own || keep.inherited) return null;
  return el(
    "button",
    {
      class: "leaf-act is-wide",
      attrs: { type: "button" },
      dataset: { ai: "copy" },
      on: { click: () => ctx.aiHelp(node) },
    },
    [icon("copy", 15), text(t("aihelp.entry"))],
  );
}

/** The clipboard, where there is one. False means: copy it by hand. */
async function toClipboard(value) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // A refused permission is not a failure worth a red line; the text is on
    // screen in a field that can be selected, which is the older way to copy.
  }
  return false;
}

/** True where the platform has a share menu of its own. */
function canShare() {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

/**
 * The whole loop in one sheet: read what goes out, take it, bring the answer
 * back, look at it, keep it.
 *
 * @param {Element} layer the overlay host
 * @param {Object} ctx the app context
 * @param {Object} node the node the steps will hang under
 */
export function openAiHelp(layer, ctx, node) {
  // Nothing opens for a node that is kept away from models. The entry point
  // already refuses it; this is the same rule at the door of the sheet, so a
  // switch thrown from somewhere else cannot leave a way in standing.
  if (!buildPrompt(ctx.doc, node.id, getLocale())) return;
  const locale = getLocale();
  const body = el("div", { class: "assist" });
  const footer = el("div", { class: "sheet-foot" });
  /** What was pasted last, so going back and forth does not lose it. */
  let pasted = "";

  const reset = () => {
    clear(body);
    clear(footer);
  };

  const btn = (label, onClick, primary, extra) =>
    el(
      "button",
      {
        class: `btn${primary ? " is-primary" : ""}`,
        attrs: { type: "button" },
        dataset: extra || null,
        on: { click: onClick },
      },
      [text(label)],
    );

  // ------------------------------------------------------------ the way out

  function paintPrompt() {
    reset();
    const built = buildPrompt(ctx.doc, node.id, locale);
    if (!built) {
      // The switch was thrown while the sheet was open. Nothing to show.
      closeSheet();
      return;
    }
    const steps = built.context.children.length;

    body.appendChild(
      el("p", { class: "field-hint" }, [
        text(steps === 1 ? t("aihelp.scopeOne") : t("aihelp.scope", { n: steps })),
      ]),
    );

    // A readonly field rather than a block of prose: it can be selected with a
    // finger and copied the way anything else on a phone is copied, which is
    // the fallback for every browser that refuses the clipboard call below.
    const field = el("textarea", {
      class: "textarea is-prompt",
      attrs: { rows: "12", readonly: "readonly", spellcheck: "false", "aria-label": t("aihelp.title") },
      dataset: { ai: "prompt" },
    });
    field.value = built.text;
    body.appendChild(field);

    body.appendChild(
      el(
        "button",
        {
          class: "setrow",
          attrs: { type: "button" },
          dataset: { ai: "paste-open" },
          on: { click: () => paintPaste() },
        },
        [
          el("span", {}, [
            el("span", { class: "setrow-label" }, [text(t("aihelp.paste.entry"))]),
            el("span", { class: "setrow-desc" }, [text(t("aihelp.paste.desc"))]),
          ]),
          icon("chevronRight", 18),
        ],
      ),
    );

    const buttons = [];
    if (canShare()) {
      buttons.push(
        btn(
          t("aihelp.share"),
          () => {
            try {
              const shared = navigator.share({ text: built.text });
              if (shared && typeof shared.catch === "function") shared.catch(() => {});
            } catch {
              // A cancelled share menu is a decision, not an error.
            }
          },
          false,
          { ai: "share" },
        ),
      );
    }
    buttons.push(
      btn(
        t("aihelp.copy"),
        async () => {
          const ok = await toClipboard(built.text);
          if (!ok) {
            field.focus();
            field.select();
          }
          ctx.toast(ok ? t("aihelp.copied") : t("aihelp.copyByHand"));
        },
        true,
        { ai: "copy-do" },
      ),
    );
    for (const b of buttons) footer.appendChild(b);
  }

  // ------------------------------------------------------------- the way back

  function paintPaste() {
    reset();
    body.appendChild(el("p", { class: "field-hint" }, [text(t("aihelp.paste.hint"))]));
    const field = el("textarea", {
      class: "textarea is-prompt",
      attrs: { rows: "12", placeholder: t("aihelp.paste.placeholder"), spellcheck: "false" },
      dataset: { ai: "answer" },
    });
    field.value = pasted;
    field.addEventListener("input", () => {
      pasted = field.value;
      look.disabled = !field.value.trim();
    });
    body.appendChild(field);

    const look = btn(t("aihelp.paste.look"), () => paintPreview(parseAnswer(field.value).items), true, {
      ai: "look",
    });
    look.disabled = !field.value.trim();
    footer.appendChild(btn(t("common.back"), () => paintPrompt()));
    footer.appendChild(look);
    queueMicrotask(() => field.focus());
  }

  /**
   * What would be created, before it is. Nothing here is editable and nothing
   * here is checkable: this is the last look, and the two answers to it are
   * Apply and Cancel.
   */
  function paintPreview(items) {
    reset();
    if (!items.length) {
      body.appendChild(el("p", { class: "assist-error" }, [text(t("aihelp.preview.nothing"))]));
      footer.appendChild(btn(t("common.back"), () => paintPaste()));
      return;
    }

    body.appendChild(
      el("p", { class: "field-hint" }, [
        text(
          items.length === 1
            ? t("aihelp.preview.oneUnder", { title: node.title })
            : t("aihelp.preview.under", { n: items.length, title: node.title }),
        ),
      ]),
    );

    for (const item of items.slice(0, PREVIEW_LINES)) {
      body.appendChild(
        el(
          "div",
          {
            class: "assist-item is-level",
            dataset: { ai: "preview-item", level: String(item.level) },
            vars: { "--lvl": String(item.level) },
          },
          [
            el("div", { class: "assist-item-body" }, [
              el("span", { class: "assist-title is-static" }, [text(item.title)]),
            ]),
          ],
        ),
      );
    }
    if (items.length > PREVIEW_LINES) {
      body.appendChild(
        el("p", { class: "field-hint" }, [
          text(t("aihelp.preview.more", { n: items.length - PREVIEW_LINES })),
        ]),
      );
    }

    footer.appendChild(btn(t("common.cancel"), () => paintPaste(), false, { ai: "cancel" }));
    footer.appendChild(
      btn(
        t("aihelp.preview.apply"),
        () => {
          closeSheet();
          ctx.importTree(node.id, items);
          ctx.toast(t("aihelp.applied", { n: items.length }));
        },
        true,
        { ai: "apply" },
      ),
    );
  }

  paintPrompt();
  openSheet(layer, { title: t("aihelp.title"), body, footer, onClose: () => reset() });
}

// ------------------------------------------------------------- the whole list

/**
 * The same sheet in TREE MODE: the list of ten, once, as a prompt to carry out.
 *
 * Owner's question: "Click auf The Ten soll mir Think it through with an AI
 * Prompt für den gesamten Baum anbieten. Ist das zu viel?" No - but only as a
 * different thing. This is a review, a Bestandsaufnahme, and its answer is
 * prose to read.
 *
 * So there is NO way back in here, and that is the whole difference in the UI:
 * no paste row, no parser, no preview, no Apply. One prompt, copy or share, and
 * a line under it that says so plainly, because a person who has used the leaf
 * sheet will look for the paste row and should be told rather than left hunting.
 *
 * @param {Element} layer the overlay host
 * @param {Object} ctx the app context
 */
export function openAiHelpTree(layer, ctx) {
  const now = typeof ctx.now === "function" ? ctx.now() : Date.now();
  const built = buildTreePrompt(ctx.doc, getLocale(), { now });
  // No list, or a list every goal of which is kept away from models: nothing
  // opens. The same rule the leaf sheet applies at its own door.
  if (!built) return;

  const goals = built.context.goals.length;
  // The honest line has to count what actually travels, and what travels is now
  // the tree: the goals AND the steps listed under them. A list with nothing
  // under it yet says that instead of claiming zero steps.
  const parts = built.context.partCount;
  const scopeKey = parts
    ? goals === 1
      ? "aihelp.tree.scopeOne"
      : "aihelp.tree.scope"
    : goals === 1
      ? "aihelp.tree.scopeBareOne"
      : "aihelp.tree.scopeBare";
  const body = el("div", { class: "assist" });
  const footer = el("div", { class: "sheet-foot" });

  body.appendChild(el("p", { class: "field-hint" }, [text(t(scopeKey, { g: goals, n: parts }))]));

  const field = el("textarea", {
    class: "textarea is-prompt",
    attrs: { rows: "12", readonly: "readonly", spellcheck: "false", "aria-label": t("aihelp.tree.title") },
    dataset: { ai: "tree-prompt" },
  });
  field.value = built.text;
  body.appendChild(field);

  // The line the leaf sheet spends on its paste row. Here it says the opposite,
  // in the same place, so the absence reads as a decision and not as a gap.
  body.appendChild(
    el("p", { class: "field-hint", dataset: { ai: "tree-nopaste" } }, [text(t("aihelp.tree.noPaste"))]),
  );

  const btn = (label, onClick, primary, extra) =>
    el(
      "button",
      {
        class: `btn${primary ? " is-primary" : ""}`,
        attrs: { type: "button" },
        dataset: extra || null,
        on: { click: onClick },
      },
      [text(label)],
    );

  if (canShare()) {
    footer.appendChild(
      btn(
        t("aihelp.share"),
        () => {
          try {
            const shared = navigator.share({ text: built.text });
            if (shared && typeof shared.catch === "function") shared.catch(() => {});
          } catch {
            // A cancelled share menu is a decision, not an error.
          }
        },
        false,
        { ai: "tree-share" },
      ),
    );
  }
  footer.appendChild(
    btn(
      t("aihelp.copy"),
      async () => {
        const ok = await toClipboard(built.text);
        if (!ok) {
          field.focus();
          field.select();
        }
        ctx.toast(ok ? t("aihelp.copied") : t("aihelp.copyByHand"));
      },
      true,
      { ai: "tree-copy" },
    ),
  );

  openSheet(layer, {
    title: t("aihelp.tree.title"),
    body,
    footer,
    onClose: () => {
      clear(body);
      clear(footer);
    },
  });
}
