// UI: the first run, the four screens the app is actually made of, and the
// two rules that must never break - no plaintext outside memory, no HTML built
// from user content.
//
// These specs drive the real app at iPhone size against the real WebCrypto and
// IndexedDB. Nothing is stubbed, which is why the setup helper is slow: it
// pays for 600000 PBKDF2 rounds, on purpose.
import { test, expect } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

const TITLES = [
  "Pay off the remaining debt",
  "Make the company sellable",
  "Run ten kilometres again",
  "Sort things out with Anna",
  "See my father regularly",
  "A back that stops hurting",
  "Spanish up to B2",
  "Will and provisions settled",
  "Finish the workshop",
  "Less screen time in the evening",
];

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

/** Walk the first run to a usable outline. Returns the recovery key. */
async function setupVault(page, { frame = false } = {}) {
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 30000 });
  const key = (await page.locator(".keygrid span").allTextContents()).join("-");
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: frame ? /Start with a frame/ : /Start empty/ }).click();
  // The backup step asks before anything is uploaded; sync stays off here.
  await page.getByRole("button", { name: "Not now" }).click();
  // First entry into a vault offers the About text once; dismiss it.
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  return key;
}

async function addRoots(page, titles) {
  await page.getByRole("button", { name: /Write the first one|New entry/ }).click();
  for (const title of titles) {
    await page.locator(".composer input").fill(title);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
}

// Real WebCrypto means two 600000-round PBKDF2 derivations per unlock; the
// default 30 s budget is not enough for the specs that lock and unlock.
test.describe.configure({ mode: "parallel", timeout: 90_000 });

test("the app boots into the first run screen without console errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await freshApp(page);

  await expect(page.getByRole("button", { name: "Set up the vault" })).toBeVisible();
  await expect(page.locator(".lock-title")).toContainText("Ten goals");
  // The phone frame must not scroll sideways at the reference width.
  const overflow = await page.evaluate(() => document.body.scrollWidth - document.body.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test("setup writes an encrypted vault and nothing else", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["CANARY-UI-4711"]);
  // Give the debounced autosave time to seal and store.
  await page.waitForTimeout(1200);

  const r = await page.evaluate(async () => {
    const store = await import("/web/js/store.js");
    const vault = await store.loadVault();
    return { vault, json: JSON.stringify(vault) };
  });

  expect(r.vault).toBeTruthy();
  expect(r.vault.magic).toBe("TENFOLD1");
  expect(Array.isArray(r.vault.wrappers)).toBe(true);
  expect(r.vault.wrappers.length).toBeGreaterThanOrEqual(2);
  // The whole point: the title must not be findable in what was persisted.
  expect(r.json).not.toContain("CANARY-UI-4711");
  expect(r.json).not.toContain("nodes");
});

test("the recovery key is shown once and is gated by an acknowledgement", async ({ page }) => {
  await freshApp(page);
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 30000 });

  const groups = await page.locator(".keygrid span").allTextContents();
  expect(groups).toHaveLength(7);
  for (const g of groups) expect(g).toMatch(/^[A-Z0-9]{4}$/);

  const go = page.getByRole("button", { name: "Continue" });
  await expect(go).toBeDisabled();
  await page.locator(".check").click();
  await expect(go).toBeEnabled();

  // The emergency sheet is offered here and nowhere else, and it does not
  // exist until it is asked for: the printable region is built on the click.
  expect(await page.locator("#paper").count()).toBe(0);
  await page.evaluate(() => {
    window.__printed = 0;
    // The real dialog would block the run for ever; the region is built before
    // print() is called, which is the part this test is about.
    window.print = () => {
      window.__printed += 1;
    };
  });
  await page.getByRole("button", { name: "Save the emergency sheet" }).click();
  await page.waitForSelector("#paper", { state: "attached" });
  expect(await page.evaluate(() => window.__printed)).toBe(1);

  const grouped = groups.join("-");
  // Both copies of the key are on the sheet: the grouped text a hand
  // transcribes, and the same string as a symbol a camera reads.
  expect(await page.locator("#paper").textContent()).toContain(grouped);
  await expect(page.locator("#paper .paper-qr path")).toHaveCount(1);
  const d = await page.locator("#paper .paper-qr path").getAttribute("d");
  expect(d.startsWith("M")).toBe(true);
  expect(d.length).toBeGreaterThan(100);

  await go.click();

  await expect(page.getByRole("button", { name: /Start empty/ })).toBeVisible();
  // Once acknowledged the key is gone from the DOM for good - the grid with
  // the repaint, and the printable region, which a repaint does not reach.
  expect(await page.locator(".keygrid").count()).toBe(0);
  expect(await page.locator("#paper").count()).toBe(0);
  expect(await page.locator("body").textContent()).not.toContain(grouped);
});

