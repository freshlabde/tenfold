// Where the app is, told to a native tab bar.
//
// The iOS shell wants a `UITabBar` under the web view. A tab bar has to know
// two things it cannot work out for itself - which tab is current, and what the
// four of them are called - and both answers live here: the routing is in
// app.js and the only catalogue of text this product has is in locales/.
// `web/js/nav.js` is the web half of the answer.
//
// THREE OF THE FOUR MESSAGES, plus the header fork. The upward pair goes out,
// the tab tap comes back down, and the screens leave out what the bar
// duplicates. `nav.back` and the edge gesture are still a later stage, and no
// shell advertises `nav` yet. So the tests below fall into three kinds, and the
// third is still the most important one today:
//
//   - with a shell that advertises `nav`: which message goes out, carrying
//     which fields, at which moment; what a tab tap does to the stack, the
//     sheet and the screen; and which header controls are gone.
//   - with today's shell, and with no shell at all: that NOTHING goes out and
//     NOTHING is hidden, over a whole session rather than at module level. A
//     stage whose whole promise is "provably inert" has to be tested for
//     inertness by walking the app.
//   - the fork asserted from both sides in one file, because the property to
//     defend is that the browser path is the `else` branch and unchanged.
//
// The wire shapes are written down once, in docs/CONTRACTS.md and in
// tenfold-ios/docs/BRIDGE.md, and both suites assert against them literally
// rather than deriving them: two repositories on two release cycles cannot
// import from each other, so a rename has to fail loudly here instead of
// quietly agreeing with itself over there.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PASS = "correct horse battery staple";
const PHONE = { width: 390, height: 844 };

// Real WebCrypto: 600000 PBKDF2 rounds per unlock.
test.describe.configure({ mode: "parallel", timeout: 240_000 });

// ------------------------------------------------------------------- the stub

/**
 * A shell that records what it is posted and nothing more.
 *
 * The capability list is left to the caller, so "advertises nav", "today's
 * shell" and "a shell too old for any of this" all walk the same code. The
 * default is the one that matters for the positive tests; the negative tests
 * pass the list that is actually shipping.
 */
async function stubShell(page, capabilities = ["nav"]) {
  await page.addInitScript((caps) => {
    const messages = [];
    window.__shellMessages = messages;
    // The same messages again, split by the door they went through. Everything
    // in the navigation contract is fire-and-forget, and "there is no reply to
    // a nav.go" is only assertable if a test can tell a `post` from a `send`.
    window.__shellPosted = [];
    window.__shellSent = [];
    window.__tenfoldShell = {
      platform: "ios",
      version: "0.5.0 (5)",
      loader: "scheme://app",
      origin: String(location.origin),
      capabilities: caps,
      post(message) {
        messages.push(message);
        window.__shellPosted.push(message);
        return true;
      },
      send(message) {
        messages.push(message);
        window.__shellSent.push(message);
        return Promise.resolve({ type: message.type, ok: true });
      },
      request(type, payload) {
        messages.push({ type, payload: payload || null });
        return Promise.resolve({ type: "pong" });
      },
      _receive(message) {
        if (!message || typeof message !== "object") return;
        window.dispatchEvent(new CustomEvent("tenfoldshell", { detail: message }));
      },
    };
  }, capabilities);
}

/** Everything the app posted whose type is in the navigation contract. */
const navMessages = (page) =>
  page.evaluate(() =>
    (window.__shellMessages || []).filter((m) => m && String(m.type).indexOf("nav.") === 0),
  );

const states = (page) =>
  page.evaluate(() =>
    (window.__shellMessages || []).filter((m) => m && m.type === "nav.state"),
  );

const tabsMessages = (page) =>
  page.evaluate(() => (window.__shellMessages || []).filter((m) => m && m.type === "nav.tabs"));

/** The last thing the app said about where it is. */
const lastState = async (page) => {
  const all = await states(page);
  return all[all.length - 1] || null;
};

/** How many messages in the contract have crossed so far. */
const navCount = async (page) => (await navMessages(page)).length;

/**
 * A tab tap, delivered exactly the way the shell delivers one.
 *
 * Through `_receive` -> the `tenfoldshell` CustomEvent, which is the same route
 * `share.incoming` and `vault.lock` already take: there is no second transport
 * for this direction and there must not be one. The return value is handed back
 * so a test can assert what it is - nothing.
 */
const tap = (page, tab, reason = "tab") =>
  page.evaluate((message) => window.__tenfoldShell._receive(message), {
    type: "nav.go",
    tab,
    reason,
  });

/** A malformed tap, verbatim - the shape is the test. */
const tapRaw = (page, message) =>
  page.evaluate((m) => window.__tenfoldShell._receive(m), message);

/** Where the app actually is, read from the app rather than from the wire. */
const where = (page) =>
  page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    return { view: ctx.view.name, shellNav: ctx.shellNav };
  });

// ------------------------------------------------------------------- the walk

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

async function addParts(page, titles) {
  await page.getByRole("button", { name: /Add the first part|New part|New entry/ }).click();
  for (const title of titles) {
    await page.locator(".composer input").fill(title);
    await page.locator(".composer input").press("Enter");
  }
  await page.locator(".composer input").press("Escape");
}

// ------------------------------------------------------------------ literals

test("the two names, the capability and the four keys are the bridge's own literals", async ({
  page,
}) => {
  // The literal, as bio.spec.js and haptics.spec.js pin theirs: the other half
  // of this assertion is in tenfold-ios, and a rename on either side has to
  // fail rather than agree quietly with itself.
  expect(readFileSync(join(ROOT, "web/js/shell.js"), "utf8")).toContain(
    'export const CAP_NAV = "nav";',
  );

  await page.goto("/web/index.html");
  const pinned = await page.evaluate(async () => {
    const nav = await import("/web/js/nav.js");
    const shell = await import("/web/js/shell.js");
    return {
      state: nav.MSG_STATE,
      tabs: nav.MSG_TABS,
      keys: nav.TABS.slice(),
      capability: shell.CAP_NAV,
    };
  });
  expect(pinned.state).toBe("nav.state");
  expect(pinned.tabs).toBe("nav.tabs");
  // Exactly four, in this order. The shell refuses any other set outright -
  // half a tab bar is worse than none - so a fifth key or a swapped pair here
  // would be a bar that never appears.
  expect(pinned.keys).toEqual(["today", "outline", "map", "more"]);
  expect(pinned.capability).toBe("nav");
});

