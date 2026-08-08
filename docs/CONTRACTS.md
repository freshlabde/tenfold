# tenfold — binding contracts between modules

This file is the contract that all modules are built against, independently of each other.
Anyone who wants to change an interface changes this file first.

## Ground rules (apply to every file under `web/`)

1. **Pure ES modules.** `export`/`import`, no bundler, no third-party library, no CDN.
2. **No `innerHTML` with user content.** Anywhere. Text goes through `textContent` /
   `document.createTextNode` only. In a zero-knowledge app an injected script is total loss —
   it would hold the plaintext *and* the key.
3. **No `eval`, no `new Function`, no inline event attributes** (`onclick=…`).
   `addEventListener` only.
4. **No emojis** in code, UI copy, or comments.
5. **Language: English is the default everywhere** — identifiers, comments, docs, commit
   messages. UI copy goes through i18n (see below).
6. **i18n: en, de, es.** English is the source of truth and the fallback chain is
   `[requested] -> en`. All three locales ship with identical key sets — a missing key in any
   locale is a test failure. No hardcoded UI strings in components.
7. **Network discipline.** The ONLY module allowed to use `fetch` is `web/js/sync.js`, and
   the only endpoints it may call are the same-origin `/api/vault/...` routes below. Every
   other module stays network-free. Nothing that leaves the device is ever plaintext.
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

### Schema 2 (stage 2 — story layer)

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
  note. Subtle visual mark only, hideable via settings; it never nags.

## Today & the daily question (stage 2)

- **Today screen**: `model.todayList` (rule fixed above), route `today`, reachable from the
  outline header; a quiet list, max 7, nothing else.
- **`web/js/questions.js`**: a catalogue of calm coaching questions (i18n keys, all three
  locales). The daily question picks deterministically (date + node with the thinnest story);
  the answer is appended to that node's story. Works fully offline, no LLM.
- **Web push** (optional, off by default, requires sync enabled + browser permission):
  - `GET  /api/push/vapid` -> `{ publicKey }` (server generates its VAPID P-256 pair once,
    stored in the data dir; ES256 JWT via node:crypto - still no third-party dependency).
  - `POST /api/push/subscribe` `{ syncId, sub, hourUtc }`, header `X-Sync-Token` -> 204.
    Max 5 subscriptions per syncId, stored beside the vault record.
  - `POST /api/push/unsubscribe` `{ syncId, endpoint }`, same auth.
  - The server sends an **empty** push (no payload) once daily per subscription at
    `hourUtc`; the service worker shows a static localised "your question is waiting"
    notification. No list content ever reaches the push channel; the SW may keep the
    current locale in its own small store to localise the static text.

## `web/js/crypto.js` (BUILT — do not change without updating its tests)

```js
export const MAGIC = "TENFOLD1";

// Creates a new vault: random 256-bit master key, wrapped in envelopes.
// Also returns the masterKey so the caller does not pay another PBKDF2 run.
export async function createVault({ passphrase }): Promise<{ vault, recoveryKey, masterKey }>

// Opens a vault with one of the envelopes. Throws VaultUnlockError on a wrong secret.
export async function unlockWithPassphrase(vault, passphrase): Promise<CryptoKey>
export async function unlockWithRecoveryKey(vault, recoveryKey): Promise<CryptoKey>
export async function unlockWithRawKey(vault, wrapKey /* ArrayBuffer */): Promise<CryptoKey>

// Add/remove envelopes later (enrol Face ID, revoke a device)
export async function addRawKeyWrapper(vault, masterKey, wrapKey, label): Promise<VaultFile>
export async function removeWrapper(vault, label): Promise<VaultFile>

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
- Per-wrapper AAD: the wrapper's own metadata (magic, version, id, kind, label, kdf, nonce) —
  parameter tampering fails the GCM tag check.
- `VaultFile` is JSON-serialisable: `{ magic, version, wrappers[], payload }` — binary parts
  base64url. No top-level `settings`/`nodes`/`doc` key, ever (store.js rejects those).
- Recovery key: 7 groups of 4 from a confusable-free base32 alphabet (137 bits), input
  normalisation tolerates case, hyphens, spaces.

## `web/js/model.js` (BUILT) — pure tree functions, no IO

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
export function mergeDocs(a, b): Doc                         // per node, younger updatedAt wins
```

`mergeDocs`: on conflict the younger `updatedAt` wins; the losing `title`/`note` is appended
to the winner's `note` under a "--- divergent version ---" marker instead of being discarded.
Tombstones never beat a younger live edit. Deterministic and argument-order independent.

## `web/js/store.js` (BUILT) — IndexedDB, ciphertext only

```js
export async function requestPersistence(): Promise<{ persisted, supported }>
export async function loadVault(): Promise<VaultFile|null>
export async function saveVault(vault): Promise<void>        // rejects plaintext-shaped objects
export async function clearAll(): Promise<void>
export async function lastSavedAt(): Promise<number|null>
```

**Only the encrypted vault ever goes into IndexedDB.** No plaintext field, no search index,
no cache — never. `saveVault` actively rejects objects carrying `nodes`, `doc`, `plaintext`
or `settings` keys.

## `web/js/portability.js` (BUILT)

```js
export function exportEncrypted(vault): Blob            // .tenfold file
export async function importEncrypted(file): Promise<VaultFile>
export function exportPlaintextMarkdown(doc): Blob      // only after explicit confirmation
```

## `web/js/prioritize.js` (BUILT) — duel state machine, no UI, no randomness

