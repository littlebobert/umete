const test = require("node:test");
const assert = require("node:assert/strict");
const { addressFieldPart, addressValue, answerType, bestMatch, compatible, contactFieldInfo, contactParts, contactValue, looksGenerated, mergeEntries, nameFieldPart, normalize, passportCountry, passportFieldPart, passportValue, rememberAnswers, score, selectOptionIndex } = require("../Extension/lib/matcher.js");

const entry = (overrides = {}) => ({
  accessibleDescription: "",
  accessibleName: "",
  autocomplete: "",
  form: "",
  group: "",
  id: "",
  inputType: "text",
  kind: "text",
  label: "",
  name: "",
  placeholder: "",
  section: "",
  tableHeaders: [],
  value: "saved",
  ...overrides
});

test("normalizes punctuation, camel case, and diacritics", () => {
  assert.equal(normalize("EmergencyContact E-mail Áddress"), "emergency contact e mail address");
});

test("select options match country names independently of case and ISO-valued options", () => {
  const options = [
    { text: "Select a country", value: "" },
    { text: "UNITED STATES ", value: "US" },
    { text: "JAPAN ", value: "JP" }
  ];
  assert.equal(selectOptionIndex(options, "United States"), 1);
  assert.equal(selectOptionIndex(options, "US"), 1);
  assert.equal(selectOptionIndex(options, "Japan"), 2);
  assert.equal(selectOptionIndex(options, "Not a country"), -1);
});

test("autocomplete creates a strong match", () => {
  assert.ok(score(entry({ autocomplete: "email" }), entry({ autocomplete: "email" })) >= 100);
});

test("similar labels match across differently named forms", () => {
  const saved = entry({ label: "Emergency contact phone number", name: "contact_phone" });
  const field = entry({ label: "Emergency contact phone", name: "emergencyPhone" });
  assert.equal(bestMatch([saved], field), saved);
});

test("different field kinds never match", () => {
  const saved = entry({ label: "Shirt size", kind: "select" });
  const field = entry({ label: "Shirt size", kind: "text" });
  assert.equal(bestMatch([saved], field), null);
});

test("the same part of an address fills a menu or a text box alike", () => {
  const state = entry({ label: "State", accessibleName: "State", name: "state", kind: "select", inputType: "select-one", value: "California" });
  assert.equal(bestMatch([state], entry({ label: "State:", accessibleName: "State:", name: "province", kind: "text" })), state);
  const typed = entry({ label: "State", accessibleName: "State", name: "state", kind: "text", value: "California" });
  assert.equal(bestMatch([typed], entry({ label: "State/Province", accessibleName: "State/Province", name: "stateProvince", kind: "select", inputType: "select-one" })), typed);
  // Not into a checkbox, and not into a different part.
  assert.equal(bestMatch([state], entry({ label: "City", accessibleName: "City", name: "city", kind: "text" })), null);
});

test("incompatible input types never match for ordinary answers", () => {
  const saved = entry({ accessibleName: "Quantity", inputType: "date" });
  const field = entry({ accessibleName: "Quantity", inputType: "number" });
  assert.equal(bestMatch([saved], field), null);
});

test("phone answers are incompatible with travel identifier fields", () => {
  const phone = entry({ accessibleName: "Phone number", name: "traveler.phone.mobileNumber", value: "090-1234-5678" });
  for (const label of ["Frequent flyer number", "Redress Number", "Known Traveler Number or PASS ID"]) {
    const field = entry({ accessibleName: label, name: label.replaceAll(" ", ".") });
    assert.equal(compatible(phone, field), false);
    assert.equal(bestMatch([phone], field), null);
  }
});

test("untyped phone answers match phone fields via context", () => {
  const phone = entry({ accessibleName: "Phone number", name: "traveler.phone.mobileNumber", value: "090-1234-5678" });
  const field = entry({ accessibleName: "Contact phone" });
  assert.equal(compatible(phone, field), true);
});

test("semantically equivalent phone fields remain compatible", () => {
  const phone = entry({ accessibleName: "Phone number", value: "090-1234-5678" });
  assert.equal(compatible(phone, entry({ accessibleName: "Mobile telephone" })), true);
});

test("ambiguous equal matches are rejected", () => {
  const first = entry({ label: "Phone number", value: "one" });
  const second = entry({ label: "Phone number", value: "two" });
  assert.equal(bestMatch([first, second], entry({ label: "Phone number" })), null);
});

test("group context distinguishes repeated labels", () => {
  const patient = entry({ accessibleName: "First name", group: "Patient", value: "Justin" });
  const emergency = entry({ accessibleName: "First name", group: "Emergency contact", value: "Jane" });
  const field = entry({ accessibleName: "First name", section: "Emergency contact" });
  assert.equal(bestMatch([patient, emergency], field), emergency);
});

test("conflicting context penalizes otherwise identical fields", () => {
  const saved = entry({ accessibleName: "Phone", group: "Patient" });
  const sameContext = entry({ accessibleName: "Phone", section: "Patient information" });
  const conflictingContext = entry({ accessibleName: "Phone", section: "Emergency contact" });
  assert.ok(score(saved, sameContext) > score(saved, conflictingContext));
});

test("generated identifiers are detected and weakly weighted", () => {
  assert.equal(looksGenerated("input_839102"), true);
  assert.equal(looksGenerated("emergencyContactPhone"), false);
  const generatedOnly = score(entry({ id: "input_839102" }), entry({ id: "input_839102" }));
  const semantic = score(entry({ id: "emergencyContactPhone" }), entry({ id: "emergencyContactPhone" }));
  assert.ok(semantic > generatedOnly);
});

test("user labels participate in semantic matching", () => {
  const saved = entry({ userLabel: "Mother's mobile phone", label: "Contact" });
  const field = entry({ accessibleName: "Mother mobile phone" });
  assert.equal(bestMatch([saved], field), saved);
});

test("merge updates a strongly matching saved answer and preserves its identity", () => {
  const previous = entry({ answerID: "answer-1", userLabel: "My email", autocomplete: "email", label: "Email", value: "old@example.com" });
  const next = entry({ autocomplete: "email", label: "Email address", value: "new@example.com" });
  const merged = mergeEntries([previous], [next]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].value, "new@example.com");
  assert.equal(merged[0].answerID, "answer-1");
  assert.equal(merged[0].userLabel, "My email");
});

test("merge assigns stable identities to new answers", () => {
  const merged = mergeEntries([], [entry({ label: "Email" })]);
  assert.equal(typeof merged[0].answerID, "string");
  assert.ok(merged[0].answerID.length > 10);
});

test("answerType falls back to semantic detection and validates explicit values", () => {
  assert.equal(answerType(entry({ accessibleName: "Date of birth" })), "date");
  assert.equal(answerType(entry({ accessibleName: "Mobile phone" })), "phone");
  assert.equal(answerType(entry({ accessibleName: "Calling code" })), "phone");
  assert.equal(answerType(entry({ accessibleName: "First name" })), "");
  assert.equal(answerType(entry({ accessibleName: "Contact", answerType: "gender" })), "gender");
  assert.equal(answerType(entry({ accessibleName: "Home", answerType: "address", kind: "aggregate" })), "address");
  assert.equal(answerType(entry({ accessibleName: "Contact", answerType: "bogus" })), "");
});

test("typed phone answers match phone and calling code fields but not identifiers", () => {
  const phone = entry({ answerType: "phone", accessibleName: "Contact", value: "15551234567", countryCode: "1" });
  assert.equal(compatible(phone, entry({ accessibleName: "Phone number" })), true);
  assert.equal(compatible(phone, entry({ accessibleName: "Country code" })), true);
  assert.equal(compatible(phone, entry({ accessibleName: "Calling code" })), true);
  assert.equal(compatible(phone, entry({ accessibleName: "Country code", kind: "select" })), true);
  assert.equal(compatible(phone, entry({ accessibleName: "Redress number" })), false);
});

test("typed answers require compatible field kinds and semantics", () => {
  const date = entry({ answerType: "date", accessibleName: "Date of birth" });
  assert.equal(compatible(date, entry({ accessibleName: "Anything", kind: "select" })), false);
  assert.equal(compatible(date, entry({ accessibleName: "Anything", kind: "text" })), false);
  assert.equal(compatible(date, entry({ accessibleName: "Date of birth", kind: "text" })), true);
});