// ------------------------------------------------------------ the tab model

test("the twelve screens, against tabFor", async ({ page }) => {
  await page.goto("/web/index.html");
  const answers = await page.evaluate(async () => {
    const { tabFor } = await import("/web/js/nav.js");
    const SCREENS = [
      "setup",
      "lock",
      "outline",
      "today",
      "map",
      "focus",
      "leaf",
      "duel",
      "search",
      "settings",
      "about",
      "entities",
    ];
    return {
      alone: SCREENS.map((s) => [s, tabFor(s, null)]),
      underOutline: SCREENS.map((s) => [s, tabFor(s, "outline")]),
      underSettings: SCREENS.map((s) => [s, tabFor(s, "settings")]),
    };
  });

  // On its own: the four roots answer for themselves, and the eight screens
  // that are not a root have no tab of their own at all.
  expect(answers.alone).toEqual([
    ["setup", null],
    ["lock", null],
    ["outline", "outline"],
    ["today", "today"],
    ["map", "map"],
    ["focus", null],
    ["leaf", null],
    ["duel", null],
    ["search", null],
    ["settings", "more"],
    ["about", null],
    ["entities", null],
  ]);

  // With the outline underneath, the eight borrow it - which is the whole
  // reason the function takes a pair. The four roots do NOT: a root answers for
  // itself whatever is beneath it.
  expect(answers.underOutline).toEqual([
    ["setup", "outline"],
    ["lock", "outline"],
    ["outline", "outline"],
    ["today", "today"],
    ["map", "map"],
    ["focus", "outline"],
    ["leaf", "outline"],
    ["duel", "outline"],
    ["search", "outline"],
    ["settings", "more"],
    ["about", "outline"],
    ["entities", "outline"],
  ]);

  // The same eight, under settings, land on More. `entities` is the screen this
  // matters for: it is reached from settings AND from a leaf, and asking only
  // "which screen" would light the wrong tab for one of the two.
  expect(answers.underSettings).toEqual([
    ["setup", "more"],
    ["lock", "more"],
    ["outline", "outline"],
    ["today", "today"],
    ["map", "map"],
    ["focus", "more"],
    ["leaf", "more"],
    ["duel", "more"],
    ["search", "more"],
    ["settings", "more"],
    ["about", "more"],
    ["entities", "more"],
  ]);
});

test("every worked example from the design", async ({ page }) => {
  await page.goto("/web/index.html");
  const worked = await page.evaluate(async () => {
    const { tabFor } = await import("/web/js/nav.js");
    return {
      outlineFocusEntities: tabFor("entities", "outline"),
      settingsEntities: tabFor("entities", "settings"),
      todayLeaf: tabFor("leaf", "today"),
      finishIntro: tabFor("today", "outline"),
      shortcutToMap: tabFor("map", "outline"),
      lock: tabFor("lock", null),
      setup: tabFor("setup", null),
    };
  });

  // outline -> focus -> entities: entities is no root, stack[0] is outline.
  expect(worked.outlineFocusEntities).toBe("outline");
  // settings -> entities: the same screen, the other tab.
  expect(worked.settingsEntities).toBe("more");
  // today -> leaf.
  expect(worked.todayLeaf).toBe("today");
  // `finishIntro` with a pending Today: stack [outline], view today. This is
  // the case the root test exists for - read root-first it would light The Ten
  // while Today is on the screen.
  expect(worked.finishIntro).toBe("today");
  // outline -> the keyboard shortcut straight to the map.
  expect(worked.shortcutToMap).toBe("map");
  // No tab at all: the bar is hidden, not blank.
  expect(worked.lock).toBeNull();
  expect(worked.setup).toBeNull();
});

// ------------------------------------------------------------------ nav.state

test("nav.state follows the app through a real walk, and its depth is the real stack", async ({
  page,
}) => {
  await stubShell(page);
  await freshApp(page);

  // Before a vault exists: setup, no tab, nothing on the stack.
  expect(await lastState(page)).toEqual({
    type: "nav.state",
    screen: "setup",
    depth: 0,
    sheet: false,
  });

  await setupVault(page);
  expect(await lastState(page)).toEqual({
    type: "nav.state",
    screen: "outline",
    tab: "outline",
    depth: 0,
    sheet: false,
  });

  await addRoots(page, ["Alpha", "Beta"]);
  // The composer is the typing path, and `mutate()` deliberately does not go
  // through syncHistory(). Two goals, four keystroke bursts, and the app has
  // not said anything new about where it is.
  expect(await lastState(page)).toEqual({
    type: "nav.state",
    screen: "outline",
    tab: "outline",
    depth: 0,
    sheet: false,
  });

  // Into a goal: depth 1, and the tab is borrowed from the outline beneath.
  await page.locator(".row-shell").first().locator(".row").click();
  await expect(page.locator(".hero-title")).toHaveText("Alpha");
  expect(await lastState(page)).toEqual({
    type: "nav.state",
    screen: "focus",
    tab: "outline",
    depth: 1,
    sheet: false,
  });

  // And into a part of it: depth 2.
  await addParts(page, ["Call the practice"]);
  await page.locator(".list.is-kids .row-shell").first().locator(".row").click();
  expect(await lastState(page)).toEqual({
    type: "nav.state",
    screen: "leaf",
    tab: "outline",
    depth: 2,
    sheet: false,
  });

  // Settings is a root of its own, reached from the outline header.
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    ctx.go("outline", null, { replace: true });
    ctx.go("settings");
  });
  expect(await lastState(page)).toEqual({
    type: "nav.state",
    screen: "settings",
    tab: "more",
    depth: 1,
    sheet: false,
  });

  // The lock hides the bar: no tab, and the stack is gone with the document.
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    await ctx.lock();
  });
  await page.waitForSelector(".lock-title");
  expect(await lastState(page)).toEqual({
    type: "nav.state",
    screen: "lock",
    depth: 0,
    sheet: false,
  });
});

