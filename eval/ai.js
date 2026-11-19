// The AI step of Fill, ported from the app so the eval can run it:
// popup.js (aiSavedEntries, schemaForAI) and SafariWebExtensionHandler.swift
// (sanitizing, then requestDecisions and its helpers for the OpenAI Decisions
// API). Keep this in step with those files; the constants are copied as-is.

const crypto = require("node:crypto");

const AI_SCHEMA_KEYS = [
  "accessibleDescription", "accessibleName", "answerType", "autocomplete", "form", "group",
  "groupName", "id", "inputType", "kind", "label", "name", "options", "placeholder",
  "required", "section", "tableHeaders", "userLabel"
];
const DECISIONS_URL = "https://api.openai.com/v1/decisions";
const UMETE_URL = "https://api.umete.jp/v1/decisions";
const DEFAULT_MODEL = "gpt-6-luna";
const QUESTIONS_PER_REQUEST = 10;
const MAXIMUM_CHOICES = 30;
const MAXIMUM_INPUT_CHARACTERS = 7_800;
const MAXIMUM_DESCRIPTION_CHARACTERS = 280;
const MINIMUM_PROBABILITY = 0.6;
const NONE = "none";

function schemaForAI(source, identityKey, identityValue) {
  const result = { [identityKey]: identityValue };
  for (const key of AI_SCHEMA_KEYS) if (source?.[key] !== undefined) result[key] = source[key];
  return result;
}

// popup.js aiSavedEntries, without contacts: the test person has none.
function aiSavedEntries(answers) {
  return answers.flatMap((answer, index) => answer.answerType === "address" ? [] : [{ key: `saved-${index}`, ...answer }]);
}

function describe(schema, includeOptions) {
  const parts = [];
  const name = [schema.userLabel, schema.accessibleName, schema.label].find((value) => typeof value === "string" && value);
  if (name) parts.push(`labeled "${name}"`);
  if (schema.answerType) parts.push(`type ${schema.answerType}`);
  if (schema.inputType && schema.inputType !== "text") parts.push(`input ${schema.inputType}`);
  if (schema.kind && schema.kind !== "text") parts.push(schema.kind);
  if (schema.autocomplete) parts.push(`autocomplete ${schema.autocomplete}`);
  if (schema.placeholder) parts.push(`placeholder "${schema.placeholder}"`);
  if (schema.accessibleDescription) parts.push(`hint "${schema.accessibleDescription}"`);
  const context = [schema.group, schema.section, schema.form].filter((value) => typeof value === "string" && value);
  if (context.length) parts.push(`in ${context.map((value) => `"${value}"`).join(" / ")}`);
  if (Array.isArray(schema.tableHeaders) && schema.tableHeaders.length) parts.push(`columns ${schema.tableHeaders.join(", ")}`);
  if (includeOptions && Array.isArray(schema.options) && schema.options.length) parts.push(`options: ${schema.options.slice(0, 12).join(" | ")}`);
  if (schema.name) parts.push(`name=${schema.name}`);
  return parts.length ? parts.join(", ") : "unlabeled field";
}

function decisionInput(fields) {
  const lines = fields.map((field) => `- ${field.field}: ${describe(field, true).slice(0, MAXIMUM_DESCRIPTION_CHARACTERS * 2)}`);
  const text = "A web form has these unfilled fields. Each saved answer is described by what it was originally entered for, not its value.\n" + lines.join("\n");
  return text.slice(0, MAXIMUM_INPUT_CHARACTERS);
}

function decisionInstructions(field) {
  return `Which saved answer should fill form field ${field.field} (${describe(field, false)})? Choose a saved answer only when its meaning clearly matches this field. If nothing fits, or two could fit equally, choose none.`;
}

function tokens(schema) {
  const text = ["userLabel", "accessibleName", "label", "name", "placeholder", "autocomplete", "group", "section"]
    .map((key) => schema[key]).filter((value) => typeof value === "string").join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return new Set(text.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1));
}

function decisionChoices(field, candidates) {
  const fieldKind = field.kind || "text";
  const fieldInputType = field.inputType || "";
  const fieldTokens = tokens(field);
  const ranked = candidates
    .filter((candidate) => ((candidate.kind || "text") === "checkbox") === (fieldKind === "checkbox"))
    .map((candidate) => {
      let score = 0;
      if ((candidate.inputType || "") === fieldInputType) score += 3;
      if ((candidate.kind || "text") === fieldKind) score += 1;
      for (const token of tokens(candidate)) if (fieldTokens.has(token)) score += 2;
      return { score, candidate };
    });
  // Swift's sort isn't stable; ties keep their order here.
  const kept = ranked.length > MAXIMUM_CHOICES
    ? ranked.slice().sort((left, right) => right.score - left.score).slice(0, MAXIMUM_CHOICES)
    : ranked;
  return kept.map(({ candidate }) => ({
    value: candidate.key,
    description: `Saved answer ${describe(candidate, false)}`.slice(0, MAXIMUM_DESCRIPTION_CHARACTERS)
  }));
}

// Builds the requests Fill would send for these unmatched fields.
function buildRequests(answers, fields) {
  const saved = aiSavedEntries(answers).map((answer) => schemaForAI(answer, "key", answer.key));
  const sanitized = fields.map((field) => schemaForAI(field, "field", field.field));
  const requests = [];
  for (let start = 0; start < sanitized.length; start += QUESTIONS_PER_REQUEST) {
    const chunk = sanitized.slice(start, start + QUESTIONS_PER_REQUEST);
    const questions = chunk.flatMap((field) => {
      const choices = decisionChoices(field, saved);
      if (!choices.length) return [];
      return [{
        type: "choice",
        name: field.field,
        instructions: decisionInstructions(field).slice(0, 600),
        choices: [{ value: NONE, description: "No saved answer belongs in this field, or it is ambiguous which one does." }, ...choices]
      }];
    });
    if (questions.length) requests.push({ input: decisionInput(chunk), questions });
  }
  return { requests, values: aiSavedEntries(answers) };
}

// A stable, random-looking device ID per eval install, as the app sends one.
function evalDeviceID() {
  return crypto.createHash("sha256").update(`umete-eval-${__dirname}`).digest("hex").slice(0, 32);
}

async function ask(provider, body, { apiKey, model }) {
  const free = provider === "umete";
  const url = free ? UMETE_URL : DECISIONS_URL;
  const headers = { "Content-Type": "application/json" };
  if (free) headers["X-Umete-Client"] = "umete-eval/1";
  else headers.Authorization = `Bearer ${apiKey}`;
  const payload = free ? { ...body, device: evalDeviceID() } : { ...body, model: model || DEFAULT_MODEL };
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) });
  const json = await response.json().catch(() => ({}));
  if (json?.error?.message) throw new Error(json.error.message);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!Array.isArray(json.answers)) throw new Error("No decisions returned.");
  const mappings = [];
  const decisions = [];
  for (const answer of json.answers) {
    if (answer?.type !== "choice" || typeof answer.choice !== "string") continue;
    const probabilities = Object.fromEntries((answer.probabilities || []).map((entry) => [entry.value, entry.probability]));
    const probability = probabilities[answer.choice] ?? 0;
    const accepted = answer.choice !== NONE && probability >= MINIMUM_PROBABILITY;
    decisions.push({ field: answer.name, choice: answer.choice, probability, accepted });
    if (accepted) mappings.push({ field: answer.name, key: answer.choice });
  }
  return { mappings, decisions };
}

module.exports = { buildRequests, ask, MINIMUM_PROBABILITY };
