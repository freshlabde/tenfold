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
//
// THE SECOND WALL IN FRONT OF THE RELAY - THE CALLER GATE: the upstream
// allowlist above says WHERE a request may go. This says WHO may send it there,
// and only for the operator's own LOCAL models:
//   - A cloud target is never gated. The caller sends their own API key and
//     pays their own bill; there is nothing of the operator's to protect.
//   - A LOCAL target is the operator's machine, their electricity, their GPU.
//     A caller who proved a vault (X-Sync-Token) may use it only when that sync
//     id stands in the operator's allowlist. Without the gate, everybody who
//     ever set up a vault here would be holding a free model server.
//   - Loopback without a sync id keeps the older allowance unchanged: that is
//     this machine (dev server, test suite, the operator's own browser).
//   - A refusal is 403 {"error":"llm-approval"} and the id is put in a pending
//     list so the operator can allow it. THIS IS THE ONE PLACE WHERE THE RELAY
//     WRITES ANYTHING DOWN, and what it writes is a sync id, a first and last
//     timestamp and a counter. Never a message, never a key, never an upstream,
//     never an IP, never a user agent. The pending list is a doorbell, not a
//     log. If a future change makes it hold what was ASKED, the design is
//     broken, not improved.
//   - The decision itself lives in tools/llm_gate.js, pure and testable.
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
//   - Referrers are stored as HOST only. A full referrer URL can carry another
//     site's query secrets, and none of that belongs in a counter.
//   - There is no cookie, no id, no session, no path through a person's visits.
//     Two loads by one person on one day are one visitor; the same person
//     tomorrow is a new one, because yesterday's salt is gone.
// If a future change makes this file able to say WHO was here, the design is
// broken, not improved.
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { homedir } from "node:os";
import { gateDecision, notePending } from "./llm_gate.js";

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

/**
 * Who may reach those local models. Beside the vaults, in the data directory,
 * so an update cannot hand out access by accident. Shape:
 *   { allowed: ["<syncId>"], pending: { "<syncId>": { first, last, count } } }
 * Created lazily on the first refusal; absent means an EMPTY allowlist, never
 * an open one. There is no grandfathering: the operator allows ids by hand,
 * starting with their own.
 */
const LLM_ACCESS_FILE = join(DATA_DIR, "llm_access.json");

/** How many ids may wait for a decision. Past it the oldest first-seen go. */
const MAX_PENDING_IDS = 500;

/**
 * Optional operator hook. When set, the FIRST time a new id asks, one JSON POST
 * goes here - fire and forget, short timeout, every failure swallowed. What the
 * operator does with it (a mail, a chat message, a log line) is their business:
 * no SMTP code lives in this repository, and no dependency is added for one.
 */
const NOTIFY_URL = String(process.env.TENFOLD_NOTIFY_URL || "");

/** The public address of this deployment, for the links in that POST. */
const PUBLIC_URL = String(process.env.TENFOLD_PUBLIC_URL || "");

/** The notification is a courtesy, not a step in the request. Five seconds. */
const NOTIFY_TIMEOUT_MS = 5 * 1000;

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
    // The relay's cache of known write tokens may still vouch for the one that
    // just lost its vault. Drop it, so the next relayed request rescans.
    tokenCache = { at: 0, owners: [] };
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
 * The relay opens a socket because a caller asked it to, and the operator's
 * notification hook fires because the operator configured one. This is the
 * single place where the server reaches out ON ITS OWN, on a timer, and it
 * reaches exactly one kind of host: the push service the browser named in its
 * own subscription. The request has NO BODY.
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
 * The write-token hash of every registered vault, with the id beside it.
 * Cached, because the alternative is a directory walk per relayed request.
 *
 * The id is in this table for ONE reason: the caller gate for local models
 * needs a name to compare against the operator's allowlist. relayAuthorised
 * below still does not read it - a request that is on its way to a cloud
 * provider is answered without this server ever asking who is calling, exactly
 * as before. Only the local branch calls callerSyncId.
 */
let tokenCache = { at: 0, owners: [] };
let lastRescanAt = 0;

