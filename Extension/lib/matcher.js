(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.UmeMatcher = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TOKEN_RE = /[^a-z0-9]+/g;
  const STOP_WORDS = new Set(["a", "an", "and", "etc", "field", "input", "of", "or", "the", "your"]);

  function normalize(value) {
    return String(value || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(TOKEN_RE, " ")
      .trim();
  }

  function tokens(value) {
    return new Set(normalize(value).split(/\s+/).filter((token) => token && !STOP_WORDS.has(token)));
  }

  function overlap(left, right) {
    const a = tokens(left);
    const b = tokens(right);
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const token of a) if (b.has(token)) shared += 1;
    return shared / Math.max(a.size, b.size);
  }

  function selectOptionIndex(options, value) {
    const normalized = normalize(value);
    if (!normalized) return -1;
    const candidates = (options || []).map((option, index) => ({
      index,
      text: normalize(option?.text),
      value: normalize(option?.value)
    })).filter((candidate) => candidate.text);
    const match = candidates.find((candidate) => candidate.text === normalized)
      || candidates.find((candidate) => candidate.value === normalized && candidate.value)
      || candidates.find((candidate) => candidate.text.startsWith(normalized) || normalized.startsWith(candidate.text))
      || candidates.find((candidate) => candidate.text.split(" ").includes(normalized));
    return match?.index ?? -1;
  }

  function looksGenerated(value) {
    const raw = String(value || "").trim();
    if (!raw) return false;
    const normalized = normalize(raw);
    const compact = raw.replace(/[^a-z0-9]/gi, "");
    return /^\d+$/.test(compact)
      || /[a-f0-9]{8,}/i.test(compact)
      || /(?:^|[_-])(?:field|input|control|element)?[_-]?\d{3,}(?:$|[_-])/i.test(raw)
      || (/\d{4,}/.test(compact) && normalized.split(" ").length <= 2);
  }

  function contextText(entry) {
    return [entry?.group, entry?.section, entry?.form, ...(entry?.tableHeaders || [])].filter(Boolean).join(" ");
  }

  function nameText(entry) {
    return entry?.userLabel || entry?.accessibleName || entry?.label || "";
  }

  function withoutConfirmation(value) {
    return normalize(value).replace(/^(?:confirm|confirmation|re enter|retype|repeat|verify)\s+/, "");
  }

  function semanticText(entry) {
    return normalize([
      nameText(entry), entry?.label, entry?.name, entry?.id, entry?.autocomplete,
      entry?.placeholder, entry?.group, entry?.section
    ].filter(Boolean).join(" "));
  }

  function addressFieldPart(entry) {
    const autocomplete = String(entry?.autocomplete || "").toLowerCase().split(/\s+/);
    if (autocomplete.includes("tel-country-code")) return "";
    for (const token of autocomplete.reverse()) {
      if (token === "address-line1") return "addressLine1";
      if (token === "address-line2") return "addressLine2";
      if (token === "street-address") return "streetAddress";
      if (token === "address-level2") return "locality";
      if (token === "address-level1") return "administrativeArea";
      if (token === "postal-code") return "postalCode";
      if (token === "country" || token === "country-name") return "country";
    }

    const text = semanticText(entry);
    const names = [entry?.userLabel, entry?.accessibleName, entry?.label, entry?.placeholder].map(normalize).filter(Boolean);
    const machineNames = [entry?.name, entry?.id].filter((value) => value && !looksGenerated(value)).map(normalize);
    // The last segment of a name like "Form$_mailingAddress$_city" says what the field is.
    const machineTails = [entry?.name, entry?.id]
      .filter((value) => value && !looksGenerated(value))
      .map((value) => normalize(String(value).split(/[$.:[\]]|<>|__/).filter((part) => part.replace(/_/g, "")).pop()))
      .filter(Boolean);
    const hasExactName = (...values) => names.some((name) => values.includes(name));
    const hasExactTail = (...values) => !names.length && machineTails.some((tail) => values.includes(tail));
    // A label outranks the machine name; the name speaks only for unlabeled fields.
    const ownText = names.length ? names.join(" ") : machineTails.join(" ");
    const ownNames = names.join(" ");
    const hasLine2Name = names.some((name) => /^(?:address line 2|address ?2|street ?2|(?:apartment|apt|suite|unit|building)(?: (?:apartment|apt|suite|unit|building|or|number|no|optional|etc))*)$/.test(name))
      || /(?:^| )(?:(?:street )?address (?:line )?(?:2|two)|street (?:address )?(?:line )?2|second address line)(?: |$)/.test(ownNames);
    // Machine names often prefix the part ("BillingAddress2", "addrLine2",
    // "address[street2]"), but only count when the label doesn't say otherwise:
    // sites reuse "address2" for a Company field or a second email.
    const labelAllowsLine = !ownNames || /(?:^| )(?:address|addr|street|line|apt|apartment|suite|unit|building|floor)\d?(?: |$)/.test(ownNames);
    const hasLine2MachineName = labelAllowsLine && machineTails.some((name) => /(?:^| |[a-z])(?:address ?(?:line ?)?2|addr ?line ?2|street ?(?:line ?)?2|line ?two)$/.test(name));
    const hasLaterLineName = /(?:^| )(?:address line [3-9]|address [3-9]|street (?:address )?(?:line )?[3-9]|third address line)(?: |$)/.test(ownNames)
      || (labelAllowsLine && machineTails.some((name) => /(?:^| |[a-z])(?:address ?(?:line ?)?[3-9]|addr ?line ?[3-9]|street ?(?:line ?)?[3-9]|line ?three)$/.test(name)));
    if (/(?:^| )(?:email|e mail|ip|internet|web|website) address/.test(text)) return "";
    if (hasLaterLineName) return "addressLine3";
    if (hasLine2Name || hasLine2MachineName) return "addressLine2";
    // The field's own words only: a "Mailing address" heading covers city and ZIP too.
    if (/(?:^| )(?:address line 1|address ?1|street address|mailing address)(?: |$)/.test(ownText)) return "addressLine1";
    // A field labeled only "Address" is the street line, or the whole street in a text area.
    if (hasExactName("address", "street", "home address", "street line", "shipping address", "billing address") || hasExactTail("address", "street")) return entry?.kind === "textarea" ? "streetAddress" : "addressLine1";
    // "City / State / Zip" over a row of boxes names the city box first.
    if (/^(?:city|town)(?: |$)/.test(ownNames) && /(?:^| )(?:state|province|zip|postal code)(?: |$)/.test(ownNames)) return "locality";
    // The four-digit ZIP+4 box, which Umete has no value for.
    if (/(?:^| )(?:zip|zip code|zipcode|postal code)\d?(?: |$)|zipcode/.test(`${ownNames} ${machineNames.join(" ")}`)
        && /(?:^| )(?:ext|extn|extension|suffix|plus 4|4)(?: |$)|zip4|zipcode ext/.test(`${ownNames} ${machineNames.join(" ")}`)) return "postalCodeSuffix";
    if (/(?:^| )(?:postal code|postcode|post code|zip|zip code)(?: |$)/.test(text)) return "postalCode";
    if (hasExactName("city", "town", "locality") || hasExactTail("city", "town") || /(?:^| )(?:address city|shipping city|billing city)(?: |$)/.test(text)) return "locality";
    if (hasExactName("state", "province", "prefecture", "region", "state province", "province state", "state region") || hasExactTail("state", "province") || /(?:^| )(?:address|shipping|billing) (?:state|province|prefecture|region)(?: |$)/.test(text)) return "administrativeArea";
    if (hasExactName("country", "country region") || hasExactTail("country")
        || /(?:^| )(?:address|shipping|billing) country(?: |$)/.test(text)
        || /(?:^| )(?:country|region) of residence|residence (?:country|region)(?: |$)/.test(text)) {
      return "country";
    }
    return "";
  }

  function nameFieldPart(entry) {
    // Set by the page reader when the label alone doesn't tell ("Name" before "Surname").
    if (["given", "family", "middle", "full"].includes(entry?.namePart)) return entry.namePart;
    const autocomplete = String(entry?.autocomplete || "").toLowerCase().split(/\s+/);
    if (autocomplete.includes("username") || autocomplete.includes("nickname") || autocomplete.includes("organization")) return "";
    if (autocomplete.includes("given-name")) return "given";
    if (autocomplete.includes("family-name")) return "family";
    if (autocomplete.includes("additional-name")) return "middle";
    if (autocomplete.includes("cc-name") || autocomplete.includes("name")) return "full";

    const labels = [entry?.userLabel, entry?.accessibleName, entry?.label, entry?.placeholder].map(normalize).filter(Boolean);
    // Each label is read on its own: joined, "Name (first and last)" twice
    // would read "…first and last name first…".
    const anyLabel = (re) => labels.some((label) => re.test(label));
    if (anyLabel(/(?:^| )(?:user ?name|login|company|business|organization|file|display|middle)(?: |$)/)) return "";
    if (anyLabel(/(?:^| )first (?:and|&) last(?: |$)/)) return "full";
    if (anyLabel(/(?:^| )(?:first name|given name|forename)(?: |$)/) || labels.some((label) => label === "first" || label === "given")) return "given";
    if (anyLabel(/(?:^| )(?:last name|family name|surname)(?: |$)/) || labels.some((label) => label === "last" || label === "family" || label === "surname")) return "family";
    if (anyLabel(/(?:^| )(?:full name|complete name|legal name|passenger name|traveler name|cardholder name|name on card)(?: |$)/)) return "full";
    if (labels.some((label) => label === "name" || label === "your name")) {
      // Sites label a first-name box just "Name" and say so in its name ("dnrfirst").
      const machine = [entry?.name, entry?.id].filter((value) => value && !looksGenerated(value)).join(" ").toLowerCase();
      if (/first|given|fname|forename/.test(machine)) return "given";
      if (/last|surname|family|lname/.test(machine)) return "family";
      return "full";
    }
    return "";
  }

  function namePartValue(entry) {
    return typeof entry?.value === "string" ? entry.value.trim() : "";
  }

  function pickNamePart(savedEntries, field, part) {
    const candidates = (savedEntries || []).filter((entry) => nameFieldPart(entry) === part && namePartValue(entry));
    if (candidates.length === 1) return candidates[0];
    if (!candidates.length) return null;
    const fieldContext = contextText(field);
    let best = null;
    let bestScore = -1;
    let tied = false;
    for (const candidate of candidates) {
      const candidateScore = overlap(contextText(candidate), fieldContext) * 40 + overlap(nameText(candidate), nameText(field));
      if (candidateScore > bestScore) {
        best = candidate;
        bestScore = candidateScore;
        tied = false;
      } else if (candidateScore === bestScore) {
        tied = true;
      }
    }
    return tied ? null : best;
  }

  function familyNameFirst(given, family) {
    if (/[\u3000-\u9fff]/.test(`${given}${family}`)) return true;
    const language = typeof navigator !== "undefined" ? String(navigator.language || "").toLowerCase() : "";
    return /^(?:ja|zh|ko)(?:-|_|$)/.test(language);
  }

  function composedFullName(savedEntries, field) {
    const given = pickNamePart(savedEntries, field, "given");
    const family = pickNamePart(savedEntries, field, "family");
    const givenValue = namePartValue(given);
    const familyValue = namePartValue(family);
    if (!givenValue || !familyValue) return null;
    const middle = namePartValue(pickNamePart(savedEntries, field, "middle"));
    const parts = familyNameFirst(givenValue, familyValue)
      ? [familyValue, givenValue]
      : [givenValue, middle, familyValue].filter(Boolean);
    return {
      accessibleName: "Full name",
      kind: field?.kind || "text",
      inputType: field?.inputType || "text",
      value: parts.join(" ")
    };
  }

  function addressValue(saved, field) {
    const address = saved?.value;
    if (!address || typeof address !== "object" || Array.isArray(address)) return "";
    const part = typeof field === "string" ? field : addressFieldPart(field);
    if (part === "streetAddress") return [address.addressLine1, address.addressLine2].filter(Boolean).join("\n");
    if (part === "country") return address.countryName || address.countryCode || "";
    return typeof address[part] === "string" ? address[part] : "";
  }

  // Contacts are aggregate answers (doctors, emergency contacts) whose parts fill
  // fields that name the contact: "Cardiologist phone", "Emergency contact name".
  const CONTACT_PARTS = ["name", "role", "phone", "fax", "email", "organization", "address"];
  const DOCTOR_WORDS = "physicians?|doctors?|pcp|primary care|family (?:doctor|physician|medicine|practice)|general practitioner|gp|specialists?|cardiologist|dentist|orthodontist|p(?:a)?ediatrician|referring (?:provider|physician|doctor)|surgeon|psychiatrist|psychologist|therapist|ophthalmologist|optometrist|dermatologist|neurologist|oncologist|obstetrician|gynecologist|ob ?gyn|endocrinologist|orthop(?:a)?edi(?:st|c)|urologist|allergist|rheumatologist|gastroenterologist|pulmonologist|nephrologist|hematologist|podiatrist|chiropractor|internist|nurse practitioner|(?:health ?care|medical|care) provider";
  const EMERGENCY_WORDS = "emergency contacts?|next of kin|in case of emergency|ice contact|emergency person|emergency notification";
  const DOCTOR_OWN_RE = new RegExp(`(?:^| )(?:${DOCTOR_WORDS}|dr)(?= |$)`);
  const DOCTOR_CONTEXT_RE = new RegExp(`(?:^| )(?:${DOCTOR_WORDS})(?= |$)`);
  const EMERGENCY_OWN_RE = new RegExp(`(?:^| )(?:${EMERGENCY_WORDS}|emergency)(?= |$)`);
  const EMERGENCY_CONTEXT_RE = new RegExp(`(?:^| )(?:${EMERGENCY_WORDS})(?= |$)`);
  const CONTACT_SELF_RE = /(?:^| )(?:your|you|my|me|self|own|patient s?|applicant s?|member s?)(?= |$)/;
  const CONTACT_EXCLUDED_RE = /(?:^| )(?:license|licence|npi|dea|id|identifier|password|insurance|insurer|policy|plan|visits?|dates?|dob|birth|appointments?|how many|number of|reasons?|notes?|comments?|history|conditions?|medications?|allerg(?:y|ies)|room|diagnosis|referral date)(?= |$)/;
  const CONTACT_NAME_QUALIFIERS = new Set([
    "primary", "secondary", "alternate", "alternative", "first", "second", "1", "2", "3", "current", "your",
    "patient", "patients", "s", "information", "info", "details", "contact", "person", "who", "is", "main",
    "regular", "preferred", "treating", "attending", "name", "full", "complete"
  ]);
  const SPECIALTIES = [
    ["primary care", "pcp", "family doctor", "family physician", "family medicine", "family practice", "general practitioner", "gp", "general practice", "general physician", "internist", "internal medicine", "primary physician", "primary doctor", "primary provider", "regular doctor", "main doctor"],
    ["cardiologist", "cardiology", "heart doctor"],
    ["dentist", "dental", "dentistry", "orthodontist", "orthodontics"],
    ["dermatologist", "dermatology"],
    ["ophthalmologist", "ophthalmology", "eye doctor", "optometrist", "optometry"],
    ["ob gyn", "obgyn", "obstetrician", "gynecologist", "gynecology", "obstetrics"],
    ["pediatrician", "paediatrician", "pediatrics", "paediatrics"],
    ["psychiatrist", "psychiatry"],
    ["psychologist", "psychology", "therapist", "counselor", "counsellor", "mental health"],
    ["neurologist", "neurology"],
    ["oncologist", "oncology"],
    ["endocrinologist", "endocrinology"],
    ["orthopedist", "orthopaedist", "orthopedic", "orthopaedic", "orthopedics", "orthopaedics"],
    ["urologist", "urology"],
    ["allergist", "allergy", "immunologist"],
    ["rheumatologist", "rheumatology"],
    ["gastroenterologist", "gastroenterology"],
    ["pulmonologist", "pulmonology"],
    ["nephrologist", "nephrology"],
    ["hematologist", "hematology"],
    ["podiatrist", "podiatry"],
    ["chiropractor", "chiropractic"],
    ["surgeon", "surgery", "surgical"]
  ];

  function specialtyIndex(text) {
    const padded = ` ${normalize(text)} `;
    return SPECIALTIES.findIndex((group) => group.some((term) => padded.includes(` ${term} `)));
  }

  function contactOwnText(entry) {
    const machine = [entry?.name, entry?.id].filter((value) => value && !looksGenerated(value));
    return normalize([entry?.userLabel, entry?.accessibleName, entry?.label, ...machine].filter(Boolean).join(" "));
  }

  function stripMatches(text, re) {
    let result = ` ${text} `;
    const global = new RegExp(re.source, "g");
    let previous;
    do {
      previous = result;
      result = result.replace(global, " ");
    } while (result !== previous);
    return result.trim();
  }

  function contactPartIn(text, category, fromContext) {
    const padded = ` ${text} `;
    if (/ fax /.test(padded)) return "fax";
    if (/ e ?mail /.test(padded)) return "email";
    if (/ (?:phone|telephone|tel|mobile|cell|number) /.test(padded)) return "phone";
    if (/ (?:relationship|relation|relation to|relationship to) /.test(padded)) return "role";
    if (/ (?:specialty|speciality|specialization|specialisation|type of (?:doctor|physician|provider|practice)) /.test(padded)) return "role";
    if (/ (?:address|street|location) /.test(padded)) return "address";
    if (/ (?:practice|clinic|office|hospital|facility|group|organization|organisation|employer|company|workplace) /.test(padded)) return "organization";
    if (/ (?:first|given) name /.test(padded)) return "givenName";
    if (/ (?:last|family) name | surname /.test(padded)) return "familyName";
    if (/ name /.test(padded)) return "name";
    if (fromContext) return "";
    const leftover = stripMatches(text, category === "doctor" ? DOCTOR_OWN_RE : EMERGENCY_OWN_RE).split(/\s+/).filter(Boolean);
    return leftover.every((token) => CONTACT_NAME_QUALIFIERS.has(token) || specialtyIndex(token) >= 0) ? "name" : "";
  }

  function contactOrdinal(text) {
    const padded = ` ${text} `;
    if (/ (?:third|3|3rd) /.test(padded)) return 2;
    if (/ (?:secondary|alternate|alternative|second|2|2nd|backup|additional|other|another|specialists?) /.test(padded)) return 1;
    if (/ (?:primary|first|1|1st|main) /.test(padded)) return 0;
    return -1;
  }

  function contactFieldInfo(entry) {
    if (!entry || typeof entry !== "object") return null;
    const own = contactOwnText(entry);
    if (!own) return null;
    const padded = ` ${own} `;
    if (CONTACT_EXCLUDED_RE.test(padded) && !/ (?:phone|fax|contact) number /.test(padded)) return null;
    let category = EMERGENCY_OWN_RE.test(padded) ? "emergencyContact" : DOCTOR_OWN_RE.test(padded) ? "doctor" : "";
    let fromContext = false;
    if (!category) {
      if (CONTACT_SELF_RE.test(padded)) return null;
      const context = normalize(contextText(entry));
      category = EMERGENCY_CONTEXT_RE.test(context) ? "emergencyContact" : DOCTOR_CONTEXT_RE.test(context) ? "doctor" : "";
      fromContext = true;
    }
    if (!category) return null;
    const part = contactPartIn(own, category, fromContext);
    if (!part) return null;
    const text = normalize(`${own} ${contextText(entry)}`);
    const specialty = category === "doctor" ? specialtyIndex(text) : -1;
    const ordinalText = category === "doctor" ? stripMatches(text, /(?:^| )primary (?:care|physician|doctor|provider)(?= |$)/) : text;
    return { category, part, specialty, ordinal: contactOrdinal(ordinalText), text };
  }

  function contactObject(saved) {
    const contact = saved?.value;
    return contact && typeof contact === "object" && !Array.isArray(contact) ? contact : null;
  }

  function contactCategory(saved) {
    return typeof contactObject(saved)?.category === "string" ? contactObject(saved).category : "";
  }

  function contactRole(saved) {
    return typeof contactObject(saved)?.role === "string" ? contactObject(saved).role : "";
  }

  function contactValue(saved, field) {
    const contact = contactObject(saved);
    if (!contact) return "";
    const part = typeof field === "string" ? field : contactFieldInfo(field)?.part;
    if (!part) return "";
    if (part === "givenName" || part === "familyName") {
      const words = String(contact.name || "").trim()
        .replace(/^(?:dr|doctor|mr|mrs|ms|miss|mx|prof)\.?\s+/i, "")
        .replace(/,.*$/, "")
        .split(/\s+/).filter(Boolean);
      if (words.length < 2) return part === "familyName" ? (words[0] || "") : "";
      return part === "givenName" ? words.slice(0, -1).join(" ") : words[words.length - 1];
    }
    return typeof contact[part] === "string" ? contact[part].trim() : "";
  }

  function pickContact(contacts, info) {
    const withPart = (list) => list.filter((entry) => contactValue(entry, info.part));
    const roleMatches = withPart(contacts.filter((entry) => contactRole(entry) && overlap(contactRole(entry), info.text) > 0));
    if (info.category === "doctor") {
      if (info.specialty >= 0) return withPart(contacts.filter((entry) => specialtyIndex(contactRole(entry)) === info.specialty))[0] || null;
      if (roleMatches.length === 1) return roleMatches[0];
      const primary = contacts.filter((entry) => specialtyIndex(contactRole(entry)) === 0);
      if (info.ordinal >= 1) return withPart(contacts.filter((entry) => specialtyIndex(contactRole(entry)) !== 0))[info.ordinal - 1] || null;
      if (primary.length === 1 && contactValue(primary[0], info.part)) return primary[0];
      const available = withPart(contacts);
      return available.length === 1 ? available[0] : null;
    }
    if (roleMatches.length === 1) return roleMatches[0];
    if (info.ordinal >= 0) return contacts[info.ordinal] && contactValue(contacts[info.ordinal], info.part) ? contacts[info.ordinal] : null;
    return withPart(contacts)[0] || null;
  }

  // The AI sees a contact by its category, role, and number only, never its label,
  // which defaults to the person's name. `number` tells apart two contacts of the
  // same category ("Doctor 2"); pass it only when there is more than one.
  function contactParts(saved, number) {
    const category = contactCategory(saved);
    const heading = `${category === "doctor" ? "Doctor" : "Emergency contact"}${number ? ` ${number}` : ""}`;
    const base = [heading, contactRole(saved)].filter(Boolean).join(", ");
    return CONTACT_PARTS.filter((part) => contactValue(saved, part)).map((part) => {
      const title = part === "role" ? (category === "doctor" ? "specialty" : "relationship") : part;
      const name = `${base} ${title}`;
      return {
        part,
        entry: {
          accessibleName: name,
          label: name,
          kind: "text",
          inputType: part === "phone" || part === "fax" ? "tel" : part === "email" ? "email" : "text",
          value: contactValue(saved, part)
        }
      };
    });
  }

  // A passport is an aggregate answer: its number, issuing country, nationality,
  // and issue and expiration dates ("yyyy-mm-dd") each fill their own field.
  const PASSPORT_CONTEXT_RE = /(?:^| )(?:passports?|international documents?|travel documents?)(?: |$)/;
  const EXPIRATION_RE = /(?:^| )(?:expir(?:y|ation|es?|ing)?|exp|valid (?:to|until|thru|through))(?: |$)/;
  const ISSUE_RE = /(?:^| )(?:issue|issued|issuance|issuing)(?: |$)/;
  const BIRTH_RE = /(?:^| )(?:birth ?day|birth ?date|date of birth|d o b|dob)(?: |$)/;

  function passportFieldPart(entry) {
    if (!entry || typeof entry !== "object" || entry.kind === "checkbox" || entry.kind === "radio") return "";
    const machine = [entry.name, entry.id].filter((value) => value && !looksGenerated(value));
    const names = [entry.userLabel, entry.accessibleName, entry.label, entry.placeholder].map(withoutConfirmation).filter(Boolean);
    const own = names.length ? names.join(" ") : withoutConfirmation(machine.join(" "));
    // Not the form's title: a "Passport application" form has a home address too.
    const context = normalize([entry.group, entry.section, ...(entry.tableHeaders || [])].filter(Boolean).join(" "));
    const ownPassport = PASSPORT_CONTEXT_RE.test(own) || /(?:^| )passport/.test(normalize(machine.join(" ")));
    const inPassport = ownPassport || PASSPORT_CONTEXT_RE.test(context);
    if (!inPassport) {
      // Nationality is the same anywhere; everything else needs a passport nearby.
      return /(?:^| )(?:nationality|citizenship|country of citizenship|citizen of)(?: |$)/.test(own) ? "nationality" : "";
    }
    if (/(?:^| )(?:nationality|citizenship|citizen of)(?: |$)/.test(own)) return "nationality";
    if (/(?:^| )(?:issuing (?:country|state|nation)|country (?:of issue|of issuance|issued|issuing)|issued (?:by|in)(?: country)?|passport country|country of passport)(?: |$)/.test(own)
        || (!ownPassport && /^(?:country|country region|country of issue)$/.test(own))) return "issuingCountry";
    // A document date reads as one from its own words or the label over its run
    // ("Expiration date" above "month", "day", "year"). A birth date never does;
    // American's "day of birth month" is a day, whatever date it's under.
    const dateText = normalize(`${own} ${entry.group || ""}`);
    const isDate = semanticCategory(entry) === "document-date" || /(?:^| )(?:date|month|day|year|mm|dd|yyyy|yy)(?: |$)/.test(dateText);
    if (isDate) {
      if (BIRTH_RE.test(own.replace(/(?:^| )day of birth month(?= |$)/, " "))) return "";
      if (EXPIRATION_RE.test(dateText)) return "expirationDate";
      if (ISSUE_RE.test(dateText)) return "issueDate";
      return "";
    }
    if (entry.kind === "select") return "";
    if (/(?:^| )(?:passport (?:number|no|num|nr|#)|passport|document (?:number|no)|number|no)(?: |$)/.test(own)
        && !/(?:^| )(?:phone|telephone|mobile|fax|frequent|loyalty|member|redress|known traveler|ktn|visa|card|license|licence)(?: |$)/.test(own)) return "number";
    return "";
  }

  function passportObject(saved) {
    const passport = saved?.value;
    return passport && typeof passport === "object" && !Array.isArray(passport) ? passport : null;
  }

  function passportValue(saved, field) {
    const passport = passportObject(saved);
    if (!passport) return "";
    const part = typeof field === "string" ? field : passportFieldPart(field);
    const text = (key) => typeof passport[key] === "string" ? passport[key].trim() : "";
    if (part === "issuingCountry") return text("issuingCountryName") || text("issuingCountryCode");
    if (part === "nationality") return text("nationalityName") || text("nationalityCode");
    if (["number", "issueDate", "expirationDate"].includes(part)) return text(part);
    return "";
  }

  // The country code and name for a passport's country part, for menus that
  // list either.
  function passportCountry(saved, part) {
    const passport = passportObject(saved);
    if (!passport) return null;
    const prefix = part === "issuingCountry" ? "issuingCountry" : part === "nationality" ? "nationality" : "";
    if (!prefix) return null;
    const code = typeof passport[`${prefix}Code`] === "string" ? passport[`${prefix}Code`].trim() : "";
    const name = typeof passport[`${prefix}Name`] === "string" ? passport[`${prefix}Name`].trim() : "";
    return code || name ? { code, name } : null;
  }

  // "Owner of Phone", "Phone holder", "Name of phone owner": these ask for a
  // person, not a number. Only the field's own label is checked, because the
  // surrounding group (often "Phone No.") would otherwise look like a number.
  function isPhoneOwnerField(entry) {
    const own = ` ${normalize([nameText(entry), entry?.label, entry?.placeholder].filter(Boolean).join(" "))} `;
    if (!/ (?:phone|telephone|tel|mobile|cell) /.test(own)) return false;
    if (!/ (?:owner|holder|subscriber|user|name|owner s) /.test(own)) return false;
    return !/ (?:number|no|num|nr|#|digits) /.test(own);
  }

  function semanticCategory(entry) {
    const text = semanticText(entry);
    if (addressFieldPart(entry)) return "address";
    // Only the field's own name counts here: a "Contact phone and email" heading
    // shouldn't make every field under it an email field.
    const own = normalize([nameText(entry), entry?.label, entry?.name, entry?.id, entry?.autocomplete, entry?.placeholder].filter(Boolean).join(" "));
    if (entry?.inputType === "email" || /(?:^| )(?:email|e mail)(?: |$)/.test(own)) return "email";
    if (/(?:^| )(?:country (?:phone )?code|phone country|calling code|dial code|international code|country dialing)(?: |$)/.test(text)) return "phone";
    if (/(?:^| )(?:ext|extension)(?: |$)/.test(own)) return "phone-extension";
    if (isPhoneOwnerField(entry)) return "phone-owner";
    // Numbered boxes count too ("dayPhone1"), as does an area code box.
    if (/(?:^| )(?:phone|telephone|tel|mobile|cell)\d?(?: |$)|(?:^| )area code(?: |$)/.test(text)) return "phone";
    if (/(?:^| )(?:gender|sex)(?: |$)/.test(text)) return "gender";
    if (/(?:^| )(?:expir(?:y|ation)|expires?|valid (?:to|until)|issue date|issued (?:on|date))(?= |$)/.test(text)) return "document-date";
    if (/(?:^| )(?:birth ?day|birth ?date|date of birth|d o b)(?: |$)/.test(text) || /^bday(?:-(?:month|day|year))?$/.test(entry?.autocomplete || "")) return "date";
    if (/(?:^| )(?:month|mm|day|dd|year|yyyy|yy)(?: |$)/.test(text) && (entry?.inputType === "date" || entry?.inputType === "number" || entry?.kind === "select") && !/(?:^| )(?:documents?|passport|visa)(?: |$)/.test(text)) return "date";
    if (/(?:^| )(?:documents?|doc|frequent flyer|mileage|loyalty|member(?:ship)?|account|redress|known traveler|ktn|pass id|passport|license|identification|traveler number)(?: |$)/.test(text)) return "identifier";
    return "";
  }

  const VALID_TYPES = new Set(["address", "contact", "date", "gender", "passport", "phone"]);
  const FIELD_CATEGORIES = { date: "date", gender: "gender", phone: "phone" };

  function answerType(entry) {
    const explicit = typeof entry?.answerType === "string" ? entry.answerType : "";
    if (VALID_TYPES.has(explicit)) return explicit;
    const detected = semanticCategory(entry);
    return FIELD_CATEGORIES[detected] || "";
  }

  function compatible(saved, field) {
    if (!saved || !field) return false;
    const savedType = answerType(saved);
    const fieldCategory = semanticCategory(field);
    const fieldContact = contactFieldInfo(field);
    if (savedType === "contact") {
      return Boolean(fieldContact) && field.kind !== "checkbox" && fieldContact.category === contactCategory(saved) && Boolean(contactValue(saved, fieldContact.part));
    }
    if ((fieldContact?.category || "") !== (contactFieldInfo(saved)?.category || "")) return false;
    if (savedType === "passport") return Boolean(passportValue(saved, field));
    if (savedType === "address") return fieldCategory === "address" && Boolean(addressValue(saved, field));
    // A remembered street line never fills line 2, and so on.
    const savedPart = addressFieldPart(saved);
    const fieldPart = fieldCategory === "address" ? addressFieldPart(field) : "";
    if (savedPart && fieldPart && !sameAddressPart(savedPart, fieldPart)) return false;
    // A remembered ZIP code only fills a field that asks for one: sharing the word
    // "code" doesn't make a coupon, captcha, or verification code a ZIP code.
    if (savedPart === "postalCode" && !fieldPart) return false;
    // A person's name never goes into a field for a company, business, username,
    // or login: "Company Name" shares "name" with "First name" but isn't one.
    if (["given", "family", "middle", "full"].includes(nameFieldPart(saved))
        && /(?:^| )(?:company|business|organi[sz]ation|user ?name|login|display name|file name)(?: |$)/.test(normalize([nameText(field), field.label, field.placeholder].filter(Boolean).join(" ")))) return false;
    // An email address never goes into a field asking for a street address.
    if (fieldCategory !== "email" && semanticCategory(saved) === "email"
        && /(?:^| )address(?: |$)/.test(normalize([nameText(field), field.label, field.placeholder].filter(Boolean).join(" ")))) return false;
    if (savedType && field.kind === "radio") {
      if (savedType === "gender") {
        const text = normalize([field.accessibleName, field.label, field.group, field.name, field.value].filter(Boolean).join(" "));
        return /(?:^| )(?:female|male|woman|man|non ?binary|gender|sex|mr|mrs|ms|miss|mx)(?: |$)/.test(text);
      }
      return false;
    }
    if (saved.kind !== field.kind) {
      const fieldText = semanticText(field);
      const callingCode = /(?:^| )(?:country (?:phone )?code|phone country|calling code|dial code|international code|country dialing)(?: |$)/.test(fieldText);
      const datePart = /(?:^| )(?:month|mm|day|dd|year|yyyy|yy)(?: |$)/.test(fieldText);
      const crossKind = (savedType === "gender")
        || sameAddressPartInTextOrMenu(saved, field)
        || (savedType === "address" && fieldCategory === "address")
        || (savedType === "date" && (fieldCategory === "date" || datePart))
        || (savedType === "phone" && callingCode);
      if (!crossKind) return false;
    }
    if (savedType) {
      if (fieldCategory === "identifier" || fieldCategory === "document-date") return false;
      if (!fieldCategory) return false;
      return savedType === fieldCategory;
    }
    const savedCategory = semanticCategory(saved);
    return !(savedCategory && fieldCategory && savedCategory !== fieldCategory);
  }

  // The same part of an address fills a menu or a text box alike: a state
  // remembered from a menu ("California") goes into a State text box too.
  function sameAddressPartInTextOrMenu(saved, field) {
    const savedPart = addressFieldPart(saved);
    const fieldPart = semanticCategory(field) === "address" ? addressFieldPart(field) : "";
    return Boolean(savedPart && fieldPart && sameAddressPart(savedPart, fieldPart))
      && [saved.kind, field.kind].every((kind) => kind === "text" || kind === "select");
  }

  function sameAddressPart(left, right) {
    if (left === right) return true;
    const street = new Set(["addressLine1", "streetAddress"]);
    return street.has(left) && street.has(right);
  }

  function score(saved, field) {
    const savedType = answerType(saved);
    if (savedType === "contact" || savedType === "passport" || !compatible(saved, field)) return -Infinity;
    if (saved.inputType && field.inputType && saved.inputType !== field.inputType) {
      const compatibleTextTypes = new Set(["", "email", "search", "tel", "text", "url"]);
      const compatibleTextInput = compatibleTextTypes.has(saved.inputType) && compatibleTextTypes.has(field.inputType);
      if (!savedType && !compatibleTextInput && !sameAddressPartInTextOrMenu(saved, field)) return -Infinity;
    }

    let total = 0;
    if (saved.autocomplete && saved.autocomplete === field.autocomplete) total += 100;
    if (savedType && savedType === semanticCategory(field)) total += 45;
    const savedAddressPart = savedType ? "" : addressFieldPart(saved);
    if (savedAddressPart && savedAddressPart === addressFieldPart(field)) total += 45;
    if (saved.name && !looksGenerated(saved.name) && !looksGenerated(field.name) && normalize(saved.name) === normalize(field.name)) total += 50;
    if (saved.id && !looksGenerated(saved.id) && !looksGenerated(field.id) && normalize(saved.id) === normalize(field.id)) total += 30;
    total += overlap(nameText(saved), nameText(field)) * 70;
    const fieldConfirmationName = withoutConfirmation(nameText(field));
    if (fieldConfirmationName && fieldConfirmationName !== normalize(nameText(field))) {
      total += overlap(nameText(saved), fieldConfirmationName) * 70;
    }
    total += overlap(saved.label, field.label) * 45;
    const fieldConfirmationLabel = withoutConfirmation(field.label);
    if (fieldConfirmationLabel && fieldConfirmationLabel !== normalize(field.label)) {
      total += overlap(saved.label, fieldConfirmationLabel) * 45;
    }
    total += overlap(saved.name, field.name) * (looksGenerated(saved.name) || looksGenerated(field.name) ? 3 : 22);
    total += overlap(saved.placeholder, field.placeholder) * 12;
    total += overlap(saved.accessibleDescription, field.accessibleDescription) * 12;

    const savedContext = contextText(saved);
    const fieldContext = contextText(field);
    const contextOverlap = overlap(savedContext, fieldContext);
    total += contextOverlap * 40;
    if (savedContext && fieldContext && contextOverlap === 0 && overlap(nameText(saved), nameText(field)) >= 0.8) total -= 30;
    return total;
  }

  function scoredBestMatch(savedEntries, field, minimumScore) {
    const threshold = minimumScore == null ? 35 : minimumScore;
    let best = null;
    let bestScore = threshold;
    let tied = false;

    for (const entry of savedEntries || []) {
      const candidateScore = score(entry, field);
      if (candidateScore > bestScore) {
        best = entry;
        bestScore = candidateScore;
        tied = false;
      } else if (candidateScore === bestScore && candidateScore >= threshold) {
        tied = true;
      }
    }

    return tied && answerType(field) !== "date" ? null : best;
  }

  function bestMatch(savedEntries, field, minimumScore) {
    const contactInfo = field?.kind === "checkbox" ? null : contactFieldInfo(field);
    if (contactInfo) {
      const contacts = (savedEntries || []).filter((entry) => answerType(entry) === "contact" && contactCategory(entry) === contactInfo.category);
      if (contacts.length) return pickContact(contacts, contactInfo);
    }

    // A saved passport fills its parts. Nationality alone is asked outside
    // passports too, where an answer remembered for it comes first.
    const passportPart = passportFieldPart(field);
    if (passportPart) {
      const passports = (savedEntries || []).filter((entry) => answerType(entry) === "passport" && passportValue(entry, passportPart));
      if (passports.length) {
        const passport = passports.length === 1 ? passports[0] : null;
        if (passportPart !== "nationality" || PASSPORT_CONTEXT_RE.test(semanticText(field))) return passport;
        return scoredBestMatch(savedEntries, field, minimumScore) || passport;
      }
    }

    const addressPart = addressFieldPart(field);
    if (addressPart) {
      const addresses = (savedEntries || []).filter((entry) => answerType(entry) === "address" && addressValue(entry, addressPart));
      if (addresses.length) return addresses.length === 1 ? addresses[0] : null;
    }

    // A first, middle, or last name box takes that part of the person's name,
    // whatever its label's wording ("Surname" for a saved "Last name").
    const namePart = contactInfo ? "" : nameFieldPart(field);
    if (namePart && namePart !== "full") {
      const part = pickNamePart(savedEntries, field, namePart);
      if (part) return part;
    }

    if (nameFieldPart(field) === "full" && !contactInfo) {
      const explicit = (savedEntries || []).filter((entry) => nameFieldPart(entry) === "full" && namePartValue(entry));
      return scoredBestMatch(explicit, field, minimumScore) || composedFullName(savedEntries, field);
    }

    return scoredBestMatch(savedEntries, field, minimumScore);
  }

  function mergeEntries(existing, incoming) {
    const result = [...(existing || [])];
    for (const next of incoming || []) {
      const index = result.findIndex((saved) => score(saved, next) >= 85);
      if (index >= 0) {
        const existing = result[index];
        result[index] = {
          ...existing,
          ...next,
          ...(existing.answerID ? { answerID: existing.answerID } : {}),
          ...(existing.userLabel ? { userLabel: existing.userLabel } : {})
        };
      } else {
        result.push({ answerID: next.answerID || crypto.randomUUID(), ...next });
      }
    }
    return result;
  }

  return { addressFieldPart, addressValue, answerType, bestMatch, composedFullName, compatible, contactCategory, contactFieldInfo, contactParts, contactValue, looksGenerated, mergeEntries, nameFieldPart, normalize, overlap, passportCountry, passportFieldPart, passportValue, score, selectOptionIndex };
});
