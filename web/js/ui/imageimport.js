// ui/imageimport.js - a photograph of a list becomes a proposal.
//
// What it does: takes one picture (camera or file), makes it small enough to
// travel on this device, sends it through the same relay every other model
// call uses, and turns the strict JSON that comes back into an indented
// checklist. Every line can be corrected in place, every line has its own
// checkbox, unchecking a parent takes its whole subtree with it, and only the
// press on "Take over" writes anything - as ordinary nodes, through the
// ordinary mutate path, with origin "llm".
//
// What it deliberately does NOT do: it does not fetch (llm.js does, and only
// llm.js), it never writes to the document itself, it never imports half a
// picture - a failure is one calm line and a button, and the document is
// untouched. The picture is resized here, in a canvas, before anything leaves:
// what the relay sees is a JPEG of at most 1600 pixels on its longest edge,
// never the original from the camera roll. Model text goes on screen as text
// nodes only, exactly like a note.

import { el, text, icon, clear } from "./dom.js";
import { openSheet, closeSheet } from "./sheet.js";
import { t } from "../i18n.js";
import { callForText, extractJson, llmMode, llmSettings, LlmError } from "../llm.js";
import { importMessages, parseImportItems } from "../prompts.js";
import { thinkingLine, errorLine, WAIT_AFTER_MS } from "./assist.js";

/** Refused before a single byte is read. A phone photo is two to five of these. */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** Longest edge after the resize. Enough for handwriting, small enough to send. */
export const MAX_EDGE = 1600;

/** JPEG quality of the resized picture. */
export const JPEG_QUALITY = 0.8;

/** How much of the model's answer we are prepared to read back. */
const MAX_TOKENS = 4000;

/** The payload size of a data URL, in bytes - base64 is four chars per three. */
export function dataUrlBytes(dataUrl) {
  const comma = String(dataUrl || "").indexOf(",");
  if (comma < 0) return 0;
  const body = dataUrl.length - comma - 1;
  const padding = dataUrl.endsWith("==") ? 2 : dataUrl.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((body * 3) / 4) - padding);
}

/**
 * The picture, decoded. `imageOrientation: "from-image"` is the whole point of
 * going through createImageBitmap: a photo taken in portrait carries its
 * rotation in EXIF, and a canvas that ignores that produces a sideways list
 * that no model can read. The <img> path is the fallback for browsers without
 * the option; browsers apply EXIF to <img> themselves.
 */
async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall through to the element path rather than failing on a codec quirk.
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new LlmError("unreadable"));
    };
    img.src = url;
  });
}

/**
 * Resize to at most MAX_EDGE on the longest side and re-encode as JPEG.
 * Pure-ish: a file in, a data URL out, nothing stored, nothing sent.
 *
 * @param {File|Blob} file
 * @param {{maxEdge?: number, quality?: number}} [opts]
 * @returns {Promise<{dataUrl: string, bytes: number, width: number, height: number}>}
 */
export async function shrinkImage(file, opts = {}) {
  const maxEdge = Number(opts.maxEdge) > 0 ? Number(opts.maxEdge) : MAX_EDGE;
  const quality = typeof opts.quality === "number" ? opts.quality : JPEG_QUALITY;
  const source = await decode(file);
  const w = source.width || source.naturalWidth || 0;
  const h = source.height || source.naturalHeight || 0;
  if (!w || !h) throw new LlmError("unreadable");

  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const g = canvas.getContext("2d");
  if (!g) throw new LlmError("unreadable");
  g.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (typeof source.close === "function") source.close();

  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  if (!dataUrl.startsWith("data:image/jpeg")) throw new LlmError("unreadable");
  return { dataUrl, bytes: dataUrlBytes(dataUrl), width: canvas.width, height: canvas.height };
}

