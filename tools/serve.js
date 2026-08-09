// Static server for the tenfold PWA plus the ciphertext mailbox the sync
// feature talks to. Deliberately tiny: no dependencies, no directory listing,
// no accounts, no sessions.
//
// Path resolution: the app in web/ is served at the root (so the PWA gets
// scope "/" on the public domain). Repo paths like /tests/... and /design/...
// still resolve as a fallback so the Playwright suite and the design previews
// keep working unchanged.
//
// THE MAILBOX RULE - the whole reason this file may be deployed at all:
// this server stores an opaque blob, a version counter and the SHA-256 hash of
// an auth token. It has no key, no passphrase, no cipher, no decrypt path, and
// it never merges anything, because it cannot read what it holds. The only
// hashing that happens here is the one-way digest of the write token; that is
// a comparison aid, not cryptography over user data. If a future change makes
// this server able to read a vault, the design is broken, not improved.
//
// THE COUNTERPART OF THE RULE: what this server holds, it must also be able to
// let go of. DELETE /api/vault/<syncId> removes the whole id directory and
// leaves nothing behind - no tombstone, no marker, no record that the id ever
// existed. Deletion here is destruction, not a flag; a mailbox that could only
// ever grow would be a worse promise than not offering one.
//
// THE ONE EXCEPTION, AND WHAT IT IS NOT: the push feature below owns an ECDSA
// P-256 key pair (VAPID). Read this before you take it as a hole in the rule:
//   - It exists to SIGN a short JWT that proves to a push service which server
//     is asking. It is an identity signature, nothing else.
//   - It is a SIGNING key. It has no decryption capability - not for a vault,
//     not for a push message, not for anything. ECDSA cannot decrypt.
//   - The pushes this server sends carry NO payload, so there is not even a
//     message that could be encrypted or read. The service worker shows one
//     fixed sentence out of its own catalogue.
//   - Nothing that belongs to a user is signed with it: the JWT contains an
//     audience, an expiry and a contact address.
// If a future change gives this key material anything to do with vault data,
// the design is broken, not improved.
//
// THE SECOND EXCEPTION - THE MODEL RELAY, AND WHAT IT IS NOT: /api/llm below
// hands a request on to a language model and hands the answer back. Read this
// before you take it as a hole in the rule either:
//   - It is a PIPE, not a store. Nothing that passes through is written to
//     disk, kept in memory past the request, counted, or logged - not the
//     messages, not the key, not the answer, not who asked.
//   - It exists only because a browser cannot reach most providers directly
//     (CORS) and because a phone outside the flat cannot reach a model on the
//     home network.
//   - It is NOT an open proxy. The target must be on the built-in cloud host
//     list (https only) or match an operator-configured upstream exactly.
//     Anything else is refused before a socket is opened. Redirects are never
//     followed, no header of the caller is passed on, and only four fields of
//     the body travel. That allowlist is the SSRF wall; widening it to "any
//     URL the client sends" is never an improvement.
//   - It adds NO cryptography. It forwards a key it does not keep and cannot
//     use for anything else. The drift guard in tests/sync.spec.js pins the
//     complete list of WebCrypto operations this file may perform, and the
//     relay is not on it.
// If a future change makes this relay remember a single message, the design is
// broken, not improved.
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { homedir } from "node:os";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const WEB = join(ROOT, "web");
const PORT = Number(process.env.PORT || 7710);

/**
 * Where the blobs live. Never inside the repository: a data directory under
 * the checkout would end up in a backup, a container image or a git status
 * sooner or later.
 */
const DATA_DIR = process.env.TENFOLD_DATA || join(homedir(), ".tenfold-data");
const VAULT_DIR = join(DATA_DIR, "vaults");

// ------------------------------------------------------------------- push
/** The VAPID pair, generated once and then read from here. Never leaves. */
const VAPID_FILE = join(DATA_DIR, "vapid.json");
/** How long the push service may hold a signal that could not be delivered. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;
/** Subscriptions per vault. Five devices is generous for one person. */
const MAX_SUBS_PER_ID = 5;
/** A subscribe body is a URL and a number - kilobytes, not megabytes. */
const MAX_PUSH_BODY_BYTES = 16 * 1024;
/** The dispatch loop wakes this often and sends whatever is due. */
const DISPATCH_INTERVAL_MS = 5 * 60 * 1000;
/**
 * The contact address in the VAPID claim. Push services want to know whom to
 * complain to; it is operator data, never user data.
 */
const PUSH_SUBJECT = process.env.TENFOLD_PUSH_SUBJECT || "mailto:tenfold@localhost";
/**
 * Test hook only: allows a plain-http push endpoint so the suite can point a
 * subscription at a local sink and read the Authorization header back. Off
 * unless the environment says otherwise - a public server must never accept
 * an arbitrary http endpoint, that would be a request forwarder.
 */
