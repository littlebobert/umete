#!/usr/bin/env node
// Form eval: replays saved real-world forms in WebKit and scores what Umete's
// local matching fills.
//
// 1. The test person "remembers" persona/learn-full.html with the real
//    content scripts (UME_COLLECT) and rememberAnswers, exactly as Remember
//    my answers does: the form's address becomes one structured answer.
// 2. Each corpus form is opened with network access blocked, the same content
//    scripts are injected, and UME_FILL runs with those saved answers.
// 3. Every labeled field is compared with what the person should get.
//
// Corpora (--corpus): Chromium's autofill corpus (fetch-chromium.sh), Firefox's
// form autofill test pages (fetch-firefox.sh, with hand-checked labels in
// labels/firefox), and Umete's own fixtures, which always run.
//
// Variants (--variant):
//   learned     every answer, address included, comes from remembering one form
//               (the address as Remember folds it from the form's fields)
//   structured  name, email, phone, company learned; the address is a
//               structured address answer, as entered in the app
//
// AI matching (--ai), the step Fill runs after local matching for fields it
// left unhandled (UME_SCHEMAS):
//   off      local matching only (default)
//   dry      no requests; reports which missed fields the AI would be asked about
//   openai   the OpenAI Decisions API with OPENAI_API_KEY, as "OpenAI Decisions
//            (your key)" does; --model overrides the app's default
//
// Usage: node run.js [--corpus chromium|firefox|all] [--variant learned|structured|both] [--ai off|dry|openai] [--only 017] [--verbose]

const fs = require("node:fs");
const path = require("node:path");
const { webkit } = require("playwright");
const { expectations, matches } = require("./expect.js");
const { parseExpected, mapRows } = require("./corpus.js");
const ai = require("./ai.js");
const { injectUmete } = require("./inject.js");
const { rememberAnswers } = require("../Extension/lib/matcher.js");

// Each corpus's pages and the .out files that label them, in Chromium's format.
const CORPORA = {
  chromium: {
    pages: path.join(__dirname, "corpus", "chromium"),
    labels: path.join(__dirname, "corpus", "chromium"),
    page: (labels, stem) => path.join(labels, stem)
  },
  // Pages are corpus/firefox/<Site>/<Page>.html; labels are <Site>_<Page>.out.
  firefox: {
    pages: path.join(__dirname, "corpus", "firefox"),
    labels: path.join(__dirname, "labels", "firefox"),
    page: (_, stem) => {
      const [site, ...rest] = stem.split("_");
      return path.join(__dirname, "corpus", "firefox", site, rest.join("_"));
    }
  },
  // Umete's own forms with hand-written labels, for cases the corpora lack.
  fixtures: {
    pages: path.join(__dirname, "fixtures"),
    labels: path.join(__dirname, "fixtures"),
    page: (labels, stem) => path.join(labels, stem)
  }
};
const REPORTS = path.join(__dirname, "reports");
const PERSONA = JSON.parse(fs.readFileSync(path.join(__dirname, "persona", "persona.json"), "utf8"));
const RULES = expectations(PERSONA);
const PAGE_TIMEOUT_MS = 15_000;

