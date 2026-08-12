// bio.js - Face ID inside the native shell: the fourth envelope on the vault.
//
// What it does: where the app runs inside the tenfold-ios shell and that shell
// found biometric hardware, it asks the shell for a 32-byte key-encryption key,
// wraps the master key with it (crypto.js, wrapper kind "shell-bio-v1"), and
// asks for the same key back - behind the device's own Face ID or Touch ID
// prompt - to open the vault again. It is the same idea as webauthn.js one
// layer down: there is no WebAuthn in a WKWebView, so the platform's own key
// store takes the authenticator's place.
//
// What it deliberately does NOT do: it stores no key material. The KEK exists
// in the shell's Keychain and, for the length of one wrap or one unwrap, in
// this page's memory. What goes into localStorage is two non-secret pointers -
// which vault this device armed, and under which wrapper label - so that
// disabling on this device cannot touch the wrapper another device added to the
// same synced vault.
//
// And the sentence that has to survive this file: BIOMETRY IS NEVER A FOURTH
// WAY BACK IN. The Keychain item is `WhenUnlockedThisDeviceOnly`, never
// synchronisable, and dies when the enrolled face changes. It is convenience on
// ONE device; the passphrase and the recovery key remain the only two things
// that recover a vault, and a new phone starts with them.
//
// The wire shape is written down once, in tenfold-ios/docs/BRIDGE.md, and both
// repositories assert against it literally - see tests/bio.spec.js here and
// Tests/Unit/BioMessageTests.swift there.

import { shellChannel, shellWith, shellSend, CAP_BIO } from "./shell.js";
import {
  addShellBioWrapper,
  removeWrapper,
  unlockWithShellBioKey,
  listWrappers,
  vaultId,
  withVaultId,
  newVaultId,
  b64uDecode,
  SHELL_BIO_KIND,
} from "./crypto.js";

/** The message names, exactly as the shell answers to them. */
export const MSG_AVAILABLE = "bio.available";
export const MSG_CREATE = "bio.createKey";
export const MSG_UNWRAP = "bio.unwrapKey";
export const MSG_DELETE = "bio.deleteKey";
export const MSG_WIPED = "vault.wiped";

/**
 * The five outcomes a refused unwrap can have. Anything the shell says that is
 * not in this list is read as `failed` - a shell newer than this build must
 * degrade to the quiet fallback rather than to an unhandled string.
 */
export const CODES = ["cancelled", "lockedOut", "invalidated", "missing", "failed"];

/** Where the two device-local pointers live. Nothing secret is written here. */
const PREF_KEY = "tenfold.shellbio";

/** One label per device, so device A disabling cannot revoke device B. */
const LABEL_PREFIX = "shell-bio:";
const LABEL_ID_CHARS = 12;
const LABEL_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

const KEY_BYTES = 32;

/** The longest sentence the shell will put on screen; it cuts, we do too. */
const REASON_MAX = 300;

/**
 * Raised when the biometric way in did not produce a key. `code` is one of
 * CODES and is the whole difference between "say nothing" and "say something",
 * which is why it is on the error rather than in a log line.
 */
export class BioError extends Error {
  constructor(code) {
    super("biometric unlock unavailable");
    this.name = "BioError";
    this.code = CODES.includes(code) ? code : "failed";
  }
}

/* ------------------------------------------------------------- support checks */

/**
 * A shell that offers the capability. Two facts in one answer, both required:
 * there is a bridge, and the build on the other end found biometric hardware.
 * In a browser this is false and every caller treats that as ordinary.
 */
export function supported() {
  return shellWith(CAP_BIO) !== null;
}

/** Last answer of `bio.available`: null until the shell was asked. */
let availability = null;

/** Synchronous read of that answer, for a screen that must paint now. */
export function availableCached() {
  return availability;
}

/**
 * What the device can do right now: hardware, and whether a face or a finger is
 * enrolled at this moment. Two facts rather than one, because the honest line
 * differs - "this device cannot" and "set Face ID up first" are not the same
 * sentence. Asked with the vault locked as well as open; it opens no Keychain
 * item and shows no prompt.
 * @returns {Promise<{available: boolean, enrolled: boolean, biometryType: string}>}
 */
export async function available() {
  if (!supported()) {
    availability = { available: false, enrolled: false, biometryType: "none" };
    return availability;
  }
  try {
    const reply = await shellSend({ type: MSG_AVAILABLE });
    availability = {
      available: reply.available === true,
      enrolled: reply.enrolled === true,
      biometryType: typeof reply.biometryType === "string" ? reply.biometryType : "none",
    };
  } catch {
    // A shell that does not answer is a shell that cannot do this today.
    availability = { available: false, enrolled: false, biometryType: "none" };
  }
  return availability;
}

/* ---------------------------------------------------------------- pointers */

function readPointer() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || typeof p.vaultId !== "string" || typeof p.label !== "string") return null;
    return { vaultId: p.vaultId, label: p.label };
  } catch {
    return null;
  }
}

