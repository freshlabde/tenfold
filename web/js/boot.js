// boot.js - the only classic (non-module) script in the app.
//
// What it does: reads the three non-secret presentation preferences (skin,
// theme, language) and puts them on <html> synchronously, before the first
// paint. Without this the app would paint the default skin and repaint after
// the vault is unlocked, which reads as a bug.
//
// What it deliberately does NOT do: it never touches vault data. The real
// source of truth for these settings is doc.settings inside the encrypted
// vault; this is a mirror kept in localStorage so it can be read while the
// vault is still locked. Nothing here is user content: three enum values.
// No eval, no network, no DOM beyond the root attributes.
(function () {
  "use strict";
  var SKINS = { slate: 1, register: 1, breath: 1 };
  var THEMES = { dark: 1, light: 1 };
  var LOCALES = { en: 1, de: 1, es: 1 };
  var root = document.documentElement;
  try {
    var raw = window.localStorage.getItem("tenfold.ui");
    if (!raw) return;
    var p = JSON.parse(raw);
    if (p && SKINS[p.skin]) root.setAttribute("data-skin", p.skin);
    if (p && THEMES[p.theme]) root.setAttribute("data-theme", p.theme);
    if (p && LOCALES[p.lang]) root.setAttribute("lang", p.lang);
  } catch (e) {
    // Private mode, disabled storage, corrupt JSON: the defaults on <html> win.
  }
})();
