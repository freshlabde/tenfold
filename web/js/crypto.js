/**
 * tenfold - crypto core (zero knowledge envelope).
 *
 * What this file does:
 *   - Creates a vault: one random 256-bit master key that encrypts the document,
 *     stored several times over as independent "wrappers". Every wrapper alone
 *     can release the master key: a passphrase, a recovery key, or a raw 32-byte
 *     key (prepared for WebAuthn PRF / Face ID, which does not exist yet).
 *   - Seals and opens the document with AES-256-GCM, fresh 12-byte nonce per call.
 *   - Produces a JSON-serialisable VaultFile (binary parts base64url) so it fits
 *     into IndexedDB and into an export file unchanged.
 *
 * What this file deliberately does NOT do:
 *   - No network access of any kind, no telemetry, no key escrow.
 *   - No third-party library, no bundler, no polyfill: WebCrypto only.
 *   - No plaintext ever leaves this module except as the return value of open().
 *   - No password strength policy, no rate limiting, no persistence: that belongs
 *     to the UI and to store.js.
 *   - No signature over the vault. An attacker who can rewrite storage can replace
 *     the whole file; AEAD protects confidentiality and detects tampering, it does
 *     not prove authorship.
 */

export const MAGIC = "TENFOLD1";
export const VERSION = 1;

/** PBKDF2 work factor. Contractually fixed; readable from every vault header. */
export const PBKDF2_ITERATIONS = 600000;
export const PBKDF2_HASH = "SHA-256";

const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MASTER_KEY_BITS = 256;
const RAW_WRAP_KEY_BYTES = 32;

/** Payload framing: MAGIC(8) | version(1) | algorithm(1) | nonce(12) | ciphertext. */
const ALG_AES_256_GCM = 1;
const PAYLOAD_HEADER_BYTES = 10;

/**
 * Sanity bounds for a KDF parameter read back from a possibly hostile vault.
 * Too low would weaken the derivation, too high is a denial of service against
 * the owner's own browser. The AAD check catches tampering as well, but only
 * after the work has already been spent - so bound it first.
 */
const MIN_ITERATIONS = 100000;
const MAX_ITERATIONS = 5000000;

/**
 * Recovery key alphabet: base32-style, but with I, L, O, U, 0 and 1 removed
 * because they are misread when copied off paper. That leaves 30 symbols, not
 * 32, so the encoding is a uniform 30-symbol draw rather than a bit-exact
 * base32 of a byte string. 28 symbols carry 28 * log2(30) = 137.4 bits, which
 * clears the 128-bit floor; the six-group example in the spec would only carry
 * 117.8 bits, so seven groups are used.
 */
const RECOVERY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_GROUPS = 7;
const RECOVERY_GROUP_SIZE = 4;
const RECOVERY_SYMBOLS = RECOVERY_GROUPS * RECOVERY_GROUP_SIZE;

const KIND_PASSPHRASE = "passphrase";
const KIND_RECOVERY = "recovery";
const KIND_RAW = "raw";

const LABEL_PASSPHRASE = "passphrase";
const LABEL_RECOVERY = "recovery";

const RAW_HKDF_INFO = "tenfold/raw-wrap/v1";

const TEXT = new TextEncoder();
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/* ------------------------------------------------------------------ errors */

export class TenfoldCryptoError extends Error {
  constructor(message) {
    super(message);
    this.name = "TenfoldCryptoError";
  }
}

/**
 * Thrown whenever a secret fails to release the master key. The message is a
 * constant on purpose: it must not disclose which wrappers a vault contains,
 * otherwise the error itself tells an attacker whether a recovery key or a
 * device key is worth hunting for.
 */
export class VaultUnlockError extends TenfoldCryptoError {
  constructor() {
    super("vault unlock failed");
    this.name = "VaultUnlockError";
  }
}

/** Thrown when ciphertext, nonce or header do not survive the AEAD check. */
export class VaultIntegrityError extends TenfoldCryptoError {
  constructor(message) {
    super(message || "vault data failed integrity check");
    this.name = "VaultIntegrityError";
  }
}

/* ------------------------------------------------------------ byte helpers */