async function loadTokenOwners() {
  const owners = [];
  let ids;
  try {
    ids = await readdir(VAULT_DIR);
  } catch {
    ids = [];
  }
  for (const id of ids) {
    if (!SYNC_ID_RE.test(id)) continue;
    const record = await readRecord(id);
    if (record && typeof record.tokenHash === "string") owners.push({ hash: record.tokenHash, id });
  }
  tokenCache = { at: Date.now(), owners };
  return owners;
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
    for (const known of list) if (sameHex(known.hash, hash)) found = true;
    return found;
  };
  const fresh = Date.now() - tokenCache.at < TOKEN_CACHE_MS;
  if (matches(fresh ? tokenCache.owners : await loadTokenOwners())) return true;
  // A vault registered seconds ago is not in the cache yet. One rescan, rate
  // limited, so a wrong token cannot be turned into a directory walk per try.
  if (fresh && Date.now() - lastRescanAt > TOKEN_RESCAN_MS) {
    lastRescanAt = Date.now();
    return matches(await loadTokenOwners());
  }
  return false;
}

/**
 * WHICH vault is calling, or "" when the caller showed no usable token. Called
 * ONLY when the target is a local upstream, because that is the one decision
 * that needs a name; a cloud request never reaches this function.
 *
 * The answer lives for the length of the request. It reaches the disk in
 * exactly one case: the gate refuses, and the id goes into the pending list so
 * the operator can allow it.
 */
async function callerSyncId(req) {
  const token = req.headers["x-sync-token"];
  if (typeof token !== "string" || token.length < 16 || token.length > 512) return "";
  const hash = await sha256Hex(token);
  const pick = (list) => {
    let found = "";
    for (const owner of list) if (sameHex(owner.hash, hash)) found = owner.id;
    return found;
  };
  const fresh = Date.now() - tokenCache.at < TOKEN_CACHE_MS;
  const hit = pick(fresh ? tokenCache.owners : await loadTokenOwners());
  if (hit) return hit;
  if (fresh && Date.now() - lastRescanAt > TOKEN_RESCAN_MS) {
    lastRescanAt = Date.now();
    return pick(await loadTokenOwners());
  }
  return "";
}

// ----------------------------------------------------------- the caller gate

let accessPromise = null; // the one load of the file, kept for the process lifetime

/**
 * Reads the allowlist back, or starts EMPTY. A missing file, a broken file and
 * an unreadable disk all mean the same thing here: nobody is allowed yet. The
 * shape is validated on the way in, so a hand-edited file cannot put anything
 * into the state that is not a sync id.
 */
async function loadAccess() {
  try {
    const parsed = JSON.parse(await readFile(LLM_ACCESS_FILE, "utf8"));
    const allowed = Array.isArray(parsed.allowed) ? parsed.allowed.filter((id) => SYNC_ID_RE.test(id)) : [];
    const pending = {};
    if (parsed.pending && typeof parsed.pending === "object") {
      for (const [id, value] of Object.entries(parsed.pending)) {
        if (!SYNC_ID_RE.test(id) || !value || typeof value !== "object") continue;
        pending[id] = {
          first: Number(value.first) || 0,
          last: Number(value.last) || 0,
          count: Number(value.count) || 0,
        };
      }
    }
    // Operator-entered labels ("Michael's iPhone") so an allowed id has a face.
    // Plain text, capped, only ever rendered on the key-gated page - a note is
    // for the operator's memory and never travels to any caller.
    const notes = {};
    if (parsed.notes && typeof parsed.notes === "object") {
      for (const [id, value] of Object.entries(parsed.notes)) {
        if (!SYNC_ID_RE.test(id) || typeof value !== "string") continue;
        const trimmed = value.trim().slice(0, NOTE_MAX_CHARS);
        if (trimmed) notes[id] = trimmed;
      }
    }
    return { allowed: [...new Set(allowed)], pending, notes };
  } catch {
    return { allowed: [], pending: {}, notes: {} };
  }
}

/** A note is a label, not a document. */
const NOTE_MAX_CHARS = 120;

function access() {
  if (!accessPromise) accessPromise = loadAccess();
  return accessPromise;
}

/** Same atomic write as the vault records: a temp file, then a rename. */
async function saveAccess(data) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await writeAtomic(LLM_ACCESS_FILE, JSON.stringify(data));
}

