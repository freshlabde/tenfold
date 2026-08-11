// llm.js - the third and last module in this app that may touch the network,
// and the only one that ever assembles something a model gets to read.
//
// What it does: decides what a request is allowed to know (the target node,
// its chain, its immediate neighbourhood, the stories along it and the linked
// cards - never the whole tree), posts that to the same-origin relay, and
// pulls a strictly shaped JSON answer out of whatever the model wrote back.
//
// What it deliberately does NOT do: it never writes to the document - every
// result is a proposal the UI offers and the person accepts item by item. It
// calls same-origin /api/llm only; the provider address lives in the sealed
// settings and travels as a field, so this module holds no foreign URL. It
// never sends an opted-out node, never a sensitive card without an explicit
// release for that one call, and in cloud mode never the notes on a card
// unless they were released the same way. It parses with JSON.parse and
// nothing else - a model answer is untrusted text, exactly like a note.

import { deriveSyncAuthToken } from "./crypto.js";
import { ancestorsOf, childrenOf, isOptedOut } from "./model.js";
import { entityById } from "./entities.js";
import { syncMeta } from "./sync.js";

/** Same trick as sync.js and push.js: the app also lives under /tenfold. */
const API_BASE = location.pathname.startsWith("/tenfold/") ? "/tenfold/api/" : "/api/";

/** The neighbourhood is a neighbourhood, not a tree walk. */
export const MAX_SIBLINGS = 12;
export const MAX_CHILDREN = 20;
export const MAX_ENTITIES = 12;

/** Failure reasons the UI can translate. Never a server text, never a stack. */
export class LlmError extends Error {
  constructor(code) {
    super(code);
    this.name = "LlmError";
    this.code = code;
  }
}

// ------------------------------------------------------------------ settings

/** The assistance settings of a document, always a defined object. */
export function llmSettings(doc) {
  const value = doc && doc.settings && doc.settings.llm;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** @returns {"off"|"local"|"cloud"} */
export function llmMode(doc) {
  const mode = llmSettings(doc).mode;
  return mode === "local" || mode === "cloud" ? mode : "off";
}

/** True when assistance is switched on at all. In "off" it is absent, not hidden. */
export function llmEnabled(doc) {
  return llmMode(doc) !== "off";
}

/** True when a node may be shown to a model at all. */
export function nodeAllowed(doc, nodeId) {
  if (!doc || !Array.isArray(doc.nodes)) return false;
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node || node.deletedAt) return false;
  return !isOptedOut(doc.nodes, nodeId);
}

// ------------------------------------------------------------- context build

