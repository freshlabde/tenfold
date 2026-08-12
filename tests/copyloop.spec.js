// The copy loop: a prompt carried out by hand, an answer pasted back.
//
// Nothing in this file talks to a model, and that is the point of the feature:
// the person is the transport. What is under test is therefore what the app
// builds and what it reads - the scoping rules that decide what may enter a
// prompt at all, the clipboard, the parser that turns an indented answer into
// steps, and the rule that nothing a model wrote reaches the document without
// somebody having looked at it first.
import { test, expect } from "@playwright/test";

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

// Real WebCrypto: 600000 PBKDF2 rounds per vault.
test.describe.configure({ mode: "parallel", timeout: 240_000 });

// The clipboard is a permission, and a copy button that cannot copy is not a
// copy button - so the suite grants it rather than mocking the call away.
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

/** One goal with two steps under it, opened on its own leaf screen. */
async function goalWithSteps(page) {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed"]);
  await page.locator(".row").first().click();
  await page.getByRole("button", { name: /Add the first part/ }).click();
  for (const title of ["Book the MRI", "Call the physio"]) {
    await page.locator(".composer input").fill(title);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
  await page.locator(".hero-card").click();
  await expect(page.locator(".leaf-title")).toHaveText("Get the knee fixed");
}

/** Open the copy-loop sheet from the leaf screen. */
async function openLoop(page) {
  await page.locator('[data-ai="copy"]').click();
  await expect(page.locator(".sheet-title")).toHaveText("Think it through with an AI");
}

/** Every node in the document, as plain data. */
function nodesOf(page) {
  return page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return ctx.doc.nodes
      .filter((n) => !n.deletedAt)
      .map((n) => ({ id: n.id, title: n.title, parentId: n.parentId, origin: n.origin }));
  });
}

// ------------------------------------------------------- what may enter a prompt

