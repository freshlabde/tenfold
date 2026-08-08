// ui/assist.js - where the model becomes visible, and where it stops.
//
// What it does: the action sheet with the operations that fit one node, the
// interview gate in front of the ones that need to understand first (same
// sheet rhythm as the story guide - one question, one field, one press), and
// the result as a proposal: every line has a checkbox, every title can be
// corrected in place, and only the press on "Take over" writes anything.
// Model text arrives the way it was written: it types itself in.
//
// What it deliberately does NOT do: it never writes to the document itself -
// every accepted item goes through the ordinary mutate path on the context,
// with origin "llm" on everything it creates. It shows no spinner, retries
// nothing on its own (one button, one press, one attempt), and puts model
// output on screen as text nodes only. A failure is one line and the app
// stays fully usable behind it.

import { el, text, icon, clear } from "./dom.js";
import { openSheet, closeSheet } from "./sheet.js";
import { t, getLocale } from "../i18n.js";
import { prefersReducedMotion } from "../motion.js";
import { buildContext, callForText, extractJson, llmMode, llmSettings } from "../llm.js";
import {
  interviewMessages,
  operationMessages,
  operationsFor,
  parseInterview,
} from "../prompts.js";
import { appendAnswer } from "./storyguide.js";
import { entitiesForNode } from "../entities.js";

/** Reading speed of the typewriter, in characters per second. */
const TYPE_CPS = 24;

/** Below this a wait is not a wait, and a line about it would be noise. */
export const WAIT_AFTER_MS = 400;

/**
 * Type text into an element. Same idea as the rest of the motion vocabulary:
 * with prefers-reduced-motion the end state is applied in one frame, without
 * an intermediate step. Always textContent - model output is user content.
 * @returns {() => void} cancel
 */
export function typeInto(node, value) {
  const full = String(value === null || value === undefined ? "" : value);
  if (!node) return () => {};
  if (prefersReducedMotion()) {
    node.textContent = full;
    return () => {};
  }
  node.textContent = "";
  let index = 0;
  let timer = 0;
  const step = () => {
    index += 1;
    node.textContent = full.slice(0, index);
    if (index < full.length) timer = setTimeout(step, 1000 / TYPE_CPS);
  };
  timer = setTimeout(step, 1000 / TYPE_CPS);
  return () => clearTimeout(timer);
}

/** The error code of anything that came back from llm.js or prompts.js. */
function codeOf(err) {
  return err && typeof err.code === "string" ? err.code : "server";
}

/**
 * The one quiet line that says a model is working, and which one. There is no
 * spinner anywhere in this app; every flow that waits uses this.
 */
export function thinkingLine(mode) {
  return el("p", { class: "assist-wait" }, [
    text(mode === "cloud" ? t("llm.thinking.cloud") : t("llm.thinking.local")),
  ]);
}

/** One calm line for whatever came back. Never a server text, never a stack. */
export function errorLine(err) {
  return el("p", { class: "assist-error" }, [text(t(`llm.error.${codeOf(err)}`))]);
}

/**
 * The one-time consent for cloud mode. Plain words about what leaves the
 * device, and nothing happens until the second button is pressed.
 */
export function openConsent(layer, ctx, onAccept) {
  const body = el("div", {}, [
    el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("llm.consent.body"))]),
    el("p", { class: "field-hint" }, [text(t("llm.consent.keeps"))]),
  ]);
  const footer = el("div", { class: "sheet-foot" }, [
    el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => closeSheet() } }, [
      text(t("llm.consent.decline")),
    ]),
    el(
      "button",
      {
        class: "btn is-primary",
        attrs: { type: "button" },
        on: {
          click: () => {
            closeSheet();
            onAccept();
          },
        },
      },
      [text(t("llm.consent.accept"))],
    ),
  ]);
  openSheet(layer, { title: t("llm.consent.title"), body, footer });
}

/**
 * The assist flow for one node. One sheet from the first press to the last:
 * pick an operation, answer what the model needs to know, look at what it
 * proposes, take over what is right.
 */
