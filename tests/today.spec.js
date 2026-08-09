// Today, the daily question, and the push API (stage 2).
//
// Three things are checked here. First the screen: it is reachable from the
// outline, it shows what model.todayList picked, a row can still be swiped
// done, and an empty list says so calmly. Second the question: it is chosen by
// the date and the thinnest story with no randomness anywhere, the answer ends
// up in that node's story, and "Not today" puts it away until tomorrow. Third
// the server: subscribing needs the write token, a subscription is stored
// without a single readable word, five is the ceiling, unsubscribing removes
// it, and the VAPID key is a real P-256 point whose signature verifies.
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { createVerify, createPublicKey } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Must match playwright.config.js webServer.env.
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

/** Add children under the root that is currently open in the focus screen. */
async function addChildren(page, titles) {
  await page.getByRole("button", { name: /Add the first part|Sub-goal/ }).click();
  for (const title of titles) {
    await page.locator(".composer input").fill(title);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
}

/**
 * Wait until an element is really hit-testable. A screen change runs through
 * View Transitions, and while one is playing the live DOM is hidden behind the
 * snapshot overlay - a pointer event sent in that window reaches nothing.
 */
async function hitTestable(page, selector) {
  await page.waitForFunction((sel) => {
    const node = document.querySelector(sel);
    if (!node) return false;
    const box = node.getBoundingClientRect();
    const at = document.elementFromPoint(box.x + 30, box.y + box.height / 2);
    return !!at && node.contains(at);
  }, selector);
}

function randomId() {
  const alphabet = "23456789abcdefghjkmnpqrstvwxyz";
  let out = "";
  for (let i = 0; i < 26; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/** Registers a vault so a push subscription has a token hash to check against. */
async function registerVault(request, id, token) {
  const res = await request.put(`/api/vault/${id}`, {
    headers: { "X-Sync-Token": token, "X-If-Version": "0" },
    data: { vault: { magic: "TENFOLD1", marker: "push-test" } },
  });
  expect(res.status()).toBe(200);
}

/** A stand-in push service: records what arrives, answers with a chosen status. */
async function pushSink(status = 201) {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization || "",
        ttl: req.headers.ttl || "",
        bodyLength: Buffer.concat(chunks).length,
      });
      res.writeHead(status).end();
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  return {
    received,
    url: (path = "/sink") => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

// ------------------------------------------------------------- today screen

test("the outline leads to Today and Today shows the short list", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Get the knee fixed"]);
  await page.locator(".row").first().click();
  await expect(page.locator(".hero-title")).toHaveText("Get the knee fixed");
  await addChildren(page, ["Call the physio", "Book the MRI"]);

  await page.locator(".crumb-back").click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.locator(".h-title")).toHaveText("Today");

  // Only the leaves, and each one carries the goal it belongs to.
  await expect(page.locator(".row-title")).toHaveText(["Call the physio", "Book the MRI"]);
  await expect(page.locator(".row-sub").first()).toHaveText("Get the knee fixed");

  // Tapping a row opens that step.
  await page.locator(".row").first().click();
  await expect(page.locator(".leaf-title")).toHaveText("Call the physio");
});

test("a row can be swiped done on the Today screen", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Ship the thing"]);
  await page.locator(".row").first().click();
  await addChildren(page, ["Write the release note", "Tag the build"]);
  await page.locator(".crumb-back").click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.locator(".row-title")).toHaveText(["Write the release note", "Tag the build"]);

  await hitTestable(page, ".list .row-shell .row");
  const row = page.locator(".list .row-shell").first().locator(".row");
  const box = await row.boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + box.height / 2, { steps: 6 });
  await page.mouse.move(box.x + 170, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();

  await expect(page.locator("#toast")).toContainText("Marked as done");
  // The finished step leaves the list; the other one stays.
  await expect(page.locator(".row-title")).toHaveText(["Tag the build"], { timeout: 15000 });
});

