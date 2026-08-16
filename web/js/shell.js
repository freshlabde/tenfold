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
 * The fourth one is different in kind: the first three are properties of the
 * BUILD and are always advertised, this one is a property of the DEVICE and
 * appears only where the shell found biometric hardware. It says nothing about
 * whether a face is enrolled right now - `bio.available` answers that, and it
 * can be asked with the vault still locked.
 */
export const CAP_BIO = "bio";
/**
 * The fifth is a property of the DEVICE, like `bio` and unlike the first three.
 * A Taptic Engine is hardware: no iPad has one, and on a device without one
 * every UIKit feedback call is accepted and silently does nothing - so a shell
 * that advertised this everywhere would be promising that a tap will be felt on
 * a machine where it cannot be. The shell asks
 * `CHHapticEngine.capabilitiesForHardware()` at injection time and leaves the
 * name out where the answer is no, which is also why it is absent in a
 * simulator.
 *
 * What that means here: an absent `haptic` is ordinary rather than a shell too
 * old to have it. Every sender in haptics.js is then a no-op, which is exactly
 * what a browser gets and the correct degradation in both cases - a haptic is
 * the one message whose absence changes nothing anybody can see.
 */
export const CAP_HAPTIC = "haptic";
/**
 * The sixth is a property of the BUILD again, like the first three and unlike
 * `bio`/`haptic`: writing a file into the app's own container needs no hardware
 * and cannot be absent on a device the shell already runs on, so the shell
 * advertises it always. There is nothing to ask `capabilitiesForHardware()`
 * about.
 *
 * What that means here: an absent `vaultmirror` says one thing only - a shell
 * built before this existed - and vaultmirror.js then behaves exactly as it
 * does in a browser. That is also why the settings row keeps its older, vaguer
 * sentence in that case rather than claiming there is no spare copy: a build
 * that cannot look is not a build that looked and found nothing.
 */
export const CAP_MIRROR = "vaultmirror";
/**
 * The seventh is a property of the BUILD, like `reminder`/`badge`/`widget`/
 * `vaultmirror` and unlike `bio`/`haptic`: a tab bar is four labels and a
 * selection, it asks no hardware question, and there is no device the shell
 * runs on where it could not be drawn. A shell that draws one advertises this
 * always; a shell that does not, never.
 *
 * What that means here, and it is the whole point of the name existing: this is
 * NOT `inShell()`. Every shell ever built answers yes to that, including the
 * ones bundling a copy of `web/` older than this file. `shellWith(CAP_NAV)`
 * answers yes only for a shell that actually paints the bar - so an older shell,
 * or one whose bundled web app is ahead of its Swift, keeps the web header and
 * stays a complete app instead of losing every route into settings.
 *
 * Today no shell advertises it. nav.js is therefore inert everywhere: in a
 * browser, in a PWA, and in the shell that is currently shipping.
 */
export const CAP_NAV = "nav";
/**
 * The eighth is neither, and it is the first of its own kind: `reminder`,
 * `badge`, `widget`, `vaultmirror` and `nav` are properties of the BUILD and
 * `bio`/`haptic` are properties of the DEVICE, but this one is a property of
 * the CONFIGURATION. The shell advertises it only where a RevenueCat key was
 * compiled in - which is no build before activation day and every build after
 * it, on the same hardware, from the same source.
 *
 * What that means here: an absent `tips` is not a shell too old and not a
 * device that cannot, it is a build with no store behind the rows. So the page
 * draws no tip jar at all rather than three buttons that would each come back
 * with "there is nothing here" - which is the whole reason the name exists
 * instead of the page discovering it from an `unavailable` code. tips.js sends
 * nothing without it, and the settings row is absent rather than disabled.
 */
export const CAP_TIPS = "tips";
/**
 * The ninth is a property of the BUILD, like `reminder` and `vaultmirror`:
 * writing a temp file and raising the system share sheet needs no hardware
 * and no configuration, so a shell that can do it advertises it always.
 *
 * Why it exists at all: `ctx.download`'s anchor-and-object-URL move is a
 * browser fact. Inside the shell the navigation guard cancels the `blob:` URL
 * - correctly, it is not the app origin - and the file went NOWHERE while the
 * page toasted "File written." A backup path that reports success without a
 * file is the worst sentence this app can say, so in a shell with this
 * capability the bytes cross the bridge instead and come back as the iOS
 * share sheet: AirDrop, Save to Files, mail, a chat. An absent `fileexport`
 * means a shell built before this existed; `ctx.download` then keeps the
 * anchor path, which is also what every browser gets.
 */
export const CAP_FILE = "fileexport";

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