test("the prompt is the neighbourhood, and never what was kept back", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const aihelp = await import("/web/js/aihelp.js");
    const model = await import("/web/js/model.js");
    const nodes = [
      model.createNode({ id: "root", title: "Get the knee fixed", rank: 0, story: "Running hurts." }),
      model.createNode({
        id: "kid",
        title: "Book the MRI",
        parentId: "root",
        rank: 0,
        story: "The referral is on the desk.",
        entityRefs: ["doc", "anna"],
      }),
      model.createNode({ id: "kid2", title: "Call the physio", parentId: "root", rank: 1 }),
      model.createNode({ id: "grand", title: "Ask for the earliest slot", parentId: "kid", rank: 0 }),
      model.createNode({ id: "under", title: "SECRET-STEP", parentId: "kid", rank: 1, llmOptout: true }),
      model.createNode({ id: "under-kid", title: "SECRET-STEP-CHILD", parentId: "under", rank: 0 }),
      model.createNode({ id: "secret", title: "SECRET-BRANCH", parentId: "root", rank: 2, llmOptout: true }),
      model.createNode({ id: "secret-kid", title: "SECRET-CHILD", parentId: "secret", rank: 0 }),
      model.createNode({ id: "far", title: "FAR-AWAY-GOAL", rank: 1, story: "FAR-STORY" }),
      model.createNode({ id: "far-kid", title: "FAR-CHILD", parentId: "far", rank: 0 }),
    ];
    const entities = [
      model.createEntity({
        id: "doc",
        name: "Dr Weber",
        kind: "person",
        relation: "orthopaedist",
        notes: "NOTE-CANARY-ordinary",
      }),
      model.createEntity({
        id: "anna",
        name: "Anna",
        kind: "person",
        relation: "my wife",
        sensitivity: "high",
        notes: "SENSITIVE-CANARY",
      }),
    ];
    // Everything a vault carries besides the tree, with a canary in each: none
    // of it has any business in a prompt, and none of it is even reachable
    // from the builder.
    const doc = {
      schema: 2,
      nodes,
      entities,
      settings: {
        lang: "en",
        llm: { mode: "cloud", apiKey: "KEY-CANARY", baseUrl: "https://CANARY.example", model: "m" },
        sync: { id: "SYNCID-CANARY", pass: "RECOVERY-CANARY" },
      },
      recovery: "RECOVERY-CANARY",
    };

    const built = (id, locale) => {
      const value = aihelp.buildPrompt(doc, id, locale);
      return value ? { text: value.text, context: value.context } : null;
    };
    return {
      en: built("kid", "en"),
      de: built("kid", "de"),
      es: built("kid", "es"),
      insideOptout: built("secret-kid", "en"),
      optoutItself: built("secret", "en"),
      gone: built("nope", "en"),
      promptKeys: Object.keys(aihelp.PROMPT).map((l) => ({
        locale: l,
        labels: Object.keys(aihelp.PROMPT[l].labels).sort().join(","),
        status: Object.keys(aihelp.PROMPT[l].status).sort().join(","),
        steps: aihelp.PROMPT[l].ask.length,
      })),
    };
  });

  // An opted-out branch does not appear, in any field, in any language - and
  // neither does a step opted out further down.
  for (const locale of ["en", "de", "es"]) {
    const text = r[locale].text;
    expect(text, locale).not.toContain("SECRET-BRANCH");
    expect(text, locale).not.toContain("SECRET-CHILD");
    expect(text, locale).not.toContain("SECRET-STEP");
    // A card marked sensitive stays here. There is no release for one call in
    // this loop, because there is no one call: the text goes to the clipboard.
    expect(text, locale).not.toContain("SENSITIVE-CANARY");
    expect(text, locale).not.toContain("Anna");
    // The notes on an ordinary card stay too, the name and the relation go.
    expect(text, locale).not.toContain("NOTE-CANARY-ordinary");
    expect(text, locale).toContain("Dr Weber");
    // The tree beyond the chain is never in it.
    expect(text, locale).not.toContain("FAR-AWAY-GOAL");
    expect(text, locale).not.toContain("FAR-STORY");
    expect(text, locale).not.toContain("FAR-CHILD");
    // Nor is anything that is not the tree at all.
    expect(text, locale).not.toContain("KEY-CANARY");
    expect(text, locale).not.toContain("SYNCID-CANARY");
    expect(text, locale).not.toContain("RECOVERY-CANARY");
    expect(text, locale).not.toContain("CANARY.example");
    // What the person asked for IS in it.
    expect(text, locale).toContain("Book the MRI");
    expect(text, locale).toContain("The referral is on the desk.");
    expect(text, locale).toContain("Get the knee fixed");
    expect(text, locale).toContain("Ask for the earliest slot");
  }

  // Target, one ancestor, one remaining step - and that is the whole of it.
  expect(r.en.context.nodeCount).toBe(3);
  expect(r.en.context.omitted).toEqual({ optout: 1, sensitive: 1, notes: true });
  // It says out loud that something was held back, so the model does not fill
  // the gap with a guess.
  expect(r.en.text).toContain("LEFT OUT ON PURPOSE");
  expect(r.de.text).toContain("BEWUSST WEGGELASSEN");
  expect(r.es.text).toContain("OMITIDO A PROPÓSITO");

  // A node inside an opted-out branch has no prompt at all, rather than a
  // reduced one - and neither has one that does not exist.
  expect(r.insideOptout).toBeNull();
  expect(r.optoutItself).toBeNull();
  expect(r.gone).toBeNull();

  // The three languages are interchangeable, the way the catalogues are.
  const shape = r.promptKeys[0];
  for (const entry of r.promptKeys) {
    expect(entry.labels, entry.locale).toBe(shape.labels);
    expect(entry.status, entry.locale).toBe(shape.status);
    expect(entry.steps, entry.locale).toBe(shape.steps);
  }
});

test("the prompt asks for questions first, in the language the app is in", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const aihelp = await import("/web/js/aihelp.js");
    const model = await import("/web/js/model.js");
    const doc = {
      schema: 2,
      nodes: [model.createNode({ id: "root", title: "Learn to sail", rank: 0 })],
      entities: [],
      settings: {},
    };
    return {
      en: aihelp.buildPrompt(doc, "root", "en").text,
      de: aihelp.buildPrompt(doc, "root", "de").text,
      es: aihelp.buildPrompt(doc, "root", "es").text,
      unknown: aihelp.buildPrompt(doc, "root", "kl").text,
    };
  });
  expect(r.en).toContain("up to three questions");
  expect(r.de).toContain("bis zu drei Fragen");
  expect(r.es).toContain("hasta tres preguntas");
  // An unknown locale falls back to English rather than to nothing.
  expect(r.unknown).toBe(r.en);
  // A goal without steps says so by leaving the heading out entirely.
  expect(r.en).not.toContain("STEPS SO FAR");
});

