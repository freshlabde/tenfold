// aihelp.js - the copy loop, and the two pure halves it is made of.
//
// What it does: builds the text a person carries to whatever AI they already
// use, and reads the answer they bring back. Out is a prompt: the goal, where
// it sits, its story, the steps under it and the names on the cards linked to
// it, written in the language the app is in, ending in the one demand that
// makes the way back work - a fenced JSON block. Back in is that block, or an
// indented outline when a model ignored the demand, and either becomes steps
// under the same node.
//
// What it deliberately does NOT do: it does not fetch, does not touch the DOM,
// does not read storage and holds no state. It is a string builder and a text
// parser, and both are pure - the same document and the same text always give
// the same result. It never writes to the document either: the parser returns
// lines, the sheet shows them, and only a press applies them.
//
// The scoping rules below are the whole point of the first half. What a person
// keeps away from a model never enters the prompt, and neither does a card they
// marked sensitive, nor the notes on any card - the text is going to leave this
// device by hand, to a service nobody here has a contract with. The vault, the
// sync id, the recovery material and the settings have no representation in
// this file at all; they cannot be forgotten out because they were never in.

import { ancestorsOf, childrenOf, isOptedOut } from "./model.js";
import { entityById } from "./entities.js";

/** The neighbourhood is a neighbourhood, not a tree walk. */
export const MAX_CHILDREN = 20;
export const MAX_ENTITIES = 12;

/** Four levels deep, 0..3 - the depth a real outline reaches. */
export const MAX_OUTLINE_LEVEL = 3;

/** Upper bound on the lines taken out of one answer. */
export const MAX_OUTLINE_ITEMS = 100;

/** A step is a line, not an essay. */
export const MAX_OUTLINE_TITLE = 200;

function line(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

// ------------------------------------------------------------ what may travel

/**
 * Everything one prompt may know, and nothing else.
 *
 * Ported from the context builder of the relay, with the two per-call releases
 * removed: there is no single request to release something for here. The text
 * goes to the clipboard, and from there wherever the person takes it, so the
 * strict answer is the only honest one - sensitive cards stay, card notes stay,
 * an opted-out branch is not reduced but absent.
 *
 * @param {Object} doc the open document
 * @param {string} nodeId the node the prompt is about
 * @returns {Object|null} null when the node itself is kept away from models
 */
export function buildCopyContext(doc, nodeId) {
  const nodes = doc && Array.isArray(doc.nodes) ? doc.nodes : [];
  const entities = doc && Array.isArray(doc.entities) ? doc.entities : [];
  const node = nodes.find((n) => n.id === nodeId);
  if (!node || node.deletedAt) return null;
  // Fail closed: an opted-out node has no context, not a reduced one.
  if (isOptedOut(nodes, nodeId)) return null;

  const omitted = { optout: 0, sensitive: 0, notes: false };
  const open = (id) => {
    if (isOptedOut(nodes, id)) {
      omitted.optout += 1;
      return false;
    }
    return true;
  };

  const chain = ancestorsOf(nodes, nodeId).filter((a) => !a.deletedAt && open(a.id));
  const children = childrenOf(nodes, nodeId)
    .filter((n) => open(n.id))
    .slice(0, MAX_CHILDREN);

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
    if (card.sensitivity === "high") {
      omitted.sensitive += 1;
      continue;
    }
    // The history on a card never travels this way. A name and what somebody
    // is to you make the card readable; the notes are the private half.
    if (line(card.notes)) omitted.notes = true;
    cards.push({ name: line(card.name), kind: card.kind, relation: line(card.relation) });
    if (cards.length >= MAX_ENTITIES) break;
  }

  return {
    target: {
      id: node.id,
      title: line(node.title),
      status: node.status,
      story: line(node.story),
      note: line(node.note),
      doneWhen: line(node.doneWhen),
      effortMinutes: typeof node.effortMinutes === "number" ? node.effortMinutes : null,
    },
    ancestors: chain.map((a) => ({ title: line(a.title) })),
    children: children.map((c) => ({ title: line(c.title), status: c.status })),
    entities: cards,
    omitted,
    // What the prompt will be made of, countable: a test can assert that it
    // never grows with the tree.
    nodeCount: 1 + chain.length + children.length,
  };
}

