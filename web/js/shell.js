// shell.js - the native shell, when there is one.
//
// tenfold runs unchanged in a browser and, since wave 2 of the tenfold-ios
// repository, inside a thin native shell. The shell injects
// `window.__tenfoldShell` at document start and advertises what it can do;
// this module is the only place in the web app that knows that channel exists.
//
// What it does: feature-detects the shell, answers whether a named capability
// is on offer, and wraps the request/reply round trip in a promise that always
// settles - including when nothing comes back.
//
// What it deliberately does NOT do: it holds no state, it sends nothing on its
// own, and it never decides WHAT to send. push.js and badge.js do that; this
// is the transport and nothing else.
//
// The rule that binds everything crossing here: NO VAULT PLAINTEXT. The shell
// is outside the trust boundary - it is the part Apple reviews and the part
// that hands data to the operating system - so counters, booleans, one hour
// and sentences the app itself wrote may cross. Titles, notes, passphrases and
// recovery keys may not, ever. tenfold-ios/docs/BRIDGE.md states the same rule
// from the other side, and the two statements have to stay in agreement.

/**
 * How long a reply may take before the caller is told that nothing came back.
 *
 * Not decoration: `enablePush()` awaits this round trip behind a button that
 * says "working", and a promise that never settles is a button that never
 * comes back. Everything on the other side is a local UNUserNotificationCenter
 * call with no network in it, so eight seconds is already generous.
 */
export const REPLY_TIMEOUT_MS = 8000;

/**
 * Capability names, exactly as the shell advertises them.
 *
 * Duplicated in tenfold-ios/Sources/Bridge/ShellBridge.swift by necessity: two
 * repositories on two release cycles cannot import from each other. That makes
 * a rename a silent break - the web app would simply stop offering a feature
 * the shell still has - so the names are pinned by a test on this side and by
 * the bridge's own unit tests on the other.
 */
export const CAP_REMINDER = "reminder";
export const CAP_BADGE = "badge";
export const CAP_WIDGET = "widget";

/**
 * The channel, or null in a plain browser.
 *
 * Every caller must treat null as ordinary. A feature that *requires* the
 * shell is a feature the web app has lost, and the web app is the product.
 * @returns {Object|null}
 */
export function shellChannel() {
  if (typeof window === "undefined") return null;
  const channel = window.__tenfoldShell;
  if (!channel || typeof channel !== "object") return null;
  if (typeof channel.post !== "function") return null;
  return channel;
}

/** @returns {boolean} true when a shell is present. */
export function inShell() {
  return shellChannel() !== null;
}

/**
 * Does the shell on the other end offer this capability?
 *
 * Asked rather than assumed, because the shell ships separately: an older
 * build may carry the bridge without the feature, and the honest answer there
 * is "no", not a message into the void.
 * @param {string} capability
 * @returns {Object|null} the channel when it offers this, else null
 */
export function shellWith(capability) {
  const channel = shellChannel();
  if (!channel) return null;
  const caps = channel.capabilities;
  if (!Array.isArray(caps)) return null;
  return caps.indexOf(capability) === -1 ? null : channel;
}

/**
 * Fire and forget. For messages where there is nothing to wait for - the badge
 * count, the widget's counters - and where a caller must never be blocked.
 * @param {Object} message
 * @returns {boolean} false when there is no shell to take it
 */
export function shellPost(message) {
  const channel = shellChannel();
  if (!channel) return false;
  try {
    return channel.post(message) !== false;
  } catch {
    // A shell that throws is a shell that is not there, as far as the web app
    // is concerned. It must never take a session down.
    return false;
  }
}

/**
 * Listen for a message the shell sends on its own.
 *
 * Everything else in this module is the page asking a question. This is the
 * other direction: the shell delivers unprompted messages - so far exactly one,
 * `share.incoming` - by dispatching a `tenfoldshell` CustomEvent on window from
 * its `_receive` hook. Replies to a `request()` or a `send()` never come
 * through here; those resolve their own promise and are never dispatched.
 *
 * Still transport and nothing else: this knows the event name and nothing about
 * what any message means. In a browser it costs one listener that never fires.
 *
 * @param {string} type the message type to listen for
 * @param {(message: Object) => void} handler
 * @returns {() => void} removes the listener
 */
export function onShellMessage(type, handler) {
  if (typeof window === "undefined") return () => {};
  const listener = (event) => {
    const message = event && event.detail;
    if (!message || message.type !== type) return;
    handler(message);
  };
  window.addEventListener("tenfoldshell", listener);
  return () => window.removeEventListener("tenfoldshell", listener);
}

/**
 * Send and wait for the native reply.
 *
 * The message travels FLAT - `{type, hour, title, body}` with an id added -
 * because that is the wire shape docs/BRIDGE.md specifies for the reminder
 * messages. The channel's own `request(type, payload)` nests its argument
 * under `payload` instead and is kept for `ping`.
 *
 * Always settles: a shell that never answers rejects after REPLY_TIMEOUT_MS
 * rather than leaving the caller waiting for the rest of the session.
 *
 * @param {Object} message must carry a `type`
 * @returns {Promise<Object>} the reply message
 */
export function shellSend(message) {
  const channel = shellChannel();
  if (!channel || typeof channel.send !== "function") {
    return Promise.reject(new Error("shell unavailable"));
  }
  let reply;
  try {
    reply = channel.send(message);
  } catch {
    return Promise.reject(new Error("shell unavailable"));
  }
  if (!reply || typeof reply.then !== "function") {
    return Promise.reject(new Error("shell unavailable"));
  }
  return Promise.race([
    reply,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error("shell timeout")), REPLY_TIMEOUT_MS);
    }),
  ]);
}