test("an open sheet raises sheet: true without changing the screen", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);
  await page.locator(".row-shell").first().locator(".row").click();
  await expect(page.locator(".hero-title")).toHaveText("Alpha");

  const before = await lastState(page);
  expect(before).toEqual({
    type: "nav.state",
    screen: "focus",
    tab: "outline",
    depth: 1,
    sheet: false,
  });

  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.locator(".sheet")).toBeVisible();

  // A sheet is not a screen: same screen, same tab, same depth. The one thing
  // that moved is the flag - and `depth` deliberately does NOT include the
  // sheet's own history guard, because the native back gesture arms on screens.
  expect(await lastState(page)).toEqual({
    type: "nav.state",
    screen: "focus",
    tab: "outline",
    depth: 1,
    sheet: true,
  });

  await page.locator(".sheet .iconbtn").first().click();
  await expect(page.locator(".sheet")).toHaveCount(0);
  expect(await lastState(page)).toEqual(before);
});

test("edgeBack is false on the duel and the map, and absent everywhere else", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma"]);

  // The map: touch-action none and a panned camera own the left edge. Reached
  // through the bar rather than through the outline's map button, which this
  // shell does not draw - it advertises `nav`, and that button is one of the
  // three the tabs duplicate.
  await tap(page, "map");
  await expect(page.locator(".map-canvas")).toBeVisible();
  expect(await lastState(page)).toEqual({
    type: "nav.state",
    screen: "map",
    tab: "map",
    depth: 1,
    sheet: false,
    edgeBack: false,
  });

  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    ctx.go("outline", null, { replace: true });
  });
  await expect(page.locator(".h-title")).toHaveText("The Ten");

  // The duel: the beam spans the screen, and this screen already has a control
  // called *back* that means something else entirely.
  await page.getByRole("button", { name: "Put in order" }).click();
  await expect(page.locator(".duel-card")).toHaveCount(2);
  expect(await lastState(page)).toEqual({
    type: "nav.state",
    screen: "duel",
    tab: "outline",
    depth: 1,
    sheet: false,
    edgeBack: false,
  });

  // Everywhere else the field is OMITTED, not sent as true: absent means true
  // on the other side, and this message rides the render path.
  const carriers = await page.evaluate(() =>
    (window.__shellMessages || [])
      .filter((m) => m && m.type === "nav.state")
      .map((m) => [m.screen, Object.prototype.hasOwnProperty.call(m, "edgeBack")]),
  );
  for (const [screen, carries] of carriers) {
    expect(carries, `${screen} carries edgeBack`).toBe(screen === "map" || screen === "duel");
  }
});

// ------------------------------------------- the rule that must be asserted

test("no nav message ever carries a node id or a title", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);

  // Titles nothing else in this app would produce, so a match cannot be a
  // coincidence with a label, a locale string or a class name.
  const TITLES = [
    "Zanzibar ledger reconciliation",
    "Quokka photography permit",
    "Marzipan pipeline rewrite",
  ];
  const PART = "Telephone the harbourmaster";

  await addRoots(page, TITLES);
  await page.locator(".row-shell").first().locator(".row").click();
  await addParts(page, [PART]);
  await page.locator(".list.is-kids .row-shell").first().locator(".row").click();

  // Every screen that can hold a node, plus a sheet over one, plus the two
  // rooted elsewhere - the widest walk this contract has to survive.
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.locator(".sheet")).toBeVisible();
  await page.locator(".sheet .iconbtn").first().click();
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    ctx.go("outline", null, { replace: true });
    ctx.go("search");
    ctx.back();
    ctx.go("map");
    ctx.back();
    ctx.go("settings");
    ctx.go("entities");
    ctx.back();
    ctx.back();
  });
  await page.getByRole("button", { name: "Put in order" }).click();
  await expect(page.locator(".duel-card")).toHaveCount(2);

  const { sent, ids } = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const nodes = ctx.doc ? Object.values(ctx.doc.nodes || {}) : [];
    return {
      sent: (window.__shellMessages || []).filter(
        (m) => m && String(m.type).indexOf("nav.") === 0,
      ),
      ids: nodes.map((n) => n.id),
    };
  });

  // A walk this long has to have produced something, or the assertion below is
  // vacuous.
  expect(sent.length).toBeGreaterThan(10);
  expect(ids.length).toBe(TITLES.length + 1);

  const wire = JSON.stringify(sent);
  for (const title of TITLES.concat([PART])) {
    expect(wire, `a title crossed the bridge: ${title}`).not.toContain(title);
  }
  for (const id of ids) {
    expect(wire, `a node id crossed the bridge: ${id}`).not.toContain(id);
  }
  // Not a single word of any title, either - a truncated one is still a leak.
  for (const word of ["Zanzibar", "Quokka", "Marzipan", "harbourmaster"]) {
    expect(wire).not.toContain(word);
  }
  // And the fields themselves are the closed set. `app.js` refuses to put an id
  // into `history.state` for exactly this reason, and this message inherits it:
  // there is no field here an id could ever be smuggled through.
  const ALLOWED = ["type", "screen", "tab", "depth", "sheet", "edgeBack", "tabs"];
  for (const message of sent) {
    for (const key of Object.keys(message)) {
      expect(ALLOWED, `unexpected field on the wire: ${key}`).toContain(key);
    }
    if (message.type !== "nav.state") continue;
    expect(typeof message.screen).toBe("string");
    expect(typeof message.depth).toBe("number");
    expect(typeof message.sheet).toBe("boolean");
    if ("tab" in message) expect(["today", "outline", "map", "more"]).toContain(message.tab);
  }
});

