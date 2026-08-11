// The caller gate of the model relay - the decision, and nothing around it.
//
// Why this is a file of its own: the two functions below are pure. They read
// no disk, open no socket, know no clock of their own, and importing them
// starts nothing. That makes the rule testable directly (tests/llmgate.spec.js)
// including the case a test cannot drive through a live server - a CLOUD
// target, which is https-only against five fixed provider hosts and therefore
// unreachable from a local sink. serve.js keeps the state, the HTTP and the
// notification; this file keeps the decision.
//
// No dependency, and none may be added: tools/serve.js imports it.

/**
 * May this caller use this upstream?
 *
 * The wall in front of the relay now has TWO layers. The first is the target
 * allowlist (serve.js: upstreamTarget), which applies to everybody. This is the
 * second: when the target is one of the operator's own LOCAL models, the caller
 * must be an id the operator allowed by hand. A cloud target is never gated
 * here - the caller sends their own API key and pays their own bill, so there
 * is nothing of the operator's to protect.
 *
 * @param {{targetLocal: boolean, localRequest: boolean, syncId: string, allowed: string[]}} input
 *   targetLocal  - the upstream matched TENFOLD_LLM_UPSTREAMS
 *   localRequest - genuinely this machine (loopback AND no cf-connecting-ip)
 *   syncId       - the vault whose write token the caller proved, "" if none
 *   allowed      - the operator's allowlist
 * @returns {{pass: boolean, reason: string, syncId: string}}
 */
export function gateDecision(input) {
  const targetLocal = input && input.targetLocal === true;
  const localRequest = input && input.localRequest === true;
  const syncId = input && typeof input.syncId === "string" ? input.syncId : "";
  const allowed = input && Array.isArray(input.allowed) ? input.allowed : [];

  // Somebody else's model, somebody else's key: not the operator's business.
  if (!targetLocal) return { pass: true, reason: "cloud", syncId: "" };

  // A caller who proved a vault has a name, and the name decides. This holds
  // for a loopback caller too: on the operator's own machine the operator's own
  // id is the first one they allow, and a vault holder who reaches the relay
  // over the tunnel must not be judged by anything softer.
  if (syncId) {
    if (allowed.includes(syncId)) return { pass: true, reason: "allowed", syncId };
    return { pass: false, reason: "approval", syncId };
  }

  // Nobody in particular, but really this machine: the operator at their own
  // keyboard, the dev server, the test suite. That allowance is older than this
  // gate and stays exactly as wide as it was - loopback with no cf-connecting-ip
  // is by construction this host, because the only way in from outside is the
  // tunnel and the tunnel always sets that header.
  if (localRequest) return { pass: true, reason: "local", syncId: "" };

  // Unreachable through serve.js (the relay's own auth turns this caller away
  // with a 401 first) and deliberately kept: a gate that falls through open is
  // not a gate.
  return { pass: false, reason: "approval", syncId: "" };
}

/**
 * Records that an id asked. Mutates the map in place and says whether this is
 * the FIRST time - the notification fires on that and never per request, so a
 * client in a retry loop cannot turn into a mail loop.
 *
 * What a pending entry holds is the id, the first and last time it asked, and
 * how often. No IP, no user agent, no message, no upstream, nothing about what
 * was being asked for. The id is a capability for the mailbox, which is why it
 * lives in the data directory and is shown on the key-gated page only.
 *
 * @param {Object} pending the map, id -> {first, last, count}
 * @param {string} syncId
 * @param {number} now
 * @param {number} cap how many ids may wait at once
 * @returns {{isNew: boolean}}
 */
export function notePending(pending, syncId, now, cap) {
  const existing = pending[syncId];
  if (existing && typeof existing === "object") {
    existing.last = now;
    existing.count = (Number(existing.count) || 0) + 1;
    return { isNew: false };
  }
  // Full: the oldest first-seen entries go. A stranger who can mint sync ids
  // could otherwise grow this file without bound, and an old unanswered request
  // is the one worth losing - the id can simply ask again.
  const ids = Object.keys(pending);
  if (ids.length >= cap) {
    ids.sort((a, b) => (Number(pending[a].first) || 0) - (Number(pending[b].first) || 0));
    for (const id of ids.slice(0, ids.length - cap + 1)) delete pending[id];
  }
  pending[syncId] = { first: now, last: now, count: 1 };
  return { isNew: true };
}
