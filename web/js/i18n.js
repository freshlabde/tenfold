// i18n.js - one flat catalogue per locale, English as source and fallback.
//
// What it does: picks a locale (explicit choice, then navigator.language, then
// "en"), resolves keys with a two-step fallback chain [requested] -> en, and
// interpolates {placeholders}. Catalogues are ES modules, imported statically,
// so the app stays network free.
//
// What it deliberately does NOT do: no DOM, no storage, no fetch, no HTML.
// A catalogue value is always plain text - it goes into textContent, never into
// innerHTML, and this module would not help if it did. Missing keys are
// returned verbatim so a gap is visible in the UI instead of silently empty.

import { en } from "./locales/en.js";
import { de } from "./locales/de.js";
import { es } from "./locales/es.js";

/** Supported locales. `en` is the source of truth and the fallback. */
export const LOCALES = ["en", "de", "es"];

export const FALLBACK_LOCALE = "en";

const CATALOGUES = { en, de, es };

let current = FALLBACK_LOCALE;
const listeners = new Set();

/** @returns {string} the best supported locale for this browser. */
export function detectLocale() {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const wanted = [];
  if (nav && Array.isArray(nav.languages)) wanted.push(...nav.languages);
  if (nav && nav.language) wanted.push(nav.language);
  for (const tag of wanted) {
    if (typeof tag !== "string") continue;
    const base = tag.toLowerCase().split("-")[0];
    if (LOCALES.includes(base)) return base;
  }
  return FALLBACK_LOCALE;
}

/** @returns {string} the locale currently in use. */
export function getLocale() {
  return current;
}

/**
 * Switch locale. Unknown values fall back to English rather than throwing -
 * a corrupt settings field must not take the UI down. Persisting the choice is
 * the app layer's job (doc.settings.lang).
 */
export function setLocale(locale) {
  const next = LOCALES.includes(locale) ? locale : FALLBACK_LOCALE;
  if (next === current) return;
  current = next;
  for (const fn of listeners) {
    try {
      fn(next);
    } catch {
      // A broken listener must not stop the other listeners.
    }
  }
}

/** Subscribe to locale changes. Returns an unsubscribe function. */
export function onLocaleChange(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/**
 * Translate a key.
 * @param {string} key
 * @param {Object} [vars] values for {placeholders}
 * @returns {string} the translation, the English text, or the key itself
 */
export function t(key, vars) {
  const own = CATALOGUES[current];
  let value = own && Object.prototype.hasOwnProperty.call(own, key) ? own[key] : undefined;
  if (typeof value !== "string" || value === "") {
    const base = CATALOGUES[FALLBACK_LOCALE];
    value = base && Object.prototype.hasOwnProperty.call(base, key) ? base[key] : undefined;
  }
  if (typeof value !== "string") return key;
  return interpolate(value, vars);
}

/** All keys of a locale - used by the key-set equality test. */
export function keysOf(locale) {
  const cat = CATALOGUES[locale];
  return cat ? Object.keys(cat).sort() : [];
}

/** The labels the story guide stamps into the story text. */
const GUIDE_LABEL_KEYS = [
  "guide.label.why",
  "guide.label.tried",
  "guide.label.blocks",
  "guide.label.done",
];

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;

/**
 * Re-label guide answers in a story for DISPLAY.
 *
 * The story guide appends each answer as "<label>: <answer>", and the label is
 * stamped in whatever language was active at that moment - so a vault answered
 * in English shows "Why now:" inside an otherwise German screen forever (owner
 * report: "En text in deutsch"). The stored text is user data and stays
 * exactly as written; this maps a KNOWN guide label at a line start from any
 * supported locale to the current one, and touches nothing else.
 * @param {string} story
 * @returns {string}
 */
export function localizeStoryLabels(story) {
  const s = String(story || "");
  if (!s) return s;
  let out = s;
  for (const key of GUIDE_LABEL_KEYS) {
    const target = t(key);
    for (const locale of LOCALES) {
      const label = CATALOGUES[locale][key];
      if (!label || label === target) continue;
      out = out.replace(new RegExp(`^${label.replace(RE_ESCAPE, "\\$&")}:`, "gm"), `${target}:`);
    }
  }
  return out;
}