function randomBytes(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** Best-effort wipe. JavaScript cannot guarantee this, but leaving key-adjacent
 *  buffers populated for the garbage collector is worse than trying. */
function wipe(bytes) {
  if (bytes && typeof bytes.fill === "function") bytes.fill(0);
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TenfoldCryptoError("expected binary input");
}

function concatBytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function b64uEncode(input) {
  const bytes = toBytes(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(text) {
  if (typeof text !== "string") throw new TenfoldCryptoError("expected base64url string");
  const normalised = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new TenfoldCryptoError("malformed base64url string");
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/* -------------------------------------------------------------- recovery key */

/**
 * Draws RECOVERY_SYMBOLS symbols uniformly from a 30-symbol alphabet using
 * rejection sampling (256 is not a multiple of 30, so plain modulo would bias
 * the first ten symbols). Returned grouped with hyphens for transcription.
 */
export function generateRecoveryKey() {
  const limit = Math.floor(256 / RECOVERY_ALPHABET.length) * RECOVERY_ALPHABET.length;
  const symbols = [];
  while (symbols.length < RECOVERY_SYMBOLS) {
    const chunk = randomBytes(RECOVERY_SYMBOLS);
    for (let i = 0; i < chunk.length && symbols.length < RECOVERY_SYMBOLS; i += 1) {
      if (chunk[i] < limit) symbols.push(RECOVERY_ALPHABET[chunk[i] % RECOVERY_ALPHABET.length]);
    }
    wipe(chunk);
  }
  const groups = [];
  for (let i = 0; i < RECOVERY_SYMBOLS; i += RECOVERY_GROUP_SIZE) {
    groups.push(symbols.slice(i, i + RECOVERY_GROUP_SIZE).join(""));
  }
  return groups.join("-");
}

/**
 * Accepts what a human actually types: lower case, no hyphens, stray spaces,
 * non-breaking spaces from a copy/paste. Confusable characters are NOT silently
 * remapped - none of them exist in the alphabet, so a remap would be a guess
 * about intent and could turn a typo into a different valid-looking key.
 */
export function normaliseRecoveryKey(text) {
  if (typeof text !== "string") throw new VaultUnlockError();
  // Drop everything that is not a letter or a digit: hyphens, spaces of every
  // width, dots, invisible characters pasted from a PDF.
  const cleaned = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== RECOVERY_SYMBOLS) throw new VaultUnlockError();
  for (const ch of cleaned) {
    if (!RECOVERY_ALPHABET.includes(ch)) throw new VaultUnlockError();
  }
  return cleaned;
}

/** Human-readable form of a normalised key. */
export function formatRecoveryKey(text) {
  const cleaned = normaliseRecoveryKey(text);
  const groups = [];
  for (let i = 0; i < cleaned.length; i += RECOVERY_GROUP_SIZE) {
    groups.push(cleaned.slice(i, i + RECOVERY_GROUP_SIZE));
  }
  return groups.join("-");
}

/* --------------------------------------------------------------- key schedule */

function assertKdfSane(kdf) {
  if (!kdf || typeof kdf !== "object") throw new VaultUnlockError();
  if (kdf.hash !== PBKDF2_HASH && kdf.hash !== "SHA-512") throw new VaultUnlockError();
  if (kdf.name === "PBKDF2") {
    const it = kdf.iterations;
    if (!Number.isSafeInteger(it) || it < MIN_ITERATIONS || it > MAX_ITERATIONS) {
      throw new VaultUnlockError();
    }
  } else if (kdf.name !== "HKDF") {
    throw new VaultUnlockError();
  }
}

async function derivePbkdf2Kek(secret, kdf) {
  const secretBytes = TEXT.encode(secret);
  const base = await crypto.subtle.importKey("raw", secretBytes, "PBKDF2", false, ["deriveKey"]);
  wipe(secretBytes);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: kdf.hash, salt: b64uDecode(kdf.salt), iterations: kdf.iterations },
    base,
    { name: "AES-GCM", length: MASTER_KEY_BITS },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

async function deriveHkdfKek(rawKeyBytes, kdf) {
  const base = await crypto.subtle.importKey("raw", rawKeyBytes, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: kdf.hash,
      salt: b64uDecode(kdf.salt),
      info: TEXT.encode(kdf.info || RAW_HKDF_INFO),
    },
    base,
    { name: "AES-GCM", length: MASTER_KEY_BITS },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

/**
 * Spends the same PBKDF2 budget as a real attempt when no wrapper of the
 * requested kind exists. Without it, "no recovery wrapper" would answer in
 * milliseconds and "wrong recovery key" in half a second - which is exactly the
 * disclosure the constant error message is meant to prevent.
 */
async function decoyDerive() {
  await derivePbkdf2Kek("decoy", {
    name: "PBKDF2",
    hash: PBKDF2_HASH,
    iterations: PBKDF2_ITERATIONS,
    salt: b64uEncode(randomBytes(SALT_BYTES)),
  });
}

/* ------------------------------------------------------------------- vault */

function newPbkdf2Kdf() {
  return {
    name: "PBKDF2",
    hash: PBKDF2_HASH,
    iterations: PBKDF2_ITERATIONS,
    salt: b64uEncode(randomBytes(SALT_BYTES)),
  };
}

function newHkdfKdf() {
  return {
    name: "HKDF",
    hash: PBKDF2_HASH,
    salt: b64uEncode(randomBytes(SALT_BYTES)),
    info: RAW_HKDF_INFO,
  };
}

/** Deterministic serialisation of a KDF description, independent of key order
 *  after a JSON round trip through IndexedDB or an export file. */
function canonicalKdf(kdf) {
  if (!kdf || typeof kdf !== "object") throw new VaultUnlockError();
  if (kdf.name === "PBKDF2") {
    return { name: "PBKDF2", hash: kdf.hash, iterations: kdf.iterations, salt: kdf.salt };
  }
  if (kdf.name === "HKDF") {
    return { name: "HKDF", hash: kdf.hash, salt: kdf.salt, info: kdf.info };
  }
  throw new VaultUnlockError();
}

/**
 * Additional authenticated data for one wrapper: magic, version and the
 * wrapper's own metadata without its ciphertext. Bound this way, lowering the
 * iteration count, swapping a salt, relabelling a wrapper or changing its kind
 * all fail the GCM tag instead of silently producing a weaker vault.
 *
 * Scope is per wrapper on purpose. If the AAD covered the whole wrapper list,
 * adding a Face ID wrapper would invalidate the passphrase wrapper, because
 * re-wrapping it would require the passphrase - which we do not have at that
 * moment.
 */
function wrapperAad(magic, version, meta) {
  return TEXT.encode(
    JSON.stringify({
      magic,
      version,
      wrapper: {
        id: meta.id,
        kind: meta.kind,
        label: meta.label,
        kdf: canonicalKdf(meta.kdf),
        nonce: meta.nonce,
      },
    }),
  );
}

async function buildWrapper(masterKey, kek, { kind, label, kdf, magic, version }) {
  const nonce = randomBytes(NONCE_BYTES);
  const meta = { id: crypto.randomUUID(), kind, label, kdf, nonce: b64uEncode(nonce) };
  const aad = wrapperAad(magic, version, meta);
  const ct = await crypto.subtle.wrapKey("raw", masterKey, kek, {
    name: "AES-GCM",
    iv: nonce,
    additionalData: aad,
  });
  return { ...meta, ct: b64uEncode(new Uint8Array(ct)) };
}

async function unwrapWith(vault, wrapper, kek) {
  const aad = wrapperAad(vault.magic, vault.version, wrapper);
  return crypto.subtle.unwrapKey(
    "raw",
    b64uDecode(wrapper.ct),
    kek,
    { name: "AES-GCM", iv: b64uDecode(wrapper.nonce), additionalData: aad },
    { name: "AES-GCM", length: MASTER_KEY_BITS },
    // Extractable: the master key has to be re-wrappable later (adding a Face ID
    // wrapper, rotating). It never leaves this module in raw form regardless.
    true,
    ["encrypt", "decrypt"],
  );
}

function assertVault(vault) {
  if (!vault || typeof vault !== "object") throw new VaultIntegrityError("not a vault");
  if (vault.magic !== MAGIC) throw new VaultIntegrityError("unknown vault format");
  if (vault.version !== VERSION) throw new VaultIntegrityError("unsupported vault version");
  if (!Array.isArray(vault.wrappers)) throw new VaultIntegrityError("vault has no wrappers");
  return vault;
}

function cloneVault(vault) {
  // JSON round trip, not structuredClone: it also proves the vault is still
  // JSON-serialisable, which is a contract requirement for export and IndexedDB.
  return JSON.parse(JSON.stringify(vault));
}

function emptyDoc() {
  return { schema: 1, nodes: [], settings: {} };
}

async function generateMasterKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: MASTER_KEY_BITS }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/* ------------------------------------------------------------- public: vault */

/**
 * Creates a fresh vault: random 256-bit master key, a passphrase wrapper and a
 * recovery wrapper, plus an already sealed empty document so a new vault is
 * never in a half-initialised state.
 *
 * Returns the master key as well (additive to the contract) so the caller does
 * not have to run 600000 PBKDF2 rounds again just to use the vault it created.
 */
export async function createVault({ passphrase }) {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new TenfoldCryptoError("passphrase required");
  }
  const masterKey = await generateMasterKey();
  const recoveryKey = generateRecoveryKey();

  const passKdf = newPbkdf2Kdf();
  const recKdf = newPbkdf2Kdf();
  const [passKek, recKek] = await Promise.all([
    derivePbkdf2Kek(passphrase, passKdf),
    derivePbkdf2Kek(normaliseRecoveryKey(recoveryKey), recKdf),
  ]);

  const wrappers = [
    await buildWrapper(masterKey, passKek, {
      kind: KIND_PASSPHRASE,
      label: LABEL_PASSPHRASE,
      kdf: passKdf,
      magic: MAGIC,
      version: VERSION,
    }),
    await buildWrapper(masterKey, recKek, {
      kind: KIND_RECOVERY,
      label: LABEL_RECOVERY,
      kdf: recKdf,
      magic: MAGIC,
      version: VERSION,
    }),
  ];

  const vault = { magic: MAGIC, version: VERSION, wrappers, payload: null };
  vault.payload = payloadFromBlob(await seal(masterKey, emptyDoc()));
  return { vault, recoveryKey, masterKey };
}

async function unlockWithKind(vault, kind, kekFor) {
  assertVault(vault);
  const candidates = vault.wrappers.filter((w) => w && w.kind === kind);
  if (candidates.length === 0) {
    await decoyDerive();
    throw new VaultUnlockError();
  }
  for (const wrapper of candidates) {
    try {
      assertKdfSane(wrapper.kdf);
      const kek = await kekFor(wrapper);
      return await unwrapWith(vault, wrapper, kek);
    } catch {
      // Keep trying the remaining wrappers of this kind; never report which one
      // was reached or why it failed.
    }
  }
  throw new VaultUnlockError();
}

export async function unlockWithPassphrase(vault, passphrase) {
  if (typeof passphrase !== "string" || passphrase.length === 0) throw new VaultUnlockError();
  return unlockWithKind(vault, KIND_PASSPHRASE, (w) => derivePbkdf2Kek(passphrase, w.kdf));
}

export async function unlockWithRecoveryKey(vault, recoveryKey) {
  let normalised;
  try {
    normalised = normaliseRecoveryKey(recoveryKey);
  } catch {
    // Malformed input still costs one derivation, so "wrong shape" and "wrong
    // key" are not distinguishable by response time.
    await decoyDerive();
    throw new VaultUnlockError();
  }
  return unlockWithKind(vault, KIND_RECOVERY, (w) => derivePbkdf2Kek(normalised, w.kdf));
}

/** For WebAuthn PRF output (Face ID) or any other externally held 32-byte key. */
export async function unlockWithRawKey(vault, wrapKey) {
  let raw;
  try {
    raw = toBytes(wrapKey);
  } catch {
    throw new VaultUnlockError();
  }
  if (raw.length !== RAW_WRAP_KEY_BYTES) throw new VaultUnlockError();
  return unlockWithKind(vault, KIND_RAW, (w) => deriveHkdfKek(raw, w.kdf));
}

function labelMatches(wrapper, label) {
  return wrapper.label === label || `${wrapper.kind}:${wrapper.label}` === label;
}

/**
 * Adds a raw-key wrapper, for example after a WebAuthn PRF enrolment on a new
 * device. Requires an already unlocked master key - a wrapper can only be
 * created by someone who already holds the secret.
 */
export async function addRawKeyWrapper(vault, masterKey, wrapKey, label) {
  assertVault(vault);
  if (typeof label !== "string" || label.trim().length === 0) {
    throw new TenfoldCryptoError("wrapper label required");
  }
  const raw = toBytes(wrapKey);
  if (raw.length !== RAW_WRAP_KEY_BYTES) {
    throw new TenfoldCryptoError("raw wrap key must be 32 bytes");
  }
  const next = cloneVault(vault);
  if (next.wrappers.some((w) => labelMatches(w, label))) {
    throw new TenfoldCryptoError("wrapper label already in use");
  }
  const kdf = newHkdfKdf();
  const kek = await deriveHkdfKek(raw, kdf);
  next.wrappers.push(
    await buildWrapper(masterKey, kek, {
      kind: KIND_RAW,
      label,
      kdf,
      magic: next.magic,
      version: next.version,
    }),
  );
  return next;
}

/** Revokes one wrapper (a lost device, a burnt recovery sheet). Refuses to
 *  remove the last one - a vault nobody can open is data loss, not security. */
export async function removeWrapper(vault, label) {
  assertVault(vault);
  const next = cloneVault(vault);
  const keep = next.wrappers.filter((w) => !labelMatches(w, label));
  if (keep.length === next.wrappers.length) {
    throw new TenfoldCryptoError("wrapper not found");
  }
  if (keep.length === 0) {
    throw new TenfoldCryptoError("refusing to remove the last wrapper");
  }
  next.wrappers = keep;
  return next;
}

/** Wrapper metadata for the UI. Never returns ciphertext or salts. */
export function listWrappers(vault) {
  assertVault(vault);
  return vault.wrappers.map((w) => ({ id: w.id, kind: w.kind, label: w.label }));
}

/* ----------------------------------------------------------- public: content */

/**
 * Encrypts the document. AES-256-GCM with a freshly drawn 12-byte nonce.
 *
 * NONCE DISCIPLINE - this is not a style rule, it is the whole guarantee:
 * AES-GCM builds its keystream from key and nonce alone. Encrypt two different
 * documents with the same key and the same nonce and the XOR of the two
 * ciphertexts is the XOR of the two plaintexts - anyone holding both blobs
 * reads the difference without any key. Worse, the pair leaks the GHASH
 * authentication subkey, which lets an attacker forge blobs that decrypt
 * cleanly. A vault is saved after every keystroke-sized edit, so the same key
 * encrypts thousands of near-identical documents; reusing a nonce even once is
 * unrecoverable. Therefore: one fresh random nonce per seal() call, never
 * derived from a counter that a restored backup could rewind.
 */
export async function seal(masterKey, doc) {
  if (doc === undefined || doc === null || typeof doc !== "object") {
    throw new TenfoldCryptoError("document must be an object");
  }
  const header = new Uint8Array(PAYLOAD_HEADER_BYTES);
  header.set(TEXT.encode(MAGIC), 0);
  header[8] = VERSION;
  header[9] = ALG_AES_256_GCM;

  const nonce = randomBytes(NONCE_BYTES);
  const plaintext = TEXT.encode(JSON.stringify(doc));
  let ct;
  try {
    ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: header },
      masterKey,
      plaintext,
    );
  } finally {
    wipe(plaintext);
  }
  return concatBytes(header, nonce, new Uint8Array(ct));
}

