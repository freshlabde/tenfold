// haptics.js - the only thing in the web app that knows what a haptic is.
//
// What it does: names the five moments this app answers with touch feedback,
// maps each one onto the closed vocabulary the native shell accepts, and posts
// it. That is the whole module.
//
// Why it exists at all: iOS Safari has no Vibration API, so a web page on iOS
// cannot produce touch feedback of any kind. The shell can, and has been able
// to since wave 2a - a complete bridge, a documented vocabulary, unit tests and
// a launch-argument self-test, with not one caller on this side. Wave 2b is
// this file: the moments the design always meant to answer, finally answered.
//
// Why the callers get a NAMED MOMENT rather than a kind: the vocabulary is
// closed on the other side of the bridge - the shell rejects a name it does not
// know rather than guessing at one - and a closed vocabulary spread across five
// call sites in three files is a vocabulary that drifts on the sixth. Here,
// `rows.js` says a step was finished and this file decides that a finish feels
// like `success`. The day that mapping is wrong it is wrong in one place, and
// the day a new moment has no name in the vocabulary the answer is to ask for
// one on the native side, not to approximate with the nearest kind.
//
// The wire shape, fixed, and duplicated in the shell repository by the same
// necessity as every other message that crosses here - two repositories, no
// shared import:
//
//     { type: "haptic", kind: "impact-medium" }
//
// No `id`. The bridge offers one, and with it an ack that says whether the name
// was understood, but an ack is only useful to a caller that waits - and there
// is nothing in this app that may wait on its own touch feedback. Every one of
// the five moments is a gesture mid-flight: a decision being taken, a row
// collapsing, a list re-ordering. A promise on any of those paths would put the
// bridge between a finger and the thing it is moving.
//
// What it deliberately does NOT do: no settings switch. Haptics are a system
// preference on every platform that has them, and an app-level copy of a system
// switch is a second answer to a question the operating system has already
// asked. Somebody who wants silence turns it off once, for everything.
//
// In a browser this file is nothing at all: no shell, no capability, no post.

import { CAP_HAPTIC, shellWith, shellPost } from "./shell.js";

/**
 * The whole vocabulary, exactly as tenfold-ios/docs/BRIDGE.md lists it.
 *
 * Frozen and pinned by a test rather than merely written down: the shell
 * refuses an unrecognised kind, so a typo here would be silence - the one kind
 * of failure that is invisible in a suite and in a release alike. Nothing may
 * be added to this list from this side; the names come from the bridge.
 */
export const KINDS = Object.freeze({
  /** A light tick: a row selected, a toggle, a card settling. */
  IMPACT_LIGHT: "impact-light",
  /** A firmer tap: a committed action - a goal created, a rank applied. */
  IMPACT_MEDIUM: "impact-medium",
  /** Something completed: the duel resolving, a sync landing. */
  SUCCESS: "success",
  /** Worth noticing, not an error: a merge, a limit reached. */
  WARNING: "warning",

  /** The picker tick - what iOS itself plays for a row crossing a position
      in a table's edit mode. Its own kind rather than the lightest impact:
      a sort is a SERIES of positions, and a series of impacts would knock
      where this motion is supposed to click. */
  SELECTION: "selection",
});

const VOCABULARY = Object.freeze(Object.values(KINDS));

/**
 * Post one, or do nothing.
 *
 * Fire and forget, and guarded three ways: no shell, a shell that does not
 * advertise the capability, and a kind this file invented by accident. The
 * third guard is not paranoia about the shell - it is about this file. A name
 * that never reached the bridge is easier to find in a test here than in a
 * native log nobody is reading.
 *
 * @param {string} kind one of KINDS
 */
/**
 * Wake the engine without playing anything.
 *
 * Sent when a gesture has started that may end in a haptic. A row swipe
 * declares itself at 8px and commits at 92px; a notification pattern
 * (success, warning) asked of a cold Taptic Engine is quietly dropped, and
 * those milliseconds in between are exactly the warm-up it needs. This is why
 * sorting buzzed on the first device round while a lone swipe out of idle
 * stayed dead: the lift's impact had already woken the engine for the ticks
 * that followed, and the swipe had nobody to wake it.
 */
export function warmUp() {
  if (!shellWith(CAP_HAPTIC)) return;
  shellPost({ type: "haptic.prepare" });
}

function play(kind) {
  if (VOCABULARY.indexOf(kind) === -1) return;
  if (!shellWith(CAP_HAPTIC)) return;
  shellPost({ type: "haptic", kind });
}

/**
 * A decision taken in the duel.
 *
 * `impact-medium` is the vocabulary's "committed action, a rank applied", and
 * that is literally what this is: the pair is resolved and the order of the ten
 * has moved. Not `success` - that is the duel RESOLVING, the end of a run of
 * twenty of these, and a run where every step felt like an ending would feel
 * like twenty endings.
 */
export function decisionCommitted() {
  play(KINDS.IMPACT_MEDIUM);
}

/**
 * A step swiped to finished.
 *
 * `success` - "something completed" is the vocabulary's own wording for it, and
 * finishing a step is the one thing in this app that is unambiguously a
 * completion. It fires as the gesture commits, not after the collapse: the
 * feedback belongs to the finger that is still on the glass, and the animation
 * that follows is the app catching up with a decision already made.
 */
export function stepFinished() {
  play(KINDS.SUCCESS);
}

/**
 * A row swiped to deleted.
 *
 * `warning`, the vocabulary's "worth noticing but not an error". A deletion
 * here takes a whole subtree and asks for no confirmation - the undo toast is
 * the only safety net on this path - so it must not feel like the finish it
 * mirrors. `impact-medium` was the alternative and was rejected for exactly
 * that: a delete that feels the same as a commit teaches the hand nothing.
 */
export function rowDeleted() {
  play(KINDS.WARNING);
}

/**
 * The long press that lifts a row out of the list for reordering.
 *
 * `impact-light` - "a row selected", the vocabulary's first example, word for
 * word. It is also the only one of the five that is not the end of anything: it
 * says the press was long enough and the row is now yours, which is a piece of
 * information a finger holding still has no other way of getting.
 */
export function rowLifted() {
  play(KINDS.IMPACT_LIGHT);
}

/**
 * The row crossed a position while being dragged. Once per crossing, from
 * `place()` in rows.js - which already knows the moment, because it is the
 * moment it animates the neighbours out of the way.
 *
 * This is the haptic the first device rounds reported missing, by feel: the
 * lift spoke and then the whole sort was silent, so "no haptics when sorting"
 * was the honest description of one tick followed by nothing. A sort is the
 * one gesture in this app whose feedback is a rhythm rather than an event.
 */
export function rowShifted() {
  play(KINDS.SELECTION);
}

/**
 * The drag ended somewhere new. The settle after the rhythm - the same weight
 * as the lift, so picking up and putting down bracket the motion in the same
 * voice. Only when the order actually changed: putting a row back where it
 * came from is not an action, and must not feel like one.
 */
export function rowDropped() {
  play(KINDS.IMPACT_LIGHT);
}

/**
 * The vault opened.
 *
 * `success`: an unlock is a completion, and on the slow path it is the end of
 * six hundred thousand PBKDF2 rounds somebody has been waiting through. It is
 * fired from the one place all three envelopes converge - passphrase, WebAuthn,
 * the shell's own Face ID - because "the vault is open" is the fact worth
 * answering, not which of the three keys opened it.
 */
export function vaultUnlocked() {
  play(KINDS.SUCCESS);
}