export function openAssist(layer, ctx, node) {
  const locale = getLocale();
  const release = { sensitive: false, notes: false };
  /** Every running typewriter, so leaving a screen stops all of them. */
  const typers = [];
  const type = (node, value) => typers.push(typeInto(node, value));
  let waitTimer = 0;

  const body = el("div", { class: "assist" });
  const footer = el("div", { class: "sheet-foot" });

  const settings = () => llmSettings(ctx.doc);
  const mode = () => llmMode(ctx.doc);
  const info = () => ({ childCount: ctx.childrenOf(node.id).length });
  const current = () => ctx.nodeById(node.id) || node;
  const contextNow = () =>
    buildContext(ctx.doc, node.id, {
      mode: mode(),
      releaseSensitive: release.sensitive,
      releaseNotes: release.notes,
    });

  const stopWaiting = () => {
    clearTimeout(waitTimer);
    waitTimer = 0;
  };

  const reset = () => {
    while (typers.length) typers.pop()();
    stopWaiting();
    clear(body);
    clear(footer);
  };

  // ------------------------------------------------------------- the menu

  function paintMenu() {
    reset();
    const target = current();
    const probe = contextNow();
    if (!probe) {
      closeSheet();
      return;
    }
    const ops = operationsFor(target, info());
    for (const op of ops) {
      body.appendChild(
        el(
          "button",
          {
            class: "setrow",
            attrs: { type: "button" },
            dataset: { llm: `op-${op.id}` },
            on: { click: () => run(op) },
          },
          [
            el("span", {}, [
              el("span", { class: "setrow-label" }, [text(t(op.labelKey))]),
              el("span", { class: "setrow-desc" }, [text(t(op.descKey))]),
            ]),
            icon("chevronRight", 18),
          ],
        ),
      );
    }

    // The two per-call releases. They only appear when there is something to
    // release, they are off every time the sheet opens, and they last exactly
    // as long as this sheet does.
    if (probe.omitted.sensitive) {
      body.appendChild(
        toggleRow("llm.release.sensitive", release.sensitive, (on) => {
          release.sensitive = on;
        }),
      );
    }
    if (mode() === "cloud" && probe.omitted.notes) {
      body.appendChild(
        toggleRow("llm.release.notes", release.notes, (on) => {
          release.notes = on;
        }),
      );
    }
    body.appendChild(
      el("p", { class: "field-hint" }, [
        text(mode() === "cloud" ? t("llm.scope.cloud") : t("llm.scope.local")),
      ]),
    );
  }

  function toggleRow(labelKey, active, onChange) {
    const input = el("input", { attrs: { type: "checkbox" } });
    input.checked = active;
    input.addEventListener("change", () => onChange(input.checked));
    return el("label", { class: "check", dataset: { llm: "release" } }, [
      input,
      el("span", { class: "check-box" }, [icon("check", 14)]),
      el("span", { class: "check-text" }, [text(t(labelKey))]),
    ]);
  }

  // ----------------------------------------------------------- the waiting

  function paintWorking() {
    reset();
    // No spinner anywhere in this app. After a moment of silence one line
    // says what is happening, and it says which model is thinking.
    waitTimer = setTimeout(() => {
      body.appendChild(thinkingLine(mode()));
    }, WAIT_AFTER_MS);
    footer.appendChild(
      el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => closeSheet() } }, [
        text(t("common.cancel")),
      ]),
    );
  }

  function paintError(op, err) {
    reset();
    body.appendChild(errorLine(err));
    footer.appendChild(
      el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => paintMenu() } }, [
        text(t("common.back")),
      ]),
    );
    footer.appendChild(
      el(
        "button",
        { class: "btn is-primary", attrs: { type: "button" }, on: { click: () => run(op) } },
        [text(t("llm.retry"))],
      ),
    );
  }

  // ---------------------------------------------------------- the interview

  /**
   * The questions, one at a time. Every answer is filed the moment it is
   * given - into the story as a labelled line, or onto one of the cards this
   * step is linked to, which is the same line in another place.
   */
  function askQuestions(questions, onDone) {
    let step = 0;
    let answered = 0;

    const paint = () => {
      reset();
      const spec = questions[step];
      const cards = entitiesForNode(ctx.entities, current());
      let targetCard = null;

      const input = el("textarea", {
        class: "textarea",
        attrs: { rows: "3", placeholder: t("guide.answerPlaceholder"), spellcheck: "false" },
      });

      body.appendChild(
        el("div", { class: "guide-step" }, [
          text(t("llm.interview.step", { n: step + 1, total: questions.length })),
        ]),
      );
      const question = el("p", { class: "guide-q" });
      type(question, spec.question);
      body.appendChild(question);
      body.appendChild(input);

      if (cards.length) {
        const chips = el("div", { class: "chips" });
        const buttons = [];
        const pick = (card, button) => {
          targetCard = card;
          for (const b of buttons) b.setAttribute("aria-pressed", b === button ? "true" : "false");
        };
        const storyChip = el(
          "button",
          { class: "chip", attrs: { type: "button", "aria-pressed": "true" } },
          [text(t("llm.interview.story"))],
        );
        storyChip.addEventListener("click", () => pick(null, storyChip));
        buttons.push(storyChip);
        chips.appendChild(storyChip);
        for (const card of cards) {
          const chip = el(
            "button",
            { class: "chip", attrs: { type: "button", "aria-pressed": "false" } },
            [text(card.name)],
          );
          chip.addEventListener("click", () => pick(card, chip));
          buttons.push(chip);
          chips.appendChild(chip);
        }
        body.appendChild(el("p", { class: "field-hint" }, [text(t("llm.interview.fileOn"))]));
        body.appendChild(chips);
      }

      const commit = (value) => {
        const answer = String(value || "").trim();
        if (answer) {
          const label = spec.label || t("llm.interview.label");
          if (targetCard) {
            ctx.updateEntity(targetCard.id, {
              notes: appendAnswer(targetCard.notes, label, answer),
            });
          } else {
            const node0 = current();
            ctx.updateNode(node0.id, { story: appendAnswer(node0.story, label, answer) });
          }
          answered += 1;
        }
        step += 1;
        if (step >= questions.length) onDone(answered);
        else paint();
      };

      footer.appendChild(
        el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => commit("") } }, [
          text(t("guide.skip")),
        ]),
      );
      footer.appendChild(
        el(
          "button",
          {
            class: "btn is-primary",
            attrs: { type: "button" },
            on: { click: () => commit(input.value) },
          },
          [icon("check", 17), text(step === questions.length - 1 ? t("guide.finish") : t("guide.next"))],
        ),
      );
      queueMicrotask(() => input.focus());
    };

    paint();
  }

  // ------------------------------------------------------------- proposals

  /** A list of proposed lines, each one acceptable on its own. */
  function paintItems(op, result) {
    reset();
    const rows = [];

    for (const item of result.items) {
      const box = el("input", { attrs: { type: "checkbox" } });
      box.checked = true;
      const state = { title: item.title, minutes: item.minutes || null, box };
      rows.push(state);

      const label = el("button", { class: "assist-title", attrs: { type: "button" } });
      type(label, item.title);
      // Correcting a proposed line is a tap, not a second screen. The button
      // becomes the field it was showing.
      label.addEventListener("click", () => {
        const field = el("input", { class: "input", attrs: { type: "text" } });
        field.value = state.title;
        label.replaceWith(field);
        field.focus();
        const done = () => {
          state.title = field.value.trim() || state.title;
          label.textContent = state.title;
          field.replaceWith(label);
        };
        field.addEventListener("blur", done);
        field.addEventListener("keydown", (ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter" || ev.key === "Escape") {
            ev.preventDefault();
            done();
          }
        });
      });

      const sub = [];
      if (item.kind) sub.push(t(`llm.kind.${item.kind}`));
      if (item.minutes) sub.push(t("leaf.minutes", { n: item.minutes }));
      if (item.why) sub.push(item.why);

      const itemEl = el("div", { class: "assist-item", dataset: { llm: "item" } }, [
        el("label", { class: "check is-bare" }, [
          box,
          el("span", { class: "check-box" }, [icon("check", 14)]),
        ]),
        el("div", { class: "assist-item-body" }, [
          label,
          sub.length ? el("span", { class: "assist-why" }, [text(sub.join(" · "))]) : null,
        ]),
      ]);
      // A rejected line steps back rather than being crossed out - it is a
      // proposal that was not taken, not a mistake.
      box.addEventListener("change", () => itemEl.classList.toggle("is-off", !box.checked));
      body.appendChild(itemEl);
    }

    const take = el("button", { class: "btn is-primary", attrs: { type: "button" } });
    const count = () => rows.filter((r) => r.box.checked).length;
    const relabel = () => {
      clear(take);
      take.appendChild(text(t("llm.proposal.take", { n: count() })));
      take.disabled = count() === 0;
    };
    for (const r of rows) r.box.addEventListener("change", relabel);
    relabel();
    take.addEventListener("click", () => {
      const chosen = rows.filter((r) => r.box.checked);
      if (!chosen.length) return;
      closeSheet();
      ctx.addChildren(
        node.id,
        chosen.map((r) => ({ title: r.title, effortMinutes: r.minutes })),
      );
      ctx.toast(t("llm.applied", { n: chosen.length }));
    });

    footer.appendChild(
      el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => paintMenu() } }, [
        text(t("common.back")),
      ]),
    );
    footer.appendChild(take);
  }

  /** One text against the one that is there now. */
  function paintReplace(op, result) {
    reset();
    const before = String(current()[result.field] || "").trim();
    body.appendChild(el("div", { class: "cell-key" }, [text(t("llm.proposal.before"))]));
    body.appendChild(
      el("p", { class: "assist-before" }, [text(before || t("llm.proposal.nothing"))]),
    );
    body.appendChild(el("div", { class: "cell-key", style: { paddingTop: "14px" } }, [
      text(t("llm.proposal.after")),
    ]));
    const after = el("p", { class: "assist-after", dataset: { llm: "after" } });
    type(after, result.value);
    body.appendChild(after);

    footer.appendChild(
      el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => paintMenu() } }, [
        text(t("common.back")),
      ]),
    );
    footer.appendChild(
      el(
        "button",
        {
          class: "btn is-primary",
          attrs: { type: "button" },
          on: {
            click: () => {
              closeSheet();
              ctx.updateNode(node.id, { [result.field]: result.value });
              ctx.toast(t("llm.appliedOne"));
            },
          },
        },
        [text(t("llm.proposal.takeOne"))],
      ),
    );
  }

  /** A new sequence for the parts of this goal, with one line of reason each. */
  function paintOrder(op, result) {
    reset();
    const kids = ctx.childrenOf(node.id);
    const ordered = result.order.map((entry) => ({ node: kids[entry.n - 1], reason: entry.reason }));
    if (ordered.some((entry) => !entry.node)) {
      paintError(op, { code: "malformed" });
      return;
    }
    ordered.forEach((entry, i) => {
      const reason = el("span", { class: "assist-why" });
      type(reason, entry.reason);
      body.appendChild(
        el("div", { class: "assist-item", dataset: { llm: "order" } }, [
          el("span", { class: "row-chip", attrs: { "aria-hidden": "true" }, text: String(i + 1) }),
          el("div", { class: "assist-item-body" }, [
            el("span", { class: "assist-title is-static" }, [text(entry.node.title)]),
            reason,
          ]),
        ]),
      );
    });

    footer.appendChild(
      el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => paintMenu() } }, [
        text(t("common.back")),
      ]),
    );
    footer.appendChild(
      el(
        "button",
        {
          class: "btn is-primary",
          attrs: { type: "button" },
          on: {
            click: () => {
              closeSheet();
              ctx.reorderChildren(node.id, ordered.map((entry) => entry.node.id));
              ctx.toast(t("llm.reordered"));
            },
          },
        },
        [text(t("llm.proposal.takeOrder"))],
      ),
    );
  }

  // ------------------------------------------------------------------- run

  async function ask(messages, maxTokens) {
    // callForText retries once at twice the budget when a reasoning model
    // thought its whole allowance away - local and cloud alike.
    return extractJson(await callForText(settings(), messages, { maxTokens }));
  }

  async function run(op) {
    paintWorking();
    try {
      const context = contextNow();
      if (!context) {
        closeSheet();
        return;
      }
      // The gate: does the model have enough to work with, and if not, what
      // does it need. The answers go into the document, then the operation
      // runs again on the enriched context.
      if (op.interview) {
        const gate = parseInterview(await ask(interviewMessages(op, context, locale), 500));
        if (!gate.ready) {
          askQuestions(gate.questions, () => runOperation(op));
          return;
        }
      }
      await runOperation(op);
    } catch (err) {
      paintError(op, err);
    }
  }

  async function runOperation(op) {
    paintWorking();
    try {
      const context = contextNow();
      if (!context) {
        closeSheet();
        return;
      }
      const result = op.parse(await ask(operationMessages(op, context, locale), op.maxTokens), info());
      if (op.kind === "items") paintItems(op, result);
      else if (op.kind === "replace") paintReplace(op, result);
      else if (op.kind === "order") paintOrder(op, result);
      else askQuestions(result.questions, () => closeSheet());
    } catch (err) {
      paintError(op, err);
    }
  }

  paintMenu();
  openSheet(layer, { title: t("llm.assist"), body, footer, onClose: () => reset() });
}