// This test exists because of a failure in the wild. The prompt was carried to
// Grok, the conversation ran two turns, and the answer came back as sentences -
// "food write down everything I eat... sport pick the four home-workout days" -
// with the list instruction, which sat in the MIDDLE of the prompt, quietly
// forgotten by the second turn. So: the format demand is the last thing the
// model reads, it asks for one machine-readable thing rather than an
// indentation convention, and it says out loud that it holds for every later
// answer too. All three of those properties are asserted here, in three
// languages, because a prompt is only a contract while its wording holds.
test("the prompt ends with the fenced-JSON demand and the drift guard, in three languages", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const aihelp = await import("/web/js/aihelp.js");
    const model = await import("/web/js/model.js");
    const doc = {
      schema: 2,
      nodes: [model.createNode({ id: "root", title: "Learn to sail", rank: 0 })],
      entities: [],
      settings: {},
    };
    const out = {};
    for (const locale of ["en", "de", "es"]) {
      out[locale] = {
        text: aihelp.buildPrompt(doc, "root", locale).text,
        last: aihelp.PROMPT[locale].ask[aihelp.PROMPT[locale].ask.length - 1],
      };
    }
    return out;
  });

  const phrases = {
    en: {
      questions: "up to three questions",
      fence: "three backticks",
      deal: "end with that one code block",
      drift: "every answer that follows",
      whole: "the whole list, not only the part that changed",
    },
    de: {
      questions: "bis zu drei Fragen",
      fence: "drei Backticks",
      deal: "hör mit diesem einen Codeblock auf",
      drift: "jede weitere Antwort",
      whole: "der ganzen Liste, nicht nur dem, was sich geändert hat",
    },
    es: {
      questions: "hasta tres preguntas",
      fence: "tres acentos graves",
      deal: "acaba con ese único bloque de código",
      drift: "cada respuesta siguiente",
      whole: "la lista entera, no solo lo que ha cambiado",
    },
  };

  for (const locale of ["en", "de", "es"]) {
    const text = r[locale].text;
    const p = phrases[locale];
    // The schema, spelled out in the prompt itself rather than only in a doc.
    expect(text, locale).toContain("```");
    expect(text, locale).toContain('"step"');
    expect(text, locale).toContain('"substeps"');
    expect(text, locale).toContain("JSON");
    expect(text, locale).toContain(p.fence);
    expect(text, locale).toContain(p.deal);
    // Recency wins: the demand comes AFTER the dramaturgy, not before it.
    expect(text.indexOf(p.fence), locale).toBeGreaterThan(text.indexOf(p.questions));
    // The multi-turn guard, and the fact that it is the last word.
    expect(text, locale).toContain(p.drift);
    expect(text.trimEnd().endsWith(r[locale].last.trim()), locale).toBe(true);
    expect(r[locale].last, locale).toContain(p.whole);
    // And the dramaturgy is still the dramaturgy: questions first.
    expect(text, locale).toContain(p.questions);
    // The old indentation convention is gone from the ask, in every language:
    // two formats asked for at once is how a model picks the wrong one.
    expect(text, locale).not.toContain("two spaces");
    expect(text, locale).not.toContain("zwei Leerzeichen");
    expect(text, locale).not.toContain("dos espacios");
  }
});

// ------------------------------------------------------------------ the parser

test("an indented answer becomes levels, whatever it was indented with", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const { parseOutlineText, MAX_OUTLINE_TITLE } = await import("/web/js/aihelp.js");
    const items = (text) => parseOutlineText(text).items;
    return {
      spaces: items("Book the MRI\n  Ask for the earliest slot\n  Take the referral\nCall the physio"),
      tabs: items("Book the MRI\n\tAsk for the slot\nCall the physio"),
      bullets: items("- Book the MRI\n    * Ask for the slot\n- Call the physio"),
      numbered: items("1. Book the MRI\n   1) Ask for the slot\n2. Call the physio"),
      boxes: items("- [ ] Book the MRI\n  - [x] Ask for the slot"),
      emphasis: items("**Book the MRI**\n  _Ask for the slot_"),
      heading: items("Preparation:\n  Book the MRI"),
      deep: items("a\n  b\n    c\n      d\n        e"),
      blanks: items("Book the MRI\n\n\n  Ask for the slot\n   \n"),
      prose: items("Here are the next steps:\n\nBook the MRI\nCall the physio"),
      empty: items("   \n\n"),
      long: items("x".repeat(400)),
      many: items(Array.from({ length: 140 }, (_, i) => `step ${i}`).join("\n")),
      cap: MAX_OUTLINE_TITLE,
    };
  });

  expect(r.spaces).toEqual([
    { title: "Book the MRI", level: 0 },
    { title: "Ask for the earliest slot", level: 1 },
    { title: "Take the referral", level: 1 },
    { title: "Call the physio", level: 0 },
  ]);
  expect(r.tabs.map((i) => i.level)).toEqual([0, 1, 0]);
  expect(r.bullets).toEqual([
    { title: "Book the MRI", level: 0 },
    { title: "Ask for the slot", level: 1 },
    { title: "Call the physio", level: 0 },
  ]);
  expect(r.numbered).toEqual([
    { title: "Book the MRI", level: 0 },
    { title: "Ask for the slot", level: 1 },
    { title: "Call the physio", level: 0 },
  ]);
  expect(r.boxes).toEqual([
    { title: "Book the MRI", level: 0 },
    { title: "Ask for the slot", level: 1 },
  ]);
  expect(r.emphasis).toEqual([
    { title: "Book the MRI", level: 0 },
    { title: "Ask for the slot", level: 1 },
  ]);
  // A heading keeps its words and loses its colon.
  expect(r.heading[0]).toEqual({ title: "Preparation", level: 0 });
  // Four levels is the floor of the house, and the fifth lands on the fourth.
  expect(r.deep.map((i) => i.level)).toEqual([0, 1, 2, 3, 3]);
  expect(r.blanks.map((i) => i.level)).toEqual([0, 1]);
  // Nothing is silently swallowed: a sentence in front of the list is a line
  // the person sees in the preview and cancels on, not something dropped here.
  expect(r.prose).toHaveLength(3);
  expect(r.empty).toEqual([]);
  expect(r.long[0].title).toHaveLength(r.cap);
  expect(r.many).toHaveLength(100);
});