const ALLOW_INSECURE_PUSH = process.env.TENFOLD_PUSH_ALLOW_INSECURE === "1";

// -------------------------------------------------------------- model relay
/**
 * The built-in cloud allowlist. Hosts, not URLs: a provider moves its path
 * around ("/v1", "/api/v1", "/openai/v1") and the host is the part that says
 * who is being talked to. https only - a plain-http cloud target would send an
 * API key across the wire in the open.
 */
const LLM_CLOUD_HOSTS = new Set([
  "api.openai.com",
  "api.anthropic.com",
  "openrouter.ai",
  "api.mistral.ai",
  "api.groq.com",
]);

/**
 * Local upstreams the operator allows, comma separated, matched EXACTLY as
 * base URLs (e.g. "http://127.0.0.1:1234/v1"). Not a host list: on a home
 * network an approximate match would let a caller aim the server at any port
 * of any machine on that network.
 */
const LLM_LOCAL_UPSTREAMS = String(process.env.TENFOLD_LLM_UPSTREAMS || "")
  .split(",")
  .map((value) => value.trim().replace(/\/+$/, ""))
  .filter(Boolean);

/** A prompt is kilobytes of text. One megabyte is already generous. */
const MAX_LLM_BODY_BYTES = 1024 * 1024;

/** Except when a photograph travels with it: a resized JPEG as a data URL. */
const MAX_LLM_IMAGE_BODY_BYTES = 8 * 1024 * 1024;

/** What may come back. A completion that needs more than this is not one. */
const MAX_LLM_RESPONSE_BYTES = 1024 * 1024;

/** A slow local model on a laptop is normal; two minutes is the ceiling. */
const LLM_TIMEOUT_MS = 120 * 1000;

/** How long the set of known write-token hashes may be reused. */
const TOKEN_CACHE_MS = 30 * 1000;

/** Floor between two rescans caused by a token that is not in the cache. */
const TOKEN_RESCAN_MS = 2 * 1000;

/** A sync id is 26 symbols of a confusable-free base32 alphabet, lower case. */
const SYNC_ID_RE = /^[a-z0-9]{26}$/;

/** Hard cap per blob. A tenfold document is kilobytes; 4 MB is generous. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** How many records are kept per id, current one included. */
const MAX_VERSIONS = 10;

// ------------------------------------------------------- abuse limits
// The mailbox is publicly reachable through the tunnel. Everything here is
// in-memory and forgets on restart - good enough to stop a disk-filling
// loop, deliberately not user tracking (no IP is ever written to disk).
const MAX_VAULTS_TOTAL = Number(process.env.TENFOLD_MAX_VAULTS || 500);
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_PER_WINDOW = 60; // API requests per IP per minute
const CREATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CREATE_MAX_PER_WINDOW = 10; // brand-new vault ids per IP per day

const rateHits = new Map(); // ip -> number[] timestamps
const createHits = new Map(); // ip -> number[] timestamps
let vaultCount = null; // lazy: counted once, then maintained

function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0 && cf.length < 64) return cf;
  return req.socket.remoteAddress || "unknown";
}

/**
 * Local requests are exempt from the abuse limits. The server binds to
 * 127.0.0.1 only; the single way in from outside is the Cloudflare tunnel,
 * and the tunnel always sets cf-connecting-ip. So loopback WITHOUT that
 * header is by construction this machine (dev server, test suite).
 */
function isLocal(req) {
  if (req.headers["cf-connecting-ip"]) return false;
  const a = req.socket.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function overLimit(map, key, windowMs, max) {
  const now = Date.now();
  const hits = (map.get(key) || []).filter((ts) => now - ts < windowMs);
  if (hits.length >= max) {
    map.set(key, hits);
    return true;
  }
  hits.push(now);
  map.set(key, hits);
  // Opportunistic cleanup so the maps cannot grow without bound.
  if (map.size > 10000) {
    for (const [k, v] of map) if (v.every((ts) => now - ts >= windowMs)) map.delete(k);
  }
  return false;
}

async function countVaults() {
  if (vaultCount !== null) return vaultCount;
  try {
    vaultCount = (await readdir(VAULT_DIR)).length;
  } catch {
    vaultCount = 0;
  }
  return vaultCount;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

const SECURITY_HEADERS = {
  // Strict CSP: own origin only. No external source can ever load, which is
  // one of the walls against the XSS-equals-total-loss scenario.
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const API_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function sendJson(res, status, payload) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  res.writeHead(status, { ...API_HEADERS, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

/** An answer that is only a status code - 204 must not carry a body. */
function sendEmpty(res, status) {
  const { "Content-Type": _type, ...headers } = API_HEADERS;
  res.writeHead(status, headers);
  res.end();
}

/**
 * One-way digest of the write token. The token itself is never written to
 * disk, never logged and never returned - only this hash is stored, so a
 * stolen data directory does not hand out write access.
 */
async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", Buffer.from(text, "utf8"));
  return Buffer.from(digest).toString("hex");
}

/** Fixed-time comparison of two hex strings, so a mismatch leaks no position. */
function sameHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Reads a request body with a hard byte cap; oversize requests are cut off. */
async function readBody(req, limit) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) return { tooLarge: true };
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.destroy();
      return { tooLarge: true };
    }
    chunks.push(chunk);
  }
  return { body: Buffer.concat(chunks) };
}

