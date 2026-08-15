// tips.js - the tip jar the native shell has, and the only module that knows
// its wire shapes.
//
// What it does: asks the shell what there is to buy, and asks it to run a
// purchase. Two messages, and nothing else.
//
// Why it exists: inside the iOS shell the web app's own tip jar cannot exist -
// an external payment link for a tip is an App Store rejection, which is why
// `supportAvailable()` in ui/support.js is `!inShell()`. The shell answers that
// with three consumable in-app purchases of its own, and has done since wave 7:
// the RevenueCat store, the bridge, the four outcome codes and the tests are
// all on the other side, with no caller on this one. This file is that caller.
//
// The wire shapes, fixed, and duplicated in the shell repository by the same
// necessity every other message here is - two repositories, no shared import:
//
//     page -> shell, request/reply:
//       { type: "tips.offers" }
//         -> { ok: true, offers: [{id, title, price, currency}, ...] }
//         -> { ok: false, code: "unavailable"|"unknownProduct"|"network"|"failed" }
//       { type: "tips.buy", product: "es.freshlab.tenfold.tip.espresso" }
//         -> { ok: true, state: "purchased"|"cancelled"|"pending"|"failed", code? }
//         -> { ok: false, code: ... }
//
// THE FIELD IS `product` AND NOT `id`, and that is not a preference. `send()`
// allocates the reply-routing id and then copies the message's own fields over
// the top of it, so a message carrying its own `id` would overwrite the routing
// id with a product identifier: native would answer `replyTo: "es.freshlab.
// tenfold.tip.espresso"`, the pending map keyed on `"s7"` would never resolve,
// and every purchase would hang on both sides with no error anywhere.
//
// `ok` AND `state` ARE DIFFERENT QUESTIONS. `ok` is whether the shell
// understood the message and ran the flow; `state` is how the flow ended. A
// cancelled purchase is therefore `ok: true, state: "cancelled"` - the
// machinery worked and the person said no - and a page that conflated the two
// would apologise for a decision somebody deliberately made.
//
// What it deliberately does NOT do:
//
//   - It holds no catalogue. The three product identifiers, their names and
//     their prices come from the store, through the shell, in the order the
//     shell sorted them into (cheapest first, part of the contract). A copy of
//     that list here would be a second place for activation day to go wrong.
//   - It never formats a price. `price` is a string the App Store built: the
//     right symbol, the right separator, the right side of the number and the
//     right amount after Apple's own regional rounding. A NumberFormatter here
//     would be a second opinion about a value with exactly one correct answer.
//   - It keeps no state and writes nothing. There is no receipt, no
//     entitlement, no restore and no "is a supporter" flag, because nothing is
//     unlocked by paying - the moment this side could answer *did they pay*,
//     somebody would draw a badge with it and the tip jar would become a
//     paywall by accretion. The one flag that exists,
//     `doc.settings.supportOpened`, predates this and means "went looking for
//     the tip jar", which is a fact about a screen and not about a payment.
//
// In a browser every function here answers without sending anything.

import { CAP_TIPS, shellWith, shellSend } from "./shell.js";

/**
 * The two message names, exactly as the shell answers to them.
 *
 * Pinned literally by tests/tips.spec.js on this side and by the bridge's own
 * unit tests on the other. A rename here would not break a build; it would
 * quietly make the only way to pay for this app unreachable.
 */
export const MSG_OFFERS = "tips.offers";
export const MSG_BUY = "tips.buy";

/**
 * Why an ask failed, in the four words the shell uses. Each one exists because
 * the response to it is different, which is why `unknownProduct` is not folded
 * into `failed`: a configuration change and a code change must not look alike.
 */
export const CODES = Object.freeze(["unavailable", "unknownProduct", "network", "failed"]);

/** How a purchase ended. Four, and no more. */
export const STATES = Object.freeze(["purchased", "cancelled", "pending", "failed"]);

/**
 * What the shell will accept as a product identifier: reverse-DNS, 1 to 64
 * characters. Checked before sending rather than after being refused, for the
 * same reason haptics.js checks its own vocabulary - the guard is about THIS
 * file. An identifier this side invented is easier to find in a test here than
 * in a native log nobody is reading.
 */
