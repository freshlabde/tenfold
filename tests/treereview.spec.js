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

test("the tree context is the goals, their pressure, their progress and everything under them", async ({ page }) => {
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
      partCount: context.partCount,
      stepCount: context.stepCount,
      trimmed: context.trimmed,
      cutStories: context.cutStories,
      omitted: context.omitted,
      titles: context.goals.map((g) => g.title),
    };
  });

  expect(r.titles).toEqual(["Get the knee fixed", "Spanish up to B2", "A quieter month"]);
  // The whole list is the whole TREE now: three goals and the three steps under
  // the first of them. The owner field-tested the roots-only version on his own
  // vault and the model read a fraction of it.
  expect(r.nodeCount).toBe(6);
  expect(r.partCount).toBe(3);
  expect(r.stepCount).toBe(3);
  expect(r.trimmed).toBe(0);
  expect(r.cutStories).toBe(0);
  expect(r.omitted).toEqual({ optout: 0, optoutGoals: 0, optoutSteps: 0, sensitive: 0, notes: false });

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
  // And the steps themselves, in document order, with the two markers that
  // matter on a line and nothing else.
  expect(knee.parts).toEqual([
    { level: 1, title: "Book the MRI", status: "open", due: "overdue", story: "", hasStory: false, storyCut: false },
    { level: 1, title: "Call the physio", status: "done", due: null, story: "", hasStory: false, storyCut: false },
    { level: 1, title: "Swim twice", status: "open", due: "today", story: "", hasStory: false, storyCut: false },
  ]);
  expect(knee.partsTrimmed).toBe(0);

  expect(r.goals[1]).toMatchObject({ rank: 2, hasStory: false, story: "", steps: 0, done: 0, overdue: 0, today: 0 });
  expect(r.goals[1].parts).toEqual([]);
  expect(r.goals[2]).toMatchObject({ rank: 3, status: "parked" });
});

// ------------------------------------------------------------------ the tree

test("three levels arrive as three levels, indented, in document order", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const aihelp = await import("/web/js/aihelp.js");
    const model = await import("/web/js/model.js");
    const now = Date.UTC(2026, 4, 20, 12, 0, 0);
    const doc = {
      schema: 2,
      nodes: [
        model.createNode({ id: "a", title: "Get the knee fixed", rank: 0, story: "It has hurt since March." }),
        model.createNode({ id: "a1", parentId: "a", title: "Book the MRI", rank: 0 }),
        model.createNode({ id: "a11", parentId: "a1", title: "Ring the practice", rank: 0 }),
        model.createNode({ id: "a111", parentId: "a11", title: "Ask for the earliest slot", rank: 0 }),
        model.createNode({ id: "a12", parentId: "a1", title: "Put the card in the wallet", rank: 1, status: "done" }),
        model.createNode({ id: "a2", parentId: "a", title: "Swim twice a week", rank: 1, due: now, status: "doing" }),
        model.createNode({ id: "b", title: "Spanish up to B2", rank: 1 }),
        model.createNode({ id: "b1", parentId: "b", title: "Find a tandem partner", rank: 0, story: "Ana at work speaks it." }),
        // A tombstone in the middle of the tree is not a step and never was.
        model.createNode({ id: "b2", parentId: "b", title: "Deleted branch", rank: 1, deletedAt: now }),
        model.createNode({ id: "b21", parentId: "b2", title: "Under the tombstone", rank: 0 }),
      ],
      entities: [],
      settings: {},
    };
    const built = aihelp.buildTreePrompt(doc, "en", { now });
    return {
      text: built.text,
      levels: built.context.goals.map((g) => g.parts.map((p) => `${p.level}:${p.title}`)),
      partCount: built.context.partCount,
    };
  });

  // Document order, depth first: a parent always stands before its children.
  expect(r.levels[0]).toEqual([
    "1:Book the MRI",
    "2:Ring the practice",
    "3:Ask for the earliest slot",
    "2:Put the card in the wallet",
    "1:Swim twice a week",
  ]);
  // A tombstoned branch is absent with everything under it.
  expect(r.levels[1]).toEqual(["1:Find a tandem partner"]);
  expect(r.partCount).toBe(6);
  expect(r.text).not.toContain("Under the tombstone");

  // Two spaces per level, counted from the goal: the labelled lines one step
  // in, the first steps one further, and each level below that one more.
  const lines = r.text.split("\n");
  const at = (title) => lines.find((l) => l.trimStart().startsWith(title));
  expect(at("STORY:")).toBe("  STORY: It has hurt since March.");
  expect(at("THE STEPS UNDER IT")).toBe("  THE STEPS UNDER IT:");
  expect(at("Book the MRI")).toBe("    Book the MRI");
  expect(at("Ring the practice")).toBe("      Ring the practice");
  expect(at("Ask for the earliest slot")).toBe("        Ask for the earliest slot");
  // The markers on a line: status only where it is not open, due only where the
  // today rule would look at it at all.
  expect(at("Put the card in the wallet")).toBe("      Put the card in the wallet (done)");
  expect(at("Swim twice a week")).toBe("    Swim twice a week (in progress, due today)");
  // A step that somebody wrote a story for shows it; most steps have none.
  expect(at("Find a tandem partner")).toBe("    Find a tandem partner - Ana at work speaks it.");
});

