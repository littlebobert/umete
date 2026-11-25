#!/usr/bin/env node
// Drafts labels/firefox/*.out, the expected field types for Firefox's test pages
// (fetched by fetch-firefox.sh), in the Chromium corpus's .out format so run.js
// scores them the same way.
//
// Firefox's tests list the fields its heuristics find on each page in document
// order, by autocomplete name, without saying which element each is; fields
// Firefox misses are left in as comments. This lines each listed field, missed
// ones included, up with the page's controls in order, preferring controls whose
// name, id, autocomplete, label, or placeholder fit the field. The result is a
// draft: check every line before committing, since a misaligned line is a wrong
// expectation. Lines marked "check" fit poorly.
//
// It writes only labels that don't exist yet, so hand-checked ones are kept;
// --force redrafts them too.
//
// Usage: node firefox-labels.js [--only Walmart] [--force]

const fs = require("node:fs");
const path = require("node:path");
const { webkit } = require("playwright");

const CORPUS = path.join(__dirname, "corpus", "firefox");
const LABELS = path.join(__dirname, "labels", "firefox");

// Firefox's field names as the Chromium types expect.js scores.
const TYPES = {
  "given-name": "NAME_FIRST", "additional-name": "NAME_MIDDLE", "family-name": "NAME_LAST", name: "NAME_FULL",
  email: "EMAIL_ADDRESS", organization: "COMPANY_NAME",
  tel: "PHONE_HOME_WHOLE_NUMBER", "tel-extension": "PHONE_HOME_EXTENSION", "tel-country-code": "PHONE_HOME_COUNTRY_CODE",
  "tel-area-code": "PHONE_HOME_CITY_CODE", "tel-local": "PHONE_HOME_NUMBER",
  "tel-local-prefix": "PHONE_HOME_NUMBER_PREFIX", "tel-local-suffix": "PHONE_HOME_NUMBER_SUFFIX",
  "street-address": "ADDRESS_HOME_STREET_ADDRESS", "address-line1": "ADDRESS_HOME_LINE1",
  "address-line2": "ADDRESS_HOME_LINE2", "address-line3": "ADDRESS_HOME_LINE3",
  "address-level2": "ADDRESS_HOME_CITY", "address-level1": "ADDRESS_HOME_STATE",
  "postal-code": "ADDRESS_HOME_ZIP", country: "ADDRESS_HOME_COUNTRY", "country-name": "ADDRESS_HOME_COUNTRY",
  "cc-number": "CREDIT_CARD_NUMBER", "cc-name": "CREDIT_CARD_NAME_FULL",
  "cc-given-name": "CREDIT_CARD_NAME_FIRST", "cc-family-name": "CREDIT_CARD_NAME_LAST",
  "cc-exp-month": "CREDIT_CARD_EXP_MONTH", "cc-exp-year": "CREDIT_CARD_EXP_4_DIGIT_YEAR",
  "cc-exp": "CREDIT_CARD_EXP_DATE_4_DIGIT_YEAR", "cc-csc": "CREDIT_CARD_VERIFICATION_CODE", "cc-type": "CREDIT_CARD_TYPE",
  password: "PASSWORD", "new-password": "ACCOUNT_CREATION_PASSWORD",
  "bday-day": "BIRTHDATE_DAY", "bday-month": "BIRTHDATE_MONTH", "bday-year": "BIRTHDATE_4_DIGIT_YEAR"
};

