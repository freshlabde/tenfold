// Stage 2, the story layer: the migration nobody is supposed to notice, the
// story on a step, the four questions, the context index and the depth marker.
//
// The UI specs drive the real app against real WebCrypto and IndexedDB, like
// ui.spec.js does; the pure parts (detectNames, entity CRUD, two-device merge)
// run in the fixture page, where no PBKDF2 has to be paid for.
import { test, expect } from "@playwright/test";

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

test.describe.configure({ mode: "parallel", timeout: 90_000 });

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
  await page.waitForSelector(".keygrid", { timeout: 30000 });
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

/** Open a root goal, give it one step and land on that step's detail screen. */
async function openStep(page, goal, step) {
  await addRoots(page, [goal]);
  await page.locator(".row-shell").first().locator(".row").click();
  await page.getByRole("button", { name: /Add the first part/ }).click();
  await page.locator(".composer input").fill(step);
  await page.locator(".composer input").press("Enter");
  await page.locator(".composer input").press("Escape");
  await page.locator(".list.is-kids .row-shell").first().locator(".row").click();
  await expect(page.locator(".leaf-title")).toHaveText(step);
}

// ------------------------------------------------------------------ migration

test("a schema-1 vault upgrades invisibly on unlock", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Run ten kilometres again"]);
  await page.waitForTimeout(1200);

  // Roll the sealed document back to what stage 1 wrote: schema 1, no
  // entities, no story or entityRefs on the node. This is the honest test -
  // the ciphertext on disk really is an old vault afterwards.
  const rolled = await page.evaluate(async () => {
    const store = await import("/web/js/store.js");
    const crypto = await import("/web/js/crypto.js");
    const vault = await store.loadVault();
    const key = await crypto.unlockWithPassphrase(vault, "correct horse battery staple");
    const doc = await crypto.openFromVault(vault, key);
    const legacy = {
      schema: 1,
      settings: doc.settings,
      nodes: doc.nodes.map((n) => {
        const copy = { ...n };
        delete copy.story;
        delete copy.entityRefs;
        return copy;
      }),
    };
    await store.saveVault(await crypto.sealIntoVault(vault, key, legacy));
    return { schema: legacy.schema, hasStory: "story" in legacy.nodes[0] };
  });
  expect(rolled.schema).toBe(1);
  expect(rolled.hasStory).toBe(false);

  await page.reload();
  await page.waitForSelector(".lock-title");
  await page.locator(".lock input").fill(PASS);
  await page.getByRole("button", { name: /Unlock/ }).click();
  // Nothing about the upgrade is visible: the list is simply there.
  await expect(page.locator(".row-title")).toHaveText(["Run ten kilometres again"], { timeout: 30000 });

  const shape = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return {
      schema: ctx.doc.schema,
      entities: ctx.doc.entities,
      story: ctx.doc.nodes[0].story,
      refs: ctx.doc.nodes[0].entityRefs,
    };
  });
  expect(shape.schema).toBe(2);
  expect(shape.entities).toEqual([]);
  expect(shape.story).toBe("");
  expect(shape.refs).toEqual([]);
});

test("a story survives lock and unlock", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await openStep(page, "A back that stops hurting", "Book the physio");

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".sheet .textarea.is-story").fill("It has been three months and sitting is the worst part.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".leaf-story")).toContainText("three months");
  await page.waitForTimeout(1200);

  await page.reload();
  await page.waitForSelector(".lock-title");
  await page.locator(".lock input").fill(PASS);
  await page.getByRole("button", { name: /Unlock/ }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 30000 });
  await page.locator(".row-shell").first().locator(".row").click();
  await page.locator(".list.is-kids .row-shell").first().locator(".row").click();
  await expect(page.locator(".leaf-story")).toContainText("sitting is the worst part");
});

// -------------------------------------------------------------- the four questions