test("gender answers match radio groups and dropdowns but not phone fields", () => {
  const gender = entry({ answerType: "gender", accessibleName: "Gender", value: "Female" });
  assert.equal(compatible(gender, entry({ accessibleName: "Gender", kind: "radio", value: "female" })), true);
  assert.equal(compatible(gender, entry({ accessibleName: "Title", kind: "radio", value: "mr" })), true);
  assert.equal(compatible(gender, entry({ accessibleName: "Department", kind: "radio", value: "engineering" })), false);
  assert.equal(compatible(gender, entry({ accessibleName: "Gender", kind: "select" })), true);
  assert.equal(compatible(gender, entry({ accessibleName: "Gender", kind: "text" })), true);
  assert.equal(compatible(gender, entry({ accessibleName: "Phone number", kind: "text" })), false);
});

test("remembered gender controls match dropdowns with a different HTML input type", () => {
  const gender = entry({
    answerType: "gender",
    accessibleName: "Gender",
    inputType: "radio",
    kind: "radio",
    value: "Female"
  });
  const unitedGender = entry({
    accessibleName: "Gender(required)",
    inputType: "select-one",
    kind: "select",
    name: "rtiTraveler.travelers[0].gender"
  });
  assert.equal(bestMatch([gender], unitedGender), gender);
});

test("legacy countrycode answers are treated as phone", () => {
  const legacy = entry({ answerType: "countrycode", accessibleName: "Country code", value: "81" });
  assert.equal(answerType(legacy), "phone");
});

test("date answers match split month, day, and year fields", () => {
  const dob = entry({ answerType: "date", accessibleName: "Date of birth", value: "1962-04-18" });
  assert.ok(bestMatch([dob], entry({ accessibleName: "Month", kind: "select", name: "dob.month" })));
  assert.ok(bestMatch([dob], entry({ accessibleName: "DD", kind: "select", name: "dob.day" })));
  assert.ok(bestMatch([dob], entry({ accessibleName: "YYYY", kind: "select", name: "dob.year" })));
  assert.ok(bestMatch([dob], entry({ accessibleName: "Birth month", autocomplete: "bday-month" })));
  assert.equal(bestMatch([dob], entry({ accessibleName: "State", kind: "select" })), null);
});

test("phone answers match country calling code dropdowns", () => {
  const phone = entry({ answerType: "phone", accessibleName: "Phone number", value: "09012345678", countryCode: "81" });
  assert.ok(bestMatch([phone], entry({ accessibleName: "Country calling code", kind: "select", name: "phone.cc" })));
});

test("typed phone answers never match unlabeled document number fields", () => {
  const phone = entry({ answerType: "phone", accessibleName: "Phone number", value: "09012345678", countryCode: "81" });
  const documentNumber = entry({ name: "docNumber", id: "adc-input-S-23BB" });
  assert.equal(compatible(phone, documentNumber), false);
  assert.equal(bestMatch([phone], documentNumber), null);
});

test("birth dates never match document expiration or issue dates", () => {
  const birthday = entry({ answerType: "date", accessibleName: "Date of birth", value: "1962-04-18" });
  for (const field of [
    entry({ accessibleName: "Document expiration date", inputType: "date" }),
    entry({ accessibleName: "Passport expiry month", kind: "select" }),
    entry({ name: "documentExpirationYear", kind: "select" }),
    entry({ accessibleName: "Document issue date", inputType: "date" }),
    // American's passport expiration dropdowns, named only by date part, under
    // an "Expiration date" label and an "International documents" heading.
    entry({ accessibleName: "month", label: "month", group: "Expiration date", section: "International documents", kind: "select" }),
    entry({ accessibleName: "day of birth month", label: "day of birth month", group: "Expiration date", kind: "select" }),
    entry({ accessibleName: "year", label: "year", section: "International documents", kind: "select" })
  ]) {
    assert.equal(compatible(birthday, field), false);
    assert.equal(bestMatch([birthday], field), null);
  }
});

const passport = () => entry({
  answerType: "passport",
  accessibleName: "Passport",
  inputType: "",
  kind: "aggregate",
  value: {
    number: "TR1234567",
    issuingCountryCode: "JP",
    issuingCountryName: "Japan",
    nationalityCode: "JP",
    nationalityName: "Japan",
    issueDate: "2021-03-15",
    expirationDate: "2031-03-15"
  }
});

test("passport number and confirmation fields get the passport number", () => {
  const saved = passport();
  for (const field of [
    entry({ accessibleName: "Passport number", section: "International documents" }),
    entry({ accessibleName: "Confirm passport number", section: "International documents" }),
    entry({ name: "passportNumber" }),
    entry({ accessibleName: "Passport No." }),
    entry({ accessibleName: "Document number", section: "Passport" })
  ]) {
    assert.equal(passportFieldPart(field), "number", field.accessibleName || field.name);
    assert.equal(bestMatch([saved], field), saved);
    assert.equal(passportValue(saved, field), "TR1234567");
  }
  // Other numbers near a passport are not its number.
  for (const label of ["Phone number", "Frequent flyer number", "Known traveler number", "Redress number", "Visa number"]) {
    const field = entry({ accessibleName: label, section: "Passport" });
    assert.notEqual(passportFieldPart(field), "number", label);
    assert.equal(bestMatch([saved], field), null, label);
  }
  // A bare "Number" with no passport around it is something else.
  assert.equal(bestMatch([saved], entry({ accessibleName: "Number" })), null);
});

test("passport dates fill expiration and issue fields only under a passport", () => {
  const saved = passport();
  const expiration = [
    entry({ accessibleName: "Passport expiration date", inputType: "date" }),
    entry({ accessibleName: "Expiry date", section: "Passport details" }),
    // American's dropdowns: named only by date part, under an "Expiration date"
    // label and an "International documents" heading.
    entry({ accessibleName: "month", label: "month", group: "Expiration date", section: "International documents", kind: "select" }),
    entry({ accessibleName: "day of birth month", label: "day of birth month", group: "Expiration date", section: "International documents", kind: "select" }),
    entry({ accessibleName: "year", label: "year", group: "Expiration date", section: "International documents", kind: "select" })
  ];
  for (const field of expiration) {
    assert.equal(passportFieldPart(field), "expirationDate", `${field.accessibleName} ${field.group}`);
    assert.equal(bestMatch([saved], field), saved);
    assert.equal(passportValue(saved, field), "2031-03-15");
  }
  for (const field of [
    entry({ accessibleName: "Passport issue date", inputType: "date" }),
    entry({ accessibleName: "Date of issue", section: "Passport" }),
    entry({ accessibleName: "month", group: "Issue date", section: "Travel documents", kind: "select" })
  ]) {
    assert.equal(passportFieldPart(field), "issueDate", field.accessibleName);
    assert.equal(passportValue(saved, field), "2021-03-15");
  }
  // Without a passport nearby, an expiration date is some other document's.
  for (const field of [
    entry({ accessibleName: "Expiration date" }),
    entry({ accessibleName: "Card expiration date" }),
    entry({ accessibleName: "Expiry date", section: "Driver's license" })
  ]) {
    assert.equal(passportFieldPart(field), "", field.accessibleName);
    assert.equal(bestMatch([saved], field), null);
  }
});

test("a date of birth never takes a passport date, and a passport date never takes a birth date", () => {
  const saved = passport();
  const birthday = entry({ answerType: "date", accessibleName: "Date of birth", value: "1984-07-09" });
  for (const field of [
    entry({ accessibleName: "Date of birth", section: "Passport details" }),
    entry({ accessibleName: "month", group: "Date of birth", section: "Passport", kind: "select" }),
    entry({ accessibleName: "day of birth month", group: "Date of birth", section: "International documents", kind: "select" })
  ]) {
    assert.equal(passportFieldPart(field), "", `${field.accessibleName} ${field.group}`);
    assert.notEqual(bestMatch([saved, birthday], field), saved);
  }
  for (const field of [
    entry({ accessibleName: "month", group: "Expiration date", section: "International documents", kind: "select" }),
    entry({ accessibleName: "day of birth month", group: "Expiration date", section: "International documents", kind: "select" }),
    entry({ accessibleName: "Passport issue date", inputType: "date" })
  ]) {
    assert.equal(bestMatch([saved, birthday], field), saved);
    assert.equal(bestMatch([birthday], field), null);
  }
});

