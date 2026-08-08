// ui/storyguide.js - the interview without an interviewer.
//
// What it does: asks the four fixed questions of the contract, one at a time,
// in a sheet that shows nothing but the question and a place to answer. Each
// answer is appended to the node's story as a labelled line the moment it is
// given, so closing the sheet halfway never loses what was already said. The
// last answer also fills "finished when" - but only when that field is still
// empty, because an existing definition of done is the user's, not ours.
//
// What it deliberately does NOT do: no LLM, no network, no scoring, no
// follow-up questions derived from the answers, and no pressure - every step
// can be skipped and the sheet can be closed at any point. There is no
// "incomplete" state anywhere in the document.

import { el, text, icon, clear } from "./dom.js";
import { openSheet, closeSheet } from "./sheet.js";
import { t } from "../i18n.js";

/** The four questions, in the order the contract fixes them. */
export const STEPS = [
  { key: "why", question: "guide.q.why", label: "guide.label.why" },
  { key: "tried", question: "guide.q.tried", label: "guide.label.tried" },
  { key: "blocks", question: "guide.q.blocks", label: "guide.label.blocks" },
  { key: "done", question: "guide.q.done", label: "guide.label.done" },
];

/** Append one labelled line to a story, keeping a blank line between blocks. */
export function appendAnswer(story, label, answer) {
  const line = `${label}: ${answer.trim()}`;
  const current = String(story || "").trim();
  return current ? `${current}\n\n${line}` : line;
}

/**
 * Open the guide for one node.
 * @param {Element} layer the overlay host
 * @param {Object} ctx app context
 * @param {Object} node
 */
export function openStoryGuide(layer, ctx, node) {
  let step = 0;
  let answered = 0;

  const body = el("div", { class: "guide" });
  const footer = el("div", { class: "sheet-foot" });

  const finish = () => {
    closeSheet();
    if (answered) ctx.toast(t("guide.saved"));
  };

  const commit = (value) => {
    const answer = value.trim();
    if (answer) {
      const current = ctx.nodeById(node.id);
      if (!current) {
        closeSheet();
        return;
      }
      const patch = { story: appendAnswer(current.story, t(STEPS[step].label), answer) };
      // The closing question is the definition of done - but it only fills the
      // field when nothing is in it yet.
      if (STEPS[step].key === "done" && !String(current.doneWhen || "").trim()) {
        patch.doneWhen = answer;
      }
      ctx.updateNode(node.id, patch);
      answered += 1;
    }
    step += 1;
    if (step >= STEPS.length) finish();
    else paint();
  };

  function paint() {
    const spec = STEPS[step];
    const input = el("textarea", {
      class: "textarea",
      attrs: { rows: "4", placeholder: t("guide.answerPlaceholder"), spellcheck: "false" },
    });

    clear(body);
    body.appendChild(el("div", { class: "guide-step" }, [text(t("guide.step", { n: step + 1, total: STEPS.length }))]));
    body.appendChild(el("p", { class: "guide-q" }, [text(t(spec.question))]));
    body.appendChild(input);

    clear(footer);
    footer.appendChild(
      el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => commit("") } }, [
        text(t("guide.skip")),
      ]),
    );
    footer.appendChild(
      el(
        "button",
        { class: "btn is-primary", attrs: { type: "button" }, on: { click: () => commit(input.value) } },
        [icon("check", 17), text(step === STEPS.length - 1 ? t("guide.finish") : t("guide.next"))],
      ),
    );
    queueMicrotask(() => input.focus());
  }

  paint();
  openSheet(layer, { title: t("guide.title"), body, footer });
}
