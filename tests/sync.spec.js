// Zero-knowledge sync (stage 2).
//
// Two browser contexts stand in for two devices: the vault is created on A,
// adopted on B with the pairing code, and every claim of the design is checked
// against the real server on disk - the blob must be unreadable, the write
// token must exist only as a hash, an unknown id must not touch the file
// system, and two devices that edited while offline must both keep their work.
//
// Nothing here is stubbed: real PBKDF2, real WebCrypto, real files. That is
// why the timeouts are generous.
import { test, expect } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Must match playwright.config.js webServer.env - the suite runs against its
// own server instance with a throwaway data dir.
const DATA_DIR = join(tmpdir(), "tenfold-test-data");
const VAULT_DIR = join(DATA_DIR, "vaults");

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

test.describe.configure({ mode: "parallel", timeout: 240_000 });

// ------------------------------------------------------------------ helpers

async function freshApp(page) {
  await page.setViewportSize(PHONE);
  await page.goto("/web/index.html");
  await page.evaluate(
    () =>
      new Promise((done) => {
        localStorage.clear();
        const req = indexedDB.deleteDatabase("tenfold");
        req.onsuccess = req.onerror = req.onblocked = () => done();
      }),
  );
  await page.reload();
  await page.waitForSelector(".screen");
}

/** Walk the first run to a usable outline (the About intro appears once). */
async function setupVault(page) {
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 60000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start empty/ }).click();
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
}

async function addRoots(page, titles) {
  await page.getByRole("button", { name: /Write the first one|New entry/ }).click();
  for (const title of titles) {
    await page.locator(".composer input").fill(title);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
}

async function openSettings(page) {
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.locator(".h-title")).toHaveText("Settings");
}

/** Turns sync on and returns { code, id } as shown in the pairing sheet. */
async function enableSync(page) {
  await openSettings(page);
  await page.getByRole("button", { name: /Turn on sync/ }).click();
  await expect(page.locator(".setrow-label").filter({ hasText: "In sync" })).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("button", { name: /Pairing code/ }).click();
  const groups = await page.locator(".sheet .keygrid span").allTextContents();
  const link = await page.locator(".sheet input").inputValue();
  await page.locator(".sheet-foot").getByRole("button", { name: "Close" }).click();
  await page.locator(".head-actions").getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  const code = groups.join("-");
  return { code, id: code.replace(/-/g, ""), link };
}

/** Fetches a vault on a fresh device and unlocks it. */
async function adoptAndUnlock(page, code) {
  await page.getByRole("button", { name: "Open from another device" }).click();
  await page.locator(".input.is-mono").fill(code);
  await page.getByRole("button", { name: /Fetch the vault/ }).click();
  await expect(page.locator(".lock-title")).toHaveText("Locked", { timeout: 30000 });
  await page.locator(".lock input").fill(PASS);
  await page.getByRole("button", { name: /Unlock/ }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 60000 });
}

async function unlockAgain(page) {
  await page.reload();
  await expect(page.locator(".lock-title")).toHaveText("Locked");
  await page.locator(".lock input").fill(PASS);
  await page.getByRole("button", { name: /Unlock/ }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 60000 });
}

async function serverVersion(request, id) {
  const res = await request.get(`/api/vault/${id}`);
  if (!res.ok()) return 0;
  const body = await res.json();
  return body.version;
}

