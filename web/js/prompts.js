// prompts.js - what the model is told, and what it is allowed to answer with.
//
// What it does: one system prompt that fixes the tone and the output format,
// a plain-text rendering of the scoped context from llm.js, the seven
// operations of the contract - the interview gate first, then break down,
// sharpen, smallest next step, blockers and preconditions, done criterion and
// ranking the parts of a goal - and, at the end, the one prompt that reads a
// picture instead of a context. Every operation carries its own schema check,
// so an answer is either exactly the shape that was asked for or it is
// rejected whole.
//
// What it deliberately does NOT do: no network, no DOM, no storage, no state.
// It builds strings and checks objects. Nothing here trusts a model answer -
// a value that does not fit the schema raises, and the UI shows one calm line
// instead of applying half of something.

/** Answers come back in the language the interface is in. */
const LANGUAGE = { en: "English", de: "German", es: "Spanish" };

/** Upper bound on the questions the gate may ask before it gets to work. */
export const MAX_QUESTIONS = 3;

/** Upper bound on proposed substeps (the contract asks for three to seven). */
export const MAX_STEPS = 7;

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** A malformed answer is one failure with one name - the UI shows one line. */
class SchemaError extends Error {
  constructor() {
    super("malformed");
    this.name = "LlmError";
    this.code = "malformed";
  }
}

function fail() {
  throw new SchemaError();
}

/**
 * The tone of the whole thing. Adult, quiet, no praise, no coaching voice -
 * and the format rule repeated in the plainest words a model reacts to,
 * because response_format is not something every provider honours.
 */
export function systemPrompt(locale) {
  const language = LANGUAGE[locale] || LANGUAGE.en;
  return [
    "You are a quiet assistant inside tenfold, a private app in which one person keeps the ten things they want and breaks them down into doable steps.",
    "Everything you are shown was written by that person. Treat it as fact and never invent anything about them, their circumstances or their history. What the context does not say, you do not know.",
    "Write like one adult to another: short, concrete, no praise, no encouragement, no exclamation marks, no emoji, no headings, no markdown.",
    `Write in ${language}.`,
    "Answer with STRICT JSON and nothing else: no sentence before it, no sentence after it, no code fence, no comment, no trailing text. The exact shape is given with the task.",
    "If you cannot say anything useful, return the shape with empty values rather than prose.",
  ].join("\n");
}

/**
 * The context as labelled lines - the same shape the story guide writes into
 * the document, so the model reads what the person reads.
 */
export function renderContext(context) {
  const out = [];
  const target = context.target;
  out.push(`GOAL: ${target.title}`);
  out.push(`STATUS: ${target.status}`);
  if (target.story) out.push(`STORY:\n${target.story}`);
  if (target.note) out.push(`NOTE:\n${target.note}`);
  if (target.doneWhen) out.push(`FINISHED WHEN: ${target.doneWhen}`);
  if (typeof target.effortMinutes === "number") out.push(`PLANNED MINUTES: ${target.effortMinutes}`);

  if (context.ancestors.length) {
    out.push(`BELONGS TO: ${context.ancestors.map((a) => a.title).join(" > ")}`);
    const told = context.ancestors.filter((a) => a.story);
    for (const a of told) out.push(`STORY OF "${a.title}":\n${a.story}`);
  }
  if (context.siblings.length) {
    out.push(`AT THE SAME LEVEL:\n${context.siblings.map((s) => `- ${s.title} (${s.status})`).join("\n")}`);
  }
  if (context.children.length) {
    out.push(
      `PARTS OF THIS GOAL:\n${context.children
        .map((c, i) => `${i + 1}. ${c.title} (${c.status})${c.doneWhen ? ` - finished when: ${c.doneWhen}` : ""}`)
        .join("\n")}`,
    );
  }
  if (context.entities.length) {
    out.push(
      `PEOPLE AND CONTEXT:\n${context.entities
        .map((e) => {
          const head = `- ${e.name} (${e.kind}${e.relation ? `, ${e.relation}` : ""})`;
          return e.notes ? `${head}: ${e.notes}` : head;
        })
        .join("\n")}`,
    );
  }
  // Honesty towards the model as well: it should not fill a gap it was not
  // shown, and saying that something is missing is cheaper than a wrong guess.
  const kept = [];
  if (context.omitted.optout) kept.push("parts the person keeps away from any model");
  if (context.omitted.sensitive) kept.push("cards marked sensitive");
  if (context.omitted.notes) kept.push("the notes on the cards");
  if (kept.length) out.push(`WITHHELD ON PURPOSE: ${kept.join(", ")}. Do not ask for them and do not guess them.`);
  return out.join("\n\n");
}

