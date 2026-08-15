// ui/lock.js - the screen in front of the vault.
//
// What it does: takes the passphrase, or the recovery key when the passphrase
// is gone, and hands it to the context. Also the route to the About text and to
// the public method page from outside the vault - this is the screen a stranger
// meets when somebody hands them a phone, and both of those have to answer
// "what is this" without anything being unlocked first.
//
// When this device has enrolled its own authenticator, the first thing on the
// screen is the biometric button, and it fires itself once - that is the answer
// to "a reload locks the vault immediately": reload, one touch, back in.
//
// There are two authenticators behind that one button and never both: the
// browser's WebAuthn PRF credential, or - inside the native shell, where
// WebAuthn does not exist - the key the shell keeps behind Face ID. The slot,
// the label and the automatic first attempt are identical, because to the
// person in front of it this is one feature.
//
// When this device could do that and has not armed it, the screen says so
// once, quietly, under the form: somebody typing a passphrase every morning on
// a phone with a face scanner is being asked for something they do not have to
// give, and a settings screen they never open is the wrong place to mention it.
// The offer cannot enrol on the spot - a new envelope can only be built by
// somebody who already holds the master key, and up here nobody does - so
// tapping it remembers the wish and the next successful unlock fulfils it. One
// dismissal is final, and it is stored outside the vault because up here the
// vault cannot be read.
//
// The shell path can refuse in five ways and only two of them are worth a word:
// too many failed attempts, and an enrolment that changed. Those get one quiet
// line under the button - a line, not a banner and not a sheet, and it does not
// come back on the next screen. The other three (cancelled, missing, anything
// else) leave the passphrase field focused and say nothing at all.
//
// What it deliberately does NOT do: it does not say whether a passphrase was
// "almost" right, does not count attempts on screen, does not remember what
// was typed, and never keeps the entered secret in a variable after the call.
// A cancelled or failed biometric prompt says nothing at all - it just leaves
// the passphrase field focused, because cancelling is not an error.

import { el, text, icon, clear } from "./dom.js";
import { t } from "../i18n.js";
import { langSwitch } from "./langswitch.js";
import { methodFootLink } from "./policy.js";

let mode = "pass";
let failed = false;
let busy = false;
/** The automatic prompt fires once per arrival on this screen, never per paint. */
let prompted = false;
/** i18n key of the one quiet line the biometric path may leave, or null. */
let notice = null;
/**
 * Whether this arrival has already asked the device what it can do. The answer
 * arrives after the paint that needed it, so it costs one repaint - and one is
 * all it may ever cost, however often this screen is rebuilt in between.
 */
let probed = false;

export function reset() {
  mode = "pass";
  failed = false;
  busy = false;
  prompted = false;
  notice = null;
  probed = false;
}

