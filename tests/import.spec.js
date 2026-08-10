// Stage 3b - a photograph of a list becomes a proposal, and only a proposal.
//
// Same mechanism as tests/llm.spec.js: a mock OpenAI-compatible server on a
// fixed port that the operator named in TENFOLD_LLM_UPSTREAMS. It answers with
// a canned four-level outline - the shape the owner's real paper has - so the
// specs below can be about what the app does with it: the levels, the ten-root
// rule, the checkbox that takes a subtree with it, and the two ways this can
// fail without touching the document.
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

/** Must match playwright.config.js webServer.env TENFOLD_LLM_UPSTREAMS. */
const SINK_PORT = 7797;
const SINK_URL = `http://127.0.0.1:${SINK_PORT}/v1`;

test.describe.configure({ mode: "serial", timeout: 240_000 });

// ------------------------------------------------------------------ the sink

function completion(content) {
  return {
    id: "chatcmpl-vision",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

/** The canned answer: four levels, the way a real outline page is written. */
const OUTLINE = {
  items: [
    { title: "01 peace", level: 0 },
    { title: "D", level: 1 },
    { title: "accept", level: 2 },
    { title: "push-motivate", level: 2 },
    { title: "one small word", level: 3 },
    { title: "02 health", level: 0 },
    { title: "knee", level: 1 },
  ],
};

async function startSink() {
  const queue = [];
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      received.push({
        size: raw.length,
        body: (() => {
          try {
            return JSON.parse(raw.toString("utf8"));
          } catch {
            return null;
          }
        })(),
      });
      const next = queue.shift() || { status: 200, body: completion(JSON.stringify(OUTLINE)) };
      const text = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
      res.writeHead(next.status || 200, { "Content-Type": "application/json" });
      res.end(text);
    });
  });
  await new Promise((done) => server.listen(SINK_PORT, "127.0.0.1", done));
  return {
    received,
    says(json) {
      queue.push({ body: completion(typeof json === "string" ? json : JSON.stringify(json)), status: 200 });
    },
    reset() {
      queue.length = 0;
      received.length = 0;
    },
    close: () => new Promise((done) => server.close(done)),
  };
}

let sink;
test.beforeAll(async () => {
  sink = await startSink();
});
test.afterAll(async () => {
  await sink.close();
});
test.beforeEach(() => sink.reset());

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

async function setupVault(page) {
  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 60000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start empty/ }).click();
  // The backup step asks before anything is uploaded; sync stays off here.
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

async function useLocalModel(page) {
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.locator(".h-title")).toHaveText("Settings");
  await page.getByRole("button", { name: "Local", exact: true }).click();
  await page.getByRole("button", { name: /Local model/ }).click();
  await page.locator(".sheet .input.is-url").fill(SINK_URL);
  await page.locator(".sheet .input").nth(1).fill("test-vision");
  await page.locator(".sheet-foot").getByRole("button", { name: "Save" }).click();
  await page.locator(".head-actions").getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
}

/**
 * A real picture: a tiny canvas drawn and encoded as a PNG in the page, then
 * handed to the file chooser the button opens. Nothing on the way is stubbed -
 * the app decodes it, resizes it in a canvas and sends what came out.
 */
async function choosePicture(page) {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 60;
    canvas.height = 40;
    const g = canvas.getContext("2d");
    g.fillStyle = "rgb(255,255,255)";
    g.fillRect(0, 0, 60, 40);
    g.fillStyle = "rgb(20,20,20)";
    g.fillRect(4, 6, 40, 3);
    g.fillRect(10, 16, 34, 3);
    const blob = await new Promise((done) => canvas.toBlob(done, "image/png"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let raw = "";
    for (const b of bytes) raw += String.fromCharCode(b);
    return btoa(raw);
  });
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Choose a picture" }).click(),
  ]);
  await chooser.setFiles({
    name: "outline.png",
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64"),
  });
}

/**
 * The bottom bar, read the way a person reads it: what the controls are called,
 * left to right, and which of them are closed. A text button answers with its
 * words, an icon button with its accessible name.
 */
async function barControls(page) {
  return page.evaluate(() =>
    [...document.querySelector(".bar").children].map((el) => ({
      name: (el.textContent || "").trim() || el.getAttribute("aria-label"),
      disabled: !!el.disabled,
    })),
  );
}

/** Everything the document knows about its own shape, by title. */
async function shape(page) {
  return page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const live = ctx.doc.nodes.filter((n) => !n.deletedAt);
    const byId = new Map(live.map((n) => [n.id, n]));
    return live.map((n) => ({
      title: n.title,
      parent: n.parentId === null ? null : (byId.get(n.parentId) || {}).title,
      origin: n.origin,
    }));
  });
}