// ------------------------------------------------------------------- nav.tabs

test("the four labels go over at boot, in the bar's own order", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);

  const tabs = await tabsMessages(page);
  // Once, at boot - before the vault is even open, because the bar is drawn
  // around the lock screen too.
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toEqual({
    type: "nav.tabs",
    tabs: [
      { key: "today", label: "Today" },
      { key: "outline", label: "The Ten" },
      { key: "map", label: "Map" },
      { key: "more", label: "More" },
    ],
  });

  // Three of the four are the titles those screens wear in their own headers,
  // which is what makes it impossible for the bar and the heading to disagree.
  await setupVault(page);
  await expect(page.locator(".h-title")).toHaveText("The Ten");
});

test("a language change re-titles the bar, and nothing else does", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);

  // A whole session's worth of routing and settings writes: still one.
  expect(await tabsMessages(page)).toHaveLength(1);

  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    ctx.setLanguage("de");
  });
  await expect(page.locator(".h-title")).toHaveText("Die Zehn");

  let tabs = await tabsMessages(page);
  expect(tabs).toHaveLength(2);
  expect(tabs[1]).toEqual({
    type: "nav.tabs",
    tabs: [
      { key: "today", label: "Heute" },
      { key: "outline", label: "Die Zehn" },
      { key: "map", label: "Karte" },
      { key: "more", label: "Mehr" },
    ],
  });

  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    ctx.setLanguage("es");
  });
  await expect(page.locator(".h-title")).toHaveText("Las Diez");
  tabs = await tabsMessages(page);
  expect(tabs).toHaveLength(3);
  expect(tabs[2].tabs).toEqual([
    { key: "today", label: "Hoy" },
    { key: "outline", label: "Las Diez" },
    { key: "map", label: "Mapa" },
    { key: "more", label: "Más" },
  ]);

  // Asking for the language that is already on does not re-post: `setLocale`
  // ignores a no-op, and the labels are not a per-settings-write message.
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    ctx.setLanguage("es");
    ctx.setSettings({ theme: "light" });
  });
  expect(await tabsMessages(page)).toHaveLength(3);
});

test("every label fits the cap the shell draws in", async ({ page }) => {
  await page.goto("/web/index.html");
  const lengths = await page.evaluate(async () => {
    const { setLocale, t, LOCALES } = await import("/web/js/i18n.js");
    const out = [];
    for (const locale of LOCALES) {
      setLocale(locale);
      for (const key of ["today.title", "outline.title", "map.title", "nav.more"]) {
        out.push([locale, key, t(key)]);
      }
    }
    return out;
  });
  for (const [locale, key, label] of lengths) {
    expect(label, `${locale}/${key} is missing`).not.toBe(key);
    expect(label.length, `${locale}/${key} is too long: ${label}`).toBeLessThanOrEqual(24);
  }
});

// --------------------------------------------------------------- inertness

test("today's shell is sent nothing at all, over a whole session", async ({ page }) => {
  // The list the shell is actually advertising right now. `nav` is not in it
  // and will not be until the native half exists, so this stage has to be
  // invisible to the build that is shipping.
  await stubShell(page, ["reminder", "badge", "widget", "vaultmirror", "haptic"]);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);

  await page.locator(".row-shell").first().locator(".row").click();
  await expect(page.locator(".hero-title")).toHaveText("Alpha");
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.locator(".sheet")).toBeVisible();
  await page.locator(".sheet .iconbtn").first().click();
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    ctx.go("outline", null, { replace: true });
    ctx.go("map");
    ctx.back();
    ctx.go("settings");
    ctx.setLanguage("de");
    ctx.setLanguage("en");
    ctx.back();
    await ctx.lock();
  });
  await page.waitForSelector(".lock-title");

  // A whole session - setup, unlock, six screens, a sheet, two language changes
  // and a lock - and not one message in the navigation contract. Asserted here
  // rather than at module level because the call sites are what would leak.
  expect(await navMessages(page)).toEqual([]);
  // Something else did cross, or the recorder is not wired and the line above
  // proves nothing.
  const total = await page.evaluate(() => (window.__shellMessages || []).length);
  expect(total).toBeGreaterThan(0);
});

test("in a browser it is exactly nothing, and never an error", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);

  await page.locator(".row-shell").first().locator(".row").click();
  await expect(page.locator(".hero-title")).toHaveText("Alpha");
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.locator(".sheet")).toBeVisible();
  await page.locator(".sheet .iconbtn").first().click();

  // Routing and a language change, one settled screen at a time: a View
  // Transition that is interrupted by the next one rejects, and that noise
  // would drown the thing this test is actually watching for.
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    ctx.back();
  });
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  await page.getByRole("button", { name: "Open the map" }).click();
  await expect(page.locator(".map-canvas")).toBeVisible();
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    ctx.back();
  });
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    ctx.setLanguage("de");
  });
  await expect(page.locator(".h-title")).toHaveText("Die Zehn");
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    ctx.setLanguage("en");
  });
  await expect(page.locator(".h-title")).toHaveText("The Ten");

  // Both senders called directly as well, in a page where the channel does not
  // exist at all: they decide there is no shell and return false.
  const direct = await page.evaluate(async () => {
    const nav = await import("/web/js/nav.js");
    return {
      state: nav.navState({ screen: "outline", root: null, depth: 0, sheet: false }),
      tabs: nav.navTabs(),
      shell: typeof window.__tenfoldShell,
    };
  });

  expect(direct.state).toBe(false);
  expect(direct.tabs).toBe(false);
  expect(direct.shell).toBe("undefined");
  expect(errors).toEqual([]);
  // The app still works, which is the point of the whole guard.
  await expect(page.locator(".h-title")).toHaveText("The Ten");
});