test("a step's story travels shorter than a goal's, and both cuts are declared", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const aihelp = await import("/web/js/aihelp.js");
    const model = await import("/web/js/model.js");
    const long = "The paperwork is in Spanish and the office only opens on Tuesday mornings, which is exactly when the standup runs, so it has been sitting there since March and nobody has moved it.";
    const doc = {
      schema: 2,
      nodes: [
        model.createNode({ id: "a", title: "Spanish up to B2", rank: 0, story: long + " " + long }),
        model.createNode({ id: "a1", parentId: "a", title: "Register at the town hall", rank: 0, story: long }),
      ],
      entities: [],
      settings: {},
    };
    const built = aihelp.buildTreePrompt(doc, "en", { now: 0 });
    return {
      goalCap: aihelp.MAX_STORY_EXCERPT,
      stepCap: aihelp.MAX_CHILD_STORY_EXCERPT,
      goalStory: built.context.goals[0].story,
      stepStory: built.context.goals[0].parts[0].story,
      stepCut: built.context.goals[0].parts[0].storyCut,
      cutChildStories: built.context.cutChildStories,
      text: built.text,
    };
  });

  expect(r.goalCap).toBe(240);
  expect(r.stepCap).toBe(120);
  expect(r.stepStory.length).toBeLessThanOrEqual(120);
  expect(r.goalStory.length).toBeGreaterThan(120);
  expect(r.stepCut).toBe(true);
  expect(r.cutChildStories).toBe(1);
  // Both caps are named once, in the one sentence that explains the cutting.
  expect(r.text).toContain("about 240 characters on a goal, 120 on a step");
  expect(r.text).toContain("Ask me for the rest of one");
  // The marker sits on the step's own line.
  expect(r.text).toMatch(/Register at the town hall - .*\(story continues\)/);
});

