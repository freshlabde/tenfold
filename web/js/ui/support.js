// ui/support.js - the tip jar, and the only place the addresses live.
//
// What it does: one quiet sheet with three ways to buy the author a coffee -
// a PayPal link, a Bitcoin address and one EVM address that takes USDT and
// USDC on Ethereum. Each crypto address is offered twice over: as a QR code
// our own encoder draws, and as selectable mono text with a copy button, so a
// phone camera and a desktop clipboard both have a path.
//
// What it deliberately does NOT do:
//
//   - It does not exist inside the native shell. `window.__tenfoldShell` is
//     present exactly when this page is running inside the iOS app, and an
//     external payment link for a tip is an App Store rejection. The rows are
//     ABSENT there, not disabled, and `openSupportSheet` refuses on its own -
//     an entry point that gets added later cannot reopen the hole. The shell
//     gets an in-app purchase of its own, which is a different feature.
//   - No script, no image, no font, no request of any kind. The three payment
//     details below are string constants in this file; the QR symbols are
//     drawn locally by web/js/qr.js. Nothing here counts a visit, and nothing
//     here can tell whether anybody ever paid.
//   - It touches no document content and reads nothing from the vault, so the
//     sheet works with the vault sealed - the About screen it hangs off is
//     readable before unlocking.
//
// The addresses are written out ONCE, here, and pinned literally by
// tests/support.spec.js. A wrong character in a crypto address is money handed
// to nobody, and it is not the kind of mistake a screenshot review catches.

import { el, text } from "./dom.js";
import { t } from "../i18n.js";
import { closeSheet } from "./sheet.js";
import { qrCard } from "./qrview.js";
import { inShell } from "../shell.js";

/** The PayPal handle. Opened in a new context; see `paypalLink` below. */
export const PAYPAL_URL = "https://www.paypal.me/freshlab";

/** Native segwit (bech32), lower case as bech32 is defined. */
export const BITCOIN_ADDRESS = "bc1qzzvx2s3lqjv70p0rs2t99xfj86amvmzxscdeay";

/**
 * One EVM address for both stablecoins, on Ethereum mainnet. The mixed case is
 * the EIP-55 checksum and is part of the address: lower-casing it here would
 * throw away the one guard a wallet has against a mistyped character.
 */
export const EVM_ADDRESS = "0x76620dE4af43494864A270d7f9bE448F1a46BBea";

/**
 * The payload the QR codes carry: BIP-21 and EIP-681, so a wallet app opens
 * straight into a send screen instead of handing back a string to paste.
 *
 * Both are about fifty bytes, which the house encoder takes at version 4 of
 * the ten it can reach (level M, byte mode, 62 data bytes at that version) -
 * roughly a quarter of what it could carry. Verified in tests/support.spec.js
 * rather than assumed, and `qrFor` falls back to the bare address anyway, so a
 * payload that ever stopped fitting would cost the URI convenience and not the
 * code.
 */
export const BITCOIN_URI = `bitcoin:${BITCOIN_ADDRESS}`;
export const EVM_URI = `ethereum:${EVM_ADDRESS}`;

/**
 * Is there anywhere to show this?
 *
 * A capability question, not a platform one, and the same shape the widget row
 * uses: the web app offers the jar, the shell does not.
 * @returns {boolean}
 */
export function supportAvailable() {
  return !inShell();
}

/**
 * The QR card for one address: the wallet URI first, the bare address as the
 * fallback. `qrCard` answers null instead of throwing when a payload will not
 * fit, so this is one `||` and no error path.
 */
function qrFor(uri, bare, label) {
  return qrCard(uri, label) || qrCard(bare, label);
}

/**
 * One way to pay: a heading, the symbol, the address as text, a copy button
 * and - where there is something worth saying - one line of warning.
 */
