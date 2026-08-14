// nav.js - where the app is, told to a native tab bar.
//
// What it does: works out which of four tabs the screen on display belongs to,
// and posts that - with the depth of the stack and whether a sheet is up - to
// the native shell. It also hands over the four labels, once at boot and again
// whenever the language changes. That is the whole module.
//
// Why it exists: the iOS shell wants a `UITabBar` under the web view, and a tab
// bar has to know two things it cannot work out for itself - which tab is
// current, and what the four of them are called. Both answers live in the web
// app: the routing is here, and so is the only catalogue of text this product
// has. The shell holds no strings, by doctrine (tenfold-ios/docs/BRIDGE.md says
// so four times), and this is the message that lets it keep that rule while
// still drawing words.
//
// THREE OF THE FOUR MESSAGES. The upward pair went first, on purpose, so the
// two repositories never had to move in the same week; this file now also takes
// the tab tap coming back down. The fourth, `nav.back`, is the edge gesture and
// is a later stage, and so is the header fork that hides what the tabs
// duplicate - deliberately in that order, because a build that hides the
// settings gear before the More tab routes is a build with no way into
// settings.
//
// The wire shapes, fixed, and duplicated in the shell repository by the same
// necessity every other message here is - two repositories, no shared import:
//
//     page -> shell, fire and forget:
//       { type: "nav.state", screen: "leaf", tab: "outline", depth: 2,
//         sheet: false, edgeBack: false }
//       { type: "nav.tabs", tabs: [{ key: "today", label: "Today" }, ...] }
//
//     shell -> page, unprompted, no reply:
//       { type: "nav.go", tab: "today", reason: "tab" }
//
// NEVER A NODE ID, AND NEVER A TITLE. `app.js` already refuses to put an id
// into `history.state` - "even a uuid out of an encrypted list has no business
// outside memory" - and this message inherits that word for word. It carries a
// screen NAME, a tab name, an integer and two booleans, and the whole set is a
// closed vocabulary written in this file. That is the one line of the new
// contract that is asserted rather than assumed: tests/nav.spec.js drives the
// app through goals with distinctive titles and reads every message that left.
//
// Two messages rather than one, on purpose. `nav.state` rides the render path -
// it is posted from `syncHistory()`, which runs inside `go()` - so it has to
// stay tiny; the labels change about as often as somebody changes language.
//
// In a browser every function here is a no-op and none of them throws.

import { CAP_NAV, shellWith, shellPost, onShellMessage } from "./shell.js";
import { t, onLocaleChange } from "./i18n.js";

/**
 * The message names, exactly as the shell answers to them.
 *
 * Pinned literally by a test on this side and by the bridge's own tests on the
 * other. A rename would not break a build; it would quietly leave a tab bar
 * with no selection and no words on it, or a tab that swallows every tap.
 */
export const MSG_STATE = "nav.state";
export const MSG_TABS = "nav.tabs";
export const MSG_GO = "nav.go";

/**
 * The four tabs, in the order the bar draws them.
 *
 * Closed, and closed on both sides: the shell REJECTS a `nav.tabs` that is not
 * exactly these four keys in this order, because half a tab bar is worse than
 * none, and it rejects an unknown `tab` on a `nav.state` rather than drawing a
 * control that leads nowhere. An unknown `screen` is the asymmetric case and is
 * tolerated over there - a newer web app meeting an older shell should lose its
 * highlight, not its bar.
 */
export const TABS = Object.freeze(["today", "outline", "map", "more"]);

/**
 * Which screen is the root of which tab, and the entire tab model's data.
 *
 * Three of the four are the screen of the same name. The fourth is not: "More"
 * is a bar label for a screen called `settings`, because a tab bar item reading
 * "Settings" next to "The Ten" claims a symmetry that does not exist - settings
 * is one of several things behind that tab, and the others (About, the context
 * list) are reached through it.
 */
const TAB_ROOTS = Object.freeze({
  today: "today",
  outline: "outline",
  map: "map",
  settings: "more",
});

/**
 * The same table read the other way: which screen a tab lands on.
 *
 * DERIVED rather than written out a second time. Two literal tables facing each
 * other is how `more` ends up meaning `settings` going up and `about` coming
 * back down, six months apart, with nothing failing in between.
 *
 * Prototype-less on purpose, and this one is not pedantry: unlike `TAB_ROOTS`,
 * whose keys are screen names this app writes itself, the key looked up here
 * arrives from OUTSIDE - it is a field on a native message. On a plain object
 * `rootOf("constructor")` would answer with a function and a tab tap would
 * route into it.
 */
