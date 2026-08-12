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
// THE SECOND EXCEPTION, REMOVED IN v1.1 - THE MODEL RELAY: there used to be a
// second exception here, and this note stands in its place rather than the
// numbering being closed up, because a rule that quietly loses an exception
// reads as if it never had one. Until v1.1 this file also served POST /api/llm:
// a pipe that handed a request on to a language model and handed the answer
// back, with an upstream allowlist in front of it (the SSRF wall), a caller
// gate for the operator's own local models, and a doorbell file of sync ids
// waiting for that operator's decision. It was the only place this server ever
// touched the plaintext of anything, and the only place it wrote down who had
// asked for something.
// It is gone. The app no longer talks to a model at all: it writes a prompt,
// the person carries it to whatever AI they already use and pastes the answer
// back, so there is nothing left for a server to forward. What went with the
// relay: LLM_CLOUD_HOSTS, TENFOLD_LLM_UPSTREAMS, llm_access.json,
// TENFOLD_NOTIFY_URL, tools/llm_gate.js and the "Local model access" section of
// the stats page. The mailbox rule below is therefore stricter than it was, not
// looser. The full relay lives in git history, at the v1.0.0 tag.
//
// THE THIRD EXCEPTION - THE STATS PAGE, AND WHAT IT IS NOT: with the env var
// TENFOLD_STATS_KEY set, and ONLY then, this server counts document loads.
// Read this before you take it as the end of "no tracking":
//   - It is OFF unless the operator switches it on. With no key set nothing is
//     counted, nothing is written, and /stats does not exist - a 404 like any
//     other unknown path. Every deployment that does not opt in stays exactly
//     as tracking-free as it was.
//   - What is counted is a COUNTER, not a visit record. Per UTC day: how many
//     document loads, how many distinct visitors, which external referrer
//     hosts, which countries, mobile against desktop. Sums, nothing else.
//   - No IP is ever written. The "distinct visitors" number comes from an
//     in-memory Set of SHA-256(daily random salt + IP); the salt is made fresh
//     each day, lives only in this process, and is never persisted. Only the
//     COUNT reaches the disk, so the file cannot be turned back into who was
//     there - not by us, not by whoever takes the disk.
//   - Only the app's own document is counted. Never /api/... (those URLs carry
//     sync ids, which are capability secrets), never an asset, never a query
//     string, never the stats page itself.
//   - THE ONE EXCEPTION TO THAT, AND ITS SHAPE: the native shell never loads a
//     page from here - it ships the app in its bundle - so page counting cannot
//     see it at all, and an app that phoned home merely to be counted would
//     break the product's own promise. It is therefore visible only through
//     traffic it already sends: the sync and push calls its proxy forwards,
//     which carry the user agent "tenfold-ios/<version>" and nothing else.
//     Those requests feed ONE number per day and nothing more: how many
//     distinct devices synced, deduplicated with the same daily salt and
//     hashed-IP trick as the visitor number, in a Set of its own. No hit per
//     request - a sync storm is not a visit. No id, no path, no method, no
//     body, no header beyond that one user-agent prefix. A browser's API calls
//     stay uncounted, exactly as before.
//   - An app used offline is invisible here, by design. That is a true number
//     being missing, not a number waiting to be fixed by a beacon.
//   - Referrers are stored as HOST only. A full referrer URL can carry another
//     site's query secrets, and none of that belongs in a counter.
//   - There is no cookie, no id, no session, no path through a person's visits.
//     Two loads by one person on one day are one visitor; the same person
//     tomorrow is a new one, because yesterday's salt is gone.
// If a future change makes this file able to say WHO was here, the design is
// broken, not improved.
import { createServer } from "node:http";
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

// -------------------------------------------------------------------- stats
/**
 * The switch. Absent or empty means the whole feature does not exist: nothing
 * is counted and /stats answers 404 like any unknown path. An operator who
 * wants numbers sets a long random string here and reads them at
 * /stats?k=<that string>.
 */
const STATS_KEY = String(process.env.TENFOLD_STATS_KEY || "");
const STATS_ENABLED = STATS_KEY.length > 0;

/** The counters, in the data directory - never inside the repository. */
const STATS_FILE = join(DATA_DIR, "stats.json");