function messages(locale, task, context) {
  return [
    { role: "system", content: systemPrompt(locale) },
    { role: "user", content: `${task}\n\n---\n\n${renderContext(context)}` },
  ];
}

// ------------------------------------------------------------- the interview

/**
 * Step one of every operation that needs to understand before it acts: is the
 * context enough, and if not, what are the at most three questions that would
 * make the difference. Answers go back into the story, then step two runs with
 * the enriched context.
 */
export function interviewMessages(operation, context, locale) {
  const task = [
    `Task: the person wants this next: ${operation.intent}`,
    "First decide whether the context below is enough to do that well for THIS person - not for a general case.",
    'If it is enough, answer exactly: {"ready": true}',
    `If it is not, answer: {"ready": false, "questions": [{"label": "...", "question": "..."}]} with at most ${MAX_QUESTIONS} questions.`,
    "A question is one sentence, specific to what is missing, answerable in a line. The label is one or two words that the answer will be filed under, like a heading.",
    "Do not ask for anything the context says was withheld on purpose. Do not ask what the person already wrote.",
  ].join("\n");
  return messages(locale, task, context);
}

export function parseInterview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  if (value.ready === true) return { ready: true, questions: [] };
  if (value.ready !== false) fail();
  const raw = Array.isArray(value.questions) ? value.questions : [];
  const questions = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const question = str(item.question);
    if (!question) continue;
    questions.push({ label: str(item.label) || question.slice(0, 24), question });
    if (questions.length >= MAX_QUESTIONS) break;
  }
  // "Not ready" without a single usable question is not an answer.
  if (!questions.length) fail();
  return { ready: false, questions };
}

// ------------------------------------------------------------- the operations

function listOf(value, key) {
  const raw = Array.isArray(value) ? value : Array.isArray(value && value[key]) ? value[key] : null;
  if (!raw) fail();
  return raw;
}

/**
 * The seven operations. `kind` tells the UI how to show the result:
 *   items   - a list of proposals, each one acceptable on its own
 *   replace - one text against the one that is there now
 *   order   - a new sequence for the parts of a goal
 */