// Words that suggest a control is that field, in the languages the pages use.
const HINTS = {
  "given-name": /first|given|fname|forename|prénom|prenom|vorname/,
  "additional-name": /middle|\bmi\b|initial/,
  "family-name": /last|family|surname|lname|\bnom\b|nachname/,
  name: /name|nom/,
  email: /e-?mail|courriel/,
  organization: /company|organi[sz]ation|business|société|firma/,
  tel: /phone|\btel|mobile|téléphone|telefon/,
  "tel-extension": /\bext/,
  "tel-area-code": /area|phone|tel/,
  "tel-local-prefix": /phone|tel|prefix|exchange/,
  "tel-local-suffix": /phone|tel|suffix|line/,
  "street-address": /address|street|adresse/,
  "address-line1": /address|street|line ?1|addr1|adresse|straße|strasse/,
  "address-line2": /line ?2|addr2|address2|apt|suite|unit|complément/,
  "address-level2": /city|town|ville|\bort\b/,
  "address-level1": /state|province|region|county/,
  "postal-code": /zip|postal|post ?code|\bplz\b|code postal/,
  country: /country|pays|\bland\b/,
  "cc-number": /card.?(num|no)|cc.?num|credit|account.?num|numéro|kartennummer/,
  "cc-name": /name.?on|holder|cc.?name|card.?name|titulaire/,
  "cc-given-name": /first/,
  "cc-family-name": /last/,
  "cc-exp-month": /month|\bmm\b|exp/,
  "cc-exp-year": /year|\byy|exp/,
  "cc-exp": /exp|mm.?yy/,
  "cc-csc": /cvv|cvc|csc|cid|security|verification|cryptogram/,
  "cc-type": /card.?type|brand|type/,
  "bday-day": /day|birth|dob|bday/,
  "bday-month": /month|birth|dob|bday/,
  "bday-year": /year|birth|dob|bday/
};

// The fields each fixture lists, in order, from the site's browser_<Site>.js.
// Commented-out entries are fields Firefox misses; they're real fields too.
function parseTests(source) {
  return source.split(/fixturePath:\s*/).slice(1).map((chunk) => {
    const fixture = chunk.match(/^"([^"]+)"/)[1];
    const fields = [];
    for (const line of chunk.split("\n")) {
      const match = line.match(/fieldName:\s*"([a-z0-9-]+)"/);
      if (!match) continue;
      const missed = /\/\/[^\n]*fieldName/.test(line) && line.indexOf("//") < line.indexOf("fieldName");
      fields.push({ fieldName: match[1], missed });
    }
    return { fixture, fields };
  });
}

function pageControls() {
  const skip = new Set(["hidden", "submit", "button", "image", "reset", "file", "checkbox", "radio"]);
  const text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
  const controls = [...document.querySelectorAll("input, select, textarea")].filter((element) => !skip.has((element.type || "").toLowerCase()));
  return controls.map((element, index) => {
    const id = element.id || "";
    const labels = [...(element.labels || [])].map(text);
    let previous = element.previousElementSibling;
    while (previous && !text(previous)) previous = previous.previousElementSibling;
    const parentText = text(element.parentElement).slice(0, 80);
    const label = labels.join(" ") || element.getAttribute("aria-label") || element.placeholder || element.title || text(previous).slice(0, 80) || parentText;
    return {
      index,
      tag: element.tagName.toLowerCase(),
      type: (element.type || "").toLowerCase(),
      name: element.getAttribute("name") || "",
      id,
      autocomplete: (element.getAttribute("autocomplete") || "").toLowerCase(),
      label,
      hint: [element.getAttribute("name"), id, element.getAttribute("autocomplete"), element.placeholder, element.getAttribute("aria-label"), element.title, label]
        .filter(Boolean).join(" ").toLowerCase()
    };
  });
}

function fit(fieldName, control) {
  const tokens = control.autocomplete.split(/\s+/);
  if (tokens.includes(fieldName)) return 4;
  const password = control.type === "password";
  if (fieldName === "password" || fieldName === "new-password") return password ? 3 : -3;
  if (password) return -3;
  let score = HINTS[fieldName]?.test(control.hint) ? 2 : -1;
  if (fieldName === "email" && control.type === "email") score = 3;
  if (fieldName.startsWith("tel") && control.type === "tel") score = Math.max(score, 2);
  if (/^(given|family|additional)-name$/.test(fieldName) && /\b(first|last).?name\b/.test(control.hint)
      && !HINTS[fieldName].test(control.hint)) score = -2;
  return score;
}

