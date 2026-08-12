// The whole-tree review: the second prompt, and the one that has no way back.
//
// Owner's question: "Click auf The Ten soll mir Think it through with an AI
// Prompt für den gesamten Baum anbieten. Ist das zu viel?" It is not, as long
// as it asks for something else than the leaf prompt does. The leaf prompt
// UNFOLDS one goal and ends in a fenced-JSON contract because its answer comes
// back into the document. This one REVIEWS ten and ends in prose, and nothing
// it brings back is parsed, previewed or written.
//
// So two things are under test here beyond the wording: that the same scoping
// rules hold for ten goals as for one - an opted-out branch absent, a sensitive
// card dropped, card notes never travelling - and that the format contract is
// NOT in this prompt. A tree prompt that grew a code block would quietly turn a
// review into an import.
import { test, expect } from "@playwright/test";

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

test.describe.configure({ mode: "parallel", timeout: 240_000 });
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

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

// --------------------------------------------------------------- the context

test("the tree context is the roots, their pressure and their progress", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const aihelp = await import("/web/js/aihelp.js");
    const model = await import("/web/js/model.js");
    const now = Date.UTC(2026, 4, 20, 12, 0, 0);
    const day = 86400000;
    const doc = {
      schema: 2,
      nodes: [
        model.createNode({ id: "a", title: "Get the knee fixed", rank: 0, story: "It has hurt since March." }),
        model.createNode({ id: "a1", parentId: "a", title: "Book the MRI", rank: 0, due: now - day }),
        model.createNode({ id: "a2", parentId: "a", title: "Call the physio", rank: 1, status: "done" }),
        model.createNode({ id: "a3", parentId: "a", title: "Swim twice", rank: 2, due: now }),
        model.createNode({ id: "b", title: "Spanish up to B2", rank: 1 }),
        model.createNode({ id: "c", title: "A quieter month", rank: 2, status: "parked" }),
        // Tombstones are not goals and never were.
        model.createNode({ id: "d", title: "Abandoned", rank: 3, deletedAt: now }),
      ],
      entities: [],
      settings: {},
    };
    const context = aihelp.buildTreeContext(doc, { now });
    return {
      goals: context.goals,
      nodeCount: context.nodeCount,
      cutStories: context.cutStories,
      omitted: context.omitted,
      // The whole list, in one prompt, is still three goals - not the tree.
      titles: context.goals.map((g) => g.title),
    };
  });

  expect(r.titles).toEqual(["Get the knee fixed", "Spanish up to B2", "A quieter month"]);
  expect(r.nodeCount).toBe(3);
  expect(r.cutStories).toBe(0);
  expect(r.omitted).toEqual({ optout: 0, sensitive: 0, notes: false });

  const knee = r.goals[0];
  expect(knee.rank).toBe(1);
  expect(knee.status).toBe("open");
  expect(knee.hasStory).toBe(true);
  expect(knee.story).toBe("It has hurt since March.");
  expect(knee.storyCut).toBe(false);
  expect(knee.overdue).toBe(1);
  expect(knee.today).toBe(1);
  expect(knee.done).toBe(1);
  expect(knee.steps).toBe(3);

  expect(r.goals[1]).toMatchObject({ rank: 2, hasStory: false, story: "", steps: 0, done: 0, overdue: 0, today: 0 });
  expect(r.goals[2]).toMatchObject({ rank: 3, status: "parked" });
});