test("the emergency sheet prints as ONE page, on A4 and on Letter", async ({ page }) => {
  await freshApp(page);
  // The longest catalogues are the honest case - the owner's two-page print
  // was the Spanish sheet. The second page was BLANK: body{min-height:100dvh}
  // survived into print, and on iOS a body pinned to one full viewport inside
  // an 11mm-margined page box spills onto a second, empty sheet. Chromium
  // resolves dvh differently in its print engine and paginates ONE page either
  // way, so the page count below cannot catch that regression - the invariant
  // is asserted directly: under print media no viewport unit may survive on
  // the body's min-height.
  await page.emulateMedia({ media: "print" });
  const minHeight = await page.evaluate(() => getComputedStyle(document.body).minHeight);
  expect(["0px", "auto"]).toContain(minHeight);
  await page.emulateMedia({ media: null });
  for (const locale of ["es", "de"]) {
    await page.evaluate(async (loc) => {
      const i18n = await import("/web/js/i18n.js");
      i18n.setLocale(loc);
      const { emergencySheet, removeEmergencySheet } = await import("/web/js/ui/emergency.js");
      removeEmergencySheet();
      document.body.appendChild(
        emergencySheet("QRST-UVWX-YZ23-4567-ABCD-EFGH-JKLM"),
      );
    }, locale);
    for (const format of ["A4", "Letter"]) {
      const pdf = await page.pdf({
        format,
        margin: { top: "11mm", bottom: "11mm", left: "11mm", right: "11mm" },
      });
      const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) || []).length;
      expect(pages, `${locale} on ${format}`).toBe(1);
    }
  }
});

test("a passphrase shorter than ten characters is refused", async ({ page }) => {
  await freshApp(page);
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill("short");
  await page.locator('input[type="password"]').nth(1).fill("short");
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await expect(page.locator(".field-error")).toContainText("ten characters");
});

test("the frame template seeds eight editable areas", async ({ page }) => {
  await freshApp(page);
  await setupVault(page, { frame: true });
  await expect(page.locator(".row-shell")).toHaveCount(8);
  await expect(page.locator(".row-title").first()).toHaveText("Health and body");
});

test("ten nodes can be added and the eleventh is refused at the button", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES);

  await expect(page.locator(".row-shell")).toHaveCount(10);
  await expect(page.locator(".row-title").first()).toHaveText(TITLES[0]);
  await expect(page.locator(".row-title").last()).toHaveText(TITLES[9]);
  // Rank one is the only row that carries the accent.
  await expect(page.locator(".row.is-lead")).toHaveCount(1);

  // The cap is enforced where the entry is made: at ten living goals the
  // button is disabled, and a tap on it does nothing at all - no composer,
  // no toast, because the browser does not deliver a click to a disabled
  // button. Refusing afterwards with a message was the weaker answer.
  const add = page.getByRole("button", { name: /New entry/ });
  await expect(add).toBeDisabled();
  await add.click({ force: true });
  expect(await page.locator(".composer").count()).toBe(0);

  // Anything that brings the list back under ten opens it again on the next
  // repaint - here the row menu's Delete on the last goal.
  await page.locator(".row-shell").last().locator(".row").click({ button: "right" });
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator(".row-shell")).toHaveCount(9);
  await expect(page.getByRole("button", { name: /New entry/ })).toBeEnabled();
});

test("focus navigation zooms into a node, adds parts and comes back", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES.slice(0, 3));

  await page.locator(".row-shell").nth(2).locator(".row").click();
  await expect(page.locator(".hero-title")).toHaveText(TITLES[2]);
  await expect(page.locator(".hero-rank")).toContainText("3");

  await page.getByRole("button", { name: /Add the first part/ }).click();
  for (const part of ["Build a base", "Stabilise the knee"]) {
    await page.locator(".composer input").fill(part);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
  await expect(page.locator(".list.is-kids .row-shell")).toHaveCount(2);

  // A leaf opens its detail screen, a goal opens its own focus screen.
  await page.locator(".list.is-kids .row-shell").first().locator(".row").click();
  await expect(page.locator(".leaf-title")).toHaveText("Build a base");
  await page.locator(".crumb-back").click();
  await expect(page.locator(".hero-title")).toHaveText(TITLES[2]);

  await page.locator(".crumb-pill").first().click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  // The parent now shows its progress instead of nothing.
  await expect(page.locator(".row-shell").nth(2).locator(".m")).toHaveText("0/2");
});

test("a duel runs to the end and reorders the list", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma"]);

  await page.getByRole("button", { name: "Put in order" }).click();
  await expect(page.locator(".duel-card")).toHaveCount(2);
  await expect(page.locator(".duel-head h2")).toContainText("matters more");
  await expect(page.locator(".duel-head .h-sub")).toContainText("comparison");

  // Always choosing the newcomer reverses the list - deterministic by
  // construction, prioritize.js uses no randomness.
  for (let i = 0; i < 30; i += 1) {
    const b = page.locator(".duel-card.is-b");
    if (!(await b.count())) break;
    // The pick is acknowledged for a beat before the next pair paints, so the
    // clicked card outlives the click. Waiting on the NODE, not on its id: the
    // item being placed stays card B across a whole binary search.
    const node = await b.elementHandle();
    await b.click();
    await page.waitForFunction((el) => !el.isConnected, node);
  }

  await expect(page.getByRole("button", { name: "Take this order" })).toBeVisible();
  await page.getByRole("button", { name: "Take this order" }).click();

  await expect(page.locator(".h-title")).toHaveText("The Ten");
  await expect(page.locator(".row-title")).toHaveText(["Gamma", "Beta", "Alpha"]);
  await expect(page.locator(".h-sub")).toContainText("ordered");
});

// The duel screen after the owner's report from the phone: the A/B letters in
// the middle row were "very hard to see and to hit". The card itself is the
// button now, and the direction is drawn on the card that moves.