// ----------------------------------------------------------------- the tree

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
function subtreeOf(items, i) {
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

// ------------------------------------------------------------- the entry point

/**
 * The control that starts all of this, or nothing at all. In "off" mode this
 * returns null and not one element is built - the same rule as every other
 * assistance control. A node that is kept away from the model does not collect
 * model-made children either, so it has no entry point of its own.
 *
 * @param {Object} ctx the app context
 * @param {string|null} parentId null = the ten, otherwise the focused node
 * @returns {HTMLElement|null}
 */
export function importEntry(ctx, parentId) {
  if (!ctx.llmOn) return null;
  if (parentId !== null) {
    const keep = ctx.optout(parentId);
    if (keep.own || keep.inherited) return null;
  }
  return el("div", { class: "import-entry" }, [
    el(
      "button",
      {
        class: "btn-ghost is-accent",
        attrs: { type: "button" },
        dataset: { llm: "import" },
        on: { click: () => ctx.importImage(parentId) },
      },
      [text(t("import.entry"))],
    ),
  ]);
}

// ------------------------------------------------------------------ the sheet

/**
 * The whole flow in one sheet: pick a picture, wait, look at what was read,
 * correct what is wrong, take over what is right.
 *
 * @param {Element} layer the overlay host
 * @param {Object} ctx the app context
 * @param {string|null} parentId null = the lines at the outer margin become goals
 */
export function openImageImport(layer, ctx, parentId) {
  const body = el("div", { class: "assist" });
  const footer = el("div", { class: "import-foot" });
  /** The size line under the buttons; empty until something was resized. */
  let upload = null;
  let waitTimer = 0;

  const mode = () => llmMode(ctx.doc);
  const target = () => (parentId === null ? null : ctx.nodeById(parentId));

  const reset = () => {
    clearTimeout(waitTimer);
    waitTimer = 0;
    clear(body);
    clear(footer);
  };

  /** The footer: the buttons, and under them the mono line with the weight. */
  const foot = (buttons) => {
    footer.appendChild(el("div", { class: "sheet-foot" }, buttons));
    if (upload) {
      footer.appendChild(
        el("p", { class: "import-size m" }, [
          text(t("import.size", { n: Math.max(1, Math.round(upload.bytes / 1024)) })),
        ]),
      );
    }
  };

  const btn = (label, onClick, primary) =>
    el(
      "button",
      { class: `btn${primary ? " is-primary" : ""}`, attrs: { type: "button" }, on: { click: onClick } },
      [text(label)],
    );

  // ------------------------------------------------------------- the picker

  function paintPick() {
    reset();
    const node = target();
    body.appendChild(
      el("p", { class: "check-text", style: { paddingTop: "6px" } }, [
        text(mode() === "cloud" ? t("import.intro.cloud") : t("import.intro.local")),
      ]),
    );
    body.appendChild(
      el("p", { class: "field-hint" }, [
        text(node ? t("import.targetUnder", { title: node.title }) : t("import.targetRoots")),
      ]),
    );
    body.appendChild(el("p", { class: "field-hint" }, [text(t("import.limit"))]));

    // The camera on a phone, the file picker everywhere else. Hidden, because
    // the button above it is the control; the input is only the mechanism.
    const input = el("input", {
      class: "import-file",
      attrs: { type: "file", accept: "image/*", capture: "environment" },
      style: { display: "none" },
    });
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (file) take(file);
    });
    body.appendChild(input);

    foot([
      btn(t("common.cancel"), () => closeSheet()),
      el(
        "button",
        {
          class: "btn is-primary",
          attrs: { type: "button" },
          dataset: { llm: "pick" },
          on: { click: () => input.click() },
        },
        [icon("upload", 16), text(t("import.pick"))],
      ),
    ]);
  }

  function paintWorking() {
    reset();
    waitTimer = setTimeout(() => {
      body.appendChild(thinkingLine(mode()));
    }, WAIT_AFTER_MS);
    foot([btn(t("common.cancel"), () => closeSheet())]);
  }

  /** One line, one button. Nothing was imported, nothing was changed. */
  function paintError(err) {
    reset();
    body.appendChild(errorLine(err));
    foot([btn(t("common.close"), () => closeSheet()), btn(t("llm.retry"), () => paintPick(), true)]);
  }

  // ----------------------------------------------------------- the proposal

  function paintProposal(items) {
    reset();
    const capacity =
      parentId === null ? Math.max(0, ctx.maxRoots - ctx.childrenOf(null).length) : items.length;
    const blocked = blockedByRootCap(items, capacity);
    const parents = parentIndexes(items);
    const rows = [];

    items.forEach((item, i) => {
      const box = el("input", { attrs: { type: "checkbox" } });
      box.checked = !blocked[i];
      box.disabled = blocked[i];

      const label = el("button", { class: "assist-title", attrs: { type: "button" } });
      label.textContent = item.title;
      // Correcting a read line is a tap, not a second screen - the same move
      // as in the assist proposals.
      label.addEventListener("click", () => {
        const field = el("input", { class: "input", attrs: { type: "text" } });
        field.value = rows[i].title;
        label.replaceWith(field);
        field.focus();
        const done = () => {
          rows[i].title = field.value.trim() || rows[i].title;
          label.textContent = rows[i].title;
          field.replaceWith(label);
        };
        field.addEventListener("blur", done);
        field.addEventListener("keydown", (ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter" || ev.key === "Escape") {
            ev.preventDefault();
            done();
          }
        });
      });

      const itemEl = el(
        "div",
        {
          class: `assist-item is-level${blocked[i] ? " is-blocked" : ""}`,
          dataset: { llm: "import-item", level: String(item.level) },
          vars: { "--lvl": String(item.level) },
        },
        [
          el("label", { class: "check is-bare" }, [
            box,
            el("span", { class: "check-box" }, [icon("check", 14)]),
          ]),
          el("div", { class: "assist-item-body" }, [label]),
        ],
      );
      rows.push({ title: item.title, level: item.level, box, itemEl, blocked: blocked[i] });
      body.appendChild(itemEl);
    });

    if (blocked.some(Boolean)) {
      body.appendChild(el("p", { class: "field-hint import-blocked" }, [text(t("outline.full"))]));
    }

    const take = el("button", { class: "btn is-primary", attrs: { type: "button" } });
    const chosen = () => rows.filter((r) => r.box.checked && !r.blocked);
    const relabel = () => {
      for (const r of rows) r.itemEl.classList.toggle("is-off", !r.box.checked && !r.blocked);
      clear(take);
      take.appendChild(text(t("llm.proposal.take", { n: chosen().length })));
      take.disabled = chosen().length === 0;
    };
    const set = (i, on) => {
      if (rows[i].blocked) return;
      rows[i].box.checked = on;
    };

    rows.forEach((row, i) => {
      row.box.addEventListener("change", () => {
        if (row.box.checked) {
          // A line needs the line it hangs under, or it has nowhere to go.
          for (let p = parents[i]; p >= 0; p = parents[p]) set(p, true);
        } else {
          // Dropping a goal drops everything written under it.
          for (const j of subtreeOf(items, i)) set(j, false);
        }
        relabel();
      });
    });
    relabel();

    take.addEventListener("click", () => {
      const picked = chosen().map((r) => ({ title: r.title, level: r.level }));
      if (!picked.length) return;
      closeSheet();
      ctx.importTree(parentId, picked);
      ctx.toast(t("llm.applied", { n: picked.length }));
    });

    foot([btn(t("import.another"), () => paintPick()), take]);
  }

  // ------------------------------------------------------------------- run

  async function take(file) {
    // The weight guard comes before the read: a video the camera roll offered
    // as an image should never be decoded at all.
    if (file.size > MAX_FILE_BYTES) {
      paintError(new LlmError("tooBig"));
      return;
    }
    paintWorking();
    try {
      upload = await shrinkImage(file);
      const text = await callForText(llmSettings(ctx.doc), importMessages(upload.dataUrl), {
        maxTokens: MAX_TOKENS,
      });
      const parsed = parseImportItems(extractJson(text));
      paintProposal(parsed.items);
    } catch (err) {
      paintError(err);
    }
  }

  paintPick();
  openSheet(layer, { title: t("import.title"), body, footer, onClose: () => reset() });
}
