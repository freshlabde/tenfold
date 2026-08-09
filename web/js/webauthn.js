// webauthn.js - unlocking with the authenticator the device already has:
// Touch ID on a Mac, Face ID on an iPhone, Windows Hello, the screen lock of an
// Android phone.
//
// What it does: enrols the platform authenticator as one more envelope on the
// vault. The PRF extension answers a fixed per-vault salt with bytes that only
// exist after the person in front of the device has proven who they are; those
// bytes become the wrap key of a crypto.js raw wrapper (the one prepared in
// wave 1 for exactly this). Every unlock asks the hardware again.
//
// What it deliberately does NOT do: it stores no key material, anywhere. What
// goes into localStorage is two non-secret pointers - the credential id and the
// PRF salt. Neither is key-like: without the authenticator, and without the
// user verification it insists on, they derive nothing. The master key stays in
// memory exactly as before, and the PRF output is recomputed from the hardware
// on every single unlock rather than cached.
//
// It also holds no personal data: the credential's user handle is the fixed
// opaque string "tenfold", there is no name, no mail address, no account. There
// is no relying-party server either - the challenge is a fresh random value
// nobody verifies, because this is not an authentication handshake, it is a key
// derivation the authenticator gates behind a fingerprint. No fetch, no third
// party, no telemetry.

import {
  addRawKeyWrapper,
  removeWrapper,
  unlockWithRawKey,
  listWrappers,
  b64uEncode,
  b64uDecode,
} from "./crypto.js";

/** Where the two device-local pointers live. Nothing secret is written here. */
const PREF_KEY = "tenfold.webauthn";

/** Wrapper labels are per credential, so device A revoking its own enrolment
 *  cannot touch the wrapper device B added to the same (synced) vault. */
const LABEL_PREFIX = "webauthn:";
const LABEL_ID_CHARS = 12;

const SALT_BYTES = 32;
const CHALLENGE_BYTES = 32;
const RP_NAME = "tenfold";
/** A fixed opaque handle. The authenticator wants a user id; it does not get
 *  a real one, because this app has no accounts and knows no names. */
const USER_HANDLE = new TextEncoder().encode("tenfold");

/** ES256 first, RS256 as the fallback platforms without it still take. */
const ALGORITHMS = [
  { type: "public-key", alg: -7 },
  { type: "public-key", alg: -257 },
];

/**
 * Raised when this device cannot do PRF - no WebAuthn at all, no platform
 * authenticator, an authenticator that ignores the extension, or a prompt the
 * person dismissed. The caller treats all of these the same way: fall back to
 * the passphrase, quietly.
 */
export class WebAuthnUnavailableError extends Error {
  constructor(message) {
    super(message || "biometric unlock unavailable");
    this.name = "WebAuthnUnavailableError";
  }
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/* ------------------------------------------------------------- support checks */

/** The API surface exists. Says nothing about PRF - see the note on evaluate(). */
export function supported() {
  return (
    typeof PublicKeyCredential === "function" &&
    typeof navigator !== "undefined" &&
    !!navigator.credentials &&
    typeof navigator.credentials.create === "function" &&
    typeof navigator.credentials.get === "function"
  );
}

/** Last answer of the platform-authenticator probe: null until it was asked. */
let platformKnown = null;

/** Synchronous read of that answer, for a screen that must paint now. */
export function platformAvailableCached() {
  return platformKnown;
}

/**
 * Whether this device has a user-verifying platform authenticator - the one
 * question the platform will answer before any prompt is shown. Whether that
 * authenticator also does PRF is only knowable at create/get time, so the
 * settings row offers enrolment and reports honestly if it does not work.
 */
export async function platformAvailable() {
  if (!supported()) {
    platformKnown = false;
    return false;
  }
  if (platformKnown !== null) return platformKnown;
  try {
    platformKnown = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    platformKnown = false;
  }
  return platformKnown;
}

/* ---------------------------------------------------------------- pointers */

function readPointer() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || typeof p.credentialId !== "string" || typeof p.salt !== "string") return null;
    return { credentialId: p.credentialId, salt: p.salt };
  } catch {
    return null;
  }
}

function writePointer(pointer) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(pointer));
  } catch {
    // Storage disabled: the enrolment then cannot be found again on the next
    // start. The vault is untouched and the passphrase still opens it.
  }
}

/** Drop the local pointers. The wrapper in the vault is removed separately. */
export function forget() {
  try {
    localStorage.removeItem(PREF_KEY);
  } catch {
    // Nothing to do: no storage, no pointer.
  }
}

function labelFor(credentialId) {
  return LABEL_PREFIX + credentialId.slice(0, LABEL_ID_CHARS);
}

/** The wrapper label this device's credential owns, if there is one. */
export function wrapperLabel() {
  const p = readPointer();
  return p ? labelFor(p.credentialId) : null;
}

/**
 * True when this device holds a pointer AND the vault still carries the
 * matching wrapper. Both halves matter: an imported or adopted vault, or one
 * where another device revoked this credential, leaves a pointer that now
 * points at nothing - and the lock screen must not offer a button that cannot
 * work.
 */