/**
 * A screen change is a View Transition, and while its snapshot overlay is up a
 * raw pointer press hit-tests against the overlay instead of the page - the
 * beam then never sees the drag. Locator clicks retry until they land; the
 * mouse API does not, so a hand-driven gesture waits for the real beam to be
 * the thing under the middle of the beam again.
 */
async function beamBox(page) {
  await page.waitForFunction(() => {
    const b = document.querySelector(".beam");
    if (!b) return false;
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!(hit && hit.closest(".beam"));
  });
  return page.locator(".beam").boundingBox();
}

test("a tap on the upper card ranks it above the lower one", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);

  await page.getByRole("button", { name: "Put in order" }).click();
  const a = page.locator(".duel-card.is-a");
  const b = page.locator(".duel-card.is-b");
  const titleA = await a.locator(".duel-card-title").textContent();
  const titleB = await b.locator(".duel-card-title").textContent();

  // The whole card is one control, and its name is the goal it carries.
  await expect(a).toHaveAttribute("role", "button");
  await expect(a).toHaveAttribute("aria-label", `Choose: ${titleA}`);

  // A plain tap, nowhere near a letter: the middle of the card.
  await a.click();
  await page.getByRole("button", { name: "Take this order" }).click();
  await expect(page.locator(".row-title")).toHaveText([titleA, titleB]);
});

test("a tap on the lower card ranks it above the upper one", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);

  await page.getByRole("button", { name: "Put in order" }).click();
  const titleA = await page.locator(".duel-card.is-a .duel-card-title").textContent();
  const titleB = await page.locator(".duel-card.is-b .duel-card-title").textContent();

  await page.locator(".duel-card.is-b").click();
  await page.getByRole("button", { name: "Take this order" }).click();
  await expect(page.locator(".row-title")).toHaveText([titleB, titleA]);
});

test("the cards take the keyboard: Enter picks, the arrow keys pick a side", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);
  await page.getByRole("button", { name: "Put in order" }).click();
  const titleA = await page.locator(".duel-card.is-a .duel-card-title").textContent();
  const titleB = await page.locator(".duel-card.is-b .duel-card-title").textContent();

  // Focus the upper card and press the key that means the LOWER one.
  await page.locator(".duel-card.is-a").focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "Take this order" }).click();
  await expect(page.locator(".row-title")).toHaveText([titleB, titleA]);

  // And Enter takes the card that has focus.
  await page.getByRole("button", { name: "Put in order" }).click();
  const upper = await page.locator(".duel-card.is-a .duel-card-title").textContent();
  const lower = await page.locator(".duel-card.is-b .duel-card-title").textContent();
  await page.locator(".duel-card.is-a").focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Take this order" }).click();
  await expect(page.locator(".row-title")).toHaveText([upper, lower]);
});

test("the faint middle hints are gone and each card carries its own arrow", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);
  await page.getByRole("button", { name: "Put in order" }).click();

  // The old row of "left-A" / "B-right" ghost buttons between the cards.
  await expect(page.locator(".duel-dirs")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose A", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose B", exact: true })).toHaveCount(0);

  // One thick arrow per card, on the edge that card is swiped towards, and
  // drawn rather than typed - no arrow character in any text node.
  await expect(page.locator(".duel-card .duel-arrow-glyph")).toHaveCount(2);
  const geometry = await page.evaluate(() => {
    const read = (sel) => {
      const card = document.querySelector(sel);
      const glyph = card.querySelector(".duel-arrow-glyph");
      const c = card.getBoundingClientRect();
      const g = glyph.getBoundingClientRect();
      return {
        width: Math.round(g.width),
        stroke: getComputedStyle(glyph).strokeWidth,
        // How far the arrow sits from the card's left edge, as a fraction.
        offset: (g.left + g.width / 2 - c.left) / c.width,
      };
    };
    return { a: read(".duel-card.is-a"), b: read(".duel-card.is-b"), text: document.body.innerText };
  });
  expect(geometry.a.width).toBeGreaterThanOrEqual(28);
  expect(parseFloat(geometry.a.stroke)).toBeGreaterThan(2);
  expect(geometry.a.offset).toBeLessThan(0.25);
  expect(geometry.b.offset).toBeGreaterThan(0.75);
  expect(geometry.text).not.toMatch(/[←→⟵⟶]/);
});

test("swiping still maps left to the upper card and right to the lower one", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);
  await page.getByRole("button", { name: "Put in order" }).click();

  const titleA = await page.locator(".duel-card.is-a .duel-card-title").textContent();
  const titleB = await page.locator(".duel-card.is-b .duel-card-title").textContent();

  const box = await beamBox(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy, { steps: 6 });
  // Past the commit distance: right is the lower card.
  await page.mouse.move(cx + 120, cy, { steps: 6 });
  await page.mouse.up();

  await page.getByRole("button", { name: "Take this order" }).click();
  await expect(page.locator(".row-title")).toHaveText([titleB, titleA]);
});

test("a swipe that falls short of the commit distance decides nothing", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma"]);
  await page.getByRole("button", { name: "Put in order" }).click();
  const before = await page.locator(".duel-head .h-sub").textContent();

  const box = await beamBox(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy, { steps: 6 });
  await page.mouse.move(cx + 62, cy, { steps: 6 });
  // The beam has to have felt the drag, or this proves nothing.
  await expect(page.locator(".scale")).toHaveClass(/is-dragging/);
  await page.mouse.up();
  await page.waitForTimeout(500);

  // The pull-back must not arrive as a tap on the card it was released over.
  await expect(page.locator(".duel-head .h-sub")).toHaveText(before);
  await expect(page.locator(".duel-card")).toHaveCount(2);
});

