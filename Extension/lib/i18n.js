(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.UmeI18n = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  // The extension's text lives in _locales/<language>/messages.json, which
  // Safari picks from the system language (English, Japanese, or Korean).
  // English plurals are separate keys ending in _one and _other; Japanese and
  // Korean give both the same text.

  function i18nAPI() {
    return root.browser?.i18n || root.chrome?.i18n || null;
  }

  // A message by key, with $1, $2… filled from the remaining arguments. Falls
  // back to the key itself, so a missing message is visible rather than blank.
  function t(key, ...substitutions) {
    const message = i18nAPI()?.getMessage(key, substitutions.map(String));
    return message || key;
  }

  function pluralKey(base, count) {
    return `${base}_${Number(count) === 1 ? "one" : "other"}`;
  }

  // A message whose first substitution is a count.
  function plural(base, count, ...more) {
    return t(pluralKey(base, count), count, ...more);
  }

  // Fills elements marked data-i18n (text) and data-i18n-aria-label.
  function localizeDocument(doc) {
    doc.querySelectorAll("[data-i18n]").forEach((element) => {
      element.textContent = t(element.dataset.i18n);
    });
    doc.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
      element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
    });
    const language = i18nAPI()?.getUILanguage?.();
    if (language) doc.documentElement.lang = language;
  }

  return { t, plural, pluralKey, localizeDocument };
});