/** The counters are held in memory and written out this often, like push. */
const STATS_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Cap per referrer/country map per day. A hostile Referer header is free to
 * invent hosts, so without a ceiling one visitor could grow the file without
 * bound. Everything past the cap lands in one "other" bucket.
 */
const STATS_MAX_KEYS = 200;

/** Roughly thirteen months of days; older ones are dropped on flush. */
const STATS_MAX_DAYS = 400;

/**
 * Ceiling for the per-day visitor Set. 100k hashes is far beyond anything this
 * server will see and keeps a flood from eating memory. Past it the visitor
 * number stops rising - it under-reports rather than lies about a number it
 * could not hold.
 */
const STATS_MAX_VISITORS = 100_000;

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

/**
 * The public documents under web/ that are not the app, and carry their own
 * CSP because of it. There is exactly one: the privacy policy.
 *
 * The strict header above forbids an inline <style> and an inline <script>,
 * which is right for the app - an injected script there would hold the
 * plaintext and the key at once. privacy.html is a static file with no user
 * content, no fetch, no storage and nothing to inject into; it is
 * self-contained on purpose, because a policy that pulls in a stylesheet is a
 * policy that can render naked. So its own two inline blocks are allowed and
 * EVERYTHING else is refused: default-src 'none' means it cannot load a font,
 * an image, a frame or an origin even if a future edit tried to.
 */
const PUBLIC_DOCS = new Set(["/privacy.html"]);

const PUBLIC_DOC_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
    "base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
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
 * THE ONE OUTBOUND CALL THAT NOBODY ASKED FOR.
 *
 * Since v1.1 it is also the only outbound call there is: the relay that opened
 * a socket because a caller asked it to, and the operator's notification hook,
 * are both gone. This is the single place where the server reaches out at all,
 * on a timer, and it reaches exactly one kind of host: the push service the
 * browser named in its own subscription. The request has NO BODY.
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

// -------------------------------------------------------------------- stats
//
// Everything from here to the router is the counter described at the top of
// this file. It exists only when TENFOLD_STATS_KEY is set. It touches nothing
// else: no request is delayed by it, no handler branches on it, and with the
// key absent every function below returns immediately.

/** The UTC calendar day as YYYY-MM-DD - the only time resolution kept. */
function utcDateKey(ts) {
  const d = new Date(ts);
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** Random hex, for the daily visitor salt. Web Crypto, no new import. */
function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Buffer.from(buf).toString("hex");
}

let statsData = null; // { days: { "YYYY-MM-DD": DayEntry } }
let statsPromise = null; // the one load of the file
let statsDirty = false;

// The visitor approximation. All three live ONLY here: the salt is never
// written, the Set is never written, and both are thrown away when the day
// turns. What survives a restart is the number that was already counted.
let visitorDay = "";
let visitorSalt = "";
let visitorSeen = new Set();
// The app devices of the same day, kept apart from the visitors so that one
// person who both opens the page and syncs the app is one of each rather than
// silently one of neither. Same salt, same lifetime, same never-written rule.
let appSeen = new Set();

function emptyDay() {
  return {
    hits: 0,
    visitors: 0,
    bots: 0,
    ref: {},
    geo: {},
    platform: { mobile: 0, desktop: 0, app: 0 },
    // Distinct devices that synced through the native shell today. A count of
    // the same salted hashes the visitor number uses, in a Set of its own, and
    // like that number only the COUNT is ever written.
    appDevices: 0,
  };
}

/**
 * Coarse bot check on the user agent. Deliberately a short substring list, not
 * a catalogue to maintain: it catches the crawlers, the link previewers and
 * the command-line fetchers that arrive in bulk the moment a link is posted
 * somewhere, and misses the clever ones - which is fine, because the point is
 * that a launch day's crawler wave does not drown the human numbers.
 *
 * A bot increments ONE counter and nothing else: no visitor, no referrer, no
 * country, no platform. Its user agent is read for this one decision and, like
 * every other user agent here, never stored.
 */
const BOT_MARKERS = [
  "bot",
  "crawler",
  "spider",
  "preview",
  "fetch",
  "curl",
  "wget",
  "python-requests",
  "headless",
];

function isBot(ua) {
  if (typeof ua !== "string" || ua.length === 0) return false;
  const lower = ua.toLowerCase();
  return BOT_MARKERS.some((marker) => lower.includes(marker));
}

