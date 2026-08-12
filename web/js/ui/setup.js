// ui/setup.js - first run: passphrase, recovery key, starting point, backup,
// daily reminder.
//
// What it does: six quiet steps. Explain what this is, take a passphrase,
// show the recovery key exactly once behind a forced acknowledgement, offer an
// empty list or a neutral frame of eight life areas, ask the one question that
// decides whether the vault survives a cleared browser, and - only if that one
// was answered with the server copy - offer the daily reminder, because nobody
// goes looking for it in the settings afterwards. Plus one side door: a vault
// that already exists somewhere else can be opened here with its pairing code,
// after which the normal lock screen asks for the passphrase.
//
// What it deliberately does NOT do: it never stores the recovery key, never
// shows it a second time, and never lets the user past that screen without
// ticking the box. There is no spinner while the key is derived - the button
// says what is happening instead. And it never switches sync on by itself: the
// backup step asks, with the copy preselected, and takes "Not now" for an
// answer without arguing.

import { el, text, icon, clear } from "./dom.js";
import { t } from "../i18n.js";
import { formatRecoveryKey } from "../crypto.js";
import { importEncrypted } from "../portability.js";
import { langSwitch } from "./langswitch.js";
import { scanSupported, openScanner } from "./scan.js";
import { photoScanSupported, photoScanControl } from "./photoscan.js";
import { printEmergencySheet, removeEmergencySheet } from "./emergency.js";

const TEMPLATE_KEYS = [
  "template.health",
  "template.money",
  "template.work",
  "template.relationships",
  "template.learning",
  "template.home",
  "template.joy",
  "template.contribution",
];

// Step state lives here because the whole screen is rebuilt on every render.
let step = "welcome";
let recoveryKey = "";
let busy = false;
let errorKey = "";
let adoptCode = "";
let adoptReplaces = false;
let adoptError = "";

/** Called by the app when a vault already exists, so setup starts clean. */
export function reset() {
  // The printable sheet lives on the body, outside the app root, so a repaint
  // does not clear it - leaving this step has to say so explicitly.
  removeEmergencySheet();
  step = "welcome";
  recoveryKey = "";
  busy = false;
  errorKey = "";
  adoptCode = "";
  adoptReplaces = false;
  adoptError = "";
}

/**
 * Opens the adopt step with a code that came from a pairing link.
 * `replacesLocal` is true when a vault is already on this device - then the
 * step warns, because adopting overwrites it.
 */
export function prime(code, replacesLocal = false, errorCode = "") {
  step = "adopt";
  adoptCode = typeof code === "string" ? code : "";
  adoptReplaces = !!replacesLocal;
  adoptError = errorCode ? `sync.error.${errorCode}` : "";
  busy = false;
}

function head(eyebrowKey, titleKey, bodyKey) {
  return el("div", { class: "head" }, [
    el("div", { class: "eyebrow" }, [text(t(eyebrowKey))]),
    el("h1", { class: "h-title" }, [text(t(titleKey))]),
    bodyKey ? el("p", { class: "lock-sub", style: { maxWidth: "34ch" } }, [text(t(bodyKey))]) : null,
  ]);
}

function screen(children) {
  return el("section", { class: "screen" }, children);
}

// ------------------------------------------------------------------ welcome

