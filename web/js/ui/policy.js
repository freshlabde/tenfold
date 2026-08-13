// ui/policy.js - the links out of this app that have to exist.
//
// What it does: the two closing lines of the About screen, pointing at
// web/privacy.html, the public policy page, and at web/method.html, the long
// form of the method the app is built on. They are here rather than inline in
// about.js because the href is not the same string in both places the app
// runs, and that difference is a rule worth having one file for.
//
//   - In a browser it is the same-origin path. Whatever host the app is served
//     from serves its own policy, which is the honest answer for anybody
//     running their own instance.
//   - Inside the native shell it is the absolute address of the public
//     deployment, because a same-origin target="_blank" is INERT there: the
//     navigation policy in tenfold-ios (WebViewCoordinator.decidePolicyFor)
//     allows an app-origin URL, and the UI delegate then refuses to make a
//     second web view for it, so the tap does nothing at all. An http(s) link
//     is the one shape that opening code hands to the system browser.
//
// What it deliberately does NOT do: it is NOT the tip jar. That line is absent
// inside the shell, because an external payment link is an App Store
// rejection; this one is present everywhere, including the first-run intro,
// because a plain informational link to a privacy policy is not only allowed
// but required, and the intro is exactly the moment somebody is deciding
// whether to trust this app with their goals. No fetch, no vault read, no
// state: it renders with everything sealed.

import { el, text } from "./dom.js";
import { t } from "../i18n.js";
import { inShell } from "../shell.js";

/** The policy beside the app that is running, wherever that app is served. */
export const POLICY_PATH = "./privacy.html";

/**
 * The public deployment, for the shell. The same origin its API proxy already
 * speaks to, written out here once and pinned by tests/privacy.spec.js.
 */
export const POLICY_URL = "https://tenfold.kairatools.com/privacy.html";

/** The method page, under the same two-hrefs rule as the policy. */
export const METHOD_PATH = "./method.html";
export const METHOD_URL = "https://tenfold.kairatools.com/method.html";

/**
 * Where the link points from here.
 * @returns {string}
 */
export function policyHref() {
  return inShell() ? POLICY_URL : POLICY_PATH;
}

/**
 * The same, for the method page.
 * @returns {string}
 */
export function methodHref() {
  return inShell() ? METHOD_URL : METHOD_PATH;
}

/**
 * A link to a public document, as a real anchor rather than a button: the
 * destination is visible before it is tapped, it needs no script, and
 * `noopener` denies the opened page a handle on a window that may be holding a
 * decrypted vault. Every placement goes through here, so there is one statement
 * of how these two documents are opened.
 */
function docAnchor(cls, href, children) {
  return el(
    "a",
    {
      class: cls,
      attrs: {
        href,
        target: "_blank",
        rel: "noopener noreferrer",
        referrerpolicy: "no-referrer",
      },
    },
    children,
  );
}

/**
 * The method page as an anchor, in whatever shape the surface asking for it
 * needs. Three screens link it - About, the lock screen and the settings - and
 * this is the one place that knows where it goes and how it is opened. The
 * caller supplies the class, so each surface can wear its own register while
 * none of them can drift on the href.
 * @param {string} cls
 * @param {Array} children
 * @returns {HTMLElement}
 */
export function methodAnchor(cls, children) {
  return docAnchor(cls, methodHref(), children);
}

/**
 * The label, from the one catalogue key every placement shares. Four surfaces
 * naming the same document differently would read as four different things.
 * @returns {string}
 */
export function methodLabel() {
  return t("about.method");
}

/**
 * The quiet footer form, for the lock screen: the same register as the About
 * button standing next to it, and reachable before anything is unlocked.
 * @returns {HTMLElement}
 */
export function methodFootLink() {
  return methodAnchor("btn-ghost is-link", [text(methodLabel())]);
}

/**
 * The closing link line of the About screen. Its own class, next to the method
 * line's own class: the specs count `a.policy-line` and `a.method-line`
 * separately, so neither can be quietly turned into the other.
 * @returns {HTMLElement}
 */
export function policyAboutLine() {
  return docAnchor("policy-line", policyHref(), [text(t("about.policy"))]);
}

/**
 * The line beneath it: the method in full, on the public page. It follows the
 * policy line's rules exactly, not the tip jar's - present in every mode and
 * during the first-run intro too, because somebody deciding whether to trust
 * this app is entitled to read what it is asking them to do.
 * @returns {HTMLElement}
 */
export function methodAboutLine() {
  return methodAnchor("method-line", [text(methodLabel())]);
}
