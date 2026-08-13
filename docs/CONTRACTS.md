# tenfold: binding contracts between modules

This file is the contract that all modules are built against, independently of each other.
Anyone who wants to change an interface changes this file first.

## Ground rules (apply to every file under `web/`)

1. **Pure ES modules.** `export`/`import`, no bundler, no third-party library, no CDN.
2. **No `innerHTML` with user content.** Anywhere. Text goes through `textContent` /
   `document.createTextNode` only. In a zero-knowledge app an injected script is total loss:
   it would hold the plaintext *and* the key.
3. **No `eval`, no `new Function`, no inline event attributes** (`onclick=…`).
   `addEventListener` only.
4. **No emojis** in code, UI copy, or comments.
5. **Language: English is the default everywhere** for identifiers, comments, docs, commit
   messages. UI copy goes through i18n (see below).
6. **i18n: en, de, es.** English is the source of truth and the fallback chain is
   `[requested] -> en`. All three locales ship with identical key sets; a missing key in any
   locale is a test failure. No hardcoded UI strings in components.
7. **Network discipline.** Exactly TWO modules are allowed to use `fetch`:
   `web/js/sync.js` (same-origin `/api/vault/...` only) and `web/js/push.js` (same-origin
   `/api/push/...` only). Every other module stays network-free. Nothing that leaves the
   device is ever plaintext; what push sends is a browser-issued endpoint URL and one hour,
   never a title, a note or a node id.
8. Every file starts with a short comment block: what it does, what it deliberately does not do.

## Data model (stage 1)

```js
/** @typedef {Object} Node
 * @property {string} id            crypto.randomUUID()
 * @property {string|null} parentId null = root node (the ten)
 * @property {number} rank          order among siblings, ascending
 * @property {string} title         plain text, no markdown
 * @property {string} note          plain text, no markdown
 * @property {"open"|"doing"|"done"|"parked"} status
 * @property {number|null} impact       1..5
 * @property {number|null} confidence   1..5
 * @property {number|null} effort       1..5
 * @property {number|null} due          epoch milliseconds
 * @property {number|null} effortMinutes
 * @property {string} doneWhen      definition of done, plain text
 * @property {"manual"|"llm"} origin
 * @property {boolean} llmOptout    inherited by all descendants
 * @property {number} createdAt     epoch ms
 * @property {number} updatedAt     epoch ms
 * @property {number|null} deletedAt tombstone; the node stays around for merging
 */

/** @typedef {Object} Doc      the complete vault content
 * @property {1} schema
 * @property {Node[]} nodes
 * @property {Object} settings  free-form, e.g. { lang: "en", theme: "dark" }
 */
```

### Schema 2 (stage 2, story layer)

```js
/** Node gains:
 * @property {string} story         the story behind the goal - plain text, no markdown
 * @property {string[]} entityRefs  ids of linked entities
 */

/** @typedef {Object} Entity   the private context index
 * @property {string} id
 * @property {string} name
 * @property {string[]} aliases
 * @property {"person"|"place"|"org"|"topic"} kind
 * @property {string} relation      one line: "my daughter, 14" - plain text
 * @property {string} notes         history, agreements, sore points - plain text
 * @property {"normal"|"high"} sensitivity  high = only ever shown to an LLM after explicit release
 * @property {number} createdAt @property {number} updatedAt @property {number|null} deletedAt
 */

/** Doc (schema 2): { schema: 2, nodes, entities, settings } */
```

- Migration: a schema-1 doc is upgraded in memory on open (`schema: 2`, `entities: []`,
  missing node fields defaulted). One-way, invisible, no data touched otherwise.
- `mergeDocs` applies the same per-item rule to `entities` as to `nodes`.
- **Name detection** is a plain local scan (capitalised words in title/story matched against
  entity names/aliases; unknown recurring names produce a quiet inline hint to add a card).
  Never a modal, never a network call, never an LLM.
- **Story guide** (the no-LLM interview): fixed prompts - why does this matter now, what was
  already tried, what typically gets in the way, how will you know it is done - whose answers
  are appended to `story` / `doneWhen` with plain labels. No new schema.
- **Story-depth marker**: a silent 0..1 derived from presence of story, doneWhen, entityRefs,
  note (weights .4/.2/.2/.2). Subtle visual mark only, hideable via settings; it never nags.
  Rendered as a small ring (`dom.depthMark`) in the mono rail of a row, in the focus hero head
  and next to the leaf title; hidden when `settings.storyDepth === false` (default on).
- **Story UI**: `story` sits above everything measurable on the leaf screen and as its own
  field in the editor sheet. The guide lives in `ui/storyguide.js`, the index and its two
  sheets in `ui/entity.js`; route `entities` in app.js SCREENS, reachable from settings, the
  entity chips and search results.
- `exportPlaintextMarkdown` writes the story of a node under a `story:` line, indented.

## Today & the daily question (stage 2)

- **Today screen** (`web/js/ui/today.js`, route `today`): `model.todayList` (rule fixed
  above), reachable from a "Today" button in the outline header and via Cmd/Ctrl+T; a quiet
  list, max 7, nothing else. Rows are the ordinary `rows.js` rows with `opts.path` set, so
  swipe-right-done works here too.
- **The path rule.** A step torn out of its tree is named by its WHOLE chain, root goal
  first, joined by `ui/format.PATH_SEPARATOR` (` › `, the breadcrumb voice the focus crumb
  and the search results already speak) via `ui/format.pathLine(ancestors)`. Never shortened
  in the middle - that is exactly the part that says which goal a step called "M&V" serves -
  and it wraps rather than ellipsing. It is carried by the Today row sub-line (`.row-path`)
  and by the question card (`.qcard-path`, under the node name); a root goal has no path and
  gets no line. All of it is user plaintext and goes through text nodes only.
- **The due phrase carries the colour.** In a row sub-line the due part - and only that part,
  never the whole row - is a `.row-due` span in the accent: `is-overdue` (whole accent, a
  notch heavier) or `is-today` (the same hue pulled back), chosen by `model.dueGroupOf`, so
  the colour can never disagree with the badge or the list. Plural forms are separate keys
  (`leaf.overdueOne` beside `leaf.overdue`) - "1 Tage überfällig" was wrong in all three
  languages.
- **The outline due hint** (`ui/outline.js` `dueHint`, key prefix `outline.due.`): when
  `model.dueCounts` reports anything overdue or due today, one mono line in the accent sits
  between the header and the ten - "1 step overdue · 2 due today", each group omitted at
  zero, singular keys of their own - and opens the Today screen. A hint, not a banner: no
  icon, no plate, nothing that outshouts rank one. With nothing due it is **absent from the
  DOM**, not hidden.
- **`web/js/questions.js`**: a catalogue of 16 calm coaching questions (i18n keys, all three
  locales; each question carries a short label its answer is filed under). The daily question
  picks deterministically (`dayKey` YYYYMMDD + the open node with the thinnest `storyDepth`,
  ties by root rank then own rank then age then id); the answer is appended to that node's
  story as a labelled line. `settings.dailyDismissed` (YYYYMMDD) puts it away until tomorrow.
  Works fully offline, no LLM, no randomness.
- **Web push** (optional, off by default, requires sync enabled + browser permission):
  - `GET  /api/push/vapid` -> `{ publicKey }` (server generates its VAPID P-256 pair once,
    stored as `vapid.json` in the data dir; ES256 JWT signed with WebCrypto -
    `globalThis.crypto.subtle`, no `node:crypto` import, no third-party dependency).
    The pair is a SIGNING key for push identity only - it can decrypt nothing.
  - `POST /api/push/subscribe` `{ syncId, sub, hourUtc }`, header `X-Sync-Token` (checked
    against the stored token hash) -> 204. Max 5 subscriptions per syncId (the 6th gets 429),
    stored as `push.json` beside the vault record, atomically. Only `sub.endpoint` is kept -
    the subscription's encryption keys are deliberately dropped.
  - `POST /api/push/unsubscribe` `{ syncId, endpoint }`, same auth -> 204.
  - `POST /api/push/dispatch` runs a round now; loopback only (operator/test trigger).
  - The server sends an **empty** push (no payload) once daily per subscription at
    `hourUtc` - a `setInterval` every 5 min, `lastSentDay` per subscription, and a 404/410
    from the push service removes it. This is the ONE outbound call in the whole system.
  - The service worker shows a static localised "your question is waiting" notification and
    never reads `event.data`; the locale sits in its own `tenfold-locale` cache entry,
    written by the app on every locale change. `notificationclick` opens `./?view=today`,
    which the app consumes once and strips from the URL.
  - Client: `web/js/push.js` (see rule 7), settings row "Daily reminder" inside the sync
    group, honest about iOS needing the installed home-screen app.
  - **Asked at vault creation, never left to the settings.** Nobody goes looking for a
    reminder later, so the first run asks - see the setup flow below - and the once-only
    bookkeeping is `doc.settings.pushOffered`: written by BOTH answers, sealed immediately
    (`setSettings(patch, { now: true })`), travelling with the vault, so no device asks twice.
  - **`push.usableHere()` / `push.remindableHere()`** decide where the question is worth
    asking. Both rest on one overridable probe (`installedHere()`, `setInstalledProbe()` -
    `navigator.standalone` or `display-mode: standalone`): on Apple platforms a tab receives
    nothing, so `usableHere()` is false there and the setup step says so instead of prompting
    for nothing; `remindableHere()` additionally gates the after-unlock offer to the installed
    app.
  - **The one-time offer** (`ui/pushoffer.js`, `offerPush()` in app.js, called from
    `offerAfterUnlock()`): on an unlock in the installed app, with sync on, no subscription
    running and no `pushOffered` recorded, ONE sheet asks the same question with the same
    words and the same enable path. Ordering is a rule: the share import is offered first, the
    reminder only if that left the screen empty, and the espresso question (see the tip jar)
    after both - never over the About intro, never over another sheet. Closing with the X
    settles nothing (the share rule), both buttons settle it for ever.

#### Two transports, one reminder

The daily reminder has two ways of arriving, and which one is in use is decided in
`web/js/push.js` and nowhere else. No screen knows the difference: the settings row, the
setup step and the one-time offer sheet call the same `ctx.push.enable/disable/refresh`
either way. The day that stops being true, the feature has two designs.