function welcome(ctx) {
  const start = el(
    "button",
    { class: "btn is-primary is-big is-wide", attrs: { type: "button" }, on: { click: () => { step = "pass"; ctx.render(); } } },
    [text(t("setup.welcome.start"))],
  );

  const file = el("input", { class: "sr-only", attrs: { type: "file", accept: ".tenfold,application/json" } });
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      const vault = await importEncrypted(f);
      await ctx.setVault(vault);
      ctx.toast(t("toast.imported"));
    } catch {
      ctx.toast(t("toast.importFailed"));
    }
  });

  return screen([
    el("div", { class: "lock" }, [
      el("div", { class: "lock-mark" }, [icon("mark", 34)]),
      el("h1", { class: "lock-title is-welcome" }, [text(t("setup.welcome.title"))]),
      el("p", { class: "lock-sub", style: { maxWidth: "34ch" } }, [text(t("setup.welcome.body"))]),
    ]),
    el("div", { class: "bar", style: { gridAutoFlow: "row" } }, [
      // What this app is must be readable BEFORE anything is set up - and it
      // must be SEEN (owner: the quiet about link at the bottom was invisible).
      // The method is the first offer on the first screen, above creating
      // anything; the About screen renders without a vault.
      el(
        "button",
        { class: "btn is-big is-wide", attrs: { type: "button" }, on: { click: () => ctx.go("about") } },
        [icon("mark", 16), text(t("setup.welcome.about"))],
      ),
      start,
      el(
        "button",
        { class: "btn-ghost", attrs: { type: "button" }, on: { click: () => file.click() } },
        [text(t("setup.welcome.import"))],
      ),
      el(
        "button",
        {
          class: "btn-ghost",
          attrs: { type: "button" },
          on: {
            click: () => {
              prime("", false, "");
              ctx.render();
            },
          },
        },
        [text(t("sync.adopt.open"))],
      ),
      file,
    ]),
    langSwitch(ctx),
  ]);
}

// ------------------------------------------------------- open from elsewhere

/**
 * Takes a pairing code and fetches the sealed vault that belongs to it. The
 * blob is useless without the passphrase, which is why this step can run
 * before anything is unlocked - the lock screen follows immediately.
 */
function adopt(ctx) {
  const input = el("input", {
    class: "input is-mono",
    attrs: {
      type: "text",
      placeholder: t("sync.adopt.placeholder"),
      "aria-label": t("sync.adopt.label"),
      autocomplete: "off",
      autocapitalize: "none",
      spellcheck: "false",
      enterkeyhint: "go",
    },
  });
  input.value = adoptCode;

  const err = el("div", { class: "field-error" }, adoptError ? [text(t(adoptError))] : []);
  const go = el(
    "button",
    { class: "btn is-primary is-big is-wide", attrs: { type: "button" } },
    [text(t("sync.adopt.action"))],
  );

  const submit = async () => {
    if (busy) return;
    const code = input.value;
    if (!code) return;
    busy = true;
    adoptError = "";
    clear(go);
    go.appendChild(text(t("sync.adopt.working")));
    go.setAttribute("disabled", "disabled");
    try {
      await ctx.sync.adopt(code);
      adoptCode = "";
      busy = false;
      // Success routes to the lock screen; nothing left to paint here.
    } catch (e) {
      busy = false;
      adoptCode = input.value;
      adoptError = `sync.error.${e && e.code ? e.code : "offline"}`;
      ctx.render();
    }
  };

  go.addEventListener("click", submit);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") submit();
  });

  const took = (code) => {
    input.value = code;
    submit();
  };

  // One button, two mechanisms. Where the browser brings a barcode detector
  // and a camera the live scanner opens; where it does not - iOS Safari has no
  // BarcodeDetector at all - the native camera takes one photograph and our
  // own reader decodes it. The typed code stays the path that always works,
  // and the pairing link opened from the camera app is still the shortest one.
  const live = scanSupported();
  const photo = !live && photoScanSupported() ? photoScanControl(ctx, took) : null;
  const scan = live
    ? el(
        "button",
        {
          class: "btn-ghost",
          attrs: { type: "button" },
          on: { click: () => openScanner(ctx, took) },
        },
        [text(t("sync.scan.action"))],
      )
    : photo && photo.button;

  return screen([
    head("sync.adopt.eyebrow", "sync.adopt.title", "sync.adopt.body"),
    el("div", { class: "scroll" }, [
      el("div", { class: "field" }, [
        el("span", { class: "field-label" }, [text(t("sync.adopt.label"))]),
        el("div", { class: "field-row" }, [input, scan]),
      ]),
      photo ? photo.input : null,
      adoptReplaces ? el("p", { class: "field-hint" }, [text(t("sync.adopt.replaces"))]) : null,
      err,
    ]),
    el("div", { class: "bar", style: { gridAutoFlow: "row" } }, [
      go,
      el(
        "button",
        {
          class: "btn-ghost",
          attrs: { type: "button" },
          on: {
            click: () => {
              const hadVault = !!ctx.vault;
              reset();
              // A vault is already here: cancelling belongs on the lock screen,
              // not on the welcome screen of a first run that is not happening.
              if (hadVault) ctx.go("lock", null, { replace: true });
              else ctx.render();
            },
          },
        },
        [text(t("common.cancel"))],
      ),
    ]),
  ]);
}