const ROOT_OF = Object.freeze(
  Object.keys(TAB_ROOTS).reduce((into, screen) => {
    into[TAB_ROOTS[screen]] = screen;
    return into;
  }, Object.create(null)),
);

/**
 * Which screen a tab tap lands on.
 *
 * @param {string} tab one of TABS
 * @returns {string|null} the screen name, or null for anything else - and null
 *   is what makes an unknown tab a dropped message rather than a guess
 */
export function rootOf(tab) {
  if (typeof tab !== "string") return null;
  return ROOT_OF[tab] || null;
}

/**
 * Why the tab bar is asking. Three, closed, and each one means something the
 * others do not - see `startShellNav` below and docs/CONTRACTS.md for what the
 * page does with each.
 *
 * An unrecognised reason is dropped rather than treated as `tab`. The
 * asymmetry with an unknown `screen` going the other way is the same one the
 * contract already makes: losing a highlight is a cosmetic degradation, while
 * acting on an instruction that was not understood moves somebody's app.
 */
export const REASONS = Object.freeze(["tab", "tab-again", "notification"]);

/**
 * The labels' keys. Three of the four are the titles those screens already wear
 * in their own headers, which is what makes it impossible for the bar and the
 * heading to disagree - and what makes a language change re-title both in the
 * same frame. Only "More" needed a key of its own; there is no screen called
 * that.
 */
const LABEL_KEYS = Object.freeze({
  today: "today.title",
  outline: "outline.title",
  map: "map.title",
  more: "nav.more",
});

/**
 * How long a tab label may be before it is cut.
 *
 * Not a display decision - the bar's own truncation is the shell's business -
 * but a bound on what crosses. Four fixed surface words out of the app's own
 * catalogue are content-free by construction; a cap is what keeps that true if
 * a catalogue ever grows a sentence where a word belongs.
 */
const LABEL_MAX = 24;

/**
 * The screens whose own horizontal gesture owns the left edge.
 *
 * `duel` spans the screen with a beam and already has a control called *back*
 * that means "take the last decision back"; `map` sets `touch-action: none` and
 * pans a camera. A native edge recogniser on either of them would be a second
 * meaning for one movement. Nothing reads this yet - the gesture is a later
 * stage - and it is emitted now anyway because it costs one array membership
 * test and because the page is the only side that knows it.
 */
const NO_EDGE_BACK = Object.freeze(["duel", "map"]);

/**
 * Which tab a screen belongs to - the whole tab model, and the only logic here.
 *
 * The highlight is a function of the PAIR, not of the screen: `entities` is
 * reached from settings and from a leaf, and `search`/`focus`/`leaf`/`duel` all
 * hang under the outline. Asking only "which screen" would light the wrong tab
 * for half the app.
 *
 * The root test comes FIRST, and that ordering is the one thing in these eight
 * lines that is load-bearing. `finishIntro` leaves the app on Today with the
 * outline underneath it - view `today`, stack `[outline]` - and a rootName-first
 * reading would light The Ten while Today is on screen. A screen that is itself
 * a tab root answers for itself, whatever is beneath it.
 *
 * @param {string} viewName the screen on display (`state.view.name`)
 * @param {string|null} [rootName] the bottom of the stack (`state.stack[0]`)
 * @returns {string|null} one of TABS, or null for "no tab, hide the bar" -
 *   setup, the lock screen, and the first-run About intro
 */
export function tabFor(viewName, rootName) {
  const own = TAB_ROOTS[viewName];
  if (own) return own;
  if (rootName) return TAB_ROOTS[rootName] || null;
  return null;
}

/**
 * Say where the app is.
 *
 * ONE CALL SITE, and it has to stay one: `syncHistory()` in app.js, which every
 * routing change already goes through - `go()`, `stepBack()`, `lock()`,
 * `enterApp()`, `finishIntro()`, `landOn()` and the sheet subscription. Two
 * mirrors of one stack drift the day somebody adds a third caller to only one
 * of them, and the history mirror is the one that is already right.
 *
 * `mutate()` does NOT call `syncHistory()` - verified, and it must stay that
 * way: it is the path a keystroke in the composer takes, and a `nav.state` per
 * character would put this bridge on the typing path.
 *
 * Fire and forget (`post`, not `send`). It rides the render path, and a routing
 * change must never wait on a tab bar - the same argument `widget.state` makes.
 *
 * `tab` is OMITTED rather than sent as null when there is none: absent means
 * "no tab, hide the bar", which is what setup, the lock screen and the intro
 * want. `edgeBack` is omitted when true, for the same economy - absent means
 * true on the other side.
 *
 * @param {{screen: string, root?: string|null, depth?: number, sheet?: boolean}} where
 * @returns {boolean} whether a shell took it
 */