// ------------------------------------------------------------------ the words

/**
 * The prompt, in three languages. It lives here rather than in the catalogues
 * because it is not chrome: it is the one piece of writing in this app that is
 * addressed to a machine, and it has to read as one whole paragraph after
 * another, which a flat key list does not survive. The catalogues carry the
 * buttons and the honest line above them.
 *
 * `labels` are the headings inside the context block, `status` the four words
 * a step can stand in, `open`/`ask` the instruction around it.
 */
export const PROMPT = {
  en: {
    open: "I am unfolding one goal into steps I can actually do, and I would like your help with the next few.",
    here: "This is where it stands.",
    labels: {
      goal: "GOAL",
      belongsTo: "BELONGS TO",
      story: "STORY",
      note: "NOTE",
      doneWhen: "FINISHED WHEN",
      minutes: "PLANNED MINUTES",
      steps: "STEPS SO FAR",
      cards: "PEOPLE AND PLACES",
      withheld: "LEFT OUT ON PURPOSE",
    },
    status: { open: "open", doing: "in progress", done: "done", parked: "resting" },
    withheld: {
      optout: "parts I keep away from any model",
      sensitive: "cards I marked sensitive",
      notes: "the notes on the cards",
      tail: "Do not ask for them and do not guess them.",
    },
    ask: [
      "Two things, in this order.",
      "First: ask me up to three questions, and only the ones whose answers would really change what comes next. Then stop and wait for me.",
      "After I have answered: propose the next steps. Keep every step small enough to finish in one sitting, and write it in my words and my situation, not as general advice. If something important is missing, say so instead of inventing it.",
      'Then end your answer with a single code block, fenced with three backticks, holding nothing but a JSON array of those steps, exactly like this:\n\n```\n[{"step": "Call the practice on Monday", "substeps": ["Ask for the earliest slot", "Write the date on the fridge"]}]\n```\n\n"substeps" is optional - a step with nothing under it is just {"step": "..."}. No commentary inside the block, no second block, nothing after it. That is the deal: whatever else you write, end with that one code block.',
      "And if we keep talking after this, the same holds for every answer that follows: each one ends again with the complete, updated list in that same block - the whole list, not only the part that changed.",
    ],
  },
  de: {
    open: "Ich zerlege ein Ziel in Schritte, die ich wirklich tun kann, und hätte gern Hilfe bei den nächsten.",
    here: "So steht es gerade.",
    labels: {
      goal: "ZIEL",
      belongsTo: "GEHÖRT ZU",
      story: "GESCHICHTE",
      note: "NOTIZ",
      doneWhen: "FERTIG WENN",
      minutes: "GEPLANTE MINUTEN",
      steps: "SCHRITTE BISHER",
      cards: "MENSCHEN UND ORTE",
      withheld: "BEWUSST WEGGELASSEN",
    },
    status: { open: "offen", doing: "läuft", done: "erledigt", parked: "ruht" },
    withheld: {
      optout: "Teile, die ich von jedem Modell fernhalte",
      sensitive: "Karten, die ich als sensibel markiert habe",
      notes: "die Notizen auf den Karten",
      tail: "Frag nicht danach und rate sie nicht.",
    },
    ask: [
      "Zwei Dinge, in dieser Reihenfolge.",
      "Zuerst: stell mir bis zu drei Fragen, und nur die, deren Antworten wirklich etwas daran ändern, was als Nächstes kommt. Dann halt an und warte auf mich.",
      "Wenn ich geantwortet habe: schlag die nächsten Schritte vor. Halte jeden Schritt so klein, dass er in einem Zug fertig wird, und schreib ihn in meinen Worten und meiner Lage, nicht als allgemeinen Rat. Wenn etwas Wichtiges fehlt, sag das, statt es zu erfinden.",
      'Beende deine Antwort dann mit genau einem Codeblock, eingerahmt von drei Backticks, und schreib nichts hinein außer einem JSON-Array dieser Schritte, genau so:\n\n```\n[{"step": "Am Montag in der Praxis anrufen", "substeps": ["Nach dem frühesten Termin fragen", "Das Datum an den Kühlschrank schreiben"]}]\n```\n\n"substeps" ist optional - ein Schritt ohne etwas darunter ist einfach {"step": "..."}. Kein Kommentar im Block, kein zweiter Block, nichts danach. Das ist die Abmachung: was du sonst auch schreibst, hör mit diesem einen Codeblock auf.',
      "Und wenn wir danach weiterreden, gilt das für jede weitere Antwort genauso: jede endet wieder mit der vollständigen, aktualisierten Liste in genau diesem Block - der ganzen Liste, nicht nur dem, was sich geändert hat.",
    ],
  },
  es: {
    open: "Estoy desplegando un objetivo en pasos que pueda hacer de verdad, y me vendría bien tu ayuda con los siguientes.",
    here: "Así está ahora mismo.",
    labels: {
      goal: "OBJETIVO",
      belongsTo: "FORMA PARTE DE",
      story: "HISTORIA",
      note: "NOTA",
      doneWhen: "TERMINADO CUANDO",
      minutes: "MINUTOS PREVISTOS",
      steps: "PASOS HASTA AHORA",
      cards: "PERSONAS Y LUGARES",
      withheld: "OMITIDO A PROPÓSITO",
    },
    status: { open: "abierto", doing: "en curso", done: "hecho", parked: "en pausa" },
    withheld: {
      optout: "partes que mantengo lejos de cualquier modelo",
      sensitive: "fichas que marqué como sensibles",
      notes: "las notas de las fichas",
      tail: "No las pidas y no las adivines.",
    },
    ask: [
      "Dos cosas, en este orden.",
      "Primero: hazme hasta tres preguntas, solo aquellas cuya respuesta cambiaría de verdad lo que viene después. Luego para y espera.",
      "Cuando te haya respondido: propón los siguientes pasos. Mantén cada paso lo bastante pequeño como para terminarlo de una sentada, y escríbelo con mis palabras y mi situación, no como consejo general. Si falta algo importante, dilo en vez de inventarlo.",
      'Y termina tu respuesta con un único bloque de código, delimitado por tres acentos graves, sin nada dentro más que un array JSON de esos pasos, exactamente así:\n\n```\n[{"step": "Llamar a la consulta el lunes", "substeps": ["Pedir la cita más temprana", "Apuntar la fecha en la nevera"]}]\n```\n\n"substeps" es opcional - un paso sin nada debajo es simplemente {"step": "..."}. Sin comentarios dentro del bloque, sin un segundo bloque, nada después. Ese es el trato: escribas lo que escribas, acaba con ese único bloque de código.',
      "Y si seguimos hablando después, lo mismo vale para cada respuesta siguiente: cada una termina otra vez con la lista completa y actualizada en ese mismo bloque - la lista entera, no solo lo que ha cambiado.",
    ],
  },
};