const VALID_PRODUCT = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Is there a store behind the rows?
 *
 * `tips` is a property of the CONFIGURATION rather than of the build or the
 * device: the shell advertises it only where a RevenueCat key was compiled in.
 * So an absent name means there is nothing to sell in this build, and the
 * honest answer is the same one a browser gets - no tip jar, and no sentence
 * apologising for one.
 *
 * @returns {boolean}
 */
export function tipsAvailable() {
  return shellWith(CAP_TIPS) !== null;
}

/** The reply's code, or `failed` for anything this side cannot recognise. */
function codeOf(reply) {
  const code = reply && reply.code;
  return CODES.indexOf(code) === -1 ? "failed" : code;
}

/**
 * One offer, or null where the shell sent something unusable.
 *
 * Dropped rather than patched: a row with a made-up name or no price is a dead
 * button, and the sheet's whole rule is that it renders only offers that
 * arrived. `currency` is carried through as ISO 4217 for a caller that wants
 * to say something about the currency without parsing the price string.
 */
function normalise(offer) {
  if (!offer || typeof offer !== "object") return null;
  const id = typeof offer.id === "string" ? offer.id : "";
  const title = typeof offer.title === "string" ? offer.title : "";
  const price = typeof offer.price === "string" ? offer.price : "";
  if (!VALID_PRODUCT.test(id) || !title || !price) return null;
  return {
    id,
    title,
    price,
    currency: typeof offer.currency === "string" ? offer.currency : "",
  };
}

/**
 * What there is to buy, priced for the storefront this device is in.
 *
 * The order is the shell's and is left alone: it sorts cheapest first because a
 * tip jar whose three rows reshuffle between launches looks broken, and a
 * second sort here would be a second opinion about an order that is part of the
 * contract.
 *
 * `offers` and `code` are never both present, which is the reply's own rule.
 * An empty list is never an answer: "the store said there are none" and "the
 * store could not be asked" need different words on screen and an empty array
 * cannot tell them apart, so the shell refuses with a code instead. A shell
 * that sent one anyway has broken that promise, and it is reported as `failed`
 * rather than translated into a claim about a store nobody asked.
 *
 * @returns {Promise<{offers: Array<{id: string, title: string, price: string, currency: string}>|null, code: string|null}>}
 */
export async function loadOffers() {
  if (!tipsAvailable()) return { offers: null, code: "unavailable" };
  let reply;
  try {
    reply = await shellSend({ type: MSG_OFFERS });
  } catch {
    // A shell that does not answer and a message it could not read are the same
    // thing to this page, which is why the bridge has no code for the second.
    return { offers: null, code: "failed" };
  }
  if (!reply || reply.ok !== true) return { offers: null, code: codeOf(reply) };
  const offers = Array.isArray(reply.offers) ? reply.offers.map(normalise).filter(Boolean) : [];
  if (offers.length === 0) return { offers: null, code: "failed" };
  return { offers, code: null };
}

/**
 * Put the payment sheet on screen and wait for it to end.
 *
 * Always an outcome, never a throw: this is a path somebody is waiting on with
 * their thumb on a button, and there is nothing a caller could do with an
 * exception that it cannot do with `state: "failed"`.
 *
 * `cancelled` is an outcome and not an error. The caller's response to it is
 * silence.
 *
 * @param {string} productId the identifier from an offer, unchanged
 * @returns {Promise<{state: string, code: string|null}>}
 */
export async function buy(productId) {
  if (!tipsAvailable()) return { state: "failed", code: "unavailable" };
  if (typeof productId !== "string" || !VALID_PRODUCT.test(productId)) {
    // Nothing goes on the wire. The shell would refuse this with `ok: false,
    // code: "failed"`, and the round trip would tell nobody anything new.
    return { state: "failed", code: "failed" };
  }
  let reply;
  try {
    reply = await shellSend({ type: MSG_BUY, product: productId });
  } catch {
    return { state: "failed", code: "failed" };
  }
  if (!reply || reply.ok !== true) return { state: "failed", code: codeOf(reply) };
  const state = STATES.indexOf(reply.state) === -1 ? "failed" : reply.state;
  return { state, code: state === "failed" ? codeOf(reply) : null };
}
