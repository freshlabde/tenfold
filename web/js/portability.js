// portability.js - getting data in and out of the app as files.
//
// What it does: wraps the opaque VaultFile into a downloadable .tenfold file,
// reads such a file back with a rough structural check, and - only on the
// user's explicit confirmation, which the UI has to obtain - writes the open
// document as a plain Markdown outline.
//
// What it deliberately does NOT do: no crypto (it never sees the master key
// and never inspects the ciphertext), no IndexedDB, no network, no DOM and no
// HTML generation. exportPlaintextMarkdown produces text, nothing else.

/** File extension of an encrypted export. */
export const VAULT_EXTENSION = ".tenfold";

const EXPECTED_MAGIC = "TENFOLD1";

/**
 * Serialise the encrypted vault into a Blob for download.
 * The content is exactly what crypto.js produced - this module adds no fields
 * and strips none.
 * @param {Object} vault VaultFile
 * @returns {Blob}
 */
export function exportEncrypted(vault) {
  if (!vault || typeof vault !== "object" || Array.isArray(vault)) {
    throw new TypeError("exportEncrypted: vault must be a plain object");
  }
  const text = JSON.stringify(vault, null, 2);
  return new Blob([text], { type: "application/octet-stream" });
}

/**
 * Suggested download name, e.g. "tenfold-2026-08-08.tenfold".
 * @param {number} [now] epoch-ms, injectable for reproducible tests
 */
export function suggestedVaultFileName(now) {
  const ts = typeof now === "number" ? now : Date.now();
  const d = new Date(ts);
  const p = (v) => String(v).padStart(2, "0");
  return `tenfold-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}${VAULT_EXTENSION}`;
}

async function readText(file) {
  if (file && typeof file.text === "function") return file.text();
  if (typeof file === "string") return file;
  throw new TypeError("importEncrypted: expected a File or Blob");
}

/**
 * Read a .tenfold file back. Validates the envelope roughly - magic, version,
 * wrappers array - and throws a message a human can act on. It cannot and does
 * not verify the ciphertext; that is crypto.js's job at unlock time.
 * @param {File|Blob|string} file
 * @returns {Promise<Object>} VaultFile
 */
export async function importEncrypted(file) {
  const text = await readText(file);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Not a tenfold vault: the file content is not valid JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Not a tenfold vault: the file contains no vault object.");
  }
  if (data.magic !== EXPECTED_MAGIC) {
    throw new Error(
      `Not a tenfold vault: expected magic "${EXPECTED_MAGIC}", found "${String(data.magic)}".`,
    );
  }
  if (data.version === undefined || data.version === null) {
    throw new Error("This vault has no version field and cannot be read.");
  }
  if (!Array.isArray(data.wrappers) || data.wrappers.length === 0) {
    throw new Error("This vault has no key wrappers and could never be unlocked.");
  }
  return data;
}

const STATUS_BOX = { open: "[ ]", doing: "[~]", done: "[x]", parked: "[-]" };

function isoDate(ms) {
  const d = new Date(ms);
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function liveChildren(nodes, parentId) {
  return nodes
    .filter((n) => (n.parentId === undefined ? null : n.parentId) === parentId && !n.deletedAt)
    .sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The whole tree as an indented Markdown list - status, due date, definition
 * of done, story and note included. Tombstones are left out. Pure text - no
 * HTML is ever produced here.
 * @param {Object} doc Doc
 * @returns {Blob}
 */
export function exportPlaintextMarkdown(doc) {
  const nodes = doc && Array.isArray(doc.nodes) ? doc.nodes : [];
  const lines = ["# tenfold", ""];

  const walk = (parentId, depth) => {
    for (const n of liveChildren(nodes, parentId)) {
      const indent = "  ".repeat(depth);
      const box = STATUS_BOX[n.status] || "[ ]";
      const meta = [`status: ${n.status}`];
      if (typeof n.due === "number") meta.push(`due: ${isoDate(n.due)}`);
      if (typeof n.effortMinutes === "number") meta.push(`effort: ${n.effortMinutes} min`);
      lines.push(`${indent}- ${box} ${n.title} (${meta.join(", ")})`);
      if (n.doneWhen) lines.push(`${indent}  done when: ${n.doneWhen}`);
      const story = String(n.story || "")
        .split("\n")
        .filter((l) => l.trim());
      if (story.length) {
        lines.push(`${indent}  story:`);
        for (const l of story) lines.push(`${indent}    ${l}`);
      }
      for (const noteLine of String(n.note || "").split("\n")) {
        if (noteLine.trim()) lines.push(`${indent}  ${noteLine}`);
      }
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  lines.push("");
  return new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
}
