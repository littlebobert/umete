// What the test person's answers should put in a field of each Chromium type.
//
// Each type is one of:
//   { accept: [...] }  the field should be filled with one of these values
//   SENSITIVE          the field must never be filled (payment, one-time codes)
//   NONE               the person has no answer for it, so it should stay empty
//   REVIEW             a fill may be fine or not; it's listed for a person to judge
// Types not listed here, UNKNOWN_TYPE included, are NONE, but a fill there is
// reported for review rather than counted wrong: Chromium leaves many fields
// it doesn't autofill (confirm email, "name on account") as UNKNOWN_TYPE.

const SENSITIVE = { sensitive: true };
const NONE = { none: true };
const REVIEW = {};

function expectations(person) {
  const { phone, address: a } = person;
  const local = `${phone.areaCode}${phone.prefix}${phone.suffix}`;
  // Chromium labels each box of a split number with the whole number's type
  // and fills it by maxlength, so any box-sized run of the number counts too.
  const phoneRule = (accept, extra = {}) => ({ accept, digits: true, whole: local, ...extra });
  const tenDigit = phoneRule([local, `${phone.countryCode}${local}`]);
  return {
    NAME_FIRST: { accept: [person.firstName] },
    NAME_LAST: { accept: [person.lastName] },
    NAME_FULL: { accept: [`${person.firstName} ${person.lastName}`, `${person.lastName} ${person.firstName}`] },
    EMAIL_ADDRESS: { accept: [person.email] },
    COMPANY_NAME: { accept: [person.company] },

    ADDRESS_HOME_LINE1: { accept: [a.addressLine1] },
    ADDRESS_HOME_LINE2: { accept: [a.addressLine2] },
    ADDRESS_HOME_STREET_ADDRESS: { accept: [`${a.addressLine1} ${a.addressLine2}`, a.addressLine1] },
    ADDRESS_HOME_HOUSE_NUMBER: { accept: [a.houseNumber] },
    ADDRESS_HOME_STREET_NAME: { accept: [a.streetName] },
    ADDRESS_HOME_CITY: { accept: [a.locality] },
    ADDRESS_HOME_STATE: { accept: [a.administrativeArea, a.administrativeAreaName] },
    ADDRESS_HOME_ZIP: { accept: [a.postalCode] },
    ADDRESS_HOME_ZIP_PREFIX: { accept: [a.postalCode] },
    ADDRESS_HOME_COUNTRY: { accept: [a.countryCode, a.countryName, "USA", "United States of America", "U.S.A.", "US - United States"] },

    PHONE_HOME_WHOLE_NUMBER: tenDigit,
    PHONE_HOME_CITY_AND_NUMBER: tenDigit,
    PHONE_HOME_CITY_AND_NUMBER_WITHOUT_TRUNK_PREFIX: tenDigit,
    PHONE_HOME_CITY_CODE: phoneRule([phone.areaCode]),
    PHONE_HOME_CITY_CODE_WITH_TRUNK_PREFIX: phoneRule([phone.areaCode]),
    PHONE_HOME_NUMBER: phoneRule([`${phone.prefix}${phone.suffix}`]),
    PHONE_HOME_NUMBER_PREFIX: phoneRule([phone.prefix]),
    PHONE_HOME_NUMBER_SUFFIX: phoneRule([phone.suffix]),
    PHONE_HOME_COUNTRY_CODE: { accept: [phone.countryCode], digits: true, countryCode: true },

    CREDIT_CARD_NUMBER: SENSITIVE,
    // The name on a card is the person's own name, not a card detail.
    CREDIT_CARD_NAME_FULL: REVIEW,
    CREDIT_CARD_NAME_FIRST: REVIEW,
    CREDIT_CARD_NAME_LAST: REVIEW,
    CREDIT_CARD_EXP_MONTH: SENSITIVE,
    CREDIT_CARD_EXP_2_DIGIT_YEAR: SENSITIVE,
    CREDIT_CARD_EXP_4_DIGIT_YEAR: SENSITIVE,
    CREDIT_CARD_EXP_DATE_2_DIGIT_YEAR: SENSITIVE,
    CREDIT_CARD_EXP_DATE_4_DIGIT_YEAR: SENSITIVE,
    CREDIT_CARD_VERIFICATION_CODE: SENSITIVE,
    CREDIT_CARD_TYPE: SENSITIVE,

    // Chromium also uses this for captchas; any saved answer there is wrong.
    ONE_TIME_CODE: NONE,

    NAME_MIDDLE: NONE,
    NAME_MIDDLE_INITIAL: NONE,
    NAME_HONORIFIC_PREFIX: NONE,
    NAME_LAST_FIRST: NONE,
    NAME_LAST_SECOND: NONE,
    ADDRESS_HOME_LINE3: NONE,
    ADDRESS_HOME_DEPENDENT_LOCALITY: NONE,
    ADDRESS_HOME_ZIP_SUFFIX: NONE,
    PHONE_HOME_EXTENSION: NONE,
    MERCHANT_PROMO_CODE: NONE,
    SEARCH_TERM: NONE,
    PRICE: NONE,
    LOYALTY_MEMBERSHIP_ID: NONE
  };
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const digitsOnly = (value) => String(value ?? "").replace(/\D/g, "");

// A filled control's candidate readings: its value, and for a select the
// chosen option's text too, since sites put "CA" or "California" in either.
function matches(rule, readings, optionText = "", maxLength = -1) {
  if (rule.digits) {
    const wanted = rule.accept.map(digitsOnly);
    return readings.some((reading) => {
      const digits = digitsOnly(reading);
      if (wanted.includes(digits)) return true;
      if (rule.whole && maxLength > 0 && maxLength < rule.whole.length
          && digits.length >= 3 && digits.length <= maxLength && rule.whole.includes(digits)) return true;
      // A calling-code select such as "United States (+1)".
      return rule.countryCode && new RegExp(`\\+${wanted[0]}(?!\\d)`).test(reading);
    });
  }
  const wanted = rule.accept.map(normalize);
  if (readings.some((reading) => wanted.includes(normalize(reading)))) return true;
  // Option text often pairs a code with a name ("CA - California").
  return Boolean(optionText) && wanted.some((value) => ` ${normalize(optionText)} `.includes(` ${value} `));
}

module.exports = { expectations, matches, normalize };