// Writes to one id are serialised. Node runs one request at a time, but every
// await is a yield point: without this chain two PUTs could both read version
// 7 and both write version 8.
const writeChains = new Map();

function withIdLock(id, fn) {
  const previous = writeChains.get(id) || Promise.resolve();
  const next = previous.then(fn, fn);
  writeChains.set(
    id,
    next.then(
      () => {
        if (writeChains.get(id) === next) writeChains.delete(id);
      },
      () => {
        if (writeChains.get(id) === next) writeChains.delete(id);
      },
    ),
  );
  return next;
}

function recordDir(id) {
  return join(VAULT_DIR, id);
}

async function readRecord(id) {
  try {
    return JSON.parse(await readFile(join(recordDir(id), "current.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Atomic write: a temporary file in the same directory, then a rename. A
 * process killed mid-write leaves the previous record intact - a half written
 * vault would be unrecoverable, because nobody here can repair ciphertext.
 */
async function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
}

/** Keeps the newest MAX_VERSIONS - 1 previous records, drops the rest. */
async function pruneHistory(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const versions = entries
    .filter((name) => /^v\d+\.json$/.test(name))
    .map((name) => ({ name, n: Number(name.slice(1, -5)) }))
    .sort((a, b) => b.n - a.n);
  for (const old of versions.slice(MAX_VERSIONS - 1)) {
    await unlink(join(dir, old.name)).catch(() => {});
  }
}

async function handleGetVault(res, id) {
  const record = await readRecord(id);
  if (!record) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  // Read is a capability: knowing the id is enough, because the answer is
  // ciphertext. The stored token hash stays here.
  sendJson(res, 200, { version: record.version, vault: record.vault });
}

async function handlePutVault(req, res, id) {
  const token = req.headers["x-sync-token"];
  const ifVersionRaw = req.headers["x-if-version"];
  const read = await readBody(req, MAX_BODY_BYTES);
  if (read.tooLarge) {
    sendJson(res, 413, { error: "too large" });
    return;
  }
  if (typeof token !== "string" || token.length < 16 || token.length > 512) {
    sendJson(res, 401, { error: "unauthorised" });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(read.body.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "bad request" });
    return;
  }
  if (!payload || typeof payload.vault !== "object" || payload.vault === null) {
    sendJson(res, 400, { error: "bad request" });
    return;
  }
  const ifVersion = Number(ifVersionRaw);
  const expected = Number.isSafeInteger(ifVersion) && ifVersion >= 0 ? ifVersion : 0;
  const tokenHash = await sha256Hex(token);

  await withIdLock(id, async () => {
    const record = await readRecord(id);
    if (record && !sameHex(record.tokenHash, tokenHash)) {
      sendJson(res, 401, { error: "unauthorised" });
      return;
    }
    if (!record && !isLocal(req)) {
      // A brand-new mailbox: capped per IP and globally, so a loop cannot
      // fill the disk with fresh ids. Existing vaults are never affected.
      if (overLimit(createHits, clientIp(req), CREATE_WINDOW_MS, CREATE_MAX_PER_WINDOW)) {
        sendJson(res, 429, { error: "slow down" });
        return;
      }
      if ((await countVaults()) >= MAX_VAULTS_TOTAL) {
        sendJson(res, 507, { error: "storage full" });
        return;
      }
      vaultCount = (vaultCount || 0) + 1;
    }
    const currentVersion = record ? record.version : 0;
    if (expected !== currentVersion) {
      // The client merges. This server holds no key, so it could only pick a
      // winner and throw the other side away - which is data loss, not sync.
      sendJson(res, 409, { version: currentVersion, vault: record ? record.vault : null });
      return;
    }
    const dir = recordDir(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const next = {
      version: currentVersion + 1,
      tokenHash: record ? record.tokenHash : tokenHash,
      updatedAt: Date.now(),
      vault: payload.vault,
    };
    if (record) await writeAtomic(join(dir, `v${record.version}.json`), JSON.stringify(record));
    await writeAtomic(join(dir, "current.json"), JSON.stringify(next));
    await pruneHistory(dir);
    sendJson(res, 200, { version: next.version });
  });
}

/**
 * DELETE - the one operation that destroys instead of storing.
 *
 * THE LOOPBACK EXEMPTION DOES NOT APPLY HERE. Everywhere else in this file a
 * local caller is trusted: it is this machine, it could read the data
 * directory with its own hands, and trusting it costs nothing. Destruction is
 * the opposite case. A stray script on this machine - a half-written cron job,
 * a test pointed at the wrong port, anything that can open a socket to
 * 127.0.0.1 - must not be able to destroy what it cannot open. The key-derived
 * write token is the proof that the caller is a device that holds the vault,
 * and that proof is required from every caller, local or not.
 *
 * What goes is the WHOLE id directory: the current record, every history
 * version, and the push subscriptions stored beside them. It is renamed out of
 * the way first and then removed, so a half-deleted record cannot be served to
 * anybody in between. Nothing is left behind - no tombstone, no marker, no
 * "this id existed" file. The id is simply free again afterwards, and the next
 * PUT registers a new token hash exactly as a brand-new mailbox would.
 */
async function handleDeleteVault(req, res, id) {
  const token = req.headers["x-sync-token"];
  const tokenHash =
    typeof token === "string" && token.length >= 16 && token.length <= 512 ? await sha256Hex(token) : null;

  await withIdLock(id, async () => {
    const record = await readRecord(id);
    if (!record) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (!tokenHash || !sameHex(record.tokenHash, tokenHash)) {
      sendJson(res, 401, { error: "unauthorised" });
      return;
    }
    // Out of the vault directory first: a name that is not id-shaped would
    // otherwise sit there while the removal runs, and everything that walks
    // this directory expects id-shaped entries only.
    const parked = join(DATA_DIR, `gone-${id}-${Math.random().toString(36).slice(2, 10)}`);
    try {
      await rename(recordDir(id), parked);
    } catch {
      sendJson(res, 500, { error: "server error" });
      return;
    }
    await rm(parked, { recursive: true, force: true }).catch(() => {});
    if (vaultCount !== null) vaultCount = Math.max(0, vaultCount - 1);
    // The relay's cache of known write tokens may still vouch for the one that
    // just lost its vault. Drop it, so the next relayed request rescans.
    tokenCache = { at: 0, hashes: [] };
    sendEmpty(res, 204);
  });
}

// ---------------------------------------------------------------- web push
//
// Everything from here to the router is the reminder feature. It stores a push
// endpoint and an hour, and once a day it pokes the push service with an
// EMPTY signal. No title, no count, no node, no text - the service worker owns
// the one sentence the user sees, in its own language catalogue.

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

/** The UTC calendar day as YYYYMMDD - the "did this already go out" marker. */
function utcDayKey(ts) {
  const d = new Date(ts);
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/**
 * The VAPID pair. Generated on first use, then read from disk. The private
 * half never leaves this process: it is loaded non-extractable, is only ever
 * handed to a signature over a JWT header, and it is not a decryption key -
 * ECDSA has no such operation.
 */
let vapidPromise = null;

async function loadOrCreateVapid() {
  const params = { name: "ECDSA", namedCurve: "P-256" };
  try {
    const stored = JSON.parse(await readFile(VAPID_FILE, "utf8"));
    if (stored && typeof stored.publicKey === "string" && stored.privateJwk) {
      const key = await globalThis.crypto.subtle.importKey("jwk", stored.privateJwk, params, false, [
        "sign",
      ]);
      return { publicKey: stored.publicKey, key };
    }
  } catch {
    // No pair yet, or an unreadable one: make a new one below.
  }
  const pair = await globalThis.crypto.subtle.generateKey(params, true, ["sign", "verify"]);
  const raw = await globalThis.crypto.subtle.exportKey("raw", pair.publicKey);
  const privateJwk = await globalThis.crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = b64url(Buffer.from(raw));
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await writeAtomic(VAPID_FILE, JSON.stringify({ publicKey, privateJwk }));
  const key = await globalThis.crypto.subtle.importKey("jwk", privateJwk, params, false, ["sign"]);
  return { publicKey, key };
}

function vapid() {
  if (!vapidPromise) vapidPromise = loadOrCreateVapid();
  return vapidPromise;
}

/**
 * The whole of RFC 8292 that we need: a JWT signed with ES256, plus the public
 * key next to it. About sixty lines instead of a dependency tree.
 *
 * The signature that WebCrypto produces for ECDSA is already r||s, 64 bytes -
 * exactly the JOSE encoding. No DER unwrapping needed.
 */
async function vapidAuthorization(endpoint) {
  const { publicKey, key } = await vapid();
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" }), "utf8"));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: PUSH_SUBJECT,
      }),
      "utf8",
    ),
  );
  const signingInput = `${header}.${claims}`;
  const signature = await globalThis.crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(signingInput, "utf8"),
  );
  return `vapid t=${signingInput}.${b64url(Buffer.from(signature))}, k=${publicKey}`;
}