function writePointer(pointer) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(pointer));
  } catch {
    // Storage disabled: this device cannot find its own wrapper again on the
    // next start. The vault is untouched and the passphrase still opens it.
  }
}

/** Drop the local pointers. The wrapper in the vault is removed separately. */
export function forget() {
  try {
    localStorage.removeItem(PREF_KEY);
  } catch {
    // No storage, no pointer.
  }
}

function newLabel() {
  const bytes = new Uint8Array(LABEL_ID_CHARS);
  crypto.getRandomValues(bytes);
  let out = LABEL_PREFIX;
  for (const b of bytes) out += LABEL_ALPHABET[b % LABEL_ALPHABET.length];
  return out;
}

/** The wrapper label this device owns in this vault, if there is one. */
export function wrapperLabel(vault) {
  const p = readPointer();
  if (!p || !vault) return null;
  // A pointer that belongs to a different vault file (adopted, imported,
  // recreated after a wipe) points at nothing here.
  return vaultId(vault) === p.vaultId ? p.label : null;
}

/**
 * True when this device holds a pointer AND the vault still carries the
 * matching wrapper. Both halves matter: a vault adopted from another device
 * carries somebody else's wrapper, and a wrapper another device revoked leaves
 * a pointer that now points at nothing - and the lock screen must not offer a
 * button that cannot work.
 */
export function enabled(vault) {
  const label = wrapperLabel(vault);
  if (!label) return false;
  try {
    return listWrappers(vault).some((w) => w.kind === SHELL_BIO_KIND && w.label === label);
  } catch {
    return false;
  }
}

/* ------------------------------------------------- what the last attempt said */

/**
 * Session state, and deliberately only session state: nothing here survives a
 * reload, because none of it is a decision - it is what the last prompt did.
 *
 * `hidden` takes the button off the lock screen for the rest of this session
 * after an outcome that cannot improve by trying again. `stale` says the
 * wrapper in the vault is dead and should be cleaned away at the next
 * passphrase unlock. `setupAgain` is the one thing the person is told twice:
 * once quietly on the lock screen, once as the wording of the settings row.
 */
let session = { code: null, hidden: false, stale: false, setupAgain: false };

/** Code of the last refused unwrap, or null. */
export function lastCode() {
  return session.code;
}

/** Has this session been told the enrolment changed? */
export function needsSetupAgain() {
  return session.setupAgain;
}

/** Should the lock screen stop offering the button for the rest of the session? */
export function offerHidden() {
  return session.hidden;
}

/** Forget the last outcome. Called when the feature is armed or turned off. */
export function resetSession() {
  session = { code: null, hidden: false, stale: false, setupAgain: false };
}

/* ------------------------------------------------------------------- the key */

function decodeKey(value) {
  if (typeof value !== "string" || value.length === 0) throw new BioError("failed");
  let bytes;
  try {
    bytes = b64uDecode(value);
  } catch {
    throw new BioError("failed");
  }
  if (bytes.length !== KEY_BYTES) throw new BioError("failed");
  return bytes;
}

/* -------------------------------------------------------------------- arm it */

/**
 * Arm this device. Requires the vault open, because a new envelope can only be
 * built by somebody who already holds the master key.
 *
 * The shell always mints a NEW key here and replaces whatever was there - so
 * this also removes the wrapper the previous key belonged to, or the vault
 * would keep an envelope nothing can ever open again.
 *
 * @param {Object} vault
 * @param {CryptoKey} masterKey
 * @returns {Promise<Object>} the vault with one wrapper more - the caller saves it
 */
export async function enable(vault, masterKey) {
  if (!supported()) throw new BioError("failed");
  if (!vault || !masterKey) throw new BioError("failed");

  // A vault made before this feature existed has no identifier yet. Minting one
  // is a change to the vault file, which is why it happens here - with the
  // vault open and a save on the way - and not on the lock screen.
  let next = withVaultId(vault);
  const id = vaultId(next);

  let reply;
  try {
    reply = await shellSend({ type: MSG_CREATE, vaultId: id });
  } catch {
    throw new BioError("failed");
  }
  if (!reply || reply.ok !== true) throw new BioError(reply && reply.code);
  const key = decodeKey(reply.key);

  const previous = wrapperLabel(next);
  if (previous && listWrappers(next).some((w) => w.label === previous)) {
    next = await removeWrapper(next, previous);
  }
  const label = newLabel();
  next = await addShellBioWrapper(next, masterKey, key, label);
  key.fill(0);
  writePointer({ vaultId: id, label });
  resetSession();
  return next;
}

/* ------------------------------------------------------------------ open it */

/**
 * The unlock itself: the shell puts the system prompt on screen with the
 * sentence this page handed it, reads the KEK back behind the face, and the
 * page unwraps. Returns the master key exactly as unlockWithPassphrase does, so
 * the caller cannot tell - and does not need to tell - which envelope opened
 * the vault.
 *
 * @param {Object} vault
 * @param {string} reason the localised sentence for the system prompt
 * @returns {Promise<CryptoKey>}
 * @throws {BioError} with one of CODES
 */