test("passport nationality and issuing country menus get the passport's countries", () => {
  const saved = passport();
  saved.value.issuingCountryCode = "US";
  saved.value.issuingCountryName = "United States";
  for (const [label, section, part, value] of [
    ["Passport nationality", "International documents", "nationality", "Japan"],
    ["Nationality", "Passport", "nationality", "Japan"],
    ["Country of citizenship", "", "nationality", "Japan"],
    ["Issuing country", "Passport", "issuingCountry", "United States"],
    ["Country of issue", "Passport", "issuingCountry", "United States"],
    ["Passport issued by", "", "issuingCountry", "United States"],
    ["Country", "Passport information", "issuingCountry", "United States"]
  ]) {
    const field = entry({ accessibleName: label, section, kind: "select", inputType: "select-one" });
    assert.equal(passportFieldPart(field), part, label);
    assert.equal(bestMatch([saved], field), saved, label);
    assert.equal(passportValue(saved, field), value, label);
  }
  assert.deepEqual(passportCountry(saved, "nationality"), { code: "JP", name: "Japan" });
  assert.deepEqual(passportCountry(saved, "issuingCountry"), { code: "US", name: "United States" });
  // A plain Country menu away from a passport is the address's.
  assert.equal(passportFieldPart(entry({ accessibleName: "Country", kind: "select" })), "");
  assert.equal(passportFieldPart(entry({ accessibleName: "Country of birth", section: "Passport" })), "");
});

test("a nationality answer remembered for the field comes before the passport outside passports", () => {
  const saved = passport();
  const remembered = entry({ accessibleName: "Nationality", kind: "select", inputType: "select-one", value: "Japanese" });
  const field = entry({ accessibleName: "Nationality", kind: "select", inputType: "select-one" });
  assert.equal(bestMatch([saved, remembered], field), remembered);
  assert.equal(bestMatch([saved], field), saved);
  const inPassport = entry({ accessibleName: "Nationality", section: "Passport", kind: "select", inputType: "select-one" });
  assert.equal(bestMatch([saved, remembered], inPassport), saved);
});

test("passports are typed, skip empty parts, never merge, and two are ambiguous", () => {
  const saved = passport();
  assert.equal(answerType(saved), "passport");
  saved.value.issueDate = "";
  const issue = entry({ accessibleName: "Passport issue date", inputType: "date" });
  assert.equal(compatible(saved, issue), false);
  assert.equal(bestMatch([saved], issue), null);
  assert.equal(score(saved, entry({ accessibleName: "Passport number" })), -Infinity);
  const merged = mergeEntries([passport()], [entry({ accessibleName: "Passport", value: "XX0000000" })]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].value.number, "TR1234567");
  const second = passport();
  second.value.number = "AB7654321";
  assert.equal(bestMatch([passport(), second], entry({ accessibleName: "Passport number" })), null);
  // Contact, address, and name fields are left to their own answers.
  for (const label of ["Emergency contact name", "City", "First name", "Email address"]) {
    assert.equal(passportFieldPart(entry({ accessibleName: label, section: "Passport" })), "", label);
  }
});

test("typed special answers require a positively identified destination", () => {
  const birthday = entry({ answerType: "date", accessibleName: "Date of birth", value: "1962-04-18" });
  const phone = entry({ answerType: "phone", accessibleName: "Phone number", value: "09012345678" });
  const gender = entry({ answerType: "gender", accessibleName: "Gender", value: "Female" });
  const anonymous = entry({ id: "generated-control" });
  assert.equal(compatible(birthday, anonymous), false);
  assert.equal(compatible(phone, anonymous), false);
  assert.equal(compatible(gender, anonymous), false);
});

test("full birthday controls are recognized through autocomplete", () => {
  const birthday = entry({ answerType: "date", accessibleName: "Date of birth", value: "1962-04-18" });
  assert.equal(compatible(birthday, entry({ autocomplete: "bday", inputType: "date" })), true);
});

test("structured addresses match standard address components", () => {
  const address = entry({
    answerType: "address",
    accessibleName: "Home address",
    inputType: "",
    kind: "aggregate",
    value: {
      addressLine1: "123 Main Street",
      addressLine2: "Apt 4B",
      locality: "Tampa",
      administrativeArea: "FL",
      postalCode: "33602",
      countryCode: "US",
      countryName: "United States"
    }
  });
  const fields = [
    ["address-line1", "addressLine1", "123 Main Street"],
    ["address-line2", "addressLine2", "Apt 4B"],
    ["address-level2", "locality", "Tampa"],
    ["address-level1", "administrativeArea", "FL"],
    ["postal-code", "postalCode", "33602"],
    ["country-name", "country", "United States"]
  ];
  for (const [autocomplete, part, value] of fields) {
    const field = entry({ autocomplete, inputType: autocomplete === "country-name" ? "select-one" : "text", kind: autocomplete === "country-name" ? "select" : "text" });
    assert.equal(addressFieldPart(field), part);
    assert.equal(addressValue(address, field), value);
    assert.equal(bestMatch([address], field), address);
  }
});

test("structured addresses fill street-address textareas and skip empty optional components", () => {
  const address = entry({
    answerType: "address",
    kind: "aggregate",
    value: { addressLine1: "東京都渋谷区神宮前1-2-3", addressLine2: "梅ビル405", countryCode: "JP", countryName: "Japan" }
  });
  assert.equal(addressValue(address, entry({ autocomplete: "street-address", kind: "textarea" })), "東京都渋谷区神宮前1-2-3\n梅ビル405");
  address.value.addressLine2 = "";
  assert.equal(bestMatch([address], entry({ autocomplete: "address-line2" })), null);
});

test("address country autocomplete is not treated as a phone field", () => {
  const address = entry({ answerType: "address", kind: "aggregate", value: { countryCode: "US", countryName: "United States" } });
  const country = entry({ accessibleName: "Country code", autocomplete: "country", kind: "select", inputType: "select-one" });
  assert.equal(addressFieldPart(country), "country");
  assert.equal(compatible(address, country), true);
  assert.equal(answerType(country), "");
});

test("generic address labels remain recognizable with generated control IDs", () => {
  assert.equal(addressFieldPart(entry({ accessibleName: "City", id: "f47ac10b-58cc-4372-a567-0e02b2c3d479" })), "locality");
  assert.equal(addressFieldPart(entry({ accessibleName: "State", id: "adc-input-S-23BB9102" })), "administrativeArea");
  assert.equal(addressFieldPart(entry({ accessibleName: "Country", id: "control-1749285123456" })), "country");
});

test("country of residence uses the saved address country", () => {
  const address = entry({
    answerType: "address",
    kind: "aggregate",
    value: { addressLine1: "1-2-3 Jingumae", countryCode: "JP", countryName: "Japan" }
  });
  for (const label of ["Country of residence", "Country / region of residence", "Residence country"]) {
    const field = entry({ accessibleName: label, kind: "select", inputType: "select-one" });
    assert.equal(addressFieldPart(field), "country");
    assert.equal(bestMatch([address], field), address);
  }
});

test("nationality and country of birth are not treated as the address country", () => {
  assert.equal(addressFieldPart(entry({ accessibleName: "Nationality" })), "");
  assert.equal(addressFieldPart(entry({ accessibleName: "Country of citizenship" })), "");
  assert.equal(addressFieldPart(entry({ accessibleName: "Country of birth" })), "");
});

test("unrelated address labels and phone country codes are not address components", () => {
  assert.equal(addressFieldPart(entry({ accessibleName: "Email address" })), "");
  assert.equal(addressFieldPart(entry({ accessibleName: "IP address" })), "");
  assert.equal(addressFieldPart(entry({ accessibleName: "Country code" })), "");
  assert.equal(addressFieldPart(entry({ accessibleName: "Country", autocomplete: "tel-country-code", kind: "select" })), "");
  assert.equal(addressFieldPart(entry({ accessibleName: "Business unit" })), "");
  assert.equal(addressFieldPart(entry({ accessibleName: "Unit price" })), "");
  assert.equal(addressFieldPart(entry({ accessibleName: "Apartment type" })), "");
  assert.equal(addressFieldPart(entry({ accessibleName: "Building access code" })), "");
});

test("a ZIP+4 box labeled Extn is the ZIP suffix, not the ZIP code", () => {
  assert.equal(addressFieldPart(entry({ accessibleName: "ZIP Extn", name: "ctl00$Body$zipCodeExtn" })), "postalCodeSuffix");
  assert.equal(addressFieldPart(entry({ accessibleName: "ZIP Code", name: "ctl00$Body$zipCode" })), "postalCode");
});