test("an empty Today says so in one calm line", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Only a goal"]);
  await page.locator(".row").first().click();
  await expect(page.locator(".hero-title")).toHaveText("Only a goal");
  await addChildren(page, ["The one step"]);

  // The goal is no longer a leaf, and its only step is finished - so the rule
  // in model.js has nothing left to offer.
  await page.locator(".list .row").first().click({ button: "right" });
  await page.getByRole("button", { name: "Mark as done" }).click();
  await page.locator(".crumb-back").click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.locator(".empty-line")).toHaveText("Nothing calls for today.");
  await expect(page.locator(".row")).toHaveCount(0);
});

test("the notification link lands on Today and leaves no parameter behind", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Something to do"]);

  // What the service worker opens on a notification click.
  await page.goto("/web/index.html?view=today");
  await page.waitForSelector(".lock-title");
  await page.locator(".lock input").fill(PASS);
  await page.getByRole("button", { name: /Unlock/ }).click();

  await expect(page.locator(".h-title")).toHaveText("Today", { timeout: 60000 });
  expect(await page.evaluate(() => location.search)).toBe("");

  // Closing goes back to the list, not into a dead end.
  await page.locator(".head-actions").getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
});

test("the locale for the notification text is parked where the worker looks", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Deutsch" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");

  const parked = await page.evaluate(async () => {
    const cache = await caches.open("tenfold-locale");
    const hit = await cache.match(`${location.origin}/tenfold-locale`);
    return hit ? (await hit.text()).trim() : null;
  });
  expect(parked).toBe("de");
});

// ---------------------------------------------------------- daily question

test("the daily question is deterministic and never random", async ({ page }) => {
  await freshApp(page);
  const picks = await page.evaluate(async () => {
    const q = await import("/web/js/questions.js");
    const model = await import("/web/js/model.js");
    const t0 = Date.UTC(2026, 0, 2, 12, 0, 0);
    const nodes = [
      model.createNode({ id: "a", title: "A", rank: 0, createdAt: t0, story: "long story" }),
      model.createNode({ id: "b", title: "B", rank: 1, createdAt: t0 }),
      model.createNode({ id: "c", title: "C", rank: 2, createdAt: t0, note: "a note" }),
    ];
    const day = new Date(2026, 3, 7, 9, 0, 0).getTime();
    const runs = [];
    for (let i = 0; i < 5; i += 1) runs.push(q.dailyQuestion(nodes, { now: day }));
    const other = q.dailyQuestion(nodes, { now: new Date(2026, 3, 8, 9, 0, 0).getTime() });
    // Same day, reversed input order: the pick must not depend on array order.
    const reversed = q.dailyQuestion([...nodes].reverse(), { now: day });
    return {
      keys: runs.map((r) => r.key),
      nodes: runs.map((r) => r.node.id),
      day: runs[0].day,
      reversedNode: reversed.node.id,
      reversedKey: reversed.key,
      otherDay: other.day,
      catalogue: q.QUESTIONS.length,
      // Over a year every question in the catalogue should come up at least
      // once, or the hash is not spreading.
      spread: new Set(
        Array.from({ length: 365 }, (_, i) =>
          q.dailyQuestion(nodes, { now: day + i * 86400000 }).key,
        ),
      ).size,
    };
  });

  expect(new Set(picks.keys).size).toBe(1);
  expect(new Set(picks.nodes).size).toBe(1);
  // Thinnest story wins: B has nothing at all, A has a story, C has a note.
  expect(picks.nodes[0]).toBe("b");
  expect(picks.reversedNode).toBe("b");
  expect(picks.reversedKey).toBe(picks.keys[0]);
  expect(picks.day).toBe("20260407");
  expect(picks.otherDay).toBe("20260408");
  expect(picks.catalogue).toBe(16);
  expect(picks.spread).toBe(16);
});

test("the question card writes the answer into that node's story", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Learn to sail properly"]);
  await page.getByRole("button", { name: "Today", exact: true }).click();

  await expect(page.locator(".qcard")).toBeVisible();
  await expect(page.locator(".qcard-node")).toHaveText("Learn to sail properly");
  const question = await page.locator(".qcard-q").textContent();
  expect(question.length).toBeGreaterThan(10);

  await page.locator(".qcard textarea").fill("Because the boat is already paid for.");
  await page.locator(".qcard").getByRole("button", { name: "Save" }).click();

  // Gone for the day, and the answer sits in the story as a labelled line.
  await expect(page.locator(".qcard")).toHaveCount(0);
  await page.locator(".row").first().click();
  await expect(page.locator(".hero-story")).toContainText("Because the boat is already paid for.");
  await expect(page.locator(".hero-story")).toContainText(":");
});

