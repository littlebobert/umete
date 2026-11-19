const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const EXTENSION = path.join(__dirname, "..", "Extension");
const LANGUAGES = ["en", "ja", "ko"];
const messages = Object.fromEntries(LANGUAGES.map((language) => [
  language,
  JSON.parse(fs.readFileSync(path.join(EXTENSION, "_locales", language, "messages.json"), "utf8"))
]));
const read = (file) => fs.readFileSync(path.join(EXTENSION, file), "utf8");

test("every language has the same messages and placeholders as English", () => {
  const keys = Object.keys(messages.en).sort();
  for (const language of LANGUAGES) {
    assert.deepEqual(Object.keys(messages[language]).sort(), keys, language);
    for (const key of keys) {
      const entry = messages[language][key];
      assert.ok(entry.message.trim(), `${language} ${key} is empty`);
      const used = (text) => [...text.matchAll(/\$([A-Z]+)\$/g)].map((match) => match[1].toLowerCase()).sort();
      assert.deepEqual(used(entry.message), used(messages.en[key].message), `${language} ${key} placeholders`);
      for (const name of used(entry.message)) assert.ok(entry.placeholders?.[name], `${language} ${key} defines $${name}$`);
    }
  }
});

test("every key the popup, background page, and manifest use exists", () => {
  const html = read("popup.html");
  const scripts = read("popup.js") + read("background.js");
  const used = new Set([
    ...[...html.matchAll(/data-i18n(?:-aria-label)?="([^"]+)"/g)].map((match) => match[1]),
    ...[...scripts.matchAll(/\bt\("([A-Za-z_]+)"/g)].map((match) => match[1]),
    ...[...read("manifest.json").matchAll(/__MSG_([A-Za-z_]+)__/g)].map((match) => match[1])
  ]);
  for (const base of [...scripts.matchAll(/\bplural\("([A-Za-z_]+)"/g)].map((match) => match[1])) {
    used.add(`${base}_one`);
    used.add(`${base}_other`);
  }
  for (const key of ["filledWithAI_one", "filledWithAI_other_one", "filledWithAI_other_other"]) used.add(key);
  for (const key of used) assert.ok(messages.en[key], `missing message ${key}`);
});

test("lookups fill substitutions and pick English plurals", () => {
  const { t, plural } = loadWith("en");
  assert.equal(plural("filled", 1), "Filled 1 field. Please review everything before continuing.");
  assert.equal(plural("filled", 3), "Filled 3 fields. Please review everything before continuing.");
  assert.equal(t("filledWithAI_other_one", 4, 1), "Filled 4 fields, including 1 AI match. Please review everything before continuing.");
  assert.equal(loadWith("ja").plural("remembered", 2), "2件の回答を保存しました。パスワードと支払い情報の項目は保存していません。");
  assert.equal(loadWith("ko").t("missingKey"), "missingKey");
});

// UmeI18n with a stand-in for browser.i18n that reads one language's messages.json.
function loadWith(language) {
  const getMessage = (key, substitutions = []) => {
    const entry = messages[language][key];
    if (!entry) return "";
    return entry.message.replace(/\$([A-Z]+)\$/g, (_, name) => {
      const content = entry.placeholders[name.toLowerCase()].content;
      return substitutions[Number(content.slice(1)) - 1] ?? "";
    });
  };
  globalThis.browser = { i18n: { getMessage } };
  delete require.cache[require.resolve("../Extension/lib/i18n.js")];
  const api = require("../Extension/lib/i18n.js");
  return api;
}