function parseArgs(argv) {
  const args = { corpus: "all", variant: "both", only: null, verbose: false, ai: "off", model: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--corpus") args.corpus = argv[++i];
    else if (argv[i] === "--variant") args.variant = argv[++i];
    else if (argv[i] === "--only") args.only = argv[++i];
    else if (argv[i] === "--verbose") args.verbose = true;
    else if (argv[i] === "--ai") args.ai = argv[++i];
    else if (argv[i] === "--model") args.model = argv[++i];
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  if (!["chromium", "firefox", "all"].includes(args.corpus)) throw new Error("--corpus is chromium, firefox, or all");
  if (!["learned", "structured", "both"].includes(args.variant)) throw new Error("--variant is learned, structured, or both");
  if (!["off", "dry", "openai"].includes(args.ai)) throw new Error("--ai is off, dry, or openai");
  if (args.ai === "openai" && !process.env.OPENAI_API_KEY) throw new Error("--ai openai needs OPENAI_API_KEY in the environment.");
  return args;
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
      visible: element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible",
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
  const { answers: collected } = await page.evaluate(() => globalThis.__umeEvalSend({ type: "UME_COLLECT" }));
  await context.close();
  // As the popup does: the form's address becomes one structured answer.
  const { answers } = rememberAnswers([], collected);
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

// Lines up UME_SCHEMAS fields (indexes into the content script's own list)
// with snapshot controls by name and id, in order.
function schemaControls(schemas, controls) {
  const used = new Set();
  const byField = new Map();
  for (const schema of schemas) {
    const control = controls.find((candidate) => !used.has(candidate.index)
      && candidate.name === (schema.name || "") && candidate.id === (schema.id || ""));
    if (!control) continue;
    used.add(control.index);
    byField.set(schema.field, control.index);
  }
  return byField;
}

async function askAI(answers, schemas, args) {
  const { requests, values } = ai.buildRequests(answers, schemas);
  const mappings = [];
  const decisions = [];
  for (const body of requests) {
    const result = await ai.ask("openai", body, { apiKey: process.env.OPENAI_API_KEY, model: args.model });
    mappings.push(...result.mappings);
    decisions.push(...result.decisions);
  }
  return { mappings, decisions, values, requests: requests.length };
}

async function fillForm(browser, htmlPath, answers, args) {
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
    const local = await page.evaluate(snapshotControls);
    if (args.ai === "off") return { before, after: local, local, result };
    const { fields: schemas = [] } = await page.evaluate((saved) => globalThis.__umeEvalSend({ type: "UME_SCHEMAS", answers: saved }), answers) || {};
    const asked = schemaControls(schemas, before);
    const aiInfo = { asked: [...asked.values()], requests: 0, characters: 0, decisions: {} };
    if (args.ai === "dry" && schemas.length) {
      const { requests } = ai.buildRequests(answers, schemas);
      aiInfo.requests = requests.length;
      aiInfo.characters = requests.reduce((sum, body) => sum + JSON.stringify(body).length, 0);
    }
    if (args.ai === "openai" && schemas.length) {
      const { mappings, decisions, values, requests } = await askAI(answers, schemas, args);
      aiInfo.requests = requests;
      for (const decision of decisions) {
        const index = asked.get(decision.field);
        if (index !== undefined) aiInfo.decisions[index] = decision;
      }
      if (mappings.length) {
        await page.evaluate(({ mappings: chosen, values: saved }) => globalThis.__umeEvalSend({ type: "UME_APPLY_MAPPINGS", mappings: chosen, values: saved }), { mappings, values });
      }
    }
    const after = await page.evaluate(snapshotControls);
    return { before, after, local, result, aiInfo };
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

function scoreForm(stem, expectedRows, before, after, local = after, aiInfo = null) {
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
    const outcomeOf = (state) => {
      const filled = Boolean(state) && changed(control, state);
      if (isPassword || rule?.sensitive) return filled ? "sensitive-fill" : "correct-skip";
      if (rule?.accept) return !filled ? "missed" : matches(rule, readings(state), state.optionText, state.maxLength) ? "correct" : "wrong";
      if (rule?.none) return filled ? "wrong" : "correct-skip";
      return filled ? "review" : "correct-skip";
    };
    // A field that already held the right value isn't a miss, and Umete
    // leaves out fields a person can't see; so does the score.
    const scoredOutcome = (state) => {
      const untouched = !changed(control, state || control);
      if (untouched && rule?.accept && control.value !== "" && matches(rule, readings(control), control.optionText, control.maxLength)) return "already-set";
      if (untouched && !control.visible && !(isPassword || rule?.sensitive)) return "hidden";
      return outcomeOf(state);
    };
    const outcome = scoredOutcome(now);
    if (outcome === "wrong" && rule?.accept) base.expected = rule.accept[0];
    if (aiInfo) {
      base.localOutcome = scoredOutcome(local[control.index]);
      base.askedAI = aiInfo.asked.includes(control.index);
      if (aiInfo.decisions[control.index]) base.aiDecision = aiInfo.decisions[control.index];
    }
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

const OUTCOMES = ["correct", "wrong", "sensitive-fill", "missed", "correct-skip", "review", "unmapped", "hidden", "already-set"];

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

// What the AI step changed: fields local matching missed that the AI was
// asked about, and what came of them.
function aiSummary(forms) {
  const fields = forms.flatMap((form) => form.fields).filter((field) => field.localOutcome !== undefined);
  const missedLocally = fields.filter((field) => field.localOutcome === "missed");
  const asked = missedLocally.filter((field) => field.askedAI);
  const changedBy = (from, to) => fields.filter((field) => field.localOutcome === from && field.outcome === to).length;
  const requests = forms.reduce((sum, form) => sum + (form.aiRequests || 0), 0);
  const characters = forms.reduce((sum, form) => sum + (form.aiCharacters || 0), 0);
  return `AI: ${asked.length} of ${missedLocally.length} local misses asked about · ${changedBy("missed", "correct")} now correct, ${changedBy("missed", "wrong")} now wrong · ${changedBy("correct-skip", "wrong")} wrong and ${changedBy("correct-skip", "review")} for review where nothing belonged · ${requests} requests${characters ? ` (~${Math.round(characters / 4 / 1000)}k input tokens)` : ""}`;
}

// The totals for each corpus, as extra rows under the overall ones.
function corpusRows(forms) {
  const names = [...new Set(forms.map((form) => form.corpus))];
  if (names.length < 2) return [];
  return ["", "| Corpus | Forms | Correct | Wrong | Sensitive fills | Missed | Review | Precision | Recall |", "|---|---|---|---|---|---|---|---|---|",
    ...names.map((name) => {
      const subset = forms.filter((form) => form.corpus === name);
      const t = tally(subset);
      return `| ${name} | ${subset.length} | ${t.correct} | ${t.wrong} | ${t["sensitive-fill"]} | ${t.missed} | ${t.review} | ${pct(t.precision)} | ${pct(t.recall)} |`;
    })];
}

function markdownReport(variant, forms, totals, answers, startedAt) {
  const lines = [
    `# Umete form eval: ${[...new Set(forms.map((form) => form.corpus))].join(", ")}, ${variant} answers`,
    "",
    `${startedAt.toISOString()} · ${forms.length} forms · ${answers.length} saved answers`,
    "",
    "| Correct | Wrong | Sensitive fills | Missed | Review | Precision | Recall |",
    "|---|---|---|---|---|---|---|",
    `| ${totals.correct} | ${totals.wrong} | ${totals["sensitive-fill"]} | ${totals.missed} | ${totals.review} | ${pct(totals.precision)} | ${pct(totals.recall)} |`,
    "",
    ...corpusRows(forms),
    "",
    "Precision is correct ÷ (correct + wrong). Recall is correct ÷ fields the person had an answer for.",
    "Review counts fills on fields labeled UNKNOWN_TYPE or not labeled; they may be fine.",
    ""
  ];
  const section = (title, outcome) => {
    const rows = forms.flatMap((form) => form.fields.filter((field) => field.outcome === outcome).map((field) => ({ form: form.form, ...field })));
    if (!rows.length) return;
    lines.push(`## ${title} (${rows.length})`, "", "| Form | Field | Label | Type | Got | Expected |", "|---|---|---|---|---|---|");
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
  const names = args.corpus === "all" ? Object.keys(CORPORA) : [args.corpus, "fixtures"];
  const entries = names.filter((name) => fs.existsSync(CORPORA[name].pages) && fs.existsSync(CORPORA[name].labels)).flatMap((name) => {
    const corpus = CORPORA[name];
    return fs.readdirSync(corpus.labels)
      .filter((file) => file.endsWith(".out"))
      .map((file) => ({ name, corpus, file: file.slice(0, -4), stem: name === "chromium" ? file.slice(0, -4) : `${name}/${file.slice(0, -4)}` }))
      .filter(({ stem }) => !args.only || stem.includes(args.only))
      .sort((left, right) => left.stem.localeCompare(right.stem));
  });
  const forms = [];
  for (const { name, corpus, file, stem } of entries) {
    const base = corpus.page(corpus.labels, file);
    const html = ["html", "htm", "xhtml"].map((ext) => `${base}.${ext}`).find((candidate) => fs.existsSync(candidate));
    if (!html) continue;
    const expectedRows = parseExpected(fs.readFileSync(path.join(corpus.labels, `${file}.out`), "utf8"));
    try {
      const { before, after, local, result, aiInfo } = await fillForm(browser, html, answers, args);
      const scored = scoreForm(stem, expectedRows, before, after, local, aiInfo);
      scored.corpus = name;
      if (aiInfo) {
        scored.aiRequests = aiInfo.requests;
        scored.aiCharacters = aiInfo.characters;
      }
      scored.umeteFilled = result?.filled ?? null;
      forms.push(scored);
      if (args.verbose) {
        const counts = tally([scored]);
        console.log(`${stem}: ${counts.correct} correct, ${counts.wrong} wrong, ${counts.missed} missed, ${counts["sensitive-fill"]} sensitive`);
      }
    } catch (error) {
      forms.push({ form: stem, corpus: name, fields: [], error: error.message.split("\n")[0] });
      if (args.verbose) console.log(`${stem}: ERROR ${error.message.split("\n")[0]}`);
    }
  }
  return { answers, forms, totals: tally(forms) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const missing = ["chromium", "firefox"].filter((name) => (args.corpus === "all" || args.corpus === name) && !fs.existsSync(CORPORA[name].pages));
  for (const name of missing) console.warn(`No ${name} pages yet; run ./fetch-${name}.sh to include them.`);
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
      for (const line of corpusRows(forms).slice(3)) console.log(`  ${line}`);
      console.log(`${variant}: ${totals.correct} correct, ${totals.wrong} wrong, ${totals["sensitive-fill"]} sensitive fills, ${totals.missed} missed, ${totals.review} for review · precision ${pct(totals.precision)}, recall ${pct(totals.recall)}`);
      if (args.ai !== "off") console.log(`  ${aiSummary(forms)}`);
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
