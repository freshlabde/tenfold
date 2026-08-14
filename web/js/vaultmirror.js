// vaultmirror.js - the second copy of the vault, as a file in the app container.
//
// What it does: hands the sealed vault to the native shell as text, asks for it
// back, and asks what the shell is holding. Three messages, and this is the only
// place in the web app that knows their shape.
//
// Why it exists: the vault lives in exactly ONE place - IndexedDB inside the
// shell's `WKWebsiteDataStore` (store.js, tenfold-ios/docs/DECISIONS.md D5).
// There is no second copy on the device. WebKit storage can be evicted under
// pressure or corrupted by a bad shutdown, and the person then has nothing at
// all unless they made an export - which is a thing people mean to do and do
// not. A second copy of the SAME ciphertext, written as an ordinary file into
// the app's own container, costs nothing and removes the single point of
// failure. It is a spare tyre, not a feature.
//
// Ciphertext stays ciphertext, and that is not a compromise made here - it is
// the only thing on offer. This module never sees the master key, never sees
// the document, and hands the shell exactly the bytes `exportEncrypted()`
// produces. The shell could already read that file out of its own container if
// it wanted to; what it still cannot do is open it. NOT A NEW TRUST BOUNDARY:
// the same rule shell.js states - no vault plaintext crosses - is untouched,
// because nothing crossing here is plaintext.
//
// The wire shapes, fixed, and duplicated in the shell repository by the same
// necessity every other message here is - two repositories, no shared import:
//
//     page -> shell, fire and forget:
//       { type: "mirror.write", blob: "...", savedAt: 1755180000000 }
//
//     page -> shell, request/reply:
//       { type: "mirror.read" }
//         -> { blob: "..." | null, savedAt: <ms> | null }
//       { type: "mirror.status" }
//         -> { present: bool, bytes: number, savedAt: <ms>|null, error: string|null }
//
// `blob` is the EXPORT FORMAT, deliberately and not incidentally: it is byte
// for byte what a `.tenfold` file downloaded from settings contains, produced
// by the same `exportEncrypted()`. That choice is what makes the restore path
// free - adopting a mirror is `importEncrypted()`, the path that has existed
// since stage 1 and is tested by everything that tests an import. A private
// wire format for the mirror would have been a second serialisation of the
// same object and a second reader for it, and the day the vault envelope grows
// a field the private one is the one that gets forgotten.
//
// What it deliberately does NOT do: no clear message. The shell already learns
// that the vault is gone - `vault.wiped`, sent by `wipeLocalVault()` before
// anything local is cleared - and already deletes the biometric Keychain item
// on it. Deleting the mirror belongs at that same point, in the shell, for one
// reason that outranks tidiness: a second way to destroy the vault is a second
// way to FORGET to destroy the vault, and a mirror that outlived a deliberate
// wipe would come back at the next boot. One signal, one place.
//
// In a browser every function here is a no-op or null, and none of them throws.

import { CAP_MIRROR, shellWith, shellPost, shellSend } from "./shell.js";
import { exportEncrypted } from "./portability.js";

/**
 * The three message names, exactly as the shell answers to them.
 *
 * Pinned literally by a test on this side and by the bridge's own tests on the
 * other. A rename here would not break a build; it would quietly stop the spare
 * copy being written, and nobody finds that out until the day it was needed.
 */
export const MSG_WRITE = "mirror.write";
export const MSG_READ = "mirror.read";
export const MSG_STATUS = "mirror.status";

/**
 * Last answer of `mirror.status`, or null until the shell has been asked.
 *
 * The settings screen has to paint NOW and the answer is a round trip, so it
 * reads this synchronously, asks when it is null, and repaints on the answer -
 * the same shape `bio.availableCached()` has, for the same reason.
 */
let statusCache = null;

/**
 * Is there a shell offering to keep the spare copy?
 *
 * `vaultmirror` is a property of the BUILD, like `reminder`/`badge`/`widget`
 * and unlike `bio`/`haptic`: writing a file into the app's own container needs
 * no hardware and is available on every device the shell runs on, so the shell
 * advertises it always. An absent name therefore means one thing only - a shell
 * older than this feature - and the honest answer there is the same as a
 * browser's: there is no second copy, and the app says so rather than promising
 * one.
 *
 * @returns {boolean}
 */
export function mirrorAvailable() {
  return shellWith(CAP_MIRROR) !== null;
}