function randomId() {
  const alphabet = "23456789abcdefghjkmnpqrstvwxyz";
  let out = "";
  for (let i = 0; i < 26; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function filesUnder(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else out.push(full);
  }
  return out;
}

// -------------------------------------------------------------------- specs

test("a second device opens the same vault with the pairing code", async ({ browser }) => {
  const deviceA = await browser.newContext({ viewport: PHONE });
  const a = await deviceA.newPage();
  await freshApp(a);
  await setupVault(a);
  await addRoots(a, ["Ship the sync layer"]);
  const { code, link } = await enableSync(a);

  expect(code).toMatch(/^[a-z0-9]{4}(-[a-z0-9]{2,4}){5,6}$/);
  expect(link).toContain(`#s=${code.replace(/-/g, "")}`);

  const deviceB = await browser.newContext({ viewport: PHONE });
  const b = await deviceB.newPage();
  await freshApp(b);
  await adoptAndUnlock(b, code);
  await expect(b.locator(".row-title")).toHaveText(["Ship the sync layer"]);

  await deviceA.close();
  await deviceB.close();
});

test("a pairing link adopts the vault and leaves no code in the address bar", async ({ browser }) => {
  const deviceA = await browser.newContext({ viewport: PHONE });
  const a = await deviceA.newPage();
  await freshApp(a);
  await setupVault(a);
  await addRoots(a, ["Written on A"]);
  const { link, id } = await enableSync(a);

  const deviceB = await browser.newContext({ viewport: PHONE });
  const b = await deviceB.newPage();
  await freshApp(b);
  await b.goto(link);

  await expect(b.locator(".lock-title")).toHaveText("Locked", { timeout: 30000 });
  // The fragment carried a capability; it is gone the moment it was read.
  expect(await b.evaluate(() => location.hash)).toBe("");
  expect(b.url()).not.toContain(id);

  await b.locator(".lock input").fill(PASS);
  await b.getByRole("button", { name: /Unlock/ }).click();
  await expect(b.locator(".row-title")).toHaveText(["Written on A"], { timeout: 60000 });

  await deviceA.close();
  await deviceB.close();
});

test("turning sync off stops the pushing and keeps the server copy", async ({ browser, request }) => {
  const deviceA = await browser.newContext({ viewport: PHONE });
  const a = await deviceA.newPage();
  await freshApp(a);
  await setupVault(a);
  await addRoots(a, ["Before the switch"]);
  const { id } = await enableSync(a);
  const version = await serverVersion(request, id);
  expect(version).toBeGreaterThan(0);

  await openSettings(a);
  await a.getByRole("button", { name: /Turn sync off/ }).click();
  await a.locator(".sheet-foot").getByRole("button", { name: /Turn sync off/ }).click();
  await expect(a.getByRole("button", { name: /Turn on sync/ })).toBeVisible();

  // The local vault forgot the sync metadata ...
  const meta = await a.evaluate(async () => {
    const store = await import("/web/js/store.js");
    const vault = await store.loadVault();
    return vault ? vault.sync || null : null;
  });
  expect(meta).toBeNull();

  // ... nothing is pushed any more ...
  await a.locator(".head-actions").getByRole("button", { name: "Close" }).click();
  await addRoots(a, ["After the switch"]);
  await a.waitForTimeout(6000);
  expect(await serverVersion(request, id)).toBe(version);

  // ... and the encrypted copy is still there for the other devices.
  const still = await request.get(`/api/vault/${id}`);
  expect(still.status()).toBe(200);

  await deviceA.close();
});

test("an edit on one device shows up on the other after unlocking", async ({ browser, request }) => {
  const deviceA = await browser.newContext({ viewport: PHONE });
  const a = await deviceA.newPage();
  await freshApp(a);
  await setupVault(a);
  await addRoots(a, ["First goal"]);
  const { code, id } = await enableSync(a);

  const deviceB = await browser.newContext({ viewport: PHONE });
  const b = await deviceB.newPage();
  await freshApp(b);
  await adoptAndUnlock(b, code);
  await expect(b.locator(".row-title")).toHaveText(["First goal"]);

  const before = await serverVersion(request, id);
  await addRoots(a, ["Second goal"]);
  // The push is debounced by three seconds and then coalesced.
  await expect
    .poll(() => serverVersion(request, id), { timeout: 60000, intervals: [1000] })
    .toBeGreaterThan(before);

  await unlockAgain(b);
  await expect(b.locator(".row-title")).toHaveText(["First goal", "Second goal"], {
    timeout: 30000,
  });

  await deviceA.close();
  await deviceB.close();
});

test("two devices that edited offline both keep their work", async ({ browser, request }) => {
  const deviceA = await browser.newContext({ viewport: PHONE });
  const a = await deviceA.newPage();
  await freshApp(a);
  await setupVault(a);
  await addRoots(a, ["Shared goal"]);
  const { code, id } = await enableSync(a);

  const deviceB = await browser.newContext({ viewport: PHONE });
  const b = await deviceB.newPage();
  await freshApp(b);
  await adoptAndUnlock(b, code);
  await expect(b.locator(".row-title")).toHaveText(["Shared goal"]);

  // Both devices lose the mailbox and write anyway.
  const block = (route) => route.abort();
  await deviceA.route("**/api/vault/**", block);
  await deviceB.route("**/api/vault/**", block);
  await addRoots(a, ["Only on A"]);
  await addRoots(b, ["Only on B"]);
  await a.waitForTimeout(4000);
  await b.waitForTimeout(4000);

  const offline = await serverVersion(request, id);

  // A comes back first and wins the version race.
  await deviceA.unroute("**/api/vault/**", block);
  await expect
    .poll(() => serverVersion(request, id), { timeout: 60000, intervals: [1000] })
    .toBeGreaterThan(offline);
  const afterA = await serverVersion(request, id);

  // B comes back, is refused with 409, merges locally and pushes the union.
  await deviceB.unroute("**/api/vault/**", block);
  await expect
    .poll(() => serverVersion(request, id), { timeout: 90000, intervals: [1000] })
    .toBeGreaterThan(afterA);

  // Both edits are on B now. The two newcomers share a rank, so their order
  // among themselves is decided by id - the test asserts the set, not the
  // sequence, and that the untouched first goal stays first.
  await expect
    .poll(() => b.locator(".row-title").allTextContents(), { timeout: 60000, intervals: [1000] })
    .toEqual(expect.arrayContaining(["Shared goal", "Only on A", "Only on B"]));
  expect((await b.locator(".row-title").allTextContents())[0]).toBe("Shared goal");

  // A picks the merge up on its next unlock.
  await unlockAgain(a);
  await expect
    .poll(() => a.locator(".row-title").allTextContents(), { timeout: 60000, intervals: [1000] })
    .toEqual(expect.arrayContaining(["Shared goal", "Only on A", "Only on B"]));

  await deviceA.close();
  await deviceB.close();
});

test("what lands on disk is ciphertext and a token hash, nothing else", async ({ browser }) => {
  const deviceA = await browser.newContext({ viewport: PHONE });
  const a = await deviceA.newPage();

  // The write token never leaves the browser except as a request header - so
  // that is where the test takes it from.
  let token = "";
  a.on("request", (req) => {
    const value = req.headers()["x-sync-token"];
    if (value) token = value;
  });

  const canary = "CANARY-SYNC-31337-do-not-store-me";
  await freshApp(a);
  await setupVault(a);
  await addRoots(a, [canary]);
  const { id } = await enableSync(a);

  expect(token.length).toBeGreaterThan(20);

  const files = await filesUnder(join(VAULT_DIR, id));
  expect(files.length).toBeGreaterThan(0);
  let hashSeen = false;
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  for (const file of files) {
    const raw = await readFile(file);
    const text = raw.toString("binary");
    expect(text.includes(canary), `${file} contains the canary`).toBe(false);
    expect(text.includes(PASS), `${file} contains the passphrase`).toBe(false);
    expect(text.includes(token), `${file} contains the write token`).toBe(false);
    if (text.includes(tokenHash)) hashSeen = true;
  }
  // Only the hash is kept - which is what makes a stolen data dir useless for
  // writing and useless for reading.
  expect(hashSeen).toBe(true);

  await deviceA.close();
});

test("a wrong or missing token cannot overwrite a blob", async ({ request }) => {
  const id = randomId();
  const token = "a-token-that-is-long-enough-1234";
  const first = await request.put(`/api/vault/${id}`, {
    headers: { "X-Sync-Token": token, "X-If-Version": "0" },
    data: { vault: { magic: "TENFOLD1", marker: "original" } },
  });
  expect(first.status()).toBe(200);
  expect((await first.json()).version).toBe(1);

  const noToken = await request.put(`/api/vault/${id}`, {
    headers: { "X-If-Version": "1" },
    data: { vault: { magic: "TENFOLD1", marker: "forged" } },
  });
  expect(noToken.status()).toBe(401);

  const wrongToken = await request.put(`/api/vault/${id}`, {
    headers: { "X-Sync-Token": "a-different-token-entirely-9999", "X-If-Version": "1" },
    data: { vault: { magic: "TENFOLD1", marker: "forged" } },
  });
  expect(wrongToken.status()).toBe(401);

  const after = await request.get(`/api/vault/${id}`);
  const body = await after.json();
  expect(body.version).toBe(1);
  expect(body.vault.marker).toBe("original");
});

test("unknown ids answer 404 and malformed ids never reach the file system", async ({ request }) => {
  const missing = await request.get(`/api/vault/${randomId()}`);
  expect(missing.status()).toBe(404);

  const bad = [
    "../../../etc/passwd",
    "..%2f..%2fetc%2fpasswd",
    "ABCDEFGHJKMNPQRSTVWXYZ2345",
    "short",
    "abcdefghjkmnpqrstvwxyz234%00",
    ".%2e%2f.tenfold-data",
  ];
  for (const id of bad) {
    const res = await request.get(`/api/vault/${id}`);
    expect([400, 404], `GET /api/vault/${id}`).toContain(res.status());
    const put = await request.put(`/api/vault/${id}`, {
      headers: { "X-Sync-Token": "a-token-that-is-long-enough-1234", "X-If-Version": "0" },
      data: { vault: { magic: "TENFOLD1" } },
    });
    expect([400, 404, 405], `PUT /api/vault/${id}`).toContain(put.status());
  }

  // Nothing outside the id-shaped directories was created.
  const dirs = await readdir(VAULT_DIR).catch(() => []);
  const strange = dirs.filter((name) => !/^[a-z0-9]{26}$/.test(name));
  expect(strange).toEqual([]);
});

test("the server keeps at most ten records per id", async ({ request }) => {
  const id = randomId();
  const token = "a-token-that-is-long-enough-1234";
  for (let version = 0; version < 14; version += 1) {
    const res = await request.put(`/api/vault/${id}`, {
      headers: { "X-Sync-Token": token, "X-If-Version": String(version) },
      data: { vault: { magic: "TENFOLD1", n: version } },
    });
    expect(res.status()).toBe(200);
  }
  const files = await readdir(join(VAULT_DIR, id));
  expect(files.length).toBeLessThanOrEqual(10);
  expect(files).toContain("current.json");

  const current = await request.get(`/api/vault/${id}`);
  const body = await current.json();
  expect(body.version).toBe(14);
  expect(body.vault.n).toBe(13);
});

test("an oversized blob is refused", async ({ request }) => {
  const id = randomId();
  const res = await request.put(`/api/vault/${id}`, {
    headers: { "X-Sync-Token": "a-token-that-is-long-enough-1234", "X-If-Version": "0" },
    data: { vault: { magic: "TENFOLD1", filler: "x".repeat(5 * 1024 * 1024) } },
  });
  expect(res.status()).toBe(413);
  const after = await request.get(`/api/vault/${id}`);
  expect(after.status()).toBe(404);
});

// --------------------------------------------------------------- source rules

test("sync.js is the only module that reaches the network", async () => {
  const dir = join(ROOT, "web", "js");
  const walk = async (base) => {
    const out = [];
    for (const entry of await readdir(base, { withFileTypes: true })) {
      const full = join(base, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else if (entry.name.endsWith(".js")) out.push(full);
    }
    return out;
  };
  const strip = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const offenders = [];
  for (const file of await walk(dir)) {
    const code = strip(await readFile(file, "utf8"));
    const reaches = /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|navigator\.sendBeacon|EventSource/.test(
      code,
    );
    if (reaches && !file.endsWith(join("web", "js", "sync.js"))) offenders.push(file.replace(ROOT, ""));
  }
  expect(offenders).toEqual([]);

  const sync = strip(await readFile(join(dir, "sync.js"), "utf8"));
  const urls = [...sync.matchAll(/fetch\s*\(\s*([^,)]+)/g)].map((m) => m[1].trim());
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) expect(url).toMatch(/endpoint\(/);
  // The endpoint builder only ever produces same-origin /api/vault paths.
  expect(sync).toMatch(/API_BASE\s*=\s*location\.pathname/);
  expect(sync).not.toMatch(/https?:\/\//);
});

test("the server has no key material, no cipher and no decrypt path", async () => {
  const source = await readFile(join(ROOT, "tools", "serve.js"), "utf8");
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const forbidden = [
    /require\(\s*["']crypto["']\s*\)/,
    /from\s+["']node:crypto["']/,
    /createDecipher/,
    /createCipher/,
    /pbkdf2/i,
    /deriveKey/,
    /deriveBits/,
    /\bdecrypt\b/,
    /masterKey/,
    /passphrase/,
    /AES-GCM/,
  ];
  const hits = forbidden.filter((rx) => rx.test(stripped)).map(String);
  expect(hits).toEqual([]);
  // The one-way digest of the write token is all the hashing there is.
  expect(stripped.match(/subtle\./g) || []).toHaveLength(1);
  expect(stripped).toMatch(/subtle\.digest\("SHA-256"/);
});