// The order the sheet reads a paste in: last fenced block, JSON, outline text.
// Everything a chat window puts AROUND the answer is the enemy here, and every
// case below is a shape a real model has produced.
test("the answer is taken from the last fenced block, as JSON first and as an outline after", async ({
  page,
}) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const { parseAnswer, fencedBlocks } = await import("/web/js/aihelp.js");
    const fence = (value, tag) => "```" + (tag || "") + "\n" + value + "\n```";
    const json = (value, tag) => fence(JSON.stringify(value, null, 2), tag);
    const steps = [
      {
        step: "Call the practice on Monday",
        substeps: ["Ask for the earliest slot", "Write the date on the fridge"],
      },
      { step: "Take the referral out of the drawer" },
    ];
    // Thirty levels of nesting: a shape nobody writes by hand.
    let deep = [{ step: "bottom" }];
    for (let i = 0; i < 30; i += 1) deep = [{ step: "level " + i, substeps: deep }];

    return {
      pure: parseAnswer(json(steps, "json")),
      // The Grok case: a question, some thinking out loud, the block, an offer.
      grok: parseAnswer(
        [
          "Good question. Before the list, one thing I noticed:",
          "you said the knee still hurts, so I keep Monday light.",
          "",
          json(steps),
          "",
          "Tell me if you want the second one broken down further.",
        ].join("\n"),
      ),
      twoBlocks: parseAnswer(
        [
          json([{ step: "FIRST-BLOCK" }]),
          "On reflection I would rather do it like this:",
          json([{ step: "LAST-BLOCK" }]),
        ].join("\n\n"),
      ),
      fencedText: parseAnswer(fence("Call the practice\n  Ask for the slot")),
      bareJson: parseAnswer(JSON.stringify(steps)),
      bareText: parseAnswer("Call the practice\n  Ask for the slot"),
      // What broke in the wild: flowing sentences, no list at all.
      prose: parseAnswer(
        "food write down everything I eat and drink for a week, sport pick the four home-workout days",
      ),
      tagInside: parseAnswer(fence("json\n" + JSON.stringify(steps))),
      unclosed: parseAnswer("Here you go:\n\n```json\n" + JSON.stringify(steps)),
      broken: parseAnswer(fence('[{"step": "Call the practice",]')),
      wrapper: parseAnswer(json({ steps })),
      numeric: parseAnswer(json([{ step: 42, substeps: ["Ask for the slot"] }])),
      strings: parseAnswer(json(["Call the practice", ["Ask for the slot"]])),
      canary: parseAnswer(json([{ step: '<img src=x onerror="window.XSS=1">' }])),
      many: parseAnswer(json(Array.from({ length: 140 }, (_, i) => ({ step: "s" + i })))),
      deep: parseAnswer(json(deep)),
      long: parseAnswer(json([{ step: "x".repeat(400) }])),
      emptyArray: parseAnswer(json([])),
      blocks: fencedBlocks("chat\n```\none\n```\nmore chat\n~~~\ntwo\n~~~\nand more"),
    };
  });

  const outline = [
    { title: "Call the practice on Monday", level: 0 },
    { title: "Ask for the earliest slot", level: 1 },
    { title: "Write the date on the fridge", level: 1 },
    { title: "Take the referral out of the drawer", level: 0 },
  ];

  // A clean answer, and the same answer with a chat wrapped around it, are the
  // same four steps. That is the whole fix.
  expect(r.pure.items).toEqual(outline);
  expect(r.pure.source).toBe("json");
  expect(r.grok.items).toEqual(outline);
  expect(r.grok.source).toBe("json");
  expect(r.grok.fenced).toBe(true);
  // Two blocks: the one the model settled on is the last one.
  expect(r.twoBlocks.items).toEqual([{ title: "LAST-BLOCK", level: 0 }]);
  // A fence around an indented list is still an indented list.
  expect(r.fencedText.items).toEqual([
    { title: "Call the practice", level: 0 },
    { title: "Ask for the slot", level: 1 },
  ]);
  expect(r.fencedText.source).toBe("text");
  // No fence at all, either way round: JSON is read, and text is read exactly
  // as it was before this order existed.
  expect(r.bareJson.items).toEqual(outline);
  expect(r.bareJson.source).toBe("json");
  expect(r.bareJson.fenced).toBe(false);
  expect(r.bareText.items).toEqual([
    { title: "Call the practice", level: 0 },
    { title: "Ask for the slot", level: 1 },
  ]);
  expect(r.bareText.source).toBe("text");
  // Prose that ignored the contract is not rescued and not swallowed: it
  // arrives as the line it is, and the preview is where the person sees that.
  expect(r.prose.source).toBe("text");
  expect(r.prose.items).toHaveLength(1);
  expect(r.prose.items[0].title).toContain("food write down everything");

  // A language tag inside the block instead of on the fence, and a block the
  // model never closed because it ran out of room.
  expect(r.tagInside.items).toEqual(outline);
  expect(r.unclosed.items).toEqual(outline);
  // Strict JSON: a comma where a value belongs, and an object around the array,
  // are both "not JSON" and fall through to the forgiving reader rather than
  // being repaired behind the person's back.
  expect(r.broken.source).toBe("text");
  expect(r.wrapper.source).toBe("text");
  expect(r.wrapper.items.length).toBeGreaterThan(0);
  // A step that is not a string is a broken entry - the entry goes, what hung
  // under it moves up rather than vanishing with it.
  expect(r.numeric.items).toEqual([{ title: "Ask for the slot", level: 0 }]);
  // Plain strings and a bare nested array are read too: accept more, never less.
  expect(r.strings.items).toEqual([
    { title: "Call the practice", level: 0 },
    { title: "Ask for the slot", level: 1 },
  ]);
  // The markup canary on the JSON path: characters, never an element.
  expect(r.canary.items).toEqual([{ title: '<img src=x onerror="window.XSS=1">', level: 0 }]);
  // The three limits are the same three limits, whichever reader produced them.
  expect(r.many.items).toHaveLength(100);
  expect(r.long.items[0].title).toHaveLength(200);
  expect(Math.max(...r.deep.items.map((i) => i.level))).toBeLessThanOrEqual(3);
  expect(r.deep.items).toHaveLength(13);
  // An empty array is an answer with nothing in it, not a reason to go hunting
  // through the prose: the preview says so and writes nothing.
  expect(r.emptyArray.items).toEqual([]);
  expect(r.emptyArray.source).toBe("json");
  // Both fence characters, content only, in the order they were written.
  expect(r.blocks).toEqual(["one", "two"]);
});