test("a step can be finished from the detail screen and reopened", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);
  await page.locator(".row-shell").first().locator(".row").click();
  await page.getByRole("button", { name: /Add the first part/ }).click();
  await page.locator(".composer input").fill("Call the practice");
  await page.locator(".composer input").press("Enter");
  await page.locator(".composer input").press("Escape");

  await page.locator(".list.is-kids .row-shell").first().locator(".row").click();
  await expect(page.locator(".leaf-title")).toHaveText("Call the practice");
  await page.getByRole("button", { name: "Mark as done" }).click();
  await expect(page.locator("#toast")).toContainText("Marked as done");
  await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();

  // The undo in the toast puts the step back exactly as it was.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Mark as done" })).toBeVisible();

  await page.getByRole("button", { name: "Mark as done" }).click();
  await page.locator(".crumb-back").click();
  await expect(page.locator(".list.is-kids .row.is-done")).toHaveCount(1);
});

test("an empty step offers its fields as chips and never as empty boxes", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);
  await page.locator(".row-shell").first().locator(".row").click();
  await page.getByRole("button", { name: /Add the first part/ }).click();
  await page.locator(".composer input").fill("Call the practice");
  await page.locator(".composer input").press("Enter");
  await page.locator(".composer input").press("Escape");
  await page.locator(".list.is-kids .row-shell").first().locator(".row").click();

  // Nothing on this step is set, so nothing on this screen says so: no value
  // cards, no "not set", no ancestry card - the breadcrumb already carries it.
  await expect(page.locator(".facts")).toHaveCount(0);
  const body = await page.locator(".scroll.is-leaf").innerText();
  expect(body).not.toContain("not set");
  expect(body).not.toContain("No note");
  expect(body).not.toContain("Not defined yet");
  expect(body).not.toContain("Belongs to");

  // What is left is one row of offers and one mono line of trivia.
  await expect(page.locator(".chips.is-offers .chip")).toHaveCount(5);
  await expect(page.locator(".microline")).toContainText("created");
  await expect(page.locator(".microline")).toContainText("open");

  // Every offer is a real button, thumb sized, and lands on its own field.
  for (const chip of await page.locator(".chips.is-offers .chip").all()) {
    expect((await chip.boundingBox()).height).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole("button", { name: "Add Due", exact: true }).click();
  await expect(page.locator('.sheet input[type="date"]')).toBeFocused();
});

test("a filled step reads as a ledger, and a finished one wears the green seal", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);
  await page.locator(".row-shell").first().locator(".row").click();
  await page.getByRole("button", { name: /Add the first part/ }).click();
  await page.locator(".composer input").fill("Call the practice");
  await page.locator(".composer input").press("Enter");
  await page.locator(".composer input").press("Escape");
  await page.locator(".list.is-kids .row-shell").first().locator(".row").click();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".sheet .textarea").nth(1).fill("They only answer before nine.");
  await page.locator(".sheet .textarea").nth(2).fill("The appointment is confirmed.");
  await page.locator('.sheet input[type="date"]').fill("2030-09-18");
  await page.locator('.sheet input[type="number"]').fill("25");
  await page.getByRole("button", { name: "Save" }).click();

  // Four values, four glyph rows, and no offer left for them.
  await expect(page.locator(".facts .fact")).toHaveCount(4);
  await expect(page.locator(".facts")).toContainText("The appointment is confirmed.");
  await expect(page.locator(".facts")).toContainText("25 min");
  await expect(page.locator(".chips.is-offers .chip")).toHaveCount(1); // only "link a card"
  await expect(page.locator(".leaf-seal")).toHaveCount(0);

  await page.getByRole("button", { name: "Mark as done" }).click();
  await expect(page.locator(".leaf-seal")).toHaveCount(1);
  await expect(page.locator(".microline")).toContainText("done");
});

test("lock and unlock round trip keeps the list", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);
  await page.waitForTimeout(1000);

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: /Lock now/ }).click();
  await expect(page.locator(".lock-title")).toHaveText("Locked");
  expect(await page.locator(".row-title").count()).toBe(0);

  // A wrong passphrase says only that it did not open.
  await page.locator(".lock input").fill("not the passphrase");
  await page.getByRole("button", { name: /Unlock/ }).click();
  await expect(page.locator(".field-error")).toContainText("did not open", { timeout: 30000 });

  await page.locator(".lock input").fill(PASS);
  await page.getByRole("button", { name: /Unlock/ }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 30000 });
  await expect(page.locator(".row-title")).toHaveText(["Alpha", "Beta"]);
});

test("the vault survives a full reload", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);
  await page.waitForTimeout(1200);

  await page.reload();
  await expect(page.locator(".lock-title")).toHaveText("Locked");
  await page.locator(".lock input").fill(PASS);
  await page.getByRole("button", { name: /Unlock/ }).click();
  await expect(page.locator(".row-title")).toHaveText(["Alpha"], { timeout: 30000 });
});

test("About is readable before unlocking", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: /Lock now/ }).click();
  await expect(page.locator(".lock-title")).toHaveText("Locked");

  await page.getByRole("button", { name: "About" }).click();
  await expect(page.locator(".h-title")).toHaveText("About tenfold");
  await expect(page.locator(".prose")).toContainText("Raymond Hull");
  await expect(page.locator(".prose")).toContainText("encrypted on this device");
  // The claim is a lockup, not a sentence: the separator is a plain hyphen and
  // stays one everywhere it is written (catalogues, README, launch notes).
  await expect(page.locator(".prose .claim")).toContainText("tenfold - get what you want.");
});