/**
 * The links the operator's notification carries. They exist only when there is
 * a public address to build them from AND a stats key to authorise them with -
 * without the key the page they point at is a 404 for everybody, so a link
 * would be a lie. No key set, or no public URL: the POST carries the id alone.
 */
function notifyLinks(syncId) {
  if (!PUBLIC_URL || !STATS_KEY) return {};
  let base;
  try {
    base = new URL(PUBLIC_URL).toString().replace(/\/+$/, "");
  } catch {
    return {};
  }
  const k = encodeURIComponent(STATS_KEY);
  return {
    allowUrl: `${base}/stats?k=${k}&allow=${syncId}`,
    denyUrl: `${base}/stats?k=${k}&deny=${syncId}`,
    statsUrl: `${base}/stats?k=${k}#llm`,
  };
}

/**
 * One POST to the operator's own hook, and then this server forgets about it.
 * It is not awaited by the request, nothing is retried, no answer is read, and
 * every failure is swallowed: a doorbell that breaks must not break the door.
 *
 * It uses node's http/https request rather than fetch on purpose - the one
 * fetch() in this file is the push round, and tests/today.spec.js counts it.
 */
function notifyOperator(syncId) {
  if (!NOTIFY_URL) return;
  let url;
  try {
    url = new URL(NOTIFY_URL);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  const body = Buffer.from(
    JSON.stringify({ event: "llm-approval-request", syncId, ...notifyLinks(syncId) }),
    "utf8",
  );
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  try {
    const call = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(body.length) },
      },
      (answer) => answer.resume(), // drained, never read
    );
    call.setTimeout(NOTIFY_TIMEOUT_MS, () => call.destroy());
    call.on("error", () => {});
    call.end(body);
  } catch {
    // A hook that is unreachable, misconfigured or gone is not an error the
    // person waiting for a model answer should ever hear about.
  }
}

/** Records that an id asked, and says whether the operator should be poked. */
async function recordPending(syncId) {
  let isNew = false;
  await withIdLock("llm-access", async () => {
    const data = await access();
    isNew = notePending(data.pending, syncId, Date.now(), MAX_PENDING_IDS).isNew;
    await saveAccess(data);
  });
  return isNew;
}

/**
 * The operator's three decisions, all idempotent: allowing an allowed id,
 * denying an unknown one and revoking one that is not there all end in the
 * state the name promises. That is what makes a link in a mail safe to click
 * twice, and what makes a double POST harmless.
 */
