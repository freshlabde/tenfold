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
 * Routes /api/vault/<syncId>. Returns true when the request was handled here.
 * Anything that is not an exact match falls through to the static files, so a
 * traversal attempt never reaches the file system through this path.
 */
async function handleApi(req, res, rel) {
  if (!rel.startsWith("/api/")) return false;
  const rest = rel.slice("/api/".length);
  if (!rest.startsWith("vault/")) {
    sendJson(res, 404, { error: "not found" });
    return true;
  }
  if (!isLocal(req) && overLimit(rateHits, clientIp(req), RATE_WINDOW_MS, RATE_MAX_PER_WINDOW)) {
    sendJson(res, 429, { error: "slow down" });
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