test("search finds a node and jumps to it", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES.slice(0, 5));

  await page.getByRole("button", { name: "Open search" }).click();
  await page.locator(".searchbar input").fill("anna");
  await expect(page.locator(".searchbar input")).toHaveValue("anna");
  await expect(page.locator(".row-title")).toHaveText(["Sort things out with Anna"]);
  await page.locator(".row").first().click();
  await expect(page.locator(".hero-title")).toHaveText("Sort things out with Anna");
});

/**
 * The loudness of every row in a list: where it sits on the ramp, how opaque
 * it is, and what its background actually resolves to. Read in ONE pass over
 * the live DOM, because a skin switch rebuilds the screen and a locator handle
 * taken before that rebuild reports the empty style of a detached node. The
 * background is compared as a string on purpose - the point is that the ranks
 * differ, not what colour any of them is, so a token tweak cannot break this.
 */
async function rowSignals(page, selector) {
  return page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].map((row) => {
        const cs = getComputedStyle(row);
        const box = row.getBoundingClientRect();
        const chip = row.querySelector(".row-chip");
        const title = row.querySelector(".row-title");
        return {
          ramp: parseFloat(cs.getPropertyValue("--ramp")),
          opacity: parseFloat(cs.opacity),
          bg: cs.backgroundImage === "none" ? cs.backgroundColor : cs.backgroundImage,
          // Real geometry, not declared values: a band that does not change
          // the height of the row on screen is exactly the failure this whole
          // wave exists to fix.
          h: box.height,
          top: box.top,
          bottom: box.bottom,
          title: parseFloat(getComputedStyle(title).fontSize),
          chipW: chip ? chip.getBoundingClientRect().width : 0,
          chipColor: chip ? getComputedStyle(chip).color : "",
        };
      }),
    selector,
  );
}

const ROWS = ".list.is-ranked > .row-shell > .row";
const COMBOS = [];
for (const skin of ["slate", "register", "breath"]) {
  for (const theme of ["dark", "light"]) COMBOS.push([skin, theme]);
}

async function applySkin(page, skin, theme) {
  await page.evaluate(async (prefs) => (await import("/web/js/app.js")).ctx.setSettings(prefs), {
    skin,
    theme,
  });
  await expect(page.locator("html")).toHaveAttribute("data-skin", skin);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

test("the ranked ten reads as three tiers, not as a gradient", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES);
  await expect(page.locator(".list.is-ranked .row-shell")).toHaveCount(10);

  // The classes exist before any measurement: 1 lead, 2 in the middle band,
  // 7 in the quiet one. Anything else and the rest of this test measures the
  // wrong rows.
  await expect(page.locator(`${ROWS}.is-tier1`)).toHaveCount(1);
  await expect(page.locator(`${ROWS}.is-tier2`)).toHaveCount(2);
  await expect(page.locator(`${ROWS}.is-tier3`)).toHaveCount(7);

  for (const [skin, theme] of COMBOS) {
    await applySkin(page, skin, theme);
    const where = `${skin}/${theme}`;
    const rows = await rowSignals(page, ROWS);
    expect(rows.length, where).toBe(10);
    const [t1, t2a, t2b, t3a] = rows;
    const t3z = rows[9];

    // The two EDGES. Six pixels is the smallest step that survives a phone at
    // arm's length; the per-rank ramp that preceded this moved a row by none
    // at all, which is what the owner reported.
    expect(t1.h - t2a.h, `${where} edge 1|2`).toBeGreaterThanOrEqual(6);
    expect(t2a.h - t3a.h, `${where} edge 2|3`).toBeGreaterThanOrEqual(6);

    // And inside a band there is no step at all: rank two and rank three are
    // the same size, rank four and rank ten are the same size. A tier that
    // drifts is a gradient wearing three names.
    expect(Math.abs(t2a.h - t2b.h), `${where} inside tier 2`).toBeLessThanOrEqual(2);
    expect(Math.abs(t3a.h - t3z.h), `${where} inside tier 3`).toBeLessThanOrEqual(2);

    // Type steps with the height, in every skin - it is the whole edge in the
    // two that have no plate to draw one with.
    expect(t1.title, `${where} title 1`).toBeGreaterThan(t2a.title);
    expect(t2a.title, `${where} title 2`).toBeGreaterThan(t3a.title);
    expect(t2a.title, where).toBe(t2b.title);
    expect(t3a.title, where).toBe(t3z.title);

    // The rank figure carries the band too: tier 3 is smaller AND paler than
    // tier 2, which keeps the full-contrast figure of a candidate for the top.
    expect(t2a.chipW, `${where} chip size`).toBeGreaterThan(t3a.chipW);
    expect(t3a.chipColor, `${where} chip colour`).not.toBe(t2a.chipColor);

    // Opacity is a band value now, not a per-rank fade: flat inside a tier,
    // stepped between them, and the foot of the list stays readable.
    expect(t1.opacity, where).toBe(1);
    expect(t2a.opacity, where).toBe(t2b.opacity);
    expect(t2a.opacity, where).toBeLessThan(t1.opacity);
    expect(t3a.opacity, where).toBeLessThan(t2a.opacity);
    expect(t3a.opacity, where).toBe(t3z.opacity);
    expect(t3z.opacity, where).toBeGreaterThan(0.7);
  }
});

