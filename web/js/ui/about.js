// ui/about.js - what this is, and what happens to what you write.
//
// What it does: a calm long-form reading screen - the method, the list of
// what the app adds over paper, why the story matters, privacy with its two
// honest limits, the claim. Reachable from settings and from the lock screen:
// somebody has to be able to read this before typing a secret into the app.
// On the very first entry into a vault it is shown once as an intro with a
// single "Begin" action; after that it never appears uninvited again.
//
// What it deliberately does NOT do: it touches no document content. This
// screen must render with the vault sealed, so it reads nothing but the i18n
// catalogue (the intro flag lives in doc.settings and is handled by app.js).

import { el, text, icon } from "./dom.js";
import { t } from "../i18n.js";

const METHOD_TOP = ["about.method.p1", "about.method.p2"];
const METHOD_LIS = ["about.method.li1", "about.method.li2", "about.method.li3", "about.method.li4"];
const METHOD_END = ["about.method.p4", "about.method.p5"];
const STORY = ["about.story.p1", "about.story.p2", "about.story.p3"];
const PRIVACY_LIS = ["about.privacy.li1", "about.privacy.li2"];

/**
 * A list item whose lead word (up to the first colon) is set in strong type.
 * Built strictly from text nodes - never from markup in catalogue values.
 */
function leadItem(key) {
  const s = t(key);
  const cut = s.indexOf(":");
  if (cut < 1 || cut > 40) return el("li", {}, [text(s)]);
  return el("li", {}, [
    el("strong", {}, [text(s.slice(0, cut + 1))]),
    text(s.slice(cut + 1)),
  ]);
}

export function render(ctx) {
  const intro = !!ctx.introAbout;
  const close = () => (intro ? ctx.finishIntro() : ctx.back());

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
            on: { click: close },
          },
          [icon("close", 20)],
        ),
      ]),
    ]),
  ]);

  const prose = el("div", { class: "scroll prose" }, [
    el("h2", {}, [text(t("about.method.heading"))]),
    ...METHOD_TOP.map((k) => el("p", {}, [text(t(k))])),
    el("p", { class: "prose-lead" }, [text(t("about.method.lead"))]),
    el("ul", { class: "prose-list" }, METHOD_LIS.map(leadItem)),
    ...METHOD_END.map((k) => el("p", {}, [text(t(k))])),

    el("h2", {}, [text(t("about.story.heading"))]),
    ...STORY.map((k) => el("p", {}, [text(t(k))])),

    el("h2", {}, [text(t("about.privacy.heading"))]),
    el("p", {}, [text(t("about.privacy.p1"))]),
    el("p", { class: "prose-lead" }, [text(t("about.privacy.lead"))]),
    el("ul", { class: "prose-list" }, PRIVACY_LIS.map(leadItem)),

    el("p", { class: "claim" }, [text(t("about.claim.p1"))]),
  ]);

  const children = [head, prose];
  if (intro) {
    children.push(
      el("div", { class: "bar", style: { gridAutoFlow: "row" } }, [
        el(
          "button",
          {
            class: "btn is-primary is-big is-wide",
            attrs: { type: "button" },
            on: { click: () => ctx.finishIntro() },
          },
          [text(t("about.begin"))],
        ),
      ]),
    );
  }
  return el("section", { class: "screen" }, children);
}