test("the caps trim from the end and say so where they trimmed", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const aihelp = await import("/web/js/aihelp.js");
    const model = await import("/web/js/model.js");
    const nodes = [];
    // One fat goal (100 steps, over the per-goal cap of 60) and then enough
    // goals behind it to run the total cap of 400 out mid-list.
    nodes.push(model.createNode({ id: "fat", title: "The fat one", rank: 0 }));
    for (let i = 0; i < 100; i += 1) {
      nodes.push(model.createNode({ id: `fat${i}`, parentId: "fat", title: `Fat step ${i}`, rank: i }));
    }
    for (let g = 0; g < 9; g += 1) {
      nodes.push(model.createNode({ id: `g${g}`, title: `Goal ${g}`, rank: g + 1 }));
      for (let i = 0; i < 50; i += 1) {
        nodes.push(model.createNode({ id: `g${g}s${i}`, parentId: `g${g}`, title: `Goal ${g} step ${i}`, rank: i }));
      }
    }
    const built = aihelp.buildTreePrompt({ schema: 2, nodes, entities: [], settings: {} }, "en", { now: 0 });
    return {
      goalCap: aihelp.MAX_GOAL_NODES,
      totalCap: aihelp.MAX_TREE_NODES,
      listed: built.context.goals.map((g) => g.parts.length),
      trimmedPer: built.context.goals.map((g) => g.partsTrimmed),
      partCount: built.context.partCount,
      stepCount: built.context.stepCount,
      trimmed: built.context.trimmed,
      text: built.text,
    };
  });

  expect(r.goalCap).toBe(60);
  expect(r.totalCap).toBe(400);
  // 60 of the fat goal's 100, then six goals of 50, then 40 of the seventh -
  // 400 - and the last two goals get nothing at all.
  expect(r.listed).toEqual([60, 50, 50, 50, 50, 50, 50, 40, 0, 0]);
  expect(r.trimmedPer).toEqual([40, 0, 0, 0, 0, 0, 0, 10, 50, 50]);
  expect(r.partCount).toBe(400);
  expect(r.stepCount).toBe(550);
  expect(r.trimmed).toBe(150);

  // What was cut is said where it was cut, so a subset is never read as a whole.
  expect(r.text).toContain("+ 40 more steps under this goal, not listed");
  expect(r.text).toContain("+ 10 more steps under this goal, not listed");
  expect(r.text).toContain("+ 50 more steps under this goal, not listed");
  // The goals the total cap emptied still stand in the list, with their count.
  expect(r.text).toContain("Goal 8 (open)");
  expect(r.text).not.toContain("Goal 8 step 0");
  // The listed part of the fat goal is the FRONT of it, not a random slice.
  expect(r.text).toContain("Fat step 0");
  expect(r.text).toContain("Fat step 59");
  expect(r.text).not.toContain("Fat step 60");
});

test("one trimmed step is written as one, not as a number", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const aihelp = await import("/web/js/aihelp.js");
    const model = await import("/web/js/model.js");
    const nodes = [model.createNode({ id: "a", title: "The goal", rank: 0 })];
    for (let i = 0; i < 61; i += 1) {
      nodes.push(model.createNode({ id: `s${i}`, parentId: "a", title: `Step ${i}`, rank: i }));
    }
    const out = {};
    for (const locale of ["en", "de", "es"]) {
      out[locale] = aihelp.buildTreePrompt({ schema: 2, nodes, entities: [], settings: {} }, locale, { now: 0 }).text;
    }
    return out;
  });

  expect(r.en).toContain("+ one more step under this goal, not listed");
  expect(r.de).toContain("+ ein weiterer Schritt unter diesem Ziel, hier nicht aufgeführt");
  expect(r.es).toContain("+ un paso más bajo este objetivo, aquí sin listar");
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
        // An opted-out branch UNDER a living goal: absent WITH its children, and
        // out of its counts. The children are the new part - the outline would
        // have carried them, so this is the test that says it does not.
        model.createNode({ id: "c1", parentId: "c", title: "Tandem partner", rank: 0 }),
        model.createNode({ id: "c2", parentId: "c", title: "The therapy homework", rank: 1, llmOptout: true }),
        model.createNode({ id: "c21", parentId: "c2", title: "Write the letter to my mother", rank: 0 }),
        model.createNode({ id: "c22", parentId: "c2", title: "Read it out loud on Thursday", rank: 1 }),
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
  expect(r.text).not.toContain("letter to my mother");
  expect(r.text).not.toContain("Thursday");
  expect(r.text).not.toContain("Ana");
  expect(r.text).not.toContain("Said the tear is old");
  // What may travel, did - the living branch of that same goal included.
  expect(r.text).toContain("Get the knee fixed");
  expect(r.text).toContain("Tandem partner");
  expect(r.text).toContain("Dr Alvarez");
  // The rank of the withheld goal leaves a gap rather than a renumbered list.
  expect(r.context.goals.map((g) => g.rank)).toEqual([1, 3]);
  // The opted-out branch is out of its parent's counts and out of its outline.
  expect(r.context.goals[1]).toMatchObject({ title: "Spanish up to B2", steps: 1 });
  expect(r.context.goals[1].parts.map((p) => p.title)).toEqual(["Tandem partner"]);
  // One goal withheld, and three steps: the branch and the two under it.
  expect(r.context.omitted).toEqual({
    optout: 4,
    optoutGoals: 1,
    optoutSteps: 3,
    sensitive: 1,
    notes: true,
  });
  // And what was held back is NAMED and COUNTED, so no gap gets filled with a
  // guess and nobody reads a hole as a small one.
  expect(r.text).toContain("LEFT OUT ON PURPOSE");
  expect(r.text).toContain("parts I keep away from any model (one goal and 3 steps)");
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
        model.createNode({ id: "a1", parentId: "a", title: "Book the theory course", rank: 0 }),
        model.createNode({ id: "a11", parentId: "a1", title: "Compare two schools", rank: 0 }),
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
      return [
        shape(tree),
        shape(tree.labels),
        shape(tree.marks),
        shape(tree.due),
        shape(tree.counts),
        String(tree.ask.length),
      ].join("|");
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
      shape: "the whole tree, indented",
      steps: "THE STEPS UNDER IT:",
    },
    de: {
      questions: "bis zu drei Fragen",
      week: "die kommende Woche verdient",
      read: "ich lese das, ich importiere es nicht",
      order: "ob die Reihenfolge ehrlich ist",
      shape: "der ganze Baum, eingerückt",
      steps: "DIE SCHRITTE DARUNTER:",
    },
    es: {
      questions: "hasta tres preguntas",
      week: "merece la semana que viene",
      read: "lo voy a leer, no importar",
      order: "si el orden es honesto",
      shape: "el árbol entero, con sangría",
      steps: "LOS PASOS DEBAJO:",
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

    // The whole list travelled, and now the whole tree with it: the framing
    // clause that says so, the heading over the outline, and the outline.
    expect(text, locale).toContain("1. Learn to sail");
    expect(text, locale).toContain("2. Spanish up to B2");
    expect(text, locale).toContain(p.shape);
    expect(text, locale).toContain(p.steps);
    expect(text, locale).toContain("    Book the theory course");
    expect(text, locale).toContain("      Compare two schools");
  }
});

