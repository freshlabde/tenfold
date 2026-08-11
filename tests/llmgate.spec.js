// The caller gate of the model relay (tools/llm_gate.js + tools/serve.js).
//
// The upstream allowlist says WHERE a request may go; this says WHO may send it
// to the operator's own machine. Two halves are checked here:
//
//   1. The decision itself, imported straight out of tools/llm_gate.js. It is
//      pure, so the CLOUD case - which no test can drive through a live server,
//      because the cloud allowlist is five https-only provider hosts - is
//      checked here rather than pretended at.
//   2. The whole path through a real server: a vault that is not allowed is
//      refused with a machine-readable code and lands in a pending list, the
//      operator's hook is poked once and not once per request, and the four
//      operator actions (allow by POST, allow by link, deny, revoke) do what
//      their names say.
//
// This file runs its own serve.js child, like tests/stats.spec.js, because the
// suite's shared server deliberately has no stats key and an allowlist seeded
// once at startup. Nothing here uses a bypass env var; there is none.
import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gateDecision, notePending } from "../tools/llm_gate.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Ports of this file alone: the gated server, its model, its operator hook. */
const PORT = 7790;
const SINK_PORT = 7791;
const HOOK_PORT = 7792;
const BASE = `http://127.0.0.1:${PORT}`;
const SINK_URL = `http://127.0.0.1:${SINK_PORT}/v1`;
const KEY = "test-gate-key-4b81c2";
const PUBLIC_URL = "https://tenfold.example.org";

const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

/** A request through the tunnel always carries this; loopback never does. */
const STRANGER = { "cf-connecting-ip": "203.0.113.44" };

const VAULT_ID = "gatespecvaultaaaaaaaaaaaaa";
const VAULT_TOKEN = "gate-spec-token-0123456789abcdef";

test.describe.configure({ mode: "serial", timeout: 240_000 });

// -------------------------------------------------------------- the decision

test("the decision: cloud is never gated, a local model always is", () => {
  const allowed = ["aaaaaaaaaaaaaaaaaaaaaaaaaa"];

  // A cloud target is the caller's own key and the caller's own bill. Not one
  // of the four inputs below changes the answer.
  for (const localRequest of [true, false]) {
    for (const syncId of ["", "bbbbbbbbbbbbbbbbbbbbbbbbbb", allowed[0]]) {
      const cloud = gateDecision({ targetLocal: false, localRequest, syncId, allowed });
      expect(cloud.pass, `${localRequest}/${syncId}`).toBe(true);
      expect(cloud.reason).toBe("cloud");
      // Nothing to record: a cloud request never gets a name attached to it.
      expect(cloud.syncId).toBe("");
    }
  }

  // A local model: the id decides, wherever the request came from.
  expect(gateDecision({ targetLocal: true, localRequest: false, syncId: allowed[0], allowed }).pass).toBe(true);
  expect(gateDecision({ targetLocal: true, localRequest: true, syncId: allowed[0], allowed }).pass).toBe(true);

  const strangerVault = gateDecision({
    targetLocal: true,
    localRequest: false,
    syncId: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
    allowed,
  });
  expect(strangerVault.pass).toBe(false);
  expect(strangerVault.reason).toBe("approval");
  expect(strangerVault.syncId).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbb");

  // A vault holder is judged by their id even on this machine.
  expect(
    gateDecision({ targetLocal: true, localRequest: true, syncId: "bbbbbbbbbbbbbbbbbbbbbbbbbb", allowed }).pass,
  ).toBe(false);

  // Nobody in particular, but really this machine: the older allowance.
  expect(gateDecision({ targetLocal: true, localRequest: true, syncId: "", allowed }).reason).toBe("local");
  // And the same caller from outside is refused with nothing to record.
  const nameless = gateDecision({ targetLocal: true, localRequest: false, syncId: "", allowed });
  expect(nameless.pass).toBe(false);
  expect(nameless.syncId).toBe("");

  // An empty allowlist is an empty allowlist. There is no grandfathering.
  expect(gateDecision({ targetLocal: true, localRequest: false, syncId: allowed[0], allowed: [] }).pass).toBe(false);
  // Missing fields default to the closed side of every question: no target
  // named is the ungated cloud case (nothing of the operator's is at stake),
  // and a local target with nothing else known is refused.
  expect(gateDecision({}).reason).toBe("cloud");
  expect(gateDecision({ targetLocal: true }).pass).toBe(false);
  expect(gateDecision({ targetLocal: true, syncId: "cccccccccccccccccccccccccc" }).pass).toBe(false);
});