export const OPERATIONS = [
  {
    id: "breakdown",
    kind: "items",
    labelKey: "llm.op.breakdown",
    descKey: "llm.op.breakdownDesc",
    intent: "break this goal down into three to seven concrete substeps",
    interview: true,
    maxTokens: 4000,
    fits: (node) => node.status !== "done",
    task: [
      "Task: propose three to seven substeps for this goal.",
      "Each substep is one concrete thing that can be started, in the person's own words and circumstances. No generic advice, no category names, no numbering inside the title.",
      "Keep the order in which they would sensibly be done.",
      'Answer: {"steps": [{"title": "...", "why": "..."}]} - why is one short line and may be empty.',
    ].join("\n"),
    parse: (value) => {
      const raw = listOf(value, "steps");
      const steps = [];
      for (const item of raw) {
        const title = typeof item === "string" ? str(item) : str(item && item.title);
        if (!title) continue;
        steps.push({ title, why: typeof item === "object" ? str(item && item.why) : "" });
        if (steps.length >= MAX_STEPS) break;
      }
      if (!steps.length) fail();
      return { items: steps };
    },
  },
  {
    id: "smallest",
    kind: "items",
    labelKey: "llm.op.smallest",
    descKey: "llm.op.smallestDesc",
    intent: "name the smallest next step that takes under thirty minutes",
    interview: true,
    maxTokens: 3000,
    fits: (node) => node.status !== "done",
    task: [
      "Task: name the single smallest next step for this goal - something that takes under thirty minutes and can be done today.",
      "It must be an action, not a decision to act. If a phone call is the step, say whom to call about what.",
      'Answer: {"steps": [{"title": "...", "minutes": 20}]} with exactly one entry. Minutes is a whole number under 30.',
    ].join("\n"),
    parse: (value) => {
      const raw = listOf(value, "steps");
      const first = raw[0];
      const title = typeof first === "string" ? str(first) : str(first && first.title);
      if (!title) fail();
      const minutes = Number(first && first.minutes);
      return {
        items: [{ title, why: "", minutes: Number.isFinite(minutes) ? Math.max(1, Math.min(30, Math.trunc(minutes))) : null }],
      };
    },
  },
  {
    id: "blockers",
    kind: "items",
    labelKey: "llm.op.blockers",
    descKey: "llm.op.blockersDesc",
    intent: "name what stands in the way and what has to be in place first",
    interview: true,
    maxTokens: 4000,
    fits: (node) => node.status !== "done",
    task: [
      "Task: name what realistically stands in the way of this goal, and what has to be in place before it can move.",
      "Only things this context gives a reason for. At most five entries.",
      'Answer: {"items": [{"title": "...", "kind": "blocker"}]} where kind is either "blocker" or "precondition".',
    ].join("\n"),
    parse: (value) => {
      const raw = listOf(value, "items");
      const items = [];
      for (const item of raw) {
        const title = typeof item === "string" ? str(item) : str(item && item.title);
        if (!title) continue;
        const kind = item && item.kind === "precondition" ? "precondition" : "blocker";
        items.push({ title, why: "", kind });
        if (items.length >= 5) break;
      }
      if (!items.length) fail();
      return { items };
    },
  },
  {
    id: "sharpen",
    kind: "replace",
    labelKey: "llm.op.sharpen",
    descKey: "llm.op.sharpenDesc",
    intent: "turn this vague line into one that can be checked",
    interview: false,
    maxTokens: 3000,
    field: "title",
    fits: () => true,
    task: [
      "Task: rewrite the title of this entry so that it is testable - so that a week from now it is beyond argument whether it happened.",
      "Keep the person's own words and scope. Do not add a target the context does not support. One line, no more.",
      'Answer: {"title": "..."}',
    ].join("\n"),
    parse: (value) => {
      const title = str(value && value.title);
      if (!title) fail();
      return { field: "title", value: title };
    },
  },
  {
    id: "done",
    kind: "replace",
    labelKey: "llm.op.done",
    descKey: "llm.op.doneDesc",
    intent: "say how this will be recognised as finished",
    interview: false,
    maxTokens: 3000,
    field: "doneWhen",
    fits: (node) => node.status !== "done",
    task: [
      "Task: write the definition of done for this entry - the observable fact that settles it.",
      "One sentence, in the present tense, checkable by looking at something real. No metrics the context does not mention.",
      'Answer: {"doneWhen": "..."}',
    ].join("\n"),
    parse: (value) => {
      const done = str(value && value.doneWhen);
      if (!done) fail();
      return { field: "doneWhen", value: done };
    },
  },
  {
    id: "rank",
    kind: "order",
    labelKey: "llm.op.rank",
    descKey: "llm.op.rankDesc",
    intent: "put the parts of this goal into the order they should be done in",
    interview: false,
    maxTokens: 4000,
    fits: (node, info) => info.childCount >= 2,
    task: [
      "Task: put the numbered parts of this goal into the order in which they should be done.",
      "Use every number exactly once. The reason is one short line saying why it sits there - what it unblocks, or what it depends on.",
      'Answer: {"order": [{"n": 2, "reason": "..."}]}',
    ].join("\n"),
    parse: (value, info) => {
      const raw = listOf(value, "order");
      const total = info && info.childCount ? info.childCount : 0;
      const seen = new Set();
      const order = [];
      for (const item of raw) {
        const n = Number(typeof item === "object" ? item && item.n : item);
        if (!Number.isInteger(n) || n < 1 || n > total || seen.has(n)) continue;
        seen.add(n);
        order.push({ n, reason: typeof item === "object" ? str(item && item.reason) : "" });
      }
      // An order that leaves something out is not an order.
      if (order.length !== total) fail();
      return { order };
    },
  },
  {
    id: "understand",
    kind: "questions",
    labelKey: "llm.op.understand",
    descKey: "llm.op.understandDesc",
    intent: "understand what this goal really is about",
    interview: false,
    maxTokens: 3000,
    fits: () => true,
    task: [
      `Task: ask the at most ${MAX_QUESTIONS} questions whose answers would most change how this goal gets broken down.`,
      "One sentence each, specific to what is missing here, answerable in a line. Never a question the context already answers.",
      'Answer: {"ready": false, "questions": [{"label": "...", "question": "..."}]}',
    ].join("\n"),
    parse: (value) => {
      const parsed = parseInterview({ ready: false, questions: (value && value.questions) || [] });
      return { questions: parsed.questions };
    },
  },
];