// ------------------------------------------------------------------- presence

test("the way in from paper exists only when a model is switched on", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed"]);

  // Off is the default: not hidden, absent. The bar is the two words it always
  // was, and nothing has taken the place between them.
  await expect(page.locator('[data-llm="import"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Import from a photo" })).toHaveCount(0);
  // One goal only, so ordering has nothing to compare and is closed already.
  expect(await barControls(page)).toEqual([
    { name: "New entry", disabled: false },
    { name: "Put in order", disabled: true },
  ]);
  await page.locator(".row").first().click();
  await expect(page.locator('[data-llm="import"]')).toHaveCount(0);
  await page.locator(".crumb-back").click();

  await useLocalModel(page);

  // On the outline: three controls, the camera in the middle, and nothing
  // above the bar any more - the text line it used to be is gone from the DOM.
  await expect(page.locator('[data-llm="import"]')).toHaveCount(1);
  await expect(page.locator(".import-entry")).toHaveCount(0);
  expect(await barControls(page)).toEqual([
    { name: "New entry", disabled: false },
    { name: "Import from a photo", disabled: false },
    { name: "Put in order", disabled: true },
  ]);
  const cam = page.locator(".bar").getByRole("button", { name: "Import from a photo" });
  await expect(cam).toBeVisible();
  // Icon only: an accessible name, no words on screen, and a square of one tap.
  await expect(cam).toHaveText("");
  await expect(cam.locator("svg")).toHaveCount(1);
  const box = await cam.boundingBox();
  expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(1);

  // The screen of a single goal carries exactly the same bar.
  await page.locator(".row").first().click();
  await expect(page.locator(".hero-title")).toHaveText("Get the knee fixed");
  await expect(page.locator('[data-llm="import"]')).toHaveCount(1);
  await expect(page.locator(".import-entry")).toHaveCount(0);
  expect(await barControls(page)).toEqual([
    { name: "Add the first part", disabled: false },
    { name: "Import from a photo", disabled: false },
    { name: "Details", disabled: false },
  ]);
});

test("the ten-root cap closes the words, never the camera", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]);
  await useLocalModel(page);

  // The cap is a rule about writing an eleventh goal by hand. A photograph is
  // decided line by line in the sheet, which enforces the cap where the lines
  // land - so this control stays open with a full list, by design.
  expect(await barControls(page)).toEqual([
    { name: "New entry", disabled: true },
    { name: "Import from a photo", disabled: false },
    { name: "Put in order", disabled: false },
  ]);
  await page.locator(".bar").getByRole("button", { name: "Import from a photo" }).click();
  await expect(page.locator(".sheet-title")).toHaveText("Import from a photo");
});

// ---------------------------------------------------------------- happy path

test("a photographed outline keeps its levels, and a dropped line drops its own", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await useLocalModel(page);

  sink.says(OUTLINE);
  await page.locator(".bar").getByRole("button", { name: "Import from a photo" }).click();
  await expect(page.locator(".sheet-title")).toHaveText("Import from a photo");
  await choosePicture(page);

  await expect(page.locator(".assist-item")).toHaveCount(7, { timeout: 30000 });
  const levels = await page.locator(".assist-item").evaluateAll((els) =>
    els.map((e) => e.dataset.level),
  );
  expect(levels).toEqual(["0", "1", "2", "2", "3", "0", "1"]);
  await expect(page.locator(".assist-title").first()).toHaveText("01 peace");
  await expect(page.locator(".assist-title").nth(4)).toHaveText("one small word");
  // The whole page travelled as one request, with the picture in it.
  expect(sink.received).toHaveLength(1);
  const parts = sink.received[0].body.messages[1].content;
  expect(Array.isArray(parts)).toBe(true);
  expect(parts[1].image_url.url.startsWith("data:image/jpeg;base64,")).toBe(true);
  // The footer says what would go out, and it is the resized weight.
  await expect(page.locator(".import-size")).toContainText("kB to send");

  await expect(page.getByRole("button", { name: "Take over 7" })).toBeEnabled();

  // Dropping "D" drops the three lines written under it - not the goal above
  // it, and not the second goal further down.
  await page.locator(".assist-item").nth(1).locator(".check").click();
  for (const i of [1, 2, 3, 4]) {
    await expect(page.locator(".assist-item").nth(i).locator('input[type="checkbox"]')).not.toBeChecked();
  }
  for (const i of [0, 5, 6]) {
    await expect(page.locator(".assist-item").nth(i).locator('input[type="checkbox"]')).toBeChecked();
  }
  await page.getByRole("button", { name: "Take over 3" }).click();

  await expect(page.locator(".row-title")).toHaveText(["01 peace", "02 health"]);
  expect(await shape(page)).toEqual([
    { title: "01 peace", parent: null, origin: "llm" },
    { title: "02 health", parent: null, origin: "llm" },
    { title: "knee", parent: "02 health", origin: "llm" },
  ]);
});