| | **Web push** (a browser) | **Local notification** (the native shell) |
|---|---|---|
| Scheduler | the server, once daily per subscription | `UNUserNotificationCenter` on the device |
| Needs sync | **yes** - the write token is what proves a subscription belongs to that vault | no. Nothing leaves the phone, so there is nothing to authorise |
| Network | `GET /api/push/vapid`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe` | **none.** No VAPID key, no `/api/push` call of any kind |
| Where the sentence comes from | the `NOTICE` table in `web/sw.js` (a worker cannot import a catalogue) | `push.notice.title` / `push.notice.body`, handed to the shell at schedule time |
| Permission words | `default` / `granted` / `denied` | `notDetermined` / `granted` / `denied`, mapped onto the three above |

- **The gate is a capability, not a platform.** `web/js/shell.js` looks for
  `window.__tenfoldShell` and asks whether it advertises `"reminder"`. A shell build without
  it falls back to the browser path rather than posting into the void, and a plain browser
  never sees any of this. The capability names are duplicated in
  `tenfold-ios/Sources/Bridge/ShellBridge.swift` - two repositories, no shared import - and
  pinned literally by `tests/shell.spec.js` on this side and the bridge's unit tests on the
  other.
- **The shell branch never touches `ctx`.** It reads no vault, derives no token, and makes no
  request. A test asserts that no `/api/push/*` fetch happens in shell mode, by spying on
  `fetch` itself rather than intercepting the route: the contract is that the app does not
  *ask*, not that the request fails.
- **The sentence travels, the catalogue does not.** The shell holds no strings. It is handed
  two finished lines - `"tenfold"` and `"Your question is waiting."` in the current language -
  because a catalogue in a second repository on a second release cycle would drift the first
  time either side was touched. They are the same two lines `sw.js` shows on the web, and both
  are content-free by construction.
- **A refused prompt is not a new failure mode.** The shell answers `permission: "denied"` and
  `push.js` throws the existing `PushError("denied")`, so the person sees the sentence they
  would have seen in a browser. One shell-specific code exists, `push.error.shell`, for the
  case where the native side does not answer at all; everything the *feature* can do wrong
  already had a word.
- **`usableHere()` and `remindableHere()` answer true in the shell** regardless of
  display-mode or user-agent. A `WKWebView` reports no display-mode, so the installed-app
  probe would call the one certainly-installed context a browser tab; and the shell is the
  installed app by construction. `setInstalledProbe()` still overrides everything, so the
  tests keep their seam.
- **`push.js` is still one of exactly two modules allowed to touch the network** (rule 7).
  The shell path adds no third: it removes network from the reminder entirely.

## The ranked ten: three tiers, and the height budget

Importance on the ten is shown as **three bands, not as a gradient**. A per-rank slope of
about four percent a step shipped and was reported invisible on a phone at arm's length; the
answer is a step the eye can name.

- **Tier 1** = rank one: the lead, tallest row, display weight, accent chip, the loudest
  plate. **Tier 2** = ranks two and three: mid height, mid title, the rank figure at full
  contrast. **Tier 3** = rank four and below: compact, smaller title, a pale and smaller
  figure. `rows.js` writes the class (`is-tier1|2|3`) from the rank index in `nodeList`, and
  **only where it also sets the rank figures**: a sublist, Today and the search results have
  no bands. Each band moves height, title size and figure size together, so the edge survives
  in `register` and `breath`, which have no plate to draw one with. The per-skin values are
  the nine `--tier*` tokens in `tokens.css`; `app.css` names no size of its own.
- The **background ramp stays underneath as the quiet echo**, still loud-to-quiet rank by
  rank, still normalised to the length of the list actually present (`--rank-last`, set on
  the `ul`). The old per-rank title shrink (`--row-title-step`) and the per-rank opacity fade
  (`--rank-fade`) are **gone**: opacity is now one value per band, and a title no longer gets
  smaller merely for standing further down in a list that is not the ten.
- **The height budget is part of the design.** Ten one-line goals must stand on a 390x844
  phone with rank one and rank ten both fully visible and nothing to scroll: about
  58 + 2x46 + 7x36 plus gaps, ~456 px, inside the ~570 px the header and the bar leave over
  (the photo link used to take a row of that budget and no longer does; see below). That budget is what holds tier 3 at nine pixels of padding. **A title that
  wraps to two lines may push past it, and that is the only thing allowed to.** Nothing here
  truncates a goal to make the sums work.
- **Fewer goals use the space.** `--tier-scale` (padding and gap) and `--tier-type` (type and
  figure) are derived from `--rank-last` on `.list.is-ranked`, so a five-goal list relaxes
  proportionally instead of huddling at the top. Ten is the tight end of that scale, not the
  norm.
- **Done and parked keep their treatments layered on top of the band**: a done row in tier 2
  sits at tier-2 size with done styling. They are written after the tier rules because they
  tie with them on specificity, and that order is a rule, not a coincidence.

**The cap at the button.** With **ten living top-level goals** (living = not tombstoned; done
and parked still hold their place until the next paper ritual) the outline's "New entry"
button carries the real `disabled` attribute and the ordinary `.btn[disabled]` styling.
Anything that brings the count back under ten enables it on the next repaint. This is the
**only** gate: a pasted outline, a shared note filed from another app and a merge from another
device can each still land an eleventh entry. A list longer than ten renders correctly: it
scrolls, which is exactly what the fit budget stops being able to promise beyond ten.

## Row gestures (`web/js/ui/rows.js`)

One row owns three direct manipulations, told apart before anything moves: past `SWIPE_START`
horizontally it is a swipe, past it vertically the list scrolls, and a press held for
`LONG_PRESS_MS` without either lifts the row for reordering. A swipe right past `SWIPE_COMMIT`
finishes a step (leaves only); **a swipe left past the same distance deletes the node through
`ctx.deleteNode`, the identical call the row menu's Delete makes, so it tombstones the whole
subtree, asks for no confirmation on any node kind, and the undo toast is the only safety net
on both paths alike.** The layer behind the row carries both affordances (the check on the
left edge, the trash on the right in the danger register) and lights the one the finger pulls
towards. Every list built from `nodeRow`/`nodeList` (the ten, a focus screen's parts, Today)
gets both swipes; the duel screen has gestures of its own and none of this. Under
`prefers-reduced-motion` a commit lands without the spring and without the collapse.

## Sheets, and the keyboard (`web/js/ui/sheet.js`)

One sheet at a time, built in one place. Every modal surface in this app - the story guide,
the editor, the pairing sheet, the copy loop, the entity sheet - goes through `openSheet`, so
anything true of a sheet is written once and inherited rather than repeated per feature.

**The keyboard is the sheet layer's problem, not the feature's.** Owner report: *"Click auf
Tell the Story - Eingabefeld taucht hinter Keyboard auf. Ich muss rauf scrollen."* On iOS the
software keyboard is drawn OVER the page instead of shrinking the layout viewport, so a sheet
pinned to the bottom keeps sitting exactly where the keys now are. While a sheet is open,
`sheet.js` listens on `visualViewport` `resize` and `scroll` and sets `--kb-lift` on the panel:

```
lift = clamp(window.innerHeight - visualViewport.height - visualViewport.offsetTop)
```

- **`offsetTop` counts.** iOS scrolls the visual viewport down over the layout one to "reveal"
  a focused field; what is covered is then what is left below it, not the raw height difference.
- **`KEYBOARD_MIN` (60px) is a floor.** A toolbar sliding away is not a keyboard, and without
  the floor the sheet would twitch every time the address bar breathed.
- **`MAX_LIFT_RATIO` (0.75) is a cap**, so a wrong number cannot fling the sheet off the screen.
- The sheet's `max-height` shrinks by the same amount, so a lifted sheet keeps its own head
  inside the frame and its body scrolls instead.
- After a lift the focused control is scrolled into view with `block: "nearest"` **inside the
  sheet body only**. The frame is `overflow: clip` on purpose: nothing may slide the whole app
  to reveal a field.
- **Released on close**, and by the keyboard's own disappearance - the hide fires a resize, the
  lift computes to 0 and the sheet rides back down on the transition it already had.
- **Guarded**: a browser without `visualViewport` gets no listener, no transform and no lift -
  byte-identical behaviour to before. Under `prefers-reduced-motion` the sheet does not animate.
- `web/index.html` carries `interactive-widget=resizes-content` in the viewport meta: where it
  is understood (Chromium, Android) the layout viewport shrinks by itself and the lift computes
  to 0. Safari ignores it, which is the case the lift exists for.

`liftFor(layoutHeight, viewportHeight, offsetTop)` is exported and pure, and `tests/keyboard.spec.js`
checks it directly plus the wiring against a mocked `visualViewport`. **A real iOS keyboard
remains a device check** - no desktop browser raises one.

## The two outside surfaces: app badge and share target

Everything else in this app only exists while it is open. These two are visible
from outside it: one writes on the icon, one lets another app write into it.
Both are therefore specified here down to what they are allowed to know.

### App badge (Badging API)

- **The rule.** The badge shows the number of **open leaves that are overdue or
  due today**, exactly the two groups `model.todayList` ranks first, counted
  **without** its cap of seven. There is one implementation, not two:
  `model.dueNowCount(nodes, opts)` and `todayList` share the same `openLeaves`
  filter and the same `dueGroupOf` step, so the icon can never claim something
  the Today screen denies. `web/js/badge.js` owns no rule of its own; it asks
  model.js and hands the number on. `dueNowCount` is the sum of
  `model.dueCounts(nodes, opts)` -> `{overdue, today, total}`, the same
  primitive the outline hint splits its line by: one count, two readings.
- **Content-free by design.** A count, never a title, never a date. It is the
  one thing this app says while the vault is locked, so it says a number.
- **Update points** (`web/js/app.js`): `scheduleSave()`, the funnel every
  mutation already passes through, so status and due changes land immediately
  rather than 600 ms later with the sealed write; `openWithMasterKey()`, the
  first correct count of a session, whichever envelope opened the vault;
  `syncCtx.applyMerged()`, because a merge is a change to the list like any other.
  No event bus was invented for this.
- **The lock does NOT clear it.** Deliberate, and the point of having a badge:
  the count is content-free, and a badge that vanishes the moment the app locks
  (which it does after 15 minutes, and on every reload) would never be seen.
  What DOES clear it is `wipeLocalVault()`: after a wipe the number would
  refer to a list that no longer exists on this device.
- **The service worker badges in FLAG mode.** On a push it calls
  `setAppBadge()` with **no argument**: the worker holds no key, so it cannot
  count anything, and it says "there is something" instead of a wrong number.
  The next open corrects it to a real count.
- **Everything is guarded twice**: `navigator.setAppBadge` does not exist in
  most desktop browsers and rejects where the app is not installed. Absent or
  refused is a no-op, never an error and never a broken session.
- **No setting.** This surface is quiet and content-free; there is nothing to
  configure.

### The home-screen widget (native shell only)

A third outside surface, and the most exposed one: a widget is drawn by a process that has
no key, sits on a home screen anybody standing nearby can read, and is rendered while the
vault is locked and the app is not running. It is therefore specified by what it may NOT
know, first.

- **Counts only, unless the person switched the title on.** The default message is
  `{type: "widget.state", due: <number>, questionWaits: <boolean>}` - three keys - and with the
  opt-in on it carries a fourth, `topTitle: <string>`. `tests/shell.spec.js` pins both shapes
  exactly, so a fifth field breaks a test rather than shipping. No question text, no note, no
  date, no name of a person. The widget draws the number and, when the question is waiting, one
  fixed line saying so.
- **The opt-in title is the one deliberate exception in the whole app to "no goal text leaves
  the vault".** It is worth stating what makes it defensible rather than merely allowed:
  - **Off by default**, and it is a setting inside the vault (`doc.settings.widgetTitle`), so
    the decision travels with the document to every device and there is one place to look for
    the answer. Not a native switch: that would be a second source of truth for the single
    setting that moves text out of the encryption.
  - **The row only exists where a widget does** - `badge.widgetSupported()`, i.e. a shell that
    advertises the `widget` capability. In a browser the group is absent, not disabled.
  - **It says what it does**: `settings.widgetTitleWarn`, in all three catalogues, states that
    the name sits outside the encryption on the home and lock screen, readable without the
    passphrase.
  - **Rank 1 only, title only.** `badge.topTitle(doc)` reads `model.childrenOf(nodes, null)[0]`
    - the same ordered list the outline draws - takes its `title`, trims it, and caps it at
    `WIDGET_TITLE_MAX` (80). Never a note, never a child, never the daily question.
  - **Turning it off clears it.** The absent field IS the clear: the shell stores the whole
    state in one value, so the next `widget.state` without `topTitle` leaves no title in the
    App Group. Changing the setting goes through `setSettings` -> `scheduleSave` -> `setBadge`,
    so the home screen changes in the same tick as the switch.
  - **A lock does NOT clear it**, exactly like the badge count, and for the same reason: a
    person who put their top goal on the home screen asked for a surface that is there when the
    app is not. tenfold locks after fifteen minutes and on every reload, so a title that
    vanished with the lock would be blank almost all of the time - which is not the feature
    they turned on. What clears it is switching it off, and `wipeLocalVault()`, which calls
    `badge.clearWidgetState()` because after a wipe there is no next save to correct the
    home screen with.
- **`due` is the badge count**, from the same `badgeCount()` call in the same tick as the
  icon. One rule (`model.dueNowCount`), three readers: the Today screen, the icon and the
  widget. They cannot disagree.
- **`questionWaits` is derived, not stored.** `badge.questionWaits(doc, opts)` asks
  `questions.dailyQuestion(nodes, {dismissed: settings.dailyDismissed})` and returns whether
  it produced anything - which is precisely the condition under which the Today screen shows
  the question. No second flag was added: a flag would be a second rule, and the widget could
  then claim the question waits while the screen shows it answered.
- **Sent whenever the badge is, and independently of it.** `setBadge()` feeds the widget
  first and does so even where no icon badge is possible, because a shell might offer one
  capability and not the other. Fire and forget: a save path must never wait on a home screen.
- **The badge itself crosses the same bridge** where `navigator.setAppBadge` is missing, as
  `{type: "badge.set", count: <number>}`. Zero means "take it away" - one message, one
  meaning, rather than a second verb that could be reached in one direction and not the other.
- **Nothing here is gated on sync.** Both messages are local facts about a local list.

### Share target (Android/Chromium, installed PWA)

`manifest.webmanifest` declares `share_target`: `action: "./share"`,
`method: "POST"`, `enctype: "multipart/form-data"`, params `title`/`text`/`url`.
iOS has no share target and ignores the whole block. That is fine, nothing
else changes.

- **POST is the privacy argument, not a detail.** With GET the shared text
  would be query parameters, and the address bar, the history and any
  screenshot of either would hold it. With POST it travels in a body and the
  URL of the app stays clean. A test asserts that `location.search` is empty
  after a share arrives.
- **The worker catches it** (`web/sw.js`): the one POST it answers is the share
  path (registration scope + `share`). It reads the form, parks
  `{title, text, url, ts}` in a Cache bucket of its own (**`tenfold-share-inbox`**,
  never IndexedDB, never beside the vault) and answers `303` to the app root,
  so the browser turns the POST into a plain GET. **One item at a time: the
  newest share overwrites the previous one (latest wins).** A share carrying
  nothing readable is dropped instead of parked.
- **The honest part: this item is PLAINTEXT.** A service worker has no key and
  cannot have one (that is the design, not an oversight), so it cannot encrypt
  what it receives. The window is from the moment of sharing until the next
  unlock. Then the app either files the text into the sealed vault or drops it,
  and the bucket is deleted either way. It is also deleted on `wipeLocalVault`.
  It deliberately **survives a worker activation** (like the locale entry), or
  an update landing between share and unlock would eat something a person
  deliberately sent here.
- **If no worker is in control** (fresh install, a browser that dropped it) the
  POST reaches `tools/serve.js`, which discards the body **unread** (not
  parsed, not buffered, not written, not logged) and redirects to the app.
  What the browser already put on the wire cannot be unsent; what the server
  can decide is that nothing is done with it. This is the one case in the whole
  design where user text reaches the server, and it is written down rather than
  hidden.
- **After unlock** (`offerShare()` in app.js, called from `enterApp` and
  `finishIntro`, never over the first-run intro) `ui/shareimport.js` offers a
  sheet showing the text that arrived and the only question that matters: where
  does it belong. The targets are "Add to the ten" (subject to the ten-root rule)
  and one row per goal. Filing it calls `ctx.addSharedNode`, which creates an
  ORDINARY node through the normal mutate path with `origin: "manual"`: the
  shared title (or the first line of the text, or the link) becomes the title,
  everything left over plus the link becomes the note, nothing that arrived is
  dropped. Discarding empties the bucket. Closing the sheet with the X settles
  nothing; the item stays parked and is offered again at the next unlock.
- Strings live under the `share.` prefix in all three catalogues.

**On iOS the share sheet feeds the same inbox.** There is no share target to register, so the
native shell carries one instead: a Share Extension accepts text and web URLs, writes
`{title, text, url, ts}` into an App Group slot (**one slot, latest wins**, the same rule as
the Cache bucket) and never launches the app. When the app next becomes active the shell hands
that item to the page as `{type: "share.incoming", …}`; `shareinbox.stashShare()` parks it in
the **same** `tenfold-share-inbox` bucket under the same key, and from there it is the path
above - the post-unlock offer sheet, `shareToNode`, the wipe on import, on dismissal and on
`wipeLocalVault`. One implementation, two platforms; nothing downstream knows which one it is
running on.

Two details that are not decoration:

- **The bucket key is https even where the origin is not.** `shareKey()` builds the key from
  `location.origin` on the web, and falls back to a fixed
  `https://shell.tenfold.invalid/tenfold-share-inbox` on any other scheme. Not a preference:
  `cache.put()` rejects with a `TypeError` unless the request URL's scheme is http(s), and the
  shell's origin is `tenfold-app://app` - measured, in `tenfold-ios/docs/DECISIONS.md` D12. The
  host is in the reserved `.invalid` TLD and is never fetched.
- **The app tells the shell when the item is parked**, with `{type: "share.stored"}`, and only
  that empties the App Group slot. Receiving is not storing: parking is a Cache write and a
  Cache write can fail (see the previous point, which is exactly how it failed the first time).
  A share that could not be parked is not acknowledged, so it stays in the slot and is offered
  again at the next launch instead of vanishing. The plaintext window is the same honest window, from the moment of sharing until
the next unlock, with one extra leg at the front: the App Group slot is plaintext too (an
extension holds no key and cannot be given one), and the shell wipes that slot the moment the
page confirms it has the item - and only then, so a page that has not finished booting costs a
retry rather than somebody's note. A vault wipe clears the slot as well, since the wave that
brought the fourth wrapper: `vault.wiped` (below) is the first message that tells the shell the
vault is gone, and clearing the share slot is one of the three things it does. What bounds the
slot in between is that it only ever holds a single share somebody made deliberately, and the
next share overwrites it.

## `web/js/crypto.js` (BUILT, do not change without updating its tests)

```js
export const MAGIC = "TENFOLD1";

// Creates a new vault: random 256-bit master key, wrapped in envelopes.
// Also returns the masterKey so the caller does not pay another PBKDF2 run.
export async function createVault({ passphrase }): Promise<{ vault, recoveryKey, masterKey }>

// Opens a vault with one of the envelopes. Throws VaultUnlockError on a wrong secret.
export async function unlockWithPassphrase(vault, passphrase): Promise<CryptoKey>
export async function unlockWithRecoveryKey(vault, recoveryKey): Promise<CryptoKey>
export async function unlockWithRawKey(vault, wrapKey /* ArrayBuffer */): Promise<CryptoKey>