export function render(ctx) {
  const isKey = mode === "key";
  const input = el("input", {
    class: `input${isKey ? " is-mono" : ""}`,
    attrs: {
      type: isKey ? "text" : "password",
      placeholder: isKey ? t("lock.keyPlaceholder") : t("lock.passPlaceholder"),
      "aria-label": isKey ? t("lock.keyLabel") : t("lock.passLabel"),
      autocomplete: isKey ? "off" : "current-password",
      autocapitalize: "none",
      spellcheck: "false",
      enterkeyhint: "go",
    },
  });

  const err = el("div", { class: "field-error" }, failed ? [text(t("lock.wrong"))] : []);

  const unlock = el(
    "button",
    { class: "btn is-primary is-big is-wide", attrs: { type: "button" } },
    [icon("unlock", 18), text(t("common.unlock"))],
  );

  const submit = async () => {
    if (busy) return;
    const secret = input.value;
    if (!secret) return;
    busy = true;
    clear(unlock);
    unlock.appendChild(text(t("setup.pass.working")));
    unlock.setAttribute("disabled", "disabled");
    await new Promise((r) => requestAnimationFrame(() => r()));
    try {
      await ctx.unlock(secret, isKey ? "recovery" : "pass");
      input.value = "";
      failed = false;
      busy = false;
      ctx.enterApp();
    } catch {
      busy = false;
      failed = true;
      input.value = "";
      ctx.render();
    }
  };

  unlock.addEventListener("click", submit);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") submit();
  });

  const toggle = el(
    "button",
    {
      class: "btn-ghost",
      attrs: { type: "button" },
      on: {
        click: () => {
          mode = isKey ? "pass" : "key";
          failed = false;
          ctx.render();
        },
      },
    },
    [text(isKey ? t("lock.usePass") : t("lock.useKey"))],
  );

  const about = el(
    "button",
    { class: "btn-ghost", attrs: { type: "button" }, on: { click: () => ctx.go("about") } },
    [text(t("common.about"))],
  );

  // The method, as its own entry rather than one buried a tap deeper inside
  // About: what this app is asking somebody to do is the one thing a locked
  // screen should still be able to explain. A real link, in the same quiet
  // register as the two buttons beside it, and it carries the same href rule
  // as every other placement (absolute inside the shell, where a same-origin
  // target="_blank" is inert).
  const method = methodFootLink();

  // The device's own authenticator, when this device armed one. The button is
  // above the field because it is the shorter way in; the field below it never
  // goes away.
  //
  // Two possible sources, checked in this order and never both: inside the
  // shell webauthn.supported() is false by construction, so the second branch
  // cannot fire there - and the shell path is absent in a browser, where there
  // is no capability to find.
  //
  // The two halves are named before the mode is taken into account, because
  // they answer a second question as well: whether this device can open the
  // vault without the passphrase. That is one fact and it must be asked once -
  // the subtitle below reads the same booleans the button is built from, so a
  // screen offering the button can never also promise the button cannot exist.
  const shellBioArmed = ctx.shellBio.supported && ctx.shellBio.enabled && !ctx.shellBio.hidden;
  const prfArmed = ctx.biometric.supported && ctx.biometric.enrolled;
  const useShell = !isKey && shellBioArmed;
  const usePrf = !isKey && prfArmed;
  const biometric = useShell
    ? shellBioButton(ctx, input)
    : usePrf
      ? biometricButton(ctx, input)
      : null;

  // One line, in the same muted voice as the subtitle above it. It says what
  // happened to a way in that used to work; it is not a call to action, and it
  // is gone the next time this screen is built.
  const bioNote = notice ? el("p", { class: "lock-sub", dataset: { bio: "note" } }, [text(t(notice))]) : null;

  // The other half of the same fact: this device COULD open the vault without
  // the passphrase and nobody has told it to. Four things have to be true, and
  // the first two are the booleans above read the other way round, so the
  // screen can never offer to arm something it is simultaneously offering to
  // use.
  //
  //   nothing armed      `!shellBioArmed && !prfArmed` - the same single
  //                      reading of the vault the button and the subtitle use.
  //   the device can     asked of the device, not of the build: a shell with
  //                      the capability still answers "no hardware here", and a
  //                      browser without a platform authenticator answers the
  //                      same. Nothing is offered on a device that would fail.
  //   never asked away   one dismissal is permanent (see ctx.bioOffer).
  //   nothing else to    the recovery-key mode belongs to somebody who cannot
  //   read here          get in at all, a `notice` is a loss being explained,
  //                      and after an enrolment change the re-offer is the
  //                      settings row's own wording by contract - none of those
  //                      moments may carry a convenience offer on top.
  const offerable =
    !isKey && !notice && !shellBioArmed && !prfArmed && !ctx.shellBio.setupAgain && !ctx.bioOffer.dismissed
      ? offerableKind(ctx, input)
      : null;
  const offer = offerable ? bioOfferLine(ctx, offerable, input) : null;

  queueMicrotask(() => input.focus());

  // The foot of this screen carries four different kinds of thing, and it used
  // to carry them as four equally loud rows. They are still all here and all
  // reachable; what changed is the grouping.
  //
  //   the recovery key   an ACTION for somebody who cannot get in. It now
  //                      stands directly under the unlock button, because it
  //                      belongs to the field above it and not to a row of
  //                      links it has nothing in common with.
  //   method / About     two things to READ, and the only pair on the screen.
  //                      Centred together, in one quiet line.
  //   the languages      a setting. Unchanged.
  //   the wipe           destructive and irreversible: last, quietest, and
  //                      with real distance in front of it.
  //
  // No entry was added, removed, renamed or hidden behind another tap, and no
  // string was invented for a grouping label - the kinds separate by position
  // and distance, which is cheaper than a heading and says the same thing.
  return el("section", { class: "screen is-lock" }, [
    el("div", { class: "lock" }, [
      el("div", { class: "lock-mark" }, [icon("mark", 34)]),
      el("h1", { class: "lock-title" }, [text(t("lock.title"))]),
      // The promise under the title, and it has to be true of the device it is
      // being read on. `lock.sub` says nothing here can read the list without
      // the passphrase; that was true of three wrappers and stopped being true
      // with the fourth. Where a face or a fingerprint on THIS device holds a
      // key to this vault, the honest sentence says so - and says that it is
      // this device only, because that is the part somebody is entitled to
      // rely on everywhere else. Which sentence appears is decided by the same
      // two booleans the button is, never by a second reading of the vault.
      el("p", { class: "lock-sub" }, [
        text(
          ctx.autoLocked
            ? t("lock.autoLocked", { minutes: ctx.idleMinutes })
            : shellBioArmed || prfArmed
              ? t("lock.subBio")
              : t("lock.sub"),
        ),
      ]),
      biometric,
      bioNote,
      el("div", { class: "field" }, [input]),
      err,
    ]),
    el("div", { class: "bar", style: { gridAutoFlow: "row" } }, [unlock]),
    el("div", { class: "lock-alt" }, [toggle]),
    // Under the recovery key and not above it: that one is for somebody who
    // cannot get in NOW, and this one is about the unlock after this one. It
    // stays in the band of things to DO, above the pair of things to read,
    // because it is an offer and not a document.
    offer,
    el("div", { class: "lock-foot" }, [method, about]),
    langSwitch(ctx),
    // The way out when the passphrase is truly gone and no key exists:
    // wipe this device's copy and start over. Deliberately quiet - it is
    // an escape hatch, not an invitation.
    el("div", { class: "lock-reset" }, [
      el(
        "button",
        { class: "btn-ghost", attrs: { type: "button" }, on: { click: () => confirmReset(ctx) } },
        [text(t("lock.reset"))],
      ),
    ]),
  ]);
}

