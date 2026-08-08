// ui/about.js - what this is, and what happens to what you write.
//
// What it does: four sections of plain prose - the method, why the story
// matters, privacy in one paragraph, the claim. Reachable from settings and,
// importantly, from the lock screen: somebody has to be able to read this
// before typing a secret into the app.
//
// What it deliberately does NOT do: it touches no document. This screen must
// render with the vault sealed, so it reads nothing but the i18n catalogue.

import { el, text, icon } from "./dom.js";
import { t } from "../i18n.js";

const METHOD = ["about.method.p1", "about.method.p2", "about.method.p3", "about.method.p4", "about.method.p5"];
const STORY = ["about.story.p1", "about.story.p2"];

export function render(ctx) {
  const head = el("div", { class: "head" }, [
    el("div", { class: "head-row" }, [
      el("div", {}, [
        el("div", { class: "eyebrow" }, [text(t("app.name"))]),
        el("h1", { class: "h-title" }, [text(t("about.title"))]),
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

  const prose = el("div", { class: "scroll prose" }, [
    el("h2", {}, [text(t("about.method.heading"))]),
    ...METHOD.map((k) => el("p", {}, [text(t(k))])),

    el("h2", {}, [text(t("about.story.heading"))]),
    ...STORY.map((k) => el("p", {}, [text(t(k))])),

    el("h2", {}, [text(t("about.privacy.heading"))]),
    el("p", {}, [text(t("about.privacy.p1"))]),

    el("p", { class: "claim" }, [text(t("about.claim.p1"))]),
  ]);

  return el("section", { class: "screen" }, [head, prose]);
}