test("Not today puts the question away until tomorrow", async ({ page }) => {
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Sort the paperwork"]);
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.locator(".qcard")).toBeVisible();

  await page.getByRole("button", { name: "Not today" }).click();
  await expect(page.locator(".qcard")).toHaveCount(0);

  // The decision is a date in the document, so it survives leaving the screen.
  const dismissed = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return ctx.doc.settings.dailyDismissed;
  });
  expect(dismissed).toMatch(/^\d{8}$/);

  await page.locator(".head-actions").getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.locator(".qcard")).toHaveCount(0);
  await expect(page.locator(".h-title")).toHaveText("Today");
});

// -------------------------------------------------------------- push API

test("the vapid endpoint hands out a real P-256 public key", async ({ request }) => {
  const res = await request.get("/api/push/vapid");
  expect(res.status()).toBe(200);
  const { publicKey } = await res.json();
  expect(typeof publicKey).toBe("string");
  const raw = Buffer.from(publicKey, "base64url");
  // Uncompressed point: 0x04 plus two 32-byte coordinates.
  expect(raw.length).toBe(65);
  expect(raw[0]).toBe(0x04);

  // Stable across calls - the pair is generated once and then read from disk.
  const again = await request.get("/api/push/vapid");
  expect((await again.json()).publicKey).toBe(publicKey);
});

test("subscribing needs the write token of that vault", async ({ request }) => {
  const id = randomId();
  const token = "a-token-that-is-long-enough-1234";
  await registerVault(request, id, token);
  const sub = { endpoint: `https://push.example.invalid/${id}` };

  const noToken = await request.post("/api/push/subscribe", {
    data: { syncId: id, sub, hourUtc: 7 },
  });
  expect(noToken.status()).toBe(401);

  const wrongToken = await request.post("/api/push/subscribe", {
    headers: { "X-Sync-Token": "a-completely-different-token-99" },
    data: { syncId: id, sub, hourUtc: 7 },
  });
  expect(wrongToken.status()).toBe(401);

  // An id that has no vault behind it cannot be verified, so it is refused.
  const unknown = await request.post("/api/push/subscribe", {
    headers: { "X-Sync-Token": token },
    data: { syncId: randomId(), sub, hourUtc: 7 },
  });
  expect(unknown.status()).toBe(401);

  const good = await request.post("/api/push/subscribe", {
    headers: { "X-Sync-Token": token },
    data: { syncId: id, sub, hourUtc: 7 },
  });
  expect(good.status()).toBe(204);
});

test("a stored subscription holds an endpoint and an hour, nothing else", async ({ request }) => {
  const id = randomId();
  const token = "a-token-that-is-long-enough-1234";
  await registerVault(request, id, token);

  const canary = "CANARY-PUSH-31337-do-not-store-me";
  const res = await request.post("/api/push/subscribe", {
    headers: { "X-Sync-Token": token },
    data: {
      syncId: id,
      // A client that sends more than the endpoint must not get more stored.
      sub: {
        endpoint: `https://push.example.invalid/${id}`,
        keys: { p256dh: canary, auth: canary },
        title: canary,
      },
      hourUtc: 6,
      note: canary,
    },
  });
  expect(res.status()).toBe(204);

  const raw = await readFile(join(VAULT_DIR, id, "push.json"), "utf8");
  expect(raw).not.toContain(canary);
  expect(raw).not.toContain(token);
  const stored = JSON.parse(raw);
  expect(stored.subs).toHaveLength(1);
  expect(Object.keys(stored.subs[0]).sort()).toEqual([
    "createdAt",
    "endpoint",
    "hourUtc",
    "lastSentDay",
  ]);
  expect(stored.subs[0].hourUtc).toBe(6);

  // The vault record itself is untouched by any of this.
  const record = JSON.parse(await readFile(join(VAULT_DIR, id, "current.json"), "utf8"));
  expect(record.version).toBe(1);
});