test("under a goal, the outer margin of the paper becomes the level below it", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed"]);
  await useLocalModel(page);

  sink.says({ items: [{ title: "Book the MRI", level: 0 }, { title: "Ask for the earliest slot", level: 1 }] });
  await page.locator(".row").first().click();
  // The camera in THIS screen's bar, and the target is still this goal - only
  // the entry point moved, the flow behind it did not.
  await page.locator(".bar").getByRole("button", { name: "Import from a photo" }).click();
  await expect(page.locator(".sheet")).toContainText("Everything lands under Get the knee fixed");
  await choosePicture(page);

  await expect(page.locator(".assist-item")).toHaveCount(2, { timeout: 30000 });
  await page.getByRole("button", { name: "Take over 2" }).click();

  await expect(page.locator(".list.is-kids .row-title")).toHaveText(["Book the MRI"]);
  expect(await shape(page)).toEqual([
    { title: "Get the knee fixed", parent: null, origin: "manual" },
    { title: "Book the MRI", parent: "Get the knee fixed", origin: "llm" },
    { title: "Ask for the earliest slot", parent: "Book the MRI", origin: "llm" },
  ]);
});

// ------------------------------------------------------------- the ten stays ten

test("what would be the eleventh goal is shown, explained, and out of reach", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["one", "two", "three", "four", "five", "six", "seven", "eight"]);
  await useLocalModel(page);

  sink.says({
    items: [
      { title: "nine", level: 0 },
      { title: "under nine", level: 1 },
      { title: "ten", level: 0 },
      { title: "eleven", level: 0 },
      { title: "under eleven", level: 1 },
      { title: "twelve", level: 0 },
      { title: "thirteen", level: 0 },
    ],
  });
  await page.locator(".bar").getByRole("button", { name: "Import from a photo" }).click();
  await choosePicture(page);
  await expect(page.locator(".assist-item")).toHaveCount(7, { timeout: 30000 });

  // Two places are free, so two goals and what hangs under them can be taken.
  await expect(page.locator(".assist-item.is-blocked")).toHaveCount(4);
  await expect(page.locator(".sheet")).toContainText("Ten is the limit that makes this work");
  for (const i of [0, 1, 2]) {
    await expect(page.locator(".assist-item").nth(i).locator('input[type="checkbox"]')).toBeEnabled();
  }
  for (const i of [3, 4, 5, 6]) {
    const box = page.locator(".assist-item").nth(i).locator('input[type="checkbox"]');
    await expect(box).toBeDisabled();
    await expect(box).not.toBeChecked();
  }
  // A press on a blocked line changes nothing at all - forced past the
  // browser's own refusal to click a disabled control, to be sure.
  await page.locator(".assist-item").nth(3).locator(".check").click({ force: true });
  await expect(page.locator(".assist-item").nth(3).locator('input[type="checkbox"]')).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Take over 3" })).toBeEnabled();

  await page.getByRole("button", { name: "Take over 3" }).click();
  await expect(page.locator(".row-title")).toHaveText([
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  ]);
  const roots = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return ctx.doc.nodes.filter((n) => !n.deletedAt && n.parentId === null).length;
  });
  expect(roots).toBe(10);
  expect((await shape(page)).find((n) => n.title === "under nine").parent).toBe("nine");
  expect((await shape(page)).some((n) => n.title === "eleven")).toBe(false);
});

// ------------------------------------------------------------------- failures

