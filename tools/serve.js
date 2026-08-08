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
import { createServer } from "node:http";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
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

/**
 * Routes /api/vault/<syncId>. Returns true when the request was handled here.
 * Anything that is not an exact match falls through to the static files, so a
 * traversal attempt never reaches the file system through this path.
 */
async function handleApi(req, res, rel) {
  if (!rel.startsWith("/api/")) return false;
  const rest = rel.slice("/api/".length);
  if (!rest.startsWith("vault/") && !rest.startsWith("push/")) {
    sendJson(res, 404, { error: "not found" });
    return true;
  }
  if (!isLocal(req) && overLimit(rateHits, clientIp(req), RATE_WINDOW_MS, RATE_MAX_PER_WINDOW)) {
    sendJson(res, 429, { error: "slow down" });
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