/** The wording of a locale, English for anything unknown. */
function wordsFor(locale) {
  return PROMPT[locale] || PROMPT.en;
}

/**
 * The context as labelled lines, then the instruction. The context half is
 * plain text with no markup in it; the instruction half ends in a fenced
 * example, because the format demand is the last thing the model reads and an
 * example of a code block is best written as one.
 *
 * @param {Object} context the object buildCopyContext returned
 * @param {string} locale
 * @returns {string}
 */
export function renderPrompt(context, locale) {
  const w = wordsFor(locale);
  const L = w.labels;
  const target = context.target;
  const out = [`${w.open}\n${w.here}`];

  const block = [`${L.goal}: ${target.title}`];
  if (context.ancestors.length) {
    block.push(`${L.belongsTo}: ${context.ancestors.map((a) => a.title).join(" > ")}`);
  }
  if (target.story) block.push(`${L.story}:\n${target.story}`);
  if (target.note) block.push(`${L.note}:\n${target.note}`);
  if (target.doneWhen) block.push(`${L.doneWhen}: ${target.doneWhen}`);
  if (typeof target.effortMinutes === "number") {
    block.push(`${L.minutes}: ${target.effortMinutes}`);
  }
  if (context.children.length) {
    const steps = context.children
      .map((c, i) => `${i + 1}. ${c.title} (${w.status[c.status] || c.status})`)
      .join("\n");
    block.push(`${L.steps}:\n${steps}`);
  }
  if (context.entities.length) {
    const cards = context.entities
      .map((e) => `- ${e.name} (${e.kind}${e.relation ? `, ${e.relation}` : ""})`)
      .join("\n");
    block.push(`${L.cards}:\n${cards}`);
  }

  // Honesty towards the model as well: it should not fill a gap it was not
  // shown, and saying that something is missing is cheaper than a wrong guess.
  const kept = [];
  if (context.omitted.optout) kept.push(w.withheld.optout);
  if (context.omitted.sensitive) kept.push(w.withheld.sensitive);
  if (context.omitted.notes) kept.push(w.withheld.notes);
  if (kept.length) block.push(`${L.withheld}: ${kept.join(", ")}. ${w.withheld.tail}`);

  out.push(block.join("\n\n"));
  out.push(w.ask.join("\n\n"));
  return out.join("\n\n");
}

