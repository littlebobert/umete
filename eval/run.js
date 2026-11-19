#!/usr/bin/env node
// Form eval: replays saved real-world forms in WebKit and scores what Umete's
// local matching fills.
//
// 1. The test person "remembers" persona/learn-full.html with the real
//    content scripts (UME_COLLECT), exactly as Remember my answers does.
// 2. Each corpus form is opened with network access blocked, the same content
//    scripts are injected, and UME_FILL runs with those saved answers.
// 3. Every field Chromium labeled is compared with what the person should get.
//
// Variants (--variant):
//   learned     every answer, address included, comes from remembering one form
//   structured  name, email, phone, company learned; the address is a
//               structured address answer, as entered in the app
//
// Usage: node run.js [--variant learned|structured|both] [--only 017] [--verbose]

const fs = require("node:fs");
const path = require("node:path");
const { webkit } = require("playwright");
const { expectations, matches } = require("./expect.js");
const { parseExpected, mapRows } = require("./corpus.js");

const ROOT = path.resolve(__dirname, "..");
const EXTENSION = path.join(ROOT, "Extension");
const CONTENT_SCRIPT_FILES = ["lib/matcher.js", "lib/dom.js", "lib/date.js", "lib/phone.js", "content.js"];
const CORPUS = path.join(__dirname, "corpus", "chromium");
// Umete's own forms with hand-written labels, for cases the corpus lacks.
const FIXTURES = path.join(__dirname, "fixtures");
const REPORTS = path.join(__dirname, "reports");
const PERSONA = JSON.parse(fs.readFileSync(path.join(__dirname, "persona", "persona.json"), "utf8"));
const RULES = expectations(PERSONA);
const PAGE_TIMEOUT_MS = 15_000;

function parseArgs(argv) {
  const args = { variant: "both", only: null, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--variant") args.variant = argv[++i];
    else if (argv[i] === "--only") args.only = argv[++i];
    else if (argv[i] === "--verbose") args.verbose = true;
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  if (!["learned", "structured", "both"].includes(args.variant)) throw new Error("--variant is learned, structured, or both");
  return args;
}

// Stands in for Safari's extension API: content.js only registers a message
// listener, which the runner then calls directly.
const SHIM = `
  globalThis.browser = {
    runtime: {
      onMessage: {
        addListener(listener) { globalThis.__umeEvalListener = listener; },
        removeListener() {}
      }
    }
  };
  globalThis.__umeEvalSend = (message) => new Promise((resolve) => {
    const returned = globalThis.__umeEvalListener(message, {}, resolve);
    if (returned !== true) setTimeout(() => resolve(undefined), 0);
  });
`;

// Pages load with their own scripts off: saved snapshots can't reach their
// sites, and with scripting on, fields inside <noscript> fallbacks vanish.
// Umete's scripts still run, through Playwright's evaluate.
const UMETE_SOURCES = [SHIM, ...CONTENT_SCRIPT_FILES.map((file) => fs.readFileSync(path.join(EXTENSION, file), "utf8"))];

async function injectUmete(page) {
  await page.evaluate((sources) => {
    for (const source of sources) new Function(source)();
  }, UMETE_SOURCES);
}

// Every form control in DOM order, open shadow roots included, with what a
// person would read from it.
function snapshotControls() {
  const controls = [];
  const walk = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if (element.matches("input, select, textarea")) controls.push(element);
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(document);
  return controls.map((element, index) => {
    const select = element instanceof HTMLSelectElement ? element : null;
    const option = select ? select.options[select.selectedIndex] : null;
    return {
      index,
      tag: element.tagName.toLowerCase(),
      type: (element.type || "").toLowerCase(),
      name: element.getAttribute("name") || "",
      id: element.id || "",
      maxLength: typeof element.maxLength === "number" ? element.maxLength : -1,
      value: element.type === "checkbox" || element.type === "radio" ? String(element.checked) : String(element.value ?? ""),
      optionText: option ? option.text.trim() : ""
    };
  });
}

async function remember(browser, variant) {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`file://${path.join(__dirname, "persona", "learn-full.html")}`);
  if (variant === "structured") await page.evaluate(() => document.querySelector("fieldset.address").remove());
  await injectUmete(page);
  const { answers } = await page.evaluate(() => globalThis.__umeEvalSend({ type: "UME_COLLECT" }));
  await context.close();
  if (variant === "structured") {
    const { houseNumber, streetName, administrativeAreaName, ...value } = PERSONA.address;
    answers.push({
      answerType: "address",
      accessibleName: "Home address",
      accessibleDescription: "", autocomplete: "", form: "", group: "", id: "", inputType: "",
      kind: "aggregate", label: "Home address", name: "", placeholder: "", section: "", tableHeaders: [],
      value
    });
  }
  return answers;
}