// ------------------------------------------------------------------- nav.go
//
// The other direction, and the half the last commit shipped without its specs.
// Everything below drives the app through `_receive` - the real delivery route,
// not the module's own export - because the thing worth testing is the whole
// chain: the shell's message, `nav.js` deciding whether it is a tab and a
// reason this app has, `app.js` deciding what the app is currently doing, and
// the `nav.state` that comes back out as the only receipt there is.
//
// Two properties run through all of it. A tap that is understood REPLACES:
// `landOn()` collapses the stack rather than pushing onto it, so no number of
// taps can grow the history. A tap that is not understood is SILENT: nothing
// happens, so nothing is reported, and silence is the honest answer rather than
// a nack the bar could not act on anyway.

test("each tab tap lands on that tab's root, from wherever the app is", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);

  // As deep as this app goes: outline -> focus -> leaf, depth 2.
  await page.locator(".row-shell").first().locator(".row").click();
  await expect(page.locator(".hero-title")).toHaveText("Alpha");
  await addParts(page, ["Call the practice"]);
  await page.locator(".list.is-kids .row-shell").first().locator(".row").click();
  expect((await lastState(page)).depth).toBe(2);

  // Today. Depth 1 rather than 0, and deliberately: `landOn()` arranges the
  // outline underneath every root that is not the outline itself, which is what
  // makes the close button on Today land somewhere predictable on a build with
  // no bar. What matters here is that two screens of depth became one.
  await tap(page, "today");
  await expect(page.locator(".h-title")).toHaveText("Today");
  expect(await lastState(page)).toEqual({
    type: "nav.state",
    screen: "today",
    tab: "today",
    depth: 1,
    sheet: false,
  });

  await tap(page, "map");
  await expect(page.locator(".h-title")).toHaveText("Map");
  expect(await lastState(page)).toEqual({
    type: "nav.state",
    screen: "map",
    tab: "map",
    depth: 1,
    sheet: false,
    edgeBack: false,
  });

  // "More" is the bar's word and `settings` is the screen. The one place the
  // two tables face each other, and the one that would rot quietly.
  await tap(page, "more");
  await expect(page.locator(".h-title")).toHaveText("Settings");
  expect(await lastState(page)).toEqual({
    type: "nav.state",
    screen: "settings",
    tab: "more",
    depth: 1,
    sheet: false,
  });

  // The outline is the floor, so it lands at depth 0 and nothing is underneath
  // it: a back press from here leaves the app, as it should.
  await tap(page, "outline");
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  expect(await lastState(page)).toEqual({
    type: "nav.state",
    screen: "outline",
    tab: "outline",
    depth: 0,
    sheet: false,
  });
});

test("the stack collapses under repeated taps instead of growing", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);

  await page.locator(".row-shell").first().locator(".row").click();
  await expect(page.locator(".hero-title")).toHaveText("Alpha");
  await addParts(page, ["Call the practice"]);
  await page.locator(".list.is-kids .row-shell").first().locator(".row").click();
  expect((await lastState(page)).depth).toBe(2);

  // Two screens deep, one tap, and the depth is 0. This is the whole reason the
  // handler routes through `landOn()` rather than `go()`: pushing would leave
  // the stack growing for the life of the session and run the back gesture
  // backwards through tab taps, which no iOS app does.
  await tap(page, "outline");
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  expect((await lastState(page)).depth).toBe(0);

  // Sixteen taps around the bar. The depth after each is a property of the tab
  // alone - never of how many taps came before it.
  const fromHere = await navCount(page);
  const ROUND = [
    ["today", "Today", 1],
    ["map", "Map", 1],
    ["more", "Settings", 1],
    ["outline", "The Ten", 0],
  ];
  for (let i = 0; i < 4; i += 1) {
    for (const [tabKey, title, depth] of ROUND) {
      await tap(page, tabKey);
      await expect(page.locator(".h-title")).toHaveText(title);
      const now = await lastState(page);
      expect(now.depth, `${tabKey} on round ${i}`).toBe(depth);
    }
  }

  // And every message across those sixteen taps agrees: the app's own stack
  // never went past one, which is the floor `landOn()` puts under the three
  // roots that are not the outline - and never one deeper.
  const depths = await page.evaluate(
    (from) =>
      (window.__shellMessages || [])
        .filter((m) => m && String(m.type).indexOf("nav.") === 0)
        .slice(from)
        .filter((m) => m.type === "nav.state")
        .map((m) => m.depth),
    fromHere,
  );
  expect(depths.length).toBeGreaterThan(16);
  expect(Math.max(...depths)).toBe(1);
});

test("tab-again does nothing at the root, and collapses to it from deeper", async ({ page }) => {
  const errors = [];
  // A View Transition interrupted by the next one rejects with an AbortError.
  // That is normal here rather than a fault - this test routes deliberately
  // fast - and it is pre-existing noise from `motion.js`, not something a tab
  // tap introduced. Everything else still has to be silence.
  page.on("pageerror", (err) => {
    if (String(err).includes("Transition was skipped")) return;
    errors.push(String(err));
  });
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);
  await expect(page.locator(".h-title")).toHaveText("The Ten");

  // Already on the outline, and the outline is at depth 0. NOTHING - not a
  // repaint, not a message. Not scroll-to-top either: that would be a fourth
  // behaviour needing a fifth message to reach the scroll container, and
  // "nothing" is an answer somebody learns in one try.
  const before = await navCount(page);
  await tap(page, "outline", "tab-again");
  await tap(page, "outline", "tab-again");
  await page.waitForTimeout(120);
  expect(await navCount(page)).toBe(before);
  expect((await where(page)).view).toBe("outline");
  await expect(page.locator(".h-title")).toHaveText("The Ten");

  // Two screens deep in the same tab: collapse to its root.
  await page.locator(".row-shell").first().locator(".row").click();
  await expect(page.locator(".hero-title")).toHaveText("Alpha");
  await addParts(page, ["Call the practice"]);
  await page.locator(".list.is-kids .row-shell").first().locator(".row").click();
  expect((await lastState(page)).depth).toBe(2);

  await tap(page, "outline", "tab-again");
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  expect(await lastState(page)).toEqual({
    type: "nav.state",
    screen: "outline",
    tab: "outline",
    depth: 0,
    sheet: false,
  });

  // And once there, a third tap is nothing again.
  const settled = await navCount(page);
  await tap(page, "outline", "tab-again");
  await page.waitForTimeout(120);
  expect(await navCount(page)).toBe(settled);

  // The three roots that are not the outline sit at depth 1, because `landOn()`
  // puts the outline under them. A second tap there is therefore NOT the
  // nothing-case: the guard reads the stack, and the stack is not empty. It
  // re-lands on the same screen at the same depth - one repaint, no movement.
  // Recorded rather than judged: it is what the depth rule says, and the
  // alternative (comparing screens instead of counting the stack) is a second
  // copy of the tab model inside the handler.
  await tap(page, "today");
  await expect(page.locator(".h-title")).toHaveText("Today");
  const onToday = await lastState(page);
  await tap(page, "today", "tab-again");
  await expect(page.locator(".h-title")).toHaveText("Today");
  expect(await lastState(page)).toEqual(onToday);

  expect(errors).toEqual([]);
});