/**
 * THE ONE OUTBOUND CALL IN THIS WHOLE SYSTEM.
 *
 * Everything else here answers requests; this is the single place where the
 * server itself reaches out, and it reaches exactly one kind of host: the push
 * service the browser named in its own subscription. The request has NO BODY.
 * There is nothing in it about the person, the vault or the list - the push
 * service sees a URL it issued itself and a signature proving who is poking it.
 *
 * @returns {Promise<"sent"|"gone"|"failed"|"retry">}
 */
async function sendEmptyPush(endpoint) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(endpoint),
        TTL: String(PUSH_TTL_SECONDS),
      },
    });
  } catch {
    // Offline, DNS, TLS: try again on the next round, do not mark it as sent.
    return "retry";
  }
  if (res.status === 404 || res.status === 410) return "gone";
  return res.ok ? "sent" : "failed";
}

function pushFile(id) {
  return join(recordDir(id), "push.json");
}

async function readPushStore(id) {
  try {
    const parsed = JSON.parse(await readFile(pushFile(id), "utf8"));
    return Array.isArray(parsed.subs) ? parsed : { subs: [] };
  } catch {
    return { subs: [] };
  }
}

async function writePushStore(id, subs) {
  await mkdir(recordDir(id), { recursive: true, mode: 0o700 });
  await writeAtomic(pushFile(id), JSON.stringify({ subs }));
}