/**
 * The whole prompt for one node, or null when that node is kept away.
 *
 * @param {Object} doc
 * @param {string} nodeId
 * @param {string} locale
 * @returns {{text: string, context: Object}|null}
 */
export function buildPrompt(doc, nodeId, locale) {
  const context = buildCopyContext(doc, nodeId);
  if (!context) return null;
  return { text: renderPrompt(context, locale), context };
}

// ---------------------------------------------------------- reading an answer

/**
 * Levels, made safe. Everything that can be wrong about a level is corrected
 * here rather than trusted: a level below zero, a level past the last one, a
 * level that jumps two steps at once and would have no line to hang under, a
 * title the length of a page, a list the length of a book.
 *
 * This is the shared middle of both ways in - the photograph and the pasted
 * answer - and the only place those limits are written down.
 *
 * @param {Array} raw entries of `{title, level}` or plain strings
 * @returns {{title: string, level: number}[]}
 */
export function normalizeOutlineItems(raw) {
  // Strictly a string, exactly as the picture path always demanded: a title
  // that is a number is a broken entry, not a title with a number in it.
  const str = (value) => (typeof value === "string" ? value.trim() : "");
  const items = [];
  let previous = -1;
  for (const entry of Array.isArray(raw) ? raw : []) {
    const title = typeof entry === "string" ? str(entry) : str(entry && entry.title);
    if (!title) continue;
    const asked = Number(entry && typeof entry === "object" ? entry.level : 0);
    let level = Number.isFinite(asked) ? Math.trunc(asked) : 0;
    if (level < 0) level = 0;
    if (level > MAX_OUTLINE_LEVEL) level = MAX_OUTLINE_LEVEL;
    // One step down at a time. The first line is always at the outer margin.
    if (level > previous + 1) level = previous + 1;
    items.push({ title: title.slice(0, MAX_OUTLINE_TITLE), level });
    previous = level;
    if (items.length >= MAX_OUTLINE_ITEMS) break;
  }
  return items;
}

/** A tab is worth four columns, the way an editor shows it. */
const TAB_WIDTH = 4;

/** What a list marker looks like: a bullet, a number, a letter, a checkbox. */
const MARKERS = [
  /^[-*+•·–—]\s+/,
  /^\d+[.)]\s+/,
  /^[a-z][.)]\s+/i,
  /^#{1,6}\s+/,
];

/** A checkbox in front of a step, empty or ticked. */
const CHECKBOX = /^\[[\sxX]?\]\s*/;

/** Emphasis a chat window writes around a line. Stripped, never interpreted. */
const EMPHASIS = /^(\*\*|__|\*|_)(.+?)\1$/;

/** How wide the indentation of one line is, tabs counted as columns. */
function indentOf(text) {
  let width = 0;
  for (const ch of text) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += TAB_WIDTH - (width % TAB_WIDTH);
    else break;
  }
  return width;
}

