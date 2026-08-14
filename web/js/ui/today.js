// ui/today.js - the short list, and one question.
//
// What it does: shows what model.todayList picked out of the tree - at most
// seven open steps, each with the chain it belongs to - and above them the
// question of the day. Rows are the ordinary rows, so swiping one to the right
// finishes it here exactly as it does in the outline.
//
// What it deliberately does NOT do: it does not sort, filter or invent an
// order of its own - the rule lives in model.js and nowhere else. It never
// adds, indents or deletes; this screen is for doing, not for editing. The
// question is asked once a day and can be put away with one press.

import { el, text, icon, brandMark } from "./dom.js";
import { nodeRow } from "./rows.js";
import { todayList } from "../model.js";
import { dailyQuestion } from "../questions.js";
import { appendAnswer } from "./storyguide.js";
import { pathLine } from "./format.js";
import { t } from "../i18n.js";

/**
 * The chain a step hangs in, as one quiet line: "Health > Knee". Whole, never
 * shortened - a step four levels down is only recognisable by its path.
 */
function pathOf(ctx, node) {
  return pathLine(ctx.ancestors(node.id));
}

/**
 * The card. Node title, the question, one field, and two ways out: answer it,
 * or put it away until tomorrow.
 */
function questionCard(ctx, daily) {
  const input = el("textarea", {
    class: "textarea",
    attrs: { rows: "3", placeholder: t("question.placeholder"), spellcheck: "false" },
  });

  const save = () => {
    const answer = input.value.trim();
    if (!answer) {
      input.focus();
      return;
    }
    const current = ctx.nodeById(daily.node.id);
    if (!current) return;
    ctx.updateNode(current.id, {
      story: appendAnswer(current.story, t(daily.label), answer),
    });
    // Asked and answered - the card steps aside for the rest of the day.
    ctx.setSettings({ dailyDismissed: daily.day });
    ctx.toast(t("question.saved"));
  };

  // The path under the name, whole. The card names one node out of the entire
  // tree, and a step called "M&V" three levels down says nothing on its own -
  // the owner could not tell what the question was even about. A root goal has
  // no path and gets no line.
  const path = pathOf(ctx, daily.node);

  return el("section", { class: "qcard" }, [
    el("div", { class: "qcard-key" }, [text(t("question.heading"))]),
    el(
      "button",
      {
        class: "qcard-node",
        attrs: { type: "button" },
        on: { click: () => ctx.openNode(daily.node) },
      },
      [text(daily.node.title || t("editor.newTitle"))],
    ),
    path ? el("p", { class: "qcard-path" }, [text(path)]) : null,
    el("p", { class: "qcard-q" }, [text(t(daily.key))]),
    input,
    el("div", { class: "qcard-foot" }, [
      el(
        "button",
        {
          class: "btn-ghost",
          attrs: { type: "button" },
          on: { click: () => ctx.setSettings({ dailyDismissed: daily.day }) },
        },
        [text(t("question.dismiss"))],
      ),
      el("button", { class: "btn is-primary", attrs: { type: "button" }, on: { click: save } }, [
        icon("check", 16),
        text(t("common.save")),
      ]),
    ]),
  ]);
}

/**
 * Nothing is dated for today.
 *
 * Two shapes, because this screen has two ways of being empty and they do not
 * read the same. On its own it is a full empty state: the mark, the fact, and
 * the hint that explains which of the two reasons it is - everything with a
 * date is done, or nothing is broken down far enough yet.
 *
 * Under the day's question the hint has to go. It says nothing is broken down
 * far enough to start, which is precisely what the card above it has just
 * asked about - so the screen would pose a question and then answer it in
 * smaller type, and the mark would put a second piece of furniture between the
 * two. What is left is the one line that is still news: nothing is dated.
 *
 * This pairing used to be rare. Since the app opens where the work is, it is
 * the ordinary first screen of the day for anybody whose goals carry no dates,
 * which is what made it worth separating.
 *
 * @param {boolean} withQuestion is the question card above this one
 */
function emptyState(withQuestion) {
  if (withQuestion) {
    return el("div", { class: "empty is-quiet" }, [
      el("p", { class: "empty-line" }, [text(t("today.empty.line"))]),
    ]);
  }
  return el("div", { class: "empty" }, [
    el("div", { class: "empty-mark" }, [icon("mark", 30)]),
    el("p", { class: "empty-line" }, [text(t("today.empty.line"))]),
    el("p", { class: "empty-hint" }, [text(t("today.empty.hint"))]),
  ]);
}

export function render(ctx) {
  const now = ctx.now();
  const settings = ctx.doc.settings || {};
  const items = todayList(ctx.doc.nodes, { now });
  const daily = dailyQuestion(ctx.doc.nodes, { now, dismissed: settings.dailyDismissed });

  const head = el("div", { class: "head" }, [
    el("div", { class: "head-row" }, [
      el("div", {}, [
        brandMark(),
        el("h1", { class: "h-title" }, [text(t("today.title"))]),
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
    el("p", { class: "h-sub" }, [
      text(items.length ? t("today.sub", { n: items.length }) : t("today.subEmpty")),
    ]),
  ]);

  const list = el("ul", { class: "list" });
  items.forEach((node, i) => {
    list.appendChild(
      nodeRow(ctx, node, {
        rank: i,
        total: items.length,
        parentId: node.parentId,
        path: pathOf(ctx, node),
      }),
    );
  });

  const body = el("div", { class: "scroll" }, [
    daily ? questionCard(ctx, daily) : null,
    items.length ? list : emptyState(Boolean(daily)),
  ]);

  return el("section", { class: "screen" }, [head, body]);
}