test("a notification arrives as a tab tap does, to the letter", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);

  // The same starting point twice, and the two answers compared field by field.
  const walkToLeaf = async () => {
    await tap(page, "outline");
    await expect(page.locator(".h-title")).toHaveText("The Ten");
    await page.locator(".row-shell").first().locator(".row").click();
    await expect(page.locator(".hero-title")).toHaveText("Alpha");
  };

  await walkToLeaf();
  await tap(page, "today", "tab");
  await expect(page.locator(".h-title")).toHaveText("Today");
  const viaTab = await lastState(page);

  await walkToLeaf();
  await tap(page, "today", "notification");
  await expect(page.locator(".h-title")).toHaveText("Today");
  const viaNotification = await lastState(page);

  expect(viaNotification).toEqual(viaTab);
  expect(viaNotification).toEqual({
    type: "nav.state",
    screen: "today",
    tab: "today",
    depth: 1,
    sheet: false,
  });

  // The one thing it shares with `tab` and not with `tab-again`: it is not
  // conditional on the depth. From the root of another tab it still moves.
  await tap(page, "outline");
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  expect((await lastState(page)).depth).toBe(0);
  await tap(page, "today", "notification");
  await expect(page.locator(".h-title")).toHaveText("Today");
  expect((await lastState(page)).screen).toBe("today");
});

test("a tab tap closes an open sheet rather than leaving it standing behind", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);
  await page.locator(".row-shell").first().locator(".row").click();
  await expect(page.locator(".hero-title")).toHaveText("Alpha");

  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.locator(".sheet")).toBeVisible();
  expect(await lastState(page)).toEqual({
    type: "nav.state",
    screen: "focus",
    tab: "outline",
    depth: 1,
    sheet: true,
  });

  const mark = await navCount(page);
  await tap(page, "today");
  await expect(page.locator(".h-title")).toHaveText("Today");

  // The sheet is gone, not behind the new screen. Closed from THIS side and
  // before the route rather than after it: both happen in one task, which costs
  // one history traversal instead of two.
  await expect(page.locator(".sheet")).toHaveCount(0);
  expect(await lastState(page)).toEqual({
    type: "nav.state",
    screen: "today",
    tab: "today",
    depth: 1,
    sheet: false,
  });

  // And at no point in between did the app claim a sheet over Today - which is
  // what a close-after-route would have reported for one message.
  const after = await states(page);
  for (const message of after.slice(mark)) {
    expect(message.sheet && message.screen === "today", "a sheet was reported over Today").toBe(
      false,
    );
  }
});

test("an unknown tab, an unknown reason, a locked app and a vault-less app are dropped", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await stubShell(page);
  await freshApp(page);

  // No vault yet. The bar is not drawn on setup either, so a tap here is the
  // two repositories being briefly out of step rather than something somebody
  // did - and a silent drop is the honest answer to both.
  await expect(page.locator(".screen")).toBeVisible();
  expect((await where(page)).view).toBe("setup");
  let mark = await navCount(page);
  await tap(page, "today");
  await tap(page, "outline", "tab-again");
  await page.waitForTimeout(120);
  expect(await navCount(page)).toBe(mark);
  expect((await where(page)).view).toBe("setup");

  await setupVault(page);
  await addRoots(page, ["Alpha"]);
  await expect(page.locator(".h-title")).toHaveText("The Ten");

  // A tab this app does not have, a reason it does not understand, and the
  // shapes a mismatched pair can actually produce - including the two the
  // prototype-less lookup table exists for.
  mark = await navCount(page);
  await tap(page, "dashboard");
  await tap(page, "settings");
  await tap(page, "TODAY");
  await tap(page, "today", "shove");
  await tap(page, "today", "tab-again-again");
  await tapRaw(page, { type: "nav.go" });
  await tapRaw(page, { type: "nav.go", tab: "today" });
  await tapRaw(page, { type: "nav.go", tab: null, reason: "tab" });
  await tapRaw(page, { type: "nav.go", tab: 7, reason: "tab" });
  await tapRaw(page, { type: "nav.go", tab: "constructor", reason: "tab" });
  await tapRaw(page, { type: "nav.go", tab: "toString", reason: "tab" });
  await tapRaw(page, { type: "nav.go", tab: "today", reason: null });
  await page.waitForTimeout(150);

  expect(await navCount(page)).toBe(mark);
  expect((await where(page)).view).toBe("outline");
  await expect(page.locator(".h-title")).toHaveText("The Ten");

  // Locked: there is no document to route into, and the vault must not be the
  // thing a stray message reopens.
  await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    await ctx.lock();
  });
  await page.waitForSelector(".lock-title");
  mark = await navCount(page);
  await tap(page, "today");
  await tap(page, "more");
  await tap(page, "outline", "notification");
  await page.waitForTimeout(120);
  expect(await navCount(page)).toBe(mark);
  expect((await where(page)).view).toBe("lock");
  await expect(page.locator(".lock-title")).toBeVisible();

  // Not one of the twelve threw, which is the property that matters most: a tab
  // tap arriving at an awkward moment must never take a session down.
  expect(errors).toEqual([]);
});

