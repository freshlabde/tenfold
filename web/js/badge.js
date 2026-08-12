// badge.js - the number on the installed app's icon.
//
// What it does: asks model.js how many open leaves are overdue or due today -
// the two groups the Today screen ranks first - and hands that number to the
// Badging API. Nothing else. A badge is the one surface of this app that is
// visible while the vault is locked, so it carries a COUNT and never a word:
// no title, no goal, no date, nothing that could be read over a shoulder.
//
// What it deliberately does NOT do: it owns no rule of its own. The definition
// of "calls for today" lives in model.js and is shared with the Today list, so
// the icon can never claim something the screen denies. It touches no network,
// no storage and no DOM, it never throws into a caller (a browser without the
// API, or one that refuses because the app is not installed, is a no-op), and
// it does NOT clear itself when the app locks - see the contract.
//
// THREE SURFACES, ONE COUNT
// -------------------------
// The number goes to the Badging API in a browser, to the native shell where
// that API is missing, and - through the shell - to the home-screen widget.
// All three are fed from the same `badgeCount()` call in the same tick, so the
// icon, the widget and the Today screen can never disagree with each other.
//
// The widget gets one thing more than the badge: whether today's question is
// still waiting. That is a BOOLEAN, and it stays one. The widget shows numbers
// and a fixed line; it never shows a goal, a title or a question - see the
// contract, and tenfold-ios/docs/BRIDGE.md, which says it from the other side.

import { dueNowCount } from "./model.js";
import { dailyQuestion } from "./questions.js";
import { CAP_BADGE, CAP_WIDGET, shellWith, shellPost } from "./shell.js";

/** Whether this browser has the Badging API at all. Desktop tabs mostly do
 *  not, and an uninstalled PWA is refused even where the method exists. */
export function supported() {
  if (typeof navigator !== "undefined" && typeof navigator.setAppBadge === "function") return true;
  return shellWith(CAP_BADGE) !== null;
}

/**
 * Is today's question still waiting to be answered?
 *
 * Derived, not stored. `questions.dailyQuestion` already answers exactly this
 * for the Today screen: it returns null when the list is empty or when the
 * question was put away for today (`settings.dailyDismissed`), and an object
 * otherwise. Asking it here rather than keeping a second flag is the same
 * discipline the count follows - one rule, several readers - so the widget can
 * never say the question is waiting while the screen shows it answered.
 *
 * What comes back is a boolean. The question itself, and the goal it is asked
 * about, stay inside the vault.
 *
 * @param {Object|null} doc
 * @param {{now?: number}} [opts]
 * @returns {boolean}
 */
export function questionWaits(doc, opts = {}) {
  if (!doc || !Array.isArray(doc.nodes)) return false;
  const dismissed = doc.settings && typeof doc.settings.dailyDismissed === "string"
    ? doc.settings.dailyDismissed
    : undefined;
  return dailyQuestion(doc.nodes, { ...opts, dismissed }) !== null;
}

/**
 * What the badge would show for this document right now.
 * @param {Object|null} doc the open, decrypted document
 * @param {{now?: number}} [opts] injectable clock, as everywhere in model.js
 * @returns {number} 0 when there is nothing to show
 */
export function badgeCount(doc, opts = {}) {
  if (!doc || !Array.isArray(doc.nodes)) return 0;
  return dueNowCount(doc.nodes, opts);
}

/**
 * Put the current count on the icon. Zero takes the badge away again - a dot
 * left over from yesterday is a small lie, and this is the one place the app
 * speaks without being opened.
 *
 * Every call is guarded twice: the method may not exist, and where it does it
 * may still reject (not installed, permission policy). Neither is an error
 * worth reporting - the badge is an accessory.
 *
 * @param {Object|null} doc
 * @param {{now?: number}} [opts]
 * @returns {number} the count that was applied (0 when cleared or unsupported)
 */
export function setBadge(doc, opts = {}) {
  const count = badgeCount(doc, opts);
  // Fed first, and fed whether or not an icon badge is possible: the widget is
  // a separate surface that happens to share this moment, not a consequence of
  // the badge. A shell that offered only one of the two would still be served.
  sendWidgetState(doc, count, opts);
  if (!supported()) return 0;
  try {
    if (count > 0) {
      // The Badging API where it exists; the shell where it does not. WKWebView
      // has no navigator.setAppBadge at all, so on iOS the number reaches the
      // icon through UIApplication on the native side instead - the same count,
      // one hop further.
      if (typeof navigator !== "undefined" && typeof navigator.setAppBadge === "function") {
        const result = navigator.setAppBadge(count);
        if (result && typeof result.catch === "function") result.catch(() => {});
      } else {
        shellPost({ type: "badge.set", count });
      }
    } else {
      clearBadge();
    }
  } catch {
    // A synchronous throw from a platform that only pretends to support this.
  }
  return count;
}

/**
 * Tell the shell what the home-screen widget should show: how many steps are
 * due now, and whether today's question is still waiting.
 *
 * Two numbers and a boolean. Nothing else may ever be added to this message
 * without the contract changing first - the widget is rendered by a process
 * outside the vault's trust boundary and drawn on a home screen anybody can
 * see over a shoulder.
 *
 * Fire and forget. A widget that missed one update is a widget that is one
 * count stale until the next mutation; a caller that had to await it would be
 * a save path blocked on a home screen.
 *
 * @param {Object|null} doc
 * @param {number} due
 * @param {{now?: number}} [opts]
 */
function sendWidgetState(doc, due, opts = {}) {
  if (!shellWith(CAP_WIDGET)) return;
  shellPost({ type: "widget.state", due, questionWaits: questionWaits(doc, opts) });
}

/**
 * Take the badge away. Used when the vault is wiped - and NOT when it locks:
 * a count is content-free, and a badge that survives the lock is the whole
 * point of having one.
 */
export function clearBadge() {
  if (typeof navigator === "undefined") return;
  try {
    // Zero, not a separate verb: the shell has one message for the number on
    // the icon and zero means "take it away", so there is no second code path
    // that could be reached in one direction and not the other.
    if (typeof navigator.setAppBadge !== "function" && shellWith(CAP_BADGE)) {
      shellPost({ type: "badge.set", count: 0 });
      return;
    }
    if (typeof navigator.clearAppBadge === "function") {
      const result = navigator.clearAppBadge();
      if (result && typeof result.catch === "function") result.catch(() => {});
      return;
    }
    if (typeof navigator.setAppBadge === "function") {
      const result = navigator.setAppBadge(0);
      if (result && typeof result.catch === "function") result.catch(() => {});
    }
  } catch {
    // Same as above: never a reason to take a session down.
  }
}