/** Reads the counters back, or starts fresh. A broken file is never fatal. */
async function loadStats() {
  try {
    const parsed = JSON.parse(await readFile(STATS_FILE, "utf8"));
    if (parsed && typeof parsed.days === "object" && parsed.days !== null) {
      const days = {};
      for (const [day, value] of Object.entries(parsed.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !value || typeof value !== "object") continue;
        const entry = emptyDay();
        entry.hits = Number(value.hits) || 0;
        entry.visitors = Number(value.visitors) || 0;
        entry.bots = Number(value.bots) || 0;
        if (value.ref && typeof value.ref === "object") entry.ref = { ...value.ref };
        if (value.geo && typeof value.geo === "object") entry.geo = { ...value.geo };
        if (value.platform && typeof value.platform === "object") {
          entry.platform.mobile = Number(value.platform.mobile) || 0;
          entry.platform.desktop = Number(value.platform.desktop) || 0;
          // Absent in every file written before the app bucket existed, which
          // is the whole migration: a missing number is zero, the day keeps its
          // other counters, and the next flush writes the current shape. No
          // rewrite pass, no version field, no upgrade step for the operator.
          entry.platform.app = Number(value.platform.app) || 0;
        }
        entry.appDevices = Number(value.appDevices) || 0;
        days[day] = entry;
      }
      return { days };
    }
  } catch {
    // No file yet, or an unreadable one: counting starts from zero.
  }
  return { days: {} };
}

function stats() {
  if (!statsPromise) statsPromise = loadStats();
  return statsPromise;
}

async function flushStats() {
  if (!STATS_ENABLED || !statsDirty || !statsData) return;
  const days = Object.keys(statsData.days).sort();
  for (const day of days.slice(0, Math.max(0, days.length - STATS_MAX_DAYS))) {
    delete statsData.days[day];
  }
  statsDirty = false;
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await writeAtomic(STATS_FILE, JSON.stringify(statsData));
}

/** One more for this key, or one more for "other" once the map is full. */
function bump(map, key, cap) {
  if (Object.prototype.hasOwnProperty.call(map, key)) {
    map[key] += 1;
    return;
  }
  if (Object.keys(map).length >= cap) {
    map.other = (map.other || 0) + 1;
    return;
  }
  map[key] = 1;
}

/**
 * The referrer's HOST, or "" when there is none worth keeping. Same-origin
 * referrers are dropped (that is navigation inside the app, not a source), and
 * so is anything that does not parse or does not look like a hostname. The
 * full URL is never touched again after this line: a foreign query string can
 * carry a foreign secret.
 */
function externalRefHost(referer, host) {
  if (typeof referer !== "string" || referer.length === 0 || referer.length > 2048) return "";
  let url;
  try {
    url = new URL(referer);
  } catch {
    return "";
  }
  const name = url.hostname.toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{0,119}$/.test(name)) return "";
  if (typeof host === "string" && name === host.toLowerCase().split(":")[0]) return "";
  return name;
}

/** The two-letter country Cloudflare puts on the request, or "??". */
function countryOf(value) {
  return typeof value === "string" && /^[A-Za-z0-9]{2}$/.test(value) ? value.toUpperCase() : "??";
}

/**
 * What the native shell puts on every request its proxy forwards, and the only
 * user agent this server reads for anything but the coarse buckets below. Two
 * tokens by construction on the client side - the product and its version - so
 * there is nothing in it to fingerprint: no device model, no OS version, no
 * build number, nothing that differs between two phones running the release.
 *
 * It is a claim, not a credential. Anything can send this header, and then it
 * is counted as an app device. That is acceptable for a counter nobody bills
 * anybody for, and it is the reason this string may never be allowed to decide
 * anything but which column a number lands in.
 */
const APP_UA_PREFIX = "tenfold-ios/";

function isAppUa(ua) {
  return typeof ua === "string" && ua.toLowerCase().startsWith(APP_UA_PREFIX);
}

/**
 * Mobile, desktop or app, and nothing else. The user agent string is read once
 * for this one bit and is not kept, not hashed, not counted in any other shape.
 *
 * The app arm is future-proofing, not today's path: the shell bundles the web
 * app and never fetches a document from here, so this returns "app" only if a
 * later build ever does load the page over the wire. Today the app reaches the
 * numbers through recordAppApiCall() below instead.
 */