async function applyAccessAction(action, syncId, note) {
  if (!SYNC_ID_RE.test(syncId)) return;
  await withIdLock("llm-access", async () => {
    const data = await access();
    if (!data.notes || typeof data.notes !== "object") data.notes = {};
    if (action === "allow") {
      if (!data.allowed.includes(syncId)) data.allowed.push(syncId);
      delete data.pending[syncId];
    } else if (action === "deny") {
      // Denying forgets the request. It is not a blocklist: an id that asks
      // again lands in the pending list again, which is the honest behaviour
      // for something the operator may simply not have decided yet.
      delete data.pending[syncId];
    } else if (action === "revoke") {
      data.allowed = data.allowed.filter((id) => id !== syncId);
    } else if (action === "note") {
      // The operator's label for an id. An empty note takes the label away;
      // saving the same note twice is a no-op - the link/button rules of the
      // other three actions hold here too.
      const trimmed = typeof note === "string" ? note.trim().slice(0, NOTE_MAX_CHARS) : "";
      if (trimmed) data.notes[syncId] = trimmed;
      else delete data.notes[syncId];
    } else {
      return;
    }
    await saveAccess(data);
  });
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

  // The second wall: WHO may use the operator's own machine as a model server.
  // A cloud target never gets here - it is the caller's key and the caller's
  // bill, and this branch is skipped before any identity is looked up.
  if (target.local) {
    const store = await access();
    const decision = gateDecision({
      targetLocal: true,
      localRequest: isLocal(req),
      syncId: await callerSyncId(req),
      allowed: store.allowed,
    });
    if (!decision.pass) {
      if (decision.syncId) {
        const isNew = await recordPending(decision.syncId).catch(() => false);
        if (isNew) notifyOperator(decision.syncId);
      }
      // The answer is one machine-readable word. It carries no id, no list, no
      // count and no hint about who else may use this server - the caller
      // learns only that a decision is owed, which is what they sent in.
      sendJson(res, 403, { error: "llm-approval" });
      return;
    }
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

function emptyDay() {
  return { hits: 0, visitors: 0, bots: 0, ref: {}, geo: {}, platform: { mobile: 0, desktop: 0 } };
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
        }
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
 * Mobile or desktop, and nothing else. The user agent string is read once for
 * this one bit and is not kept, not hashed, not counted in any other shape.
 */
function platformOf(ua) {
  return typeof ua === "string" && /Mobi|Android|iPhone|iPad/.test(ua) ? "mobile" : "desktop";
}

/**
 * The distinct-visitor approximation. The hash exists for the length of a
 * comparison and lives in a Set that is dropped when the day turns; the salt
 * that makes it unlinkable is generated in memory and never written anywhere.
 */
async function noteVisitor(entry, day, ip) {
  if (visitorDay !== day) {
    visitorDay = day;
    visitorSalt = randomHex(32);
    visitorSeen = new Set();
  }
  if (visitorSeen.size >= STATS_MAX_VISITORS) return;
  const digest = await sha256Hex(`${visitorSalt}:${ip}`);
  if (visitorSeen.has(digest)) return;
  visitorSeen.add(digest);
  entry.visitors += 1;
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

/** A moment, in UTC, to the minute. No locale, no timezone guessing. */
function stamp(ts) {
  const value = Number(ts) || 0;
  if (!value) return "-";
  return new Date(value).toISOString().replace("T", " ").slice(0, 16);
}

/**
 * The operator's console for the caller gate: who may use the local models,
 * and who is waiting for an answer.
 *
 * Showing sync ids here is deliberate and bounded. An id is a capability for
 * the MAILBOX (it grants a read of one ciphertext blob), so it belongs behind
 * the key - which this page already is, rate limited and unlisted. The operator
 * holds the data directory anyway; the requester never sees any of it.
 */
function gateSection(gate, key) {
  const action = `?k=${esc(encodeURIComponent(key))}`;
  const button = (name, id, label) =>
    `<form class="act" method="post" action="${action}"><input type="hidden" name="action" value="${name}"><input type="hidden" name="id" value="${esc(
      id,
    )}"><button type="submit">${esc(label)}</button></form>`;

  // The note gives an allowed id a face ("Michael's iPhone") - operator's
  // memory only, rendered nowhere but here, never sent to any caller.
  const noteForm = (id, current) =>
    `<form class="act note" method="post" action="${action}"><input type="hidden" name="action" value="llm-note"><input type="hidden" name="id" value="${esc(
      id,
    )}"><input class="note-input" type="text" name="note" maxlength="120" placeholder="Note" value="${esc(
      current || "",
    )}"><button type="submit">Save</button></form>`;

  const allowedRows = gate.allowed
    .map(
      (id) =>
        `<tr><td class="id">${esc(id)}${
          gate.notes && gate.notes[id] ? `<div class="note-label">${esc(gate.notes[id])}</div>` : ""
        }</td><td class="act-cell">${noteForm(id, gate.notes && gate.notes[id])}${button(
          "llm-revoke",
          id,
          "Revoke",
        )}</td></tr>`,
    )
    .join("");

  const waiting = Object.entries(gate.pending).sort((a, b) => (b[1].last || 0) - (a[1].last || 0));
  const pendingRows = waiting
    .map(
      ([id, entry]) =>
        `<tr><td class="id">${esc(id)}</td><td>${esc(stamp(entry.first))}</td><td>${esc(
          stamp(entry.last),
        )}</td><td class="n">${num(entry.count)}</td><td class="act-cell">${button(
          "llm-allow",
          id,
          "Allow",
        )}${button("llm-deny", id, "Deny")}</td></tr>`,
    )
    .join("");

  return `<h2 id="llm">Local model access</h2>
<p class="lede">Who may send a request to the model servers named in TENFOLD_LLM_UPSTREAMS. Cloud targets are
not affected: those run on the caller's own key. A caller who is not allowed gets a refusal and lands in the
list below; what is stored per waiting id is the id, when it first and last asked, and how often. Nothing else.</p>
<h3>Allowed</h3>
${allowedRows ? `<div class="wrap"><table><tbody>${allowedRows}</tbody></table></div>` : '<p class="none">Nobody yet. Local models are reachable from this machine only.</p>'}
<h3>Waiting for a decision</h3>
${
  pendingRows
    ? `<div class="wrap"><table><thead><tr><th>Sync id</th><th>First asked</th><th>Last asked</th><th class="n">Tries</th><th></th></tr></thead><tbody>${pendingRows}</tbody></table></div>`
    : '<p class="none">Nobody is waiting.</p>'
}`;
}

function statsPage(data, key, gate) {
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
      return acc;
    },
    { mobile: 0, desktop: 0 },
  );
  const platformTotal = platform.mobile + platform.desktop;
  const share = (value) => (platformTotal ? `${Math.round((value / platformTotal) * 100)}%` : "-");

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
<p class="lede">Document loads only, counted per UTC day. No IP, no cookie, no identifier is stored -
the visitor number is a daily count of salted hashes that never leave memory.</p>
<nav><a href="#visitors">Visitors</a><a href="#referrers">Referrers</a><a href="#countries">Countries</a><a href="#platform">Platform</a><a href="#llm">Local model access</a></nav>

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
<table><tbody>
<tr><td>Mobile</td><td class="n">${num(platform.mobile)}</td><td class="n">${share(platform.mobile)}</td></tr>
<tr><td>Desktop</td><td class="n">${num(platform.desktop)}</td><td class="n">${share(platform.desktop)}</td></tr>
</tbody></table>

${gateSection(gate, key)}

<form class="clear" method="post" action="?k=${esc(encodeURIComponent(key))}">
  <input type="hidden" name="action" value="clear">
  <button type="submit">Clear all counters</button>
</form>

<footer>Counted: document loads of the app, per UTC day, with the referrer host, the country header
Cloudflare sets, and one bit of mobile against desktop. Crawlers and command-line fetchers are put in the
bot column and appear in nothing else. Never counted: API calls, assets, query strings, this page.
Never stored: IP addresses, user agents, cookies, sessions, anything that could name a person.
A visitor counted today and tomorrow is two, because the daily salt is gone by then.</footer>
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

  // The admin surface: the button that throws the counters away, and the three
  // decisions of the caller gate. All of them POST, so no prefetch, no crawler
  // and no history entry can trigger them, and all of them need the same key
  // the page needs.
  if (req.method === "POST") {
    const read = await readBody(req, 4096);
    const form = new URLSearchParams(read.tooLarge ? "" : read.body.toString("utf8"));
    const action = form.get("action") || "";
    let fragment = "";
    if (action === "clear") {
      statsData = { days: {} };
      statsPromise = Promise.resolve(statsData);
      visitorDay = "";
      visitorSalt = "";
      visitorSeen = new Set();
      statsDirty = true;
      await flushStats().catch(() => {});
    } else if (action.startsWith("llm-")) {
      await applyAccessAction(action.slice("llm-".length), form.get("id") || "", form.get("note") || "").catch(
        () => {},
      );
      fragment = "#llm";
    }
    // Back to the page itself, so a refresh does not repeat the action.
    res.writeHead(303, {
      Location: `${rel}?k=${encodeURIComponent(given)}${fragment}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end();
    return true;
  }

  // The clickable half of the same three decisions: /stats?k=KEY&allow=<id>.
  // The operator's notification is a mail, and a mail carries links, not forms.
  // THE KEY IN THE LINK IS THE AUTHENTICATION - it was checked above, exactly
  // as for the page itself - and the action is IDEMPOTENT, because a link gets
  // clicked twice, prefetched by a mail client and opened again from history.
  const allowId = query.get("allow") || "";
  const denyId = query.get("deny") || "";
  if (allowId || denyId) {
    await applyAccessAction(allowId ? "allow" : "deny", allowId || denyId).catch(() => {});
    res.writeHead(303, {
      Location: `${rel}?k=${encodeURIComponent(given)}#llm`,
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
  const gate = await access();
  const body = Buffer.from(statsPage(data, given, gate), "utf8");
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