test("a 4-digit Ext. box named postal_code2 is the ZIP suffix", () => {
  assert.equal(addressFieldPart(entry({ accessibleName: "4-digit Ext.", name: "address$ctl00$address$_EditView$postal_code2" })), "postalCodeSuffix");
  assert.equal(addressFieldPart(entry({ accessibleName: "Zip Code", name: "address$ctl00$address$_EditView$postal_code" })), "postalCode");
});

test("a remembered ZIP code never fills coupon, captcha, or verification code fields", () => {
  const zip = entry({ accessibleName: "ZIP code", label: "ZIP code", name: "zip", value: "94102" });
  for (const label of ["Coupon Code:", "Verification code:", "Type the code shown", "Promo code"]) {
    const field = entry({ accessibleName: label, label, name: "code", inputType: "tel" });
    assert.equal(compatible(zip, field), false, label);
    assert.equal(bestMatch([zip], field), null, label);
  }
  assert.equal(bestMatch([zip], entry({ accessibleName: "Postal code", label: "Postal code", name: "postcode" })), zip);
});

test("older pages' address labels: digits attached, combined rows, and state or province", () => {
  assert.equal(addressFieldPart(entry({ accessibleName: "Address1:" })), "addressLine1");
  assert.equal(addressFieldPart(entry({ accessibleName: "Address2:" })), "addressLine2");
  assert.equal(addressFieldPart(entry({ accessibleName: "City / State / Zip *" })), "locality");
  assert.equal(addressFieldPart(entry({ accessibleName: "State/Province:", kind: "select" })), "administrativeArea");
});

test("a bare Name label takes its part from the field's name, and first and last means full", () => {
  assert.equal(nameFieldPart(entry({ accessibleName: "Name *", name: "dnrfirst" })), "given");
  assert.equal(nameFieldPart(entry({ accessibleName: "Name:", name: "ShiptoLastName" })), "family");
  assert.equal(nameFieldPart(entry({ accessibleName: "Name:", name: "name" })), "full");
  assert.equal(nameFieldPart(entry({ accessibleName: "* Name (first and last):", label: "* Name (first and last):" })), "full");
  assert.equal(nameFieldPart(entry({ accessibleName: "Name:", namePart: "given" })), "given");
});

test("first and last name boxes take those parts whatever the label says", () => {
  const first = entry({ accessibleName: "First name", label: "First name", name: "firstName", value: "Hana" });
  const last = entry({ accessibleName: "Last name", label: "Last name", name: "lastName", value: "Sato" });
  assert.equal(bestMatch([first, last], entry({ accessibleName: "Surname:", label: "Surname:", name: "surname" })), last);
  assert.equal(bestMatch([first, last], entry({ accessibleName: "Name:", label: "Name:", name: "name", namePart: "given" })), first);
});

test("Company Name gets the company, not a first or last name", () => {
  const first = entry({ accessibleName: "First name", label: "First name", name: "first_name", value: "Hana" });
  const last = entry({ accessibleName: "Last name", label: "Last name", name: "last_name", value: "Sato" });
  const company = entry({ accessibleName: "Company", label: "Company", name: "company", value: "Plum Labs" });
  assert.equal(bestMatch([first, last, company], entry({ accessibleName: "Company Name", label: "Company Name", name: "FormField[2][6]" })), company);
  assert.equal(bestMatch([first, last], entry({ accessibleName: "User Name", label: "User Name", name: "user" })), null);
});

test("a shared etc. doesn't match an apartment answer to an unrelated field", () => {
  const apartment = entry({ accessibleName: "Apartment, suite, etc.", label: "Apartment, suite, etc.", name: "address2", value: "Apt 4B" });
  assert.equal(bestMatch([apartment], entry({ accessibleName: "Guests | Rooms, etc.", label: "Guests | Rooms, etc.", id: ":1h.ta" })), null);
});

test("secondary address fallbacks require a dedicated line-two label or name", () => {
  assert.equal(addressFieldPart(entry({ accessibleName: "Apartment, suite, building, etc." })), "addressLine2");
  assert.equal(addressFieldPart(entry({ name: "shippingAddressLine2" })), "addressLine2");
});

test("multiple structured addresses are treated as ambiguous", () => {
  const first = entry({ answerType: "address", kind: "aggregate", value: { locality: "Tokyo" } });
  const second = entry({ answerType: "address", kind: "aggregate", value: { locality: "Tampa" } });
  assert.equal(bestMatch([first, second], entry({ autocomplete: "address-level2" })), null);
});

test("confirmation fields reuse their corresponding saved answer", () => {
  const email = entry({ accessibleName: "Email", inputType: "email", value: "hanako@example.com" });
  for (const label of ["Confirm email", "Re-enter email", "Verify email"]) {
    assert.equal(bestMatch([email], entry({ accessibleName: label, inputType: "email" })), email);
  }
});

test("confirmation matching preserves the underlying field identity", () => {
  const email = entry({ accessibleName: "Email address", inputType: "email", value: "hanako@example.com" });
  const phone = entry({ answerType: "phone", accessibleName: "Phone number", value: "09012345678" });
  assert.equal(bestMatch([email, phone], entry({ accessibleName: "Confirm email address", inputType: "email" })), email);
});

test("name field parts are recognized from labels and autocomplete", () => {
  assert.equal(nameFieldPart(entry({ accessibleName: "First name" })), "given");
  assert.equal(nameFieldPart(entry({ accessibleName: "Last name" })), "family");
  assert.equal(nameFieldPart(entry({ accessibleName: "Full name" })), "full");
  assert.equal(nameFieldPart(entry({ accessibleName: "Name" })), "full");
  assert.equal(nameFieldPart(entry({ autocomplete: "name" })), "full");
  assert.equal(nameFieldPart(entry({ accessibleName: "Username" })), "");
});

test("full name fields are composed from first and last names", () => {
  const first = entry({ accessibleName: "First name", value: "Justin" });
  const last = entry({ accessibleName: "Last name", value: "Garcia" });
  const match = bestMatch([first, last], entry({ accessibleName: "Full name" }));
  assert.equal(match.value, "Justin Garcia");
});

test("an explicit full name answer is preferred over composing parts", () => {
  const first = entry({ accessibleName: "First name", value: "Justin" });
  const last = entry({ accessibleName: "Last name", value: "Garcia" });
  const full = entry({ accessibleName: "Full name", value: "J. Garcia" });
  assert.equal(bestMatch([first, last, full], entry({ accessibleName: "Full name" })), full);
});

test("full name fields are not filled from only a first name", () => {
  const first = entry({ accessibleName: "First name", value: "Justin" });
  assert.equal(bestMatch([first], entry({ accessibleName: "Full name" })), null);
});

test("grouped first and last names compose the matching full name", () => {
  const first = entry({ accessibleName: "First name", group: "Traveler", value: "Justin" });
  const last = entry({ accessibleName: "Last name", group: "Traveler", value: "Garcia" });
  const otherFirst = entry({ accessibleName: "First name", group: "Emergency contact", value: "Jane" });
  const otherLast = entry({ accessibleName: "Last name", group: "Emergency contact", value: "Doe" });
  const match = bestMatch([first, last, otherFirst, otherLast], entry({ accessibleName: "Full name", section: "Traveler" }));
  assert.equal(match.value, "Justin Garcia");
});

const contact = (category, role, name, extra = {}) => entry({
  answerType: "contact",
  kind: "aggregate",
  inputType: "",
  userLabel: name,
  accessibleName: name,
  label: name,
  value: { version: 1, category, role, name, ...extra }
});

const doctors = () => [
  contact("doctor", "Primary care", "Dr. Sakura Ito", { phone: "03-1234-5678", organization: "Ito Family Clinic" }),
  contact("doctor", "Cardiologist", "Dr. Anita Patel", { phone: "813-555-0200", fax: "813-555-0201", address: "500 Heart Way, Tampa, FL 33602" })
];

const emergencyContacts = () => [
  contact("emergencyContact", "Daughter", "Hanako Yamada", { phone: "080-9876-5432" }),
  contact("emergencyContact", "Son", "Taro Yamada", { phone: "080-1111-2222" })
];