// ------------------------------------------------------------------ the sheet

test("tapping the title of the ten opens the review, with no way to paste anything back", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed", "Spanish up to B2", "A quieter month"]);

  // A story on the first one, and two levels under it, so the prompt carries
  // the tree rather than three titles.
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const root = ctx.doc.nodes.find((n) => n.title === "Get the knee fixed");
    ctx.updateNode(root.id, { story: "Running hurts after ten minutes. The referral has been on the desk since March." });
    ctx.importTree(root.id, [
      { title: "Book the MRI", level: 0 },
      { title: "Ring the practice", level: 1 },
      { title: "Swim twice a week", level: 0 },
    ]);
  });

  // The heading is still a heading, and now it is also the way in.
  await expect(page.locator("h1.h-title")).toHaveText("The Ten");
  const entry = page.locator(".h-title-btn");
  await expect(entry).toHaveAttribute("aria-label", /whole list/i);
  await entry.click();

  await expect(page.locator(".sheet-title")).toHaveText("Look at the whole list with an AI");
  // The honest line counts what actually travels: the goals AND the steps.
  const scope = page.locator(".field-hint").first();
  await expect(scope).toContainText("your 3 goals in their order and the 3 steps under them");
  await expect(scope).toContainText("keep away from a model");

  const prompt = await page.locator('[data-ai="tree-prompt"]').inputValue();
  expect(prompt).toContain("1. Get the knee fixed");
  expect(prompt).toContain("2. Spanish up to B2");
  expect(prompt).toContain("3. A quieter month");
  expect(prompt).toContain("Running hurts after ten minutes");
  expect(prompt).toContain("nothing written yet");
  expect(prompt).toContain("no steps yet");
  expect(prompt).toContain("deserves the coming week");
  // The tree, indented, and the clause that says it is one.
  expect(prompt).toContain("the whole tree, indented");
  expect(prompt).toContain("    Book the MRI");
  expect(prompt).toContain("      Ring the practice");
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