/**
 * Decrypts a blob produced by seal(). Returns the document only after the GCM
 * tag has verified - WebCrypto releases nothing on a failed tag, so a partial
 * or malleable plaintext cannot escape this function.
 */
export async function open(masterKey, blob) {
  let bytes;
  try {
    bytes = toBytes(blob);
  } catch {
    throw new VaultIntegrityError("payload is not binary");
  }
  if (bytes.length < PAYLOAD_HEADER_BYTES + NONCE_BYTES + GCM_TAG_BYTES) {
    throw new VaultIntegrityError("payload truncated");
  }
  const header = bytes.subarray(0, PAYLOAD_HEADER_BYTES);
  if (!timingSafeEqual(header.subarray(0, 8), TEXT.encode(MAGIC))) {
    throw new VaultIntegrityError("unknown payload format");
  }
  if (header[8] !== VERSION) throw new VaultIntegrityError("unsupported payload version");
  if (header[9] !== ALG_AES_256_GCM) throw new VaultIntegrityError("unsupported payload cipher");

  const nonce = bytes.subarray(PAYLOAD_HEADER_BYTES, PAYLOAD_HEADER_BYTES + NONCE_BYTES);
  const ct = bytes.subarray(PAYLOAD_HEADER_BYTES + NONCE_BYTES);

  let plaintext;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: header },
        masterKey,
        ct,
      ),
    );
  } catch {
    throw new VaultIntegrityError("payload failed authentication");
  }
  try {
    return JSON.parse(UTF8.decode(plaintext));
  } catch {
    throw new VaultIntegrityError("payload is not a valid document");
  } finally {
    wipe(plaintext);
  }
}