test("the story guide appends labelled answers and fills the definition of done", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await openStep(page, "Spanish up to B2", "Find a tandem partner");

  await page.getByRole("button", { name: "Tell the story" }).click();
  await expect(page.locator(".guide-q")).toContainText("matter now");
  await expect(page.locator(".guide-step")).toContainText("1 of 4");

  await page.locator(".sheet textarea").fill("Because the move is in September.");
  await page.getByRole("button", { name: "Next" }).click();

  // Step two is skipped: skipping must never write anything.
  await expect(page.locator(".guide-step")).toContainText("2 of 4");
  await page.getByRole("button", { name: "Skip" }).click();

  await expect(page.locator(".guide-step")).toContainText("3 of 4");
  await page.locator(".sheet textarea").fill("Evenings disappear.");
  await page.getByRole("button", { name: "Next" }).click();

  await expect(page.locator(".guide-step")).toContainText("4 of 4");
  await page.locator(".sheet textarea").fill("We have met twice.");
  await page.getByRole("button", { name: "Finish", exact: true }).click();

  const story = page.locator(".leaf-story");
  await expect(story).toContainText("Why now: Because the move is in September.");
  await expect(story).toContainText("In the way: Evenings disappear.");
  await expect(story).toContainText("Done when: We have met twice.");
  await expect(story).not.toContainText("Tried already");
  // The closing answer also became the definition of done, which was empty.
  await expect(page.locator(".facts")).toContainText("We have met twice.");
});

test("a guide label answered in one language reads in the current one", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await openStep(page, "Spanish up to B2", "Find a tandem partner");

  // Answer the first question in English - the label is stamped into the
  // story text in the language of that moment.
  await page.getByRole("button", { name: "Tell the story" }).click();
  await page.locator(".sheet textarea").fill("Because the move is in September.");
  await page.getByRole("button", { name: "Next" }).click();
  for (let i = 0; i < 3; i += 1) await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.locator(".leaf-story")).toContainText("Why now: Because the move is in September.");

  // Switch the app to German: the SCREEN re-labels the answer, the sealed
  // document keeps exactly what was written (owner report: "En text in
  // deutsch" - an English "Why now:" inside an otherwise German screen).
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    ctx.setSettings({ lang: "de" });
  });
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.locator(".leaf-story")).toContainText("Warum jetzt: Because the move is in September.");
  await expect(page.locator(".leaf-story")).not.toContainText("Why now:");
  const raw = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return ctx.doc.nodes.map((n) => n.story || "").join("\n");
  });
  expect(raw).toContain("Why now: Because the move is in September.");
  expect(raw).not.toContain("Warum jetzt");
});

test("the review card scrolls a long story instead of cutting it off", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await openStep(page, "Spanish up to B2", "Find a tandem partner");

  // A story far past the old three-line clamp, on the GOAL - the node whose
  // review card the Back below lands on.
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const goal = ctx.childrenOf(null)[0];
    const line = "The classes stalled twice and the podcast alone does not stick. ";
    ctx.updateNode(goal.id, { story: line.repeat(12) });
  });

  // Back on the parent: the review card shows the story in a box that scrolls.
  await page.locator("#app").getByRole("button", { name: "Back" }).click();
  const story = page.locator(".hero-story");
  await expect(story).toBeVisible();
  const box = await story.evaluate((n) => ({
    overflowY: getComputedStyle(n).overflowY,
    scrollable: n.scrollHeight > n.clientHeight + 4,
    capped: n.clientHeight < window.innerHeight * 0.35,
  }));
  expect(box.overflowY).toBe("auto");
  expect(box.scrollable).toBe(true);
  // The cap still holds: a long story may scroll, never take over the screen.
  expect(box.capped).toBe(true);
});

test("the guide leaves an existing definition of done alone", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await openStep(page, "Tidy the workshop", "Clear the bench");

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".sheet .textarea").nth(2).fill("Bench is empty and swept.");
  await page.getByRole("button", { name: "Save" }).click();

  await page.getByRole("button", { name: "Tell the story" }).click();
  for (let i = 0; i < 3; i += 1) await page.getByRole("button", { name: "Skip" }).click();
  await page.locator(".sheet textarea").fill("Something else entirely.");
  await page.getByRole("button", { name: "Finish", exact: true }).click();

  await expect(page.locator(".leaf-story")).toContainText("Done when: Something else entirely.");
  await expect(page.locator(".facts")).toContainText("Bench is empty and swept.");
  await expect(page.locator(".facts")).not.toContainText("Something else entirely.");
});