export async function unlockWithShellBioKey(vault, wrapKey /* 32 bytes from the shell */): Promise<CryptoKey>

// Add/remove envelopes later (enrol Face ID, revoke a device)
export async function addRawKeyWrapper(vault, masterKey, wrapKey, label): Promise<VaultFile>
export async function addShellBioWrapper(vault, masterKey, wrapKey, label): Promise<VaultFile>
export async function removeWrapper(vault, label): Promise<VaultFile>

// The vault file's own name, for anything outside the vault that has to point at it.
export function newVaultId(): string                  // 16 random bytes, base64url, 22 chars
export function vaultId(vault): string|null           // null for a vault made before this existed
export function withVaultId(vault): VaultFile         // mints one only if there is none

// Content <-> blob. seal() frames MAGIC|version|alg|nonce|ct with the header as AAD.
export async function seal(masterKey, doc): Promise<Uint8Array>
export async function open(masterKey, blob): Promise<Doc>

// Convenience pair used by the app: puts the sealed blob into vault.payload / reads it back.
export async function sealIntoVault(vault, masterKey, doc): Promise<VaultFile>
export async function openFromVault(vault, masterKey): Promise<Doc>

// Rotate the master key (after device loss). Drops all raw wrappers.
export async function rotateMasterKey(vault, oldMasterKey, { passphrase }): Promise<{ vault, recoveryKey, masterKey }>
```

- KDF: PBKDF2-SHA256, 600000 rounds, 16-byte salt, WebCrypto.
- Cipher: AES-256-GCM, 12-byte nonce, never reused, fresh per seal().
- Per-wrapper AAD: the wrapper's own metadata (magic, version, id, kind, label, kdf, nonce), so
  parameter tampering fails the GCM tag check.
- `VaultFile` is JSON-serialisable: `{ magic, version, vid, wrappers[], payload }`, with binary
  parts base64url. No top-level `settings`/`nodes`/`doc` key, ever (store.js rejects those).

### The wrapper registry

Four kinds, and every one of them alone releases the master key. The `kind` string travels
inside the AAD, so a wrapper cannot be rewritten as another kind and still open.

| `kind` | secret behind it | KDF | HKDF `info` | label | dropped by `rotateMasterKey` |
|---|---|---|---|---|---|
| `passphrase` | what somebody types | PBKDF2-SHA256, 600000 | - | `passphrase` | rebuilt |
| `recovery` | the printed key, 137 bits | PBKDF2-SHA256, 600000 | - | `recovery` | rebuilt |
| `raw` | WebAuthn PRF output, `SHA-256`-reduced to 32 bytes | HKDF-SHA256 | `tenfold/raw-wrap/v1` | `webauthn:<credIdPrefix>` | yes |
| `shell-bio-v1` | 32 bytes the native shell keeps in the Keychain behind the current biometric enrolment | HKDF-SHA256 | `tenfold/shell-bio/v1` | `shell-bio:<12 random chars>` | yes |

**Biometry is never a fourth way *back* in.** Neither of the two biometric wrappers is a
recovery path: both are a shortcut past one passphrase field on one device that is already in
somebody's hand. The Keychain item behind `shell-bio-v1` is `WhenUnlockedThisDeviceOnly`, is
never synchronisable, has no export and no backup path, and dies when the enrolled face
changes. A new phone starts with the passphrase or the recovery key, exactly as on the web -
and those two remain the only things that recover a vault.

### The vault's own identifier (`vault.vid`)

16 random bytes, base64url, 22 characters, matching `[A-Za-z0-9_-]{1,64}` because that is what
the native shell accepts. Written at `createVault`, carried through every save and through
`rotateMasterKey` (the file is the same file; only its key changed), minted on demand by
`withVaultId` for a vault that predates it.

- **Not the sync id.** That one exists only where sync was switched on, and the shell has to be
  able to name a vault that has never talked to a server.
- **Not inside the payload.** It is read with the vault still locked - the lock screen needs it
  before anything is decrypted.
- **Not a secret**, and not derived from anything: it wraps nothing, unlocks nothing, and is
  worth exactly as much as a filename. It is metadata beside the wrappers, so a sync server sees
  it in the same way it already sees the sync id.
- Recovery key: 7 groups of 4 from a confusable-free base32 alphabet (137 bits), input
  normalisation tolerates case, hyphens, spaces.

### Biometric unlock (WebAuthn PRF): `web/js/webauthn.js`

Touch ID on a Mac, Face ID on an iPhone, Windows Hello, an Android screen lock: the
platform authenticator becomes **one more envelope on the vault**, using the raw-key wrapper
prepared in wave 1. It is the answer to "a reload locks the vault immediately": reload,
one touch, back in. The passphrase path never goes away.

```js
export function supported(): boolean               // PublicKeyCredential + credentials.create/get
export async function platformAvailable(): boolean // isUserVerifyingPlatformAuthenticatorAvailable
export function platformAvailableCached(): boolean|null   // null = not asked yet
export function enrolled(vault): boolean           // local pointer AND matching wrapper in the vault
export function wrapperLabel(): string|null
export async function enrol(vault, masterKey): Promise<VaultFile>  // caller saves
export async function unlock(vault): Promise<CryptoKey>
export async function revoke(vault): Promise<VaultFile>            // caller saves
export function forget(): void
```

- **Derivation.** `credentials.create` with a platform authenticator, `residentKey: "preferred"`,
  `userVerification: "required"`, `attestation: "none"`, extension `prf.eval.first = <32 random
  bytes, per vault>`. The PRF output is reduced by one fixed step (`SHA-256(prf.first)` → 32
  bytes) and handed to `addRawKeyWrapper(vault, masterKey, bytes, "webauthn:<credIdPrefix>")`,
  which runs HKDF over it again. `unlock` repeats the same evaluation through
  `credentials.get` and calls `unlockWithRawKey`. If `create()` returns no PRF results, one
  immediate `get()` is tried (some platforms only evaluate on assertions); if that is empty too,
  the device is reported unsupported and **nothing is enrolled**.
- **What is stored.** `localStorage["tenfold.webauthn"] = { credentialId, salt }`, two
  device-local, non-secret pointers. Nothing key-like: without the authenticator and the user
  verification it insists on, they derive nothing. **The master key never touches storage**;
  the PRF output is recomputed from the hardware on every unlock and never cached.
- **No personal data, no server.** The credential's user handle is the fixed opaque string
  `"tenfold"`: no name, no address, no account. There is no relying party to verify the
  assertion; the challenge is fresh random and unverified, because this is a key derivation
  gated by a fingerprint, not an authentication handshake. No `fetch` in this module.
- **Sync.** The wrapper travels inside the VaultFile, so it reaches other devices; the
  credential does not. Every device enrols its own, and labels are per credential
  (`webauthn:<first 12 chars of the base64url credential id>`), so revoking on device A leaves
  device B's wrapper alone. Re-enrolling the same credential replaces its own envelope instead
  of colliding with it. `rotateMasterKey` drops all raw wrappers, as documented above.
- **UI.** Settings → Security carries one row with a neutral label (`webauthn.title`,
  "Unlock with face or fingerprint", since naming Face ID would be wrong on half the devices
  that can do this); the row only exists where the platform reports a user-verifying platform
  authenticator. The lock screen shows the biometric button **above** the passphrase field
  whenever this device is enrolled, and fires it once automatically on arrival. A cancelled or
  failed prompt is silent (no banner, no counter) and leaves the passphrase field focused.

### Biometric unlock in the native shell: `web/js/bio.js`

There is no WebAuthn in a `WKWebView`, so on iOS the section above does not exist and somebody
types their passphrase every single time. The shell answers that with a key of its own, and
this module is the web half of it. `webauthn.supported()` returns **false inside the shell** by
an explicit branch, so the two paths can never both be on offer: one screen, one biometric row,
whichever one can work.

```js
export const MSG_AVAILABLE = "bio.available";   // pinned literally; see the bridge
export const MSG_CREATE    = "bio.createKey";
export const MSG_UNWRAP    = "bio.unwrapKey";
export const MSG_DELETE    = "bio.deleteKey";
export const MSG_WIPED     = "vault.wiped";
export const CODES = ["cancelled", "lockedOut", "invalidated", "missing", "failed"];