function line(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function trimmedNode(node) {
  return {
    id: node.id,
    title: line(node.title),
    status: node.status,
    story: line(node.story),
    note: line(node.note),
    doneWhen: line(node.doneWhen),
    effortMinutes: typeof node.effortMinutes === "number" ? node.effortMinutes : null,
  };
}

/**
 * Everything one request may know, and nothing else.
 *
 * Pure: same document and same options always give the same object, no clock,
 * no storage, no network. That is what makes the filters testable, and the
 * filters are the whole point of this function.
 *
 * @param {Object} doc the open document
 * @param {string} nodeId the node the request is about
 * @param {{mode?: string, releaseSensitive?: boolean, releaseNotes?: boolean}} [opts]
 * @returns {Object|null} null when the node itself is kept away from the model
 */
export function buildContext(doc, nodeId, opts = {}) {
  const nodes = doc && Array.isArray(doc.nodes) ? doc.nodes : [];
  const entities = doc && Array.isArray(doc.entities) ? doc.entities : [];
  const node = nodes.find((n) => n.id === nodeId);
  if (!node || node.deletedAt) return null;
  // Fail closed: an opted-out node has no context, not a reduced one.
  if (isOptedOut(nodes, nodeId)) return null;

  const mode = opts.mode === "cloud" ? "cloud" : "local";
  const omitted = { optout: 0, sensitive: 0, notes: false };
  const open = (id) => {
    if (isOptedOut(nodes, id)) {
      omitted.optout += 1;
      return false;
    }
    return true;
  };

  const chain = ancestorsOf(nodes, nodeId).filter((a) => !a.deletedAt && open(a.id));
  const siblings = childrenOf(nodes, node.parentId)
    .filter((n) => n.id !== nodeId && open(n.id))
    .slice(0, MAX_SIBLINGS);
  const children = childrenOf(nodes, nodeId).filter((n) => open(n.id)).slice(0, MAX_CHILDREN);

  // The cards of the step and of the goals it hangs under - the people and
  // places that make the step what it is, and nothing beyond that chain.
  const refs = [];
  for (const source of [...chain, node]) {
    for (const id of Array.isArray(source.entityRefs) ? source.entityRefs : []) {
      if (!refs.includes(id)) refs.push(id);
    }
  }
  const cards = [];
  for (const id of refs) {
    const card = entityById(entities, id);
    if (!card || card.deletedAt) continue;
    if (card.sensitivity === "high" && !opts.releaseSensitive) {
      omitted.sensitive += 1;
      continue;
    }
    // In cloud mode a card's history stays on the device unless it was
    // released for this one call. Name and relation may travel: without them
    // the card says nothing at all.
    const withNotes = mode === "local" || opts.releaseNotes === true;
    if (!withNotes && line(card.notes)) omitted.notes = true;
    cards.push({
      name: line(card.name),
      kind: card.kind,
      relation: line(card.relation),
      notes: withNotes ? line(card.notes) : "",
    });
    if (cards.length >= MAX_ENTITIES) break;
  }

  return {
    mode,
    target: trimmedNode(node),
    ancestors: chain.map((a) => ({ title: line(a.title), story: line(a.story) })),
    siblings: siblings.map((s) => ({ title: line(s.title), status: s.status })),
    children: children.map((c) => ({
      id: c.id,
      title: line(c.title),
      status: c.status,
      doneWhen: line(c.doneWhen),
    })),
    entities: cards,
    omitted,
    // What the prompt will be made of, countable: a test can assert that a
    // request never grows with the tree.
    nodeCount: 1 + chain.length + siblings.length + children.length,
  };
}

// -------------------------------------------------------------- json rescue

/**
 * The first JSON object or array inside a model answer.
 *
 * Models add fences, a sentence in front, a sentence behind, sometimes both.
 * This walks the text with a depth counter that knows about strings and
 * escapes and hands the slice to JSON.parse. No eval, no Function, no regex
 * that pretends to be a parser.
 *
 * @param {string} text
 * @returns {Object|Array} the parsed value
 */
export function extractJson(text) {
  const source = String(text || "");
  const start = (() => {
    for (let i = 0; i < source.length; i += 1) {
      if (source[i] === "{" || source[i] === "[") return i;
    }
    return -1;
  })();
  if (start < 0) throw new LlmError("malformed");

  const openChar = source[start];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          throw new LlmError("malformed");
        }
      }
    }
  }
  throw new LlmError("malformed");
}

/** The assistant's text out of an OpenAI-shaped answer. */
/**
 * Some reasoning models put their thinking INSIDE the content as
 * <think>...</think> blocks (DeepSeek-R1 style). That text may contain
 * stray braces, so it must go before any JSON is extracted. An unclosed
 * block (thinking cut off by the budget) strips to the end.
 */
function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}

export function answerText(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const message = choice && choice.message;
  let content = message && message.content;
  if (typeof content === "string") content = stripThinking(content);
  // Reasoning models spend tokens thinking before they answer. When the
  // budget ran out mid-thought the content comes back empty (or was pure
  // thinking) with finish_reason "length" - a distinct, explainable and
  // RETRYABLE failure, not a malformed answer (verified live against
  // gemma via LM Studio; cloud reasoning models behave the same way).
  if (
    choice &&
    choice.finish_reason === "length" &&
    (content === "" || content === null || content === undefined)
  ) {
    throw new LlmError("budget");
  }
  if (typeof content === "string") return content;
  // Some providers answer with content parts instead of a plain string.
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }
  throw new LlmError("malformed");
}

// ----------------------------------------------------------------- the call