/**
 * Write the spare copy. Fire and forget, and it must stay that way.
 *
 * The caller is `flushSave()`, immediately after the IndexedDB write it must
 * not extend: the vault in IndexedDB is the one that matters and this is the
 * spare, so a mirror that is slow, or refused, or written by a shell that is
 * out of disk, must cost the save nothing and must never surface as a failed
 * save. Hence a post rather than a send - there is no reply to read and no
 * caller that could act on one - and hence every failure path below ending in
 * `false` rather than a throw.
 *
 * It is async only because a Blob's text is: the bytes are taken from
 * `exportEncrypted()` rather than re-serialised here, which is the whole point
 * of the format choice, and reading a Blob back is a promise. Nothing awaits
 * this promise, and nothing may start to.
 *
 * @param {Object} vault the sealed VaultFile - ciphertext, never a document
 * @param {{savedAt?: number}} [opts] the timestamp the vault was saved under,
 *   so the mirror carries the vault's own age rather than the moment a copy
 *   happened to be made
 * @returns {Promise<boolean>} whether a shell took it
 */
export async function writeMirror(vault, opts = {}) {
  if (!mirrorAvailable()) return false;
  let blob;
  try {
    blob = await exportEncrypted(vault).text();
  } catch {
    // `exportEncrypted` refuses anything that is not a plain object, and a
    // Blob can fail to read. Neither is worth telling anybody about: the save
    // that triggered this already succeeded.
    return false;
  }
  const savedAt = typeof opts.savedAt === "number" ? opts.savedAt : Date.now();
  // A fresh write means the cached status is a description of the previous
  // file. Dropped rather than guessed at - the shell knows the byte count and
  // this side does not.
  statusCache = null;
  return shellPost({ type: MSG_WRITE, blob, savedAt });
}

/**
 * Ask for the spare copy back.
 *
 * The reply carries the text, not a vault: parsing and validating it is
 * `importEncrypted()`'s job in portability.js, which is exactly the code a
 * `.tenfold` file goes through, and keeping that here would be a second reader
 * of one format. This module returns the wire and stops.
 *
 * Null covers every way there can be nothing to adopt - no shell, no
 * capability, no file, a shell that did not answer inside the bridge's own
 * timeout, or an answer that was not a string. One value for one question, and
 * the caller has the same thing to do in all five cases.
 *
 * @returns {Promise<{blob: string, savedAt: number|null}|null>}
 */
export async function readMirror() {
  if (!mirrorAvailable()) return null;
  let reply;
  try {
    reply = await shellSend({ type: MSG_READ });
  } catch {
    return null;
  }
  if (!reply || typeof reply.blob !== "string" || reply.blob.length === 0) return null;
  return {
    blob: reply.blob,
    savedAt: typeof reply.savedAt === "number" ? reply.savedAt : null,
  };
}

/**
 * What the shell is holding, for the one row in settings that says so.
 *
 * Null means "nothing to say" - a browser, or a shell without the capability -
 * and is NOT the same as `{present: false}`, which is a shell that looked and
 * found no file. The settings row keeps its old, vaguer sentence for null and
 * states the fact for the other two, because "there is no spare copy" and "this
 * build cannot tell you" are different sentences and only one of them is true
 * at a time.
 *
 * `error` is carried through as the shell wrote it: a file that could not be
 * read is worth a different row from a file that was never written, and this
 * side must not flatten the two.
 *
 * @returns {Promise<{present: boolean, bytes: number, savedAt: number|null, error: string|null}|null>}
 */
export async function mirrorStatus() {
  if (!mirrorAvailable()) return null;
  let reply;
  try {
    reply = await shellSend({ type: MSG_STATUS });
  } catch {
    // A shell that does not answer is not a shell without a file. Cached as an
    // error rather than as an absence, so the row says nothing rather than
    // something false - and so a settings repaint does not ask again forever.
    statusCache = { present: false, bytes: 0, savedAt: null, error: "unreachable" };
    return statusCache;
  }
  statusCache = {
    present: reply.present === true,
    bytes: typeof reply.bytes === "number" ? reply.bytes : 0,
    savedAt: typeof reply.savedAt === "number" ? reply.savedAt : null,
    error: typeof reply.error === "string" && reply.error ? reply.error : null,
  };
  return statusCache;
}

/** The last answer, synchronously. Null until the shell has been asked. */
export function mirrorStatusCached() {
  return statusCache;
}

/** Forget the last answer. Used by the tests; the app drops it on every write. */
export function resetMirrorStatus() {
  statusCache = null;
}