test("five subscriptions per vault is the ceiling, and re-subscribing updates", async ({ request }) => {
  const id = randomId();
  const token = "a-token-that-is-long-enough-1234";
  await registerVault(request, id, token);
  const headers = { "X-Sync-Token": token };

  for (let i = 0; i < 5; i += 1) {
    const res = await request.post("/api/push/subscribe", {
      headers,
      data: { syncId: id, sub: { endpoint: `https://push.example.invalid/${id}/${i}` }, hourUtc: 5 },
    });
    expect(res.status()).toBe(204);
  }
  const sixth = await request.post("/api/push/subscribe", {
    headers,
    data: { syncId: id, sub: { endpoint: `https://push.example.invalid/${id}/5` }, hourUtc: 5 },
  });
  expect(sixth.status()).toBe(429);

  // A device that is already there may still move its hour.
  const again = await request.post("/api/push/subscribe", {
    headers,
    data: { syncId: id, sub: { endpoint: `https://push.example.invalid/${id}/0` }, hourUtc: 21 },
  });
  expect(again.status()).toBe(204);

  const stored = JSON.parse(await readFile(join(VAULT_DIR, id, "push.json"), "utf8"));
  expect(stored.subs).toHaveLength(5);
  expect(stored.subs.find((s) => s.endpoint.endsWith("/0")).hourUtc).toBe(21);
});

test("unsubscribing removes exactly that endpoint", async ({ request }) => {
  const id = randomId();
  const token = "a-token-that-is-long-enough-1234";
  await registerVault(request, id, token);
  const headers = { "X-Sync-Token": token };
  const one = `https://push.example.invalid/${id}/one`;
  const two = `https://push.example.invalid/${id}/two`;

  for (const endpoint of [one, two]) {
    const res = await request.post("/api/push/subscribe", {
      headers,
      data: { syncId: id, sub: { endpoint }, hourUtc: 4 },
    });
    expect(res.status()).toBe(204);
  }

  const forged = await request.post("/api/push/unsubscribe", {
    headers: { "X-Sync-Token": "a-completely-different-token-99" },
    data: { syncId: id, endpoint: one },
  });
  expect(forged.status()).toBe(401);

  const gone = await request.post("/api/push/unsubscribe", { headers, data: { syncId: id, endpoint: one } });
  expect(gone.status()).toBe(204);

  const stored = JSON.parse(await readFile(join(VAULT_DIR, id, "push.json"), "utf8"));
  expect(stored.subs.map((s) => s.endpoint)).toEqual([two]);
});

test("a bad syncId or hour never reaches the file system", async ({ request }) => {
  const token = "a-token-that-is-long-enough-1234";
  const bad = [
    { syncId: "../../etc", sub: { endpoint: "https://push.example.invalid/x" }, hourUtc: 3 },
    { syncId: randomId(), sub: { endpoint: "ftp://push.example.invalid/x" }, hourUtc: 3 },
    { syncId: randomId(), sub: { endpoint: "https://push.example.invalid/x" }, hourUtc: 24 },
    { syncId: randomId(), sub: {}, hourUtc: 3 },
  ];
  for (const data of bad) {
    const res = await request.post("/api/push/subscribe", { headers: { "X-Sync-Token": token }, data });
    expect([400, 401], JSON.stringify(data)).toContain(res.status());
  }
  const dirs = await readdir(VAULT_DIR).catch(() => []);
  expect(dirs.filter((name) => !/^[a-z0-9]{26}$/.test(name))).toEqual([]);
});