test("contact fields are recognized by category, part, and specialty", () => {
  const info = (overrides) => {
    const result = contactFieldInfo(entry(overrides));
    return result ? { category: result.category, part: result.part, specialty: result.specialty, ordinal: result.ordinal } : null;
  };
  assert.deepEqual(info({ accessibleName: "Primary care physician" }), { category: "doctor", part: "name", specialty: 0, ordinal: -1 });
  assert.deepEqual(info({ accessibleName: "Cardiologist phone" }), { category: "doctor", part: "phone", specialty: 1, ordinal: -1 });
  assert.deepEqual(info({ accessibleName: "Referring physician fax" }), { category: "doctor", part: "fax", specialty: -1, ordinal: -1 });
  assert.deepEqual(info({ accessibleName: "Emergency contact name" }), { category: "emergencyContact", part: "name", specialty: -1, ordinal: -1 });
  assert.deepEqual(info({ accessibleName: "Emergency contact phone number", name: "emergency_contact_phone" }), { category: "emergencyContact", part: "phone", specialty: -1, ordinal: -1 });
  assert.deepEqual(info({ accessibleName: "Emergency contact 2 phone" }), { category: "emergencyContact", part: "phone", specialty: -1, ordinal: 1 });
  assert.deepEqual(info({ accessibleName: "Relationship", group: "Emergency contact" }), { category: "emergencyContact", part: "role", specialty: -1, ordinal: -1 });
  assert.deepEqual(info({ accessibleName: "Phone", section: "In case of emergency" }), { category: "emergencyContact", part: "phone", specialty: -1, ordinal: -1 });
  assert.deepEqual(info({ accessibleName: "Practice name", section: "Primary care physician" }), { category: "doctor", part: "organization", specialty: 0, ordinal: -1 });
  assert.equal(info({ accessibleName: "Your phone", section: "Emergency contact" }), null);
  assert.equal(info({ accessibleName: "Name", section: "Emergency department intake" }), null);
  assert.equal(info({ accessibleName: "Physician license number" }), null);
  assert.equal(info({ accessibleName: "Insurance provider" }), null);
  assert.equal(info({ accessibleName: "Mobile phone", autocomplete: "tel" }), null);
  assert.equal(info({ accessibleName: "Who normally manages your care?", id: "portal-doctor" }), null);
  assert.equal(info({ accessibleName: "Date of last doctor visit" }), null);
});

test("doctor fields pick the saved doctor by specialty", () => {
  const [pcp, cardiologist] = doctors();
  const saved = [...doctors(), entry({ accessibleName: "Phone number", autocomplete: "tel", answerType: "phone", value: "090-1234-5678" })];
  const pick = (overrides) => bestMatch(saved, entry(overrides));
  assert.equal(pick({ accessibleName: "Primary care physician" }).userLabel, pcp.userLabel);
  assert.equal(pick({ accessibleName: "Primary physician", name: "primary_physician" }).userLabel, pcp.userLabel);
  assert.equal(pick({ accessibleName: "Cardiologist phone" }).userLabel, cardiologist.userLabel);
  assert.equal(pick({ accessibleName: "Cardiologist fax" }).userLabel, cardiologist.userLabel);
  assert.equal(pick({ accessibleName: "Physician name" }).userLabel, pcp.userLabel, "no specialty hint prefers the primary care doctor");
  assert.equal(pick({ accessibleName: "Specialist name" }).userLabel, cardiologist.userLabel);
  assert.equal(pick({ accessibleName: "Dermatologist phone" }), null, "unknown specialties are not guessed");
  assert.equal(pick({ accessibleName: "Primary care physician fax" }), null, "missing parts are not filled");
  assert.equal(contactValue(cardiologist, entry({ accessibleName: "Cardiologist address" })), "500 Heart Way, Tampa, FL 33602");
  assert.equal(contactValue(pcp, entry({ accessibleName: "Practice", section: "Primary care physician" })), "Ito Family Clinic");
  assert.equal(contactValue(pcp, entry({ accessibleName: "Physician last name" })), "Ito");
  assert.equal(contactValue(pcp, entry({ accessibleName: "Physician first name" })), "Sakura");
});

test("emergency contact fields use ordinals, relationships, and name parts", () => {
  const [daughter, son] = emergencyContacts();
  const saved = [...emergencyContacts(), ...doctors()];
  const pick = (overrides) => bestMatch(saved, entry(overrides));
  assert.equal(pick({ accessibleName: "Emergency contact phone number" }).userLabel, daughter.userLabel);
  assert.equal(pick({ accessibleName: "Emergency contact 2 phone" }).userLabel, son.userLabel);
  assert.equal(pick({ accessibleName: "Emergency contact 3 phone" }), null);
  assert.equal(pick({ accessibleName: "Secondary emergency contact name" }).userLabel, son.userLabel);
  const relationship = entry({ accessibleName: "Relationship", group: "Emergency contact", kind: "select" });
  assert.equal(pick(relationship).userLabel, daughter.userLabel);
  assert.equal(contactValue(daughter, relationship), "Daughter");
  assert.equal(contactValue(daughter, entry({ accessibleName: "Emergency contact first name" })), "Hanako");
  assert.equal(contactValue(daughter, entry({ accessibleName: "Emergency contact last name" })), "Yamada");
  assert.equal(pick({ accessibleName: "Emergency", kind: "checkbox", inputType: "checkbox" }), null);
});

test("your own answers never fill contact fields, and remembered contact answers stay with contact fields", () => {
  const ownPhone = entry({ accessibleName: "Phone number", autocomplete: "tel", answerType: "phone", value: "090-1234-5678" });
  const emergencyField = entry({ accessibleName: "Emergency contact phone number", name: "emergency_contact_phone", inputType: "tel" });
  assert.equal(bestMatch([ownPhone], emergencyField), null);
  assert.equal(bestMatch([ownPhone, ...emergencyContacts()], emergencyField).userLabel, "Hanako Yamada");

  const remembered = entry({ ...emergencyField, value: "080-9876-5432" });
  assert.equal(bestMatch([remembered, ownPhone], entry({ accessibleName: "Emergency contact phone", inputType: "tel" })), remembered);
  assert.equal(bestMatch([remembered], entry({ accessibleName: "Mobile phone", autocomplete: "tel", inputType: "tel" })), null);

  const given = entry({ autocomplete: "given-name", value: "Hanako" });
  const family = entry({ autocomplete: "family-name", value: "Yamada" });
  assert.equal(bestMatch([given, family], entry({ accessibleName: "Emergency contact full name" })), null);
  assert.equal(bestMatch([given, family], entry({ accessibleName: "Full name" }))?.value, "Hanako Yamada");
});

test("remembering a form never replaces a saved address with a field's text", () => {
  const address = entry({
    answerID: "home",
    answerType: "address",
    userLabel: "Address",
    accessibleName: "Address",
    label: "Address",
    inputType: "",
    kind: "aggregate",
    value: { addressLine1: "1-2-3 Jingumae", countryCode: "JP", countryName: "Japan" }
  });
  // The same label on the page scores well above the merge threshold.
  const field = entry({ accessibleName: "Address", label: "Address", value: "9 Elm St" });
  const merged = mergeEntries([address], [field]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], address);
  assert.equal(merged[1].value, "9 Elm St");
  // Plain answers still merge as before.
  const city = entry({ answerID: "city", accessibleName: "City", label: "City", value: "Tokyo" });
  const updated = mergeEntries([address, city], [entry({ accessibleName: "City", label: "City", value: "Osaka" })]);
  assert.equal(updated.length, 2);
  assert.equal(updated[1].value, "Osaka");
  assert.equal(updated[1].answerID, "city");
});

test("contacts flatten into sanitized parts for AI mapping and never merge with remembered answers", () => {
  const [, cardiologist] = doctors();
  const parts = contactParts(cardiologist);
  assert.deepEqual(parts.map((item) => item.part), ["name", "role", "phone", "fax", "address"]);
  const phone = parts.find((item) => item.part === "phone").entry;
  assert.equal(phone.accessibleName, "Doctor, Cardiologist phone");
  assert.equal(phone.inputType, "tel");
  assert.equal(phone.value, "813-555-0200");
  assert.equal(parts.find((item) => item.part === "role").entry.accessibleName, "Doctor, Cardiologist specialty");
  assert.equal(contactParts(emergencyContacts()[0]).find((item) => item.part === "role").entry.label, "Emergency contact, Daughter relationship");
  // The AI never sees a contact's label, which defaults to the person's name.
  for (const { entry: part } of parts) assert.equal(part.userLabel, undefined);
  assert.ok(parts.every(({ entry: part }) => !JSON.stringify({ ...part, value: undefined }).includes(cardiologist.userLabel)));
  assert.equal(contactParts(cardiologist, 2).find((item) => item.part === "phone").entry.accessibleName, "Doctor 2, Cardiologist phone");

  const incoming = entry({ accessibleName: "Cardiologist phone", inputType: "tel", value: "813-555-0200" });
  assert.equal(mergeEntries([cardiologist], [incoming]).length, 2);
  assert.equal(score(cardiologist, incoming), -Infinity);
  assert.equal(answerType(cardiologist), "contact");
});