test("an answer that is not a list says so and leaves the document alone", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Sort the paperwork"]);
  await useLocalModel(page);

  sink.says("I am afraid I cannot read that picture, sorry.");
  await page.locator(".bar").getByRole("button", { name: "Import from a photo" }).click();
  await choosePicture(page);

  await expect(page.locator(".assist-error")).toHaveText(
    "The answer did not come back in the expected form. Nothing was changed.",
    { timeout: 30000 },
  );
  await expect(page.locator(".assist-item")).toHaveCount(0);
  // One press, one attempt: nothing retries on its own.
  expect(sink.received).toHaveLength(1);

  // A picture with nothing on it is its own honest line, not a broken answer.
  sink.says({ items: [] });
  await page.getByRole("button", { name: "Try again" }).click();
  await choosePicture(page);
  await expect(page.locator(".assist-error")).toHaveText(
    "Nothing readable was found on that picture. Nothing was changed.",
    { timeout: 30000 },
  );

  await page.locator(".sheet-head").getByRole("button", { name: "Close" }).click();
  expect(await shape(page)).toEqual([{ title: "Sort the paperwork", parent: null, origin: "manual" }]);
});

test("a title that tries to be markup stays a title", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await useLocalModel(page);

  const canary = '<img src=x onerror="window.XSS=1">';
  sink.says({ items: [{ title: canary, level: 0 }, { title: "<script>window.XSS=2</script>", level: 1 }] });
  await page.locator(".bar").getByRole("button", { name: "Import from a photo" }).click();
  await choosePicture(page);

  await expect(page.locator(".assist-item")).toHaveCount(2, { timeout: 30000 });
  await expect(page.locator(".assist-title").first()).toHaveText(canary);
  expect(await page.locator(".sheet img, .sheet script").count()).toBe(0);
  expect(await page.evaluate(() => window.XSS)).toBeUndefined();

  await page.getByRole("button", { name: "Take over 2" }).click();
  await expect(page.locator(".row-title").first()).toHaveText(canary);
  expect(await page.evaluate(() => window.XSS)).toBeUndefined();
  expect(await page.locator("#app img, #app script").count()).toBe(0);
  expect(await shape(page)).toEqual([
    { title: canary, parent: null, origin: "llm" },
    { title: "<script>window.XSS=2</script>", parent: canary, origin: "llm" },
  ]);
});

// ------------------------------------------------------------- the pure parts

test("levels are clamped where the model gets them wrong", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const prompts = await import("/web/js/prompts.js");
    const imp = await import("/web/js/ui/imageimport.js");
    const attempt = (fn) => {
      try {
        return { value: fn() };
      } catch (err) {
        return { code: err && err.code };
      }
    };
    return {
      // A first line further in than the margin, a jump of two, a level past
      // four, a negative one, a missing one - all corrected, none refused.
      clamped: attempt(() =>
        prompts.parseImportItems({
          items: [
            { title: "a", level: 3 },
            { title: "b", level: 9 },
            { title: "c", level: -4 },
            { title: "d" },
            { title: "e", level: 2 },
          ],
        }),
      ),
      long: attempt(() => prompts.parseImportItems({ items: [{ title: "x".repeat(500), level: 0 }] })),
      many: attempt(() =>
        prompts.parseImportItems({
          items: Array.from({ length: 140 }, (_, i) => ({ title: `t${i}`, level: 0 })),
        }),
      ),
      empty: attempt(() => prompts.parseImportItems({ items: [] })),
      blank: attempt(() => prompts.parseImportItems({ items: [{ title: "   " }] })),
      wrong: attempt(() => prompts.parseImportItems({ nope: 1 })),
      parents: imp.parentIndexes([
        { level: 0 }, { level: 1 }, { level: 2 }, { level: 2 }, { level: 3 }, { level: 0 }, { level: 1 },
      ]),
      capped: imp.blockedByRootCap(
        [{ level: 0 }, { level: 1 }, { level: 0 }, { level: 0 }, { level: 1 }],
        2,
      ),
      // The prompt says what it must say, and does not ask for a translation.
      prompt: prompts.importSystemPrompt(),
      shaped: prompts.importMessages("data:image/jpeg;base64,AAAA"),
    };
  });

  expect(r.clamped.value.items).toEqual([
    { title: "a", level: 0 },
    { title: "b", level: 1 },
    { title: "c", level: 0 },
    { title: "d", level: 0 },
    { title: "e", level: 1 },
  ]);
  expect(r.long.value.items[0].title).toHaveLength(200);
  expect(r.many.value.items).toHaveLength(100);
  expect(r.empty.code).toBe("unreadable");
  expect(r.blank.code).toBe("unreadable");
  expect(r.wrong.code).toBe("malformed");
  expect(r.parents).toEqual([-1, 0, 1, 1, 3, -1, 5]);
  expect(r.capped).toEqual([false, false, false, true, true]);
  expect(r.prompt).toContain("Do not translate");
  expect(r.prompt).toContain("STRICT JSON");
  expect(r.shaped[1].content[1].image_url.url).toBe("data:image/jpeg;base64,AAAA");
});