test("the answer to a tab tap is the next nav.state, and never a reply", async ({ page }) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);
  await page.locator(".row-shell").first().locator(".row").click();
  await expect(page.locator(".hero-title")).toHaveText("Alpha");

  const mark = await navCount(page);
  // `_receive` hands back nothing. There is no promise to settle, no ack to
  // wait for, and the shell has nothing to time out on.
  const returned = await tap(page, "today");
  expect(returned).toBeUndefined();
  await expect(page.locator(".h-title")).toHaveText("Today");

  const answer = await page.evaluate((from) => {
    const all = (window.__shellMessages || []).filter(
      (m) => m && String(m.type).indexOf("nav.") === 0,
    );
    return {
      after: all.slice(from),
      sent: (window.__shellSent || []).filter((m) => String(m.type).indexOf("nav.") === 0),
      posted: (window.__shellPosted || []).filter((m) => String(m.type).indexOf("nav.") === 0)
        .length,
    };
  }, mark);

  // What came back is state, and only state: no echo of `nav.go`, no `ok`, no
  // `replyTo`. The honest receipt reports what HAPPENED rather than that a
  // message was understood.
  expect(answer.after.length).toBeGreaterThan(0);
  for (const message of answer.after) {
    expect(message.type).toBe("nav.state");
    expect(Object.prototype.hasOwnProperty.call(message, "replyTo")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(message, "ok")).toBe(false);
  }
  expect(answer.after[answer.after.length - 1]).toEqual({
    type: "nav.state",
    screen: "today",
    tab: "today",
    depth: 1,
    sheet: false,
  });

  // And it went out through `post`, never `send`: a routing change must never
  // wait on a tab bar, so there is no round trip to block on in the first place.
  expect(answer.sent).toEqual([]);
  expect(answer.posted).toBeGreaterThan(0);

  // The counter-case, and the reason there is no reply at all: a tap that was
  // dropped says nothing whatsoever. Nothing happened, so there is nothing to
  // report, and the bar's own selection is the shell's business to keep.
  const quiet = await navCount(page);
  await tap(page, "dashboard");
  await page.waitForTimeout(120);
  expect(await navCount(page)).toBe(quiet);
});

// ------------------------------------------------- the header fork (section 3)
//
// A native tab bar draws Today, The Ten, the map and More under the web view.
// Everything in a web header that leads to one of those four is then the same
// destination twice, and the copy further from the thumb is the one nobody
// presses - so it goes. What does NOT go is everything else, and the list of
// what stays is the more important half of this fork: the search icon (search
// is not a tab, and the bar leads nowhere near it), the hints on the outline
// that route rather than navigate, the contextual bottom bar on every screen,
// and every X at depth one and below - those mirror the back gesture, not the
// bar, and on a build whose gesture is not installed they are the only way out.
//
// The predicate is `shellWith(CAP_NAV)` and deliberately not `inShell()`, which
// is what the last two tests here are about: an older shell, or one whose
// bundled copy of `web/` is ahead of its Swift, keeps the whole web header and
// stays a complete app rather than losing every route into settings.
//
// These live in nav.spec.js rather than shell.spec.js because the fork is part
// of the navigation contract rather than of the bridge transport: the predicate,
// the four tabs and the reason each element goes or stays are all written down
// in the nav section of docs/CONTRACTS.md, and this file already owns the stub
// that advertises `nav`. shell.spec.js's stub advertises the shipping list and
// its subject is what crosses the channel, not what the screens draw.

const todayLink = (page) => page.locator(".head-actions .btn-ghost.is-today");
const mapButton = (page) => page.locator(".head-actions .iconbtn.is-map");
const gearButton = (page) => page.locator('.head-actions button[aria-label="Open settings"]');
const searchButton = (page) => page.locator('.head-actions button[aria-label="Open search"]');
const closeButton = (page) => page.locator('.head-actions button[aria-label="Close"]');

/** The four the fork is about, counted on the outline. */
async function outlineHeader(page) {
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  return {
    today: await todayLink(page).count(),
    map: await mapButton(page).count(),
    gear: await gearButton(page).count(),
    search: await searchButton(page).count(),
  };
}

test("with a tab bar the outline header loses Today, the map and the gear - and keeps search", async ({
  page,
}) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);

  expect(await where(page)).toEqual({ view: "outline", shellNav: true });
  expect(await outlineHeader(page)).toEqual({ today: 0, map: 0, gear: 0, search: 1 });

  // Search still opens, which is the point of keeping it: the bar has no fifth
  // item and this is the only door. Its own closing button is in the search bar
  // rather than in a header and stays where it is, at depth 1.
  await searchButton(page).click();
  await expect(page.locator('input[type="search"]')).toBeVisible();
  await expect(page.locator('.searchbar button[aria-label="Close"]')).toBeVisible();
  await tap(page, "outline");
  await expect(page.locator(".h-title")).toHaveText("The Ten");

  // Everything else on this screen is untouched. The two hints route rather
  // than navigate - the Today tab lights up because a `nav.state` follows - and
  // the bottom bar is this screen's content, not its chrome.
  await expect(page.locator(".h-sub")).toContainText("only in this browser");
  await expect(page.getByRole("button", { name: "New entry" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Put in order" })).toBeVisible();
});

test("with a tab bar the three tab roots lose their X, and every X deeper keeps it", async ({
  page,
}) => {
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);

  // Today: the whole `head-actions` goes, because the X was all it held.
  await tap(page, "today");
  await expect(page.locator(".h-title")).toHaveText("Today");
  expect(await closeButton(page).count()).toBe(0);
  expect(await page.locator(".head .head-actions").count()).toBe(0);

  // The map keeps its own controls and loses only the way out.
  await tap(page, "map");
  await expect(page.locator(".h-title")).toHaveText("Map");
  expect(await closeButton(page).count()).toBe(0);
  await expect(page.getByRole("button", { name: "Show everything" })).toBeVisible();

  // Settings, the root of More.
  await tap(page, "more");
  await expect(page.locator(".h-title")).toHaveText("Settings");
  expect(await closeButton(page).count()).toBe(0);

  // And one screen further in - About, at depth 2 behind settings - the X is
  // exactly where it was. It mirrors the back gesture rather than the bar, and
  // on a build where that gesture is not installed it is the only way out.
  await page.getByText("About tenfold", { exact: true }).click();
  await expect(page.locator(".h-title")).toHaveText("About tenfold");
  expect((await lastState(page)).depth).toBe(2);
  expect(await closeButton(page).count()).toBe(1);
  await closeButton(page).click();
  await expect(page.locator(".h-title")).toHaveText("Settings");

  // The focus screen, at depth 1, keeps its way back as well - a chevron in the
  // crumb rather than an X in a header, and the same argument covers both.
  await tap(page, "outline");
  await page.locator(".row-shell").first().locator(".row").click();
  await expect(page.locator(".hero-title")).toHaveText("Alpha");
  await expect(page.locator('.crumb button[aria-label="Back one level"]')).toBeVisible();
  // And the bottom bar underneath it, which is this screen's content.
  await expect(page.locator(".bar button").first()).toBeVisible();
});

