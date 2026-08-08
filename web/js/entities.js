// entities.js - the private context index, as pure functions.
//
// What it does: create, change, tombstone and look up the cards that describe
// the people, places, organisations and topics a list keeps touching; link
// them to nodes; and scan titles and stories for capitalised names that have
// no card yet, so the UI can ask one quiet question about them.
//
// What it deliberately does NOT do: no DOM, no storage, no network and above
// all no model of the world. `detectNames` is a plain local string scan - no
// dictionary, no name list, no LLM, nothing that leaves the device. It never
// invents a card; it only proposes a word the user already wrote twice.

import { createEntity } from "./model.js";

/** How often a word must appear before it is worth asking about. */
const MIN_OCCURRENCES = 2;

/** Shorter words are initials, units or sentence noise, not names. */
const MIN_NAME_LENGTH = 3;

/** Upper bound on the dismissal memory kept in doc.settings. */
export const MAX_DISMISSED = 50;

/**
 * Words that start a sentence, an article or a filler in the three supported
 * languages. German capitalises every noun, so this list can only ever thin
 * the candidates out, never make them precise - which is why a candidate is a
 * question ("Who is X?"), never an automatic card.
 */
const STOPWORDS = {
  en: [
    "The", "A", "An", "And", "But", "For", "If", "In", "It", "Is", "Of", "On", "Or", "So", "That",
    "There", "They", "This", "To", "We", "What", "When", "Where", "Which", "Who", "Why", "With",
    "You", "Your", "My", "Not", "No", "Yes", "Then", "Than", "Every", "Each", "All", "Also",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December",
  ],
  de: [
    "Der", "Die", "Das", "Den", "Dem", "Des", "Ein", "Eine", "Einen", "Einem", "Einer", "Eines",
    "Und", "Oder", "Aber", "Wenn", "Weil", "Dass", "Doch", "Noch", "Nur", "Nicht", "Kein", "Keine",
    "Ich", "Du", "Er", "Sie", "Es", "Wir", "Ihr", "Mein", "Meine", "Mit", "Ohne", "Fuer", "Für",
    "Von", "Vom", "Zum", "Zur", "Zu", "Auf", "Aus", "Bei", "Nach", "Vor", "Ueber", "Über", "Immer",
    "Alle", "Jeder", "Jede", "Was", "Wer", "Wie", "Wo", "Warum", "Wann", "Dann", "Also", "Schon",
    "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag",
    "Januar", "Februar", "Maerz", "März", "April", "Mai", "Juni", "Juli", "August", "September",
    "Oktober", "November", "Dezember",
  ],
  es: [
    "El", "La", "Los", "Las", "Un", "Una", "Unos", "Unas", "Y", "O", "Pero", "Si", "Que", "Como",
    "Cuando", "Donde", "Porque", "Para", "Por", "Con", "Sin", "De", "Del", "Al", "En", "Su", "Mi",
    "Mis", "Tu", "Yo", "No", "Si", "Todo", "Todos", "Toda", "Todas", "Cada", "Mas", "Más",
    "Lunes", "Martes", "Miercoles", "Miércoles", "Jueves", "Viernes", "Sabado", "Sábado", "Domingo",
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre",
    "Octubre", "Noviembre", "Diciembre",
  ],
};

function str(v) {
  return typeof v === "string" ? v : "";
}

