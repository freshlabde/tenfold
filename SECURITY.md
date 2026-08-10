# Security

tenfold is a zero-knowledge application: the server stores ciphertext it cannot
read, and the claim "nobody but you can see your list" is meant to hold against
the operator too. A bug that weakens that claim is the most serious kind this
project can have.

## Reporting a vulnerability

Write to **info@freshlab.es**. Please include what you found, where in the code
it lives, and - if you can - how to reproduce it. You will get an answer; give
us a reasonable window to fix and release before anything is published.

Please do NOT open a public issue for anything that touches:

- the crypto (`web/js/crypto.js`, key wrapping, the vault format),
- the sync mailbox or its tokens (`tools/serve.js`),
- the LLM relay and its SSRF wall,
- anything that could put plaintext or key material where it does not belong.

Everything else - UI bugs, layout, translations - is fine as a public issue.

## What is in scope

The promises the test suite enforces are the promises we consider binding:
no plaintext outside memory, no key material on the server, no HTML built from
user content, destruction requires proof of ability to open. If you can break
one of them, we want to know, whatever the path.