// ------------------------------------------------------------- the context index

test("a card can be written, linked to a step and found again", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await openStep(page, "Sort things out with Anna", "Call her back");

  await page.getByRole("button", { name: "Link a card" }).click();
  await page.getByRole("button", { name: "New card" }).click();
  await page.locator(".sheet .input").first().fill("Anna");
  await page.locator(".sheet .input").nth(1).fill("my sister, two years older");
  await page.locator(".sheet .textarea").fill("We have not spoken since the funeral.");
  await page.getByRole("button", { name: "Save" }).click();

  // The chip is on the step, and the card carries the link.
  await expect(page.locator(".chip").first()).toHaveText("Anna");

  await page.locator(".crumb-back").click();
  await page.locator(".crumb-pill").first().click();
  await page.getByRole("button", { name: "Open search" }).click();
  await page.locator(".searchbar input").fill("funeral");
  await expect(page.locator(".row-title")).toHaveText(["Anna"]);
  await page.locator(".row").first().click();
  await expect(page.locator(".sheet .input").first()).toHaveValue("Anna");
});

test("the index is reachable from settings and lists what is on file", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: /Context index/ }).click();
  await expect(page.locator(".h-title")).toHaveText("Context");
  await expect(page.locator(".empty-line")).toBeVisible();

  await page.getByRole("button", { name: "New card", exact: true }).click();
  await page.locator(".sheet .input").first().fill("The workshop");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".setrow-label")).toContainText("The workshop");
});

test("a repeated unknown name is offered once and can be dismissed", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await openStep(page, "See Bergmann about the roof", "Ring Bergmann again");

  const hint = page.locator(".hintchip");
  await expect(hint).toHaveText("Who is Bergmann?");

  await page.getByRole("button", { name: "Do not ask again" }).click();
  await expect(page.locator(".hintchip")).toHaveCount(0);

  // The dismissal lives in the document, so it travels with the vault.
  const dismissed = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return ctx.doc.settings.dismissedNames;
  });
  expect(dismissed).toEqual(["bergmann"]);
});

test("the hint opens a prefilled card", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await openStep(page, "See Bergmann about the roof", "Ring Bergmann again");

  await page.locator(".hintchip").click();
  await expect(page.locator(".sheet .input").first()).toHaveValue("Bergmann");
  await page.getByRole("button", { name: "Save" }).click();
  // Saving the suggestion links it to the step and stops the question.
  await expect(page.locator(".chip").first()).toHaveText("Bergmann");
  await expect(page.locator(".hintchip")).toHaveCount(0);
});

// -------------------------------------------------------------- depth marker

test("the depth marker appears with context and disappears with the toggle", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);
  // A bare line carries no context, so the rail stays empty.
  await expect(page.locator(".row-shell .depth")).toHaveCount(0);

  await page.locator(".row-shell").first().locator(".row").click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".sheet .textarea.is-story").fill("This is why it matters.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".hero-head .depth")).toHaveCount(1);
  expect(await page.locator(".hero-head .depth").getAttribute("data-depth")).toBe("0.4");

  await page.locator(".crumb-pill").first().click();
  await expect(page.locator(".row-shell .depth")).toHaveCount(1);

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".row-shell .depth")).toHaveCount(0);

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".row-shell .depth")).toHaveCount(1);
});

// ------------------------------------------------------------- pure functions