export function supported(): boolean              // a shell that advertises the `bio` capability
export async function available(): {available, enrolled, biometryType}   // the device, right now
export function availableCached(): Object|null    // null = not asked yet
export function enabled(vault): boolean           // local pointer AND matching wrapper in the vault
export function wrapperLabel(vault): string|null
export async function enable(vault, masterKey): Promise<VaultFile>   // caller saves
export async function unlock(vault, reason): Promise<CryptoKey>      // throws BioError{code}
export async function reconcile(vault): Promise<VaultFile>           // caller saves if it changed
export async function disable(vault): Promise<VaultFile>             // caller saves
export async function announceWipe(vault): Promise<boolean>
export function forget(): void
```

- **The capability is a property of the device, not of the build.** The shell advertises `bio`
  only where it found biometric hardware, so a row is never drawn that can never be switched on.
  Whether anything is *enrolled* is a second question, asked with `bio.available` and answered
  while the vault is still locked: `available: true, enrolled: false` is a phone whose owner has
  not set Face ID up, and the honest line there is "do that first", not a button that fails.
- **Setup is gated on `available && enrolled`.** `bio.createKey` mints a NEW key every time and
  replaces whatever was there, so `enable()` also removes the wrapper the previous key belonged
  to - otherwise the vault would keep an envelope nothing can open.
- **What is stored.** `localStorage["tenfold.shellbio"] = { vaultId, label }`, two device-local,
  non-secret pointers. The KEK is never written anywhere by this page: it exists in the reply,
  for the length of one wrap or one unwrap, and is zeroed after use. The label is per device, so
  disabling on device A cannot revoke the wrapper device B added to the same synced vault.
- **The reason sentence comes from the page**, ready-localised (`bio.reason`), cut at 300
  characters. The shell holds no catalogue: the app's words live in one repository in three
  languages, and a copy on the other side would drift the first time either was touched.
- **The five refusals**, and what each one does to the screen:

| `code` | what happened | the web app's answer |
|---|---|---|
| `cancelled` | the sheet was dismissed, or the device passcode was asked for | nothing at all. The passphrase field is focused; the button stays |
| `failed` | anything else - no hardware, an authentication that did not succeed, a Keychain that refused, a message this side could not read | the same silence, for the same reason |
| `lockedOut` | too many failed attempts; biometry needs the device passcode first | one quiet line (`bio.lockedOut`). The button stays: after the passcode, trying again is the right move |
| `invalidated` | the key was made against an enrolment set that no longer exists | one quiet line (`bio.invalidated`) saying the passphrase is needed once. The button goes, the dead wrapper is cleaned away at the next unlock, and the re-offer is the settings row's own wording (`bio.setupAgain`) - not a sheet, not a nag, and it does not repeat |
| `missing` | there is no key for this vault | treated as off: the button goes, nothing is said, and the wrapper is cleaned away at the next unlock |

- **Cleaning is lazy and happens where a save is possible.** `reconcile()` runs inside the
  ordinary unlock path, with a master key present; a lock screen can save nothing, so nothing is
  cleaned there. It also sends `bio.deleteKey`, which makes the shell forget its "a key existed
  here" marker - so the next question answers `missing` rather than repeating that a face
  changed.
- **UI.** Settings → Security carries the same neutral row as the browser path
  (`webauthn.title`, "Unlock with face or fingerprint" - naming Face ID would be wrong on half
  the devices that can do this), and the lock screen shows the same button in the same slot
  above the passphrase field, firing once automatically on arrival.
- **The trust note, stated rather than hidden.** The KEK crosses the bridge as bytes. In the
  `WKWebView` model that is one process and one trust zone: our own document, our own origin, a
  CSP the shell synthesises, deny-by-default navigation. Anybody who can read those bytes out of
  the process can already read the unlocked master key sitting in the same process. What it buys
  is a key at rest in the operating system's key store, released only for a face, bound to the
  enrolment set that existed when it was made.

#### `vault.wiped`

```js
window.__tenfoldShell.send({ type: "vault.wiped", vaultId });   // reply: { ok: true }
```

Sent by `wipeLocalVault()` - and therefore by the delete-everywhere path, which ends in it -
**before** the vault is cleared, because the message has to name which vault died and that name
lives in the file. It is the only message that means "the vault is gone" rather than "the vault
is empty": a badge of zero is an ordinary Tuesday.

- **Not gated on the `bio` capability.** Two of the three things it clears have nothing to do
  with biometry. It is gated on there being a shell at all.
- The shell clears three things with it: the Keychain key for that vault, the widget's state
  together with the badge, and the share slot.
- The identifier is required - the shell refuses a wipe without one - so a vault that never had
  one is named with a fresh id. The Keychain delete then finds nothing, which is the outcome
  asked for, and the widget, the badge and the share slot are cleared regardless, which is the
  part that could not be skipped.

## Browser history (wave: session UX)

The browser history mirrors the in-app view stack. The wanted depth is derived, never
book-kept by hand:

```
depth = state.stack.length + (isSheetOpen() ? 1 : 0)     // the sheet guard is that +1
```

`ctx.go` pushes, `{ replace: true }` collapses the stack (and the reconciliation walks the
browser back to the new depth, so entries that can no longer be reached are not left behind),
`ctx.back` pops. A `popstate` runs the same back logic as the in-app arrow: with a sheet open
it closes the sheet, and the guard entry is exactly what that press spends; otherwise it walks
the in-app stack; at the outline root it lets the navigation leave the app.

**Nothing calls the history API directly.** Every routing change calls one `syncHistory()`,
which reconciles depth once per task in a microtask: `pushState` is synchronous, a traversal
is not, so a close-then-open pair in the same task (the row menu handing over to the editor
sheet) would otherwise push first and travel back afterwards and leave the page an entry below
where the app thinks it is. Reconciled, the pair cancels out and any number of steps costs one
`history.go(-n)`, whose popstate is suppressed. That bug was real and cost the app its DOM.

A history entry carries the screen NAME only, never a node id, because browsers persist
history state to disk for session restore. The entries are decorative anyway: routing reads
the app's own counters, never `history.state`. A reload always lands on lock/setup at depth 0,
so `#s=<code>` and `?view=today` keep working unchanged (both strip themselves with
`replaceState`, preserving the state object).

## `web/js/model.js` (BUILT): pure tree functions, no IO

```js
export function createNode(partial): Node
export function childrenOf(nodes, parentId): Node[]          // by rank, tombstones excluded
export function ancestorsOf(nodes, id): Node[]               // root first
export function descendantsOf(nodes, id): Node[]
export function isLeaf(nodes, id): boolean
export function moveNode(nodes, id, newParentId, newRank): Node[]   // throws on a cycle
export function reorder(nodes, parentId, orderedIds): Node[]
export function softDelete(nodes, id): Node[]                // tombstones the whole subtree
export function isOptedOut(nodes, id): boolean               // own flag or inherited
export function score(node): number|null                     // impact*confidence/effort
export function todayList(nodes, opts): Node[]               // rule: see plan; max 7; opts.now injectable
export function dueGroupOf(node, now): 0|1|2                 // 0 overdue, 1 due today, 2 later/undated
export function dueCounts(nodes, opts): {overdue, today, total}  // the same two groups, told apart
export function dueNowCount(nodes, opts): number             // = dueCounts(...).total (the app badge)
export function mergeDocs(a, b): Doc                         // per item, younger updatedAt wins
// stage 2
export const SCHEMA = 2
export const ENTITY_KINDS = ["person","place","org","topic"]
export function createEntity(partial): Entity
export function storyDepth(node): number                     // 0..1, presence only
export function upgradeDoc(doc): Doc                         // schema 1 -> 2, in memory, idempotent
export function createdAtOf(doc): number|null                // the vault's age anchor, see below
```

`createdAtOf` answers "when did this vault begin" as the EARLIEST evidence in the document:
`settings.createdAt` or the oldest `createdAt` on any node or entity, tombstones included,
whichever is smaller; `null` only for a document with no evidence at all. It is not
`settings.createdAt` on its own on purpose - two devices that both backfilled the stamp produce
two values and `mergeSettings` keeps the one from the document touched last, which may be the
later one. Taking the minimum means a vault can never look younger than its own content, so the
one thing that reads it (the espresso question below) errs towards asking late.

`mergeDocs`: on conflict the younger `updatedAt` wins; the losing `title`/`note`/`story` is
appended to the winner's `note` (for an entity: `name`/`relation`/`notes` into `notes`) under a
"--- divergent version ---" marker instead of being discarded. Tombstones never beat a younger
live edit. Deterministic and argument-order independent. `nodes` and `entities` follow exactly
the same rule.