/**
 * The biometric way in. One button, one neutral label - naming Face ID or
 * Touch ID would be wrong on half the devices that can do this - and one
 * automatic attempt when the screen appears.
 */
function biometricButton(ctx, field) {
  const button = el(
    "button",
    { class: "btn is-primary is-big is-wide", attrs: { type: "button" }, dataset: { bio: "unlock" } },
    [icon("unlock", 18), text(t("webauthn.unlock"))],
  );

  let running = false;
  const attempt = async () => {
    if (running || busy) return;
    running = true;
    try {
      await ctx.unlockBiometric();
      ctx.enterApp();
    } catch {
      // Cancelled, dismissed, a credential this vault does not know: the
      // passphrase is right there, and nothing is said about it.
      running = false;
      if (field && field.isConnected) field.focus();
    }
  };

  button.addEventListener("click", attempt);
  if (!prompted) {
    prompted = true;
    // One frame later, so the screen is painted behind the system prompt.
    requestAnimationFrame(() => attempt());
  }
  return el("div", { class: "lock-bio" }, [button]);
}

/**
 * The same button, one layer down: the shell holds the key behind the device's
 * own Face ID or Touch ID. Same slot, same neutral label, same single automatic
 * attempt - and five possible refusals, of which exactly two are said out loud.
 *
 *   cancelled   the person dismissed the sheet. Silence: cancelling is not an
 *               error, and the passphrase field is already there.
 *   failed      anything else that went wrong. Silence, same reasoning.
 *   lockedOut   biometry wants the device passcode before it works again. One
 *               line, because inviting another try would be a lie.
 *   invalidated the enrolled face changed, so this envelope is dead. One line
 *               that says the passphrase is needed once, and the offer to set
 *               it up again waits in settings - it is not a sheet, not a nag,
 *               and it does not repeat.
 *   missing     there is no key for this vault: the feature is off, whatever
 *               the vault file still says. The button goes, silently, and the
 *               dead wrapper is cleaned away after the passphrase unlock.
 */
function shellBioButton(ctx, field) {
  const button = el(
    "button",
    { class: "btn is-primary is-big is-wide", attrs: { type: "button" }, dataset: { bio: "shell" } },
    [icon("unlock", 18), text(t("webauthn.unlock"))],
  );

  let running = false;
  const attempt = async () => {
    if (running || busy) return;
    running = true;
    try {
      await ctx.unlockShellBio();
      ctx.enterApp();
    } catch (err) {
      running = false;
      const code = err && err.code ? err.code : "failed";
      notice = code === "lockedOut" ? "bio.lockedOut" : code === "invalidated" ? "bio.invalidated" : null;
      if (notice || code === "missing") {
        // Either there is something new to read, or the button has just stopped
        // being an offer this screen may keep making.
        ctx.render();
        return;
      }
      if (field && field.isConnected) field.focus();
    }
  };

  button.addEventListener("click", attempt);
  if (!prompted) {
    prompted = true;
    // One frame later, so the screen is painted behind the system prompt.
    requestAnimationFrame(() => attempt());
  }
  return el("div", { class: "lock-bio" }, [button]);
}