test("the pending map counts, and drops the oldest when it is full", () => {
  const pending = {};
  expect(notePending(pending, "one", 1000, 3).isNew).toBe(true);
  expect(notePending(pending, "one", 2000, 3).isNew).toBe(false);
  expect(pending.one).toEqual({ first: 1000, last: 2000, count: 2 });

  notePending(pending, "two", 1500, 3);
  notePending(pending, "three", 1600, 3);
  expect(Object.keys(pending).sort()).toEqual(["one", "three", "two"]);

  // Full: the oldest first-seen goes, so a flood cannot grow the file for ever.
  notePending(pending, "four", 1700, 3);
  expect(Object.keys(pending).sort()).toEqual(["four", "three", "two"]);
  expect(pending.four).toEqual({ first: 1700, last: 1700, count: 1 });
});

// ------------------------------------------------------------- the live gate

let child;
let dataDir;
let sink;
let hook;
let hookHits;

function startSink() {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-gate",
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
      }),
    );
  });
  return new Promise((done) => server.listen(SINK_PORT, "127.0.0.1", () => done(server)));
}

/** The operator's own hook: whatever it is in real life, here it is a list. */
function startHook(hits) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = null;
      }
      hits.push({ method: req.method, type: req.headers["content-type"] || "", body });
      res.writeHead(204).end();
    });
  });
  return new Promise((done) => server.listen(HOOK_PORT, "127.0.0.1", () => done(server)));
}

async function accessFile() {
  return readFile(join(dataDir, "llm_access.json"), "utf8");
}

async function accessState() {
  return JSON.parse(await accessFile());
}

function relay(headers = {}, upstream = SINK_URL) {
  return fetch(`${BASE}/api/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      upstream,
      model: "test-model",
      messages: [{ role: "user", content: "ping" }],
    }),
  });
}

const asVault = { ...STRANGER, "X-Sync-Token": VAULT_TOKEN };

function statsPost(form, key = KEY) {
  return fetch(`${BASE}/stats?k=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "manual",
  });
}