test("without the capability every one of them is still there", async ({ page }) => {
  // The list the shell is actually advertising right now - a build with the
  // bridge and no bar. This is the branch the browser and the PWA take too, and
  // it has to be the header the app has always had.
  await stubShell(page, ["reminder", "badge", "widget", "vaultmirror", "haptic"]);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);

  expect(await where(page)).toEqual({ view: "outline", shellNav: false });
  expect(await outlineHeader(page)).toEqual({ today: 1, map: 1, gear: 1, search: 1 });

  // All four lead where they always did, and the three closing buttons are back.
  await todayLink(page).click();
  await expect(page.locator(".h-title")).toHaveText("Today");
  expect(await closeButton(page).count()).toBe(1);
  await closeButton(page).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");

  await mapButton(page).click();
  await expect(page.locator(".h-title")).toHaveText("Map");
  expect(await closeButton(page).count()).toBe(1);
  await closeButton(page).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");

  await gearButton(page).click();
  await expect(page.locator(".h-title")).toHaveText("Settings");
  expect(await closeButton(page).count()).toBe(1);
  await closeButton(page).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
});

test("in a plain browser the header is untouched, and shellNav is false", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta"]);

  expect(await where(page)).toEqual({ view: "outline", shellNav: false });
  expect(await outlineHeader(page)).toEqual({ today: 1, map: 1, gear: 1, search: 1 });

  await todayLink(page).click();
  await expect(page.locator(".h-title")).toHaveText("Today");
  expect(await page.locator(".head .head-actions").count()).toBe(1);
  await closeButton(page).click();
  await expect(page.locator(".h-title")).toHaveText("The Ten");
  expect(errors).toEqual([]);
});

test("the fork is the capability and not inShell(): a shell with everything but nav keeps its header", async ({
  page,
}) => {
  // The case the whole predicate exists for. Every shell ever built answers yes
  // to `inShell()`, including the ones bundling a copy of `web/` older than the
  // Swift that draws the bar. Reading the weaker predicate would take the gear
  // off this outline and leave nothing in its place.
  await stubShell(page, ["reminder", "badge", "widget", "vaultmirror", "haptic", "bio"]);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha"]);

  const facts = await page.evaluate(async () => {
    const { ctx } = await import("/web/js/app.js");
    const { inShell, shellWith, CAP_NAV } = await import("/web/js/shell.js");
    return { inShell: inShell(), withNav: shellWith(CAP_NAV) !== null, shellNav: ctx.shellNav };
  });
  // A shell, unmistakably - and the header stays whole anyway.
  expect(facts.inShell).toBe(true);
  expect(facts.withNav).toBe(false);
  expect(facts.shellNav).toBe(false);
  expect(await outlineHeader(page)).toEqual({ today: 1, map: 1, gear: 1, search: 1 });
});

test("a tab switch away from the map stops the loop the close button used to stop", async ({
  page,
}) => {
  // The one thing the design flagged rather than assumed. `map.js`'s close
  // button ran `stopLoop(); stopCam();` before going back, and a tab switch
  // never presses it. Nothing had to move: `draw()` opens with
  // `if (!alive()) { stopCam(); return; }` and `frame()` stops the loop - and
  // takes the visibility listener with it - the moment the svg is detached. The
  // cost of leaving by the bar is the one frame the browser's own back button
  // has always cost.
  await stubShell(page);
  await freshApp(page);
  await setupVault(page);
  await addRoots(page, ["Alpha", "Beta", "Gamma"]);

  await tap(page, "map");
  await expect(page.locator(".map-canvas")).toBeVisible();
  await expect(page.locator(".map-scene.is-ready")).toHaveCount(1);
  // The constellation, because the mind map deliberately holds still: there is
  // no animation frame at all in that mode, so it could not prove anything
  // about a loop stopping. The mode toggle is not part of the fork and is still
  // on the screen.
  const sky = page.getByRole("button", { name: "Constellation" });
  if ((await sky.getAttribute("aria-pressed")) !== "true") await sky.click();
  await expect(page.locator(".map-tree > .map-body").first()).toBeVisible();
  await page.waitForTimeout(350);
  const running = await page.evaluate(() => window.__tfMap);
  expect(running.loop).toBe(true);
  expect(running.frames).toBeGreaterThan(4);

  // Out by the bar, not by the X - which is not on the screen any more.
  expect(await closeButton(page).count()).toBe(0);
  await tap(page, "outline");
  await expect(page.locator(".h-title")).toHaveText("The Ten");

  await page.waitForTimeout(150);
  const a = await page.evaluate(() => window.__tfMap.frames);
  await page.waitForTimeout(300);
  const b = await page.evaluate(() => window.__tfMap.frames);
  expect(b).toBe(a);
  expect(await page.evaluate(() => window.__tfMap.loop)).toBe(false);
});