// --------------------------------------------------------------- passphrase

function passphrase(ctx) {
  const pass = el("input", {
    class: "input",
    attrs: { type: "password", placeholder: t("setup.pass.placeholder"), autocomplete: "new-password" },
  });
  const again = el("input", {
    class: "input",
    attrs: { type: "password", autocomplete: "new-password" },
  });

  const err = el("div", { class: "field-error" }, errorKey ? [text(t(errorKey))] : []);

  const create = el(
    "button",
    { class: "btn is-primary is-big is-wide", attrs: { type: "button", disabled: busy ? "disabled" : false } },
    [text(busy ? t("setup.pass.working") : t("setup.pass.create"))],
  );

  const submit = async () => {
    if (busy) return;
    errorKey = "";
    if (pass.value.length < 10) {
      errorKey = "setup.pass.tooShort";
      clear(err);
      err.appendChild(text(t(errorKey)));
      pass.focus();
      return;
    }
    if (pass.value !== again.value) {
      errorKey = "setup.pass.mismatch";
      clear(err);
      err.appendChild(text(t(errorKey)));
      again.focus();
      return;
    }
    busy = true;
    clear(create);
    create.appendChild(text(t("setup.pass.working")));
    create.setAttribute("disabled", "disabled");
    // One frame so the changed label is painted before PBKDF2 blocks.
    await new Promise((r) => requestAnimationFrame(() => r()));
    try {
      recoveryKey = await ctx.createVaultWith(pass.value);
      pass.value = "";
      again.value = "";
      busy = false;
      step = "key";
      ctx.render();
    } catch {
      busy = false;
      errorKey = "lock.wrong";
      ctx.render();
    }
  };

  create.addEventListener("click", submit);
  again.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") submit();
  });

  return screen([
    head("setup.pass.eyebrow", "setup.pass.title", "setup.pass.body"),
    el("div", { class: "scroll" }, [
      el("div", { class: "field" }, [
        el("span", { class: "field-label" }, [text(t("setup.pass.label"))]),
        pass,
      ]),
      el("div", { class: "field" }, [
        el("span", { class: "field-label" }, [text(t("setup.pass.repeatLabel"))]),
        again,
      ]),
      err,
    ]),
    el("div", { class: "bar", style: { gridAutoFlow: "row" } }, [create]),
  ]);
}

// ------------------------------------------------------------- recovery key

function recovery(ctx) {
  const grouped = formatRecoveryKey(recoveryKey);
  const groups = grouped.split("-");
  const grid = el(
    "div",
    { class: "keygrid", attrs: { role: "group", "aria-label": t("setup.key.title") } },
    groups.map((g) => el("span", {}, [text(g)])),
  );

  const box = el("input", { attrs: { type: "checkbox" } });
  const go = el(
    "button",
    { class: "btn is-primary is-big is-wide", attrs: { type: "button", disabled: "disabled" } },
    [text(t("setup.key.confirm"))],
  );
  box.addEventListener("change", () => {
    if (box.checked) go.removeAttribute("disabled");
    else go.setAttribute("disabled", "disabled");
  });
  go.addEventListener("click", () => {
    if (!box.checked) return;
    // Both copies go at the same moment: the grid on screen with the repaint,
    // the printable region by hand. After this click the key exists nowhere.
    removeEmergencySheet();
    recoveryKey = "";
    step = "template";
    ctx.render();
  });

  const copy = el(
    "button",
    { class: "btn-ghost", attrs: { type: "button" } },
    [text(t("setup.key.copy"))],
  );
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(formatRecoveryKey(recoveryKey));
      ctx.toast(t("setup.key.copied"));
    } catch {
      // No clipboard permission: the key is on screen, which is the point.
    }
  });

  // The alternative to a screenshot, which is what people otherwise reach for:
  // a photo library syncs to a cloud and is readable by every app that asked
  // for the gallery once. Print gives paper, and on iOS the same dialog saves
  // a PDF into Files - both places this key is allowed to be.
  const sheet = el(
    "button",
    { class: "btn-ghost", attrs: { type: "button" } },
    [icon("download", 15), text(t("setup.key.sheet.action"))],
  );
  sheet.addEventListener("click", () => {
    printEmergencySheet(grouped);
  });

  return screen([
    head("setup.key.eyebrow", "setup.key.title", "setup.key.body"),
    el("div", { class: "scroll" }, [
      grid,
      el("div", { class: "keyacts" }, [sheet, copy]),
      el("label", { class: "check" }, [
        box,
        el("span", { class: "check-box" }, [icon("check", 14)]),
        el("span", { class: "check-text" }, [text(t("setup.key.ack"))]),
      ]),
    ]),
    el("div", { class: "bar", style: { gridAutoFlow: "row" } }, [go]),
  ]);
}

