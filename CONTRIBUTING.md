# Contributing

tenfold is small on purpose. Before you write code, it helps to know the rules
the codebase already lives by - most review feedback is one of these.

## The hard rules

- **No dependencies.** The app, the server and the tools are plain ES modules
  and Node built-ins. No frameworks, no build step, no third-party runtime
  code - the QR encoder/decoder, the spring physics and the VAPID JWT are all
  written here. `npm ci` installs Playwright for the tests, nothing else.
  A PR that adds a runtime dependency will be declined, whatever it saves.
- **No copyleft.** MIT in, MIT out. Do not vendor GPL/AGPL/LGPL code.
- **Zero knowledge is not negotiable.** Nothing may put plaintext or key
  material outside process memory: not in logs, not on the server, not in
  `localStorage`. `tools/serve.js` must stay free of crypto imports - a test
  asserts that.
- **No `innerHTML` with user content.** User text travels as text nodes only.
- **Contracts first.** `docs/CONTRACTS.md` is binding. If a change alters an
  interface or a promise, the contract changes in the same PR - and a
  contract change needs a maintainer's explicit yes.

## The soft rules

- English throughout: code, comments, commit messages. UI strings live in all
  three catalogues (`web/js/locales/{en,de,es}.js`) - `en` is the source of
  truth, and a key set that drifts fails the i18n spec.
- No emojis in the UI, none in code.
- Comments state constraints the code cannot show; they do not narrate.
- The service worker's `SHELL` list is hand-maintained; if you add a file the
  app needs offline, add it there (a drift test will remind you) and bump
  `VERSION` together with the three pinned specs.

## Tests

```bash
npm ci
npx playwright install chromium
npx playwright test
```

The suite drives the real app against real WebCrypto and IndexedDB - it is
slow on purpose (600k PBKDF2 rounds per unlock) and it is the definition of
done. A PR needs a green suite and, for any behaviour it adds or changes, a
spec that would fail without the change. Check exit codes, not output.