test("the daily dispatch sends an empty, VAPID-signed push exactly once a day", async ({ request }) => {
  const sink = await pushSink(201);
  try {
    const id = randomId();
    const token = "a-token-that-is-long-enough-1234";
    await registerVault(request, id, token);
    const hourUtc = 11;
    const subscribed = await request.post("/api/push/subscribe", {
      headers: { "X-Sync-Token": token },
      data: { syncId: id, sub: { endpoint: sink.url(`/sink/${id}`) }, hourUtc },
    });
    expect(subscribed.status()).toBe(204);

    const first = await request.post("/api/push/dispatch", { data: { hourUtc } });
    expect(first.status()).toBe(200);
    expect((await first.json()).attempted).toBeGreaterThan(0);

    const hit = sink.received.find((r) => r.url.includes(id));
    expect(hit, "the sink was poked").toBeTruthy();
    // The whole point: nothing travels with it.
    expect(hit.bodyLength).toBe(0);
    expect(hit.method).toBe("POST");
    expect(hit.ttl).toBe("86400");

    // The Authorization header is a VAPID token: a real ES256 JWT over the
    // claims, signed by the key the vapid endpoint hands out.
    const m = /^vapid t=([^,]+),\s*k=(.+)$/.exec(hit.authorization);
    expect(m, hit.authorization).toBeTruthy();
    const [, jwt, keyB64] = m;
    const { publicKey } = await (await request.get("/api/push/vapid")).json();
    expect(keyB64).toBe(publicKey);

    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    const body = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
    expect(body.aud).toBe(new URL(sink.url()).origin);
    expect(body.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(typeof body.sub).toBe("string");
    // No user data in the claims - three fields and nothing else.
    expect(Object.keys(body).sort()).toEqual(["aud", "exp", "sub"]);

    const raw = Buffer.from(publicKey, "base64url");
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: raw.subarray(1, 33).toString("base64url"),
        y: raw.subarray(33, 65).toString("base64url"),
      },
      format: "jwk",
    });
    const verifier = createVerify("SHA256");
    verifier.update(`${header}.${claims}`);
    expect(
      verifier.verify(
        { key, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
      "the VAPID signature verifies against the published key",
    ).toBe(true);

    // Once a day and no more: the send is marked and the second round is quiet.
    const marked = JSON.parse(await readFile(join(VAULT_DIR, id, "push.json"), "utf8"));
    expect(marked.subs[0].lastSentDay).toMatch(/^\d{8}$/);
    const before = sink.received.length;
    const second = await request.post("/api/push/dispatch", { data: { hourUtc } });
    expect(second.status()).toBe(200);
    expect(sink.received.length).toBe(before);
  } finally {
    await sink.close();
  }
});

test("a push service that answers 410 drops the subscription", async ({ request }) => {
  const sink = await pushSink(410);
  try {
    const id = randomId();
    const token = "a-token-that-is-long-enough-1234";
    await registerVault(request, id, token);
    const hourUtc = 12;
    await request.post("/api/push/subscribe", {
      headers: { "X-Sync-Token": token },
      data: { syncId: id, sub: { endpoint: sink.url(`/gone/${id}`) }, hourUtc },
    });

    const res = await request.post("/api/push/dispatch", { data: { hourUtc } });
    expect(res.status()).toBe(200);

    const stored = JSON.parse(await readFile(join(VAULT_DIR, id, "push.json"), "utf8"));
    expect(stored.subs).toEqual([]);
  } finally {
    await sink.close();
  }
});

// ----------------------------------------------------------- source rules

/** Strip comments so prose about a rule cannot trip the rule. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("the push channel can never carry content", async () => {
  const sw = stripComments(await readFile(new URL("../web/sw.js", import.meta.url), "utf8"));
  // The service worker writes its own sentence and never reads what arrived.
  expect(sw).toMatch(/showNotification/);
  expect(sw).not.toMatch(/event\.data/);
  expect(sw).toMatch(/tenfold-v18/);

  const serve = await readFile(new URL("../tools/serve.js", import.meta.url), "utf8");
  const stripped = stripComments(serve);
  // Still exactly one outbound fetch in the whole server, and it carries no
  // body. The model relay added in stage 3 is deliberately NOT a second one:
  // it uses node's http/https request directly, because it has to cap and
  // destroy the response stream, and that keeps this count meaningful.
  const calls = [...stripped.matchAll(/fetch\(/g)];
  expect(calls).toHaveLength(1);
  expect(stripped).not.toMatch(/fetch\([\s\S]{0,400}body:/);
});