test("the background ramp still runs loud to quiet under the tiers", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES);
  await expect(page.locator(".list.is-ranked .row-shell")).toHaveCount(10);

  for (const [skin, theme] of COMBOS) {
    await applySkin(page, skin, theme);
    const where = `${skin}/${theme}`;
    const rows = await rowSignals(page, ROWS);
    const [lead, second, third] = rows;
    const last = rows[9];

    // Monotonic, and with a real gap under the lead: the echo must never
    // disagree with the bands about which way the list runs.
    expect(lead.ramp, where).toBe(1);
    expect(second.ramp, where).toBeLessThan(0.85);
    expect(third.ramp, where).toBeLessThan(second.ramp);
    expect(last.ramp, where).toBeLessThan(third.ramp);
    expect(last.ramp, where).toBeGreaterThanOrEqual(0);

    // The background is genuinely different per rank - the ramp is still a
    // ramp underneath, not four rows sharing one wash.
    expect(new Set([lead.bg, second.bg, third.bg, last.bg]).size, where).toBe(4);
  }
});

test("ten one-line goals stand on the phone with nothing cut off", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES);
  await expect(page.locator(".list.is-ranked .row-shell")).toHaveCount(10);

  // The owner's own screen: 390x844, ten goals, rank one clipped at the top
  // and rank ten clipped at the bottom, scrolling needed in both directions.
  // Every skin has to hold the budget, not just the default one.
  for (const [skin, theme] of COMBOS) {
    await applySkin(page, skin, theme);
    const where = `${skin}/${theme}`;
    const rows = await rowSignals(page, ROWS);
    const frame = await page.evaluate(() => {
      const scroll = document.querySelector(".scroll");
      const head = document.querySelector(".head").getBoundingClientRect();
      return {
        vh: window.innerHeight,
        headBottom: head.bottom,
        scrollBottom: scroll.getBoundingClientRect().bottom,
        overflow: scroll.scrollHeight - scroll.clientHeight,
      };
    });

    // Nothing to scroll: the whole ten fits in the space between the header
    // and the bar, and the list is not merely visible after a scroll.
    expect(frame.overflow, `${where} overflow`).toBeLessThanOrEqual(1);
    expect(rows[0].top, `${where} rank one under the header`).toBeGreaterThanOrEqual(
      frame.headBottom,
    );
    expect(rows[9].bottom, `${where} rank ten above the bar`).toBeLessThanOrEqual(
      frame.scrollBottom,
    );
    expect(rows[9].bottom, `${where} rank ten on screen`).toBeLessThanOrEqual(frame.vh);
  }
});

test("a shorter list uses the space the missing goals leave", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES.slice(0, 5));
  await expect(page.locator(".list.is-ranked .row-shell")).toHaveCount(5);
  const five = await rowSignals(page, ROWS);
  // Relaxed, and still not a scroll.
  const fiveOverflow = await page.evaluate(() => {
    const s = document.querySelector(".scroll");
    return s.scrollHeight - s.clientHeight;
  });
  expect(fiveOverflow).toBeLessThanOrEqual(1);

  await addRoots(page, TITLES.slice(5));
  await expect(page.locator(".list.is-ranked .row-shell")).toHaveCount(10);
  const ten = await rowSignals(page, ROWS);

  // "If there are fewer, show them all bigger" - every band, not only the
  // lead, and the bands stay bands while they grow.
  expect(five[0].h).toBeGreaterThan(ten[0].h);
  expect(five[1].h).toBeGreaterThan(ten[1].h);
  expect(five[4].h).toBeGreaterThan(ten[4].h);
  expect(five[0].h - five[1].h).toBeGreaterThanOrEqual(6);
  expect(five[1].h - five[4].h).toBeGreaterThanOrEqual(6);
});

test("a shorter list runs the same loud-to-quiet arc as ten", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  // Eight goals - the owner's real count when he reported the app looking
  // flatter than the ten-row design shots: with the divisor fixed at rank
  // ten, an eight-goal list never reached the floor.
  await addRoots(page, TITLES.slice(0, 8));
  await expect(page.locator(".list.is-ranked .row-shell")).toHaveCount(8);

  const rows = await rowSignals(page, ".list.is-ranked > .row-shell > .row");
  const floor = await page.evaluate(() =>
    parseFloat(
      getComputedStyle(document.querySelector(".list.is-ranked .row")).getPropertyValue("--ramp-floor"),
    ),
  );
  // The LAST row of the list that is actually there is the quiet end.
  expect(rows[0].ramp).toBe(1);
  expect(rows[7].ramp).toBeCloseTo(floor, 2);
  for (let i = 2; i < 8; i += 1) expect(rows[i].ramp).toBeLessThan(rows[i - 1].ramp);

  // The bands do not renumber themselves for a shorter list: eight goals are
  // still one lead, two behind it and five below. The echo is normalised, the
  // hierarchy is not - "second of eight" means what "second of ten" means.
  await expect(page.locator(`${ROWS}.is-tier1`)).toHaveCount(1);
  await expect(page.locator(`${ROWS}.is-tier2`)).toHaveCount(2);
  await expect(page.locator(`${ROWS}.is-tier3`)).toHaveCount(5);
  expect(rows[0].h - rows[1].h).toBeGreaterThanOrEqual(6);
  expect(rows[1].h - rows[3].h).toBeGreaterThanOrEqual(6);
});