/**
 * Only a device that can open the vault may register a reminder for it. The
 * proof is the same write token the sync PUT uses, checked against the same
 * stored hash - so knowing a sync id (which grants read) is not enough.
 */
async function authorisedForVault(req, id) {
  const token = req.headers["x-sync-token"];
  if (typeof token !== "string" || token.length < 16 || token.length > 512) return false;
  const record = await readRecord(id);
  if (!record) return false;
  return sameHex(record.tokenHash, await sha256Hex(token));
}

/** A push endpoint is a URL the browser handed us; it must look like one. */
function validEndpoint(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === "https:") return url.toString();
  if (ALLOW_INSECURE_PUSH && url.protocol === "http:") return url.toString();
  return null;
}

async function readPushBody(req) {
  const read = await readBody(req, MAX_PUSH_BODY_BYTES);
  if (read.tooLarge) return null;
  try {
    const parsed = JSON.parse(read.body.toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function handlePushSubscribe(req, res) {
  const payload = await readPushBody(req);
  if (!payload) {
    sendJson(res, 400, { error: "bad request" });
    return;
  }
  const id = payload.syncId;
  const endpoint = validEndpoint(payload.sub && payload.sub.endpoint);
  const hourUtc = Number(payload.hourUtc);
  if (typeof id !== "string" || !SYNC_ID_RE.test(id) || !endpoint) {
    sendJson(res, 400, { error: "bad request" });
    return;
  }
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) {
    sendJson(res, 400, { error: "bad request" });
    return;
  }
  if (!(await authorisedForVault(req, id))) {
    sendJson(res, 401, { error: "unauthorised" });
    return;
  }
  await withIdLock(id, async () => {
    const store = await readPushStore(id);
    const existing = store.subs.findIndex((s) => s.endpoint === endpoint);
    if (existing < 0 && store.subs.length >= MAX_SUBS_PER_ID) {
      sendJson(res, 429, { error: "too many" });
      return;
    }
    // What is kept is the endpoint and the hour. The subscription's p256dh and
    // auth secrets are deliberately NOT stored: an empty push needs no payload
    // encryption, so holding those keys would be storing a capability nobody
    // in this design ever uses.
    const entry = {
      endpoint,
      hourUtc,
      createdAt: existing < 0 ? Date.now() : store.subs[existing].createdAt,
      lastSentDay: existing < 0 ? "" : store.subs[existing].lastSentDay || "",
    };
    const subs = existing < 0 ? [...store.subs, entry] : store.subs.map((s, i) => (i === existing ? entry : s));
    await writePushStore(id, subs);
    sendEmpty(res, 204);
  });
}

async function handlePushUnsubscribe(req, res) {
  const payload = await readPushBody(req);
  if (!payload) {
    sendJson(res, 400, { error: "bad request" });
    return;
  }
  const id = payload.syncId;
  const endpoint = typeof payload.endpoint === "string" ? payload.endpoint : "";
  if (typeof id !== "string" || !SYNC_ID_RE.test(id) || !endpoint) {
    sendJson(res, 400, { error: "bad request" });
    return;
  }
  if (!(await authorisedForVault(req, id))) {
    sendJson(res, 401, { error: "unauthorised" });
    return;
  }
  await withIdLock(id, async () => {
    const store = await readPushStore(id);
    await writePushStore(id, store.subs.filter((s) => s.endpoint !== endpoint));
    sendEmpty(res, 204);
  });
}

/**
 * One round of the daily dispatch: everything whose hour has come and that has
 * not gone out today yet. Returns how many endpoints were poked, which is what
 * the local trigger below reports.
 */
async function dispatchDue(hourOverride) {
  const now = Date.now();
  const hourUtc = Number.isInteger(hourOverride) ? hourOverride : new Date(now).getUTCHours();
  const day = utcDayKey(now);
  let ids;
  try {
    ids = await readdir(VAULT_DIR);
  } catch {
    return 0;
  }
  let attempted = 0;
  for (const id of ids) {
    if (!SYNC_ID_RE.test(id)) continue;
    const store = await readPushStore(id);
    const due = store.subs.filter((s) => s.hourUtc === hourUtc && s.lastSentDay !== day);
    for (const sub of due) {
      attempted += 1;
      const outcome = await sendEmptyPush(sub.endpoint);
      await withIdLock(id, async () => {
        const current = await readPushStore(id);
        const subs =
          outcome === "gone"
            ? current.subs.filter((s) => s.endpoint !== sub.endpoint)
            : current.subs.map((s) =>
                s.endpoint === sub.endpoint && outcome !== "retry" ? { ...s, lastSentDay: day } : s,
              );
        await writePushStore(id, subs);
      });
    }
  }
  return attempted;
}

async function handlePushApi(req, res, rest) {
  if (rest === "vapid") {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const { publicKey } = await vapid();
    sendJson(res, 200, { publicKey });
    return;
  }
  if (rest === "subscribe" && req.method === "POST") {
    await handlePushSubscribe(req, res);
    return;
  }
  if (rest === "unsubscribe" && req.method === "POST") {
    await handlePushUnsubscribe(req, res);
    return;
  }
  if (rest === "dispatch" && req.method === "POST") {
    // Operator trigger, loopback only: runs the daily round now instead of
    // waiting for the interval. It sends the same empty signal and nothing
    // more, so it cannot be used to extract anything.
    if (!isLocal(req)) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const payload = await readPushBody(req);
    const hour = payload && Number.isInteger(payload.hourUtc) ? payload.hourUtc : undefined;
    sendJson(res, 200, { attempted: await dispatchDue(hour) });
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

// ---------------------------------------------------------------- model relay
//
// Everything from here to the router is the pipe described at the top of this
// file. It reads a request, checks that the target is allowed and that the
// caller may use it, opens exactly one connection, and copies the answer back.
// It keeps nothing.

/**
 * The full URL to talk to, or null when the target is not allowed.
 * Query strings, fragments and URL credentials are refused outright: none of
 * them belong in a base URL, and all three are classic ways to make a checked
 * string point somewhere else.
 */
function upstreamTarget(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 300) return null;
  const cleaned = value.trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(cleaned);
  } catch {
    return null;
  }
  if (url.search || url.hash || url.username || url.password) return null;
  if (url.protocol === "https:" && LLM_CLOUD_HOSTS.has(url.hostname)) {
    return { url: `${cleaned}/chat/completions`, local: false, host: url.hostname };
  }
  if (LLM_LOCAL_UPSTREAMS.includes(cleaned)) {
    return { url: `${cleaned}/chat/completions`, local: true, host: url.hostname };
  }
  return null;
}

/**
 * Providers that expect the token cap as max_completion_tokens - their
 * reasoning models reject the older max_tokens outright. The others still
 * reject unknown fields, so the name is chosen per host, never sent twice.
 */
const MAX_COMPLETION_HOSTS = new Set(["api.openai.com", "api.groq.com", "openrouter.ai"]);

/** True when the messages carry an image part - the only reason for 8 MB. */
function carriesImage(messages) {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    const content = message && message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && part.type === "image_url") return true;
    }
  }
  return false;
}

