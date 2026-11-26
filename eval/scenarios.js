// Pages that need their own scripts running, filled with answers typed in
// Settings (a phone with its country code, a date of birth, a gender), and
// checked field by field. Unlike run.js, which scores the Chromium corpus with
// page scripts off, these pages imitate one site's widgets closely.
//
// Usage: node scenarios.js [--only delta|american]

const path = require("node:path");
const { webkit } = require("playwright");
const { injectUmete } = require("./inject.js");

// Typed answers as Stores.add saves them; the values are fictional.
function typed(label, value, answerType) {
  return {
    answerID: label, userLabel: label, accessibleName: label, label,
    kind: "text", inputType: "text", value,
    ...(answerType ? { answerType } : {})
  };
}

const PERSON = [
  typed("First name", "Kenji"),
  typed("Last name", "Mori"),
  typed("Phone number", "+81 9012345678", "phone"),
  typed("Date of birth", "1984-07-09", "date"),
  typed("Gender", "Female", "gender"),
  typed("Email address", "kenji.mori@example.com")
];

// A dropdown button shows its choice in its own text; inputs hold a value.
// A component's own control sits in its shadow root (American's <adc-select>).
function shown(selector) {
  let element = document.querySelector(selector);
  if (!element) return null;
  element = element.shadowRoot?.querySelector("select, input, button") || element;
  if (element.matches("button")) return element.querySelector(".dropdown__placeholder--text")?.textContent.trim() ?? element.textContent.trim();
  return element.value;
}

const SCENARIOS = [
  {
    name: "delta",
    page: "scenarios/delta-passenger.html",
    answers: PERSON,
    expect: {
      "#firstName_0_0": "Kenji",
      "#middleName_0_0": "",
      "#lastName_0_0": "Mori",
      "#suffix_0": "--",
      "#frequentFlyerProgram_0": "Delta Air Lines/SkyMiles",
      "#dobmonth_0": "Jul",
      "#dobday_0": "9",
      "#dobyear_0": "1984",
      "#gender_0": "Female (F)",
      "#contact_info_country": "Japan (81)",
      "#phone-number_0": "9012345678",
      "#email_0": "kenji.mori@example.com"
    },
    // Remember my answers afterwards keeps the phone's country code.
    rememberedPhoneCode: "81"
  },
  {
    // The date of birth fills its dropdowns, and never the passport's
    // expiration date, though both are named only "month", "day", and "year".
    name: "american",
    page: "scenarios/aa-passport.html",
    answers: PERSON,
    expect: {
      "#firstName": "Kenji",
      "#lastName": "Mori",
      "#dob-month": "07",
      "#dob-day": "09",
      "#dob-year": "1984",
      "#passportNumber": "",
      "#exp-month": "",
      "#exp-day": "",
      "#exp-year": "",
      "#nationality": ""
    }
  }
];

async function run(browser, scenario) {
  const context = await browser.newContext();
  await context.route(/^(?!file:)/, (route) => route.abort());
  const page = await context.newPage();
  await page.goto(`file://${path.join(__dirname, scenario.page)}`);
  await injectUmete(page);
  const result = await page.evaluate((answers) => globalThis.__umeEvalSend({ type: "UME_FILL", answers }), scenario.answers);
  const failures = [];
  for (const [selector, wanted] of Object.entries(scenario.expect)) {
    const actual = await page.evaluate(shown, selector);
    if (actual !== wanted) failures.push({ selector, wanted, actual });
  }
  if (scenario.rememberedPhoneCode) {
    const { answers = [] } = await page.evaluate(() => globalThis.__umeEvalSend({ type: "UME_COLLECT" })) || {};
    const phone = answers.find((answer) => answer.answerType === "phone");
    if (phone?.countryCode !== scenario.rememberedPhoneCode) {
      failures.push({ selector: "remembered phone country code", wanted: scenario.rememberedPhoneCode, actual: phone?.countryCode ?? null });
    }
  }
  await context.close();
  return { result, failures };
}

async function main() {
  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;
  const browser = await webkit.launch();
  let failed = 0;
  try {
    for (const scenario of SCENARIOS.filter((candidate) => !only || candidate.name === only)) {
      const { result, failures } = await run(browser, scenario);
      const checks = Object.keys(scenario.expect).length + (scenario.rememberedPhoneCode ? 1 : 0);
      console.log(`${failures.length ? "FAIL" : "ok  "} ${scenario.name}: ${checks - failures.length}/${checks} fields right (filled ${result?.filled}, eligible ${result?.eligibleFieldCount})`);
      for (const failure of failures) console.log(`     ${failure.selector}: wanted ${JSON.stringify(failure.wanted)}, got ${JSON.stringify(failure.actual)}`);
      failed += failures.length ? 1 : 0;
    }
  } finally {
    await browser.close();
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