// The outline shaper used to be shared by two ways in - a photographed list and
// a pasted answer - and this test proved they were literally the same function.
// The photo import went with the relay in v1.1, so there is one way in now and
// nothing to compare it against. What is left is the shaper itself: the clamps
// it applies to a level nobody controls, and the tree it builds out of them.
test("the outline shaper clamps every level and finds every parent", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const aihelp = await import("/web/js/aihelp.js");
    return {
      // A first line further in than the margin, a jump of two, a level past
      // four, a negative one, a missing one - all corrected, none refused.
      clamped: aihelp.normalizeOutlineItems([
        { title: "a", level: 3 },
        { title: "b", level: 9 },
        { title: "c", level: -4 },
        { title: "d" },
        { title: "e", level: 2 },
      ]),
      long: aihelp.normalizeOutlineItems([{ title: "x".repeat(500), level: 0 }]),
      many: aihelp.normalizeOutlineItems(
        Array.from({ length: 140 }, (_, i) => ({ title: `t${i}`, level: 0 })),
      ),
      empty: aihelp.normalizeOutlineItems([]),
      blank: aihelp.normalizeOutlineItems([{ title: "   " }]),
      wrong: aihelp.normalizeOutlineItems({ nope: 1 }),
      numeric: aihelp.normalizeOutlineItems([{ title: 42, level: 0 }]),
      parents: aihelp.parentIndexes([
        { level: 0 }, { level: 1 }, { level: 2 }, { level: 2 }, { level: 3 }, { level: 0 }, { level: 1 },
      ]),
      capped: aihelp.blockedByRootCap(
        [{ level: 0 }, { level: 1 }, { level: 0 }, { level: 0 }, { level: 1 }],
        2,
      ),
      // And the text path lands on the same clamp, because it ends in the same
      // function: ten spaces of indent is still one level down, never nine.
      viaText: aihelp.parseOutlineText("a\n          b").items,
    };
  });

  expect(r.clamped).toEqual([
    { title: "a", level: 0 },
    { title: "b", level: 1 },
    { title: "c", level: 0 },
    { title: "d", level: 0 },
    { title: "e", level: 1 },
  ]);
  expect(r.long[0].title).toHaveLength(200);
  expect(r.many).toHaveLength(100);
  // Nothing usable in, nothing out - and never a throw: a shaper that raises
  // would take the preview down with it, and the preview is the safety rail.
  expect(r.empty).toEqual([]);
  expect(r.blank).toEqual([]);
  expect(r.wrong).toEqual([]);
  // A title that is a number is a broken entry, not a title with a number in it.
  expect(r.numeric).toEqual([]);
  expect(r.parents).toEqual([-1, 0, 1, 1, 3, -1, 5]);
  expect(r.capped).toEqual([false, false, false, true, true]);
  expect(r.viaText).toEqual([{ title: "a", level: 0 }, { title: "b", level: 1 }]);
});