/**
 * The narrow context, handed over once at boot. It carries the master key,
 * because the relay wants the same write token the sync PUT uses - and only a
 * device that can open the vault can derive that.
 */
let boundCtx = null;

export function bindContext(ctx) {
  boundCtx = ctx;
}

/**
 * The token, or null. Null is not a failure: a request from this machine is
 * accepted by the relay without one, which is the normal case for a local
 * model on the same computer.
 */
async function authToken() {
  if (!boundCtx) return null;
  const meta = syncMeta(boundCtx.vault);
  if (!meta || !boundCtx.masterKey) return null;
  try {
    return await deriveSyncAuthToken(boundCtx.masterKey, meta.authSalt);
  } catch {
    return null;
  }
}

function endpointUrl() {
  return `${API_BASE}llm`;
}

/**
 * One request. Returns the upstream answer verbatim; reading it is the
 * caller's job (answerText + extractJson + the operation's own check).
 *
 * @param {Object} llm doc.settings.llm
 * @param {Array} messages OpenAI-shaped messages
 * @param {{maxTokens?: number, temperature?: number, signal?: AbortSignal}} [opts]
 */
export async function call(llm, messages, opts = {}) {
  const settings = llm && typeof llm === "object" ? llm : {};
  if (settings.mode !== "local" && settings.mode !== "cloud") throw new LlmError("off");
  const upstream = line(settings.baseUrl);
  const model = line(settings.model);
  if (!upstream || !model) throw new LlmError("config");

  const headers = { "Content-Type": "application/json" };
  const token = await authToken();
  if (token) headers["X-Sync-Token"] = token;

  const body = {
    upstream,
    model,
    messages,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 0.2,
  };
  if (Number.isFinite(opts.maxTokens)) body.maxTokens = Math.trunc(opts.maxTokens);
  // Local reasoning models otherwise think their whole budget away before
  // answering; the relay forwards this to local upstreams only.
  if (settings.mode === "local") body.reasoningEffort = "low";
  // A local model usually wants no key; when one is set it is sent for both
  // modes, because some local servers are configured to ask for one.
  if (line(settings.apiKey)) body.apiKey = line(settings.apiKey);

  let res;
  try {
    res = await fetch(endpointUrl(), {
      method: "POST",
      cache: "no-store",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch {
    throw new LlmError("offline");
  }
  if (res.status === 401) throw new LlmError("denied");
  if (res.status === 403) {
    // Two different refusals share the status: an address this server does not
    // allow, and a caller the operator has not allowed for their local models
    // yet. The second one is answerable ("ask the operator"), so it gets its
    // own code and its own sentence instead of the address error.
    const detail = await res.json().catch(() => null);
    throw new LlmError(detail && detail.error === "llm-approval" ? "approval" : "upstream");
  }
  if (res.status === 413) throw new LlmError("tooLarge");
  if (res.status === 429) throw new LlmError("busy");
  if (res.status === 504) throw new LlmError("timeout");
  if (!res.ok) throw new LlmError("server");
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== "object") throw new LlmError("malformed");
  return data;
}

/** The retry ceiling: generous for local models, still a sane cloud cap. */
const BUDGET_RETRY_MAX = 8000;

/**
 * call() plus answerText(), with ONE automatic retry at twice the budget
 * when the model thought its whole allowance away (LlmError "budget").
 * Local and cloud reasoning models fail the same way, so this is the
 * provider-agnostic robustness layer; every other error passes through
 * untouched and nothing ever retries more than once.
 */
export async function callForText(llm, messages, opts = {}) {
  try {
    return answerText(await call(llm, messages, opts));
  } catch (err) {
    const budget = Number.isFinite(opts.maxTokens) ? opts.maxTokens : 0;
    if (!(err instanceof LlmError) || err.code !== "budget" || !budget || budget >= BUDGET_RETRY_MAX) {
      throw err;
    }
    const raised = Math.min(BUDGET_RETRY_MAX, budget * 2);
    return answerText(await call(llm, messages, { ...opts, maxTokens: raised }));
  }
}