/**
 * The hashes of every registered write token. Cached, because the alternative
 * is a directory walk per relayed request. The relay deliberately does NOT ask
 * which vault is calling: it only needs to know that SOME vault on this server
 * vouches for the caller, and not asking is one identifier less that exists.
 */
let tokenCache = { at: 0, hashes: [] };
let lastRescanAt = 0;

async function loadTokenHashes() {
  const hashes = [];
  let ids;
  try {
    ids = await readdir(VAULT_DIR);
  } catch {
    ids = [];
  }
  for (const id of ids) {
    if (!SYNC_ID_RE.test(id)) continue;
    const record = await readRecord(id);
    if (record && typeof record.tokenHash === "string") hashes.push(record.tokenHash);
  }
  tokenCache = { at: Date.now(), hashes };
  return hashes;
}

/**
 * Who may use the relay: a local caller (this machine - the dev server, the
 * test suite, the operator's own browser), or anybody holding the write token
 * of a vault that exists here. Without that rule a stranger who found the
 * tunnel could burn the operator's local model, or their cloud budget.
 */
async function relayAuthorised(req) {
  if (isLocal(req)) return true;
  const token = req.headers["x-sync-token"];
  if (typeof token !== "string" || token.length < 16 || token.length > 512) return false;
  const hash = await sha256Hex(token);
  const matches = (list) => {
    let found = false;
    for (const known of list) if (sameHex(known, hash)) found = true;
    return found;
  };
  const fresh = Date.now() - tokenCache.at < TOKEN_CACHE_MS;
  if (matches(fresh ? tokenCache.hashes : await loadTokenHashes())) return true;
  // A vault registered seconds ago is not in the cache yet. One rescan, rate
  // limited, so a wrong token cannot be turned into a directory walk per try.
  if (fresh && Date.now() - lastRescanAt > TOKEN_RESCAN_MS) {
    lastRescanAt = Date.now();
    return matches(await loadTokenHashes());
  }
  return false;
}

