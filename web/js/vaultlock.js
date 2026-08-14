// vaultlock.js - the shell asking for the vault to be closed.
//
// What it does: listens for the one unprompted message the native shell sends
// when the app has been away from the foreground for longer than the shell's
// own deadline, and calls back. That is the whole module.
//
// Why the shell decides this and not the page: a web page in the background is
// not a reliable clock. Timers are throttled, a suspended WKWebView runs
// nothing at all, and `document.hidden` says when the app went away but not
// how long it stayed - a page woken after two hours can measure two hours of
// wall time, or one frame, depending on what the operating system did to it in
// between. So the away time is MEASURED NATIVELY, in the shell, and the page is
// told the answer. The app's own fifteen-minute idle lock is unchanged and
// still runs; this is a second, shorter deadline that only exists where there
// is a shell to keep it.
//
// The wire shape, fixed, and duplicated in the shell repository by the same
// necessity every other message here is - two repositories, no shared import:
//
//     { type: "vault.lock", reason: "background", awaySeconds: 87 }
//
// `reason` and `awaySeconds` are read by nobody on this side. They are on the
// wire because a lock somebody did not ask for should be explicable from a log
// on either side of the bridge, and because the shell already has both numbers
// - not because the page needs them to act. Nothing about the lock changes
// with them, which is the point: there is exactly one lock in this app.
//
// What it deliberately does NOT do: no capability check, and no handshake. No
// capability, because like `share.incoming` this is a push the page listens
// for rather than a feature it asks for - in a browser it costs one listener
// that never fires, and a missing shell has to be ordinary rather than an
// error. No handshake either, and that is the difference from the share inbox:
// a share arriving before the listener exists would be somebody's note lost,
// while a lock arriving before the app has booted is a lock that was already
// true - a page that has not finished starting has nothing unlocked to close.

import { onShellMessage } from "./shell.js";

/**
 * The message name, exactly as the shell sends it. Pinned literally by a test
 * on this side and by the bridge's own tests on the other, because a rename
 * would silently stop the vault locking rather than break a build.
 */
export const SHELL_MESSAGE = "vault.lock";

/**
 * Listen for it.
 *
 * The handler is called SYNCHRONOUSLY, inside the dispatch, and it has to stay
 * that way: the shell holds its privacy veil over the web view until the
 * JavaScript that took this message returns, so a handler that deferred its
 * work to an animation frame or a promise would hand the veil back over a
 * screen still showing the list. Whatever the callback does, it does now.
 *
 * A callback that throws is swallowed. A message arriving at an awkward moment
 * must never take the session down - and the caller decides what an awkward
 * moment is, since only it knows whether there is anything open to close.
 *
 * @param {() => void} onLock
 * @returns {() => void} removes the listener
 */
export function startShellVaultLock(onLock) {
  if (typeof window === "undefined") return () => {};
  return onShellMessage(SHELL_MESSAGE, () => {
    if (typeof onLock !== "function") return;
    try {
      onLock();
    } catch {
      // Nothing to report to: the shell asked for a lock, not for an answer.
    }
  });
}
