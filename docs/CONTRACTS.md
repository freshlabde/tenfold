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
7. **No network calls in stage 1.** No `fetch`, no `XMLHttpRequest`. Exception: none.
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

Stage 2/3 fields (`story`, `entityRefs`, the context index) do not exist in the schema yet.
The `schema` field enables later migration.

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

## About screen (stage 1, wave 2)

A calm, readable screen inside the app (`web/js/ui/about.js`), reachable from settings and
from the lock screen — it must be readable *before* unlocking, since it explains what the
app is and what happens to the data. Content (all through i18n):

1. **The method** — one list of the ten things you truly want; ranking them honestly
   (pairwise duels, because a real order is hard); breaking each one down, level by level,
   until single actionable steps appear; working from the top of the list, not the bottom.
   Inspired by Raymond Hull's classic self-management advice — named as inspiration, no
   quoted material.
2. **Why stories matter** — a goal without its story cannot be broken down well; the app
   asks and remembers so the steps fit your life, not a template.
3. **Privacy in one paragraph** — everything is encrypted on the device with your keys;
   the server (when sync exists) stores unreadable blobs; nobody, including the operator,
   can read the list. Honest limits: an unlocked device in foreign hands, and whoever runs
   the model sees plaintext while it thinks.
4. **The claim** — "tenfold — get what you want."

No marketing tone, no self-praise, no AI-tell phrasing. Short paragraphs, generous type.

## Tests

Playwright, headless. `tests/*.spec.js` load the ES modules directly in an empty page via a
small static server. What counts: crypto round trip, every envelope alone, tamper detection,
merge behaviour, cycle guard, duel correctness, plaintext-leak test, i18n key-set equality,
and the full-chain integration spec (`tests/integration.spec.js`).
