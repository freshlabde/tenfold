// ui/search.js - find a line anywhere in the tree.
//
// What it does: types straight into search.js and paints the hits with their
// ancestor path, so a result is readable without opening it. Tapping a result
// jumps to that node in the normal navigation, not into a special result view.
//
// What it deliberately does NOT do: it does not re-render the whole screen per
// keystroke (that would take the keyboard focus with it) - only the result
// list is rebuilt. Nothing is ever written to disk: the index is the in-memory
// node list, scanned on each call.

import { el, text, icon, clear } from "./dom.js";
import { search } from "../search.js";
import { t } from "../i18n.js";
import { metricFor } from "./format.js";

let query = "";

export function reset() {
  query = "";
}

export function render(ctx) {
  const input = el("input", {
    attrs: {
      type: "search",
      placeholder: t("search.placeholder"),
      "aria-label": t("search.placeholder"),
      autocomplete: "off",
      autocapitalize: "none",
      spellcheck: "false",
      enterkeyhint: "search",
    },
  });
  input.value = query;

  const results = el("div", { class: "scroll" });
  const count = el("p", { class: "h-sub", style: { padding: "10px var(--gutter) 0" } });

  const paint = () => {
    clear(results);
    clear(count);
    const q = query.trim();
    if (!q) {
      count.appendChild(text(t("search.hint")));
      return;
    }
    const hits = search(ctx.doc.nodes, q, { limit: 40 });
    count.appendChild(text(hits.length ? t("search.count", { n: hits.length }) : t("search.none")));
    const list = el("ul", { class: "list" });
    hits.forEach((hit, i) => {
      const row = el("div", {
        class: "row",
        attrs: { role: "button", tabindex: "0", "aria-label": t("a11y.openNode", { title: hit.node.title }) },
      });
      row.appendChild(el("span", { class: "row-chip", attrs: { "aria-hidden": "true" }, text: "·" }));
      const body = el("div", { class: "row-body" }, [
        el("div", { class: "row-title" }, [text(hit.node.title)]),
      ]);
      if (hit.path) body.appendChild(el("div", { class: "result-path" }, [text(hit.path)]));
      row.appendChild(body);
      row.appendChild(el("span", { class: "m" }, [text(metricFor(ctx.doc.nodes, hit.node))]));
      const open = () => {
        reset();
        ctx.openNode(hit.node, row);
      };
      row.addEventListener("click", open);
      row.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          open();
        }
      });
      list.appendChild(el("li", { class: "row-shell", vars: { "--rank": String(Math.min(i, 6)) } }, [row]));
    });
    results.appendChild(list);
  };

  input.addEventListener("input", () => {
    query = input.value;
    paint();
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      reset();
      ctx.back();
    }
  });

  const bar = el("div", { class: "searchbar" }, [
    icon("search", 18),
    input,
    el(
      "button",
      {
        class: "iconbtn",
        attrs: { type: "button", "aria-label": t("common.close") },
        on: {
          click: () => {
            reset();
            ctx.back();
          },
        },
      },
      [icon("close", 18)],
    ),
  ]);

  queueMicrotask(() => {
    input.focus();
    paint();
  });

  return el("section", { class: "screen" }, [
    el("div", { style: { flex: "none", paddingTop: "6px" } }, [bar]),
    count,
    results,
  ]);
}
