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

import { dueNowCount } from "./model.js";

/** Whether this browser has the Badging API at all. Desktop tabs mostly do
 *  not, and an uninstalled PWA is refused even where the method exists. */
export function supported() {
  return typeof navigator !== "undefined" && typeof navigator.setAppBadge === "function";
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
  if (!supported()) return 0;
  const count = badgeCount(doc, opts);
  try {
    if (count > 0) {
      const result = navigator.setAppBadge(count);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } else {
      clearBadge();
    }
  } catch {
    // A synchronous throw from a platform that only pretends to support this.
  }
  return count;
}

/**
 * Take the badge away. Used when the vault is wiped - and NOT when it locks:
 * a count is content-free, and a badge that survives the lock is the whole
 * point of having one.
 */
export function clearBadge() {
  if (typeof navigator === "undefined") return;
  try {
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