// ------------------------------------------------------------------ template

function templateStep(ctx) {
  const choose = (withFrame) => {
    // The step is switched before the seeding, because seeding repaints and
    // would otherwise draw this screen a second time on its way out.
    step = "backup";
    if (withFrame) ctx.seedTemplate(TEMPLATE_KEYS.map((k) => t(k)));
    ctx.render();
  };

  const option = (labelKey, descKey, onClick, primary) =>
    el(
      "button",
      { class: `setrow${primary ? " is-danger" : ""}`, attrs: { type: "button" }, on: { click: onClick } },
      [
        el("span", {}, [
          el("span", { class: "setrow-label" }, [text(t(labelKey))]),
          el("span", { class: "setrow-desc" }, [text(t(descKey))]),
        ]),
        icon("chevronRight", 18),
      ],
    );

  return screen([
    head("setup.template.eyebrow", "setup.template.title", "setup.template.body"),
    el("div", { class: "scroll" }, [
      option("setup.template.empty", "setup.template.emptyDesc", () => choose(false)),
      option("setup.template.frame", "setup.template.frameDesc", () => choose(true)),
    ]),
  ]);
}

// -------------------------------------------------------------------- backup

/**
 * The last question of the first run, and the only one that decides whether
 * the list survives the browser it lives in. It is asked, never answered on
 * the user's behalf: the encrypted copy is the preselected offer, "Not now"
 * is one tap away, and neither answer blocks the way into the app.
 */
function backupStep(ctx) {
  const done = () => {
    reset();
    ctx.enterApp();
  };

  const keep = el(
    "button",
    { class: "btn is-primary is-big is-wide", attrs: { type: "button" } },
    [text(t("setup.backup.keep"))],
  );
  const skip = el(
    "button",
    {
      class: "btn-ghost",
      attrs: { type: "button" },
      on: {
        click: () => {
          if (!busy) done();
        },
      },
    },
    [text(t("common.notNow"))],
  );

  keep.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    clear(keep);
    keep.appendChild(text(t("setup.backup.working")));
    keep.setAttribute("disabled", "disabled");
    skip.setAttribute("disabled", "disabled");
    try {
      await ctx.sync.enable();
    } catch {
      // enableSync folds every network failure into its status phase; a throw
      // would be something else entirely and gets the same calm treatment.
    }
    busy = false;
    // Offline or a server that is down leaves the vault marked for sync and
    // retrying in the background - it must not hold up the first run, so the
    // toast says where to look and the app opens either way.
    if (ctx.sync.status.phase !== "idle") ctx.toast(t("setup.backup.later"));
    // Sync is on, so the reminder can be asked for. It is the step after this
    // one and only after this answer: without the server copy there is no
    // token a subscription could be registered with.
    step = "reminder";
    ctx.render();
  });

  return screen([
    head("setup.backup.eyebrow", "setup.backup.title", "setup.backup.body"),
    el("div", { class: "scroll" }, [
      el("p", { class: "field-hint", style: { maxWidth: "34ch" } }, [text(t("setup.backup.note"))]),
    ]),
    el("div", { class: "bar", style: { gridAutoFlow: "row" } }, [keep, skip]),
  ]);
}

// ------------------------------------------------------------------ reminder