test("a kids list carries no rank ramp", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES.slice(0, 3));
  await page.locator(".row-shell").first().locator(".row").click();

  await page.getByRole("button", { name: /Add the first part/ }).click();
  for (const part of ["Renegotiate the rate", "Cancel the subscriptions", "One extra payment"]) {
    await page.locator(".composer input").fill(part);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
  await expect(page.locator(".list.is-kids .row-shell")).toHaveCount(3);
  expect(await page.locator(".list.is-kids.is-ranked").count()).toBe(0);

  // Every row carries a --rank in every list; only the ranked ten reads it as
  // loudness. Here all three rows sit at the top of the ramp and share one
  // background - the sublist is ordered, but its order is not its subject.
  const rows = await rowSignals(page, ".list.is-kids > .row-shell > .row");
  expect(rows.length).toBe(3);
  expect(rows.map((r) => r.ramp)).toEqual([1, 1, 1]);
  expect(new Set(rows.map((r) => r.bg)).size).toBe(1);

  // And no bands either: the three tiers belong to the ranked ten alone. A
  // sublist is ordered, but its order is not the subject of it, so its rows
  // are one height and one type size.
  expect(await page.locator(".list.is-kids .row[class*='is-tier']").count()).toBe(0);
  expect(new Set(rows.map((r) => r.h)).size).toBe(1);
  expect(new Set(rows.map((r) => r.title)).size).toBe(1);
});

test("skins and themes switch without losing the list", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);
  await page.getByRole("button", { name: "Open settings" }).click();

  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-skin", "register");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Breath", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-skin", "breath");

  // The choice is mirrored for the pre-paint bootstrap.
  const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem("tenfold.ui")));
  expect(prefs).toMatchObject({ skin: "breath", theme: "light" });

  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".row-title")).toHaveText(["Alpha"]);
});

test("XSS canary: a node title is text, never markup", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  const payload = '<img src=x onerror="window.XSS=1">';
  await addRoots(page, [payload]);

  await expect(page.locator(".row-title").first()).toHaveText(payload);
  expect(await page.locator(".row-title img").count()).toBe(0);
  expect(await page.evaluate(() => window.XSS)).toBeUndefined();

  // And it stays text after a round trip through focus and search.
  await page.locator(".row-shell").first().locator(".row").click();
  await expect(page.locator(".hero-title")).toHaveText(payload);
  expect(await page.evaluate(() => window.XSS)).toBeUndefined();
  expect(await page.locator("img").count()).toBe(0);
});

test("swiping a step to the right finishes it", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);
  await page.locator(".row-shell").first().locator(".row").click();
  await page.getByRole("button", { name: /Add the first part/ }).click();
  await page.locator(".composer input").fill("Call the practice");
  await page.locator(".composer input").press("Enter");
  await page.locator(".composer input").press("Escape");

  const row = page.locator(".list.is-kids .row-shell").first().locator(".row");
  const box = await row.boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + box.height / 2, { steps: 6 });
  await page.mouse.move(box.x + 170, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();

  await expect(page.locator("#toast")).toContainText("Marked as done");
  await expect(page.locator(".list.is-kids .row.is-done")).toHaveCount(1);
});

test("a long press lifts a row and the release reorders the siblings", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma", "Delta"]);

  const row = page.locator(".row-shell").nth(3).locator(".row");
  const box = await row.boundingBox();
  const x = box.x + 120;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(650); // past the long-press threshold
  await page.mouse.move(x, y - 60, { steps: 10 });
  await page.mouse.move(x, y - 120, { steps: 10 });
  await page.mouse.up();

  await expect(page.locator(".row-title")).toHaveText(["Alpha", "Delta", "Beta", "Gamma"]);
  // A drag is not a tap: the list must still be on screen.
  await expect(page.locator(".h-title")).toHaveText("The Ten");
});

test("the row menu on a focus screen can rename and delete the node", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);
  await page.locator(".row-shell").first().locator(".row").click();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".sheet .input").first().fill("Alpha, renamed");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".hero-title")).toHaveText("Alpha, renamed");

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  await expect(page.locator(".row-title")).toHaveText(["Beta"]);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".row-title")).toHaveText(["Alpha, renamed", "Beta"]);
});

test("the composer indents with Tab and outdents with Shift+Tab", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await page.getByRole("button", { name: /Write the first one/ }).click();
  await page.locator(".composer input").fill("Run ten kilometres again");
  await page.locator(".composer input").press("Enter");
  // Tab turns the next line into a child of the line just written.
  await page.locator(".composer input").fill("Stabilise the knee");
  await page.locator(".composer input").press("Tab");
  // Indenting moved the writing one level down, so the view followed it.
  await expect(page.locator(".hero-title")).toHaveText("Run ten kilometres again");
  await page.locator(".composer input").fill("Book the physio");
  await page.locator(".composer input").press("Enter");

  // Shift+Tab takes the next line back out to the level above.
  await page.locator(".composer input").fill("Sort things out with Anna");
  await page.locator(".composer input").press("Shift+Tab");
  await page.locator(".composer input").press("Escape");

  await expect(page.locator(".h-title")).toHaveText("The Ten");
  await expect(page.locator(".row-title")).toHaveText([
    "Run ten kilometres again",
    "Sort things out with Anna",
  ]);
  await expect(page.locator(".row-shell").first().locator(".m")).toHaveText("0/2");

  await page.locator(".row-shell").first().locator(".row").click();
  await expect(page.locator(".list.is-kids .row-title")).toHaveText([
    "Stabilise the knee",
    "Book the physio",
  ]);
});

