// ui/scan.js - reading the pairing code with the camera instead of the thumbs.
//
// What it does: where the browser brings its own BarcodeDetector and a camera,
// it opens one sheet with a live preview, looks at about five frames a second
// and hands the first pairing code it recognises to the adopt flow.
//
// What it deliberately does NOT do: no frame ever leaves the device - there is
// no canvas copy, no upload, no fetch, no storage, and the detector is the
// browser's own. The stream is stopped in exactly ONE place (`stop` below),
// which the hit path, every error path and the sheet's onClose all call, so a
// camera cannot outlive the sheet. Where the detector is missing this module
// offers nothing at all: the button is not drawn, and the typed code and the
// native camera app stay the two paths that always work.

import { el, text, clear } from "./dom.js";
import { t } from "../i18n.js";
import { closeSheet } from "./sheet.js";
import { normaliseSyncId } from "../sync.js";

/** How often a frame is looked at. Five a second is plenty for a still code. */
const FRAME_INTERVAL_MS = 200;

/**
 * Progressive enhancement, decided once: both the detector and a camera have
 * to be there. Anything less and the caller draws no button at all.
 */
export function scanSupported() {
  return (
    typeof window !== "undefined" &&
    "BarcodeDetector" in window &&
    !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function")
  );
}

/** A pairing code out of whatever the code carried, or "" when it is foreign. */
function readCode(raw) {
  if (typeof raw !== "string" || !raw) return "";
  try {
    // The same normaliser the typed field uses: it takes the whole pairing
    // URL, the bare code, upper case and hyphens alike.
    return normaliseSyncId(raw);
  } catch {
    return "";
  }
}

/**
 * Opens the scanner sheet.
 * @param {Object} ctx the app context (openSheet, toast)
 * @param {(code: string) => void} onCode called once, with a normalised id
 */
export function openScanner(ctx, onCode) {
  let stream = null;
  let timer = 0;
  let closed = false;
  let busy = false;

  const video = el("video", {
    class: "scanvideo",
    attrs: { playsinline: "", autoplay: "", muted: "" },
  });
  // The properties, not just the attributes: iOS honours only these two.
  video.muted = true;
  video.playsInline = true;

  const note = el("p", { class: "field-hint" }, [text(t("sync.scan.body"))]);

  /**
   * The single teardown. Idempotent on purpose - it runs again when the sheet
   * closes after a hit, and that must be harmless.
   */
  const stop = () => {
    closed = true;
    if (timer) {
      clearInterval(timer);
      timer = 0;
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    video.srcObject = null;
  };

  const fail = (key) => {
    stop();
    clear(note);
    note.appendChild(text(t(key)));
  };

  const body = el("div", {}, [el("div", { class: "scanbox" }, [video]), note]);
  const footer = el("div", { class: "sheet-foot" }, [
    el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => closeSheet() } }, [
      text(t("common.cancel")),
    ]),
  ]);
  ctx.openSheet({ title: t("sync.scan.title"), body, footer, onClose: stop });

  let detector;
  try {
    detector = new window.BarcodeDetector({ formats: ["qr_code"] });
  } catch {
    fail("sync.scan.denied");
    return;
  }

  const tick = async () => {
    if (closed || busy) return;
    busy = true;
    try {
      const hits = await detector.detect(video);
      for (const hit of hits || []) {
        const code = readCode(hit && hit.rawValue);
        if (!code) continue;
        // Order matters: the camera goes dark before anything else happens.
        stop();
        closeSheet();
        onCode(code);
        return;
      }
    } catch {
      // A frame that cannot be read is simply not this frame.
    } finally {
      busy = false;
    }
  };

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
    } catch {
      fail("sync.scan.denied");
      return;
    }
    if (closed) {
      // Closed while the permission prompt was up: nothing may start now.
      stop();
      return;
    }
    video.srcObject = stream;
    // Not awaited on purpose: on a browser that refuses autoplay the promise
    // may never settle, and the detector reads the element either way. A
    // scanner that waits for a preview to start is a scanner that hangs.
    const playing = video.play();
    if (playing && typeof playing.catch === "function") playing.catch(() => {});
    timer = setInterval(tick, FRAME_INTERVAL_MS);
  })();
}