test.beforeAll(async () => {
  hookHits = [];
  sink = await startSink();
  hook = await startHook(hookHits);
  dataDir = await mkdtemp(join(tmpdir(), "tenfold-gate-"));
  child = spawn(process.execPath, [join(ROOT, "tools", "serve.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      TENFOLD_DATA: dataDir,
      TENFOLD_STATS_KEY: KEY,
      TENFOLD_LLM_UPSTREAMS: SINK_URL,
      TENFOLD_NOTIFY_URL: `http://127.0.0.1:${HOOK_PORT}/hook`,
      TENFOLD_PUBLIC_URL: PUBLIC_URL,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fetch(`${BASE}/api/probe`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("the gated server did not come up");
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  // The vault this file speaks for. It exists on the server (so the relay
  // recognises the token) and is on nobody's allowlist (so the gate refuses).
  const put = await fetch(`${BASE}/api/vault/${VAULT_ID}`, {
    method: "PUT",
    headers: { "X-Sync-Token": VAULT_TOKEN, "X-If-Version": "0", "Content-Type": "application/json" },
    body: JSON.stringify({ vault: { magic: "TENFOLD1", marker: "gate-spec" } }),
  });
  expect(put.status).toBe(200);
});

test.afterAll(async () => {
  if (child) child.kill();
  if (sink) await new Promise((done) => sink.close(done));
  if (hook) await new Promise((done) => hook.close(done));
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test("a vault the operator has not allowed is refused, and only its id is written", async () => {
  const first = await relay(asVault);
  expect(first.status).toBe(403);
  expect(await first.json()).toEqual({ error: "llm-approval" });

  const second = await relay(asVault);
  expect(second.status).toBe(403);

  await expect
    .poll(async () => (await accessState()).pending[VAULT_ID]?.count, { timeout: 10_000 })
    .toBe(2);

  const state = await accessState();
  expect(state.allowed).toEqual([]);
  expect(Object.keys(state.pending)).toEqual([VAULT_ID]);
  const entry = state.pending[VAULT_ID];
  // The id, when it first asked, when it last asked, how often. Nothing else.
  expect(Object.keys(entry).sort()).toEqual(["count", "first", "last"]);
  expect(entry.first).toBeLessThanOrEqual(entry.last);
  expect(entry.first).toBeGreaterThan(1_700_000_000_000);

  const raw = await accessFile();
  // Not the message, not the model, not the upstream, not the address it came
  // from, not the token that proved the vault.
  expect(raw).not.toContain("ping");
  expect(raw).not.toContain("test-model");
  expect(raw).not.toContain("127.0.0.1");
  expect(raw).not.toContain("203.0.113");
  expect(raw).not.toContain(VAULT_TOKEN);
  // And the refusal told the caller nothing beyond the word.
  expect(await (await relay(asVault)).text()).toBe('{"error":"llm-approval"}');
});

test("the operator is poked once, with links that work, and never again", async () => {
  // The first refusal above is the one that rings the bell.
  await expect.poll(() => hookHits.length, { timeout: 10_000 }).toBe(1);
  const hit = hookHits[0];
  expect(hit.method).toBe("POST");
  expect(hit.type).toContain("application/json");
  expect(hit.body).toEqual({
    event: "llm-approval-request",
    syncId: VAULT_ID,
    allowUrl: `${PUBLIC_URL}/stats?k=${encodeURIComponent(KEY)}&allow=${VAULT_ID}`,
    denyUrl: `${PUBLIC_URL}/stats?k=${encodeURIComponent(KEY)}&deny=${VAULT_ID}`,
    statsUrl: `${PUBLIC_URL}/stats?k=${encodeURIComponent(KEY)}#llm`,
  });

  // Two more refusals in the meantime, and still one poke: the notification is
  // per NEW id, not per request. A client that retries is not a mail loop.
  await relay(asVault);
  await new Promise((done) => setTimeout(done, 500));
  expect(hookHits).toHaveLength(1);
});

test("allowing lets the same caller through, revoking closes it again", async () => {
  const allowed = await statsPost(`action=llm-allow&id=${VAULT_ID}`);
  expect(allowed.status).toBe(303);
  expect(allowed.headers.get("location")).toBe(`/stats?k=${encodeURIComponent(KEY)}#llm`);

  const state = await accessState();
  expect(state.allowed).toEqual([VAULT_ID]);
  // Allowing takes the id out of the queue - it is decided, not waiting.
  expect(state.pending).toEqual({});

  const through = await relay(asVault);
  expect(through.status).toBe(200);
  expect((await through.json()).choices[0].message.content).toBe("pong");

  // Idempotent: the same decision twice is the same state.
  await statsPost(`action=llm-allow&id=${VAULT_ID}`);
  expect((await accessState()).allowed).toEqual([VAULT_ID]);

  const revoked = await statsPost(`action=llm-revoke&id=${VAULT_ID}`);
  expect(revoked.status).toBe(303);
  expect((await accessState()).allowed).toEqual([]);
  expect((await relay(asVault)).status).toBe(403);
});

test("the allow link is a GET, is idempotent, and the deny link clears the queue", async () => {
  // The id is waiting again after the revoked call above.
  await expect.poll(async () => Object.keys((await accessState()).pending), { timeout: 10_000 }).toEqual([
    VAULT_ID,
  ]);

  const link = `${BASE}/stats?k=${encodeURIComponent(KEY)}&allow=${VAULT_ID}`;
  const clicked = await fetch(link, { redirect: "manual" });
  expect(clicked.status).toBe(303);
  expect(clicked.headers.get("location")).toBe(`/stats?k=${encodeURIComponent(KEY)}#llm`);
  expect((await accessState()).allowed).toEqual([VAULT_ID]);
  expect((await relay(asVault)).status).toBe(200);

  // Clicked again - by a mail client prefetching it, by the operator wondering
  // whether it worked - and the state is the same.
  expect((await fetch(link, { redirect: "manual" })).status).toBe(303);
  expect((await accessState()).allowed).toEqual([VAULT_ID]);

  // Without the key the link is the same plain 404 every unknown path gets.
  const noKey = await fetch(`${BASE}/stats?allow=${VAULT_ID}`, { redirect: "manual" });
  expect(noKey.status).toBe(404);
  const wrongKey = await fetch(`${BASE}/stats?k=nope&revoke=${VAULT_ID}`, { redirect: "manual" });
  expect(wrongKey.status).toBe(404);
  expect((await accessState()).allowed).toEqual([VAULT_ID]);

  // Back to waiting, then denied: the queue is empty and the caller stays out.
  await statsPost(`action=llm-revoke&id=${VAULT_ID}`);
  expect((await relay(asVault)).status).toBe(403);
  await expect.poll(async () => Object.keys((await accessState()).pending), { timeout: 10_000 }).toEqual([
    VAULT_ID,
  ]);

  const denied = await fetch(`${BASE}/stats?k=${encodeURIComponent(KEY)}&deny=${VAULT_ID}`, {
    redirect: "manual",
  });
  expect(denied.status).toBe(303);
  const after = await accessState();
  expect(after.pending).toEqual({});
  expect(after.allowed).toEqual([]);
  // Denying is not a blocklist: an id that asks again is waiting again.
  expect((await relay(asVault)).status).toBe(403);
  await expect.poll(async () => Object.keys((await accessState()).pending), { timeout: 10_000 }).toEqual([
    VAULT_ID,
  ]);
});

test("the operator's page shows the queue, and a stranger's id is never echoed back", async () => {
  const page = await fetch(`${BASE}/stats?k=${encodeURIComponent(KEY)}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('id="llm"');
  expect(html).toContain("Local model access");
  expect(html).toContain(VAULT_ID);
  expect(html).toContain("Allow");
  expect(html).toContain("Deny");
  // Still one page with no script and nothing to load from anywhere.
  expect(html).not.toMatch(/<script/);
  expect(html).not.toMatch(/https?:\/\//);

  // The requester's answer carries the word and nothing else - no id, no list,
  // no count, nothing about who else may use this server.
  const refusal = await relay(asVault);
  expect(await refusal.text()).toBe('{"error":"llm-approval"}');
  expect([...refusal.headers.keys()].join(" ")).not.toContain("sync");
});

test("the gate has no opinion about the mailbox, only about the models", async () => {
  // The same id, not allowed for models, still syncs: the gate is in front of
  // the relay and nowhere else.
  const get = await fetch(`${BASE}/api/vault/${VAULT_ID}`, { headers: STRANGER });
  expect(get.status).toBe(200);
  const put = await fetch(`${BASE}/api/vault/${VAULT_ID}`, {
    method: "PUT",
    headers: {
      ...STRANGER,
      "X-Sync-Token": VAULT_TOKEN,
      "X-If-Version": String((await get.json()).version),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ vault: { magic: "TENFOLD1", marker: "still-syncing" } }),
  });
  expect(put.status).toBe(200);

  // An upstream that is not on the allowlist is refused BEFORE the gate, with
  // the older code - the two walls stay distinguishable.
  const refused = await relay(asVault, "http://127.0.0.1:7788/v1");
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: "upstream not allowed" });
});

// --------------------------------------------------------------- the client

/**
 * The app itself, against the gated server. Both come from the same origin
 * here, exactly as in a deployment: this child serves the static files as well.
 */
test("the app says what is missing instead of a generic failure", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto(`${BASE}/web/index.html`);
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

  await page.getByRole("button", { name: "Set up the vault" }).click();
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.getByRole("button", { name: /Create the vault/ }).click();
  await page.waitForSelector(".keygrid", { timeout: 60000 });
  await page.locator(".check").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start empty/ }).click();
  // The copy on the server is what gives this device a sync id at all - and the
  // sync id is what the gate judges. Declining it would make the browser a
  // nameless local caller, which is a different case entirely.
  await page.getByRole("button", { name: "Keep an encrypted copy on the server" }).click();
  const notNow = page.getByRole("button", { name: "Not now" });
  const begin = page.getByRole("button", { name: "Begin" });
  await expect(notNow.or(begin).first()).toBeVisible({ timeout: 60000 });
  if (await notNow.isVisible()) await notNow.click();
  await begin.click();
  await expect(page.locator(".h-title")).toHaveText("The Ten", { timeout: 60000 });

  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.locator(".h-title")).toHaveText("Settings");
  await page.getByRole("button", { name: "Local", exact: true }).click();
  await page.getByRole("button", { name: /Local model/ }).click();
  await page.locator(".sheet .input.is-url").fill(SINK_URL);
  await page.locator(".sheet .input").nth(1).fill("test-model");
  await page.locator(".sheet-foot").getByRole("button", { name: "Save" }).click();

  await page.getByRole("button", { name: /Test connection/ }).click();
  await expect(page.locator("#toast")).toContainText("needs the operator's approval", { timeout: 30000 });
  await expect(page.locator("#toast")).toContainText("try again once it is granted");

  // ... and the request really did land in the operator's queue.
  const id = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return ctx.vault.sync.id;
  });
  await expect.poll(async () => Object.keys((await accessState()).pending).includes(id), {
    timeout: 15_000,
  }).toBe(true);
});

test("a note gives an allowed id a face, stays operator-only, and clears when emptied", async () => {
  await statsPost(`action=llm-allow&id=${VAULT_ID}`);

  // Set a label - with characters that would break out of the HTML if the
  // renderer forgot to escape them.
  const label = "Michael's iPhone <b>&test</b>";
  const noted = await statsPost(`action=llm-note&id=${VAULT_ID}&note=${encodeURIComponent(label)}`);
  expect(noted.status).toBe(303);

  const state = await accessState();
  expect(state.notes).toEqual({ [VAULT_ID]: label });

  // The page shows it escaped, next to the allowed id.
  const html = await (await fetch(`${BASE}/stats?k=${encodeURIComponent(KEY)}`)).text();
  // esc() encodes &, <, > and double quotes - enough for text nodes and the
  // double-quoted attribute the input value sits in; the apostrophe may stay.
  expect(html).toContain("Michael's iPhone &lt;b&gt;&amp;test&lt;/b&gt;");
  expect(html).not.toContain("<b>&test</b>");

  // The note never travels to a caller: the refusal body of a stranger and a
  // successful relay body both stay free of it.
  const through = await relay(asVault);
  expect(await through.text()).not.toContain("Michael");

  // A long note is capped, an empty one removes the label.
  await statsPost(`action=llm-note&id=${VAULT_ID}&note=${encodeURIComponent("x".repeat(500))}`);
  expect((await accessState()).notes[VAULT_ID].length).toBe(120);
  await statsPost(`action=llm-note&id=${VAULT_ID}&note=`);
  expect((await accessState()).notes).toEqual({});

  // Housekeeping for the specs above: leave the gate the way this file's
  // earlier tests expect between runs.
  await statsPost(`action=llm-revoke&id=${VAULT_ID}`);
});