test("Alt and the arrow keys move a node among its siblings", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma"]);

  await page.locator(".row-shell").nth(2).locator(".row").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.locator(".row-title")).toHaveText(["Alpha", "Gamma", "Beta"]);
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.locator(".row-title")).toHaveText(["Gamma", "Alpha", "Beta"]);
});

test("the app centres itself on a desktop viewport without overflowing", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, TITLES.slice(0, 4));
  await page.setViewportSize({ width: 1280, height: 900 });

  const box = await page.locator(".frame").boundingBox();
  // Past 900px the frame is a tablet canvas, not the phone column it used to
  // be here; the width discipline moved inside it (tests/desktop.spec.js).
  expect(box.width).toBeGreaterThanOrEqual(768);
  expect(box.width).toBeLessThanOrEqual(820);
  // Centred within one pixel of rounding.
  expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(2);
  const overflow = await page.evaluate(() => document.body.scrollWidth - document.body.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("with reduced motion the app still boots and navigates", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: PHONE,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);
  await page.locator(".row-shell").first().locator(".row").click();
  await expect(page.locator(".hero-title")).toHaveText("Alpha");
  await page.locator(".crumb-back").click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  await context.close();
});

// --------------------------------------------------------------- source rules

/** Strip line and block comments so prose about a rule cannot trip the rule. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

async function jsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await jsFiles(full)));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

test("no source builds DOM from strings and none of it can evaluate code", async () => {
  const files = [...(await jsFiles(join(ROOT, "web", "js"))), join(ROOT, "web", "sw.js")];
  expect(files.length).toBeGreaterThan(15);

  const forbidden = [
    /\.innerHTML\b/,
    /\.outerHTML\b/,
    /insertAdjacentHTML/,
    /document\.write\b/,
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
    /createContextualFragment/,
  ];

  const hits = [];
  for (const file of files) {
    const code = stripComments(await readFile(file, "utf8"));
    for (const rx of forbidden) {
      if (rx.test(code)) hits.push(`${file.replace(ROOT, "")}: ${rx}`);
    }
  }
  expect(hits).toEqual([]);
});

test("the entry document has no inline handler and no foreign origin", async () => {
  const html = await readFile(join(ROOT, "web", "index.html"), "utf8");
  const markup = html.replace(/<!--[\s\S]*?-->/g, "");
  expect(markup).not.toMatch(/\son[a-z]+\s*=/i);
  expect(markup).not.toMatch(/https?:\/\//i);
  // Every script tag must be a src reference with an empty body.
  const bodies = [...markup.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim());
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies.filter(Boolean)).toEqual([]);
});

test("no stylesheet reaches outside the app", async () => {
  // Strip comments, then strip whole inline data URIs - their payload may
  // legitimately contain url(#id) fragment references of its own.
  const strip = (css) =>
    css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/url\(["']data:[\s\S]*?["']\)/g, "");
  for (const name of ["tokens.css", "app.css"]) {
    const css = strip(await readFile(join(ROOT, "web", "css", name), "utf8"));
    expect(css, name).not.toMatch(/@import/);
    expect(css, name).not.toMatch(/url\(/);
  }
  // Components may not hard-code colour; that is what tokens are for.
  const app = strip(await readFile(join(ROOT, "web", "css", "app.css"), "utf8"));
  expect(app).not.toMatch(/#[0-9a-f]{3,8}\b/i);
});

test("no emoji anywhere in the shipped source", async () => {
  const files = [
    ...(await jsFiles(join(ROOT, "web", "js"))),
    join(ROOT, "web", "index.html"),
    join(ROOT, "web", "privacy.html"),
    join(ROOT, "web", "method.html"),
    join(ROOT, "web", "css", "tokens.css"),
    join(ROOT, "web", "css", "app.css"),
  ];
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
  const hits = files.filter((f) => emoji.test(""));
  expect(hits).toEqual([]);
  for (const file of files) {
    const body = await readFile(file, "utf8");
    expect(emoji.test(body), `${file.replace(ROOT, "")} contains an emoji`).toBe(false);
  }
});

// The owner's house style: no em dash in prose. It is a typographic habit the
// three catalogues were cleaned of, and the two documents that speak for the
// product have to hold the same line, or the next paragraph written by hand
// quietly puts one back. The dash the catalogues are guarded against lives in
// tests/i18n.spec.js; this is the same rule for the docs on disk.
test("no em dash in the documents that describe the product", async () => {
  for (const name of ["README.md", "docs/CONTRACTS.md", "web/privacy.html", "web/method.html"]) {
    const body = await readFile(join(ROOT, name), "utf8");
    const line = body.split("\n").findIndex((l) => l.includes("—")) + 1;
    expect(line, `${name} carries an em dash on line ${line}`).toBe(0);
  }
});

test("i18n key sets stay identical when loaded through the app", async ({ page }) => {
  await freshApp(page);
  const r = await page.evaluate(async () => {
    const { keysOf, LOCALES } = await import("/web/js/i18n.js");
    return LOCALES.map((l) => keysOf(l).join("|"));
  });
  expect(new Set(r).size).toBe(1);
});