export async function unlock(vault, reason) {
  if (!supported()) throw new BioError("failed");
  const id = vaultId(vault);
  if (!id) throw new BioError("missing");

  const sentence = String(reason || "").slice(0, REASON_MAX);
  if (!sentence) throw new BioError("failed");

  let reply;
  try {
    reply = await shellSend({ type: MSG_UNWRAP, vaultId: id, reason: sentence });
  } catch {
    reply = null;
  }
  if (!reply || reply.ok !== true) {
    const err = new BioError(reply && reply.code);
    noteFailure(err.code);
    throw err;
  }

  const key = decodeKey(reply.key);
  try {
    return await unlockWithShellBioKey(vault, key);
  } catch {
    // The bytes came back but they do not fit this wrapper: a vault restored
    // from an export, a wrapper another device replaced. Nothing to say, and
    // the wrapper is dead - clean it away after the passphrase unlock.
    const err = new BioError("failed");
    noteFailure("missing");
    throw err;
  } finally {
    key.fill(0);
  }
}

/** What each refusal leaves behind for the screens to read. */
function noteFailure(code) {
  session.code = code;
  if (code === "invalidated") {
    // The enrolment changed: the Keychain item is gone for good and so is the
    // usefulness of the wrapper. Say it once, offer the re-arm in settings.
    session.hidden = true;
    session.stale = true;
    session.setupAgain = true;
  } else if (code === "missing") {
    // There is no key for this vault: the feature is off, whatever the vault
    // file still says. Hide the button and clean the wrapper away.
    session.hidden = true;
    session.stale = true;
  } else if (code === "lockedOut") {
    // Biometry needs the device passcode before it will work again. The button
    // stays - trying again after that is exactly the right move.
    session.hidden = false;
  }
}

/**
 * Called after a unlock that did NOT come from here. When the last biometric
 * attempt proved the wrapper dead, this is where it leaves the vault - lazily,
 * with the master key present and a save already on the way, rather than on a
 * lock screen that can save nothing.
 *
 * @param {Object} vault
 * @returns {Promise<Object>} the same vault, or a smaller one the caller saves
 */
export async function reconcile(vault) {
  if (!session.stale || !vault) return vault;
  session.stale = false;
  const label = wrapperLabel(vault);
  const id = vaultId(vault);
  forget();
  if (id && supported()) {
    // Idempotent on the other side, and it forgets the "a key existed here"
    // marker too, so the next question answers `missing` rather than repeating
    // that a face changed.
    shellSend({ type: MSG_DELETE, vaultId: id }).catch(() => {});
  }
  if (!label) return vault;
  try {
    return await removeWrapper(vault, label);
  } catch {
    // Not there any more: the pointer is dropped either way, which is the part
    // that mattered.
    return vault;
  }
}

/* ----------------------------------------------------------------- turn off */

/**
 * Turn it off on this device: the wrapper leaves the vault, the pointer leaves
 * the browser, the key leaves the Keychain. Returns the vault to save; the
 * caller does that, because this module never touches storage beyond its own
 * two pointers.
 */
export async function disable(vault) {
  const label = wrapperLabel(vault);
  const id = vaultId(vault);
  forget();
  resetSession();
  if (id && supported()) {
    try {
      await shellSend({ type: MSG_DELETE, vaultId: id });
    } catch {
      // A delete that could not be delivered leaves a key behind that opens a
      // wrapper which is about to stop existing. Nothing to report.
    }
  }
  if (!label || !vault) return vault;
  try {
    return await removeWrapper(vault, label);
  } catch {
    return vault;
  }
}

/* ------------------------------------------------------------- the vault died */

/**
 * Tell the shell the vault is gone - wiped on this device or deleted
 * everywhere. It clears three things that live outside the vault and would
 * otherwise outlive it: the Keychain key, the widget's state plus the badge,
 * and the share slot.
 *
 * NOT gated on the `bio` capability: two of those three have nothing to do with
 * biometry, and a shell on a device without Face ID still has a widget. It is
 * gated on there being a shell at all.
 *
 * The message requires a vault identifier and the shell refuses one without it,
 * so a vault that never had one is named with a fresh id: the Keychain delete
 * then finds nothing, which is the outcome asked for, and the widget, the badge
 * and the share slot are cleared - which is the part that could not be skipped.
 *
 * @param {Object} vault
 * @returns {Promise<boolean>} whether a shell took the message
 */
export async function announceWipe(vault) {
  if (!shellChannel()) return false;
  const id = vaultId(vault) || newVaultId();
  forget();
  resetSession();
  try {
    await shellSend({ type: MSG_WIPED, vaultId: id });
    return true;
  } catch {
    return false;
  }
}