// --------------------------------------------------------------------- the loop

test("the sheet says what travels, and the button puts it on the clipboard", async ({ page }) => {
  await goalWithSteps(page);
  // The entry exists without a relay being configured anywhere: assistance is
  // switched off in this vault and always has been.
  await openLoop(page);

  await expect(page.locator(".sheet")).toContainText("What travels:");
  await expect(page.locator(".sheet")).toContainText("2 steps");
  await expect(page.locator(".sheet")).toContainText("keep away from a model");

  const shown = await page.locator('[data-ai="prompt"]').inputValue();
  expect(shown).toContain("GOAL: Get the knee fixed");
  expect(shown).toContain("STEPS SO FAR");
  expect(shown).toContain("Book the MRI");
  expect(shown).toContain("up to three questions");

  await page.locator('[data-ai="copy-do"]').click();
  await expect(page.locator("#toast")).toContainText("Copied");
  const clipped = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipped).toBe(shown);
});

test("a pasted answer is shown before it is written, and cancelling writes nothing", async ({ page }) => {
  await goalWithSteps(page);
  await openLoop(page);
  const before = await nodesOf(page);

  await page.locator('[data-ai="paste-open"]').click();
  await page.locator('[data-ai="answer"]').fill(
    [
      "Here is what I would do next:",
      "",
      "- Call the practice on Monday",
      "  - Ask for the earliest slot",
      "  - Write the date on the fridge",
      "- Take the referral out of the drawer",
    ].join("\n"),
  );
  await page.locator('[data-ai="look"]').click();

  // The count and the lines themselves, and not one node yet. The sentence the
  // model wrote in front of its list is in there too: nothing is dropped
  // behind the person's back, it is shown and it can be cancelled.
  await expect(page.locator(".sheet")).toContainText("5 steps would be written under Get the knee fixed");
  await expect(page.locator('[data-ai="preview-item"]')).toHaveCount(5);
  await expect(page.locator('[data-ai="preview-item"]').first()).toContainText(
    "Here is what I would do next",
  );
  await expect(page.locator('[data-ai="preview-item"]').nth(2)).toHaveAttribute("data-level", "1");
  expect(await nodesOf(page)).toEqual(before);

  // Cancel goes back to the field with the text still in it, and the document
  // is exactly where it was.
  await page.locator('[data-ai="cancel"]').click();
  await expect(page.locator('[data-ai="answer"]')).toHaveValue(/Call the practice on Monday/);
  expect(await nodesOf(page)).toEqual(before);
  await page.locator(".sheet-head").getByRole("button", { name: "Close" }).click();
  expect(await nodesOf(page)).toEqual(before);
});