export function navState(where) {
  if (!shellWith(CAP_NAV)) return false;
  const at = where || {};
  const screen = typeof at.screen === "string" ? at.screen : "";
  const tab = tabFor(screen, typeof at.root === "string" ? at.root : null);
  const depth = Number.isFinite(at.depth) && at.depth > 0 ? Math.floor(at.depth) : 0;
  const message = { type: MSG_STATE, screen };
  if (tab) message.tab = tab;
  message.depth = depth;
  message.sheet = at.sheet === true;
  if (NO_EDGE_BACK.indexOf(screen) !== -1) message.edgeBack = false;
  return shellPost(message);
}

/**
 * Hand over the four words.
 *
 * The page supplies the set and the shell keeps no catalogue - the same rule as
 * `reminder.schedule` and `push.notice.title`, and it carries here where it
 * could not for the widget: the bar is only on screen while the page is
 * running, so there is always a live app to ask.
 *
 * Exactly four, in TABS order, capped. The shell refuses anything else outright.
 *
 * @returns {boolean} whether a shell took it
 */
export function navTabs() {
  if (!shellWith(CAP_NAV)) return false;
  const tabs = TABS.map((key) => ({
    key,
    label: String(t(LABEL_KEYS[key])).slice(0, LABEL_MAX),
  }));
  return shellPost({ type: MSG_TABS, tabs });
}

/**
 * Start both halves: the labels now and on every language change, and the ear
 * for a tab tap coming back.
 *
 * `onLocaleChange` is the honest hook rather than the settings screen: the
 * language can move from three places (the switch on the lock screen, the row in
 * settings, and a document arriving from another device with a different `lang`),
 * and all three end in `setLocale`. It also already ignores a no-op change, so
 * this posts on a real change and not on every settings write.
 *
 * THERE IS NO REPLY TO A `nav.go`, and that is deliberate rather than an
 * omission. The page answers with its next `nav.state`, which is the honest
 * receipt: it reports what actually HAPPENED - which screen, at which depth,
 * with the sheet down - rather than that a message was understood. A tab tap
 * that was dropped (no document, an unknown tab, a second tap on a root) is
 * therefore silent, and correctly so: nothing happened, so there is nothing to
 * report, and the bar's own selection is the shell's business to keep.
 *
 * WHAT THIS FILE DECIDES AND WHAT IT DOES NOT. The wire is decided here: is
 * this a tab the app has, is this a reason it understands, which screen is that
 * tab's root. Everything that needs to know what the app is currently DOING -
 * whether a vault is open, how deep the stack is, whether a sheet is up - is
 * the caller's, because that state lives in app.js and this module holds none.
 * Same split as `startShellVaultLock`, and for the same reason: a transport
 * that started reading app state would be a second copy of the routing rules.
 *
 * The callback receives `{ tab, root, reason }` - the tab as sent, the screen
 * it lands on, and the reason, guaranteed to be one of REASONS. It is called
 * synchronously, inside the dispatch. A callback that throws is swallowed: a
 * tab tap arriving at an awkward moment must never take a session down.
 *
 * Called from `boot()` unconditionally, and NOT gated on `CAP_NAV` - the same
 * choice `share.incoming` and `vault.lock` make. This is a push the page
 * listens for rather than a feature it asks for; only a shell that draws a bar
 * can send it, so a capability check would be a second lock on a door only one
 * key opens. In a browser it costs one listener that never fires.
 *
 * @param {(go: {tab: string, root: string, reason: string}) => void} [onGo]
 * @returns {() => void} unsubscribes from both
 */
export function startShellNav(onGo) {
  navTabs();
  const stopLocale = onLocaleChange(() => {
    navTabs();
  });
  const stopGo = onShellMessage(MSG_GO, (message) => {
    const tab = message.tab;
    const root = rootOf(tab);
    // An unknown tab is dropped. The shell should never send one - it is handed
    // the four keys by `nav.tabs` and refuses any other set - so this guard is
    // for the pair that is out of step, which is the ordinary state of two
    // repositories on two release cycles.
    if (!root) return;
    if (REASONS.indexOf(message.reason) === -1) return;
    if (typeof onGo !== "function") return;
    try {
      onGo({ tab, root, reason: message.reason });
    } catch {
      // Nothing to report to: the bar asked for a screen, not for an answer.
    }
  });
  return () => {
    stopLocale();
    stopGo();
  };
}
