// The counters (tools/serve.js, TENFOLD_STATS_KEY).
//
// Two things are checked here, and the first one matters more than the second:
// that a server WITHOUT the key counts nothing and has no stats page at all,
// and that a server WITH the key counts document loads and only those.
//
// The suite's shared server (playwright.config.js) deliberately runs without
// the key, because the default-off claim is only worth anything if it is the
// default the rest of the suite runs under. Everything that needs the feature
// switched on therefore gets its own serve.js child on its own port with its
// own throwaway data directory.
import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Must match playwright.config.js webServer.env - the shared, keyless server. */
const SHARED_DATA = join(tmpdir(), "tenfold-test-data");

/** The private server for this file. Not a port any other spec uses. */
const PORT = 7796;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "test-stats-key-9f3c1a7e";

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

// One server, one data directory, one file: serial.
test.describe.configure({ mode: "serial", timeout: 120_000 });

let child;
let dataDir;

/** The counters as they stand on disk. A GET of the page flushes them first. */
async function statsFile() {
  return readFile(join(dataDir, "stats.json"), "utf8");
}

async function openPage(key = KEY) {
  return fetch(`${BASE}/stats?k=${encodeURIComponent(key)}`, { headers: { "User-Agent": BROWSER_UA } });
}

/** One document load, with the headers a real visit would carry. */
async function load(path = "/", headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: { "User-Agent": BROWSER_UA, ...headers } });
  await res.arrayBuffer();
  return res;
}

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "tenfold-stats-"));
  child = spawn(process.execPath, [join(ROOT, "tools", "serve.js")], {
    env: { ...process.env, PORT: String(PORT), TENFOLD_DATA: dataDir, TENFOLD_STATS_KEY: KEY },
    stdio: "ignore",
  });
  // Wait for the socket rather than for a fixed delay. The probe deliberately
  // asks for a path that is never counted, so waiting for the server does not
  // put a hit in the very file this spec is about to assert on.
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fetch(`${BASE}/api/probe`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("the stats server did not come up");
      await new Promise((done) => setTimeout(done, 100));
    }
  }
});

