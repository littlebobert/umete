const test = require("node:test");
const assert = require("node:assert/strict");
const { addressFieldPart, addressValue, answerType, bestMatch, compatible, contactFieldInfo, contactParts, contactValue, looksGenerated, mergeEntries, nameFieldPart, normalize, passportCountry, passportFieldPart, passportValue, score, selectOptionIndex } = require("../Extension/lib/matcher.js");

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
