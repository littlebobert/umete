(() => {
  "use strict";

  // The popup injects this script only after a ping goes unanswered. That
  // happens on first use, and also after the extension updates or reloads:
  // the copy already in the page is then disconnected but its globals remain.
  // So never bail out on an earlier copy; replace its listener instead.

  const api = browser;
  const BLOCKED_TYPES = new Set(["button", "file", "hidden", "image", "password", "reset", "submit"]);
  const SENSITIVE_HINT = /\b(card(?:holder)?|credit card|cvc|cvv|password|passcode|security code|secret|social security|ssn|token)\b/i;
  const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6, [role='heading']";
  const MAX_CONTEXT_LENGTH = 160;
  const FORM_CONTROL_SELECTOR = "input, select, textarea, [role='combobox']";

  function compactText(value, maximum = MAX_CONTEXT_LENGTH) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > maximum ? `${text.slice(0, maximum - 1).trimEnd()}…` : text;
  }

  function textOf(element) {
    return compactText(element?.innerText || element?.textContent || "");
  }

  const { deepQuerySelectorAll, isUserVisible } = UmeDOM;
  const { formatDateParts, parseDateParts } = UmeDate;
  const { callingCodeFromOption, countryCodeDigits, digitsOnly, resolveCountryCode, valueForField: phoneValueForField } = UmePhone;

  function elementById(element, id) {
    const root = element.getRootNode?.();
    return root?.getElementById?.(id) || document.getElementById(id);
  }

  function referencedText(element, attribute) {
    return compactText((element.getAttribute(attribute) || "")
      .split(/\s+/)
      .map((id) => textOf(elementById(element, id)))
      .filter(Boolean)
      .join(" "));
  }

  // A label wrapped around a dropdown or text area would otherwise take in
  // every option ("State Select a state Arizona California…") or typed text.
  function labelText(label) {
    if (!label) return "";
    if (!label.querySelector?.("select, textarea, datalist")) return textOf(label);
    const copy = label.cloneNode(true);
    copy.querySelectorAll("select, textarea, datalist").forEach((node) => node.remove());
    return compactText(copy.textContent || "");
  }

  // A label wrapped around its field names it before the field; what follows is
  // often a validation message ("City <input> Please double-check the city,
  // state, and ZIP code."). A checkbox's text comes after it.
  function wrappedLabelText(label, element) {
    if (!label?.contains?.(element) || element.type === "checkbox" || element.type === "radio") return labelText(label);
    const range = document.createRange();
    range.setStart(label, 0);
    range.setEndBefore(element);
    const fragment = range.cloneContents();
    fragment.querySelectorAll?.("select, textarea, datalist").forEach((node) => node.remove());
    return compactText(fragment.textContent || "") || labelText(label);
  }

  const SHORT_LABEL_MAX_LENGTH = 40;
  // Fields a person sees. Hidden inputs often sit right before a field (McPhee's,
  // OfficeMax's) and don't make the text before them another field's label.
  const VISIBLE_FIELD_SELECTOR = "input:not([type='hidden']), select, textarea, [role='combobox']";

  // Older pages put a field's name beside it rather than in a <label>: in the
  // cell or <div> before its own ("<div>Company</div><div><input></div>"), or as
  // text just before it ("Company: <input>").
  function neighborLabel(element) {
    if (element.type === "checkbox" || element.type === "radio") return "";
    const short = (text) => {
      const cleaned = compactText(text).replace(/[\s:*]+$/, "").replace(/^[\s*]+/, "");
      // "* Indicates a required field" is a note about the form, not a name.
      if (/required field|indicates (?:a )?required|^required$/i.test(cleaned)) return "";
      return cleaned && cleaned.length <= SHORT_LABEL_MAX_LENGTH && cleaned.split(" ").length <= 6 ? cleaned : "";
    };
    let before = "";
    for (const node of element.parentElement?.childNodes || []) {
      if (node === element) break;
      if (node.nodeType === Node.TEXT_NODE) before += node.textContent;
      else if (node.nodeType === Node.ELEMENT_NODE) before = node.matches(VISIBLE_FIELD_SELECTOR) || node.querySelector(VISIBLE_FIELD_SELECTOR) ? "" : `${before} ${node.textContent}`;
    }
    if (short(before)) return short(before);
    const above = labelAbove(element);
    if (above) return short(above);
    let node = element;
    for (let depth = 0; node?.parentElement && depth < 3; depth += 1) {
      let sibling = node.previousElementSibling;
      while (sibling && !textOf(sibling) && !sibling.matches(VISIBLE_FIELD_SELECTOR) && !sibling.querySelector(VISIBLE_FIELD_SELECTOR)) sibling = sibling.previousElementSibling;
      if (sibling) {
        if (sibling.matches(`${VISIBLE_FIELD_SELECTOR}, ${HEADING_SELECTOR}, label`) || sibling.querySelector(VISIBLE_FIELD_SELECTOR)) return "";
        // Text right after another field is that field's note ("Street address
        // or P.O. box" under line 1), not this field's name.
        let before = sibling.previousElementSibling;
        while (before && !textOf(before) && !before.matches(VISIBLE_FIELD_SELECTOR) && !before.querySelector(VISIBLE_FIELD_SELECTOR)) before = before.previousElementSibling;
        // A <dt> names the <dd> after it, though another field comes just before it.
        if (sibling.tagName !== "DT" && before && (before.matches(VISIBLE_FIELD_SELECTOR) || before.querySelector(VISIBLE_FIELD_SELECTOR))) return "";
        return short(textOf(sibling));
      }
      // Climb only while the container holds just this field.
      const parent = node.parentElement;
      if (parent.querySelectorAll(VISIBLE_FIELD_SELECTOR).length > 1) return "";
      node = parent;
    }
    return "";
  }

  // A table of fields can put the labels in a row of their own, each above its
  // field's cell: "Zip Code | 4-digit Ext." over the two boxes (Dell's).
  function labelAbove(element) {
    const cell = element.closest("td, th");
    const row = cell?.parentElement;
    if (!cell || row?.tagName !== "TR" || cell.querySelectorAll(VISIBLE_FIELD_SELECTOR).length !== 1) return "";
    // Only when nothing to the left names it.
    const left = cell.previousElementSibling;
    if (left && textOf(left) && !left.querySelector(VISIBLE_FIELD_SELECTOR)) return "";
    const previousRow = row.previousElementSibling;
    if (!previousRow || previousRow.tagName !== "TR" || previousRow.querySelector(VISIBLE_FIELD_SELECTOR)) return "";
    const cellAbove = previousRow.cells[cell.cellIndex];
    return cellAbove && previousRow.cells.length === row.cells.length ? textOf(cellAbove) : "";
  }

  function labelFor(element) {
    if (element.labels?.length) return compactText([...element.labels].map((label) => wrappedLabelText(label, element)).filter(Boolean).join(" "));
    return referencedText(element, "aria-labelledby")
      || comboboxOwnLabel(element)
      || ariaLabel(element)
      || wrappedLabelText(element.closest("label"), element)
      || neighborLabel(element);
  }

  // A dropdown button can carry its title in a <label> inside it, as Delta's do
  // ("Month" inside the button that shows "MM").
  function comboboxOwnLabel(element) {
    return isCustomCombobox(element) ? textOf(element.querySelector("label")) : "";
  }

  // Dropdown buttons often put what's chosen after the name ("Trip Type, Round
  // Trip") or say it's required ("Month, required"); the field is just the name.
  function ariaLabel(element) {
    let label = compactText(element.getAttribute("aria-label"));
    if (!isCustomCombobox(element)) return label;
    label = label.replace(/,\s*required$/i, "");
    const comma = label.lastIndexOf(", ");
    if (comma <= 0) return label;
    const shown = UmeMatcher.normalize(element.textContent);
    const tail = UmeMatcher.normalize(label.slice(comma + 2));
    return tail && shown.includes(tail) ? label.slice(0, comma) : label;
  }

  function descriptionFor(element) {
    const description = referencedText(element, "aria-describedby") || compactText(element.getAttribute("title"));
    const currentValue = typeof element.value === "string" ? element.value.trim() : "";
    return currentValue && description.includes(currentValue)
      ? compactText(description.replaceAll(currentValue, ""))
      : description;
  }

  // Older pages show a field's name as its starting value instead of a
  // placeholder (<input value="First Name">); while the field still holds it,
  // it says what the field is.
  function placeholderFor(element) {
    if (element.placeholder) return compactText(element.placeholder);
    if (!(element instanceof HTMLInputElement) || !["", "text", "email", "tel"].includes(element.type)) return "";
    if (element.getAttribute("aria-labelledby") || element.labels?.length) return "";
    // A title or aria-label must agree with it: Google Calendar's box titled
    // "Event title" can hold the word "State" as a real value, while REI's
    // value "Email Address" sits under "Enter email address to sign up…".
    const otherName = element.title || element.getAttribute("aria-label") || "";
    if (otherName && !` ${UmeMatcher.normalize(otherName)} `.includes(` ${UmeMatcher.normalize(element.getAttribute("value") || "")} `)) return "";
    const initial = element.getAttribute("value") || "";
    if (!initial || element.value !== initial || initial.length > SHORT_LABEL_MAX_LENGTH || !/\p{L}{2}/u.test(initial) || /@|\d{3}/.test(initial)) return "";
    return compactText(initial);
  }

  function accessibleNameFor(element) {
    return referencedText(element, "aria-labelledby")
      || ariaLabel(element)
      || labelFor(element)
      || placeholderFor(element);
  }

  // The parent, stepping out of a shadow root to its host. American's dropdowns
  // are <select>s inside <adc-select> components, while the fieldset, label, or
  // heading that names them sits outside.
  function composedParent(node) {
    return node.parentElement || node.parentNode?.host || null;
  }

  function composedClosest(element, selector) {
    for (let node = element; node; node = composedParent(node)) {
      if (node.matches?.(selector)) return node;
    }
    return null;
  }

  function namedContainer(element, selector) {
    const container = composedClosest(element, selector);
    if (!container) return "";
    return referencedText(container, "aria-labelledby")
      || compactText(container.getAttribute("aria-label"));
  }

  function groupFor(element) {
    const fieldset = composedClosest(element, "fieldset");
    const legend = fieldset?.querySelector(":scope > legend");
    if (legend) return textOf(legend);
    return namedContainer(element, "[role='group'], [role='radiogroup']") || dateRunLabel(element);
  }

  const DATE_PART_NAME = /(?:^| )(?:month|mm|day|dd|year|yyyy|yy)(?: |$)/;

  function visibleFieldsIn(node) {
    return deepQuerySelectorAll(VISIBLE_FIELD_SELECTOR, { children: [node] }).filter((field) => isUserVisible(field)).length;
  }

  // Month, day, and year dropdowns often share one label above them
  // ("Expiration date") while each is named only "month" or "day" (American's
  // passport expiration day is even named "day of birth month"). The label is
  // short text just before the smallest box around the two or three of them.
  function dateRunLabel(element) {
    const own = UmeMatcher.normalize(labelFor(element) || element.name);
    if (!DATE_PART_NAME.test(own) || own.split(" ").length > 4) return "";
    let run = null;
    for (let node = composedParent(element), depth = 0; node && node !== document.body && depth < 8; node = composedParent(node), depth += 1) {
      const count = visibleFieldsIn(node);
      if (count > 3) break;
      if (count >= 2) run = node;
    }
    if (!run) return "";
    const label = (text) => {
      const cleaned = compactText(text).replace(/[\s:*]+$/, "").replace(/^[\s*]+/, "");
      return cleaned && cleaned.length <= SHORT_LABEL_MAX_LENGTH && cleaned.split(" ").length <= 6 ? cleaned : "";
    };
    // Text inside the box, before its first field.
    let inside = "";
    for (const child of run.children) {
      if (visibleFieldsIn(child)) break;
      if (!child.matches(HEADING_SELECTOR)) inside += ` ${textOf(child)}`;
    }
    if (label(inside)) return label(inside);
    // Or the text just before the box.
    let sibling = run.previousElementSibling;
    while (sibling && !textOf(sibling) && !visibleFieldsIn(sibling)) sibling = sibling.previousElementSibling;
    if (!sibling || visibleFieldsIn(sibling) || sibling.matches(HEADING_SELECTOR)) return "";
    return label(textOf(sibling));
  }

  function headingFor(element) {
    let child = element;
    let ancestor = composedParent(element);
    for (let depth = 0; ancestor && depth < 5; depth += 1) {
      if (ancestor.matches("section, article, form, fieldset, li, [role='group'], [role='region']")) {
        const labelled = referencedText(ancestor, "aria-labelledby") || compactText(ancestor.getAttribute("aria-label"));
        if (labelled && labelled !== groupFor(element)) return labelled;
        // In a form with several headings ("Personal information", then
        // "International documents"), the field's is the last one above it.
        const children = [...ancestor.children];
        const isHeading = (candidate) => candidate !== child && candidate.matches?.(HEADING_SELECTOR);
        const index = children.indexOf(child);
        const directHeading = (index >= 0 ? children.slice(0, index).reverse().find(isHeading) : null) || children.find(isHeading);
        if (directHeading) return textOf(directHeading);
      }

      let sibling = child.previousElementSibling;
      while (sibling) {
        if (sibling.matches?.(HEADING_SELECTOR)) return textOf(sibling);
        sibling = sibling.previousElementSibling;
      }
      child = ancestor;
      // Stepping out of a component's shadow root to its host doesn't count.
      if (!ancestor.parentElement && ancestor.parentNode?.host) depth -= 1;
      ancestor = composedParent(ancestor);
    }
    return "";
  }

  function formFor(element) {
    const form = element.form || element.closest("form");
    if (!form) return "";
    const named = referencedText(form, "aria-labelledby") || compactText(form.getAttribute("aria-label"));
    if (named) return named;
    const heading = form.querySelector(HEADING_SELECTOR);
    return heading ? textOf(heading) : "";
  }

  function tableHeadersFor(element) {
    const cell = element.closest("td, th");
    const table = cell?.closest("table");
    if (!cell || !table) return [];

    const headers = [];
    const explicit = (cell.getAttribute("headers") || "").split(/\s+/).filter(Boolean);
    headers.push(...explicit.map((id) => textOf(elementById(element, id))));

    const row = cell.closest("tr");
    if (row) {
      for (const header of row.querySelectorAll(":scope > th")) {
        if (header !== cell) headers.push(textOf(header));
      }
    }

    const columnIndex = cell.cellIndex;
    if (columnIndex >= 0) {
      for (const tableRow of table.rows) {
        const header = tableRow.cells[columnIndex];
        if (header?.tagName === "TH") headers.push(textOf(header));
      }
    }

    return [...new Set(headers.filter(Boolean))].slice(0, 4);
  }

  // ARIA comboboxes: dropdowns built from a div or button with role="combobox"
  // and a list of role="option" items, used instead of <select> by many sites
  // (Delta, for example). Text inputs with role="combobox" stay text fields.
  function isCustomCombobox(element) {
    return element instanceof HTMLElement
      && !(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)
      && element.getAttribute("role") === "combobox";
  }

  function isDropdown(element) {
    return element instanceof HTMLSelectElement || isCustomCombobox(element);
  }

  function comboboxListbox(element) {
    for (const attribute of ["aria-controls", "aria-owns"]) {
      for (const id of (element.getAttribute(attribute) || "").split(/\s+/).filter(Boolean)) {
        // The list may sit in another shadow root than its combobox.
        const target = elementById(element, id) || deepQuerySelectorAll(`[id="${CSS.escape(id)}"]`)[0];
        if (target?.getAttribute("role") === "listbox") return target;
        const nested = target?.querySelector?.("[role='listbox']");
        if (nested) return nested;
      }
    }
    const inside = element.querySelector("[role='listbox']");
    if (inside) return inside;
    // Otherwise the nearest container holding exactly one listbox.
    let ancestor = element.parentElement;
    for (let depth = 0; ancestor && depth < 4; depth += 1, ancestor = ancestor.parentElement) {
      const lists = ancestor.querySelectorAll("[role='listbox']");
      if (lists.length === 1) return lists[0];
      if (lists.length > 1) return null;
    }
    // An open combobox whose list was put at the end of the page, or in a
    // shadow root: the one list showing.
    if (element.getAttribute("aria-expanded") === "true") {
      const showing = deepQuerySelectorAll("[role='listbox']").filter((list) => isUserVisible(list));
      if (showing.length === 1) return showing[0];
    }
    return null;
  }

  // Options of a <select>, or of a combobox shaped like <select> options:
  // { text, value } plus the option node to click.
  function dropdownOptions(element) {
    if (element instanceof HTMLSelectElement) return [...element.options];
    const listbox = comboboxListbox(element);
    if (!listbox) return [];
    return [...listbox.querySelectorAll("[role='option']")].map((node) => ({
      text: compactText(node.textContent),
      value: node.getAttribute("data-value") || node.getAttribute("value") || compactText(node.textContent),
      node,
      selected: node.getAttribute("aria-selected") === "true"
    })).filter((option) => option.text);
  }

  function clickLikeAPerson(node) {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const EventType = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      node.dispatchEvent(new EventType(type, { bubbles: true, cancelable: true, view: window }));
    }
    node.click();
  }

  function chooseComboboxOption(element, option) {
    const listbox = comboboxListbox(element);
    const wasOpen = isUserVisible(listbox || element);
    if (!wasOpen) clickLikeAPerson(element);
    clickLikeAPerson(option.node);
    const chosen = option.node.getAttribute("aria-selected") === "true"
      || UmeMatcher.normalize(element.textContent).includes(UmeMatcher.normalize(option.text));
    // Close the list if picking an option didn't.
    if (listbox && isUserVisible(listbox)) {
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    }
    return chosen;
  }

  // A <button> dropdown reports type "submit"; it's still a field.
  function controlType(element) {
    return isCustomCombobox(element) ? "" : String(element.type || "").toLowerCase();
  }

  function kindOf(element) {
    if (isDropdown(element)) return "select";
    if (element.tagName === "TEXTAREA") return "textarea";
    const type = (element.type || "text").toLowerCase();
    return type === "checkbox" || type === "radio" ? type : "text";
  }

  function isEligible(element) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement || isCustomCombobox(element))) return false;
    if (element.getAttribute("aria-disabled") === "true") return false;
    const type = controlType(element);
    const hints = [element.name, element.id, element.autocomplete, element.placeholder, labelFor(element), groupFor(element)]
      .filter(Boolean)
      .join(" ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ");
    // Hidden fields are skipped: pages often keep alternate inputs (for example
    // office and home phone numbers behind tabs) that must stay empty.
    return !element.disabled && !element.readOnly && !BLOCKED_TYPES.has(type) && !SENSITIVE_HINT.test(hints)
      && isUserVisible(element);
  }

  function optionLabelFor(element) {
    if (element instanceof HTMLSelectElement) return compactText(element.selectedOptions?.[0]?.text);
    if (isCustomCombobox(element)) return dropdownOptions(element).find((option) => option.selected)?.text || "";
    return "";
  }

  function radioGroupName(element) {
    return groupFor(element) || headingFor(element) || element.name || "";
  }

  // A field labeled only "Name" right before a "Surname" field asks for the
  // first name, not the full name.
  // "Name" beside a surname box is the given name: before it ("Name",
  // "Surname"), or after it, as Korean forms put 이름 after 성.
  function givenNameBesideSurname(element, descriptor) {
    if (UmeMatcher.normalize(descriptor.label || descriptor.accessibleName) !== "name") return false;
    const controls = [...(element.form || document).querySelectorAll(FORM_CONTROL_SELECTOR)].filter((control) => !BLOCKED_TYPES.has(controlType(control)));
    const index = controls.indexOf(element);
    const isSurname = (control) => /^(?:surname|last name|family name)$/.test(UmeMatcher.normalize(labelFor(control)));
    return controls.slice(index + 1, index + 3).some(isSurname) || (index > 0 && isSurname(controls[index - 1]));
  }

  function describe(element) {
    const descriptor = {
      accessibleDescription: descriptionFor(element),
      accessibleName: accessibleNameFor(element),
      autocomplete: element.autocomplete || "",
      form: formFor(element),
      group: groupFor(element),
      id: element.id || "",
      inputType: controlType(element),
      kind: kindOf(element),
      label: labelFor(element),
      name: element.name || "",
      placeholder: isDropdown(element) ? "" : placeholderFor(element),
      required: Boolean(element.required || element.getAttribute("aria-required") === "true"),
      section: headingFor(element),
      tableHeaders: tableHeadersFor(element)
    };
    if (isDropdown(element)) descriptor.optionLabel = optionLabelFor(element);
    if (givenNameBesideSurname(element, descriptor)) descriptor.namePart = "given";
    const addressPart = UmeMatcher.addressFieldPart(descriptor);
    if (addressPart) descriptor.addressPart = addressPart;
    if (element.type === "radio") {
      descriptor.optionLabel = compactText([labelFor(element), element.value].filter(Boolean).join(" "));
      descriptor.groupName = compactText(radioGroupName(element));
      descriptor.accessibleName = descriptor.groupName || descriptor.accessibleName;
      descriptor.label = descriptor.groupName || descriptor.label;
    }
    return descriptor;
  }

  function readValue(element) {
    if (element.type === "checkbox") return element.checked;
    if (element.type === "radio") return element.checked ? (describe(element).optionLabel || element.value) : null;
    if (element instanceof HTMLSelectElement) return optionLabelFor(element) || element.value;
    if (isCustomCombobox(element)) return optionLabelFor(element);
    return element.value;
  }

  function collectAnswers() {
    const answers = [];
    const seenRadios = new Set();
    const elements = deepQuerySelectorAll(FORM_CONTROL_SELECTOR).filter(isEligible);
    for (const element of elements) {
      if (isCountryCodeField(element)) continue;
      const descriptor = describe(element);
      if (element.type === "radio" && element.checked) {
        const key = element.name || `${descriptor.groupName}`;
        if (seenRadios.has(key)) continue;
        seenRadios.add(key);
      }
      const value = readValue(element);
      if (value === "" || value == null) continue;
      const answer = { ...descriptor, value };
      // For Remember to fold a page's address and passport into one answer
      // each: a menu's option value is often the country code ("JP"), and a
      // passport date's dropdowns each hold one part of it.
      if (element instanceof HTMLSelectElement && element.value) answer.optionValue = element.value;
      if (["issueDate", "expirationDate"].includes(UmeMatcher.passportFieldPart(descriptor))) {
        const part = dateFieldPart(element);
        if (part) answer.datePart = part;
      }
      if (UmeMatcher.answerType(descriptor) === "phone") {
        const codeElement = relatedCountryCodeElement(element, elements);
        const code = selectedCountryCode(codeElement);
        answer.answerType = "phone";
        if (code) answer.countryCode = code;
      }
      answers.push(answer);
    }
    return answers;
  }

  // Sites often reformat what's typed, such as uppercasing names (ANA) or
  // trimming spaces, so compare loosely when checking that a value stuck.
  function valueStuck(element, expected) {
    const actual = String(element.value ?? "").trim();
    const wanted = String(expected ?? "").trim();
    return actual === wanted || (actual !== "" && actual.toLocaleLowerCase() === wanted.toLocaleLowerCase());
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, String(value));
    else element.value = String(value);
  }

  function isCountryCodeField(element) {
    if (UmeMatcher.addressFieldPart(describe(element)) === "country") return false;
    const text = UmeMatcher.normalize([
      element.id, element.name, element.placeholder, element.autocomplete, labelFor(element), accessibleNameFor(element)
    ].filter(Boolean).join(" "));
    return /(?:^| )(?:country (?:phone )?code|phone country|calling code|dial code|international code|country dialing)(?: |$)/.test(text);
  }

  function nearestRelatedElement(element, elements, predicate) {
    const index = elements.indexOf(element);
    let candidates = elements.filter((candidate) => candidate !== element && predicate(candidate));
    const sameForm = candidates.filter((candidate) => candidate.form && candidate.form === element.form);
    if (sameForm.length) candidates = sameForm;
    candidates.sort((left, right) => Math.abs(elements.indexOf(left) - index) - Math.abs(elements.indexOf(right) - index));
    return candidates[0] || null;
  }

  function relatedPhoneElement(element, elements) {
    return nearestRelatedElement(element, elements, (candidate) => {
      return !isCountryCodeField(candidate) && UmeMatcher.answerType(describe(candidate)) === "phone";
    });
  }

  function relatedCountryCodeElement(element, elements) {
    return nearestRelatedElement(element, elements, isCountryCodeField);
  }

  function selectedCountryCode(element) {
    if (!element) return "";
    if (element instanceof HTMLSelectElement) {
      const option = element.selectedOptions?.[0];
      return callingCodeFromOption(option?.value, option?.text);
    }
    if (isCustomCombobox(element)) {
      const option = dropdownOptions(element).find((candidate) => candidate.selected);
      return callingCodeFromOption(option?.value, option?.text);
    }
    return callingCodeFromOption(element.value, element.value);
  }

  function countryCodeResolution(savedEntries, element, elements = eligibleElements()) {
    if (!isCountryCodeField(element)) return { codes: [], saved: null, result: "not a country code field" };
    const related = relatedPhoneElement(element, elements);
    return resolveCountryCode(savedEntries, related ? describe(related) : null);
  }

  function matchForElement(savedEntries, element) {
    if (isCountryCodeField(element)) return countryCodeResolution(savedEntries, element).saved;
    return UmeMatcher.bestMatch(savedEntries, describe(element));
  }

  function phoneParts(saved, element) {
    const callingCodeField = isCountryCodeField(element);
    const value = phoneValueForField(saved, callingCodeField);
    return value ? [value] : null;
  }

  const PHONE_PART_TYPES = new Set(["", "text", "tel", "number"]);
  const MAX_PHONE_PART_LENGTH = 8;

  function isPhonePartBox(element) {
    return element instanceof HTMLInputElement
      && PHONE_PART_TYPES.has(element.type)
      && element.maxLength >= 1 && element.maxLength <= MAX_PHONE_PART_LENGTH
      && !isCountryCodeField(element);
  }

  // Boxes of one number sit in the same row, so they share an ancestor a few levels up.
  function closeTogether(first, second) {
    let node = first.parentElement;
    for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
      if (node.contains(second)) return true;
    }
    return false;
  }

  // A number split into boxes sized for its parts, such as 415 / 555 / 0142.
  // Starting at the matched box, the following boxes take the digits in
  // order, each up to its maxlength. Returns null unless the boxes hold the
  // whole number exactly, so a short run never gets a partial number.
  function splitPhoneParts(element, digits) {
    if (!isPhonePartBox(element) || element.maxLength >= digits.length) return null;
    const elements = eligibleElements();
    const start = elements.indexOf(element);
    if (start < 0) return null;
    const parts = [];
    let remaining = digits;
    for (let index = start; index < elements.length && remaining; index += 1) {
      const box = elements[index];
      if (index > start && !(isPhonePartBox(box) && closeTogether(elements[index - 1], box))) break;
      parts.push({ element: box, value: remaining.slice(0, box.maxLength) });
      remaining = remaining.slice(box.maxLength);
    }
    return !remaining && parts.length > 1 ? parts : null;
  }

  function phoneBoxText(element) {
    return UmeMatcher.normalize([labelFor(element), element.name, element.id, element.placeholder].filter(Boolean).join(" "));
  }

  // A box for the area code alone ("Area Code", not "Phone (with area code)").
  function isAreaCodeBox(element) {
    const text = phoneBoxText(element);
    const named = UmeMatcher.normalize(element.name || element.id);
    return (/(?:^| )area ?code(?: |$)|areacode/.test(text) || /(?:^| )area(?: code)?$/.test(named))
      && !/(?:with|including|incl|plus) (?:the )?area code/.test(text);
  }

  // An area code box with no length limit takes the area code of a ten-digit
  // number, and the boxes after it the rest ("Area Code", "Exchange"). Null
  // when the number can't be laid out that way.
  function areaCodeSplit(element, digits) {
    if (digits.length !== 10) return null;
    const elements = eligibleElements();
    const start = elements.indexOf(element);
    if (start < 0) return null;
    const parts = [{ element, value: digits.slice(0, 3) }];
    let remaining = digits.slice(3);
    for (let index = start + 1; index < elements.length && remaining; index += 1) {
      const box = elements[index];
      if (!(box instanceof HTMLInputElement) || !PHONE_PART_TYPES.has(box.type) || isCountryCodeField(box)
          || !closeTogether(elements[index - 1], box) || /(?:^| )(?:ext|extn|extension)(?: |$)/.test(phoneBoxText(box))) break;
      const take = box.maxLength > 0 ? Math.min(box.maxLength, remaining.length) : remaining.length;
      parts.push({ element: box, value: remaining.slice(0, take) });
      remaining = remaining.slice(take);
    }
    return remaining ? null : parts;
  }

  // The later boxes of a split number, filled along with the first one.
  const filledAsPhonePart = new WeakSet();

  function applySplitPhone(parts) {
    let applied = true;
    for (const [index, part] of parts.entries()) {
      setNativeValue(part.element, part.value);
      dispatchValueEvents(part.element);
      const stuck = valueStuck(part.element, part.value);
      if (index === 0) applied = stuck;
      else if (stuck) filledAsPhonePart.add(part.element);
    }
    return applied;
  }

  function selectOption(element, option) {
    if (!option) return false;
    if (isCustomCombobox(element)) return chooseComboboxOption(element, option);
    setNativeValue(element, option.value);
    if (element.value !== option.value) option.selected = true;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return element.value === option.value || option.selected;
  }

  function applyCountryCodeSelect(element, code) {
    const target = digitsOnly(code);
    if (!target) return false;
    const candidates = dropdownOptions(element).filter((option) => compactText(option.text) || String(option.value || "").trim());
    const option = candidates.find((candidate) => callingCodeFromOption(candidate.value, candidate.text) === target)
      || candidates.find((candidate) => new RegExp(`\\+${target}(?:\\D|$)`).test(compactText(candidate.text)))
      || candidates.find((candidate) => {
        const groups = compactText(candidate.text).match(/\+\d{1,3}/g) || [];
        return groups.some((group) => digitsOnly(group) === target);
      });
    return selectOption(element, option);
  }

  function applySelect(element, value) {
    const options = dropdownOptions(element);
    const index = UmeMatcher.selectOptionIndex(options, value);
    return selectOption(element, index >= 0 ? options[index] : null);
  }

  // A country menu lists codes or names ("JP", "Japan", "Japan +81"); a text box
  // takes the name unless it asks for the code.
  function applyCountry(element, descriptor, countryCode, countryName) {
    const code = UmeMatcher.normalize(countryCode);
    const name = UmeMatcher.normalize(countryName);
    if (isDropdown(element)) {
      const option = dropdownOptions(element).find((candidate) => {
        const optionValue = UmeMatcher.normalize(candidate.value);
        const optionText = UmeMatcher.normalize(candidate.text);
        const optionTextWithoutDialingCode = optionText.replace(/ \d{1,3}$/, "");
        return Boolean((code && (optionValue === code || optionText === code)) || (name && (optionValue === name || optionText === name || optionTextWithoutDialingCode === name)));
      });
      return selectOption(element, option);
    }
    const autocomplete = String(element.autocomplete || "").toLowerCase().split(/\s+/);
    const requestsCode = autocomplete.includes("country") || /(?:^| )(?:country code|iso country)(?: |$)/.test(UmeMatcher.normalize([descriptor.label, descriptor.name].join(" ")));
    const country = requestsCode ? countryCode : (countryName || countryCode);
    if (!country) return false;
    setNativeValue(element, country);
    dispatchValueEvents(element);
    return valueStuck(element, country);
  }

  function applyPassport(element, saved) {
    const descriptor = describe(element);
    const part = UmeMatcher.passportFieldPart(descriptor);
    if (part === "issuingCountry" || part === "nationality") {
      const country = UmeMatcher.passportCountry(saved, part);
      return Boolean(country) && applyCountry(element, descriptor, country.code, country.name);
    }
    const value = UmeMatcher.passportValue(saved, part);
    if (!value) return false;
    if (part === "issueDate" || part === "expirationDate") return applyDate(element, { value }, true);
    if (isDropdown(element)) return false;
    setNativeValue(element, value);
    dispatchValueEvents(element);
    return valueStuck(element, value);
  }

  function applyAddress(element, saved) {
    const descriptor = describe(element);
    const part = UmeMatcher.addressFieldPart(descriptor);
    const address = saved?.value;
    if (!part || !address || typeof address !== "object" || Array.isArray(address)) return false;

    if (part === "country") return applyCountry(element, descriptor, address.countryCode, address.countryName);

    const value = part === "streetAddress" && !(element instanceof HTMLTextAreaElement)
      ? address.addressLine1
      : UmeMatcher.addressValue(saved, part);
    if (!value) return false;
    if (isDropdown(element)) return applySelect(element, value);
    setNativeValue(element, value);
    dispatchValueEvents(element);
    return valueStuck(element, value);
  }

  function genderValue(value) {
    const normalized = UmeMatcher.normalize(value);
    const parts = new Set(normalized.split(" ").filter(Boolean));
    if (parts.has("female") || parts.has("woman") || normalized === "f") return "f";
    if (parts.has("male") || parts.has("man") || normalized === "m") return "m";
    if (parts.has("undisclosed") || normalized === "u") return "u";
    if (parts.has("unspecified") || normalized === "x" || normalized === "nonbinary" || normalized === "non binary") return "x";
    return normalized;
  }

  function applyGenderSelect(element, saved) {
    if (applySelect(element, saved?.value)) return true;
    const target = genderValue(saved?.value);
    if (!target) return false;
    const option = dropdownOptions(element).find((candidate) => {
      return genderValue([candidate.text, candidate.value].filter(Boolean).join(" ")) === target;
    });
    return selectOption(element, option);
  }

  function applyRadio(saved, sourceElement) {
    const type = UmeMatcher.answerType(saved);
    const normalized = type === "gender" ? genderValue(saved?.value) : UmeMatcher.normalize(saved?.value);
    if (!normalized) return false;
    const candidates = deepQuerySelectorAll("input[type='radio']").filter((candidate) => {
      if (!isEligible(candidate)) return false;
      const descriptor = describe(candidate);
      if (sourceElement?.name && candidate.name && sourceElement.name !== candidate.name) return false;
      return !sourceElement || UmeMatcher.compatible(saved, descriptor);
    });
    const match = candidates.find((candidate) => {
      const value = type === "gender"
        ? genderValue([labelFor(candidate), candidate.value].filter(Boolean).join(" "))
        : UmeMatcher.normalize([labelFor(candidate), candidate.value].filter(Boolean).join(" "));
      return value === normalized || value.startsWith(`${normalized} `);
    });
    if (match && !match.checked) match.click();
    return Boolean(match && match.checked);
  }

  function applySegmentedGender(saved) {
    const target = genderValue(saved?.value);
    if (!target) return false;
    const candidates = deepQuerySelectorAll("button, [role='radio']").filter((candidate) => {
      if (candidate.disabled || candidate.getAttribute("aria-disabled") === "true") return false;
      return genderValue([candidate.getAttribute("aria-label"), candidate.getAttribute("data-value"), candidate.getAttribute("value"), textOf(candidate)].filter(Boolean).join(" ")) === target;
    });
    const match = candidates.find((candidate) => {
      const container = candidate.closest("[role='radiogroup'], mat-button-toggle-group, .mat-button-toggle-group") || candidate.parentElement;
      const context = UmeMatcher.normalize(textOf(container));
      return /(?:^| )male(?: |$)/.test(context) && /(?:^| )female(?: |$)/.test(context);
    });
    if (!match) return false;
    match.click();
    return match.getAttribute("aria-checked") !== "false" && match.getAttribute("aria-pressed") !== "false";
  }

  const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

  function dateFieldPart(element) {
    const autocomplete = String(element.autocomplete || "");
    if (autocomplete === "bday-month") return "month";
    if (autocomplete === "bday-year") return "year";
    if (autocomplete === "bday-day") return "day";
    if (autocomplete === "bday") return "";
    // IDs like "dobmonth_0_dropdown" or "birthYear" glue the part onto the name.
    const machine = [element.name, element.id].filter(Boolean).join(" ").toLowerCase();
    const glued = machine.match(/(?:dob|birth|bday)[_-]?(month|day|year)/);
    if (glued) return glued[1];
    // "Birth day" is the whole date, not the day part, so drop that phrase first.
    const text = UmeMatcher.normalize([labelFor(element), element.name, element.id, element.placeholder].filter(Boolean).join(" "))
      .replace(/(?:^| )birth ?day(?= |$)/g, " ");
    // "Day of birth month" (American's) asks for the day: the part before "of"
    // is what the field wants.
    const headed = text.match(/(?:^| )(month|day|year) of /);
    if (headed) return headed[1];
    if (/(?:^| )(?:month|mm)(?: |$)/.test(text)) return "month";
    if (/(?:^| )(?:year|yyyy|yy)(?: |$)/.test(text)) return "year";
    if (/(?:^| )(?:day|dd)(?: |$)/.test(text)) return "day";
    return "";
  }

  function datePartValue(parts, part) {
    if (part === "month") return { numeric: parts.month, padded: parts.month.padStart(2, "0"), name: MONTH_NAMES[Number(parts.month) - 1] || "" };
    if (part === "day") return { numeric: parts.day, padded: parts.day.padStart(2, "0") };
    if (part === "year") return { numeric: parts.year, padded: parts.year, short: parts.year.slice(-2) };
    return null;
  }

  function applyDateSelect(element, partValue) {
    const candidates = [partValue.name, partValue.numeric, partValue.padded, partValue.short].filter(Boolean);
    for (const candidate of candidates) {
      if (applySelect(element, candidate)) return true;
    }
    return false;
  }

  // A whole-date box takes a birth date only when it asks for one; a passport
  // date is placed by the matcher, so `anyWholeDate` skips that check.
  function applyDate(element, saved, anyWholeDate = false) {
    const parts = parseDateParts(saved?.value);
    if (!parts) return false;
    const part = dateFieldPart(element);
    if (part) {
      const partValue = datePartValue(parts, part);
      if (!partValue) return false;
      if (isDropdown(element)) return applyDateSelect(element, partValue);
      const text = UmeMatcher.normalize([element.placeholder, element.name, element.id].filter(Boolean).join(" "));
      const value = (part === "month" || part === "day") && /mm|dd|yyyy|yy/.test(text) ? partValue.padded : partValue.numeric;
      setNativeValue(element, value);
      dispatchValueEvents(element);
      return valueStuck(element, value);
    }

    if (isDropdown(element)) return false;
    const normalized = UmeMatcher.normalize([labelFor(element), accessibleNameFor(element), element.name, element.id, element.placeholder, element.autocomplete].filter(Boolean).join(" "));
    const isBirthDate = /(?:^| )(?:birth ?day|birth ?date|date of birth|dob)(?: |$)/.test(normalized) || element.autocomplete === "bday";
    if (!isBirthDate && !anyWholeDate) return false;
    const value = formatDateParts(parts, [element.placeholder, labelFor(element), accessibleNameFor(element)].filter(Boolean).join(" "), element.type);
    setNativeValue(element, value);
    dispatchValueEvents(element);
    return String(element.value) === value;
  }

  function dispatchValueEvents(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function flattenContact(saved, element) {
    if (element.type === "checkbox") return null;
    const descriptor = describe(element);
    const info = UmeMatcher.contactFieldInfo(descriptor);
    const value = info ? UmeMatcher.contactValue(saved, info.part) : "";
    if (!value) return null;
    return {
      accessibleName: descriptor.accessibleName || descriptor.label,
      label: descriptor.label,
      kind: descriptor.kind,
      inputType: descriptor.inputType,
      ...(info.part === "phone" || info.part === "fax" ? { answerType: "phone" } : {}),
      value
    };
  }

  function applyValue(element, value, saved) {
    // Already holds its part of a split phone number filled from the first box.
    if (filledAsPhonePart.has(element)) return true;
    if (UmeMatcher.answerType(saved) === "contact") {
      const flattened = flattenContact(saved, element);
      return flattened ? applyValue(element, flattened.value, flattened) : false;
    }
    if (element.type === "checkbox") {
      if (element.checked !== Boolean(value)) element.click();
      return element.checked === Boolean(value);
    }
    if (element.type === "radio") return applyRadio(saved || { value }, element);

    const type = UmeMatcher.answerType(saved);
    if (type === "address") return applyAddress(element, saved);
    if (type === "passport") return applyPassport(element, saved);
    if (type === "gender") {
      if (isDropdown(element) && applyGenderSelect(element, saved)) return true;
      if (applySegmentedGender(saved)) return true;
      if (isDropdown(element)) return false;
    }
    if (type === "date") {
      if (applyDate(element, saved)) return true;
      if (isDropdown(element)) return false;
      setNativeValue(element, value);
      dispatchValueEvents(element);
      return valueStuck(element, value);
    }

    if (type === "phone") {
      const parts = phoneParts(saved, element);
      if (!parts) return false;
      if (isDropdown(element)) {
        return isCountryCodeField(element)
          ? applyCountryCodeSelect(element, parts[0])
          : applySelect(element, parts[0]);
      }
      value = parts[parts.length - 1];
      const digits = digitsOnly(value);
      let split = digits ? splitPhoneParts(element, digits) : null;
      // An area code box never gets the whole number.
      if (!split && digits && isAreaCodeBox(element)) {
        split = areaCodeSplit(element, digits);
        if (!split) {
          intentionallySkipped.add(element);
          return false;
        }
      }
      // A box too short for the number that isn't part of a split run (an
      // area code box on its own) is left alone rather than given a cut-off number.
      if (!split && element.maxLength > 0 && String(value).length > element.maxLength) {
        intentionallySkipped.add(element);
        return false;
      }
      if (digits && !isConfirmationField(element) && phoneUsedElsewhere(digits, element, split)) {
        intentionallySkipped.add(element);
        return false;
      }
      if (digits && !filledPhoneNumbers.has(digits)) filledPhoneNumbers.set(digits, element);
      if (split) return applySplitPhone(split);
    } else if (isDropdown(element)) {
      return applySelect(element, value);
    }

    setNativeValue(element, value);
    dispatchValueEvents(element);
    return valueStuck(element, value);
  }

  const failedApplications = new WeakSet();
  // Fields Fill just filled. They never go to the AI: a field named only by its
  // starting value ("First Name") no longer reads that way once it's filled.
  const filledByUmete = new WeakSet();
  // Fields left empty on purpose (not failures), so they aren't sent to the AI.
  const intentionallySkipped = new WeakSet();
  // Phone numbers Umete filled on this page, mapped to the field that got each.
  // A second phone field is almost always an alternate, emergency, or
  // per-person number, and sites like ANA reject the same number twice, so a
  // saved number goes into one field per page unless a field asks to confirm
  // it. This lasts for the page's lifetime because multi-step forms (ANA again)
  // collapse a finished step before showing the next, so the next click is a
  // separate fill whose earlier phone field is no longer visible.
  const filledPhoneNumbers = new Map();

  function fieldIdentity(element) {
    return element.id || element.name || "";
  }

  function phoneUsedElsewhere(digits, element, split = null) {
    const owner = filledPhoneNumbers.get(digits);
    // The field that got the number counts as used even after the site removes
    // it (a collapsed step), unless this is that same field re-rendered.
    if (owner && owner !== element && !(fieldIdentity(owner) && fieldIdentity(owner) === fieldIdentity(element))) return true;
    // Also catch the number already typed into any other field, hidden or not,
    // except this number's own boxes from an earlier fill.
    const ownBoxes = new Set((split || []).map((part) => part.element));
    return deepQuerySelectorAll("input").some((other) => {
      if (other === element || other.type === "hidden" || ownBoxes.has(other)) return false;
      const otherDigits = digitsOnly(other.value);
      return otherDigits.length >= 6 && (otherDigits === digits || otherDigits.endsWith(digits) || digits.endsWith(otherDigits));
    });
  }

  function isConfirmationField(element) {
    const text = UmeMatcher.normalize([labelFor(element), accessibleNameFor(element), element.name, element.placeholder].filter(Boolean).join(" "));
    return /(?:^| )(?:confirm|confirmation|re enter|reenter|retype|repeat|verify|again)(?: |$)/.test(text);
  }

  function eligibleElements() {
    return deepQuerySelectorAll(FORM_CONTROL_SELECTOR).filter(isEligible);
  }

  // A combobox whose options aren't on the page until it's opened (American's
  // Gender, Title, and Loyalty program). Fill sets these aside, then opens
  // each, waits for its list, picks the option, and closes it.
  function optionsAppearOnOpen(element) {
    return isCustomCombobox(element) && element.getAttribute("aria-expanded") !== "true" && !dropdownOptions(element).length;
  }

  const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function closeCombobox(element) {
    if (element.getAttribute("aria-expanded") !== "true" && !isUserVisible(comboboxListbox(element))) return;
    for (const target of [element, document.activeElement].filter(Boolean)) {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, composed: true }));
    }
    if (element.getAttribute("aria-expanded") === "true") clickLikeAPerson(element);
  }

  async function applyWithOptionsOpen(element, value, saved) {
    clickLikeAPerson(element);
    for (let waited = 0; waited < 1000 && !dropdownOptions(element).length; waited += 50) await pause(50);
    const applied = dropdownOptions(element).length ? applyValue(element, value, saved) : false;
    await pause(0);
    closeCombobox(element);
    return applied;
  }

  function recordApplied(element, applied, counts) {
    if (applied) {
      counts.filled += 1;
      filledByUmete.add(element);
      failedApplications.delete(element);
      intentionallySkipped.delete(element);
    } else if (intentionallySkipped.has(element)) {
      counts.skippedDuplicates += 1;
      failedApplications.delete(element);
    } else {
      counts.unmatched += 1;
      counts.matchedButNotApplied += 1;
      failedApplications.add(element);
    }
  }

  // Fill, then the comboboxes it set aside, one at a time.
  async function fillAnswersAndOpenLists(savedEntries, diagnosticsEnabled = false) {
    const result = fillAnswers(savedEntries, diagnosticsEnabled);
    const counts = { filled: result.filled, unmatched: result.unmatched, matchedButNotApplied: result.matchedButNotApplied, skippedDuplicates: result.skippedDuplicates };
    for (const { element, match } of result.setAside) {
      recordApplied(element, await applyWithOptionsOpen(element, match.value, match), counts);
    }
    const { setAside, ...rest } = result;
    return { ...rest, ...counts, openedLists: setAside.length };
  }

  function fillAnswers(savedEntries, diagnosticsEnabled = false) {
    const elements = eligibleElements();
    const countryCodeDiagnostics = [];
    let filled = 0;
    let skippedDuplicates = 0;
    let unmatched = 0;
    let matchedButNotApplied = 0;
    const setAside = [];
    // The address part of the last address field, to spot a second line 2.
    let previousLinePart = "";
    for (const element of elements) {
      // A second "line 2" right after one (an "Apt/Suite" box, then "Address
      // line 2") would get the apartment again; it's left empty.
      const linePart = UmeMatcher.addressFieldPart(describe(element));
      // A site's own autocomplete="address-line2" still counts.
      const repeatsLine2 = linePart === "addressLine2" && previousLinePart === "addressLine2"
        && !/(?:^| )address-line2(?: |$)/.test(String(element.autocomplete || "").toLowerCase());
      if (linePart) previousLinePart = linePart;
      if (repeatsLine2) {
        intentionallySkipped.add(element);
        skippedDuplicates += 1;
        continue;
      }
      const isCallingCode = isCountryCodeField(element);
      const resolution = isCallingCode ? countryCodeResolution(savedEntries, element, elements) : null;
      const match = isCallingCode ? resolution.saved : matchForElement(savedEntries, element);
      if (!match) {
        unmatched += 1;
        if (isCallingCode && diagnosticsEnabled) {
          countryCodeDiagnostics.push({
            availableSavedCodes: resolution.codes,
            result: resolution.result,
            selectedBefore: optionLabelFor(element)
          });
        }
        continue;
      }
      if (optionsAppearOnOpen(element)) {
        setAside.push({ element, match });
        continue;
      }
      const selectedBefore = isCallingCode ? optionLabelFor(element) : "";
      const applied = applyValue(element, match.value, match);
      if (isCallingCode && diagnosticsEnabled) {
        const targetCode = countryCodeDigits(match);
        countryCodeDiagnostics.push({
          availableSavedCodes: resolution.codes,
          targetCode,
          selectedBefore,
          selectedAfter: optionLabelFor(element),
          applied,
          matchingOptions: isDropdown(element)
            ? dropdownOptions(element).filter((option) => {
              const textCodes = compactText(option.text).match(/\+\d{1,3}/g) || [];
              return digitsOnly(option.value) === targetCode || textCodes.some((code) => digitsOnly(code) === targetCode);
            }).slice(0, 10).map((option) => ({ text: compactText(option.text), value: String(option.value || "") }))
            : []
        });
      }
      const counts = { filled, unmatched, matchedButNotApplied, skippedDuplicates };
      recordApplied(element, applied, counts);
      ({ filled, unmatched, matchedButNotApplied, skippedDuplicates } = counts);
    }
    return {
      setAside,
      filled,
      unmatched,
      matchedButNotApplied,
      skippedDuplicates,
      ...(diagnosticsEnabled ? { countryCodeDiagnostics } : {}),
      eligibleFieldCount: elements.length,
      domControlCount: deepQuerySelectorAll(FORM_CONTROL_SELECTOR).length,
      frameURL: location.href
    };
  }

  function unmatchedSchemas(savedEntries) {
    const hasAddress = (savedEntries || []).some((entry) => UmeMatcher.answerType(entry) === "address");
    const hasPassport = (savedEntries || []).some((entry) => UmeMatcher.answerType(entry) === "passport");
    return eligibleElements().flatMap((element, index) => {
      const descriptor = describe(element);
      if (hasAddress && UmeMatcher.addressFieldPart(descriptor)) return [];
      // Passport fields are filled on the device only, like addresses.
      if (hasPassport && UmeMatcher.passportFieldPart(descriptor)) return [];
      // A ZIP+4 box stays empty: there's no saved answer for it to get.
      if (UmeMatcher.addressFieldPart(descriptor) === "postalCodeSuffix") return [];
      if (intentionallySkipped.has(element) || filledAsPhonePart.has(element) || filledByUmete.has(element)) return [];
      if (!failedApplications.has(element) && matchForElement(savedEntries, element)) return [];
      const options = isDropdown(element)
        ? dropdownOptions(element).map((option) => compactText(option.text)).filter(Boolean).slice(0, 50)
        : [];
      return [{ field: `field-${index}`, ...descriptor, options }];
    });
  }

  async function applyMappings(mappings, values) {
    const elements = eligibleElements();
    const savedByKey = new Map((values || []).map((item) => [item.key, item]));
    let filled = 0;
    for (const mapping of mappings || []) {
      const index = Number(String(mapping.field || "").replace("field-", ""));
      const element = elements[index];
      const saved = savedByKey.get(mapping.key);
      if (!element || !saved || ["address", "passport"].includes(UmeMatcher.answerType(saved))) continue;
      const applied = optionsAppearOnOpen(element)
        ? await applyWithOptionsOpen(element, saved.value, saved)
        : applyValue(element, saved.value, saved);
      if (applied) filled += 1;
    }
    return { filled };
  }

  function handleMessage(message, _sender, sendResponse) {
    if (message?.type === "UME_PING") sendResponse({ ready: true });
    if (message?.type === "UME_COLLECT") sendResponse({ answers: collectAnswers() });
    if (message?.type === "UME_SCHEMAS") sendResponse({ fields: unmatchedSchemas(message.answers || []) });
    // These may open comboboxes and wait for their lists, so they answer later.
    if (message?.type === "UME_FILL") {
      fillAnswersAndOpenLists(message.answers || [], Boolean(message.diagnostics)).then(sendResponse, () => sendResponse(undefined));
      return true;
    }
    if (message?.type === "UME_APPLY_MAPPINGS") {
      applyMappings(message.mappings, message.values).then(sendResponse, () => sendResponse({ filled: 0 }));
      return true;
    }
    return false;
  }

  const previousListener = globalThis.__umeContentListener;
  if (previousListener) {
    try {
      api.runtime.onMessage.removeListener(previousListener);
    } catch (_error) {
      // The earlier copy belongs to an extension instance that no longer exists.
    }
  }
  globalThis.__umeContentListener = handleMessage;
  api.runtime.onMessage.addListener(handleMessage);
})();