/** Splits a seal() blob into the stored {nonce, ct} form. */
function payloadFromBlob(blob) {
  const bytes = toBytes(blob);
  return {
    nonce: b64uEncode(bytes.subarray(PAYLOAD_HEADER_BYTES, PAYLOAD_HEADER_BYTES + NONCE_BYTES)),
    ct: b64uEncode(bytes.subarray(PAYLOAD_HEADER_BYTES + NONCE_BYTES)),
  };
}

/** Rebuilds the seal() blob from the stored {nonce, ct} form. */
function blobFromPayload(vault) {
  if (!vault.payload || typeof vault.payload !== "object") {
    throw new VaultIntegrityError("vault has no payload");
  }
  const header = new Uint8Array(PAYLOAD_HEADER_BYTES);
  header.set(TEXT.encode(vault.magic), 0);
  header[8] = vault.version;
  header[9] = ALG_AES_256_GCM;
  return concatBytes(header, b64uDecode(vault.payload.nonce), b64uDecode(vault.payload.ct));
}

/**
 * Convenience pair around seal()/open() for the stored form. store.js persists a
 * VaultFile, so the sealed document has to live inside it; these two keep that
 * framing in one place instead of spreading it over app code.
 */
export async function sealIntoVault(vault, masterKey, doc) {
  assertVault(vault);
  const next = cloneVault(vault);
  next.payload = payloadFromBlob(await seal(masterKey, doc));
  return next;
}