/** Accent- and case-folded key, so "Jose" and "José" are the same person. */
export function foldName(value) {
  return str(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function nowOf(opts) {
  return opts && typeof opts.now === "number" ? opts.now : Date.now();
}

// ----------------------------------------------------------------------- CRUD

/** Living cards, ordered by name (id as a stable tiebreak). */
export function listEntities(entities) {
  return (Array.isArray(entities) ? entities : [])
    .filter((e) => e && !e.deletedAt)
    .sort((a, b) => {
      const x = foldName(a.name);
      const y = foldName(b.name);
      if (x !== y) return x < y ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/** One card by id, tombstones included (a linked card may be deleted). */
export function entityById(entities, id) {
  return (Array.isArray(entities) ? entities : []).find((e) => e && e.id === id) || null;
}

/** The living cards a node links to, in the order the node lists them. */
export function entitiesForNode(entities, node) {
  const refs = node && Array.isArray(node.entityRefs) ? node.entityRefs : [];
  const out = [];
  for (const id of refs) {
    const e = entityById(entities, id);
    if (e && !e.deletedAt) out.push(e);
  }
  return out;
}

/** The living nodes that link to a card. */
export function nodesForEntity(nodes, entityId) {
  return (Array.isArray(nodes) ? nodes : []).filter(
    (n) => !n.deletedAt && Array.isArray(n.entityRefs) && n.entityRefs.includes(entityId),
  );
}

/** Append a new card. Returns a NEW array. */
export function addEntity(entities, partial, opts = {}) {
  const now = nowOf(opts);
  const entity = createEntity({ createdAt: now, updatedAt: now, ...partial });
  return [...(Array.isArray(entities) ? entities : []), entity];
}

/**
 * Patch a card. Only the fields in `patch` change; `updatedAt` is bumped only
 * when something really did.
 */
export function updateEntity(entities, id, patch, opts = {}) {
  const now = nowOf(opts);
  return (Array.isArray(entities) ? entities : []).map((e) => {
    if (e.id !== id) return e;
    // Spread e first so a field a newer version wrote survives the patch.
    const next = { ...e, ...createEntity({ ...e, ...patch, createdAt: e.createdAt, updatedAt: now }) };
    const same = JSON.stringify({ ...next, updatedAt: 0 }) === JSON.stringify({ ...e, updatedAt: 0 });
    return same ? e : next;
  });
}

/** Tombstone a card. Nothing is removed physically - a merge has to see it. */
export function deleteEntity(entities, id, opts = {}) {
  const now = nowOf(opts);
  return (Array.isArray(entities) ? entities : []).map((e) =>
    e.id === id && !e.deletedAt ? { ...e, deletedAt: now, updatedAt: now } : e,
  );
}

/** Link a card to a node. Returns a NEW node array; a repeat is a no-op. */
export function linkEntity(nodes, nodeId, entityId, opts = {}) {
  const now = nowOf(opts);
  return (Array.isArray(nodes) ? nodes : []).map((n) => {
    if (n.id !== nodeId) return n;
    const refs = Array.isArray(n.entityRefs) ? n.entityRefs : [];
    if (refs.includes(entityId)) return n;
    return { ...n, entityRefs: [...refs, entityId], updatedAt: now };
  });
}

/** Remove a link. Returns a NEW node array; removing what is not there is a no-op. */
export function unlinkEntity(nodes, nodeId, entityId, opts = {}) {
  const now = nowOf(opts);
  return (Array.isArray(nodes) ? nodes : []).map((n) => {
    if (n.id !== nodeId) return n;
    const refs = Array.isArray(n.entityRefs) ? n.entityRefs : [];
    if (!refs.includes(entityId)) return n;
    return { ...n, entityRefs: refs.filter((r) => r !== entityId), updatedAt: now };
  });
}

// ------------------------------------------------------------ name detection

/** Every folded name and alias that already has a card. */
function knownNames(entities) {
  const set = new Set();
  for (const e of Array.isArray(entities) ? entities : []) {
    if (!e || e.deletedAt) continue;
    const name = foldName(e.name);
    if (name) set.add(name);
    for (const a of Array.isArray(e.aliases) ? e.aliases : []) {
      const alias = foldName(a);
      if (alias) set.add(alias);
    }
  }
  return set;
}

// A capitalised word: one uppercase letter followed by letters, apostrophes or
// hyphens. Unicode aware, so "Ángela", "Müller" and "O'Brien" are one word.
const WORD = /\p{Lu}[\p{L}'’-]*/gu;

/**
 * Capitalised words that occur at least twice across the living titles and
 * stories and match no card. Deterministic, local, cheap.
 *
 * @param {Array} nodes
 * @param {Array} entities
 * @param {{locale?: string, dismissed?: string[], minCount?: number}} [opts]
 * @returns {{name: string, count: number}[]} best first
 */
export function detectNames(nodes, entities, opts = {}) {
  const locale = STOPWORDS[opts.locale] ? opts.locale : "en";
  // Every locale's stopwords are applied on top of the active one: a German
  // list written on an English UI must not flood the hint with articles.
  const stop = new Set();
  for (const list of Object.values(STOPWORDS)) for (const w of list) stop.add(foldName(w));
  for (const w of STOPWORDS[locale]) stop.add(foldName(w));

  const known = knownNames(entities);
  const dismissed = new Set((Array.isArray(opts.dismissed) ? opts.dismissed : []).map(foldName));
  const minCount = typeof opts.minCount === "number" ? opts.minCount : MIN_OCCURRENCES;

  const counts = new Map();
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || n.deletedAt) continue;
    const haystack = `${str(n.title)}\n${str(n.story)}`;
    for (const match of haystack.matchAll(WORD)) {
      const word = match[0].replace(/[-'’]+$/, "");
      if (word.length < MIN_NAME_LENGTH) continue;
      if (word === word.toUpperCase() && word.length > 4) continue; // SHOUTED, not a name
      const key = foldName(word);
      if (!key || stop.has(key) || known.has(key) || dismissed.has(key)) continue;
      const seen = counts.get(key);
      if (seen) seen.count += 1;
      else counts.set(key, { name: word, count: 1 });
    }
  }

  return [...counts.values()]
    .filter((c) => c.count >= minCount)
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Add a name to the dismissal memory, folded, de-duplicated and capped. */
export function rememberDismissal(dismissed, name) {
  const key = foldName(name);
  if (!key) return Array.isArray(dismissed) ? dismissed : [];
  const list = (Array.isArray(dismissed) ? dismissed : []).filter((d) => foldName(d) !== key);
  list.push(key);
  return list.slice(-MAX_DISMISSED);
}