async function fillForm(browser, htmlPath, answers) {
  const context = await browser.newContext({ javaScriptEnabled: false });
  // Saved pages still point at their sites' scripts, images, and trackers.
  await context.route(/^(?!file:)/, (route) => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  try {
    await page.goto(`file://${htmlPath}`, { waitUntil: "load", timeout: PAGE_TIMEOUT_MS }).catch(() => {});
    await injectUmete(page);
    const before = await page.evaluate(snapshotControls);
    const result = await page.evaluate((saved) => globalThis.__umeEvalSend({ type: "UME_FILL", answers: saved }), answers);
    const after = await page.evaluate(snapshotControls);
    return { before, after, result };
  } finally {
    await context.close();
  }
}

function readings(control) {
  return [control.value, control.optionText].filter(Boolean);
}

function changed(before, after) {
  return before.value !== after.value || before.optionText !== after.optionText;
}

function scoreForm(stem, expectedRows, before, after) {
  const fields = [];
  const mapped = mapRows(expectedRows, before);
  const labeledIndexes = new Set();
  for (const { row, control } of mapped) {
    if (!control) {
      fields.push({ outcome: "unmapped", type: row.type, name: row.name, label: row.label });
      continue;
    }
    labeledIndexes.add(control.index);
    const now = after[control.index];
    const filled = Boolean(now) && changed(control, now);
    const rule = RULES[row.type];
    const isPassword = control.type === "password";
    const base = { type: row.type, name: row.name, label: row.label, got: now ? (now.optionText || now.value) : "" };
    let outcome;
    if (isPassword || rule?.sensitive) outcome = filled ? "sensitive-fill" : "correct-skip";
    else if (rule?.accept) outcome = !filled ? "missed" : matches(rule, readings(now), now.optionText, now.maxLength) ? "correct" : "wrong";
    else if (rule?.none) outcome = filled ? "wrong" : "correct-skip";
    else outcome = filled ? "review" : "correct-skip";
    if (outcome === "wrong" && rule?.accept) base.expected = rule.accept[0];
    fields.push({ outcome, ...base });
  }
  // Fills on controls Chromium didn't label at all (checkboxes, radios, fields
  // it ignores), so they're still seen.
  for (const control of before) {
    if (labeledIndexes.has(control.index)) continue;
    const now = after[control.index];
    if (!now || !changed(control, now)) continue;
    const outcome = control.type === "password" ? "sensitive-fill" : "review";
    fields.push({ outcome, type: "(not labeled)", name: control.name || control.id, label: "", got: now.optionText || now.value, unlabeled: true });
  }
  return { form: stem, fields };
}

const OUTCOMES = ["correct", "wrong", "sensitive-fill", "missed", "correct-skip", "review", "unmapped"];

function tally(forms) {
  const totals = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
  for (const form of forms) for (const field of form.fields) totals[field.outcome] += 1;
  const attempted = totals.correct + totals.wrong;
  const shouldFill = totals.correct + totals.wrong + totals.missed;
  return {
    ...totals,
    precision: attempted ? totals.correct / attempted : 1,
    recall: shouldFill ? totals.correct / shouldFill : 1
  };
}

const pct = (value) => `${(value * 100).toFixed(1)}%`;

function markdownReport(variant, forms, totals, answers, startedAt) {
  const lines = [
    `# Umete form eval: Chromium corpus, ${variant} answers`,
    "",
    `${startedAt.toISOString()} · ${forms.length} forms · ${answers.length} saved answers`,
    "",
    "| Correct | Wrong | Sensitive fills | Missed | Review | Precision | Recall |",
    "|---|---|---|---|---|---|---|",
    `| ${totals.correct} | ${totals.wrong} | ${totals["sensitive-fill"]} | ${totals.missed} | ${totals.review} | ${pct(totals.precision)} | ${pct(totals.recall)} |`,
    "",
    "Precision is correct ÷ (correct + wrong). Recall is correct ÷ fields the person had an answer for.",
    "Review counts fills on fields Chromium calls UNKNOWN_TYPE or doesn't label; they may be fine.",
    ""
  ];
  const section = (title, outcome) => {
    const rows = forms.flatMap((form) => form.fields.filter((field) => field.outcome === outcome).map((field) => ({ form: form.form, ...field })));
    if (!rows.length) return;
    lines.push(`## ${title} (${rows.length})`, "", "| Form | Field | Label | Chromium type | Got | Expected |", "|---|---|---|---|---|---|");
    for (const row of rows) {
      const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 60);
      lines.push(`| ${cell(row.form)} | ${cell(row.name)} | ${cell(row.label)} | ${cell(row.type)} | ${cell(row.got)} | ${cell(row.expected)} |`);
    }
    lines.push("");
  };
  section("Sensitive fills", "sensitive-fill");
  section("Wrong fills", "wrong");
  section("For review", "review");
  section("Missed", "missed");
  const errors = forms.filter((form) => form.error);
  if (errors.length) {
    lines.push(`## Forms that failed to run (${errors.length})`, "");
    for (const form of errors) lines.push(`- ${form.form}: ${form.error}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function runVariant(browser, variant, args) {
  const answers = await remember(browser, variant);
  const entries = [CORPUS, FIXTURES].flatMap((directory) => fs.readdirSync(directory)
    .filter((file) => file.endsWith(".out"))
    .map((file) => ({ directory, file: file.slice(0, -4), stem: directory === FIXTURES ? `fixtures/${file.slice(0, -4)}` : file.slice(0, -4) }))
    .filter(({ stem }) => !args.only || stem.includes(args.only))
    .sort((left, right) => left.stem.localeCompare(right.stem)));
  const forms = [];
  for (const { directory, file, stem } of entries) {
    const html = ["html", "htm", "xhtml"].map((ext) => path.join(directory, `${file}.${ext}`)).find((candidate) => fs.existsSync(candidate));
    if (!html) continue;
    const expectedRows = parseExpected(fs.readFileSync(path.join(directory, `${file}.out`), "utf8"));
    try {
      const { before, after, result } = await fillForm(browser, html, answers);
      const scored = scoreForm(stem, expectedRows, before, after);
      scored.umeteFilled = result?.filled ?? null;
      forms.push(scored);
      if (args.verbose) {
        const counts = tally([scored]);
        console.log(`${stem}: ${counts.correct} correct, ${counts.wrong} wrong, ${counts.missed} missed, ${counts["sensitive-fill"]} sensitive`);
      }
    } catch (error) {
      forms.push({ form: stem, fields: [], error: error.message.split("\n")[0] });
      if (args.verbose) console.log(`${stem}: ERROR ${error.message.split("\n")[0]}`);
    }
  }
  return { answers, forms, totals: tally(forms) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(CORPUS)) throw new Error("No corpus yet. Run ./fetch-chromium.sh first.");
  fs.mkdirSync(REPORTS, { recursive: true });
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const variants = args.variant === "both" ? ["learned", "structured"] : [args.variant];
  const browser = await webkit.launch();
  let failed = false;
  try {
    for (const variant of variants) {
      const { answers, forms, totals } = await runVariant(browser, variant, args);
      const base = path.join(REPORTS, `${stamp}-${variant}`);
      fs.writeFileSync(`${base}.json`, JSON.stringify({ variant, startedAt, answers, totals, forms }, null, 2));
      fs.writeFileSync(`${base}.md`, markdownReport(variant, forms, totals, answers, startedAt));
      console.log(`${variant}: ${totals.correct} correct, ${totals.wrong} wrong, ${totals["sensitive-fill"]} sensitive fills, ${totals.missed} missed, ${totals.review} for review · precision ${pct(totals.precision)}, recall ${pct(totals.recall)}`);
      console.log(`  ${path.relative(process.cwd(), base)}.md`);
      if (totals["sensitive-fill"] > 0) failed = true;
    }
  } finally {
    await browser.close();
  }
  // A sensitive fill breaks a promise Umete makes, so it fails the run.
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