test("applying writes the pasted outline as steps, marked as model-made", async ({ page }) => {
  await goalWithSteps(page);
  await openLoop(page);

  await page.locator('[data-ai="paste-open"]').click();
  await page.locator('[data-ai="answer"]').fill(
    ["Call the practice on Monday", "  Ask for the earliest slot", "Take the referral out of the drawer"].join(
      "\n",
    ),
  );
  await page.locator('[data-ai="look"]').click();
  await page.locator('[data-ai="apply"]').click();
  await expect(page.locator("#toast")).toContainText("3 taken over.");

  const nodes = await nodesOf(page);
  const root = nodes.find((n) => n.title === "Get the knee fixed");
  const call = nodes.find((n) => n.title === "Call the practice on Monday");
  const ask = nodes.find((n) => n.title === "Ask for the earliest slot");
  const take = nodes.find((n) => n.title === "Take the referral out of the drawer");

  // The outer margin hangs under the goal the sheet was opened on, the
  // indented line under the line above it - and all three say where they came
  // from, which is the whole reason origin exists.
  expect(call.parentId).toBe(root.id);
  expect(take.parentId).toBe(root.id);
  expect(ask.parentId).toBe(call.id);
  for (const made of [call, ask, take]) expect(made.origin).toBe("llm");
  // The two steps that were there before are untouched and still manual.
  expect(nodes.find((n) => n.title === "Book the MRI").origin).toBe("manual");

  // And they are on the screen, under the goal, in the order they were written.
  await page.locator(".crumb-back").click();
  await expect(page.locator(".list.is-kids .row-title")).toHaveText([
    "Book the MRI",
    "Call the physio",
    "Call the practice on Monday",
    "Take the referral out of the drawer",
  ]);
});

// Carried over from the photo import when that was removed in v1.1. The rule it
// guards has nothing to do with how an outline arrives: a model answer is
// untrusted text, exactly like a note, and it reaches the screen as text nodes
// or not at all. The paste path is now the only way model-authored text enters
// this app, so this is the only place the canary can still stand.
test("a pasted title that tries to be markup stays a title", async ({ page }) => {
  await goalWithSteps(page);
  await openLoop(page);

  const canary = '<img src=x onerror="window.XSS=1">';
  await page.locator('[data-ai="paste-open"]').click();
  await page.locator('[data-ai="answer"]').fill([canary, "  <script>window.XSS=2</script>"].join("\n"));
  await page.locator('[data-ai="look"]').click();

  // In the preview: the characters, not an element.
  await expect(page.locator('[data-ai="preview-item"]')).toHaveCount(2);
  await expect(page.locator(".assist-title").first()).toHaveText(canary);
  expect(await page.locator(".sheet img, .sheet script").count()).toBe(0);
  expect(await page.evaluate(() => window.XSS)).toBeUndefined();

  // And after applying, on the screen and in the document.
  await page.locator('[data-ai="apply"]').click();
  await page.locator(".crumb-back").click();
  await expect(page.locator(".list.is-kids .row-title").nth(2)).toHaveText(canary);
  expect(await page.evaluate(() => window.XSS)).toBeUndefined();
  expect(await page.locator("#app img, #app script").count()).toBe(0);

  const nodes = await nodesOf(page);
  const outer = nodes.find((n) => n.title === canary);
  const inner = nodes.find((n) => n.title === "<script>window.XSS=2</script>");
  expect(inner.parentId).toBe(outer.id);
  expect(outer.origin).toBe("llm");
});

// The same failure as the parser test above, but through the sheet: what a
// person actually does is select the whole conversation and paste it. The chat
// around the block must not reach the preview, and the block must - including a
// title that tries to be markup, which is the canary above on the JSON path.
test("a whole chat pasted back becomes only the steps in its last code block", async ({ page }) => {
  await goalWithSteps(page);
  await openLoop(page);
  const canary = '<img src=x onerror="window.XSS=1">';
  const list = [
    { step: "Call the practice on Monday", substeps: ["Ask for the earliest slot"] },
    { step: canary },
  ];

  await page.locator('[data-ai="paste-open"]').click();
  await page.locator('[data-ai="answer"]').fill(
    [
      "Before I answer: how many days a week can you actually train?",
      "",
      "Three days, understood. food write down everything you eat, sport pick the days.",
      "",
      "```json",
      JSON.stringify(list, null, 2),
      "```",
      "",
      "Say the word and I will break the second one down.",
    ].join("\n"),
  );
  await page.locator('[data-ai="look"]').click();

  await expect(page.locator(".sheet")).toContainText("3 steps would be written under Get the knee fixed");
  await expect(page.locator('[data-ai="preview-item"]')).toHaveCount(3);
  // Not one sentence of the conversation, and no JSON punctuation either.
  await expect(page.locator(".sheet")).not.toContainText("how many days a week");
  await expect(page.locator(".sheet")).not.toContainText("food write down everything");
  await expect(page.locator(".sheet")).not.toContainText("substeps");
  await expect(page.locator('[data-ai="preview-item"]').nth(1)).toHaveAttribute("data-level", "1");
  // The markup canary holds on this path too: the characters, not an element.
  await expect(page.locator(".assist-title").nth(2)).toHaveText(canary);
  expect(await page.locator(".sheet img, .sheet script").count()).toBe(0);
  expect(await page.evaluate(() => window.XSS)).toBeUndefined();

  await page.locator('[data-ai="apply"]').click();
  await expect(page.locator("#toast")).toContainText("3 taken over.");

  const nodes = await nodesOf(page);
  const root = nodes.find((n) => n.title === "Get the knee fixed");
  const call = nodes.find((n) => n.title === "Call the practice on Monday");
  const ask = nodes.find((n) => n.title === "Ask for the earliest slot");
  const marked = nodes.find((n) => n.title === canary);
  expect(call.parentId).toBe(root.id);
  expect(ask.parentId).toBe(call.id);
  expect(marked.parentId).toBe(root.id);
  for (const made of [call, ask, marked]) expect(made.origin).toBe("llm");
  expect(await page.evaluate(() => window.XSS)).toBeUndefined();
  expect(await page.locator("#app img, #app script").count()).toBe(0);
});

