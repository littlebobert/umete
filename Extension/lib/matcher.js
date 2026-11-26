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
    // "City (required)" is a city; "State* State*" (a label read twice) a state.
    const names = [entry?.userLabel, entry?.accessibleName, entry?.label, entry?.placeholder]
      .map((value) => normalize(value).replace(/(?:^| )(?:required|optional)(?= |$)/g, "").replace(/\s+/g, " ").trim().replace(/^(.+) \1$/, "$1"))
      .filter(Boolean);
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
    const hasLine2Name = names.some((name) => /^(?:address line 2|address ?2|street ?2|(?:apartment|apt|suite|unit|building)(?: (?:apartment|apt|suite|unit|building|floor|or|number|no|optional|etc))*)$/.test(name))
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
    if (/(?:^| )(?:address line 1|address ?1|street address|mailing address|(?:house )?number and street|street and (?:house )?number|(?:residential|residence|permanent|current) address|address of residence)(?: |$)/.test(ownText)) return "addressLine1";
    // A field labeled only "Address" is the street line, or the whole street in a text area.
    if (hasExactName("address", "street", "home address", "street line", "shipping address", "billing address") || hasExactTail("address", "street")) return entry?.kind === "textarea" ? "streetAddress" : "addressLine1";
    // "City / State / Zip" over a row of boxes names the city box first.
    if (/^(?:city|town)(?: |$)/.test(ownNames) && /(?:^| )(?:state|province|zip|postal code)(?: |$)/.test(ownNames)) return "locality";
    // The four-digit ZIP+4 box, which Umete has no value for.
    if (/(?:^| )(?:zip|zip code|zipcode|postal code)\d?(?: |$)|zipcode/.test(`${ownNames} ${machineNames.join(" ")}`)
        && /(?:^| )(?:ext|extn|extension|suffix|plus 4|4)(?: |$)|zip4|zipcode ext/.test(`${ownNames} ${machineNames.join(" ")}`)) return "postalCodeSuffix";
    if (/(?:^| )(?:postal code|postcode|post code|zip|zip code)(?: |$)/.test(text)) return "postalCode";
    // "Town / City", "Suburb/City", "City or APO/FPO" (US military mail).
    if (names.some((name) => /^(?:city|town|suburb|locality)(?: (?:or )?(?:city|town|suburb|locality|apo|fpo|dpo))*$/.test(name))
        || hasExactTail("city", "town") || /(?:^| )(?:address city|shipping city|billing city)(?: |$)/.test(text)) return "locality";
    if (names.some((name) => /^(?:state|province|prefecture|region|territory)(?: (?:or )?(?:state|province|prefecture|region|territory))*$/.test(name))
        || hasExactTail("state", "province") || /(?:^| )(?:address|shipping|billing) (?:state|province|prefecture|region)(?: |$)/.test(text)) return "administrativeArea";
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

  // An address, contact, or passport keeps its parts in an object. A field read
  // from a page holds one string, so merging it in would replace the whole
  // answer with that string (and the app then refuses to save it).
  function isStructured(entry) {
    return Boolean(entry?.value) && typeof entry.value === "object" && !Array.isArray(entry.value);
  }

  // Fields that are plainly different things, however alike their labels and
  // surroundings: "First name" and "Last name" in one "Your details" box.
  function differentFields(saved, next) {
    const savedName = nameFieldPart(saved);
    const nextName = nameFieldPart(next);
    if (savedName && nextName && savedName !== nextName) return true;
    const savedTokens = String(saved?.autocomplete || "").toLowerCase().trim();
    const nextTokens = String(next?.autocomplete || "").toLowerCase().trim();
    return Boolean(savedTokens && nextTokens && savedTokens !== nextTokens);
  }

  // Merges a page's fields into the saved answers. A field updates the saved
  // answer it matches best; each saved answer takes at most one field, and
  // fields from the same page never merge with each other (they're different
  // fields, even when "First name" and "Last name" look alike).
  function mergeEntries(existing, incoming) {
    const result = [...(existing || [])];
    const pairs = [];
    (incoming || []).forEach((next, nextIndex) => {
      if (isStructured(next)) return;
      result.forEach((saved, savedIndex) => {
        if (isStructured(saved) || differentFields(saved, next)) return;
        const pairScore = score(saved, next);
        if (pairScore >= 85) pairs.push({ nextIndex, savedIndex, pairScore });
      });
    });
    pairs.sort((left, right) => right.pairScore - left.pairScore || left.nextIndex - right.nextIndex);
    const targetOf = new Map();
    const taken = new Set();
    for (const { nextIndex, savedIndex } of pairs) {
      if (targetOf.has(nextIndex) || taken.has(savedIndex)) continue;
      targetOf.set(nextIndex, savedIndex);
      taken.add(savedIndex);
    }
    (incoming || []).forEach((next, nextIndex) => {
      if (targetOf.has(nextIndex)) {
        const savedIndex = targetOf.get(nextIndex);
        const existing = result[savedIndex];
        result[savedIndex] = {
          ...existing,
          ...next,
          ...(existing.answerID ? { answerID: existing.answerID } : {}),
          ...(existing.userLabel ? { userLabel: existing.userLabel } : {})
        };
      } else {
        result.push({ answerID: next.answerID || crypto.randomUUID(), ...next });
      }
    });
    return result;
  }

  // --- Remember my answers: a page's address and passport fields become (or
  // update) one structured answer each, instead of a loose answer per field.

  // The app's limits (Stores.swift); a longer part is left out rather than
  // making the whole save fail.
  const ADDRESS_LIMITS = { addressLine1: 240, addressLine2: 240, locality: 120, administrativeArea: 120, postalCode: 32, countryName: 120 };
  const PASSPORT_LIMITS = { number: 32, issuingCountryName: 120, nationalityName: 120 };
  const COUNTRY_ALIASES = {
    "usa": "US", "u s a": "US", "united states of america": "US", "us": "US", "america": "US",
    "uk": "GB", "u k": "GB", "great britain": "GB", "britain": "GB", "england": "GB",
    "south korea": "KR", "korea republic of": "KR", "republic of korea": "KR", "korea south": "KR",
    "viet nam": "VN", "russian federation": "RU", "czech republic": "CZ", "holland": "NL"
  };

  function userLanguage() {
    return typeof navigator !== "undefined" && navigator.language ? navigator.language : "en";
  }

  let regionIndex = null;

  // Every region code, and its English and local names, built once.
  function regions() {
    if (regionIndex) return regionIndex;
    const codes = new Set();
    const byName = new Map(Object.entries(COUNTRY_ALIASES));
    let displays = [];
    try {
      // The app's languages, and the person's own.
      displays = [...new Set(["en", "ja", "ko", userLanguage()])].map((language) => new Intl.DisplayNames([language], { type: "region", fallback: "none" }));
    } catch (_error) {
      displays = [];
    }
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (const first of letters) {
      for (const second of letters) {
        const code = first + second;
        if (code === "ZZ") continue;
        for (const display of displays) {
          let name;
          try { name = display.of(code); } catch (_error) { name = undefined; }
          if (!name || name === code) continue;
          codes.add(code);
          // Names in other scripts ("日本") normalize to nothing; they're kept as written.
          const key = normalize(name) || name.trim().toLowerCase();
          if (!byName.has(key)) byName.set(key, code);
        }
      }
    }
    regionIndex = { codes, byName };
    return regionIndex;
  }

  function regionName(code) {
    try {
      return new Intl.DisplayNames([userLanguage()], { type: "region", fallback: "none" }).of(code) || code;
    } catch (_error) {
      return code;
    }
  }

  // A country from a menu's option value ("JP"), or its text ("Japan",
  // "Japan +81", "United States of America"). Nationalities written as
  // demonyms ("Japanese") aren't recognized and are left out.
  function countryFromField(entry) {
    const { codes, byName } = regions();
    for (const raw of [entry?.optionValue, entry?.value]) {
      const text = String(raw ?? "").trim();
      if (/^[A-Za-z]{2}$/.test(text) && codes.has(text.toUpperCase())) return text.toUpperCase();
    }
    const name = normalize(entry?.value);
    const written = String(entry?.value ?? "").trim().toLowerCase();
    const candidates = name
      ? [name, name.replace(/ \d{1,4}$/, ""), name.replace(/ [a-z]{2,3}$/, "")]
      : [written, written.replace(/\s*[(（]?\+?\d{1,4}[)）]?$/, "")];
    for (const candidate of candidates) {
      if (candidate && byName.has(candidate)) return byName.get(candidate);
    }
    return "";
  }

  function twoDigitYear(year) {
    return year.length === 2 ? `20${year}` : year;
  }

  // "yyyy-mm-dd" from year, month, and day, if they make a real date.
  function isoDate(year, month, day) {
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return "";
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCMonth() !== m - 1) return "";
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  const MONTH_WORDS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

  function monthNumber(text) {
    const normalized = normalize(text);
    const digits = normalized.match(/^0?(\d{1,2})(?: |$)/) || normalized.match(/(?:^| )(\d{1,2})(?: |$)/);
    if (digits) return digits[1];
    const index = MONTH_WORDS.findIndex((word) => normalized.split(" ").some((token) => token.startsWith(word)));
    return index >= 0 ? String(index + 1) : "";
  }

  // A whole date typed in one box. Day and month written as two numbers of 12
  // or less could be either way round, so that date is left out.
  function wholeDate(text) {
    const value = String(text ?? "").trim();
    let match = value.match(/^(\d{4})\D(\d{1,2})\D(\d{1,2})$/);
    if (match) return isoDate(match[1], match[2], match[3]);
    match = value.match(/^(\d{1,2})\D(\d{1,2})\D(\d{2}|\d{4})$/);
    if (match) {
      const [first, second] = [Number(match[1]), Number(match[2])];
      const year = twoDigitYear(match[3]);
      if (first > 12 && second <= 12) return isoDate(year, second, first);
      if (second > 12 && first <= 12) return isoDate(year, first, second);
      return first === second ? isoDate(year, first, second) : "";
    }
    match = normalize(value).match(/^(?:(\d{1,2}) ([a-z]+)|([a-z]+) (\d{1,2})) (\d{4})$/);
    if (match) {
      const month = monthNumber(match[2] || match[3]);
      return month && !/^\d/.test(match[2] || match[3]) ? isoDate(match[5], month, match[1] || match[4]) : "";
    }
    return "";
  }

  function fitsLimit(value, limit) {
    return value && (!limit || value.length <= limit);
  }

  // Collects one part's values; two different values make the part unknown
  // (billing and shipping addresses that differ, two travelers' passports).
  function partCollector() {
    const values = {};
    const conflicts = new Set();
    return {
      add(part, value) {
        if (!value) return;
        if (values[part] !== undefined && normalize(values[part]) !== normalize(value)) conflicts.add(part);
        else if (values[part] === undefined) values[part] = value;
      },
      result() {
        const clean = {};
        for (const [part, value] of Object.entries(values)) if (!conflicts.has(part)) clean[part] = value;
        return { values: clean, conflicts };
      }
    };
  }

  function isLooseField(entry) {
    return entry && !isStructured(entry) && typeof entry.value === "string" && entry.kind !== "checkbox" && entry.kind !== "radio"
      && !contactFieldInfo(entry);
  }

  function addressFromFields(incoming) {
    const parts = partCollector();
    const fields = [];
    for (const entry of incoming || []) {
      if (!isLooseField(entry)) continue;
      const part = addressFieldPart(entry);
      if (!part || part === "postalCodeSuffix") continue;
      const value = entry.value.trim();
      if (!value) continue;
      fields.push(entry);
      if (part === "country") {
        const code = countryFromField(entry);
        if (code) parts.add("countryCode", code);
      } else if (part === "streetAddress") {
        const [line1, ...rest] = value.split(/\n+/).map((line) => line.trim()).filter(Boolean);
        parts.add("addressLine1", line1);
        if (rest.length) parts.add("addressLine2", rest.join(", "));
      } else if (part === "addressLine3") {
        parts.add("addressLine3", value);
      } else {
        parts.add(part, value);
      }
    }
    const { values, conflicts } = parts.result();
    // Two different street lines are two addresses; which is the person's?
    if (conflicts.has("addressLine1") || !fields.length) return null;
    if (values.addressLine3) {
      values.addressLine2 = [values.addressLine2, values.addressLine3].filter(Boolean).join(", ");
      delete values.addressLine3;
    }
    const address = {};
    for (const [part, value] of Object.entries(values)) {
      if (part === "countryCode" || fitsLimit(value, ADDRESS_LIMITS[part])) address[part] = value;
    }
    if (address.countryCode) address.countryName = regionName(address.countryCode);
    return Object.keys(address).length ? { value: address, fields } : null;
  }

  function passportFromFields(incoming) {
    const parts = partCollector();
    const dateParts = { issueDate: partCollector(), expirationDate: partCollector() };
    const fields = [];
    for (const entry of incoming || []) {
      if (!isLooseField(entry)) continue;
      const part = passportFieldPart(entry);
      if (!part) continue;
      const value = entry.value.trim();
      if (!value) continue;
      fields.push(entry);
      if (part === "number") {
        parts.add("number", value.replace(/\s+/g, ""));
      } else if (part === "issuingCountry" || part === "nationality") {
        const code = countryFromField(entry);
        if (code) parts.add(`${part}Code`, code);
      } else if (["month", "day", "year"].includes(entry.datePart)) {
        const text = entry.datePart === "month" ? monthNumber(value) : (value.match(/\d+/) || [""])[0];
        dateParts[part].add(entry.datePart, entry.datePart === "year" ? twoDigitYear(text) : String(Number(text) || ""));
      } else {
        parts.add(part, wholeDate(value));
      }
    }
    for (const part of ["issueDate", "expirationDate"]) {
      const { values } = dateParts[part].result();
      parts.add(part, isoDate(values.year, values.month, values.day));
    }
    const { values, conflicts } = parts.result();
    // Two passport numbers: two travelers, and no telling which is the person.
    if (conflicts.has("number") || !fields.length) return null;
    const passport = {};
    for (const [part, value] of Object.entries(values)) {
      if (fitsLimit(value, PASSPORT_LIMITS[part])) passport[part] = value;
    }
    if (values.number && !passport.number) return null;
    for (const key of ["issuingCountry", "nationality"]) {
      if (passport[`${key}Code`]) passport[`${key}Name`] = regionName(passport[`${key}Code`]);
    }
    return Object.keys(passport).length ? { value: passport, fields } : null;
  }

  function sameText(left, right) {
    return Boolean(left) && Boolean(right) && normalize(left).replace(/ /g, "") === normalize(right).replace(/ /g, "");
  }

  // The saved answer a page's parts update: the only one of that type, or
  // the one with the same street line or passport number. Null when there's
  // none, or no telling which.
  function structuredTarget(saved, type, parts) {
    const candidates = saved.filter((entry) => answerType(entry) === type && isStructured(entry));
    if (candidates.length <= 1) return { target: candidates[0] || null, ambiguous: false };
    const key = type === "address" ? "addressLine1" : "number";
    const same = candidates.filter((entry) => sameText(entry.value[key], parts[key]));
    return same.length === 1 ? { target: same[0], ambiguous: false } : { target: null, ambiguous: true };
  }

  // A new street line or passport number is a new address or passport: its
  // other parts start over, except the country (and for a passport, its
  // countries), which a page often doesn't ask again.
  function foldedValue(type, old, parts) {
    const key = type === "address" ? "addressLine1" : "number";
    const kept = type === "address" ? ["countryCode", "countryName"] : ["issuingCountryCode", "issuingCountryName", "nationalityCode", "nationalityName"];
    const replaced = parts[key] && !sameText(parts[key], old[key]);
    const base = replaced ? Object.fromEntries(kept.filter((part) => old[part]).map((part) => [part, old[part]])) : { ...old };
    return { ...base, ...parts, version: 1 };
  }

  function isComplete(type, value) {
    return type === "address" ? Boolean(value.addressLine1 && value.countryCode) : Boolean(value.number);
  }

  // Remember my answers: merges a page's fields into the saved answers, with
  // its address and passport fields going into one structured answer each.
  // Returns the answers and which structured types were updated or added.
  // `labels` names new ones ({ address: "Address", passport: "Passport" }).
  function rememberAnswers(existing, incoming, labels = {}) {
    let result = [...(existing || [])];
    const folded = new Set();
    const structured = [];
    for (const [type, found] of [["address", addressFromFields(incoming)], ["passport", passportFromFields(incoming)]]) {
      if (!found) continue;
      const { target, ambiguous } = structuredTarget(result, type, found.value);
      if (ambiguous) continue;
      const value = target ? foldedValue(type, target.value, found.value) : { ...found.value, version: 1 };
      if (!isComplete(type, value)) continue;
      if (target) {
        result = result.map((entry) => entry === target ? { ...target, value } : entry);
      } else {
        const label = labels[type] || (type === "address" ? "Address" : "Passport");
        result.push({
          answerID: crypto.randomUUID(), answerType: type, userLabel: label, accessibleName: label, label,
          kind: "aggregate", inputType: "", value
        });
      }
      found.fields.forEach((field) => folded.add(field));
      structured.push(type);
    }
    const loose = (incoming || []).filter((entry) => !folded.has(entry)).map((entry) => {
      const { optionValue, datePart, ...rest } = entry;
      return rest;
    });
    return { answers: mergeEntries(result, loose), structured };
  }

  return { addressFieldPart, addressValue, answerType, bestMatch, composedFullName, compatible, contactCategory, contactFieldInfo, contactParts, contactValue, looksGenerated, mergeEntries, nameFieldPart, normalize, overlap, passportCountry, passportFieldPart, passportValue, rememberAnswers, score, selectOptionIndex };
});