test.describe("pure", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/tests/fixture.html");
  });

  test("entity CRUD and linking are pure and tombstone rather than delete", async ({ page }) => {
    const r = await page.evaluate(async () => {
      const e = await import("/web/js/entities.js");
      const m = await import("/web/js/model.js");
      const nodes = [m.createNode({ id: "n1", title: "Call", createdAt: 1, updatedAt: 1 })];

      let cards = e.addEntity([], { name: "Anna", relation: "my sister" }, { now: 100 });
      const id = cards[0].id;
      cards = e.updateEntity(cards, id, { notes: "since the funeral" }, { now: 200 });
      const unchanged = e.updateEntity(cards, id, { notes: "since the funeral" }, { now: 300 });

      let linked = e.linkEntity(nodes, "n1", id, { now: 400 });
      const twice = e.linkEntity(linked, "n1", id, { now: 500 });
      const unlinked = e.unlinkEntity(linked, "n1", id, { now: 600 });

      const gone = e.deleteEntity(cards, id, { now: 700 });

      return {
        name: cards[0].name,
        notes: cards[0].notes,
        bumped: cards[0].updatedAt,
        noBump: unchanged[0].updatedAt,
        pure: nodes[0].entityRefs.length,
        refs: linked[0].entityRefs,
        idempotentLink: twice[0] === linked[0],
        afterUnlink: unlinked[0].entityRefs,
        stillThere: gone.length,
        deletedAt: gone[0].deletedAt,
        living: e.listEntities(gone).length,
        forNode: e.entitiesForNode(cards, linked[0]).map((c) => c.name),
        usedBy: e.nodesForEntity(linked, id).map((n) => n.id),
      };
    });
    expect(r.name).toBe("Anna");
    expect(r.notes).toBe("since the funeral");
    expect(r.bumped).toBe(200);
    expect(r.noBump).toBe(200); // a patch that changes nothing changes nothing
    expect(r.pure).toBe(0); // the input array was never touched
    expect(r.refs).toHaveLength(1);
    expect(r.idempotentLink).toBe(true);
    expect(r.afterUnlink).toEqual([]);
    expect(r.stillThere).toBe(1); // tombstone, not removal
    expect(r.deletedAt).toBe(700);
    expect(r.living).toBe(0);
    expect(r.forNode).toEqual(["Anna"]);
    expect(r.usedBy).toEqual(["n1"]);
  });

  test("detectNames finds repeated unknown names and respects stopwords, cards and dismissals", async ({ page }) => {
    const r = await page.evaluate(async () => {
      const e = await import("/web/js/entities.js");
      const m = await import("/web/js/model.js");
      const mk = (p) => m.createNode({ createdAt: 1, updatedAt: 1, ...p });
      const nodes = [
        mk({ id: "a", title: "Call Bergmann about the roof", story: "Bergmann wanted an answer by Friday." }),
        mk({ id: "b", title: "The roof needs Bergmann", story: "Anna asked about it too." }),
        mk({ id: "c", title: "Anna's birthday", story: "" }),
        mk({ id: "d", title: "Ignore Ghost Ghost", story: "", deletedAt: 5 }),
        mk({ id: "e", title: "Meier once", story: "" }),
      ];
      const cards = [m.createEntity({ id: "x", name: "anna", aliases: ["Annie"], createdAt: 1, updatedAt: 1 })];
      const plain = e.detectNames(nodes, cards, { locale: "en" });
      return {
        plain: plain.map((c) => [c.name, c.count]),
        dismissed: e.detectNames(nodes, cards, { locale: "en", dismissed: ["Bergmann"] }).map((c) => c.name),
        german: e
          .detectNames(
            [
              mk({ id: "g1", title: "Der Termin mit Bergmann", story: "Die Sache mit Bergmann klaeren" }),
            ],
            [],
            { locale: "de" },
          )
          .map((c) => c.name),
        capped: e.rememberDismissal(Array.from({ length: 60 }, (_, i) => `n${i}`), "Anna").length,
        deduped: e.rememberDismissal(["anna", "bo"], "ANNA"),
      };
    });
    // Bergmann appears three times and has no card: the only candidate.
    expect(r.plain).toEqual([["Bergmann", 3]]);
    // "The", "Call", "Friday" are stopwords or single occurrences; "anna" has
    // a card, "Ghost" only lives in a tombstone, "Meier" appears once.
    expect(r.dismissed).toEqual([]);
    expect(r.german).toEqual(["Bergmann"]); // articles are filtered out
    expect(r.capped).toBe(50);
    expect(r.deduped).toEqual(["bo", "anna"]);
  });

  test("two devices merge their cards without losing either side", async ({ page }) => {
    const r = await page.evaluate(async () => {
      const m = await import("/web/js/model.js");
      const e = await import("/web/js/entities.js");
      // The common ancestor: one goal, one card.
      const base = m.upgradeDoc({
        schema: 1,
        nodes: [m.createNode({ id: "n1", title: "Sort things out", createdAt: 100, updatedAt: 100 })],
        settings: {},
      });
      const shared = m.createEntity({ id: "anna", name: "Anna", createdAt: 100, updatedAt: 100 });
      const start = { ...base, entities: [shared] };

      // Phone: writes a note on the shared card and adds one of its own.
      const phone = {
        ...start,
        entities: e.addEntity(
          e.updateEntity(start.entities, "anna", { notes: "phone note" }, { now: 200 }),
          { id: "roof", name: "The roof" },
          { now: 210 },
        ),
        nodes: e.linkEntity(start.nodes, "n1", "anna", { now: 220 }),
      };
      // Laptop: writes a different note on the same card, later.
      const laptop = {
        ...start,
        entities: e.updateEntity(start.entities, "anna", { notes: "laptop note" }, { now: 300 }),
      };

      const merged = m.mergeDocs(phone, laptop);
      const swapped = m.mergeDocs(laptop, phone);
      const anna = merged.entities.find((c) => c.id === "anna");
      return {
        ids: merged.entities.map((c) => c.id),
        notes: anna.notes,
        marker: m.CONFLICT_MARKER,
        refs: merged.nodes[0].entityRefs,
        sameBothWays: JSON.stringify(merged) === JSON.stringify(swapped),
      };
    });
    expect(r.ids).toEqual(["anna", "roof"]); // neither device lost a card
    expect(r.notes).toContain("laptop note"); // the younger edit wins
    expect(r.notes).toContain(r.marker);
    expect(r.notes).toContain("phone note"); // the loser is kept, not dropped
    expect(r.refs).toEqual(["anna"]); // the link only one device made survives
    expect(r.sameBothWays).toBe(true);
  });

  test("search reaches stories and cards and labels what it found", async ({ page }) => {
    const r = await page.evaluate(async () => {
      const s = await import("/web/js/search.js");
      const m = await import("/web/js/model.js");
      const mk = (p) => m.createNode({ createdAt: 1, updatedAt: 1, ...p });
      const nodes = [
        mk({ id: "a", title: "Run again", story: "The knee gave up in Cordoba." }),
        mk({ id: "b", title: "Cordoba trip", story: "" }),
      ];
      const cards = [
        m.createEntity({ id: "x", name: "Doctor Vela", relation: "knee specialist in Cordoba", createdAt: 1, updatedAt: 1 }),
      ];
      const hits = s.search(nodes, "cordoba", { entities: cards });
      return {
        kinds: hits.map((h) => (h.entity ? `card:${h.entity.name}` : `node:${h.node.id}`)),
        fields: hits.map((h) => h.matchField),
        noEntities: s.search(nodes, "cordoba").length,
        storyOnly: s.search(nodes, "knee", { entities: cards }).map((h) => h.matchField),
      };
    });
    // Title hit first, then the card, then the node that only mentions it in
    // its story - and each hit says which field it came from.
    expect(r.kinds).toEqual(["node:b", "card:Doctor Vela", "node:a"]);
    expect(r.fields).toEqual(["title", "entityRelation", "story"]);
    expect(r.noEntities).toBe(2); // without the index, only nodes are searched
    // "knee" starts the relation line but sits mid-sentence in the story, so
    // the word-start bonus puts the card first.
    expect(r.storyOnly).toEqual(["entityRelation", "story"]);
  });
});