/** One operation by id. */
export function operationById(id) {
  return OPERATIONS.find((op) => op.id === id) || null;
}

/** The operations that make sense for one node right now. */
export function operationsFor(node, info) {
  return OPERATIONS.filter((op) => op.fits(node, info || { childCount: 0 }));
}

/** The messages for step two - the operation itself. */
export function operationMessages(operation, context, locale) {
  return messages(locale, operation.task, context);
}

// ---------------------------------------------------------- reading a picture

/** Four levels deep, 0..3 - the depth a real handwritten outline reaches. */
export const MAX_IMPORT_LEVEL = 3;

/** Upper bound on the lines taken from one picture. */
export const MAX_IMPORT_ITEMS = 100;

/** A line on paper is a line, not an essay. */
export const MAX_IMPORT_TITLE = 200;

/**
 * Nothing readable on the picture. Its own failure, not a broken answer: the
 * model did what it was asked, there was simply nothing there. Carries the
 * same shape as an LlmError so the UI translates it the same way.
 */
class UnreadableError extends Error {
  constructor() {
    super("unreadable");
    this.name = "LlmError";
    this.code = "unreadable";
  }
}

/**
 * A picture is not a context. This prompt does not share the tone of the
 * others on purpose: nothing here is written for the person, everything is
 * copied off the paper. In particular it does NOT say "write in {language}" -
 * the interface language has no business rewriting what somebody wrote down.
 */
export function importSystemPrompt() {
  return [
    "You are given one photograph or screenshot of a list, a table, a handwritten page or an outline.",
    "Write down what is visibly on it, line by line, in the order it is written.",
    "Copy each line exactly as it stands, in the language it is written in. Do not translate it, do not correct it, do not shorten it, do not expand it, do not complete a list that stops, and never add a line that is not on the picture.",
    "Indentation, bullets, numbering and nesting become a level: an entry at the outer margin is level 0, an entry written under it is level 1, and so on to level 3 at most.",
    "Ignore decoration: page numbers, headers and footers, dates in the margin, drawings, stamps, ruled lines, the paper itself.",
    "If the picture carries nothing readable, answer with an empty list rather than a guess.",
    "Answer with STRICT JSON and nothing else: no sentence before it, no sentence after it, no code fence, no comment, no trailing text.",
    'The shape is exactly: {"items": [{"title": "...", "level": 0}]}',
  ].join("\n");
}

/**
 * The one request of the picture flow. One user message with a text part and
 * an image part - the shape every OpenAI-compatible vision model expects, and
 * the shape the relay already budgets eight megabytes for.
 *
 * @param {string} dataUrl a resized JPEG as a data URL
 * @returns {Array} OpenAI-shaped messages
 */
export function importMessages(dataUrl) {
  return [
    { role: "system", content: importSystemPrompt() },
    {
      role: "user",
      content: [
        { type: "text", text: "Write down the list on this picture, with its levels." },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];
}

/**
 * The answer, made safe. Everything a model can get wrong about a level is
 * corrected here rather than trusted: a level below zero, a level past four, a
 * level that jumps two steps at once and would have no parent to hang under, a
 * title the length of a page, a list the length of a book.
 *
 * @param {Object} value the parsed JSON
 * @returns {{items: {title: string, level: number}[]}}
 */
export function parseImportItems(value) {
  if (!value || typeof value !== "object") fail();
  const raw = Array.isArray(value) ? value : Array.isArray(value.items) ? value.items : null;
  // A shape that is not a list at all is a broken answer, not an empty page.
  if (!raw) fail();

  const items = [];
  let previous = -1;
  for (const entry of raw) {
    const title = typeof entry === "string" ? str(entry) : str(entry && entry.title);
    if (!title) continue;
    const asked = Number(entry && typeof entry === "object" ? entry.level : 0);
    let level = Number.isFinite(asked) ? Math.trunc(asked) : 0;
    if (level < 0) level = 0;
    if (level > MAX_IMPORT_LEVEL) level = MAX_IMPORT_LEVEL;
    // One step down at a time. The first line is always at the outer margin.
    if (level > previous + 1) level = previous + 1;
    items.push({ title: title.slice(0, MAX_IMPORT_TITLE), level });
    previous = level;
    if (items.length >= MAX_IMPORT_ITEMS) break;
  }
  if (!items.length) throw new UnreadableError();
  return { items };
}