// What replaced the old "in off mode not one assistance control exists in the
// DOM" test. There is no off mode any more, because there is nothing to switch:
// what that test proved conditionally is now unconditional and permanent, so
// this asserts the ABSENCE of the whole removed apparatus rather than its
// absence in one setting.
test("nothing of the removed relay is left on any screen", async ({ page }) => {
  await goalWithSteps(page);

  // The relay surface marked itself with data-llm - the assist entry on the
  // leaf screen, its sheet, the row-menu entries, the camera in the bar and the
  // proposal rows. Not one of those attributes exists anywhere any more.
  await expect(page.locator("[data-llm]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Assist" })).toHaveCount(0);

  // The bottom bar is back to two controls on a focus screen, and two on the
  // outline: no camera between them.
  await page.locator(".crumb-back").click();
  await expect(page.locator(".bar > *")).toHaveCount(2);
  await expect(page.locator(".bar").getByRole("button", { name: /photo|camera/i })).toHaveCount(0);
  await page.locator(".crumb-pill").first().click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  await expect(page.locator(".bar > *")).toHaveCount(2);

  // The row menu offers the keep-away switch and nothing else about models -
  // and it offers it without anything having been switched on, which is the
  // point: the switch guards the copy loop now.
  await page.locator(".row").first().click();
  await page.locator(".crumb .iconbtn").last().click();
  await expect(page.locator(".sheet").getByText("Keep away from the model")).toHaveCount(1);
  await expect(page.locator(".sheet [data-llm]")).toHaveCount(0);
  await page.locator(".sheet-head").getByRole("button", { name: "Close" }).click();

  // And the settings screen has no assistance group at all: no mode segment,
  // no local model, no provider, no key, no connection test. The group that
  // used to sit between the widget group and the security group is simply not
  // there - the security group follows the widget group now.
  await page.locator(".crumb-pill").first().click();
  await page.locator(".head-actions .iconbtn").last().click();
  await expect(page.locator(".h-title")).toHaveText("Settings");
  const groups = await page.locator(".group-key").allTextContents();
  expect(groups).toContain("Security");
  expect(groups).not.toContain("Assistance");
  for (const gone of ["Assistance", "Local model", "Provider", "API key", "Test connection"]) {
    await expect(page.getByText(gone, { exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Import from a photo" })).toHaveCount(0);
});

test("a step kept away from models has no way into the copy loop", async ({ page }) => {
  await goalWithSteps(page);
  await expect(page.locator('[data-ai="copy"]')).toHaveCount(1);

  // The switch on the goal itself, thrown from its own screen.
  await page.getByRole("button", { name: "Keep away from the model" }).click();
  await expect(page.locator("#toast")).toContainText("Kept away from the model");
  await expect(page.locator('[data-ai="copy"]')).toHaveCount(0);

  // The step underneath inherits it and offers nothing either.
  await page.locator(".crumb-back").click();
  await page.locator(".list.is-kids .row").first().click();
  await expect(page.locator(".leaf-title")).toHaveText("Book the MRI");
  await expect(page.locator(".assist-foot")).toContainText("inherited from Get the knee fixed");
  await expect(page.locator('[data-ai="copy"]')).toHaveCount(0);

  // The builder agrees with the UI - it is the same rule, one layer down.
  const built = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const aihelp = await import("/web/js/aihelp.js");
    const kid = ctx.doc.nodes.find((n) => n.title === "Book the MRI");
    return aihelp.buildPrompt(ctx.doc, kid.id, "en");
  });
  expect(built).toBeNull();
});
