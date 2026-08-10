// ui/shareimport.js - what happens to something that was shared into tenfold.
//
// What it does: after an unlock, if the service worker parked a shared item,
// this sheet shows the text that arrived and asks the only question that
// matters - where does it belong. One press files it as an ordinary node under
// the chosen goal (or in the ten), one press discards it. Either way the
// parking space is emptied afterwards.
//
// What it deliberately does NOT do: it never imports silently, it never keeps
// the item around "for later", it builds every piece of the shared text as a
// text node (ground rule 2 - shared text is foreign text), and it adds no
// setting: this surface appears when something was shared and never otherwise.

import { el, text, icon } from "./dom.js";
import { openSheet, closeSheet } from "./sheet.js";
import { clearShare, shareToNode } from "../shareinbox.js";
import { t } from "../i18n.js";

/**
 * @param {Element} layer the overlay host
 * @param {Object} ctx the app context
 * @param {{title: string, text: string, url: string, ts: number}} item
 */
export function openShareImport(layer, ctx, item) {
  const draft = shareToNode(item);
  const roots = ctx.childrenOf(null);
  const full = roots.length >= ctx.maxRoots;

  const file = (parentId, label) => {
    closeSheet();
    ctx.addSharedNode(parentId, draft);
    clearShare();
    ctx.toast(label ? t("share.added", { title: label }) : t("share.addedTop"));
    if (parentId !== null) ctx.go("focus", parentId);
  };

  const dismiss = () => {
    closeSheet();
    clearShare();
  };

  const targetRow = (label, onClick, disabled) =>
    el(
      "button",
      {
        class: "setrow",
        attrs: { type: "button", "aria-disabled": disabled ? "true" : "false" },
        on: {
          click: () => {
            if (disabled) {
              ctx.toast(t("outline.full"));
              return;
            }
            onClick();
          },
        },
      },
      [el("span", { class: "setrow-label" }, [text(label)]), icon("chevronRight", 18)],
    );

  const body = el("div", {}, [
    // What arrived, verbatim and unstyled: the person has to be able to see
    // exactly what they are about to file before they file it.
    el("p", { class: "check-text" }, [text(draft.title)]),
    draft.note ? el("p", { class: "field-hint" }, [text(draft.note)]) : null,
    el("p", { class: "field-hint" }, [text(t("share.body"))]),
    el("p", { class: "field-label" }, [text(t("share.addUnder"))]),
    targetRow(t("share.addTop"), () => file(null, ""), full),
    ...roots.map((root) =>
      targetRow(root.title || t("editor.newTitle"), () => file(root.id, root.title), false),
    ),
  ]);

  const footer = el("div", { class: "sheet-foot" }, [
    el("button", { class: "btn-ghost", attrs: { type: "button" }, on: { click: dismiss } }, [
      text(t("share.dismiss")),
    ]),
  ]);

  // Closing with the X is neither an import nor a decision: the item stays
  // parked and is offered again at the next unlock. Only filing it or
  // discarding it empties the bucket, because only those two say what should
  // happen to the text.
  return openSheet(layer, { title: t("share.title"), body, footer });
}
