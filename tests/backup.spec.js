// The backup decision on the first run, and the quiet marker that follows it.
//
// The owner's concern, in one sentence: clearing the browser's site data
// deletes IndexedDB, and a vault with neither a server copy nor an export file
// is then simply gone. So the last step of the first run asks - with the copy
// preselected, never switched on behind the user's back - and a vault that
// answered "Not now" carries one quiet clause in the outline header until one
// of the two exists.
//
// Nothing here is stubbed: the sealed blob really travels to the test server,
// and it is read back off disk to prove it is still ciphertext.
import { test, expect } from "@playwright/test";

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

// Real WebCrypto: 600000 PBKDF2 rounds per unlock.
test.describe.configure({ mode: "parallel", timeout: 180_000 });

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

/** Walk the first run up to - and not past - the backup question. */
async function walkToBackup(page) {
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 60000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start empty/ }).click();
  await expect(page.locator(".eyebrow")).toHaveText("Backup");
}

/** Past the About intro and into the outline. */
async function enterApp(page) {
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 60000 });
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
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await expect(page.locator(".h-title")).toHaveText("Settings");
}

async function closeSettings(page) {
  await page.locator(".head-actions").getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
}

/** The sync id off the stored vault - non-secret metadata, so this is honest. */
async function syncIdOf(page) {
  return page.evaluate(async () => {
    const store = await import("/web/js/store.js");
    const vault = await store.loadVault();
    return vault && vault.sync ? vault.sync.id : null;
  });
}

const marker = (page) => page.locator(".h-sub").filter({ hasText: "only in this browser" });

// -------------------------------------------------------------------- specs

test("the first run asks about the backup and preselects nothing silently", async ({ page }) => {
  await freshApp(page);
  await walkToBackup(page);

  await expect(page.locator(".h-title")).toHaveText("One copy is fragile");
  // Both answers are on screen, and the copy is the primary one.
  const keep = page.getByRole("button", { name: "Keep an encrypted copy on the server" });
  await expect(keep).toBeVisible();
  await expect(keep).toHaveClass(/is-primary/);
  await expect(page.getByRole("button", { name: "Not now" })).toBeVisible();

  // Nothing has been switched on just by arriving here.
  expect(await syncIdOf(page)).toBeNull();
});

test("choosing the copy turns sync on and the server holds a sealed vault", async ({ page, request }) => {
  await freshApp(page);
  await walkToBackup(page);
  await page.getByRole("button", { name: "Keep an encrypted copy on the server" }).click();
  await enterApp(page);

  // The vault now carries its sync metadata, and the marker is not there.
  const id = await syncIdOf(page);
  expect(id).toMatch(/^[a-z0-9]{26}$/);
  await expect(marker(page)).toHaveCount(0);

  await addRoots(page, ["CANARY-BACKUP-9021"]);
  // The debounced push is 3 s after the save; poll rather than guess.
  await expect
    .poll(async () => (await request.get(`/api/vault/${id}`)).status(), { timeout: 30000 })
    .toBe(200);
  const body = await (await request.get(`/api/vault/${id}`)).json();
  expect(body.vault.magic).toBe("TENFOLD1");
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/vault/${id}`);
        const data = await res.json();
        return JSON.stringify(data).includes("CANARY-BACKUP-9021");
      },
      { timeout: 30000 },
    )
    .toBe(false);
  // The settings screen agrees: sync is on, not merely attempted.
  await openSettings(page);
  await expect(page.getByRole("button", { name: /Turn sync off/ })).toBeVisible();
});

test("Not now lands on the outline with the only-in-this-browser marker", async ({ page }) => {
  await freshApp(page);
  await walkToBackup(page);
  await page.getByRole("button", { name: "Not now" }).click();
  await enterApp(page);

  await expect(marker(page)).toBeVisible();
  // In that state the line is a button that leads where the fix lives.
  const sub = page.locator("button.h-sub");
  await expect(sub).toHaveAttribute("aria-label", /only in this browser/);
  await sub.click();
  await expect(page.locator(".h-title")).toHaveText("Settings");
  // And sync really is off - the marker is not decoration.
  await expect(page.getByRole("button", { name: /Turn on sync/ })).toBeVisible();
  expect(await syncIdOf(page)).toBeNull();
});

test("turning sync on from settings clears the marker", async ({ page }) => {
  await freshApp(page);
  await walkToBackup(page);
  await page.getByRole("button", { name: "Not now" }).click();
  await enterApp(page);
  await expect(marker(page)).toBeVisible();

  await openSettings(page);
  await page.getByRole("button", { name: /Turn on sync/ }).click();
  await expect(page.locator(".setrow-label").filter({ hasText: "In sync" })).toBeVisible({
    timeout: 30000,
  });
  await closeSettings(page);

  await expect(marker(page)).toHaveCount(0);
});

test("an export clears the marker, and the stamp survives a lock", async ({ page }) => {
  await freshApp(page);
  await walkToBackup(page);
  await page.getByRole("button", { name: "Not now" }).click();
  await enterApp(page);
  await addRoots(page, ["Something worth keeping"]);
  await expect(marker(page)).toBeVisible();

  await openSettings(page);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /Export the encrypted vault/ }).click();
  await (await download).path();
  await closeSettings(page);

  await expect(marker(page)).toHaveCount(0);
  // exportedAt lives in doc.settings, so it is sealed into the vault: a lock
  // and a fresh unlock must not bring the marker back.
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.locator(".lock-title")).toHaveText("Locked");
  await page.locator(".lock input").fill(PASS);
  await page.getByRole("button", { name: /Unlock/ }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 60000 });
  await expect(marker(page)).toHaveCount(0);
  // Sync stayed off throughout - the export is the other way to be safe.
  expect(await syncIdOf(page)).toBeNull();
});