// Lines the fields up with controls in order, maximizing how well they fit. A
// field may go unmatched (it may be in an iframe) at a cost.
function align(fields, controls) {
  const UNMATCHED = -2.5;
  const rows = fields.length, cols = controls.length;
  const best = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(-Infinity));
  const step = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(null));
  for (let j = 0; j <= cols; j += 1) best[0][j] = 0;
  for (let i = 1; i <= rows; i += 1) {
    for (let j = 0; j <= cols; j += 1) {
      const options = [[best[i - 1][j] + UNMATCHED, "unmatched"]];
      if (j > 0) {
        options.push([best[i][j - 1], "skip"]);
        options.push([best[i - 1][j - 1] + fit(fields[i - 1].fieldName, controls[j - 1]), "match"]);
      }
      for (const [value, kind] of options) if (value > best[i][j]) { best[i][j] = value; step[i][j] = kind; }
    }
  }
  const result = new Array(rows).fill(null);
  for (let i = rows, j = cols; i > 0;) {
    const kind = step[i][j];
    if (kind === "match") { result[i - 1] = controls[j - 1]; i -= 1; j -= 1; }
    else if (kind === "skip") j -= 1;
    else i -= 1;
  }
  return result;
}

async function main() {
  const onlyAt = process.argv.indexOf("--only");
  const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : null;
  if (!fs.existsSync(CORPUS)) throw new Error("No Firefox pages yet. Run ./fetch-firefox.sh first.");
  fs.mkdirSync(LABELS, { recursive: true });
  const browser = await webkit.launch();
  try {
    for (const site of fs.readdirSync(CORPUS).sort()) {
      if (only && site !== only) continue;
      const testFile = path.join(CORPUS, site, `browser_${site}.js`);
      if (!fs.existsSync(testFile)) continue;
      for (const { fixture, fields } of parseTests(fs.readFileSync(testFile, "utf8"))) {
        const html = path.join(CORPUS, site, fixture);
        if (!fs.existsSync(html)) continue;
        const context = await browser.newContext({ javaScriptEnabled: false });
        await context.route(/^(?!file:)/, (route) => route.abort());
        const page = await context.newPage();
        await page.goto(`file://${html}`, { waitUntil: "load", timeout: 15_000 }).catch(() => {});
        const controls = await page.evaluate(pageControls);
        await context.close();
        const matched = align(fields, controls);
        const stem = `${site}_${fixture.replace(/\.html$/, "")}`;
        const out = path.join(LABELS, `${stem}.out`);
        if (fs.existsSync(out) && !process.argv.includes("--force")) continue;
        const lines = [`Firefox ${site}/${fixture}: drafted by firefox-labels.js, then checked by hand.`];
        console.log(`\n${stem} (${fields.length} fields, ${controls.length} controls)`);
        // Firefox lists a page's sections in its own order; run.js lines rows up
        // with controls in document order, so the rows go in that order.
        const rows = [];
        fields.forEach((field, index) => {
          const control = matched[index];
          if (!control) {
            console.log(`  ${field.fieldName.padEnd(16)} -> (not on the page)`);
            return;
          }
          const type = TYPES[field.fieldName] || field.fieldName.toUpperCase();
          const note = `firefox ${field.fieldName}${field.missed ? " (missed by Firefox)" : ""}`;
          const label = control.label.replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 60);
          const shared = control.name && controls.filter((other) => other.name === control.name).length > 1;
          const key = shared && control.id ? control.id : control.name || control.id;
          rows.push({ index: control.index, line: `${type} | ${key} | ${label} |  | ${note}` });
          console.log(`  ${field.fieldName.padEnd(16)} -> ${(control.name || control.id || `#${control.index}`).slice(0, 48).padEnd(48)} ${label.slice(0, 40).padEnd(40)} ${fit(field.fieldName, control) < 2 ? "check" : ""}`);
        });
        lines.push(...rows.sort((a, b) => a.index - b.index).map((row) => row.line));
        fs.writeFileSync(out, `${lines.join("\n")}\n`);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