function platformOf(ua) {
  if (isAppUa(ua)) return "app";
  return typeof ua === "string" && /Mobi|Android|iPhone|iPad/.test(ua) ? "mobile" : "desktop";
}

/**
 * Turns the day over: one fresh salt and both Sets emptied, together. They
 * share a salt on purpose - it is thrown away either way, and two salts would
 * only mean two things to reason about - but they are separate Sets, so a
 * person who both opens the page and syncs the app is one of each.
 */
function rollDay(day) {
  if (visitorDay === day) return;
  visitorDay = day;
  visitorSalt = randomHex(32);
  visitorSeen = new Set();
  appSeen = new Set();
}

/**
 * The distinct-visitor approximation. The hash exists for the length of a
 * comparison and lives in a Set that is dropped when the day turns; the salt
 * that makes it unlinkable is generated in memory and never written anywhere.
 */
async function noteVisitor(entry, day, ip) {
  rollDay(day);
  if (visitorSeen.size >= STATS_MAX_VISITORS) return;
  const digest = await sha256Hex(`${visitorSalt}:${ip}`);
  if (visitorSeen.has(digest)) return;
  visitorSeen.add(digest);
  entry.visitors += 1;
}

/**
 * The same approximation for the app, over its own Set. A device that syncs
 * forty times today is one; the same device tomorrow is a new one, because
 * today's salt is gone by then - the identical honesty, and the identical
 * limit, as the visitor number.
 */
async function noteAppDevice(entry, day, ip) {
  rollDay(day);
  if (appSeen.size >= STATS_MAX_VISITORS) return;
  const digest = await sha256Hex(`${visitorSalt}:${ip}`);
  if (appSeen.has(digest)) return;
  appSeen.add(digest);
  entry.appDevices += 1;
}

/**
 * One document load. Called only for the app's own index.html, only for GET,
 * and only when the file was really served. Everything it reads off the
 * request it turns into a number here and now; nothing is queued, kept or
 * passed on. It does not await anything the response needs: a page must never
 * wait on a counter.
 */
function recordDocumentLoad(req) {
  if (!STATS_ENABLED || req.method !== "GET") return;
  const refHost = externalRefHost(req.headers.referer, req.headers.host);
  const country = countryOf(req.headers["cf-ipcountry"]);
  const platform = platformOf(req.headers["user-agent"]);
  const bot = isBot(req.headers["user-agent"]);
  const ip = clientIp(req);
  void (async () => {
    try {
      const data = await stats();
      statsData = data;
      const day = utcDateKey(Date.now());
      const entry = data.days[day] || (data.days[day] = emptyDay());
      if (bot) {
        // One number, and out. A crawler is traffic, not a visitor.
        entry.bots += 1;
        statsDirty = true;
        return;
      }
      entry.hits += 1;
      entry.platform[platform] += 1;
      bump(entry.geo, country, STATS_MAX_KEYS);
      if (refHost) bump(entry.ref, refHost, STATS_MAX_KEYS);
      await noteVisitor(entry, day, ip);
      statsDirty = true;
    } catch {
      // A counter that fails is a counter that fails. It never becomes an
      // error the person on the page can see.
    }
  })();
}

/**
 * One API request from the native shell. The ONLY thing an /api/ call has ever
 * been allowed to contribute to the counters, and it contributes exactly one
 * bit: that some device with the app on it was in touch today.
 *
 * What is deliberately not here:
 *   - No hit. A sync client that PUTs on every edit would otherwise turn one
 *     afternoon into a traffic spike that means nothing.
 *   - No path, no method, no sync id, no token, no body length. The id in the
 *     URL is a capability secret and does not get to be a statistic.
 *   - Nothing at all for a browser's API calls. Those stay as uncounted as
 *     they were before this function existed; only the app's user agent opens
 *     this door, and the door leads to one Set and one integer.
 */
function recordAppApiCall(req) {
  if (!STATS_ENABLED) return;
  if (!isAppUa(req.headers["user-agent"])) return;
  const ip = clientIp(req);
  void (async () => {
    try {
      const data = await stats();
      statsData = data;
      const day = utcDateKey(Date.now());
      const entry = data.days[day] || (data.days[day] = emptyDay());
      await noteAppDevice(entry, day, ip);
      statsDirty = true;
    } catch {
      // Same rule as the document counter: a counter that fails, fails alone.
      // The sync call it rode in on has already been answered.
    }
  })();
}

