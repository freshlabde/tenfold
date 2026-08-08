// Stage 3 - the model: the relay, the scoped context, and the way a proposal
// becomes a decision.
//
// Nothing here talks to a real provider. A mock OpenAI-compatible server runs
// on a fixed port and is named in TENFOLD_LLM_UPSTREAMS (playwright.config.js)
// exactly the way an operator would name a model server on their own machine -
// that is the mechanism, not a way around the allowlist. Everything else is
// real: the relay, the vault, the document, the sheets.
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

/** Must match playwright.config.js webServer.env TENFOLD_LLM_UPSTREAMS. */
const SINK_PORT = 7799;
const SINK_URL = `http://127.0.0.1:${SINK_PORT}/v1`;

// One sink on one fixed port for the whole file, so the specs run one after
// the other rather than fighting over it.
test.describe.configure({ mode: "serial", timeout: 240_000 });

// ------------------------------------------------------------------ the sink

/** The shape an OpenAI-compatible server answers with. */
function completion(content) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { total_tokens: 42 },
  };
}

async function startSink() {
  const queue = [];
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      received.push({
        url: req.url,
        authorization: req.headers.authorization || "",
        size: raw.length,
        body: (() => {
          try {
            return JSON.parse(raw.toString("utf8"));
          } catch {
            return null;
          }
        })(),
      });
      const next = queue.shift() || { status: 200, body: completion('{"ready": true}') };
      const text = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
      res.writeHead(next.status || 200, { "Content-Type": "application/json" });
      res.end(text);
    });
  });
  await new Promise((done) => server.listen(SINK_PORT, "127.0.0.1", done));
  return {
    received,
    /** Queue one answer. Strings go out as-is, objects are stringified. */
    reply(body, status = 200) {
      queue.push({ body, status });
    },
    /** Queue a model answer - the JSON the operation asked for, as text. */
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

async function closeSettings(page) {
  await page.locator(".head-actions").getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
}

/** Switch assistance to the local mode and point it at the sink. */
async function useLocalModel(page) {
  await openSettings(page);
  await page.getByRole("button", { name: "Local", exact: true }).click();
  await page.getByRole("button", { name: /Local model/ }).click();
  await page.locator(".sheet .input.is-url").fill(SINK_URL);
  await page.locator(".sheet .input").nth(1).fill("test-model");
  await page.locator(".sheet-foot").getByRole("button", { name: "Save" }).click();
  await closeSettings(page);
}

/** Open the assist sheet from the header menu of the goal that is open. */
async function openAssist(page) {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.locator(".sheet").getByRole("button", { name: "Assist", exact: true }).click();
  // The row-menu sheet is still fading out for a moment; the new one is last.
  await expect(page.locator(".sheet-title").last()).toHaveText("Assist");
}

function randomId() {
  const alphabet = "23456789abcdefghjkmnpqrstvwxyz";
  let out = "";
  for (let i = 0; i < 26; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

const relayBody = (extra = {}) => ({
  upstream: SINK_URL,
  model: "test-model",
  messages: [{ role: "user", content: "ping" }],
  ...extra,
});

// -------------------------------------------------------------------- relay

test("an upstream that is not on the allowlist never gets a connection", async ({ request }) => {
  const refused = [
    "https://example.invalid/v1",
    "http://127.0.0.1:9/v1",
    "http://127.0.0.1:7799/v2",
    "http://127.0.0.1:7799/v1?key=x",
    "file:///etc/passwd",
    "http://[::1]:7799/v1",
    "",
  ];
  for (const upstream of refused) {
    const res = await request.post("/api/llm", { data: relayBody({ upstream }) });
    expect(res.status(), upstream).toBe(403);
  }
  // Nothing was even attempted.
  expect(sink.received).toEqual([]);

  const allowed = await request.post("/api/llm", { data: relayBody() });
  expect(allowed.status()).toBe(200);
  expect(sink.received).toHaveLength(1);
  expect(sink.received[0].url).toBe("/v1/chat/completions");
});

test("a caller the server does not know is turned away", async ({ request }) => {
  // A forged cf-connecting-ip is what a request through the tunnel looks
  // like - the loopback exemption does not apply to it.
  const stranger = { "cf-connecting-ip": "203.0.113.51" };
  const noToken = await request.post("/api/llm", { headers: stranger, data: relayBody() });
  expect(noToken.status()).toBe(401);

  const wrongToken = await request.post("/api/llm", {
    // Long enough to be a token, belonging to nothing on this server.
    headers: { ...stranger, "X-Sync-Token": "no-vault-here-ever-used-this-one-42" },
    data: relayBody(),
  });
  expect(wrongToken.status()).toBe(401);
  expect(sink.received).toEqual([]);

  // A vault on this server vouches for its own devices, and for nobody else.
  const id = randomId();
  const token = `relay-spec-token-${randomId()}`;
  const put = await request.put(`/api/vault/${id}`, {
    headers: { "X-Sync-Token": token, "X-If-Version": "0" },
    data: { vault: { magic: "TENFOLD1", marker: "llm-relay-test" } },
  });
  expect(put.status()).toBe(200);

  const good = await request.post("/api/llm", {
    headers: { ...stranger, "X-Sync-Token": token },
    data: relayBody(),
  });
  expect(good.status()).toBe(200);
  expect(sink.received).toHaveLength(1);
});

test("what the model said comes back verbatim, and only four fields go out", async ({ request }) => {
  const answer = {
    id: "chatcmpl-verbatim",
    choices: [{ index: 0, message: { role: "assistant", content: "{\"ready\": true}" } }],
    odd: { nested: [1, 2, 3], unicode: "Ángela" },
  };
  sink.reply(answer);

  const res = await request.post("/api/llm", {
    data: {
      upstream: SINK_URL,
      model: "test-model",
      apiKey: "sk-test-key",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 64,
      temperature: 0.1,
      // Anything beyond the four fields stops at the relay.
      syncId: "should-not-travel",
      user: "should-not-travel",
    },
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual(answer);

  const seen = sink.received[0];
  expect(seen.authorization).toBe("Bearer sk-test-key");
  expect(Object.keys(seen.body).sort()).toEqual(["max_tokens", "messages", "model", "temperature"]);
  expect(seen.body.max_tokens).toBe(64);

  // An error from the provider is also its own answer, passed on unchanged.
  sink.reply({ error: { message: "no credit", type: "billing" } }, 402);
  const failed = await request.post("/api/llm", { data: relayBody() });
  expect(failed.status()).toBe(402);
  expect((await failed.json()).error.type).toBe("billing");
});

test("the caps hold in both directions", async ({ request }) => {
  const filler = (bytes) => "x".repeat(bytes);

  // Text only: one megabyte is the ceiling.
  const tooMuchText = await request.post("/api/llm", {
    data: relayBody({ messages: [{ role: "user", content: filler(1_400_000) }] }),
  });
  expect(tooMuchText.status()).toBe(413);
  expect(sink.received).toEqual([]);

  // The same size with a picture in it is exactly what stage 3b needs.
  const withImage = await request.post("/api/llm", {
    data: relayBody({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is on this list" },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${filler(1_400_000)}` } },
          ],
        },
      ],
    }),
  });
  expect(withImage.status()).toBe(200);
  expect(sink.received).toHaveLength(1);

  // Eight megabytes is the end of it, picture or not.
  const absurd = await request.post("/api/llm", {
    data: relayBody({
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${filler(9_000_000)}` } }],
        },
      ],
    }),
  });
  expect(absurd.status()).toBe(413);
  expect(sink.received).toHaveLength(1);

  // And an upstream that answers with a flood is cut off, not buffered.
  sink.reply(completion(filler(1_500_000)));
  const flood = await request.post("/api/llm", { data: relayBody() });
  expect(flood.status()).toBe(502);
});

// ------------------------------------------------------------- context scope

test("the context is the neighbourhood, never the tree", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const llm = await import("/web/js/llm.js");
    const prompts = await import("/web/js/prompts.js");
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
    const doc = { schema: 2, nodes, entities, settings: {} };
    const render = (opts) => {
      const context = llm.buildContext(doc, "kid", opts);
      return context ? { context, text: prompts.renderContext(context) } : null;
    };
    return {
      local: render({ mode: "local" }),
      cloud: render({ mode: "cloud" }),
      cloudReleased: render({ mode: "cloud", releaseSensitive: true, releaseNotes: true }),
      localReleased: render({ mode: "local", releaseSensitive: true }),
      insideOptout: llm.buildContext(doc, "secret-kid", { mode: "local" }),
      optoutItself: llm.buildContext(doc, "secret", { mode: "local" }),
      gone: llm.buildContext(doc, "nope", { mode: "local" }),
    };
  });

  // An opted-out subtree does not appear, in any field, in any form.
  for (const key of ["local", "cloud", "cloudReleased"]) {
    expect(r[key].text, key).not.toContain("SECRET-BRANCH");
    expect(r[key].text, key).not.toContain("SECRET-CHILD");
  }
  // ... and a node inside one has no context at all, rather than a reduced one.
  expect(r.insideOptout).toBeNull();
  expect(r.optoutItself).toBeNull();
  expect(r.gone).toBeNull();

  // The tree beyond the chain is never sent, whatever the mode.
  expect(r.local.text).not.toContain("FAR-AWAY-GOAL");
  expect(r.local.text).not.toContain("FAR-STORY");
  expect(r.local.text).not.toContain("FAR-CHILD");
  // Target, one ancestor, one sibling, one child - and that is the whole of it.
  expect(r.local.context.nodeCount).toBe(4);
  expect(r.local.text).toContain("Book the MRI");
  expect(r.local.text).toContain("Get the knee fixed");
  expect(r.local.text).toContain("Call the physio");
  expect(r.local.text).toContain("Ask for the earliest slot");

  // A sensitive card stays here until it is released for one call.
  expect(r.local.text).not.toContain("SENSITIVE-CANARY");
  expect(r.local.text).not.toContain("Anna");
  expect(r.local.context.omitted.sensitive).toBe(1);
  expect(r.localReleased.text).toContain("Anna");
  expect(r.localReleased.text).toContain("SENSITIVE-CANARY");

  // In cloud mode the notes on a card stay behind as well; the name and what
  // the person is to you may go, or the card says nothing at all.
  expect(r.cloud.text).toContain("Dr Weber");
  expect(r.cloud.text).toContain("orthopaedist");
  expect(r.cloud.text).not.toContain("NOTE-CANARY-ordinary");
  expect(r.cloud.context.omitted.notes).toBe(true);
  expect(r.local.text).toContain("NOTE-CANARY-ordinary");
  expect(r.cloudReleased.text).toContain("NOTE-CANARY-ordinary");
  expect(r.cloudReleased.text).toContain("SENSITIVE-CANARY");
});

test("a malformed model answer is a calm line, never half an apply", async ({ page }) => {
  await page.goto("/tests/fixture.html");
  const r = await page.evaluate(async () => {
    const { extractJson } = await import("/web/js/llm.js");
    const prompts = await import("/web/js/prompts.js");
    const attempt = (fn) => {
      try {
        return { value: fn() };
      } catch (err) {
        return { code: err && err.code };
      }
    };
    return {
      fenced: attempt(() => extractJson('```json\n{"ready": true}\n```')),
      chatty: attempt(() => extractJson('Sure! Here you go:\n{"steps": [{"title": "A"}]}\nHope that helps.')),
      braceInString: attempt(() => extractJson('{"title": "a } brace \\" inside"}')),
      array: attempt(() => extractJson("[1, 2, 3]")),
      prose: attempt(() => extractJson("I am afraid I cannot do that.")),
      truncated: attempt(() => extractJson('{"steps": [{"title": "A"')),
      broken: attempt(() => extractJson("{not json at all}")),
      emptySteps: attempt(() => prompts.operationById("breakdown").parse({ steps: [] })),
      wrongShape: attempt(() => prompts.operationById("sharpen").parse({ nope: 1 })),
      shortOrder: attempt(() => prompts.operationById("rank").parse({ order: [{ n: 1 }] }, { childCount: 3 })),
      goodOrder: attempt(() =>
        prompts.operationById("rank").parse({ order: [{ n: 2 }, { n: 1 }] }, { childCount: 2 }),
      ),
      notReady: attempt(() => prompts.parseInterview({ ready: false, questions: [] })),
    };
  });

  expect(r.fenced.value).toEqual({ ready: true });
  expect(r.chatty.value).toEqual({ steps: [{ title: "A" }] });
  expect(r.braceInString.value).toEqual({ title: 'a } brace " inside' });
  expect(r.array.value).toEqual([1, 2, 3]);
  for (const key of ["prose", "truncated", "broken", "emptySteps", "wrongShape", "shortOrder", "notReady"]) {
    expect(r[key].code, key).toBe("malformed");
  }
  expect(r.goodOrder.value.order).toHaveLength(2);
});

// ----------------------------------------------------------------- off mode

test("in off mode not one assistance control exists in the DOM", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed"]);

  await expect(page.locator("[data-llm]")).toHaveCount(0);

  // The row menu of a goal: edit, story, done, move, delete - nothing else.
  await page.locator(".row").first().click({ button: "right" });
  await expect(page.locator(".sheet")).toBeVisible();
  await expect(page.locator("[data-llm]")).toHaveCount(0);
  await expect(page.locator(".sheet").getByRole("button", { name: "Assist" })).toHaveCount(0);
  await page.locator(".sheet-head").getByRole("button", { name: "Close" }).click();

  // The step screen: no assist, no opt-out switch.
  await page.locator(".row").first().click();
  await page.getByRole("button", { name: /Add the first part/ }).click();
  await page.locator(".composer input").fill("Book the MRI");
  await page.locator(".composer input").press("Enter");
  await page.locator(".composer input").press("Escape");
  await page.locator(".list.is-kids .row").first().click();
  await expect(page.locator(".leaf-title")).toHaveText("Book the MRI");
  await expect(page.locator("[data-llm]")).toHaveCount(0);

  // The mode switch itself is always there - it IS the switch.
  await page.locator(".crumb-back").click();
  await page.locator(".crumb-pill").first().click();
  await openSettings(page);
  await expect(page.getByRole("button", { name: "Off", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("cloud asks once, and declining changes nothing", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await openSettings(page);

  await page.getByRole("button", { name: "Cloud", exact: true }).click();
  await expect(page.locator(".sheet-title")).toHaveText("Before cloud is switched on");
  await expect(page.locator(".sheet")).toContainText("leave this device");

  await page.getByRole("button", { name: "Keep it off" }).click();
  await expect(page.locator(".sheet")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Off", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    await page.evaluate(async () => {
      const { ctx } = await import("/web/js/app.js");
      return (ctx.doc.settings.llm || {}).mode || "off";
    }),
  ).toBe("off");

  // Accepting is the second press, never the first.
  await page.getByRole("button", { name: "Cloud", exact: true }).click();
  await page.getByRole("button", { name: "Switch cloud on" }).click();
  const stored = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return ctx.doc.settings.llm;
  });
  expect(stored.mode).toBe("cloud");
  expect(stored.cloudConsent).toBe(true);
  expect(stored.baseUrl).toContain("api.openai.com");
  // And it is asked exactly once per vault.
  await page.getByRole("button", { name: "Off", exact: true }).click();
  await page.getByRole("button", { name: "Cloud", exact: true }).click();
  await expect(page.locator(".sheet")).toHaveCount(0);
});

// ------------------------------------------------------ the interview and on

test("the gate asks, the answer lands in the story, then the proposals come", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed"]);
  await useLocalModel(page);

  sink.says({
    ready: false,
    questions: [{ label: "Deadline", question: "By when does the knee have to hold again?" }],
  });
  sink.says({
    steps: [
      { title: "Book the MRI", why: "everything else waits on the picture" },
      { title: "Call the physio", why: "" },
      { title: "Buy proper shoes", why: "" },
    ],
  });

  await page.locator(".row").first().click();
  await expect(page.locator(".hero-title")).toHaveText("Get the knee fixed");
  await openAssist(page);
  await page.getByRole("button", { name: "Break it down" }).click();

  // Step one: the model says it does not know enough yet, and asks.
  await expect(page.locator(".guide-q")).toHaveText("By when does the knee have to hold again?", {
    timeout: 30000,
  });
  await expect(page.locator(".guide-step")).toHaveText("Question 1 of 1");
  await page.locator(".sheet textarea").fill("Before the marathon in October.");
  await page.locator(".sheet-foot").getByRole("button", { name: "Finish" }).click();

  // Step two: the proposals, with the enriched story behind them.
  await expect(page.locator(".assist-item")).toHaveCount(3, { timeout: 30000 });
  await expect(page.locator(".assist-item").first().locator(".assist-title")).toHaveText("Book the MRI");
  await expect(page.locator(".assist-item").first()).toContainText("everything else waits");

  const asked = sink.received.map((r) => r.body.messages[1].content);
  expect(asked).toHaveLength(2);
  expect(asked[0]).not.toContain("Before the marathon");
  // The answer travelled into the document and came back as context.
  expect(asked[1]).toContain("Deadline: Before the marathon in October.");
  expect(sink.received[0].body.messages[0].content).toContain("STRICT JSON");

  // Two of three: the third is unchecked and simply does not happen. The box
  // itself is the visible control - the input behind it is a hit target only.
  await page.locator(".assist-item").nth(2).locator(".check").click();
  await expect(page.locator(".assist-item").nth(2).locator('input[type="checkbox"]')).not.toBeChecked();
  await page.getByRole("button", { name: "Take over 2" }).click();

  await expect(page.locator(".list.is-kids .row-title")).toHaveText(["Book the MRI", "Call the physio"]);
  const made = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const root = ctx.doc.nodes.find((n) => n.title === "Get the knee fixed");
    return {
      children: ctx.doc.nodes.filter((n) => n.parentId === root.id).map((n) => ({ title: n.title, origin: n.origin })),
      story: root.story,
    };
  });
  expect(made.children).toEqual([
    { title: "Book the MRI", origin: "llm" },
    { title: "Call the physio", origin: "llm" },
  ]);
  expect(made.story).toContain("Deadline: Before the marathon in October.");
});

test("rejecting everything writes nothing", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Sort the paperwork"]);
  await useLocalModel(page);

  sink.says({ ready: true });
  sink.says({ steps: [{ title: "Find the folder" }, { title: "Throw half of it away" }] });

  await page.locator(".row").first().click();
  await openAssist(page);
  await page.getByRole("button", { name: "Break it down" }).click();
  await expect(page.locator(".assist-item")).toHaveCount(2, { timeout: 30000 });

  // No interview this time: the model said it had enough.
  expect(sink.received).toHaveLength(2);

  for (let i = 0; i < 2; i += 1) {
    await page.locator(".assist-item").nth(i).locator(".check").click();
  }
  await expect(page.getByRole("button", { name: /Take over 0/ })).toBeDisabled();
  await page.locator(".sheet-head").getByRole("button", { name: "Close" }).click();

  const count = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return ctx.doc.nodes.length;
  });
  expect(count).toBe(1);
});

test("a proposed line can be corrected before it is taken over", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail properly"]);
  await useLocalModel(page);

  sink.says({ ready: true });
  sink.says({ steps: [{ title: "Book a course somewhere" }] });

  await page.locator(".row").first().click();
  await openAssist(page);
  await page.getByRole("button", { name: "Break it down" }).click();
  await expect(page.locator(".assist-item")).toHaveCount(1, { timeout: 30000 });
  await expect(page.locator(".assist-title")).toHaveText("Book a course somewhere");

  await page.locator(".assist-title").click();
  await page.locator(".assist-item .input").fill("Book the course in Palma");
  await page.locator(".assist-item .input").press("Enter");
  await page.getByRole("button", { name: "Take over 1" }).click();

  await expect(page.locator(".list.is-kids .row-title")).toHaveText(["Book the course in Palma"]);
});

test("a garbled answer says so and leaves the document alone", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Run ten kilometres again"]);
  await useLocalModel(page);

  sink.says("I would rather not answer that, sorry.");

  await page.locator(".row").first().click();
  await openAssist(page);
  await page.getByRole("button", { name: "Break it down" }).click();

  await expect(page.locator(".assist-error")).toHaveText(
    "The answer did not come back in the expected form. Nothing was changed.",
    { timeout: 30000 },
  );
  await expect(page.locator(".assist-item")).toHaveCount(0);

  // One button, one attempt - nothing retries on its own.
  expect(sink.received).toHaveLength(1);
  sink.says({ ready: true });
  sink.says({ steps: [{ title: "Start with three kilometres" }] });
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".assist-item")).toHaveCount(1, { timeout: 30000 });

  await page.locator(".sheet-head").getByRole("button", { name: "Close" }).click();
  const count = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return ctx.doc.nodes.length;
  });
  expect(count).toBe(1);
});

test("an unreachable model leaves the app fully usable", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Fix the boiler"]);
  await openSettings(page);
  await page.getByRole("button", { name: "Local", exact: true }).click();
  await page.getByRole("button", { name: /Local model/ }).click();
  // A perfectly ordinary address that this server does not allow.
  await page.locator(".sheet .input.is-url").fill("http://127.0.0.1:7798/v1");
  await page.locator(".sheet .input").nth(1).fill("test-model");
  await page.locator(".sheet-foot").getByRole("button", { name: "Save" }).click();

  await page.getByRole("button", { name: /Test connection/ }).click();
  await expect(page.locator("#toast")).toContainText("not an allowed model server", { timeout: 30000 });

  await closeSettings(page);
  await addRoots(page, ["And another one"]);
  await expect(page.locator(".row-title")).toHaveText(["Fix the boiler", "And another one"]);
});

test("a step kept away from the model has no assist entry", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Sort things out with Anna"]);
  await useLocalModel(page);

  await page.locator(".row").first().click();
  await page.getByRole("button", { name: /Add the first part/ }).click();
  await page.locator(".composer input").fill("Write the letter");
  await page.locator(".composer input").press("Enter");
  await page.locator(".composer input").press("Escape");

  // The switch on the goal, thrown from its own screen.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.locator(".sheet").getByRole("button", { name: "Keep away from the model" }).click();
  await expect(page.locator("#toast")).toContainText("Kept away from the model");

  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.locator(".sheet").getByRole("button", { name: "Assist" })).toHaveCount(0);
  await page.locator(".sheet-head").getByRole("button", { name: "Close" }).click();

  // The step underneath inherits it, says where from, and offers no switch.
  await page.locator(".list.is-kids .row").first().click();
  await expect(page.locator(".leaf-title")).toHaveText("Write the letter");
  await expect(page.locator(".assist-foot")).toContainText("inherited from Sort things out with Anna");
  await expect(page.locator(".assist-foot").getByRole("button", { name: "Assist" })).toHaveCount(0);
  await expect(
    page.locator(".assist-foot").getByRole("button", { name: "Keep away from the model" }),
  ).toHaveCount(0);

  // The context builder agrees with the UI - it is the same rule.
  const context = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const llm = await import("/web/js/llm.js");
    const kid = ctx.doc.nodes.find((n) => n.title === "Write the letter");
    return llm.buildContext(ctx.doc, kid.id, { mode: "local" });
  });
  expect(context).toBeNull();
});

test("sharpen shows before and after, and the order operation reorders", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Do something about the garden"]);
  await useLocalModel(page);

  await page.locator(".row").first().click();
  await page.getByRole("button", { name: /Add the first part/ }).click();
  for (const part of ["Buy the plants", "Clear the beds"]) {
    await page.locator(".composer input").fill(part);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");

  sink.says({ title: "Replant the front bed before the end of April" });
  await openAssist(page);
  await page.getByRole("button", { name: "Sharpen the wording" }).click();
  await expect(page.locator(".assist-after")).toHaveText(
    "Replant the front bed before the end of April",
    { timeout: 30000 },
  );
  await expect(page.locator(".assist-before")).toHaveText("Do something about the garden");
  await page.getByRole("button", { name: "Take it over", exact: true }).click();
  await expect(page.locator(".hero-title")).toHaveText("Replant the front bed before the end of April");

  // Ranking: the parts come back in the other order, with a reason each.
  sink.says({
    order: [
      { n: 2, reason: "nothing goes in until the bed is empty" },
      { n: 1, reason: "buy once the space is known" },
    ],
  });
  await openAssist(page);
  await page.getByRole("button", { name: "Order the parts" }).click();
  await expect(page.locator(".assist-item")).toHaveCount(2, { timeout: 30000 });
  await expect(page.locator(".assist-item").first()).toContainText("Clear the beds");
  await expect(page.locator(".assist-item").first()).toContainText("until the bed is empty");
  await page.getByRole("button", { name: "Take this order" }).click();
  await expect(page.locator(".list.is-kids .row-title")).toHaveText(["Clear the beds", "Buy the plants"]);
});