export function enrolled(vault) {
  const label = wrapperLabel();
  if (!label || !vault) return false;
  try {
    return listWrappers(vault).some((w) => w.kind === "raw" && w.label === label);
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------- prf */

function prfFirst(results) {
  const prf = results && results.prf;
  const first = prf && prf.results && prf.results.first;
  if (!first) return null;
  const bytes = first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer || first);
  return bytes.length ? bytes : null;
}

/**
 * One fixed reduction from PRF output to wrap key, so enrolment and unlock can
 * never disagree about the shape. SHA-256 gives the 32 bytes a raw wrapper
 * takes whatever length an authenticator returned; crypto.js runs HKDF over it
 * again before anything is unwrapped.
 */
async function wrapKeyFrom(prfBytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", prfBytes));
}

/**
 * Ask the authenticator to evaluate the PRF for one salt. This is also the
 * unlock gesture: the platform shows its own prompt, and nothing comes back
 * before a fingerprint, a face or a device PIN.
 */
async function evaluate(credentialId, salt) {
  let assertion;
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(CHALLENGE_BYTES),
        allowCredentials: [
          { type: "public-key", id: b64uDecode(credentialId), transports: ["internal"] },
        ],
        userVerification: "required",
        extensions: { prf: { eval: { first: salt } } },
      },
    });
  } catch {
    // Cancelled, timed out, wrong device: one honest failure, no detail.
    throw new WebAuthnUnavailableError();
  }
  if (!assertion || typeof assertion.getClientExtensionResults !== "function") {
    throw new WebAuthnUnavailableError();
  }
  const bytes = prfFirst(assertion.getClientExtensionResults());
  if (!bytes) throw new WebAuthnUnavailableError();
  return bytes;
}

/* ------------------------------------------------------------------ enrol */

/**
 * Enrol this device. Requires the vault open, because a new envelope can only
 * be built by somebody who already holds the master key.
 *
 * @param {Object} vault
 * @param {CryptoKey} masterKey
 * @returns {Promise<Object>} the vault with one wrapper more - the caller saves it
 */
export async function enrol(vault, masterKey) {
  if (!supported()) throw new WebAuthnUnavailableError();
  if (!vault || !masterKey) throw new WebAuthnUnavailableError();

  const salt = randomBytes(SALT_BYTES);
  let created;
  try {
    created = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(CHALLENGE_BYTES),
        // No rp.id: it defaults to this origin, which is the only place this
        // credential is ever meant to work.
        rp: { name: RP_NAME },
        user: { id: USER_HANDLE, name: RP_NAME, displayName: RP_NAME },
        pubKeyCredParams: ALGORITHMS,
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          residentKey: "preferred",
          userVerification: "required",
        },
        attestation: "none",
        extensions: { prf: { eval: { first: salt } } },
      },
    });
  } catch {
    throw new WebAuthnUnavailableError();
  }
  if (!created || !created.rawId) throw new WebAuthnUnavailableError();

  const credentialId = b64uEncode(new Uint8Array(created.rawId));
  // Some platforms answer the PRF only on an assertion, not on creation. One
  // immediate get() settles it; if that is still empty the authenticator does
  // not do PRF and nothing is enrolled at all.
  let prfBytes = null;
  try {
    prfBytes = prfFirst(created.getClientExtensionResults());
  } catch {
    prfBytes = null;
  }
  if (!prfBytes) prfBytes = await evaluate(credentialId, salt);

  const wrapKey = await wrapKeyFrom(prfBytes);
  const label = labelFor(credentialId);
  let next = vault;
  // Re-enrolling the same credential (a cleared localStorage, a fresh salt)
  // replaces its envelope instead of colliding with it. Other devices' labels
  // are different, so theirs are untouched.
  if (listWrappers(vault).some((w) => w.label === label)) {
    next = await removeWrapper(next, label);
  }
  next = await addRawKeyWrapper(next, masterKey, wrapKey, label);
  writePointer({ credentialId, salt: b64uEncode(salt) });
  return next;
}

/**
 * The unlock itself: authenticator prompt, PRF, raw wrapper. Returns the master
 * key exactly as unlockWithPassphrase does, so the caller cannot tell - and
 * does not need to tell - which envelope opened the vault.
 *
 * @param {Object} vault
 * @returns {Promise<CryptoKey>}
 */
export async function unlock(vault) {
  if (!supported()) throw new WebAuthnUnavailableError();
  const p = readPointer();
  if (!p) throw new WebAuthnUnavailableError();
  const prfBytes = await evaluate(p.credentialId, b64uDecode(p.salt));
  return unlockWithRawKey(vault, await wrapKeyFrom(prfBytes));
}

/**
 * Remove this device's enrolment: the wrapper leaves the vault, the pointers
 * leave the device. Returns the vault to save; the caller does that, because
 * this module never touches storage beyond its own two pointers.
 */
export async function revoke(vault) {
  const label = wrapperLabel();
  forget();
  if (!label || !vault) return vault;
  try {
    return await removeWrapper(vault, label);
  } catch {
    // No such wrapper (already gone, or another device's vault): the pointer is
    // dropped either way, which is the part that mattered.
    return vault;
  }
}