/** "at 08:00" - the hour in the plain 24 hour form every locale can read. */
function hourLabel(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

/**
 * The daily reminder, asked where the decision actually gets made. Nobody
 * opens the settings later to switch this on, so the first run asks once -
 * right after the server copy, because a subscription needs that write token.
 *
 * Two shapes, one step. Where a permission prompt can lead somewhere, the
 * press is the prompt and the hour comes with it. Where it cannot - iOS
 * delivers push to the installed home-screen app and to nothing else - the
 * step says so plainly and continues; `ui/pushoffer.js` picks the question up
 * again at the first unlock inside the installed app. In that case nothing is
 * recorded as a decision, or that later offer would never appear.
 */
function reminderStep(ctx) {
  const done = () => {
    reset();
    ctx.enterApp();
  };

  // Asked and answered: neither answer is ever asked for a second time.
  // Written immediately rather than with the debounced autosave - the About
  // intro follows, and a reload in between would resurrect the question.
  const settle = () => ctx.setSettings({ pushOffered: true }, { now: true });

  if (!ctx.push.usableHere) {
    const go = el(
      "button",
      {
        class: "btn is-primary is-big is-wide",
        attrs: { type: "button" },
        on: { click: () => done() },
      },
      [text(t("setup.reminder.inApp"))],
    );
    return screen([
      head("setup.reminder.eyebrow", "setup.reminder.title", "setup.reminder.body"),
      el("div", { class: "scroll" }, [
        el("p", { class: "field-hint", style: { maxWidth: "34ch" } }, [text(t("push.ios"))]),
      ]),
      el("div", { class: "bar", style: { gridAutoFlow: "row" } }, [go]),
    ]);
  }

  const field = el("input", {
    class: "input",
    attrs: {
      type: "number",
      min: "0",
      max: "23",
      step: "1",
      inputmode: "numeric",
      "aria-label": t("push.hour"),
    },
  });
  field.value = String(ctx.push.status.hour);

  const turnOn = el(
    "button",
    { class: "btn is-primary is-big is-wide", attrs: { type: "button" } },
    [text(t("push.enable"))],
  );
  const skip = el(
    "button",
    {
      class: "btn-ghost",
      attrs: { type: "button" },
      on: {
        click: () => {
          if (busy) return;
          settle();
          done();
        },
      },
    },
    [text(t("common.notNow"))],
  );

  turnOn.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    const raw = Number(field.value);
    const hour = Math.max(0, Math.min(23, Math.trunc(Number.isFinite(raw) ? raw : 8)));
    clear(turnOn);
    turnOn.appendChild(text(t("setup.reminder.working")));
    turnOn.setAttribute("disabled", "disabled");
    skip.setAttribute("disabled", "disabled");
    try {
      // No await before this call: the permission prompt inside it has to stay
      // inside the gesture that asked for it.
      await ctx.push.enable(hour);
      ctx.toast(t("push.on", { time: hourLabel(hour) }));
    } catch (err) {
      // A refused permission, a server that will not answer: say it in the
      // ordinary toast and walk on. The first run is not a place to be stuck.
      ctx.toast(t(`push.error.${err && err.code ? err.code : "server"}`));
    }
    await ctx.push.refresh();
    busy = false;
    settle();
    done();
  });

  return screen([
    head("setup.reminder.eyebrow", "setup.reminder.title", "setup.reminder.body"),
    el("div", { class: "scroll" }, [
      el("div", { class: "field" }, [
        el("span", { class: "field-label" }, [text(t("push.hour"))]),
        field,
        el("p", { class: "field-hint" }, [text(t("push.hourHint"))]),
      ]),
      el("p", { class: "field-hint", style: { maxWidth: "34ch" } }, [text(t("push.ios"))]),
    ]),
    el("div", { class: "bar", style: { gridAutoFlow: "row" } }, [turnOn, skip]),
  ]);
}

export function render(ctx) {
  if (step === "adopt") return adopt(ctx);
  if (step === "pass") return passphrase(ctx);
  if (step === "key") return recovery(ctx);
  if (step === "template") return templateStep(ctx);
  if (step === "backup") return backupStep(ctx);
  if (step === "reminder") return reminderStep(ctx);
  return welcome(ctx);
}