test("fields asking who owns a phone are not filled with a phone number", () => {
  const phone = entry({ accessibleName: "Phone number", label: "Phone number", autocomplete: "tel", inputType: "tel", answerType: "phone", countryCode: "81", value: "8026206269" });
  const saved = [phone, entry({ autocomplete: "given-name", value: "Justin" }), entry({ autocomplete: "family-name", value: "Garcia" })];
  for (const label of ["Owner of Phone", "Name of phone owner", "Phone holder", "Mobile subscriber name"]) {
    assert.equal(bestMatch(saved, entry({ accessibleName: label, label, group: "Phone No." })), null, label);
  }
  for (const label of ["Phone No.", "Owner's phone number", "Cardholder phone", "Mobile"]) {
    assert.equal(bestMatch(saved, entry({ accessibleName: label, label, group: "Phone No.", placeholder: "+81 Ex. 9012345678" })), phone, label);
  }
});

test("a saved email never fills a field asking for an address", () => {
  const email = entry({ accessibleName: "Email address", label: "Email address", name: "email", autocomplete: "email", inputType: "email", value: "hana@example.com" });
  const street = entry({ accessibleName: "Street address", label: "Street address", name: "address1", autocomplete: "address-line1", value: "1200 Market Street" });
  for (const label of ["Address:", "* Shipping Address:", "Address 2 (optional)", "Address Line 3"]) {
    const field = entry({ accessibleName: label, label, name: "address" });
    assert.notEqual(bestMatch([email], field), email, label);
  }
  assert.equal(bestMatch([email, street], entry({ accessibleName: "E-mail Address:", label: "E-mail Address:", name: "txtEmail" })), email);
});

test("a plain Address label is the street line, so a structured address fills it", () => {
  const address = entry({ answerType: "address", kind: "aggregate", value: { addressLine1: "1200 Market Street", addressLine2: "Apt 4B", countryCode: "US" } });
  const email = entry({ accessibleName: "Email address", label: "Email address", autocomplete: "email", value: "hana@example.com" });
  const field = entry({ accessibleName: "Address:", label: "Address:", name: "address" });
  assert.equal(addressFieldPart(field), "addressLine1");
  assert.equal(bestMatch([email, address], field), address);
  assert.equal(addressFieldPart(entry({ accessibleName: "Address", kind: "textarea" })), "streetAddress");
});

test("a remembered street line never fills line 2, and line 2 finds the remembered apartment", () => {
  const street = entry({ accessibleName: "Street address", label: "Street address", name: "address1", autocomplete: "address-line1", value: "1200 Market Street" });
  const apartment = entry({ accessibleName: "Apartment, suite, etc.", label: "Apartment, suite, etc.", name: "address2", autocomplete: "address-line2", value: "Apt 4B" });
  for (const [label, name] of [["Address line 2:", "a2"], ["Street Address Line 2", "shipping_address2"], ["Address 2:(optional)", "billing_suite"], ["", "BillingAddress2"]]) {
    const field = entry({ accessibleName: label, label, name });
    assert.equal(addressFieldPart(field), "addressLine2", label || name);
    assert.equal(bestMatch([street, apartment], field), apartment, label || name);
  }
  assert.equal(bestMatch([street, apartment], entry({ accessibleName: "Address Line 3", label: "Address Line 3", name: "address3" })), null);
});

test("machine names give way to a label that names something else", () => {
  assert.equal(addressFieldPart(entry({ accessibleName: "Company", label: "Company", name: "ctl00$Main$address2" })), "");
  assert.equal(addressFieldPart(entry({ accessibleName: "Company", label: "Company", name: "Form$_mailingAddress$_company", id: "Form__mailingAddress__company" })), "");
  assert.equal(addressFieldPart(entry({ name: "Form$_mailingAddress$_city" })), "locality");
  assert.equal(addressFieldPart(entry({ accessibleName: "Zip/Postal Code", label: "Zip/Postal Code", section: "Mailing Address" })), "postalCode");
});

test("ZIP+4 boxes and phone extensions get nothing", () => {
  const zip = entry({ accessibleName: "ZIP code", label: "ZIP code", name: "zip", autocomplete: "postal-code", value: "94102" });
  const phone = entry({ answerType: "phone", accessibleName: "Phone number", label: "Phone number", name: "phone", autocomplete: "tel", inputType: "tel", value: "4155550142" });
  assert.equal(addressFieldPart(entry({ accessibleName: "Optional", label: "Optional", name: "addzipcodeExt" })), "postalCodeSuffix");
  assert.equal(bestMatch([zip, phone], entry({ accessibleName: "Optional", label: "Optional", name: "addzipcodeExt" })), null);
  for (const label of ["Ext.", "Ext:", "Extension"]) {
    assert.equal(bestMatch([zip, phone], entry({ accessibleName: label, label, name: "phoneExt", inputType: "tel" })), null, label);
  }
});

test("area code and numbered phone boxes are phone fields, never ZIP codes", () => {
  const zip = entry({ accessibleName: "ZIP code", label: "ZIP code", name: "zip", autocomplete: "postal-code", value: "94102" });
  const phone = entry({ answerType: "phone", accessibleName: "Phone number", label: "Phone number", name: "phone", autocomplete: "tel", inputType: "tel", value: "4155550142" });
  assert.equal(bestMatch([zip, phone], entry({ accessibleName: "Area code", label: "Area code", name: "eveningAreaCode", inputType: "tel" })), phone);
  assert.equal(bestMatch([zip, phone], entry({ name: "dayPhone1", tableHeaders: ["Day phone:"] })), phone);
});

// Fields as Remember reads them from American's profile after it's filled in.
const americanFields = (overrides = {}) => [
  entry({ accessibleName: "First name", label: "First name", section: "Personal information", value: "Kenji" }),
  entry({ accessibleName: "month", label: "month", group: "Date of birth", section: "Personal information", kind: "select", inputType: "select-one", value: "July", optionValue: "07" }),
  entry({ accessibleName: "Passport number", label: "Passport number", section: "International documents", value: overrides.number || "TK1234567" }),
  entry({ accessibleName: "Confirm passport number", label: "Confirm passport number", section: "International documents", value: overrides.number || "TK1234567" }),
  entry({ accessibleName: "month", label: "month", group: "Expiration date", section: "International documents", kind: "select", inputType: "select-one", value: "March", optionValue: "03", datePart: "month" }),
  entry({ accessibleName: "day of birth month", label: "day of birth month", group: "Expiration date", section: "International documents", kind: "select", inputType: "select-one", value: "15", optionValue: "15", datePart: "day" }),
  entry({ accessibleName: "year", label: "year", group: "Expiration date", section: "International documents", kind: "select", inputType: "select-one", value: "2031", optionValue: "2031", datePart: "year" }),
  entry({ accessibleName: "Passport nationality", label: "Passport nationality", section: "International documents", kind: "select", inputType: "select-one", value: "Japan", optionValue: "JP" })
];

test("remembering a passport page saves one passport answer, not a field each", () => {
  const { answers, structured } = rememberAnswers([], americanFields(), { passport: "パスポート" });
  assert.deepEqual(structured, ["passport"]);
  const passports = answers.filter((answer) => answer.answerType === "passport");
  assert.equal(passports.length, 1);
  assert.equal(passports[0].userLabel, "パスポート");
  assert.equal(passports[0].kind, "aggregate");
  assert.equal(passports[0].value.number, "TK1234567");
  assert.equal(passports[0].value.expirationDate, "2031-03-15");
  assert.equal(passports[0].value.nationalityCode, "JP");
  assert.ok(passports[0].value.nationalityName);
  // The first name and the birth month stay answers of their own, and no
  // passport field is left over as one.
  assert.deepEqual(answers.filter((answer) => answer.answerType !== "passport").map((answer) => answer.value), ["Kenji", "July"]);
  assert.ok(answers.every((answer) => answer.optionValue === undefined && answer.datePart === undefined));
  // What was remembered fills the page again.
  const saved = passports[0];
  assert.equal(bestMatch(answers, entry({ accessibleName: "month", group: "Expiration date", section: "International documents", kind: "select" })), saved);
});