test("a long story is cut on a word, marked, and the cut is declared in the prompt", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const aihelp = await import("/web/js/aihelp.js");
    const model = await import("/web/js/model.js");
    // The shape the story guide writes: labelled blocks with blank lines.
    const story = [
      "Why now: The move is in September and the paperwork is in Spanish.",
      "Tried already: Two apps, a podcast and one evening class that met twice.",
      "In the way: Evenings disappear into work and the class was on the wrong side of town.",
      "Done when: I can hold a twenty minute conversation with the landlord without rehearsing it.",
    ].join("\n\n");
    const doc = {
      schema: 2,
      nodes: [model.createNode({ id: "a", title: "Spanish up to B2", rank: 0, story })],
      entities: [],
      settings: {},
    };
    const context = aihelp.buildTreeContext(doc, { now: 0 });
    return {
      cap: aihelp.MAX_STORY_EXCERPT,
      full: story.length,
      excerpt: context.goals[0].story,
      cut: context.goals[0].storyCut,
      cutStories: context.cutStories,
      text: aihelp.renderTreePrompt(context, "en"),
    };
  });

  expect(r.cap).toBe(240);
  expect(r.full).toBeGreaterThan(r.cap);
  expect(r.excerpt.length).toBeLessThanOrEqual(r.cap);
  expect(r.cut).toBe(true);
  expect(r.cutStories).toBe(1);
  // Cut on a word, not through one, and flattened to one paragraph so ten of
  // them do not turn the prompt into a wall.
  expect(r.excerpt.endsWith(" ")).toBe(false);
  expect(r.excerpt).not.toContain("\n");
  expect(r.excerpt.startsWith("Why now: The move is in September")).toBe(true);
  // The marker on the line, and the sentence that explains it once.
  expect(r.text).toContain("(story continues)");
  expect(r.text).toContain("Ask me for the rest of one");
  // The tail of the story did not travel.
  expect(r.text).not.toContain("without rehearsing it");
});

// ---------------------------------------------------------------- the scoping

test("the tree prompt keeps back exactly what the leaf prompt keeps back", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const aihelp = await import("/web/js/aihelp.js");
    const model = await import("/web/js/model.js");
    const doc = {
      schema: 2,
      nodes: [
        model.createNode({ id: "a", title: "Get the knee fixed", rank: 0, entityRefs: ["e1", "e2"] }),
        // Kept away from any model, with a step under it that is kept away with it.
        model.createNode({ id: "b", title: "The divorce paperwork", rank: 1, llmOptout: true }),
        model.createNode({ id: "b1", parentId: "b", title: "Call the solicitor", rank: 0 }),
        model.createNode({ id: "c", title: "Spanish up to B2", rank: 2 }),
        // An opted-out branch UNDER a living goal: absent, and out of its counts.
        model.createNode({ id: "c1", parentId: "c", title: "Tandem partner", rank: 0 }),
        model.createNode({ id: "c2", parentId: "c", title: "The therapy homework", rank: 1, llmOptout: true }),
      ],
      entities: [
        model.createEntity({ id: "e1", name: "Dr Alvarez", kind: "person", relation: "surgeon", notes: "Said the tear is old." }),
        model.createEntity({ id: "e2", name: "Ana", kind: "person", relation: "ex", sensitivity: "high" }),
      ],
      settings: {},
    };
    const built = aihelp.buildTreePrompt(doc, "en", { now: 0 });
    return { text: built.text, context: built.context };
  });

  // The canaries: nothing kept back is anywhere in the text.
  expect(r.text).not.toContain("divorce");
  expect(r.text).not.toContain("Call the solicitor");
  expect(r.text).not.toContain("therapy homework");
  expect(r.text).not.toContain("Ana");
  expect(r.text).not.toContain("Said the tear is old");
  // What may travel, did.
  expect(r.text).toContain("Get the knee fixed");
  expect(r.text).toContain("Dr Alvarez");
  // The rank of the withheld goal leaves a gap rather than a renumbered list.
  expect(r.context.goals.map((g) => g.rank)).toEqual([1, 3]);
  // The opted-out step is out of its parent's counts too.
  expect(r.context.goals[1]).toMatchObject({ title: "Spanish up to B2", steps: 1 });
  expect(r.context.omitted).toEqual({ optout: 2, sensitive: 1, notes: true });
  // And what was held back is NAMED, so no gap gets filled with a guess.
  expect(r.text).toContain("LEFT OUT ON PURPOSE");
  expect(r.text).toContain("parts I keep away from any model");
  expect(r.text).toContain("cards I marked sensitive");
  expect(r.text).toContain("the notes on the cards");
});

