// aihelp.js - the copy loop, and the two pure halves it is made of.
//
// What it does: builds the text a person carries to whatever AI they already
// use, and reads the answer they bring back. Out is a prompt: the goal, where
// it sits, its story, the steps under it and the names on the cards linked to
// it, written in the language the app is in. Back in is an indented outline
// that becomes steps under the same node.
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
      "After I have answered: propose the next steps as a plain indented list I can paste straight back. One step per line, no numbering. A step that belongs under the one above it gets two spaces in front of it. Nothing around the list, nothing between the lines.",
      "Keep every step small enough to finish in one sitting, and write it in my words and my situation, not as general advice. If something important is missing, say so instead of inventing it.",
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
      "Wenn ich geantwortet habe: schlag die nächsten Schritte als einfache eingerückte Liste vor, die ich direkt zurückkopieren kann. Ein Schritt pro Zeile, keine Nummerierung. Ein Schritt, der unter den darüber gehört, bekommt zwei Leerzeichen davor. Nichts um die Liste herum, nichts zwischen den Zeilen.",
      "Halte jeden Schritt so klein, dass er in einem Zug fertig wird, und schreib ihn in meinen Worten und meiner Lage, nicht als allgemeinen Rat. Wenn etwas Wichtiges fehlt, sag das, statt es zu erfinden.",
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
      "Cuando te haya respondido: propón los siguientes pasos como una lista sencilla con sangría que pueda pegar de vuelta tal cual. Un paso por línea, sin numeración. Un paso que va debajo del anterior lleva dos espacios delante. Nada alrededor de la lista, nada entre las líneas.",
      "Mantén cada paso lo bastante pequeño como para terminarlo de una sentada, y escríbelo con mis palabras y mi situación, no como consejo general. Si falta algo importante, dilo en vez de inventarlo.",
    ],
  },
};

/** The wording of a locale, English for anything unknown. */
function wordsFor(locale) {
  return PROMPT[locale] || PROMPT.en;
}

/**
 * The context as labelled lines, then the instruction. Pure text: no markdown,
 * no fences, nothing a chat window would swallow.
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