test("remembering updates the saved passport in place, and a new number starts its dates over", () => {
  const saved = passport();
  saved.answerID = "mine";
  saved.userLabel = "My passport";
  const same = rememberAnswers([saved], americanFields({ number: "TR1234567" })).answers;
  assert.equal(same.length, 3);
  const updated = same.find((answer) => answer.answerType === "passport");
  assert.equal(updated.answerID, "mine");
  assert.equal(updated.userLabel, "My passport");
  assert.equal(updated.value.issueDate, "2021-03-15");
  assert.equal(updated.value.expirationDate, "2031-03-15");
  // A renewed passport: its old issue date goes, its countries stay.
  const renewed = rememberAnswers([saved], americanFields({ number: "TZ7654321" })).answers.find((answer) => answer.answerType === "passport");
  assert.equal(renewed.answerID, "mine");
  assert.equal(renewed.value.number, "TZ7654321");
  assert.equal(renewed.value.issueDate, undefined);
  assert.equal(renewed.value.issuingCountryCode, "JP");
});

test("two travelers' passports, or two saved passports with neither number, stay as they were", () => {
  const second = [
    entry({ accessibleName: "Passport number", section: "Traveler 2 passport", value: "AB0000001" })
  ];
  const { answers, structured } = rememberAnswers([], [...americanFields(), ...second]);
  assert.deepEqual(structured, []);
  assert.ok(answers.some((answer) => answer.value === "AB0000001"));
  assert.ok(answers.every((answer) => answer.answerType !== "passport"));
  const other = passport();
  other.value.number = "XX1111111";
  const result = rememberAnswers([passport(), other], americanFields({ number: "TZ7654321" }));
  assert.deepEqual(structured, []);
  assert.deepEqual(result.structured, []);
  assert.equal(result.answers.filter((answer) => answer.answerType === "passport").length, 2);
});

const addressFields = (line1 = "1200 Market Street", extra = []) => [
  entry({ autocomplete: "address-line1", accessibleName: "Street address", value: line1 }),
  entry({ autocomplete: "address-line2", accessibleName: "Apartment, suite, etc.", value: "Apt 4B" }),
  entry({ autocomplete: "address-level2", accessibleName: "City", value: "San Francisco" }),
  entry({ autocomplete: "address-level1", accessibleName: "State", kind: "select", inputType: "select-one", value: "California", optionValue: "CA" }),
  entry({ autocomplete: "postal-code", accessibleName: "ZIP code", value: "94102" }),
  entry({ autocomplete: "country", accessibleName: "Country", kind: "select", inputType: "select-one", value: "United States", optionValue: "US" }),
  ...extra
];

test("remembering an address page saves one address answer that fills the page again", () => {
  const { answers, structured } = rememberAnswers([], [entry({ accessibleName: "Email", inputType: "email", value: "kenji@example.com" }), ...addressFields()]);
  assert.deepEqual(structured, ["address"]);
  assert.equal(answers.length, 2);
  const address = answers.find((answer) => answer.answerType === "address");
  assert.deepEqual(
    Object.fromEntries(Object.entries(address.value).filter(([key]) => key !== "countryName")),
    { addressLine1: "1200 Market Street", addressLine2: "Apt 4B", locality: "San Francisco", administrativeArea: "California", postalCode: "94102", countryCode: "US", version: 1 }
  );
  assert.equal(address.userLabel, "Address");
  assert.equal(bestMatch(answers, entry({ autocomplete: "postal-code" })), address);
  // Shipping and billing that agree are one address; country names in any
  // of the app's languages, or with a dialing code, are recognized.
  const billing = addressFields().map((field) => ({ ...field, autocomplete: `billing ${field.autocomplete}` }));
  assert.deepEqual(rememberAnswers([], [...addressFields(), ...billing]).structured, ["address"]);
  for (const country of ["日本", "Japan +81", "Japan"]) {
    const fields = [
      entry({ autocomplete: "address-line1", value: "1-2-3 Jingumae" }),
      entry({ autocomplete: "country", kind: "select", value: country })
    ];
    assert.equal(rememberAnswers([], fields).answers[0].value.countryCode, "JP", country);
  }
});

test("an address isn't folded when it can't be saved or it's unclear whose it is", () => {
  // No country and no saved address to take one from.
  const noCountry = addressFields().filter((field) => field.autocomplete !== "country");
  assert.deepEqual(rememberAnswers([], noCountry).structured, []);
  assert.equal(rememberAnswers([], noCountry).answers.length, noCountry.length);
  // Shipping and billing that differ.
  const billing = addressFields("9 Elm St").map((field) => ({ ...field, autocomplete: `billing ${field.autocomplete}` }));
  assert.deepEqual(rememberAnswers([], [...addressFields(), ...billing]).structured, []);
  // An emergency contact's address is the contact's.
  const contact = [entry({ accessibleName: "Emergency contact street address", value: "5 Oak Ave" })];
  assert.deepEqual(rememberAnswers([], contact).structured, []);
});

test("remembering updates the saved address: a new street line clears the old apartment", () => {
  const home = entry({
    answerID: "home", answerType: "address", userLabel: "Home", accessibleName: "Home", label: "Home", inputType: "", kind: "aggregate",
    value: { addressLine1: "1-2-3 Jingumae", addressLine2: "Room 405", locality: "Shibuya", countryCode: "JP", countryName: "Japan" }
  });
  const moved = [
    entry({ autocomplete: "address-line1", value: "4-5-6 Ebisu" }),
    entry({ autocomplete: "address-level2", value: "Shibuya" })
  ];
  const { answers, structured } = rememberAnswers([home], moved);
  assert.deepEqual(structured, ["address"]);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].answerID, "home");
  assert.deepEqual(answers[0].value, { addressLine1: "4-5-6 Ebisu", locality: "Shibuya", countryCode: "JP", countryName: "Japan", version: 1 });
  // The same street line only fills in what's new.
  const zip = rememberAnswers([home], [entry({ autocomplete: "address-line1", value: "1-2-3 Jingumae" }), entry({ autocomplete: "postal-code", value: "150-0001" })]).answers[0];
  assert.equal(zip.value.addressLine2, "Room 405");
  assert.equal(zip.value.postalCode, "150-0001");
  // With two saved addresses, the one with the same street line is updated;
  // a third street line is no telling which, so the fields stay loose.
  const work = { ...home, answerID: "work", value: { addressLine1: "7-8-9 Marunouchi", countryCode: "JP" } };
  const both = rememberAnswers([home, work], [entry({ autocomplete: "address-line1", value: "7-8-9 Marunouchi" }), entry({ autocomplete: "postal-code", value: "100-0005" })]).answers;
  assert.equal(both.find((answer) => answer.answerID === "work").value.postalCode, "100-0005");
  assert.equal(both.find((answer) => answer.answerID === "home").value.postalCode, undefined);
  assert.deepEqual(rememberAnswers([home, work], moved).structured, []);
});

test("remembered passport dates: whole dates are read only when unambiguous, and long parts are left out", () => {
  const field = (value, label = "Passport expiration date") => entry({ accessibleName: label, value });
  const date = (value) => rememberAnswers([], [field("TK1234567", "Passport number"), field(value)]).answers[0].value.expirationDate;
  assert.equal(date("2031-03-15"), "2031-03-15");
  assert.equal(date("15/03/2031"), "2031-03-15");
  assert.equal(date("03/15/2031"), "2031-03-15");
  assert.equal(date("15 Mar 2031"), "2031-03-15");
  assert.equal(date("March 15 2031"), "2031-03-15");
  assert.equal(date("04/05/2031"), undefined);
  assert.equal(date("2031-02-30"), undefined);
  assert.deepEqual(rememberAnswers([], [field("X".repeat(40), "Passport number")]).structured, []);
});

test("remembering a form keeps first and last name apart, on the page and against saved answers", () => {
  const field = (label, autocomplete, value) => entry({ accessibleName: label, label, name: label.toLowerCase().replace(" ", "_"), autocomplete, group: "Your details", value });
  const first = field("First name", "given-name", "Hana");
  const last = field("Last name", "family-name", "Sato");
  // They score above the merge threshold, but they're different fields.
  assert.ok(score(first, last) >= 85);
  assert.deepEqual(mergeEntries([], [first, last]).map((answer) => answer.value), ["Hana", "Sato"]);
  const saved = mergeEntries([], [first, last]);
  const again = mergeEntries(saved, [field("First name", "given-name", "Hanako"), field("Last name", "family-name", "Sato")]);
  assert.deepEqual(again.map((answer) => answer.value), ["Hanako", "Sato"]);
  assert.deepEqual(again.map((answer) => answer.answerID), saved.map((answer) => answer.answerID));
  // Without names or autocomplete to tell them apart, each saved answer
  // still takes only the field that matches it best.
  const city = entry({ accessibleName: "City", label: "City", value: "Tokyo" });
  const merged = mergeEntries([city], [entry({ accessibleName: "City", label: "City", value: "Osaka" }), entry({ accessibleName: "City", label: "City", section: "Billing", value: "Kyoto" })]);
  assert.deepEqual(merged.map((answer) => answer.value), ["Osaka", "Kyoto"]);
});