function addressBlock(ctx, spec) {
  // Plain text, not a readonly input: an address has to be selectable with a
  // finger and it has to show its own case. `.input.is-mono` upper-cases what
  // it is given, which would destroy the EIP-55 checksum below.
  const value = el("div", { class: "addr" }, [text(spec.address)]);

  const copy = el(
    "button",
    {
      class: "btn",
      attrs: { type: "button" },
      on: {
        click: async () => {
          try {
            await navigator.clipboard.writeText(spec.address);
            ctx.toast(t("support.copied"));
          } catch {
            // No clipboard permission: the address is on screen and selectable,
            // which is the path that never needed one.
          }
        },
      },
    },
    [text(t("support.copy"))],
  );

  return el("div", { class: "support-block" }, [
    el("div", { class: "support-label" }, [text(t(spec.labelKey))]),
    qrFor(spec.uri, spec.address, t(spec.qrLabelKey)),
    value,
    copy,
    spec.hintKey ? el("p", { class: "field-hint" }, [text(t(spec.hintKey))]) : null,
  ]);
}

/**
 * The PayPal row. A real anchor rather than `window.open`: the destination is
 * visible on hover and on a long press, it needs no script, and it survives
 * with JavaScript doing nothing at all.
 *
 * `target="_blank"` leaves the app in its own tab, which is the honest thing
 * for a payment page - and the rel pair is not decoration: `noopener` denies
 * the opened page a handle on this one (this window holds a decrypted vault),
 * `noreferrer` keeps the address of the app out of PayPal's logs on top of the
 * server's own Referrer-Policy. The strict CSP allows this: it governs what
 * this document may LOAD, and a top-level navigation to another origin loads
 * nothing into this page.
 */
function paypalLink() {
  return el(
    "a",
    {
      class: "btn is-primary is-wide",
      attrs: {
        href: PAYPAL_URL,
        target: "_blank",
        rel: "noopener noreferrer",
        referrerpolicy: "no-referrer",
      },
    },
    [text(t("support.paypal"))],
  );
}

/**
 * The sheet. Order is deliberate: the way most people will actually use first,
 * then the two that need a wallet.
 *
 * @param {Object} ctx the app context (openSheet, toast)
 */
export function openSupportSheet(ctx) {
  // The guard sits here as well as at every entry point. A sheet is reachable
  // from anywhere somebody wires a button to it later, and the shell rule has
  // to hold without that person having read this file.
  if (!supportAvailable()) return null;

  const body = el("div", {}, [
    el("p", { class: "check-text", style: { paddingTop: "6px" } }, [text(t("support.body"))]),

    el("div", { class: "support-block" }, [
      paypalLink(),
      el("p", { class: "field-hint" }, [text(t("support.paypalHint"))]),
    ]),

    addressBlock(ctx, {
      labelKey: "support.btc",
      qrLabelKey: "support.qrBtc",
      address: BITCOIN_ADDRESS,
      uri: BITCOIN_URI,
    }),

    addressBlock(ctx, {
      labelKey: "support.evm",
      qrLabelKey: "support.qrEvm",
      address: EVM_ADDRESS,
      uri: EVM_URI,
      hintKey: "support.evmHint",
    }),

    el("p", { class: "field-hint support-privacy" }, [text(t("support.privacy"))]),
  ]);

  const footer = el("div", { class: "sheet-foot" }, [
    el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => closeSheet() } }, [
      text(t("common.close")),
    ]),
  ]);

  return ctx.openSheet({ title: t("support.title"), body, footer });
}

/**
 * The closing line of the About screen, or null where there is none.
 *
 * A sentence in the About's own register rather than a button that looks like
 * a checkout: it sits after the claim, in the muted tone, and is the last
 * thing on the screen.
 * @param {Object} ctx
 * @returns {HTMLElement|null}
 */
export function supportAboutLine(ctx) {
  if (!supportAvailable()) return null;
  return el(
    "button",
    {
      class: "support-line",
      attrs: { type: "button" },
      on: { click: () => openSupportSheet(ctx) },
    },
    [text(t("support.about"))],
  );
}