/** The line without its bullet, its number, its checkbox or its asterisks. */
function stripMarkers(text) {
  let out = text.trim();
  for (const marker of MARKERS) {
    const next = out.replace(marker, "");
    if (next !== out) {
      out = next.trim();
      break;
    }
  }
  out = out.replace(CHECKBOX, "").trim();
  const emphasised = EMPHASIS.exec(out);
  if (emphasised) out = emphasised[2].trim();
  // A line that ends in a colon is a heading somebody wrote by hand; the colon
  // is punctuation for the eye and has no business in a step title.
  return out.replace(/\s*:$/, "").trim();
}

/**
 * An indented outline, as text, becomes lines with levels.
 *
 * The indentation is read RELATIVELY: a stack of the widths seen so far, so
 * two spaces, four spaces and a tab all mean the same thing as long as one
 * answer is consistent with itself. Nothing is dropped for looking like prose -
 * a person sees every line in the preview before anything is created, and
 * silently swallowing a line would be the worse failure.
 *
 * @param {string} text whatever was pasted
 * @returns {{items: {title: string, level: number}[]}}
 */
export function parseOutlineText(text) {
  const rows = [];
  const stack = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim()) {
      // A blank line ends nothing: an answer often has one between the steps.
      continue;
    }
    const width = indentOf(raw);
    const title = stripMarkers(raw);
    if (!title) continue;

    while (stack.length && width < stack[stack.length - 1]) stack.pop();
    if (!stack.length || width > stack[stack.length - 1]) stack.push(width);
    rows.push({ title, level: stack.length - 1 });
  }
  return { items: normalizeOutlineItems(rows) };
}

// ------------------------------------------------------- the answer, in order

/**
 * How deep a JSON answer is followed before the reader stops descending. The
 * levels are clamped to four either way; this is only a floor under the
 * recursion, so a hostile file of ten thousand nested arrays cannot take the
 * stack down with it.
 */
export const MAX_JSON_DEPTH = 12;

/** A line that opens or closes a fenced block, with its info string. */
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})[ \t]*(.*)$/;

/** A language tag a model wrote on its own line inside the block. */
const LANGUAGE_TAG = /^\s*(json5?|jsonc|javascript|js)\s*\r?\n/i;

/**
 * Every fenced code block in a paste, in the order they were written, without
 * their fences and without the info string on the opening one.
 *
 * A block that was opened and never closed still counts: a model that ran out
 * of room mid-answer wrote a block, and throwing it away would lose exactly the
 * part the person came for.
 *
 * @param {string} text whatever was pasted
 * @returns {string[]}
 */
export function fencedBlocks(text) {
  const blocks = [];
  let open = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const fence = FENCE_LINE.exec(raw);
    if (!open) {
      if (fence) open = { marker: fence[1], lines: [] };
      continue;
    }
    // A closing fence is the same character, at least as long, and alone on
    // its line. Anything else inside the block is content, fence or not.
    const closes =
      fence && fence[1][0] === open.marker[0] && fence[1].length >= open.marker.length && !fence[2].trim();
    if (closes) {
      blocks.push(open.lines.join("\n"));
      open = null;
      continue;
    }
    open.lines.push(raw);
  }
  if (open && open.lines.length) blocks.push(open.lines.join("\n"));
  return blocks;
}

/**
 * The documented schema, flattened to lines and levels.
 *
 * `[{"step": "...", "substeps": ["...", ...]}, ...]` - `substeps` optional, an
 * entry of it either a string or the same object again. Unknown keys are
 * ignored. A `step` that is not a string is a broken entry, the way it always
 * was on the photo path: the row goes in, the shaper drops it, and what hung
 * under it moves up a level rather than disappearing with it.
 */