/** The answer, byte for byte, with the content type this API always sends. */
function sendRaw(res, status, body) {
  res.writeHead(status, { ...API_HEADERS, "Content-Length": body.length });
  res.end(body);
}

/**
 * One request to the model. No caller header is passed on, no redirect is
 * followed (node does not follow them and nothing here adds it), and the
 * response is read with a hard cap so a hostile or broken upstream cannot
 * push this process into swap.
 * @returns {Promise<{status?: number, body?: Buffer, error?: string}>}
 */
function askUpstream(target, payload, apiKey) {
  return new Promise((done) => {
    const url = new URL(target.url);
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
      Accept: "application/json",
    };
    // The key belongs to the caller, travels once, and is not kept anywhere.
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const call = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers,
      },
      (answer) => {
        const chunks = [];
        let size = 0;
        answer.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_LLM_RESPONSE_BYTES) {
            answer.destroy();
            call.destroy();
            done({ error: "tooLarge" });
            return;
          }
          chunks.push(chunk);
        });
        answer.on("end", () => done({ status: answer.statusCode || 502, body: Buffer.concat(chunks) }));
        answer.on("error", () => done({ error: "upstream" }));
      },
    );
    call.setTimeout(LLM_TIMEOUT_MS, () => {
      call.destroy();
      done({ error: "timeout" });
    });
    call.on("error", () => done({ error: "upstream" }));
    call.end(body);
  });
}

async function handleLlm(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  // The hard ceiling is read off the stream; the ordinary one megabyte is
  // applied below, once it is clear whether an image is really part of this.
  const read = await readBody(req, MAX_LLM_IMAGE_BODY_BYTES);
  if (read.tooLarge) {
    sendJson(res, 413, { error: "too large" });
    return;
  }
  if (!(await relayAuthorised(req))) {
    sendJson(res, 401, { error: "unauthorised" });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(read.body.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "bad request" });
    return;
  }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages)) {
    sendJson(res, 400, { error: "bad request" });
    return;
  }
  const target = upstreamTarget(payload.upstream);
  if (!target) {
    sendJson(res, 403, { error: "upstream not allowed" });
    return;
  }
  if (!carriesImage(payload.messages) && read.body.length > MAX_LLM_BODY_BYTES) {
    sendJson(res, 413, { error: "too large" });
    return;
  }
  if (typeof payload.model !== "string" || !payload.model || payload.model.length > 200) {
    sendJson(res, 400, { error: "bad request" });
    return;
  }

  // A fixed, tiny set of fields travels. Anything else the client might have
  // sent - and anything a future client might send by accident - stops here.
  const forwarded = { model: payload.model, messages: payload.messages };
  if (Number.isFinite(payload.maxTokens)) {
    const cap = Math.trunc(payload.maxTokens);
    if (MAX_COMPLETION_HOSTS.has(target.host)) forwarded.max_completion_tokens = cap;
    else forwarded.max_tokens = cap;
  }
  if (Number.isFinite(payload.temperature)) forwarded.temperature = payload.temperature;
  // Reasoning throttle, LOCAL upstreams only: LM Studio honours it (verified
  // live: gemma's thinking shrinks to a third and the answer arrives), and
  // servers that do not know it ignore it. Cloud providers instead reject
  // unknown parameters, so it never travels to the allowlist hosts.
  if (target.local && (payload.reasoningEffort === "low" || payload.reasoningEffort === "none")) {
    forwarded.reasoning_effort = payload.reasoningEffort;
  }

  const answer = await askUpstream(target, forwarded, typeof payload.apiKey === "string" ? payload.apiKey : "");
  if (answer.error === "timeout") {
    sendJson(res, 504, { error: "timeout" });
    return;
  }
  if (answer.error) {
    sendJson(res, 502, { error: "upstream" });
    return;
  }
  // Verbatim: whatever the model said, including its own error shape. This
  // server does not interpret, rewrite, summarise or remember any of it.
  sendRaw(res, answer.status, answer.body);
}