// ------------------------------------------------------------- the stats page

function esc(text) {
  return String(text).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

/** Plain numbers with thin thousands groups - no locale surprises. */
function num(value) {
  return String(Math.trunc(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** The last n UTC days, oldest first, whether or not anything happened. */
function recentDays(n) {
  const out = [];
  const today = Date.now();
  for (let i = n - 1; i >= 0; i -= 1) out.push(utcDateKey(today - i * 86400000));
  return out;
}

/** Sums one of the string-keyed maps across the given days. */
function totalsOver(data, days, field) {
  const out = new Map();
  for (const day of days) {
    const entry = data.days[day];
    if (!entry) continue;
    for (const [key, count] of Object.entries(entry[field] || {})) {
      out.set(key, (out.get(key) || 0) + (Number(count) || 0));
    }
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]);
}

function rows(pairs, limit, empty) {
  if (pairs.length === 0) return `<p class="none">${esc(empty)}</p>`;
  const body = pairs
    .slice(0, limit)
    .map(([key, count]) => `<tr><td>${esc(key)}</td><td class="n">${num(count)}</td></tr>`)
    .join("");
  return `<table><tbody>${body}</tbody></table>`;
}

/** Thirty bars, drawn as one SVG. No script, no library, no external asset. */
function sparkline(data, days) {
  const values = days.map((day) => (data.days[day] ? data.days[day].hits : 0));
  const peak = Math.max(1, ...values);
  const w = 10;
  const bars = values
    .map((value, i) => {
      const h = Math.round((value / peak) * 52);
      return `<rect x="${i * w + 1}" y="${56 - h}" width="${w - 2}" height="${Math.max(h, 1)}"><title>${esc(
        days[i],
      )}: ${num(value)}</title></rect>`;
    })
    .join("");
  return `<svg class="spark" viewBox="0 0 ${values.length * w} 58" preserveAspectRatio="none" role="img" aria-label="Document loads per day, last ${values.length} days">${bars}</svg>`;
}

function statsPage(data, key) {
  const last30 = recentDays(30);
  const last7 = recentDays(7);
  const allDays = Object.keys(data.days).sort().reverse();
  const totalHits = allDays.reduce((sum, day) => sum + data.days[day].hits, 0);
  const totalVisitors = allDays.reduce((sum, day) => sum + data.days[day].visitors, 0);
  const totalBots = allDays.reduce((sum, day) => sum + data.days[day].bots, 0);
  const platform = allDays.reduce(
    (acc, day) => {
      acc.mobile += data.days[day].platform.mobile;
      acc.desktop += data.days[day].platform.desktop;
      acc.app += data.days[day].platform.app;
      return acc;
    },
    { mobile: 0, desktop: 0, app: 0 },
  );
  // Summed daily, exactly like the visitor number above it and for the same
  // reason: each day's figure is distinct WITHIN that day and nothing links two
  // days, so the sum is "device-days", not people. The page says so.
  const appDevices = allDays.reduce((sum, day) => sum + data.days[day].appDevices, 0);
  // The share column compares like with like: browser loads against browser
  // loads. The app row is a different unit and gets no percentage rather than a
  // made-up one.
  const browserLoads = platform.mobile + platform.desktop;
  const share = (value) => (browserLoads ? `${Math.round((value / browserLoads) * 100)}%` : "-");

  const dayRows = allDays
    .slice(0, 60)
    .map(
      (day) =>
        `<tr><td>${esc(day)}</td><td class="n">${num(data.days[day].hits)}</td><td class="n">${num(
          data.days[day].visitors,
        )}</td><td class="n dim">${num(data.days[day].bots)}</td></tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>tenfold stats</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 28px 20px 64px; background: #0B0D11; color: #E7E9EE;
         font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 600; letter-spacing: .01em; margin: 0 0 4px; }
  h2 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .12em;
       color: #D6A441; margin: 40px 0 12px; }
  h3 { font-size: 12px; font-weight: 600; color: #8A9099; margin: 22px 0 8px; text-transform: uppercase;
       letter-spacing: .1em; }
  .lede { color: #8A9099; font-size: 13px; margin: 0 0 4px; }
  nav { margin: 18px 0 0; font-size: 13px; }
  nav a { color: #D6A441; text-decoration: none; margin-right: 16px; }
  nav a:hover { text-decoration: underline; }
  .cards { display: flex; flex-wrap: wrap; gap: 12px; margin: 22px 0 0; }
  .card { flex: 1 1 150px; border: 1px solid #1D212A; border-radius: 10px; padding: 12px 14px; background: #10131A; }
  .card .k { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: #8A9099; }
  .card .v { font-size: 22px; font-weight: 600; color: #D6A441; margin-top: 4px; }
  .spark { width: 100%; height: 72px; display: block; margin: 8px 0 4px; }
  .spark rect { fill: #D6A441; opacity: .85; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  td { border-bottom: 1px solid #171B23; padding: 6px 8px 6px 0; }
  td.n { text-align: right; width: 6em; color: #D6A441; }
  th { text-align: left; font-weight: 600; color: #8A9099; font-size: 12px; padding: 0 8px 6px 0;
       border-bottom: 1px solid #1D212A; text-transform: uppercase; letter-spacing: .08em; }
  th.n { text-align: right; }
  .none { color: #6C727C; font-size: 13px; }
  td.dim { color: #6C727C; }
  .unit { display: block; color: #6C727C; font-size: 11px; letter-spacing: .04em; margin-top: 2px; }
  form.clear { margin: 34px 0 0; }
  form.clear button, form.act button { background: transparent; border: 1px solid #2A2018; color: #8A9099;
    border-radius: 8px; padding: 7px 14px; font: inherit; font-size: 13px; cursor: pointer; }
  form.clear button:hover, form.act button:hover { border-color: #D6A441; color: #D6A441; }
  form.act { display: inline-block; margin: 0 0 0 8px; }
  form.act.note { display: inline-flex; gap: 6px; align-items: center; }
  .note-input { background: #0F1216; border: 1px solid #2A2018; border-radius: 6px; color: #C6CBD3;
    font: inherit; font-size: 12px; padding: 4px 8px; width: 140px; }
  .note-input:focus { outline: none; border-color: #D6A441; }
  .note-label { color: #D6A441; font-size: 12px; margin-top: 3px; }
  form.act button { padding: 4px 10px; font-size: 12px; }
  td.id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  td.act-cell { text-align: right; white-space: nowrap; }
  .cols { display: flex; flex-wrap: wrap; gap: 28px; }
  .cols > div { flex: 1 1 300px; min-width: 260px; }
  footer { margin-top: 48px; color: #6C727C; font-size: 12px; border-top: 1px solid #171B23; padding-top: 14px; }
  .wrap { overflow-x: auto; }
</style>
</head><body><main>
<h1>tenfold &middot; stats</h1>
<p class="lede">Document loads, counted per UTC day, plus one number for the app: how many devices synced.
No IP, no cookie, no identifier is stored - both the visitor and the device number are daily counts of
salted hashes that never leave memory.</p>
<nav><a href="#visitors">Visitors</a><a href="#referrers">Referrers</a><a href="#countries">Countries</a><a href="#platform">Platform</a></nav>

<div class="cards">
  <div class="card"><div class="k">Loads, all time</div><div class="v">${num(totalHits)}</div></div>
  <div class="card"><div class="k">Visitors, summed daily</div><div class="v">${num(totalVisitors)}</div></div>
  <div class="card"><div class="k">Days recorded</div><div class="v">${num(allDays.length)}</div></div>
  <div class="card"><div class="k">Bot hits, all time</div><div class="v">${num(totalBots)}</div></div>
</div>

<h2 id="visitors">Visitors</h2>
${sparkline(data, last30)}
<p class="lede">Human loads per day, last 30 days. Bots are counted separately and are in no other number
on this page.</p>
<div class="wrap"><table><thead><tr><th>Day (UTC)</th><th class="n">Loads</th><th class="n">Visitors</th><th class="n">Bots</th></tr></thead>
<tbody>${dayRows || '<tr><td colspan="4" class="none">Nothing counted yet.</td></tr>'}</tbody></table></div>

<h2 id="referrers">Referrers</h2>
<div class="cols">
  <div><h3>All time</h3>${rows(totalsOver(data, allDays, "ref"), 50, "No external referrer so far.")}</div>
  <div><h3>Last 7 days</h3>${rows(totalsOver(data, last7, "ref"), 20, "No external referrer in the last 7 days.")}</div>
</div>

<h2 id="countries">Countries</h2>
<div class="cols">
  <div><h3>All time</h3>${rows(totalsOver(data, allDays, "geo"), 50, "Nothing counted yet.")}</div>
  <div><h3>Last 7 days</h3>${rows(totalsOver(data, last7, "geo"), 20, "Nothing in the last 7 days.")}</div>
</div>

<h2 id="platform">Platform</h2>
<table><thead><tr><th>Where</th><th class="n">Count</th><th class="n">Share</th></tr></thead><tbody>
<tr><td>Mobile (browser)<span class="unit">document loads</span></td><td class="n">${num(
    platform.mobile,
  )}</td><td class="n">${share(platform.mobile)}</td></tr>
<tr><td>Desktop (browser)<span class="unit">document loads</span></td><td class="n">${num(
    platform.desktop,
  )}</td><td class="n">${share(platform.desktop)}</td></tr>
<tr><td>App<span class="unit">devices that synced, summed per day</span></td><td class="n">${num(
    appDevices,
  )}</td><td class="n dim">-</td></tr>${
    platform.app
      ? `
<tr><td>App<span class="unit">document loads</span></td><td class="n">${num(platform.app)}</td><td class="n dim">-</td></tr>`
      : ""
  }
</tbody></table>
<p class="lede">The two browser rows are page loads. The app never loads a page from this server - it carries
the app inside it - so it is counted where it does appear: when it syncs. That row is a per-day count of
distinct devices, from the same daily salted hash as the visitor number, and the days are added up, so it
is device-days rather than people. An app used offline is in no number on this page, by design.</p>

<form class="clear" method="post" action="?k=${esc(encodeURIComponent(key))}">
  <input type="hidden" name="action" value="clear">
  <button type="submit">Clear all counters</button>
</form>

<footer>Counted: document loads of the app, per UTC day, with the referrer host, the country header
Cloudflare sets, and one bit of mobile against desktop against app. Crawlers and command-line fetchers are
put in the bot column and appear in nothing else. Counted from the app's sync and push calls, and only
from those: how many distinct devices were in touch that day - no hit per request, no sync id, no path,
no method. Never counted: a browser's API calls, assets, query strings, this page. Never stored: IP
addresses, user agents, cookies, sessions, anything that could name a person. A visitor or a device
counted today and tomorrow is two, because the daily salt is gone by then.</footer>
</main></body></html>`;
}

/**
 * GET /stats?k=KEY, and /stats.php?k=KEY for the operator's muscle memory.
 * Returns true when the request was handled here.
 *
 * A wrong key, a missing key and a disabled feature all answer the SAME plain
 * 404 the static branch sends for any unknown path, so the answer never
 * betrays that this page exists at all.
 */
async function handleStats(req, res, rel, query) {
  if (rel !== "/stats" && rel !== "/stats.php") return false;
  if (!STATS_ENABLED) return false;
  if (req.method !== "GET" && req.method !== "POST") return false;
  // The same per-IP limiter the API calls go through, so the key cannot be
  // guessed at speed. Over the limit is a 404 as well - a 429 here would tell
  // a stranger that the path is worth trying.
  if (!isLocal(req) && overLimit(rateHits, clientIp(req), RATE_WINDOW_MS, RATE_MAX_PER_WINDOW)) {
    return false;
  }
  const given = query.get("k") || "";
  // Fixed-time over the digests: same length whatever was sent, so neither the
  // key's length nor the position of the first wrong character leaks.
  if (!sameHex(await sha256Hex(given), await sha256Hex(STATS_KEY))) return false;

  // The admin surface: one button, the one that throws the counters away. It
  // POSTs, so no prefetch, no crawler and no history entry can trigger it, and
  // it needs the same key the page needs.
  if (req.method === "POST") {
    const read = await readBody(req, 4096);
    const form = new URLSearchParams(read.tooLarge ? "" : read.body.toString("utf8"));
    const action = form.get("action") || "";
    if (action === "clear") {
      statsData = { days: {} };
      statsPromise = Promise.resolve(statsData);
      visitorDay = "";
      visitorSalt = "";
      visitorSeen = new Set();
      appSeen = new Set();
      statsDirty = true;
      await flushStats().catch(() => {});
    }
    // Back to the page itself, so a refresh does not repeat the action.
    res.writeHead(303, {
      Location: `${rel}?k=${encodeURIComponent(given)}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end();
    return true;
  }

  const data = await stats();
  statsData = data;
  // The operator looking is a good moment to put the counters on disk; the
  // interval does the same every five minutes.
  await flushStats().catch(() => {});
  const body = Buffer.from(statsPage(data, given), "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    // Its own policy: this page is one file with one inline stylesheet and no
    // script at all. Nothing may load, nothing may run, nothing may frame it.
    // form-action is 'self' for the one clear button and nothing else.
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Content-Length": body.length,
  });
  res.end(body);
  return true;
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
  // The app's one way into the numbers, and the only line in the API path that
  // touches the counters at all. It runs for a real /api/vault or /api/push
  // request that got past the limiter, it reads one header, and it never
  // delays the answer: the request continues below regardless.
  recordAppApiCall(req);
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

  // Safari probes these two well-known paths before reading any <link> tag,
  // and on a 404 it walks up to the DOMAIN root - which under the path rule
  // is another product's icon, not ours (owner report: the app carried the
  // chat's dog as its favicon). Answer them with the real files; modern
  // browsers accept PNG bytes on /favicon.ico regardless of the name.
  if (rel === "/favicon.ico") rel = "/icons/favicon-32.png";
  else if (rel === "/apple-touch-icon.png" || rel === "/apple-touch-icon-precomposed.png") {
    rel = "/icons/icon-192.png";
  }

  // The share target belongs to the service worker, which answers this POST
  // before it can ever reach a socket. This branch is the honest fallback for
  // the one case where no worker is in control yet (a fresh install, a browser
  // that dropped it): the body is DISCARDED unread - not parsed, not buffered,
  // not written, not logged - and the person lands in the app instead of on a
  // "not found" page. What the browser already put on the wire cannot be
  // unsent; what this server can decide is that nothing is done with it.
  if (req.method === "POST" && rel === "/share") {
    req.resume();
    res.writeHead(303, { Location: "/", "Cache-Control": "no-store" }).end();
    return;
  }

  // The mailbox comes before the static files: /api/... is never a file.
  try {
    if (await handleApi(req, res, rel)) return;
  } catch {
    // No request detail is logged, ever - a body is ciphertext and a header
    // may be the write token.
    if (!res.headersSent) sendJson(res, 500, { error: "server error" });
    return;
  }

  // The counters, when the operator switched them on. Before the static
  // branch, because /stats is not a file, and it answers a plain 404 for every
  // caller who cannot show the key.
  try {
    if (await handleStats(req, res, rel, url.searchParams)) return;
  } catch {
    // A broken counter must not take the server with it.
  }

  if (rel === "/" || rel === "/index.html") rel = "/index.html";
  // A directory request resolves to its index, as on any static server. The
  // deployed app is served at the root and never needs this; the suite opens it
  // at /web/, and the service worker's very first act is to precache "./" -
  // which is that directory, and which a 404 would turn into a failed install.
  else if (rel.endsWith("/")) rel = `${rel}index.html`;

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
  // The one place anything is counted, and only when the operator switched it
  // on: the app's own document, really served, nothing else. Assets, API
  // calls, the repo fallback paths and every 404 pass this line untouched.
  if (fromApp && rel === "/index.html") recordDocumentLoad(req);
  res.writeHead(200, {
    "Content-Type": TYPES[extname(rel)] || "application/octet-stream",
    "Cache-Control": "no-store",
    ...(fromApp ? (PUBLIC_DOCS.has(rel) ? PUBLIC_DOC_HEADERS : SECURITY_HEADERS) : {}),
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

// The counters, when they exist at all: held in memory and written out on the
// same rhythm as the push round. A crash loses at most the last five minutes
// of counting, which is the right trade for a number nobody bills anybody for.
// Rendering the page writes them out too, so the operator never reads a stale
// file. unref() so this timer cannot hold the process open either.
if (STATS_ENABLED) {
  const statsTimer = setInterval(() => {
    flushStats().catch(() => {
      // A full or read-only disk is not worth a crash; the next round retries.
    });
  }, STATS_FLUSH_INTERVAL_MS);
  if (typeof statsTimer.unref === "function") statsTimer.unref();
}