/**
 * Which enrolment this device could still arm: "shell", "prf", or null.
 *
 * The same never-both rule the button follows, asked in the same order: inside
 * the shell there is no WebAuthn, and in a browser there is no shell, so the
 * two branches are exclusive by construction rather than by a check.
 *
 * Both halves answer asynchronously and both start at null - "not asked yet",
 * which is not the same as "no". A paint cannot wait for that, so an unasked
 * device draws nothing, asks once, and repaints if the answer turns out to be
 * yes. `available && enrolled` for the shell, because hardware with no face
 * registered on it would fail at the first prompt.
 */
function offerableKind(ctx, field) {
  if (ctx.shellBio.supported) {
    const known = ctx.shellBio.availableCached;
    if (known === null) {
      probeOnce(ctx, field, () => ctx.shellBio.available());
      return null;
    }
    return known.available && known.enrolled ? "shell" : null;
  }
  if (ctx.biometric.supported) {
    const known = ctx.biometric.availableCached;
    if (known === null) {
      probeOnce(ctx, field, () => ctx.biometric.available());
      return null;
    }
    return known === true ? "prf" : null;
  }
  return null;
}

/**
 * Ask the device once, and repaint only if repainting costs nothing.
 *
 * A repaint of this screen builds a new passphrase field, so anything typed
 * into the old one is gone - which would turn a background probe into lost
 * keystrokes. So the repaint is skipped where it would be felt: another screen,
 * an unlock already in flight, or a field somebody has started typing into. The
 * offer then simply waits for the next arrival here, which is the cheapest
 * possible way to be wrong.
 */
function probeOnce(ctx, field, ask) {
  if (probed) return;
  probed = true;
  Promise.resolve()
    .then(ask)
    .then(() => {
      if (busy || ctx.view.name !== "lock") return;
      if (field && field.isConnected && field.value) return;
      ctx.repaint();
    })
    .catch(() => {
      // A device that will not answer is a device with nothing to offer.
    });
}

/**
 * The offer itself. One quiet line with two ways out of it - take it, or never
 * be asked again - and it is deliberately not a sheet: nothing here interrupts
 * an unlock somebody is in the middle of.
 *
 * IT CANNOT ENROL HERE. Arming a biometric envelope means wrapping the master
 * key, and on this screen there is no master key: the vault is shut, that is
 * what the screen is for. So the tap records a wish and the enrolment happens
 * at the first moment it can - right after the next successful unlock, from
 * app.js, through the one enrolment flow settings already uses.
 *
 * Both taps rewrite this line in place instead of calling ctx.render(). A full
 * repaint would replace the passphrase field and drop whatever was already
 * typed into it, and somebody who accepts an offer about the NEXT unlock has
 * usually started on this one.
 */
function bioOfferLine(ctx, kind, field) {
  const line = el("div", { class: "lock-offer", dataset: { bio: "offer-line" } }, []);

  const armed = () => {
    clear(line);
    line.appendChild(
      el("p", { class: "lock-offer-note", dataset: { bio: "offer-armed" } }, [text(t("bio.offerArmed"))]),
    );
    if (field && field.isConnected) field.focus();
  };

  const accept = el(
    "button",
    {
      class: "btn-ghost",
      attrs: { type: "button" },
      dataset: { bio: "offer" },
      on: {
        click: () => {
          ctx.bioOffer.arm(kind);
          armed();
        },
      },
    },
    [text(t("bio.offer"))],
  );

  const no = el(
    "button",
    {
      class: "btn-ghost is-quiet",
      attrs: { type: "button" },
      dataset: { bio: "offer-dismiss" },
      on: {
        click: () => {
          // Persistent, and on purpose: an offer that returns every morning is
          // the nag this one exists not to be.
          ctx.bioOffer.dismiss();
          line.remove();
          if (field && field.isConnected) field.focus();
        },
      },
    },
    [text(t("bio.offerDismiss"))],
  );

  // A wish taken on an earlier visit to this screen survives a lock that was
  // never followed by an unlock, so the line has to be able to open in the
  // state it was left in.
  if (ctx.bioOffer.armed) armed();
  else line.append(accept, no);
  return line;
}

/** The wipe is irreversible on this device - say so in plain words first. */
function confirmReset(ctx) {
  const body = el("div", {}, [
    el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("lock.reset.body"))]),
    el("p", { class: "check-text" }, [text(t("lock.reset.syncNote"))]),
  ]);
  const footer = el("div", { class: "sheet-foot" }, [
    el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => ctx.closeSheet() } }, [
      text(t("common.cancel")),
    ]),
    el(
      "button",
      {
        class: "btn is-primary",
        attrs: { type: "button" },
        on: { click: () => ctx.wipeLocalVault() },
      },
      [text(t("lock.reset.confirm"))],
    ),
  ]);
  ctx.openSheet({ title: t("lock.reset.title"), body, footer });
}