`upgradeDoc` returns its input by reference when the document already is schema 2, keeps fields
it does not know about (a newer version's data is never dropped), and touches no timestamp.
Every `openFromVault` in app.js and sync.js passes through it before anything else sees the doc.

## `web/js/entities.js` (BUILT, stage 2): the context index, pure

```js
export function listEntities(entities): Entity[]             // living, by name
export function entityById(entities, id): Entity|null
export function entitiesForNode(entities, node): Entity[]
export function nodesForEntity(nodes, entityId): Node[]
export function addEntity(entities, partial, opts): Entity[]
export function updateEntity(entities, id, patch, opts): Entity[]   // no-op patch = no updatedAt bump
export function deleteEntity(entities, id, opts): Entity[]          // tombstone
export function linkEntity(nodes, nodeId, entityId, opts): Node[]
export function unlinkEntity(nodes, nodeId, entityId, opts): Node[]
export function detectNames(nodes, entities, opts): {name, count}[] // opts: locale, dismissed, minCount
export function rememberDismissal(dismissed, name): string[]        // folded, capped at 50
export function foldName(value): string
```

Dismissed names live in `doc.settings.dismissedNames` (folded, max 50), so the answer to
"who is X?" travels with the vault.

## `web/js/store.js` (BUILT): IndexedDB, ciphertext only

```js
export async function requestPersistence(): Promise<{ persisted, supported }>
export async function loadVault(): Promise<VaultFile|null>
export async function saveVault(vault): Promise<void>        // rejects plaintext-shaped objects
export async function clearAll(): Promise<void>
export async function lastSavedAt(): Promise<number|null>
```

**Only the encrypted vault ever goes into IndexedDB.** No plaintext field, no search index,
no cache. Never. `saveVault` actively rejects objects carrying `nodes`, `doc`, `plaintext`
or `settings` keys.

## `web/js/portability.js` (BUILT)

```js
export function exportEncrypted(vault): Blob            // .tenfold file
export async function importEncrypted(file): Promise<VaultFile>
export function exportPlaintextMarkdown(doc): Blob      // only after explicit confirmation
```

## `web/js/prioritize.js` (BUILT): duel state machine, no UI, no randomness

```js
export function startDuel(items): DuelState
export function currentPair(state): { a, b } | null     // null = finished
export function choose(state, winnerId): DuelState      // pure, returns a new state
export function result(state): string[]                 // ids, best first
export function progress(state): { done, estimatedTotal }
```

Binary insertion: ten items in at most 25 comparisons. No `Math.random()`, so it is reproducible.

## `web/js/search.js` (BUILT)

```js
export function search(nodes, query, opts): { node?, entity?, path, matchField }[]
```

Local, accent-insensitive, partial-word matches, relevance-ordered. No index on disk.
Fields and weights: node `title` 100, `story` 20, `note` 10; with `opts.entities` also card
`name` 100, `aliases` 60, `relation` 20, `notes` 10. A result carries either `node` or
`entity`; `matchField` names the strongest field the query touched.

## `web/js/i18n.js` (stage 1, wave 2)

```js
export const LOCALES = ["en", "de", "es"];   // en is source of truth and fallback
export function detectLocale(): string        // navigator.language -> supported locale
export function setLocale(locale): void       // persists into doc.settings via the app layer
export function t(key, vars?): string         // falls back to en; missing key returns the key
export function onLocaleChange(fn): void
```

- Catalogues live in `web/js/locales/{en,de,es}.js` as plain exported objects (ES modules,
  not JSON, so no fetch is needed and stage 1 stays network-free).
- Identical key sets across all three files, enforced by a test.
- Interpolation via `{name}` placeholders. No HTML in catalogue values, ever (XSS rule 2).

## Skins (stage 1, wave 2)

The three design directions under `design/` become user-selectable skins. One DOM structure,
one set of components; the look is carried entirely by CSS custom properties plus a
`data-skin` attribute on `<html>`:

- `slate` (**default**) is direction B: layered slabs, light edges, rank as depth
- `register` is direction A: set type, hairlines, serif stack, no boxes
- `breath` is direction C: text on black, hierarchy through size and opacity

Rules: components never hardcode colors, radii, shadows, or font stacks. Tokens only
(`--bg`, `--surface`, `--text`, `--muted`, `--accent`, `--line`, `--radius`, `--shadow`,
`--font-display`, `--font-body`, `--font-mono`). Skin-specific structural touches go through
`[data-skin="…"]` selectors in the skin file, never through JS branching. Each skin defines a
dark and a light variant (`data-theme="dark|light"`, dark default). The choice persists in
`doc.settings.skin` and is applied before first paint to avoid flashes.

### The data palette (`--data-1` … `--data-10`)

One accent per skin still governs every **control**. The accent means "you": what you
pressed, what you are on, the primary action, the focus ring. Alongside it there is exactly
one second colour system, and it means "the things": which parts belong to which goal on the
map. Nothing else in the app may reach into it.

- Ten hues at **one lightness and one chroma** in OKLCH (dark `oklch(.735 .062 h)`, light
  `oklch(.545 .075 h)`), so no family is louder than another and the chroma stays about a
  third of a normal chart palette. Only the hue moves.
- Defined per **theme**, not per skin (a data surface must not change meaning because
  somebody prefers serifs), in the block at the foot of `tokens.css`.
- Hue order walks the wheel in jumps, so two families that land next to each other on screen
  are far apart in hue. **Rank never rides on hue**: it is carried by size and by how much
  of the family colour is mixed into the body (`--rm`), so two families a colour-blind eye
  reads as similar are still told apart. Nothing on the map depends on hue alone.
- `ui/map.js` never names a colour. It writes the family **index** as a class
  (`is-fam0` … `is-fam9`) and the ladder as plain numbers (`--rm`, `--glow`, `--ink`); what
  those mean is decided in `app.css`. The one exception is the halo's `fill`, which is a
  fragment id (`url(#tf-halo-N)`) and not a colour: an SVG paint server referenced from an
  *external* stylesheet resolves against the stylesheet's URL in some engines.
- Where OKLCH is unavailable the whole palette falls back to the skin's accent, a quieter
  map, never a broken one.
- Also theme-level, and also map-only: `--map-halo-in`, `--map-halo-mid`, `--map-core`. On
  paper a halo stops reading as light and starts reading as a smudge, so it is pulled back.

## About screen (stage 1, wave 2)

A calm, readable screen inside the app (`web/js/ui/about.js`), reachable from settings and
from the lock screen; it must be readable *before* unlocking, since it explains what the
app is and what happens to the data. On the very first entry into a vault it is shown once
as an intro with a single "Begin" action (`ctx.introAbout` / `ctx.finishIntro`); after that
it never appears uninvited. Outline (v4, all through i18n, key prefix `about.`):

1. **Opening**, no heading (`intro.p1..p3`): you know what matters; it sinks in the
   everyday; it is not a question of effort but of nobody ever settling what comes first.
   tenfold holds one list: the ten things you truly want, in an honest order, broken down
   to the one step you can take tomorrow.
2. **What this looks like** (`walk.*`) walks one worked goal, end to end: "get fit" stays on
   every list because you cannot derive a Tuesday from it, so tenfold asks about the
   circumstances first; then four labelled question/answer lines (`walk.li1..li4`: what do
   you mean, what stands in the way, what works anyway, when exactly), the concrete first
   step (`walk.step`), and the point of it (`walk.p3`): a goal without context cannot be
   broken down.
3. **Exactly ten. Not twenty.** (`ten.*`): ten is a limit, not a round number; the order
   is the hard part, so the duel asks one pair at a time (at most 25 questions for ten
   entries, stoppable at any time, and the reached order stays; binary insertion, so
   contradictions cannot arise); work from the top down; done goals stay visible and the
   attention moves on, the list itself is re-decided at the next paper ritual.
4. **Where the method comes from** (`origin.*`): Raymond Hull (1919–1985), British-Canadian
   author in Vancouver; *How to Get What You Want* (1969), same year as *The Peter
   Principle*, of which he was co-author; his observation and his tool. Plus the honest
   demarcation: tenfold takes the ordered list and the writing ritual, leaves the rest of
   the book, and the limit of exactly ten is ours. Named as origin, no quoted material.
5. **Paper and app share the work** (`paper.*`). The monthly handwritten ritual stays
   (writing is the thinking), then the four things the app adds (`paper.li1..li4`):
   lossless, depth (level by level, hence the name: *ten* goals, *fold* levels), memory of
   your circumstances, confidentiality.
6. **What tenfold is not** (`not.*`): not a task manager, not a habit app, not a calendar.
7. **Privacy, and three honest limits** (`privacy.*`): encrypted on the device with your
   passphrase (PBKDF2 600k rounds, AES-256-GCM); stored and transmitted is an unreadable
   block; no accounts, no plaintext on servers; how a second device gets the block (QR
   pairing) and the two export formats. The three limits: lost passphrase *and* recovery
   key with no export file means the data is gone; an unlocked device in foreign hands;
   AI assistance as a deliberate opt-in, where the stored context travels with the goal,
   hence the recommendation to point it at your own LM Studio / Ollama server.
8. **Closing + the claim** (`close.p1`, `claim.p1`): none of this is new, and that is the
   strength; "tenfold - get what you want."

Rendering: headings are plain `h2`s, lists use the `leadItem` helper, which sets everything
up to the first colon or question mark in `strong`, built from text nodes only, never from
markup in a catalogue value (ground rule 2). The same helper renders `walk.step` as a
paragraph.

No marketing tone, no self-praise, no AI-tell phrasing. Short paragraphs, generous type.
Every factual claim on this screen must match what the code actually does.

## The tip jar (`web/js/ui/support.js`, WEB ONLY)

tenfold costs nothing and has nothing to sell, so the one place it asks for
anything is a sheet with three ways to buy the author a coffee. It is
deliberately the quietest surface in the app, and it is specified here because
it is the only screen that names an address the owner cannot afford to have
wrong.

- **Two entry points, one sheet.** A row in the settings "About this app" group,
  between About and the version, and one closing line at the end of the About
  screen, after the claim and in the muted tone. Both call
  `openSupportSheet(ctx)`. The About line is **absent during the first-run
  intro**: that screen is somebody deciding whether to trust the app with their
  goals, which is not the moment to ask them for money.
- **It does not exist inside the native shell.** `supportAvailable()` is
  `!inShell()`, and an external payment link for a tip is an App Store
  rejection. In the shell the row and the line are **absent from the DOM**, not
  disabled, and `openSupportSheet` returns null on its own, so an entry point
  added later cannot reopen the hole. The shell gets an in-app purchase of its
  own; that is a different feature and it is not this one. `tests/support.spec.js`
  asserts all three absences against a shell stub.
- **Three ways, in this order.** PayPal (`https://www.paypal.me/freshlab`) as a
  real anchor with `target="_blank"` and `rel="noopener noreferrer"`: the
  destination is visible before it is tapped, it needs no script, and `noopener`
  denies the payment page a handle on the window holding a decrypted vault.
  Then Bitcoin, then one EVM address labelled `USDT / USDC (ERC-20)`, each as a
  QR code and as selectable mono text with a copy button. The strict CSP allows
  the navigation: it governs what this document may LOAD, and a top-level
  navigation to another origin loads nothing into this page.
- **The addresses live in exactly one module**, as string constants, and are
  pinned literally by the spec, which states them a second time and
  independently. A wrong character in a crypto address is money handed to
  nobody, and it is not a mistake a diff review catches. The EVM address keeps
  its EIP-55 mixed case, which is why the address is rendered as `.addr` text
  and never as `.input.is-mono` (that class upper-cases what it is given).
- **The QR codes carry wallet URIs**, `bitcoin:<address>` (BIP-21) and
  `ethereum:<address>` (EIP-681), so a phone opens a send screen instead of
  handing back a string to paste. Both are about fifty bytes and land at version
  4 of the ten the house encoder reaches (byte mode, level M, 62 data bytes at
  that version). `qrFor` falls back to the bare address if a payload ever stops
  fitting, so the symbol is never the thing that breaks.
- **The chain warning is one sentence**, in all three catalogues: the address is
  on Ethereum, and coins sent over another chain arrive nowhere.
- **No external script, image, font or request of any kind.** The QR symbols are
  drawn locally by `web/js/qr.js`; the addresses are static text. Nothing here
  counts a visit and nothing here can tell whether anybody ever paid, which is
  the one line the privacy note in the sheet makes. The module reads no document
  content, so the sheet works with the vault sealed, which is what the About
  entry point on the lock screen needs.
- Strings live under the `support.` prefix in all three catalogues.
- **Opening the sheet is recorded**, once, as `doc.settings.supportOpened` (sealed immediately),
  written inside `openSupportSheet` rather than at the two entry points so that a third entry
  point cannot forget it. It is the only thing this module writes, and its only purpose is the
  rule below. On the lock screen there is no open document to write into - the About screen and
  with it this sheet are readable before unlocking - so that visit goes unrecorded, which errs
  towards asking a question that was already answered rather than towards writing outside the
  vault.

### The espresso question (`web/js/ui/supportnudge.js`, WEB ONLY)

The one thing this app ever asks for unprompted, and it asks at most once per vault. A sheet in
the shape of the reminder offer: the title asks whether tenfold is being enjoyed, the body is
`support.body` word for word, the primary button opens the tip jar above and the quiet one says
"Not now".

- **Trigger, all of it required.** On an unlock, as the last step of `offerAfterUnlock()`:
  the vault is at least **7 days** old by `createdAtOf(doc)`; `settings.supportOpened` is unset
  (somebody who found the jar by themselves is never asked); `settings.supportNudged` is unset;
  `supportAvailable()` is true, i.e. `window.__tenfoldShell` is ABSENT; no sheet is open; and
  the first-run About intro is not on screen. A vault whose age cannot be established is not
  asked.
- **Not in the shell, at any age.** A nudge towards PayPal inside the iOS app is the same App
  Store rejection as the link it leads to. The guard sits in `offerSupport()` in app.js AND in
  `openSupportNudge`, the same belt-and-braces the sheet itself uses. The shell gets an in-app
  purchase instead; that is a later wave and a different feature.
- **Last in the chain.** `offerAfterUnlock()` is `offerShare()` -> `offerPush()` ->
  `offerSupport()`. Something another app sent in is the oldest claim on the moment, the
  reminder is the app's promise from the first run, and a question about the app itself comes
  after both. Each step bails on `isSheetOpen()`, so the ones behind a sheet simply wait for the
  next unlock. Pinned by `tests/supportnudge.spec.js`, at runtime and in the source.
- **Both buttons are final**, and both write `settings.supportNudged` with the immediate seal
  (`setSettings(..., { now: true })`) - the same reason the reminder offer does: a reload 200 ms
  later must not ask again. The primary writes `supportOpened` in the SAME call before opening
  the jar, so one decision costs one seal instead of two racing ones.
- **The X is not an answer.** Closing the sheet settles nothing, exactly as the share and
  reminder offers behave, and the question comes back at the next unlock. It does not come back
  twice in one session: `state.supportNudgedThisSession` is set when the sheet opens and cleared
  in `openWithMasterKey`, i.e. per unlock, not per screen.
- **The age anchor** is `doc.settings.createdAt`, written when the vault is created
  (`createVaultWith`) and backfilled once on the first unlock of a document that has none
  (`stampCreatedAt`, from `createdAtOf` - the oldest node or entity, and only where there is
  nothing at all to go on, today). The backfill rides on the debounced save; a session that ends
  before it lands derives the same value again next time.
- **One new string, `supportNudge.title`**, in all three catalogues; everything else on the
  sheet is `support.body`, `support.row` and `common.notNow`, so the question and the answer
  speak with one voice.

## The privacy policy (`web/privacy.html`)

The one public document this project ships, and the one page here that SHOULD be
indexed. App Store Connect takes a single URL and so does a link anywhere else, so
all three languages live on one page with a three-button toggle (default from
`navigator.language`, `en` as the fallback, `?lang=xx` wins where it is given).
Three files would have drifted apart the first time a server rule changed.

- **What it must always reflect** is what the code does, not what would read well:
  the four things the mailbox stores, deletion requiring the key-derived token, the
  metadata the server cannot help seeing, the visitor counters *exactly* as the
  section above defines them (and that they do not exist unless the operator sets
  the key), the empty push and what the push service therefore sees, the model modes
  with the operator's relay keeping nothing, the plaintext window of a shared note,
  and the tip jar learning nothing. When any of that changes on the server, this page
  changes in the same commit. The date stamp at the top of each language moves with it.
- **Self-contained, and it carries its own CSP.** Inline style, one inline script,
  the mark as an inline SVG, no font, no image, no request of any kind.
  `tools/serve.js` serves it with `default-src 'none'; style-src 'unsafe-inline';
  script-src 'unsafe-inline'` (`PUBLIC_DOCS`) instead of the app's strict header:
  the app's rule exists because an injected script there would hold the plaintext
  and the key at once, and this document has no user content, no fetch and no
  storage to inject into. Everything it does not need stays refused.
- **`sw.js` does NOT precache it.** The shell list is what the app needs to open
  without a network; a policy is a public document that must be current, and a
  cached copy of a policy is a stale copy of a policy. It is also the one page that
  has to be readable by somebody who has not installed anything.
- **The About link is the mirror image of the tip-jar line.** `ui/policy.js` renders
  one closing line, after the claim and immediately ABOVE the espresso line, and it
  is present in **every** mode: browser, shell, and during the first-run intro,
  where the tip jar is deliberately absent. An informational policy link is required
  where a payment link is a rejection.
- **Two hrefs, one rule.** In a browser it is the same-origin `./privacy.html`, so
  every deployment serves its own copy. In the shell it is the absolute
  `https://tenfold.kairatools.com/privacy.html`, because a same-origin
  `target="_blank"` is inert there: `WebViewCoordinator.decidePolicyFor` allows an
  app-origin URL and `createWebViewWith` then returns nil for it, so the tap does
  nothing. An http(s) link is the shape that reaches `UIApplication.open`, i.e. the
  system browser. Both strings live in `ui/policy.js` alone and are pinned by
  `tests/privacy.spec.js`.

## Zero-knowledge sync (stage 2)

The server is a dumb ciphertext mailbox. It stores the encrypted VaultFile, a version
counter, and the hash of an auth token. It has no code path that could decrypt anything.

**Identifiers and auth**
- `syncId`: 26 chars from the confusable-free base32 alphabet (128 bits), generated
  client-side, displayed grouped like the recovery key. Knowing it grants READ of the
  ciphertext only (capability); it is not derivable from any secret.
- `authToken`: HKDF-SHA256(masterKey, salt=authSalt, info="tenfold-sync-auth"), base64url.
  Only a device that can OPEN the vault can derive it. The server stores its SHA-256 hash,
  registered on the first PUT (trust on first use). PUT requires the token; GET does not
  (bootstrap: a new device must fetch the blob before it can decrypt anything).
- Both `syncId` and `authSalt` live in `vault.sync = { id, authSalt }`, non-secret metadata
  on the VaultFile, travelling with exports. crypto.js must preserve unknown top-level
  fields across sealIntoVault.

**HTTP API (served by tools/serve.js, same origin as the PWA)**
```
GET /api/vault/<syncId>          -> 200 { version, vault } | 404
PUT /api/vault/<syncId>          -> 200 { version } | 401 | 409 { version, vault } | 413
    headers: X-Sync-Token, X-If-Version (optimistic lock)
    body: { vault }
DELETE /api/vault/<syncId>       -> 204 | 401 | 404
    header: X-Sync-Token (required from EVERY caller, see below)
```
- Version is a server-side monotonic counter. A PUT with a stale X-If-Version returns 409
  with the current record; the CLIENT merges (decrypt both, `mergeDocs`, re-seal, re-PUT).
  The server never merges; it cannot.
- The server keeps the last 10 versions per syncId (rescue net), enforces a 4 MB blob cap,
  validates syncId against `^[a-z0-9]{26}$` (path traversal), and stores everything under
  the data dir (`TENFOLD_DATA`, default `~/.tenfold-data`, OUTSIDE the repo).
- No logging of tokens or bodies. Access log lines carry syncId prefix (6 chars) at most.

**Deletion (DELETE /api/vault/<syncId>).** The mailbox must be able to let go of what it
holds, or "your data, your device" is only half true:
- **The token is required from every caller, loopback included.** The loopback exemption that
  applies to the abuse limits and to the model relay does NOT apply here: a stray local script
  (a half-written cron job, a test pointed at the wrong port) must not be able to destroy
  what it cannot open. Only a device that can derive the key-based `authToken` may delete.
  Wrong or missing token -> 401, unknown id -> 404, success -> 204 (no body).
- What goes is the WHOLE id directory: `current.json`, every `v<n>.json` history file and
  `push.json` with the reminder subscriptions. The directory is renamed out of the vault dir
  first and then removed, so no half-emptied record is ever served; the vault counter is
  decremented and the relay's token cache is dropped.
- **Deletion is destruction, not a tombstone.** Nothing is kept: no marker, no "this id
  existed" file. Afterwards the id is free: the next PUT with ANY token registers it again as
  a brand-new mailbox (trust on first use), and the token that used to own it has no standing.
- Rate limits apply exactly as for the other API calls.

**Client (`web/js/sync.js`)**
```js
export async function enableSync(ctx): Promise<void>      // generate ids, first push
export async function disableSync(ctx): Promise<void>     // forget local sync fields (server copy stays)
export async function deleteRemote(ctx): Promise<void>    // DELETE the server copy; 404 counts as done
export async function push(ctx): Promise<void>            // debounced after autosave
export async function pull(ctx): Promise<"clean"|"merged"|"offline">  // on unlock
export function pairingCode(vault): string                // grouped syncId for the other device
export async function adopt(syncId): Promise<VaultFile>   // fetch + store, then normal unlock
```
- Sync is OFF by default; enabling is an explicit act, either in settings or as the answer
  to the one question the first run asks (see below). Nothing enables it silently.
- **The backup step (last step of the first run, `ui/setup.js`, key prefix `setup.backup.`)**:
  after the starting point and before `ctx.enterApp()`, the setup asks whether to keep the
  encrypted copy on the server, because clearing the browser's site data deletes IndexedDB and
  a vault with no copy and no export file is then gone. The copy is the primary offer, "Not
  now" is a ghost button, and neither answer blocks: a failed upload (offline, server down) is
  a calm toast naming settings as the way back, never a wall. Import and adopt paths land on
  the lock screen, not on setup, and never see this step.
- **The reminder step (`setup.reminder.*`, immediately after the backup step)** exists only
  on the "keep the copy" branch: a subscription needs the vault's write token, so "Not now"
  on the backup question skips it entirely and lands in the app as before. It reuses the
  reminder's own words (`push.body`, `push.hour`, `push.ios`, `push.enable`) and the exact
  `ctx.push.enable(hour)` path the settings row uses, hour default 8. A denied permission or
  a server that will not answer is the ordinary `push.error.*` toast and the first run
  continues - nothing here traps anybody. Where notifications cannot work in this window
  (`push.usableHere()` false - an iOS browser tab) the step still appears, says exactly that,
  and its one action is "I will do it in the app": that branch deliberately records NOTHING,
  because the after-unlock offer in the installed app is what makes up for it.
- **`doc.settings.exportedAt`** (epoch ms) is stamped wherever an encrypted or a plaintext
  export is actually delivered: the two settings handlers, never the setup recovery-key
  screen. With sync off AND no `exportedAt`, the outline's `h-sub` carries one extra clause
  (`outline.onlyHere`, in the `.hot` tone) and becomes a button into settings; in every other
  state it stays plain text. The clause disappears the moment either condition changes.
- On unlock: pull; if the remote is newer, decrypt locally, `mergeDocs`, save, push.
- All failures are silent-but-visible: a quiet status dot plus a "last synced" line in
  settings, never a blocking dialog.
- New device: "Open from another device" on the setup welcome screen asks for the pairing
  code, calls `adopt`, then the normal lock screen takes the passphrase. The URL fragment
  form `#s=<code>` triggers the same flow (fragments never reach the server).
- **Delete everywhere (`ctx.deleteEverywhere`, settings danger row, key prefix `danger.`)** is
  the last row of the security group. The sheet names what dies before anything happens: the
  encrypted server copy (or, with sync off, that there is none this device could reach), this
  device down to the list, the keys and the Face ID enrolment, and honestly that other paired
  devices keep their local copy, stop syncing, and would create a NEW server copy under the
  same pairing code if one of them ever uploads again. Confirmation is the recovery-key
  acknowledgement pattern, not a countdown: a checkbox ("I understand this is final") that
  ungreys the primary. **Order matters and is a rule, not a detail:** `deleteRemote` runs FIRST
  and throws before anything local is touched; on failure the flow STOPS, says which side
  failed, and offers "Delete only on this device" instead of silently half-deleting. On
  success: `push.forgetLocal()`, `webauthn.forget()`, `clearAll()`, `resetSync()`, setup
  screen, toast. The presentation prefs (skin/theme/lang in `tenfold.ui`) stay, because three enum
  values about how a screen looks are not personal data.
- The lock-screen reset stays what it always was, a device-only wipe; `lock.reset.syncNote`
  now points at the bigger action ("unlock first, Settings, Delete the vault everywhere"),
  because a locked device cannot derive the token that deletion requires.

## Stage 3: the model, and its removal in v1.1

**What stage 3 built, and what is left of it.** Until v1.1 this app spoke to a language
model itself: `doc.settings.llm` held a mode (`off` / `local` / `cloud`), a provider, a base
URL, a model name and an API key inside the sealed vault; `web/js/llm.js` scoped a context
and posted it to a same-origin relay, `POST /api/llm` in `tools/serve.js`, which forwarded
it to an allowlisted upstream (the SSRF wall) behind a caller gate for the operator's own
local models (`tools/llm_gate.js`, `DATA_DIR/llm_access.json`, the `/stats#llm` console and
the `TENFOLD_NOTIFY_URL` doorbell). `web/js/prompts.js` held seven operations behind an
interview gate, `web/js/ui/assist.js` showed them as proposals, and `web/js/ui/imageimport.js`
read a photographed list through the same relay from a camera button in the bottom bar.

**All of it is gone.** Not deprecated, not disabled: deleted, together with the settings
group that configured it, the three-mode switch, the cloud consent sheet, the connection
test, the camera button and 91 i18n keys. The app makes no model request of any kind, and
`tools/serve.js` has no route that forwards anything anywhere. **The full apparatus lives
in git history at the `v1.0.0` tag** - read it there rather than reconstructing it from
this paragraph.

**What replaced it: the copy loop**, specified below under "The copy loop". The person is
the transport. This is a smaller promise honestly kept rather than a larger one hedged:
there is no key to store, no address to trust, no relay to audit and nothing that can be
switched on by accident.

**What SURVIVED the removal, and is still binding:**
- **`llmOptout` on a node** (schema 2) and its UI - the toggle in the row menu and on the
  leaf screen, with the inherited state shown and never toggled where it was inherited. It
  is no longer conditional on any assistance being configured, because the copy loop needs
  no configuration: the switch that holds a branch back must exist wherever the loop does.
- **`origin: "llm"`** on every node a model's words produced, applied through the ordinary
  mutate path (`ctx.importTree`). The answer did come from a model; how it travelled does
  not change where it came from.
- **The scoping rules**, ported into `buildCopyContext` with the two per-call releases
  removed - a text on the clipboard has no single call to release something for. They are
  therefore STRICTER than the relay's were, not looser.

**QR pairing (stage 3c):** the pairing sheet shows the pairing URL additionally as a QR
code, generated by our own encoder (`web/js/qr.js`, byte mode, EC level M, no third-party
code; correctness proven against fixed known-good vectors in tests). The new device scans
it with the NATIVE camera app (the URL opens the app, `#s=` adopts) or with the in-app
"Scan code" button on the welcome/adopt screen, which exists on **every** platform and
picks its mechanism itself:

- `BarcodeDetector` present (Android/Chrome) → the live scanner, `getUserMedia` plus the
  browser's own detector, in `web/js/ui/scan.js`.
- otherwise (iOS Safari has no `BarcodeDetector` at all) → `web/js/ui/photoscan.js`: an
  `input[type=file][accept=image/*][capture=environment]` opens the native camera, and the
  single photograph it returns is decoded by **our own reader**, `web/js/qrread.js`:
  adaptive threshold, finder patterns, perspective grid, and real Reed-Solomon *correction*
  (Berlekamp-Massey, Chien, Forney over the GF(256) tables `qr.js` exports), so the handful
  of wrong modules a phone photo of a screen always carries are repaired rather than merely
  detected. Level M, versions 1–10, byte mode: what our encoder writes. The whole frame is
  tried first, then a 2× centre crop; a failure is one calm line naming both ways out.

Both paths are progressive enhancement over the typed code, which stays fully usable.
Frames and photographs are processed locally and never leave the device: no fetch in
either module; the live stream stops the moment the sheet closes, and the photo path drops
file, bitmap and canvas in the same single-point teardown. The symbol is rendered by
`web/js/ui/qrview.js` (one SVG path, quiet zone 4, black on white in every skin).
`decodeImage(imageDataOrCanvas)` returns `string|null` and never throws.

## The copy loop (`web/js/aihelp.js`, `web/js/ui/aihelp.js`)

The person is the transport. tenfold writes a prompt about one goal, they carry it to whatever
AI they already use, and they paste the answer back. **No network call is involved at any point
of this loop** - not a relay, not a key, not a provider address, nothing to configure and nothing
that can be switched off, which is why the entry point does not ask whether any other kind of
assistance is enabled. It works offline, in a browser with no server behind it, and inside the
native shell.

**Entry point:** "Think it through with an AI", a quiet `.leaf-act` at the top of the assistance
block on the leaf screen (`data-ai="copy"`), where every other route to a model has always sat.
It is absent for a node that is kept away from models, own or inherited. Deliberately NOT marked
`data-llm`: that attribute names the relay surface, and this is not part of it.

**What enters a prompt** (`buildCopyContext`, pure, tested): the target node with its title,
status, story, note, done-criterion and planned minutes; the titles of the goals it hangs under;
its direct children with their status (capped at 20); and the LINKED entity cards of that chain,
name, kind and relation only (capped at 12).

**What never enters a prompt**, enforced in the builder rather than in the sheet:
- **an opted-out subtree.** A node with `llmOptout`, or under one, returns `null` - no prompt at
  all, not a reduced one. Opted-out nodes anywhere in the neighbourhood are dropped and counted.
- **a card marked `sensitivity: "high"`.** There is no per-call release here and there cannot be
  one: a text on the clipboard has no single call to release it for.
- **the notes on ANY card.** The name and what somebody is to you make a card readable; the
  history on it is the private half and stays on the device.
- **anything that is not the tree.** The vault, the passphrase, the recovery material, the sync
  id and the settings have no representation in this module; they cannot be forgotten out
  because they were never in. Pinned by canaries in `tests/copyloop.spec.js`.

What was held back is NAMED in the prompt ("left out on purpose"), so the model does not fill the
gap with a guess. The sheet says the same thing in one line above the text, with the number of
steps in it, before anything is copied.

**The prompt itself** lives in `PROMPT` in `web/js/aihelp.js`, en/de/es, and is built in the
language the app is in (an unknown locale falls back to English). It asks for two things in
order: at most three clarifying questions first, then small steps in the person's own words.
The three catalogues carry the same label, status and instruction keys; a spec asserts that, the
way the i18n spec asserts it for the UI catalogues.

**The output contract is the LAST thing in the prompt**, and it asks for exactly one format:

```
[{"step": "...", "substeps": ["...", ...]}, ...]
```

one fenced code block (three backticks) at the end of the answer, containing nothing but that
JSON array. `substeps` is optional; its entries may be strings or the same object again, which
is how a level below the first one is written. Stated as a deal - *whatever else you write, end
with that one code block* - so a model is free to think out loud, ask, apologise and summarise,
as long as the block is there.

Two properties of that paragraph are load-bearing and are pinned by
`tests/copyloop.spec.js` in all three languages:
- **It comes last.** Recency wins. The format demand used to sit in the middle of the prompt,
  ahead of the "small steps, my words" guidance, and that is precisely the instruction a model
  drops first. Asserted as a position: the demand appears after the questions paragraph.
- **The drift guard.** One sentence saying that IF the conversation continues, every later
  answer ends the same way again, with the **complete, updated** list in that same block - not
  only the part that changed. This is the sentence that addresses the observed failure: the
  prompt was carried into a chat, the conversation ran two turns, and the second answer came
  back as flowing prose with the list convention forgotten, leaving the paste-back parser
  nothing to parse.

The old "indent a sub-step by two spaces" convention is gone from the prompt (a spec asserts its
absence, in three languages). Two formats asked for at once is how a model picks the wrong one -
the parser still reads indentation, but nothing asks for it any more.

**Copying out:** clipboard first (`navigator.clipboard.writeText`), the share menu as a secondary
where the platform has one (`navigator.share`, text only). A browser that refuses the clipboard is
not a failure: the prompt stands in a readonly field, it gets selected, and one line says to take
it by hand.

**Pasting back** goes through `parseAnswer(text)`, which reads a paste in ONE fixed order and
returns `{items, source, fenced}`. What a person actually does is select the whole conversation,
so the order exists to find the answer inside the chat rather than to demand a clean paste:

1. **Last fenced block wins.** `fencedBlocks()` collects every fenced block (three backticks or
   three tildes), and if there is one, the LAST one is the answer and everything around it is
   chat that never reaches a parser. A block that was opened and never closed still counts - a
   model that ran out of room mid-answer wrote a block, and dropping it would lose exactly the
   part the person came for.
2. **JSON inside it, strictly.** `JSON.parse`, top level must be the documented array. No
   trailing-comma tolerance, no repair pass, no object wrapper: the only slack is surrounding
   whitespace and a language tag (`json`) a model wrote inside the block instead of on the fence.
   `step` → title, `substeps` → children one level down, unknown keys ignored. A `step` that is
   not a string is a **broken entry** - the same strictness the photo path had - so the entry is
   dropped and what hung under it moves up rather than vanishing with it. Plain strings and bare
   nested arrays are accepted as well: accept more, never less.
3. **Indented text after that.** Anything that is not JSON goes through `parseOutlineText` -
   inside the block when there was one, over the whole paste when there was not. It reads
   indentation RELATIVELY, a stack of the widths it has seen, so two spaces, four spaces and a
   tab all mean the same thing as long as one answer is consistent with itself. Bullets, numbers,
   letters, checkboxes, heading hashes and emphasis marks are stripped; a trailing colon goes
   with them. An answer that ignored the format entirely is read exactly as it was before this
   order existed.

Both readers end in `normalizeOutlineItems`, the ONE place the three limits of an outline live
(four levels, 100 lines, 200 characters per line) - it was shared with the photo import so the
two ways in could not drift, and it is still the only place those limits exist. JSON recursion
has a floor of its own (`MAX_JSON_DEPTH`, 12) so a file of nested arrays cannot take the stack
down; the levels are clamped to four either way. Nothing is dropped for looking like prose: a
sentence in front of the list becomes a line the person sees and cancels on, which is honest
where silent swallowing would not be. The **markup canary covers both readers** - a title
carrying `<img src=x onerror=...>` arrives as characters, in the preview and in the document,
whether it came out of JSON or out of indented text.

**Preview before apply.** The parsed lines are shown with their indentation, counted, and the
only two answers are Apply and Cancel. Cancel returns to the field with the text still in it and
writes nothing. Apply goes through `ctx.importTree`, the ordinary mutate path, which sets
`origin: "llm"` on everything it creates - the answer did come from a model, and the provenance
mark says so no matter which way it arrived. **The app never applies model output blind:**
Vorschlag, nie Ausfuehrung.

**The keep-away switch** (`llmOptout`) is the guard for this loop as much as for anything else,
so the leaf screen offers it whether or not any other assistance is configured. Without it the
promise above would have no control behind it.

### The tree review: the whole list, and no way back

Owner's question: *"Click auf The Ten soll mir Think it through with an AI Prompt für den
gesamten Baum anbieten. Ist das zu viel?"* It is not, but only as a **different prompt**. The
leaf prompt UNFOLDS one goal into steps and therefore ends in a format contract. The tree prompt
REVIEWS the list - a Bestandsaufnahme - and ends in prose.

**Entry point:** the title of the outline screen. The `<h1 class="h-title">` keeps its heading
role and holds a `button.h-title-btn` (`aria-label` from `a11y.treeReview`) - the same treatment
`button.h-sub` gets one line below it, and the same register: no chevron, no icon, no colour,
a press dims it. It is a plain heading again whenever `treeReviewAvailable(doc)` is false, which
is an empty list or one whose every goal is kept away from models.

**What enters it** (`buildTreeContext`, pure, tested): the LIVING TREE - every goal and, under
it, every living descendant, in document order. Per goal: its rank in the document, title,
status, a story excerpt, due pressure (overdue / due today, counted with `model.dueCounts` over
that goal's subtree) and progress (done of total steps). Plus the linked cards of the roots,
through the same `collectCards` the leaf prompt uses - one function, so the card rule cannot
drift into two versions.

It carried the ROOTS ONLY until v1.65. The owner field-tested that version on his own vault -
nine goals, seventy steps, three levels deep - and reported: *"Der große Prompt mit dem Baum hat
bei weitem nicht alle Unterzweige dabei. Das LLM versteht nur einen kleinen Teil vom Ganzen."*
He is right, and the review it asks for is the reason: "which of these is too vague to unfold"
cannot be answered by a model that was never shown what has already been unfolded. So the whole
tree travels, and the prompt's opening says in one clause that it is a tree and that what stands
under a goal is a step towards it.

**The outline** (`renderTreePrompt`): two spaces per level counted from the goal - its labelled
lines one step in, the steps under it one further, each level below that one more. Plain text,
the shape the app's own outline parser can read, though nothing on this side ever comes back. A
step line is its title and nothing else unless something is true of it: a status marker only
where the status is not `open` (`(done)`, `(in progress)`, `(resting)`), a due marker only where
`model.isOpenLeaf` says the today rule looks at that node at all, with the group from
`model.dueGroupOf` - so a marker on a line can never disagree with the PRESSURE count above it.

**What never enters it** is what never enters the leaf prompt, enforced in the same builder
layer: an opted-out root is **absent and counted**, an opted-out branch under a living root is
absent **with everything under it** and out of that root's counts, a card marked
`sensitivity: "high"` is dropped, and card notes never travel. Ranks are the document's ranks,
so a withheld goal leaves a **gap** rather than a silently renumbered list, and the "left out on
purpose" line explains it - now with the size of the hole, in goals and in steps
(`omitted.optoutGoals` / `omitted.optoutSteps`), because "one goal and 3 steps" tells a reader
something that "parts I keep away" alone does not.

**Story excerpts: `MAX_STORY_EXCERPT` = 240 characters for a goal, `MAX_CHILD_STORY_EXCERPT` =
120 for a step**, cut on a word boundary and flattened to one paragraph. Ten stories written
properly are pages, and a prompt nobody reads to the end is a prompt whose ask gets skimmed; 240
is about three sentences, enough to tell a goal with a reason behind it from a goal that is only
a title. Most steps have no story at all, so the smaller budget is spent rarely and exactly
where somebody sat down and thought about one step - which is what the model wants to see. A cut
story is **marked** (`(story continues)`) and the prompt says once, in a sentence of its own,
that the longer ones were cut, with both caps named, and that the rest can be asked for.

**Caps that scale honestly: `MAX_TREE_NODES` = 400 lines in total, `MAX_GOAL_NODES` = 60 under
any one goal.** Seventy steps fit whole; eight hundred would not, and 800 lines is the skimmed
ask again. The per-goal cap is the more important one - without it a single runaway goal eats
the budget and the nine below it arrive as bare titles. Trimming is from the END of a goal's own
depth-first outline, so a parent always precedes its child and a cut leaves no orphan, and what
was cut is **said in place** on the line where it was cut (`+ 40 more steps under this goal, not
listed`). A goal the total cap emptied still stands in the list with its own count. A prompt
that showed four of sixty-four steps without saying so would be a lie by omission.

**The ask** (`PROMPT[locale].tree.ask`, en/de/es): read the whole of it first; up to three
questions, only where an answer would change the reading; then the review proper - where goals
collide or are the same goal twice, which are too vague to unfold, which have no story yet,
whether the order is honest, and which ONE deserves the coming week; then a short verdict in
prose, in the person's words.

**No paste-back, anywhere.** There is no code-block contract in this prompt (a spec asserts the
absence of a fence, of the word JSON and of the `"step"`/`"substeps"` keys in all three
languages, while asserting the leaf prompt built from the same document still carries all of
them). The sheet opened in tree mode has no paste row, no parser, no preview and no Apply; the
line where the leaf sheet puts its paste row says so instead. Copy and share behave exactly as
they do on the leaf side.

**The scope line** above the field counts what actually travels - the goals AND the steps listed
under them (`context.partCount`, so a trimmed list is never claimed whole), in all three
languages. A list with nothing under it yet says that rather than reporting zero steps
(`aihelp.tree.scopeBare` / `scopeBareOne`).

## Visitor counters (`TENFOLD_STATS_KEY`, off by default)

The server logs nothing. This is the **third explicit exception** to that rule, after the VAPID
signing key and the share-target fallback, and it is written down here for the same reason as
the other two: an exception that is not named is a hole. It was the fourth until v1.1, when the
model relay - the second - was removed. (The header of `tools/serve.js` still labels this one
the third: it numbers only the exceptions declared in that header, and the second slot now
holds a history note about the relay rather than being closed up, because a rule that quietly
loses an exception reads as if it never had one. The share-target fallback is documented at its
branch in the router.)

**It does not exist unless the operator switches it on.** With `TENFOLD_STATS_KEY` absent or
empty nothing is counted, no file is written, and `/stats` answers the same plain 404 as any
unknown path. Every deployment that does not opt in stays exactly as tracking-free as before;
the test suite's own server runs without the key, so "off by default" is the state the rest of
the suite is proven under (`tests/stats.spec.js`).

**What is recorded**, per UTC calendar day, in memory, flushed to `stats.json` in `TENFOLD_DATA`
every 5 minutes and whenever the page is rendered:
- `hits` - document loads of the app's own `index.html` (bare domain and the `/tenfold` prefix).
- `visitors` - a COUNT of distinct SHA-256(daily random salt + IP). The salt is generated per
  day, held only in memory, never persisted; the hash Set is never persisted either. Only the
  number reaches the disk, so the file cannot be turned back into who was there.
- `bots` - loads whose user agent carries one of a short list of markers (bot, crawler, spider,
  preview, fetch, curl, wget, python-requests, headless). A bot increments **this counter only**
  and appears in no other number, so a launch-day crawler wave cannot drown the human figures.
- `ref` - the external referrer **host** (`news.ycombinator.com`), never the full URL: a foreign
  URL can carry a foreign query secret.
- `geo` - the `cf-ipcountry` header when Cloudflare sets one, else `??`.
- `platform` - one bucket of three, `mobile` / `desktop` / `app`, from a user-agent substring.
- `appDevices` - a COUNT of distinct devices that synced through the native shell that day. Same
  daily salt, same hash, same never-persisted rule as `visitors`, in a Set of its own.

`ref` and `geo` are capped at **200 keys per day** with an `other` bucket, so a hostile `Referer`
cannot grow the file without bound; days are capped at 400. The visitor Set and the app-device Set
are each capped at 100 000 hashes per day and then stop counting rather than eating memory.

**The native app, and why it is counted differently.** The iOS shell (`tenfold-ios`) bundles the
web app and never loads a document from this server, so document counting cannot see it at all -
and an app that sent a beacon purely to be counted would break the product's own promise. It is
therefore visible only through traffic it already sends: the sync and push calls its proxy
forwards, which carry `User-Agent: tenfold-ios/<marketing version>` and nothing else. That string
is two tokens by construction on the client side (`ApiProxy.userAgentValue`, pinned by a unit
test); it carries no device model, no OS version, no build number and no per-install value, so two
phones on the same release send byte-identical strings. It is a claim, not a credential - anything
can send it - which is why it may only decide which column a number lands in.

An `/api/vault*` or `/api/push/*` request with that prefix feeds **`appDevices` and nothing else**:
no hit (a sync storm is not a visit), no id, no path, no method, no body size. Browsers' API calls
stay uncounted exactly as before. A `tenfold-ios/` user agent on a *document* load would land in
`platform.app`; that arm is future-proofing for a build that fetches the page over the wire, and is
not today's path. An app used offline appears in no number on the page - a true figure missing,
not one waiting for a beacon. Shell side: `tenfold-ios/docs/DECISIONS.md` D17.

**What is never recorded:** `/api/*` from a browser, and from the app everything except that one
per-day device count (those URLs carry sync ids, which are capability secrets); static assets,
query strings, the stats page itself, and any 404. No IP, no user agent string, no cookie, no
session, no identifier, nothing that links two days of one person - the same visitor or device
tomorrow is a new one, because today's salt is gone.

**File migration.** `platform.app` and `appDevices` are absent from every `stats.json` written
before they existed. `loadStats()` reads a missing number as zero and the next flush writes the
current shape - lazy and tolerant, like the shape change before it. No version field, no rewrite
pass, no upgrade step for the operator.

**The page.** `GET /stats?k=KEY`, and `/stats.php?k=KEY` for the operator's muscle memory, same
handler. The key is compared in fixed time over SHA-256 digests; a wrong key, a missing key, a
disabled feature and a rate-limited caller all get the byte-identical plain 404, so the answer
never betrays that the page exists. Server-rendered HTML, inline CSS, no script, no external
asset, `noindex`; sections `#visitors` (per-day table plus an inline SVG bar chart of the last
30 days), `#referrers`, `#countries`, `#platform`. `/stats` goes through the same per-IP limiter
as the API calls.

**The one write action.** `POST /stats` with `action=clear` and the same key wipes the file and
the in-memory state and redirects back to the page (303), so an operator can scrub their own test
visits. That is the whole admin surface; there is nothing to edit, because there is nothing in
there about anybody.

## Tests

Playwright, headless. `tests/*.spec.js` load the ES modules directly in an empty page via a
small static server. What counts: crypto round trip, every envelope alone, tamper detection,
merge behaviour, cycle guard, duel correctness, plaintext-leak test, i18n key-set equality,
and the full-chain integration spec (`tests/integration.spec.js`).