test("a list with nothing reviewable in it has no prompt at all", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const aihelp = await import("/web/js/aihelp.js");
    const model = await import("/web/js/model.js");
    const empty = { schema: 2, nodes: [], entities: [], settings: {} };
    const allKept = {
      schema: 2,
      nodes: [
        model.createNode({ id: "a", title: "One", rank: 0, llmOptout: true }),
        model.createNode({ id: "b", title: "Two", rank: 1, llmOptout: true }),
      ],
      entities: [],
      settings: {},
    };
    const deleted = {
      schema: 2,
      nodes: [model.createNode({ id: "a", title: "Gone", rank: 0, deletedAt: 1 })],
      entities: [],
      settings: {},
    };
    return {
      empty: aihelp.buildTreePrompt(empty, "en"),
      allKept: aihelp.buildTreePrompt(allKept, "en"),
      deleted: aihelp.buildTreePrompt(deleted, "en"),
      availableEmpty: aihelp.treeReviewAvailable(empty),
      availableKept: aihelp.treeReviewAvailable(allKept),
      availableOne: aihelp.treeReviewAvailable({
        schema: 2,
        nodes: [model.createNode({ id: "a", title: "One", rank: 0 })],
        entities: [],
        settings: {},
      }),
      junk: aihelp.buildTreePrompt(null, "en"),
    };
  });

  expect(r.empty).toBe(null);
  expect(r.allKept).toBe(null);
  expect(r.deleted).toBe(null);
  expect(r.junk).toBe(null);
  expect(r.availableEmpty).toBe(false);
  expect(r.availableKept).toBe(false);
  expect(r.availableOne).toBe(true);
});

// ----------------------------------------------------------------- the words

test("the tree prompt asks for a review and NOT for a code block, in three languages", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const aihelp = await import("/web/js/aihelp.js");
    const model = await import("/web/js/model.js");
    const doc = {
      schema: 2,
      nodes: [
        model.createNode({ id: "a", title: "Learn to sail", rank: 0, story: "The boat is my father's." }),
        model.createNode({ id: "b", title: "Spanish up to B2", rank: 1 }),
      ],
      entities: [],
      settings: {},
    };
    const out = {};
    for (const locale of ["en", "de", "es"]) {
      out[locale] = {
        tree: aihelp.buildTreePrompt(doc, locale, { now: 0 }).text,
        leaf: aihelp.buildPrompt(doc, "a", locale).text,
        last: aihelp.PROMPT[locale].tree.ask[aihelp.PROMPT[locale].tree.ask.length - 1],
      };
    }
    // The three wordings have to stay interchangeable, the way the catalogues do.
    const shape = (o) => (o && typeof o === "object" ? Object.keys(o).sort().join(",") : typeof o);
    const keys = ["en", "de", "es"].map((l) => {
      const tree = aihelp.PROMPT[l].tree;
      return [shape(tree), shape(tree.labels), shape(tree.marks), shape(tree.due), String(tree.ask.length)].join("|");
    });
    return { out, keys };
  });

  expect(r.keys[0]).toBe(r.keys[1]);
  expect(r.keys[1]).toBe(r.keys[2]);

  const phrases = {
    en: {
      questions: "up to three questions",
      week: "deserves the coming week",
      read: "read this, not import it",
      order: "whether the order is honest",
    },
    de: {
      questions: "bis zu drei Fragen",
      week: "die kommende Woche verdient",
      read: "ich lese das, ich importiere es nicht",
      order: "ob die Reihenfolge ehrlich ist",
    },
    es: {
      questions: "hasta tres preguntas",
      week: "merece la semana que viene",
      read: "lo voy a leer, no importar",
      order: "si el orden es honesto",
    },
  };

  for (const locale of ["en", "de", "es"]) {
    const text = r.out[locale].tree;
    const p = phrases[locale];
    // The dramaturgy: questions first, then the review, then a verdict.
    expect(text, locale).toContain(p.questions);
    expect(text, locale).toContain(p.order);
    expect(text, locale).toContain(p.week);
    expect(text, locale).toContain(p.read);
    expect(text.trimEnd().endsWith(r.out[locale].last.trim()), locale).toBe(true);

    // THE POINT: no paste-back contract anywhere in this prompt. The leaf
    // prompt built from the same document still carries all of it, so this is
    // an assertion about the tree wording and not about an empty document.
    expect(text, locale).not.toContain("```");
    expect(text, locale).not.toContain("JSON");
    expect(text, locale).not.toContain('"step"');
    expect(text, locale).not.toContain('"substeps"');
    expect(r.out[locale].leaf, locale).toContain("```");
    expect(r.out[locale].leaf, locale).toContain("JSON");

    // The whole list travelled, and only the roots of it.
    expect(text, locale).toContain("1. Learn to sail");
    expect(text, locale).toContain("2. Spanish up to B2");
  }
});

