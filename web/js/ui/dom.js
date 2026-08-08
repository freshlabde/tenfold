// ui/dom.js - the only way this app builds DOM.
//
// What it does: a tiny element factory. Text always travels as a string into
// textContent or as a Text node, attributes go through setAttribute, listeners
// through addEventListener. Icons are built from a fixed path table with
// createElementNS.
//
// What it deliberately does NOT do: it has no innerHTML, no insertAdjacentHTML,
// no outerHTML, no document.write, no template parsing and no eval anywhere -
// on purpose, and enforced by a source test. In a zero knowledge app an
// injected script would hold the plaintext and the key at the same time, so
// there is no "safe" HTML string here, not even for our own markup.

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Build an element.
 * @param {string} tag
 * @param {Object} [props] class, text, attrs, dataset, style, vars, on
 * @param {Array<Node|string|null|undefined|false>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.id) node.id = props.id;
  if (typeof props.text === "string") node.textContent = props.text;
  if (props.attrs) {
    for (const [k, v] of Object.entries(props.attrs)) {
      if (v === false || v === null || v === undefined) continue;
      node.setAttribute(k, String(v));
    }
  }
  if (props.dataset) {
    for (const [k, v] of Object.entries(props.dataset)) {
      if (v === null || v === undefined) continue;
      node.dataset[k] = String(v);
    }
  }
  if (props.vars) {
    for (const [k, v] of Object.entries(props.vars)) {
      if (v === null || v === undefined) continue;
      node.style.setProperty(k, String(v));
    }
  }
  if (props.style) {
    for (const [k, v] of Object.entries(props.style)) node.style[k] = v;
  }
  if (props.on) {
    for (const [type, fn] of Object.entries(props.on)) {
      if (typeof fn === "function") node.addEventListener(type, fn);
    }
  }
  append(node, children);
  return node;
}

/** Append children, skipping falsy entries and wrapping bare strings as text. */
export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false || c === "") continue;
    parent.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return parent;
}

/** A text node. Explicit, so a call site reads as "this is user content". */
export function text(value) {
  return document.createTextNode(value === null || value === undefined ? "" : String(value));
}

/**
 * Remove every child of a node in one step. replaceChildren() rather than a
 * removeChild loop on purpose: removing a focused input fires blur mid-loop,
 * a blur handler may re-render, and the loop would then walk a stale tree.
 */
export function clear(node) {
  if (!node) return node;
  if (typeof node.replaceChildren === "function") node.replaceChildren();
  else while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Shorthand for a button that carries a class, a label and a click handler. */
export function button(cls, label, onClick, extra = {}) {
  return el(
    "button",
    {
      class: cls,
      attrs: { type: "button", ...(extra.attrs || {}) },
      on: { click: onClick, ...(extra.on || {}) },
    },
    [...(extra.before || []), label ? text(label) : null, ...(extra.after || [])],
  );
}

// --------------------------------------------------------------------- icons

// Stroked 24x24 paths. No emoji anywhere in this app; these are the icons.
const PATHS = {
  plus: ["M12 5v14", "M5 12h14"],
  check: ["M4.5 12.6 9.5 17.6 19.5 6.6"],
  scales: ["M4 6h16", "M4 12h11", "M4 18h6"],
  chevronLeft: ["M14.5 5.5 8 12l6.5 6.5"],
  chevronRight: ["M9.5 5.5 16 12l-6.5 6.5"],
  arrowLeft: ["M10.5 5 4 12l6.5 7", "M4.4 12H20"],
  arrowRight: ["M13.5 5 20 12l-6.5 7", "M19.6 12H4"],
  arrowUp: ["M5 10.5 12 4l7 6.5", "M12 4.4V20"],
  arrowDown: ["M5 13.5 12 20l7-6.5", "M12 19.6V4"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M16.2 16.2 20.5 20.5"],
  gear: [
    "M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z",
    "M19.4 12a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.4 7.4 0 0 0-2.1-1.2L14.6 3h-4l-.3 2.7a7.4 7.4 0 0 0-2.1 1.2l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.4 7.4 0 0 0 2.1 1.2l.3 2.7h4l.3-2.7a7.4 7.4 0 0 0 2.1-1.2l2.3 1 2-3.4-2-1.5c.06-.4.1-.8.1-1.2z",
  ],
  close: ["M6 6l12 12", "M18 6 6 18"],
  lock: ["M6.5 10.5h11v9h-11z", "M9 10.5V7.5a3 3 0 0 1 6 0v3"],
  unlock: ["M6.5 10.5h11v9h-11z", "M9 10.5V7.5a3 3 0 0 1 5.6-1.5"],
  download: ["M12 4v11", "M7.5 10.5 12 15l4.5-4.5", "M5 19.5h14"],
  upload: ["M12 15V4", "M7.5 8.5 12 4l4.5 4.5", "M5 19.5h14"],
  dots: ["M6 12h.01", "M12 12h.01", "M18 12h.01"],
  pencil: ["M4.5 19.5h4L19 9a2.5 2.5 0 0 0-3.5-3.5L5 16z"],
  trash: ["M5 7h14", "M9.5 7V5h5v2", "M6.8 7l.8 12.5h8.8L17.2 7"],
  calendar: ["M4.5 6.5h15v13h-15z", "M4.5 10.5h15", "M8.5 4v4", "M15.5 4v4"],
  clock: ["M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "M12 7.5V12l3 2"],
  // The mark: ten strokes that fold from one into many.
  mark: ["M4 20V4", "M9 20V9", "M14 20v-5", "M19 20v-2"],
};

/**
 * Inline SVG icon.
 * @param {string} name key of the path table
 * @param {number} [size]
 * @returns {SVGElement}
 */
export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of PATHS[name] || []) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

/** A horizontal fill bar, used for progress everywhere. */
export function track(ratio, cls = "track") {
  return el("span", { class: cls, vars: { "--p": String(Math.max(0, Math.min(1, ratio || 0))) } }, [
    el("i", {}),
  ]);
}