test("older and spelled-out address labels name their part", () => {
  for (const [label, part] of [
    ["Town/City*", "locality"], ["• City or APO/FPO:", "locality"], ["* Suburb/City:", "locality"], ["City (required)", "locality"],
    ["State* State*", "administrativeArea"], ["State (required)", "administrativeArea"], ["State or province", "administrativeArea"],
    ["*House Number and Street", "addressLine1"], ["Address of residence", "addressLine1"],
    ["Apartment, Building, Floor, Etc", "addressLine2"],
    ["City or Town of Birth:", ""], ["Country of Birth:", ""]
  ]) {
    assert.equal(addressFieldPart(entry({ accessibleName: label, label })), part, label);
  }
});

test("Japanese and Korean label words read as the English words matching looks for", () => {
  for (const [label, words] of [
    ["郵便番号", "postal code"], ["〒", "postal code"], ["ご住所", "address"], ["住所２", "address 2"], ["国・地域", "country region"],
    ["建物名・部屋番号など", "building apartment etc"], ["お電話番号（必須）", "phone required"], ["携帯電話番号", "mobile phone"],
    ["ﾒｰﾙｱﾄﾞﾚｽ", "email"], ["パスポート番号（確認用）", "passport number confirm"], ["1月", "1 month"],
    ["시/도", "state"], ["상세 주소", "address line 2"], ["이메일 주소", "email address"], ["여권 번호", "passport number"]
  ]) {
    assert.equal(normalize(label), words, label);
  }
  // Other Japanese and Korean text is kept as it is written, not dropped:
  // a single character counts only standing alone.
  assert.equal(normalize("東京都"), "東京都");
  assert.equal(normalize("日本"), "日本");
  assert.equal(normalize("国内"), "国内");
  assert.equal(normalize("서울특별시"), "서울특별시");
});

test("Japanese and Korean address labels name their part, and a kana reading box is none", () => {
  for (const [label, part] of [
    ["郵便番号", "postalCode"], ["〒", "postalCode"], ["都道府県", "administrativeArea"], ["市区町村", "locality"],
    ["町名・番地", "addressLine1"], ["番地以降", "addressLine1"], ["ご住所", "addressLine1"], ["建物名・部屋番号など", "addressLine2"],
    ["住所２", "addressLine2"], ["国・地域", "country"], ["市区町村（カナ）", ""], ["住所（フリガナ）", ""],
    ["우편번호", "postalCode"], ["시/도", "administrativeArea"], ["시/군/구", "locality"], ["도로명 주소", "addressLine1"],
    ["상세 주소", "addressLine2"], ["국가", "country"]
  ]) {
    assert.equal(addressFieldPart(entry({ accessibleName: label, label })), part, label);
  }
  const address = entry({
    answerType: "address", kind: "aggregate", inputType: "",
    value: { addressLine1: "神宮前1-2-3", addressLine2: "梅ビル405", locality: "渋谷区", administrativeArea: "東京都", postalCode: "150-0001", countryCode: "JP", countryName: "日本" }
  });
  assert.equal(addressValue(address, entry({ accessibleName: "市区町村" })), "渋谷区");
  assert.equal(bestMatch([address], entry({ accessibleName: "建物名・部屋番号" })), address);
  // A prefecture menu now finds "東京都" among its options.
  assert.equal(selectOptionIndex([{ text: "選択してください", value: "" }, { text: "大阪府", value: "27" }, { text: "東京都", value: "13" }], "東京都"), 2);
});

test("Japanese and Korean passport, birth date, phone, and gender labels are recognized", () => {
  const saved = passport();
  for (const [label, section, part, extra] of [
    ["旅券番号", "", "number"], ["パスポート番号（確認用）", "", "number"], ["有効期限", "パスポート情報", "expirationDate"],
    ["月", "パスポート情報", "expirationDate", { group: "有効期限", kind: "select" }], ["発行年月日", "パスポート情報", "issueDate"],
    ["発行国", "パスポート情報", "issuingCountry", { kind: "select" }], ["国籍", "", "nationality", { kind: "select" }],
    ["여권 번호", "", "number"], ["만료일", "여권 정보", "expirationDate"], ["발급일", "여권 정보", "issueDate"], ["국적", "", "nationality", { kind: "select" }]
  ]) {
    const field = entry({ accessibleName: label, label, section, ...(extra || {}) });
    assert.equal(passportFieldPart(field), part, label);
    assert.equal(bestMatch([saved], field), saved, label);
  }
  // A birth date in a passport section is still a birth date.
  const birthday = entry({ answerType: "date", accessibleName: "Date of birth", value: "1984-07-09" });
  for (const label of ["生年月日", "생년월일"]) {
    const field = entry({ accessibleName: label, label, section: "パスポート情報", inputType: "date" });
    assert.equal(passportFieldPart(field), "", label);
    assert.equal(bestMatch([saved, birthday], field), birthday, label);
  }
  assert.equal(bestMatch([birthday], entry({ accessibleName: "有効期限", section: "パスポート情報", inputType: "date" })), null);
  const phone = entry({ answerType: "phone", accessibleName: "Phone number", value: "+81 9012345678" });
  const gender = entry({ answerType: "gender", accessibleName: "Gender", value: "Female" });
  for (const label of ["電話番号", "お電話番号（必須）", "携帯電話番号", "휴대폰 번호"]) {
    assert.equal(bestMatch([phone], entry({ accessibleName: label, label, inputType: "tel" })), phone, label);
  }
  for (const label of ["性別", "성별"]) {
    assert.equal(bestMatch([gender], entry({ accessibleName: label, label, kind: "select" })), gender, label);
  }
  // An emergency contact's phone isn't yours.
  for (const label of ["緊急連絡先 電話番号", "비상 연락처 전화번호"]) {
    assert.equal(bestMatch([phone], entry({ accessibleName: label, label, inputType: "tel" })), null, label);
  }
});

test("remembering a Japanese address page saves one address, and tells different Japanese addresses apart", () => {
  const fields = [
    entry({ accessibleName: "郵便番号", value: "150-0001" }),
    entry({ accessibleName: "都道府県", kind: "select", value: "東京都", optionValue: "13" }),
    entry({ accessibleName: "市区町村", value: "渋谷区" }),
    entry({ accessibleName: "町名・番地", value: "神宮前1-2-3" }),
    entry({ accessibleName: "建物名・部屋番号", value: "梅ビル405" }),
    entry({ accessibleName: "国・地域", kind: "select", value: "日本", optionValue: "JP" })
  ];
  const { answers, structured } = rememberAnswers([], fields, { address: "住所" });
  assert.deepEqual(structured, ["address"]);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].userLabel, "住所");
  assert.equal(answers[0].value.addressLine1, "神宮前1-2-3");
  assert.equal(answers[0].value.administrativeArea, "東京都");
  assert.equal(answers[0].value.countryCode, "JP");
  // Two saved addresses whose street lines share only their numbers are
  // different addresses: a third page address updates neither.
  const home = { ...answers[0], answerID: "home" };
  const osaka = { ...answers[0], answerID: "osaka", value: { ...answers[0].value, addressLine1: "梅田1-2-3", locality: "大阪市北区" } };
  const other = [entry({ accessibleName: "町名・番地", value: "栄1-2-3" }), entry({ accessibleName: "国・地域", kind: "select", value: "日本", optionValue: "JP" })];
  assert.deepEqual(rememberAnswers([home, osaka], other).structured, []);
});

test("a bilingual label reads by its English words; a kana reading box stays a reading box", () => {
  assert.equal(nameFieldPart(entry({ accessibleName: "姓名 Name(必填)" })), "full");
  assert.equal(addressFieldPart(entry({ accessibleName: "地址 Address" })), "addressLine1");
  assert.equal(addressFieldPart(entry({ accessibleName: "市区町村（カナ）" })), "");
  assert.equal(addressFieldPart(entry({ accessibleName: "City カナ" })), "");
});
