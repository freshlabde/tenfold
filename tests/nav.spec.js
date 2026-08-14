// Where the app is, told to a native tab bar.
//
// The iOS shell wants a `UITabBar` under the web view. A tab bar has to know
// two things it cannot work out for itself - which tab is current, and what the
// four of them are called - and both answers live here: the routing is in
// app.js and the only catalogue of text this product has is in locales/.
// `web/js/nav.js` is the web half of the answer.
//
// THIS IS THE UPWARD HALF ONLY. Nothing native reads either message yet, no
// shell advertises `nav`, and there is no receiver on this side for the two
// messages that will one day come back. So the tests below fall into two kinds,
// and the second kind is the more important one today:
//
//   - with a shell that advertises `nav`: which message goes out, carrying
//     which fields, at which moment.
//   - with today's shell, and with no shell at all: that NOTHING goes out, over
//     a whole session rather than at module level. A stage whose whole promise
//     is "provably inert" has to be tested for inertness by walking the app.
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
    window.__tenfoldShell = {
      platform: "ios",
      version: "0.5.0 (5)",
      loader: "scheme://app",
      origin: String(location.origin),
      capabilities: caps,
      post(message) {
        messages.push(message);
        return true;
      },
      send(message) {
        messages.push(message);
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

  // The map: touch-action none and a panned camera own the left edge.
  await page.getByRole("button", { name: "Open the map" }).click();
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