// ------------------------------------------------------------------ the sheet

test("tapping the title of the ten opens the review, with no way to paste anything back", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed", "Spanish up to B2", "A quieter month"]);

  // A story on the first one, so the prompt carries more than three titles.
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const root = ctx.doc.nodes.find((n) => n.title === "Get the knee fixed");
    ctx.updateNode(root.id, { story: "Running hurts after ten minutes. The referral has been on the desk since March." });
  });

  // The heading is still a heading, and now it is also the way in.
  await expect(page.locator("h1.h-title")).toHaveText("The Ten");
  const entry = page.locator(".h-title-btn");
  await expect(entry).toHaveAttribute("aria-label", /whole list/i);
  await entry.click();

  await expect(page.locator(".sheet-title")).toHaveText("Look at the whole list with an AI");
  await expect(page.locator(".field-hint").first()).toContainText("your 3 goals in their order");

  const prompt = await page.locator('[data-ai="tree-prompt"]').inputValue();
  expect(prompt).toContain("1. Get the knee fixed");
  expect(prompt).toContain("2. Spanish up to B2");
  expect(prompt).toContain("3. A quieter month");
  expect(prompt).toContain("Running hurts after ten minutes");
  expect(prompt).toContain("nothing written yet");
  expect(prompt).toContain("no steps yet");
  expect(prompt).toContain("deserves the coming week");
  expect(prompt).not.toContain("```");

  // No way back in: not the row, not the field, not the button.
  await expect(page.locator('[data-ai="paste-open"]')).toHaveCount(0);
  await expect(page.locator('[data-ai="answer"]')).toHaveCount(0);
  await expect(page.locator('[data-ai="look"]')).toHaveCount(0);
  await expect(page.locator('[data-ai="apply"]')).toHaveCount(0);
  // And it says so, where the paste row would have been.
  await expect(page.locator('[data-ai="tree-nopaste"]')).toContainText("comes back as reading, not as steps");

  // The button hands the same text to the clipboard.
  await page.locator('[data-ai="tree-copy"]').click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(prompt);
});

test("the title is a plain heading while there is nothing to review", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);

  // An empty list: the heading is a heading and leads nowhere.
  await expect(page.locator("h1.h-title")).toHaveText("The Ten");
  await expect(page.locator(".h-title-btn")).toHaveCount(0);

  await addRoots(page, ["Get the knee fixed"]);
  await expect(page.locator(".h-title-btn")).toHaveCount(1);

  // Kept away from every model: the way in closes again.
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    ctx.updateNode(ctx.doc.nodes.find((n) => n.title === "Get the knee fixed").id, { llmOptout: true });
  });
  await expect(page.locator(".h-title-btn")).toHaveCount(0);
});