```js
export function startDuel(items): DuelState
export function currentPair(state): { a, b } | null     // null = finished
export function choose(state, winnerId): DuelState      // pure, returns a new state
export function result(state): string[]                 // ids, best first
export function progress(state): { done, estimatedTotal }
```

Binary insertion: ten items in at most 25 comparisons. No `Math.random()` — reproducible.

## `web/js/search.js` (BUILT)

```js
export function search(nodes, query, opts): { node, path, matchField }[]
```

Local, accent-insensitive, partial-word matches, relevance-ordered. No index on disk.

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
- Identical key sets across all three files — enforced by a test.
- Interpolation via `{name}` placeholders. No HTML in catalogue values, ever (XSS rule 2).

## Skins (stage 1, wave 2)

The three design directions under `design/` become user-selectable skins. One DOM structure,
one set of components; the look is carried entirely by CSS custom properties plus a
`data-skin` attribute on `<html>`:

- `slate` (**default**) — direction B: layered slabs, light edges, rank as depth
- `register` — direction A: set type, hairlines, serif stack, no boxes
- `breath` — direction C: text on black, hierarchy through size and opacity

Rules: components never hardcode colors, radii, shadows, or font stacks — tokens only
(`--bg`, `--surface`, `--text`, `--muted`, `--accent`, `--line`, `--radius`, `--shadow`,
`--font-display`, `--font-body`, `--font-mono`). Skin-specific structural touches go through
`[data-skin="…"]` selectors in the skin file, never through JS branching. Each skin defines a
dark and a light variant (`data-theme="dark|light"`, dark default). The choice persists in
`doc.settings.skin` and is applied before first paint to avoid flashes.

## About screen (stage 1, wave 2)

A calm, readable screen inside the app (`web/js/ui/about.js`), reachable from settings and
from the lock screen — it must be readable *before* unlocking, since it explains what the
app is and what happens to the data. Content (all through i18n):

1. **The method** — one list of the ten things you truly want; ranking them honestly
   (pairwise duels, because a real order is hard); breaking each one down, level by level,
   until single actionable steps appear; working from the top of the list, not the bottom.
   **The handwritten ritual stays**: once a month, or whenever life shifts, the ten are
   written by hand on paper — writing by hand is the thinking, no app replaces it; the app
   then carries what paper cannot (breakdown, honest ordering, encryption, always in the
   pocket). Inspired by Raymond Hull's classic self-management advice — named as
   inspiration, no quoted material.
2. **Why stories matter** — a goal without its story cannot be broken down well; the app
   asks and remembers so the steps fit your life, not a template.
3. **Privacy in one paragraph** — everything is encrypted on the device with your keys;
   the server (when sync exists) stores unreadable blobs; nobody, including the operator,
   can read the list. Honest limits: an unlocked device in foreign hands, and whoever runs
   the model sees plaintext while it thinks.
4. **The claim** — "tenfold — get what you want."

No marketing tone, no self-praise, no AI-tell phrasing. Short paragraphs, generous type.

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
- Both `syncId` and `authSalt` live in `vault.sync = { id, authSalt }` — non-secret metadata
  on the VaultFile, travelling with exports. crypto.js must preserve unknown top-level
  fields across sealIntoVault.

**HTTP API (served by tools/serve.js, same origin as the PWA)**
```
GET /api/vault/<syncId>          -> 200 { version, vault } | 404
PUT /api/vault/<syncId>          -> 200 { version } | 401 | 409 { version, vault } | 413
    headers: X-Sync-Token, X-If-Version (optimistic lock)
    body: { vault }
```
- Version is a server-side monotonic counter. A PUT with a stale X-If-Version returns 409
  with the current record; the CLIENT merges (decrypt both, `mergeDocs`, re-seal, re-PUT).
  The server never merges — it cannot.
- The server keeps the last 10 versions per syncId (rescue net), enforces a 4 MB blob cap,
  validates syncId against `^[a-z0-9]{26}$` (path traversal), and stores everything under
  the data dir (`TENFOLD_DATA`, default `~/.tenfold-data` — OUTSIDE the repo).
- No logging of tokens or bodies. Access log lines carry syncId prefix (6 chars) at most.

**Client (`web/js/sync.js`)**
```js
export async function enableSync(ctx): Promise<void>      // generate ids, first push
export async function disableSync(ctx): Promise<void>     // forget local sync fields (server copy stays)
export async function push(ctx): Promise<void>            // debounced after autosave
export async function pull(ctx): Promise<"clean"|"merged"|"offline">  // on unlock
export function pairingCode(vault): string                // grouped syncId for the other device
export async function adopt(syncId): Promise<VaultFile>   // fetch + store, then normal unlock
```
- Sync is OFF by default; enabling is an explicit act in settings.
- On unlock: pull; if the remote is newer, decrypt locally, `mergeDocs`, save, push.
- All failures are silent-but-visible: a quiet status dot plus a "last synced" line in
  settings, never a blocking dialog.
- New device: "Open from another device" on the setup welcome screen asks for the pairing
  code, calls `adopt`, then the normal lock screen takes the passphrase. The URL fragment
  form `#s=<code>` triggers the same flow (fragments never reach the server).

## Tests

Playwright, headless. `tests/*.spec.js` load the ES modules directly in an empty page via a
small static server. What counts: crypto round trip, every envelope alone, tamper detection,
merge behaviour, cycle guard, duel correctness, plaintext-leak test, i18n key-set equality,
and the full-chain integration spec (`tests/integration.spec.js`).