export async function openFromVault(vault, masterKey) {
  assertVault(vault);
  return open(masterKey, blobFromPayload(vault));
}

/* ------------------------------------------------------------ public: rotate */

/**
 * Rotates the master key after a device loss: new random master key, document
 * re-encrypted under it, passphrase and recovery wrappers rebuilt from scratch
 * with fresh salts and a fresh recovery key.
 *
 * Every raw wrapper is dropped. That is the point of the operation - a stolen
 * phone still holds a WebAuthn PRF secret, and only re-enrolment on a device
 * the owner still controls can restore access. Keeping them would rotate
 * nothing.
 */
export async function rotateMasterKey(vault, oldMasterKey, { passphrase }) {
  assertVault(vault);
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new TenfoldCryptoError("passphrase required");
  }
  const doc = vault.payload ? await openFromVault(vault, oldMasterKey) : emptyDoc();

  const masterKey = await generateMasterKey();
  const recoveryKey = generateRecoveryKey();
  const passKdf = newPbkdf2Kdf();
  const recKdf = newPbkdf2Kdf();
  const [passKek, recKek] = await Promise.all([
    derivePbkdf2Kek(passphrase, passKdf),
    derivePbkdf2Kek(normaliseRecoveryKey(recoveryKey), recKdf),
  ]);

  const next = {
    magic: MAGIC,
    version: VERSION,
    wrappers: [
      await buildWrapper(masterKey, passKek, {
        kind: KIND_PASSPHRASE,
        label: LABEL_PASSPHRASE,
        kdf: passKdf,
        magic: MAGIC,
        version: VERSION,
      }),
      await buildWrapper(masterKey, recKek, {
        kind: KIND_RECOVERY,
        label: LABEL_RECOVERY,
        kdf: recKdf,
        magic: MAGIC,
        version: VERSION,
      }),
    ],
    payload: null,
  };
  next.payload = payloadFromBlob(await seal(masterKey, doc));
  return { vault: next, recoveryKey, masterKey };
}
