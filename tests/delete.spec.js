// Deleting the vault everywhere.
//
// The lock-screen reset only ever wiped the device; the encrypted copy on the
// server outlived it. This file covers the way out that leaves nothing behind:
// the DELETE endpoint (which insists on the key-derived write token from EVERY
// caller, loopback included), and the settings flow that destroys the server
// copy first and this device afterwards - or stops and says so when the server
// could not be reached, because half a deletion is the one outcome nobody can
// recover from.
import { test, expect } from "@playwright/test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Must match playwright.config.js webServer.env.
const DATA_DIR = join(tmpdir(), "tenfold-test-data");
const VAULT_DIR = join(DATA_DIR, "vaults");

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };
const TOKEN = "a-token-that-is-long-enough-1234";

test.describe.configure({ mode: "parallel", timeout: 240_000 });

// ------------------------------------------------------------------ helpers

function randomId() {
  const alphabet = "23456789abcdefghjkmnpqrstvwxyz";
  let out = "";
  for (let i = 0; i < 26; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/** A fake tunnel IP. Unique per call, so one test cannot rate-limit another. */
function forgedIp() {
  return `203.0.113.${Math.floor(Math.random() * 200) + 10}`;
}

async function dirNames() {
  return readdir(VAULT_DIR).catch(() => []);
}

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

async function setupVault(page) {
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 60000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start empty/ }).click();
  await page.getByRole("button", { name: "Not now" }).click();
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

async function enableSync(page) {
  await openSettings(page);
  await page.getByRole("button", { name: /Turn on sync/ }).click();
  await expect(page.locator(".setrow-label").filter({ hasText: "In sync" })).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("button", { name: /Pairing code/ }).click();
  const groups = await page.locator(".sheet .keygrid span").allTextContents();
  await page.locator(".sheet-foot").getByRole("button", { name: "Close" }).click();
  const code = groups.join("-");
  return { code, id: code.replace(/-/g, "") };
}

/** Runs the whole delete-everywhere flow from the open settings screen. */
async function deleteEverywhere(page) {
  await page.getByRole("button", { name: "Delete the vault everywhere" }).click();
  await expect(page.locator(".sheet-title")).toHaveText("Delete everywhere?");
  const confirm = page.locator(".sheet-foot").getByRole("button", { name: "Delete everywhere" });
  // The primary stays out of reach until the acknowledgement is ticked.
  await expect(confirm).toBeDisabled();
  await page.locator(".sheet .check").click();
  await expect(confirm).toBeEnabled();
  await confirm.click();
}

// ------------------------------------------------------------------- server

test("deleting needs the write token - from the tunnel and from loopback alike", async ({ request }) => {
  const id = randomId();
  const created = await request.put(`/api/vault/${id}`, {
    headers: { "X-Sync-Token": TOKEN, "X-If-Version": "0" },
    data: { vault: { magic: "TENFOLD1", marker: "original" } },
  });
  expect(created.status()).toBe(200);

  // No token, coming through the tunnel.
  const forged = await request.delete(`/api/vault/${id}`, {
    headers: { "cf-connecting-ip": forgedIp() },
  });
  expect(forged.status()).toBe(401);

  // No token, coming from this machine. The loopback exemption that lets a
  // local caller create a vault does NOT extend to destroying one: a stray
  // local script must not be able to destroy what it cannot open.
  const local = await request.delete(`/api/vault/${id}`);
  expect(local.status()).toBe(401);

  // A token that belongs to somebody else.
  const wrong = await request.delete(`/api/vault/${id}`, {
    headers: { "X-Sync-Token": "a-different-token-entirely-9999" },
  });
  expect(wrong.status()).toBe(401);

  // Three refusals later the blob is untouched.
  const still = await request.get(`/api/vault/${id}`);
  expect(still.status()).toBe(200);
  expect((await still.json()).vault.marker).toBe("original");
  expect(await dirNames()).toContain(id);
});

test("the right token takes the whole directory - history, push and all", async ({ request }) => {
  const id = randomId();
  // Several versions, so there is a history to destroy as well.
  for (let version = 0; version < 4; version += 1) {
    const res = await request.put(`/api/vault/${id}`, {
      headers: { "X-Sync-Token": TOKEN, "X-If-Version": String(version) },
      data: { vault: { magic: "TENFOLD1", n: version } },
    });
    expect(res.status()).toBe(200);
  }
  // And a reminder subscription, which lives in the same directory.
  const subscribed = await request.post("/api/push/subscribe", {
    headers: { "X-Sync-Token": TOKEN },
    data: { syncId: id, sub: { endpoint: "http://127.0.0.1:7798/sink-delete" }, hourUtc: 8 },
  });
  expect(subscribed.status()).toBe(204);

  const before = await readdir(join(VAULT_DIR, id));
  expect(before).toContain("current.json");
  expect(before).toContain("push.json");
  expect(before.filter((name) => /^v\d+\.json$/.test(name)).length).toBeGreaterThan(0);

  const gone = await request.delete(`/api/vault/${id}`, { headers: { "X-Sync-Token": TOKEN } });
  expect(gone.status()).toBe(204);

  // Nothing on disk, and nothing renamed into a leftover either.
  await expect(readdir(join(VAULT_DIR, id))).rejects.toThrow();
  expect(await dirNames()).not.toContain(id);
  const residue = (await readdir(DATA_DIR).catch(() => [])).filter((name) => name.startsWith(`gone-${id}`));
  expect(residue).toEqual([]);

  // Deletion is destruction, not a tombstone: the record is simply not there.
  expect((await request.delete(`/api/vault/${id}`, { headers: { "X-Sync-Token": TOKEN } })).status()).toBe(404);
  expect((await request.get(`/api/vault/${id}`)).status()).toBe(404);
});

test("after a deletion the id is free again for any token", async ({ request }) => {
  const id = randomId();
  expect(
    (
      await request.put(`/api/vault/${id}`, {
        headers: { "X-Sync-Token": TOKEN, "X-If-Version": "0" },
        data: { vault: { magic: "TENFOLD1", marker: "first" } },
      })
    ).status(),
  ).toBe(200);
  expect((await request.delete(`/api/vault/${id}`, { headers: { "X-Sync-Token": TOKEN } })).status()).toBe(204);

  // Trust on first use, from scratch: a token that would have been refused a
  // moment ago now registers the id as a brand-new mailbox.
  const again = await request.put(`/api/vault/${id}`, {
    headers: { "X-Sync-Token": "a-completely-fresh-token-55555", "X-If-Version": "0" },
    data: { vault: { magic: "TENFOLD1", marker: "second" } },
  });
  expect(again.status()).toBe(200);
  expect((await again.json()).version).toBe(1);

  const now = await request.get(`/api/vault/${id}`);
  expect((await now.json()).vault.marker).toBe("second");

  // And the old token has no standing any more.
  expect((await request.delete(`/api/vault/${id}`, { headers: { "X-Sync-Token": TOKEN } })).status()).toBe(401);
});

test("deleting an id that was never used answers 404", async ({ request }) => {
  const res = await request.delete(`/api/vault/${randomId()}`, { headers: { "X-Sync-Token": TOKEN } });
  expect(res.status()).toBe(404);
});

// ---------------------------------------------------------------------- e2e

test("delete everywhere takes the server copy and the whole device", async ({ browser, request }) => {
  const device = await browser.newContext({ viewport: PHONE });
  const page = await device.newPage();
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Something worth keeping"]);
  const { id } = await enableSync(page);
  expect((await request.get(`/api/vault/${id}`)).status()).toBe(200);

  // A biometric enrolment is device-local: two non-secret pointers in
  // localStorage. They have to go with everything else.
  await page.evaluate(() =>
    localStorage.setItem(
      "tenfold.webauthn",
      JSON.stringify({ credentialId: "AAAABBBBCCCC", salt: "ZGVtby1zYWx0" }),
    ),
  );

  await deleteEverywhere(page);

  // One quiet word, the same as every other finished action ...
  await expect(page.locator("#toast")).toContainText("Deleted.", { timeout: 30000 });
  // ... the way out lands on the first-run screen ...
  await expect(page.getByRole("button", { name: "Set up the vault" })).toBeVisible({ timeout: 30000 });
  // ... the encrypted copy is gone from the server, directory and all ...
  await expect
    .poll(async () => (await request.get(`/api/vault/${id}`)).status(), { timeout: 30000, intervals: [500] })
    .toBe(404);
  expect(await dirNames()).not.toContain(id);

  // ... nothing local survived, not even the biometric pointers ...
  const leftovers = await page.evaluate(async () => {
    const store = await import("/web/js/store.js");
    return {
      vault: await store.loadVault(),
      webauthn: localStorage.getItem("tenfold.webauthn"),
      push: localStorage.getItem("tenfold.push"),
      ui: localStorage.getItem("tenfold.ui"),
    };
  });
  expect(leftovers.vault).toBeNull();
  expect(leftovers.webauthn).toBeNull();
  expect(leftovers.push).toBeNull();
  // The presentation preferences are not personal and are allowed to stay.
  expect(leftovers.ui).not.toBeNull();

  // ... and a reload finds a first run, not a lock screen.
  await page.reload();
  await expect(page.getByRole("button", { name: "Set up the vault" })).toBeVisible({ timeout: 30000 });

  await device.close();
});

test("a server that cannot be reached stops the deletion instead of halving it", async ({
  browser,
  request,
}) => {
  const device = await browser.newContext({ viewport: PHONE });
  const page = await device.newPage();
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Still here afterwards"]);
  const { id } = await enableSync(page);

  // Only the deletion is cut off; everything else still reaches the mailbox.
  await device.route("**/api/vault/**", (route) =>
    route.request().method() === "DELETE" ? route.abort() : route.continue(),
  );

  await deleteEverywhere(page);

  // The honest answer, and the smaller action offered next to it. Scoped by
  // the dialog's own label: the sheet it replaced is still animating out.
  const failed = page.locator('.sheet[aria-label="The server copy is still there"]');
  await expect(failed).toBeVisible({ timeout: 30000 });
  await expect(failed).toContainText("the encrypted copy was not deleted");
  await expect(failed.getByRole("button", { name: "Delete only on this device" })).toBeVisible();
  await failed.locator(".iconbtn").click();

  // Nothing was destroyed: the server still holds the copy ...
  expect((await request.get(`/api/vault/${id}`)).status()).toBe(200);
  expect(await dirNames()).toContain(id);
  // ... and the vault is still on this device, unlocked, where it was.
  await expect(page.locator(".h-title")).toHaveText("Settings");
  const vault = await page.evaluate(async () => {
    const store = await import("/web/js/store.js");
    return await store.loadVault();
  });
  expect(vault).not.toBeNull();

  await page.reload();
  await expect(page.locator(".lock-title")).toHaveText("Locked", { timeout: 30000 });

  await device.close();
});

test("without sync the flow deletes the device and says there is no server copy", async ({ browser }) => {
  const device = await browser.newContext({ viewport: PHONE });
  const page = await device.newPage();
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Local only"]);
  await openSettings(page);

  await page.getByRole("button", { name: "Delete the vault everywhere" }).click();
  await expect(page.locator(".sheet")).toContainText("Sync is off on this device");
  await page.locator(".sheet .check").click();
  await page.locator(".sheet-foot").getByRole("button", { name: "Delete everywhere" }).click();

  await expect(page.getByRole("button", { name: "Set up the vault" })).toBeVisible({ timeout: 30000 });
  await page.reload();
  await expect(page.getByRole("button", { name: "Set up the vault" })).toBeVisible({ timeout: 30000 });

  await device.close();
});