function collectJsonItems(list, level, rows, depth) {
  if (!Array.isArray(list) || depth > MAX_JSON_DEPTH) return;
  for (const entry of list) {
    if (rows.length >= MAX_OUTLINE_ITEMS) return;
    if (typeof entry === "string") {
      rows.push({ title: entry, level });
      continue;
    }
    // A bare nested array is somebody's sublist. Read it rather than refuse it.
    if (Array.isArray(entry)) {
      collectJsonItems(entry, level + 1, rows, depth + 1);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    rows.push({ title: entry.step, level });
    collectJsonItems(entry.substeps, level + 1, rows, depth + 1);
  }
}

/**
 * The block as JSON, or null when it is not JSON at all.
 *
 * Strict: `JSON.parse`, no trailing commas, no repair pass, and the top level
 * has to be the array the prompt asked for. The only slack is the whitespace
 * around it and a language tag a model wrote inside the block instead of on
 * the fence. Anything else falls through to the text parser, which is the more
 * forgiving reader and was always there.
 *
 * @param {string} text the content of one block, or a whole paste
 * @returns {{title: unknown, level: number}[]|null}
 */
function jsonOutlineRows(text) {
  const body = String(text || "")
    .replace(LANGUAGE_TAG, "")
    .trim();
  if (!body.startsWith("[")) return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows = [];
  collectJsonItems(parsed, 0, rows, 0);
  return rows;
}

/**
 * What a paste means, in one fixed order. This is the way in for the sheet;
 * `parseOutlineText` below is one of the two readers it can end up using.
 *
 * 1. FENCED BLOCK FIRST. If the paste has fenced blocks, the LAST one is the
 *    answer and everything around it is chat. This is the whole fix for the
 *    real failure: a model that asks a question, thinks out loud, apologises,
 *    and then prints the list still delivers a clean list, because the prose
 *    never reaches a parser.
 * 2. JSON INSIDE IT. The block is tried as the documented schema first.
 * 3. TEXT AFTER THAT. Whatever is not JSON goes through the indented-outline
 *    parser - inside the block when there was one, over the whole paste when
 *    there was not. A model that ignored the format entirely is read exactly
 *    as it was before this order existed.
 *
 * Both readers end in `normalizeOutlineItems`, so the four levels, the 100
 * lines and the 200 characters are enforced once, for every way in. Nothing is
 * dropped for looking like prose either: what survives to the preview is shown
 * as the lines it is, and the person cancels on it.
 *
 * @param {string} text whatever was pasted
 * @returns {{items: {title: string, level: number}[], source: string, fenced: boolean}}
 */
export function parseAnswer(text) {
  const blocks = fencedBlocks(text);
  const fenced = blocks.length > 0;
  const candidate = fenced ? blocks[blocks.length - 1] : String(text || "");
  const rows = jsonOutlineRows(candidate);
  if (rows) return { items: normalizeOutlineItems(rows), source: "json", fenced };
  return { items: parseOutlineText(candidate).items, source: "text", fenced };
}

// -------------------------------------------------------------- the tree shape

/**
 * For each line, the index of the line it hangs under - the nearest earlier
 * line one level up, or -1 for a line at the outer margin.
 */
export function parentIndexes(items) {
  const out = [];
  const open = [];
  items.forEach((item, i) => {
    open.length = item.level;
    out.push(item.level === 0 ? -1 : open[item.level - 1] === undefined ? -1 : open[item.level - 1]);
    open[item.level] = i;
  });
  return out;
}

/** The indexes below one line: everything after it until the level rises back. */
export function subtreeOf(items, i) {
  const out = [];
  for (let j = i + 1; j < items.length && items[j].level > items[i].level; j += 1) out.push(j);
  return out;
}

/**
 * Which lines the ten-root rule leaves room for. Only an import into the top
 * level can overflow; under a node there is no such limit. A line at the outer
 * margin that would be the eleventh goal is blocked, and everything written
 * under it is blocked with it - a step without its goal is not an import.
 *
 * @returns {boolean[]} one flag per line, true = cannot be taken over
 */
export function blockedByRootCap(items, capacity) {
  const out = [];
  let taken = 0;
  let current = false;
  for (const item of items) {
    if (item.level === 0) {
      taken += 1;
      current = taken > capacity;
    }
    out.push(current);
  }
  return out;
}