/**
 * Routes /api/vault/<syncId>. Returns true when the request was handled here.
 * Anything that is not an exact match falls through to the static files, so a
 * traversal attempt never reaches the file system through this path.
 */
async function handleApi(req, res, rel) {
  if (!rel.startsWith("/api/")) return false;
  const rest = rel.slice("/api/".length);
  if (!rest.startsWith("vault/") && !rest.startsWith("push/") && rest !== "llm") {
    sendJson(res, 404, { error: "not found" });
    return true;
  }
  if (!isLocal(req) && overLimit(rateHits, clientIp(req), RATE_WINDOW_MS, RATE_MAX_PER_WINDOW)) {
    sendJson(res, 429, { error: "slow down" });
    return true;
  }
  if (rest === "llm") {
    await handleLlm(req, res);
    return true;
  }
  if (rest.startsWith("push/")) {
    await handlePushApi(req, res, rest.slice("push/".length));
    return true;
  }
  const id = rest.slice("vault/".length);
  if (!SYNC_ID_RE.test(id)) {
    sendJson(res, 400, { error: "bad id" });
    return true;
  }
  if (req.method === "GET") await handleGetVault(res, id);
  else if (req.method === "PUT") await handlePutVault(req, res, id);
  else if (req.method === "DELETE") await handleDeleteVault(req, res, id);
  else sendJson(res, 405, { error: "method not allowed" });
  return true;
}

async function tryRead(base, rel) {
  const file = join(base, rel);
  if (!file.startsWith(base)) return null; // path traversal guard
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let rel = normalize(decodeURIComponent(url.pathname));

  // The app is also reachable under the /tenfold prefix
  // (kairatools.com/tenfold via the tunnel path rule). Redirect the bare
  // prefix to the trailing-slash form so relative asset paths resolve,
  // then strip the prefix - the file layout below is identical.
  if (rel === "/tenfold") {
    res.writeHead(301, { Location: "/tenfold/" }).end();
    return;
  }
  if (rel.startsWith("/tenfold/")) rel = rel.slice("/tenfold".length);

  // The mailbox comes before the static files: /api/... is never a file.
  try {
    if (await handleApi(req, res, rel)) return;
  } catch {
    // No request detail is logged, ever - a body is ciphertext and a header
    // may be the write token.
    if (!res.headersSent) sendJson(res, 500, { error: "server error" });
    return;
  }

  if (rel === "/" || rel === "/index.html") rel = "/index.html";

  // App files first (served at the root), then repo files (tests, design).
  // The strict CSP applies to the app only - the design previews and test
  // fixtures under the repo fallback use inline styles by design.
  let body = await tryRead(WEB, rel);
  let fromApp = body !== null;
  if (body === null) {
    body = await tryRead(ROOT, rel);
  }
  if (body === null) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": TYPES[extname(rel)] || "application/octet-stream",
    "Cache-Control": "no-store",
    ...(fromApp ? SECURITY_HEADERS : {}),
  });
  res.end(body);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`tenfold server on http://127.0.0.1:${PORT}`);
  console.log(`vault mailbox: ${VAULT_DIR}`);
});

// The daily round. It wakes every five minutes, which is fine granularity for
// something that fires once a day per subscription, and it never blocks the
// server: a failed send is simply retried on the next wake. unref() so the
// process can still exit on its own.
const dispatchTimer = setInterval(() => {
  dispatchDue().catch(() => {
    // A push service that is down is not a server error - the next round tries
    // again. Nothing is logged: an endpoint is a per-device identifier.
  });
}, DISPATCH_INTERVAL_MS);
if (typeof dispatchTimer.unref === "function") dispatchTimer.unref();