test.afterAll(async () => {
  if (child) child.kill();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------ off by default

test("without the key there is no stats page and nothing is written", async ({ request }) => {
  // The shared server of the whole suite: no TENFOLD_STATS_KEY anywhere.
  expect((await request.get("/stats?k=")).status()).toBe(404);
  expect((await request.get("/stats?k=test-stats-key-9f3c1a7e")).status()).toBe(404);
  expect((await request.get("/stats.php?k=anything")).status()).toBe(404);

  // A real document load through that server, and still no counter file.
  expect((await request.get("/web/index.html")).status()).toBe(200);
  expect((await request.get("/")).status()).toBe(200);
  await new Promise((done) => setTimeout(done, 200));
  expect(existsSync(join(SHARED_DATA, "stats.json"))).toBe(false);
});

// --------------------------------------------------------- with the key set

test("a document load is counted, twice from one address is one visitor", async () => {
  await load("/", { Referer: "https://news.ycombinator.com/item?id=42&secret=leaky", "cf-ipcountry": "de" });
  await load("/tenfold/", { Referer: "https://news.ycombinator.com/newest", "cf-ipcountry": "de" });

  const page = await openPage();
  expect(page.status).toBe(200);
  const html = await page.text();

  const stored = JSON.parse(await statsFile());
  const days = Object.keys(stored.days);
  expect(days).toHaveLength(1);
  const day = stored.days[days[0]];

  // Both loads counted, one visitor: same IP, same day, same salt.
  expect(day.hits).toBe(2);
  expect(day.visitors).toBe(1);
  // The referrer is a HOST. The foreign query string never reaches the file.
  expect(day.ref).toEqual({ "news.ycombinator.com": 2 });
  expect(await statsFile()).not.toContain("secret=leaky");
  expect(await statsFile()).not.toContain("item?id=42");
  // The country header Cloudflare sets, normalised.
  expect(day.geo).toEqual({ DE: 2 });
  expect(day.platform).toEqual({ mobile: 0, desktop: 2 });

  // And the page the operator reads shows the day's number.
  expect(html).toContain(days[0]);
  expect(html).toContain("noindex");
  expect(html).toMatch(/id="visitors"/);
  expect(html).toMatch(/id="referrers"/);
  expect(html).toMatch(/id="countries"/);
  expect(html).toMatch(/id="platform"/);
  // Self-contained: no script at all, and no address anything could load from.
  expect(html).not.toMatch(/<script/);
  expect(html).not.toMatch(/https?:\/\//);
});

test("a phone is counted as mobile, a crawler only as a bot", async () => {
  await load("/", { "User-Agent": PHONE_UA, "cf-ipcountry": "ES" });
  await load("/", { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" });
  await load("/", { "User-Agent": "python-requests/2.31.0" });

  await openPage();
  const stored = JSON.parse(await statsFile());
  const day = stored.days[Object.keys(stored.days)[0]];

  // The phone is a visit; the two crawlers are one number and nothing else.
  expect(day.hits).toBe(3);
  expect(day.platform).toEqual({ mobile: 1, desktop: 2 });
  expect(day.bots).toBe(2);
  expect(day.geo).toEqual({ DE: 2, ES: 1 });
  // No user agent is ever stored, bot or human.
  const raw = await statsFile();
  expect(raw).not.toContain("Googlebot");
  expect(raw).not.toContain("python-requests");
  expect(raw).not.toContain("iPhone");
});

test("api traffic is never counted and no sync id reaches the file", async () => {
  const syncId = "statsspecvaultidaaaaaaaaaa";
  const before = JSON.parse(await statsFile());
  const beforeHits = before.days[Object.keys(before.days)[0]].hits;

  const put = await fetch(`${BASE}/api/vault/${syncId}`, {
    method: "PUT",
    headers: {
      "X-Sync-Token": "0123456789abcdefghijklmn",
      "X-If-Version": "0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ vault: { blob: "ciphertext" } }),
  });
  expect(put.status).toBe(200);
  const get = await fetch(`${BASE}/api/vault/${syncId}`);
  expect(get.status).toBe(200);
  // An asset, too - only the document is a document.
  await load("/js/app.js");

  await openPage();
  const raw = await statsFile();
  const after = JSON.parse(raw);
  expect(after.days[Object.keys(after.days)[0]].hits).toBe(beforeHits);
  // The drift guard: a sync id is a capability secret. Not one byte of it.
  expect(raw).not.toContain(syncId);
  expect(raw).not.toContain("api/vault");
});

test("the wrong key is a plain 404, and the page never counts itself", async () => {
  const before = JSON.parse(await statsFile());
  const beforeHits = before.days[Object.keys(before.days)[0]].hits;

  for (const wrong of ["", "nope", `${KEY}x`, KEY.slice(0, -1)]) {
    const res = await fetch(`${BASE}/stats?k=${encodeURIComponent(wrong)}`);
    expect(res.status).toBe(404);
    // Byte-identical to the answer any unknown path gets.
    expect((await res.text()).trim()).toBe("not found");
  }
  // The old habit works too.
  expect((await fetch(`${BASE}/stats.php?k=${KEY}`)).status).toBe(200);

  await openPage();
  const after = JSON.parse(await statsFile());
  expect(after.days[Object.keys(after.days)[0]].hits).toBe(beforeHits);
});

test("the clear button empties the counters, and only with the key", async () => {
  const denied = await fetch(`${BASE}/stats?k=wrong`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "action=clear",
  });
  expect(denied.status).toBe(404);
  expect(JSON.parse(await statsFile()).days).not.toEqual({});

  const cleared = await fetch(`${BASE}/stats?k=${encodeURIComponent(KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "action=clear",
    redirect: "manual",
  });
  // Back to the page, so a refresh cannot repeat the wipe.
  expect(cleared.status).toBe(303);
  expect(cleared.headers.get("location")).toBe(`/stats?k=${encodeURIComponent(KEY)}`);
  expect(JSON.parse(await statsFile()).days).toEqual({});

  // And counting simply starts again.
  await load("/");
  await openPage();
  const stored = JSON.parse(await statsFile());
  expect(stored.days[Object.keys(stored.days)[0]].hits).toBe(1);
});
