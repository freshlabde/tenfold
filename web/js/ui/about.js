// ui/about.js - what this is, and what happens to what you write.
//
// What it does: a calm long-form reading screen - the opening, a worked
// walkthrough of one goal, why the list is exactly ten, where the method comes
// from, how paper and app divide the work, what tenfold is not, privacy with
// its three honest limits, the claim. Reachable from settings and from the
// lock screen: somebody has to be able to read this before typing a secret
// into the app. On the very first entry into a vault it is shown once as an
// intro with a single "Begin" action; after that it never appears uninvited
// again.
//
// What it deliberately does NOT do: it touches no document content. This
// screen must render with the vault sealed, so it reads nothing but the i18n
// catalogue (the intro flag lives in doc.settings and is handled by app.js).

import { el, text, icon } from "./dom.js";
import { t } from "../i18n.js";

const INTRO = ["about.intro.p1", "about.intro.p2", "about.intro.p3"];
const WALK_TOP = ["about.walk.p1", "about.walk.p2"];
const WALK_LIS = ["about.walk.li1", "about.walk.li2", "about.walk.li3", "about.walk.li4"];
const TEN = ["about.ten.p1", "about.ten.p2", "about.ten.p3", "about.ten.p4", "about.ten.p5"];
const ORIGIN = ["about.origin.p1", "about.origin.p2", "about.origin.p3", "about.origin.p4"];
const PAPER_LIS = ["about.paper.li1", "about.paper.li2", "about.paper.li3", "about.paper.li4"];
const PRIVACY_LIS = ["about.privacy.li1", "about.privacy.li2", "about.privacy.li3"];

/** The lead of a line: everything up to and including the first colon or
 * question mark, if that happens early enough to read as a label. */
function leadCut(s) {
  const marks = [s.indexOf(":"), s.indexOf("?")].filter((i) => i >= 1);
  if (!marks.length) return -1;
  const cut = Math.min(...marks);
  return cut > 60 ? -1 : cut;
}

/**
 * An element whose lead (up to the first colon or question mark) is set in
 * strong type. Built strictly from text nodes - never from markup in
 * catalogue values.
 */
function leadItem(key, tag = "li", opts = {}) {
  const s = t(key);
  const cut = leadCut(s);
  if (cut < 0) return el(tag, opts, [text(s)]);
  return el(tag, opts, [
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
    ...INTRO.map((k) => el("p", {}, [text(t(k))])),

    el("h2", {}, [text(t("about.walk.heading"))]),
    ...WALK_TOP.map((k) => el("p", {}, [text(t(k))])),
    el("p", { class: "prose-lead" }, [text(t("about.walk.lead"))]),
    el("ul", { class: "prose-list" }, WALK_LIS.map((k) => leadItem(k))),
    leadItem("about.walk.step", "p", { class: "prose-lead" }),
    el("p", {}, [text(t("about.walk.p3"))]),

    el("h2", {}, [text(t("about.ten.heading"))]),
    ...TEN.map((k) => el("p", {}, [text(t(k))])),

    el("h2", {}, [text(t("about.origin.heading"))]),
    ...ORIGIN.map((k) => el("p", {}, [text(t(k))])),

    el("h2", {}, [text(t("about.paper.heading"))]),
    el("p", {}, [text(t("about.paper.p1"))]),
    el("p", { class: "prose-lead" }, [text(t("about.paper.lead"))]),
    el("ul", { class: "prose-list" }, PAPER_LIS.map((k) => leadItem(k))),

    el("h2", {}, [text(t("about.not.heading"))]),
    el("p", {}, [text(t("about.not.p1"))]),

    el("h2", {}, [text(t("about.privacy.heading"))]),
    el("p", {}, [text(t("about.privacy.p1"))]),
    el("p", {}, [text(t("about.privacy.p2"))]),
    el("p", { class: "prose-lead" }, [text(t("about.privacy.lead"))]),
    el("ul", { class: "prose-list" }, PRIVACY_LIS.map((k) => leadItem(k))),

    el("p", {}, [text(t("about.close.p1"))]),
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
