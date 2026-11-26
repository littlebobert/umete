# Form eval

Replays saved real-world forms in WebKit and scores what Umete's local matching fills, so matching can be measured without filling out forms by hand.

```bash
cd eval
npm install
npx playwright install webkit
npm run fetch     # Chromium's and Firefox's test pages into corpus/ (git-ignored)
npm run eval      # writes reports/<time>-<variant>.md and .json
```

`node run.js --only 017 --verbose` runs a single form, and `--corpus chromium` or `--corpus firefox` runs one corpus (Umete's fixtures always run). Reports give totals for each corpus as well as overall.

### AI matching

`--ai dry` reports which fields local matching missed that Fill would ask the AI about, and how many requests that takes, without sending anything. `--ai openai` sends them to the OpenAI Decisions API with `OPENAI_API_KEY`, as **OpenAI Decisions (your key)** does: same questions, `gpt-6-luna` (or `--model`), the same 0.6 confidence cutoff, applied through `UME_APPLY_MAPPINGS`. [ai.js](ai.js) is a port of the app's Swift request code, so keep the two in step. A full run is about 530 requests across both variants.

### Scenarios

`node scenarios.js` fills pages that imitate one site's widgets closely, with their own scripts running, using answers typed in Settings (a phone with its country code, a date of birth, a gender), and checks each field. [scenarios/delta-passenger.html](scenarios/delta-passenger.html) is Delta's passenger form, whose dropdowns are `<button role="combobox">` lists. [scenarios/aa-booking.html](scenarios/aa-booking.html) is the traveler form of American's booking flow, whose Gender, Title, and Loyalty program comboboxes show their options only once opened, in a list put at the end of the page; Gender must be filled and every list closed again. [scenarios/aa-passport.html](scenarios/aa-passport.html) is American's profile, whose dropdowns sit in `<adc-select>` shadow roots and are named only "month", "day", and "year", with a date of birth and a passport expiration date. It runs twice: with typed answers only, the expiration date must stay empty; with a saved passport too, its number, expiration date, and nationality fill, and the date of birth still goes only to its own dropdowns. Then Remember my answers on the filled page must give back one passport, new or updated in place. It exits non-zero on any wrong field.

## How it works

1. A fictional person ([persona/persona.json](persona/persona.json)) remembers [persona/learn-full.html](persona/learn-full.html) through the real content scripts (`UME_COLLECT`) and `rememberAnswers`, as **Remember my answers** does: the form's address fields become one structured address answer.
2. Each corpus page opens with its own scripts and all network access off. The content scripts are injected and `UME_FILL` runs with those saved answers.
3. Each labeled field is compared with what the person should get ([expect.js](expect.js)).

## Corpora

**Chromium** (`fetch-chromium.sh`): about 180 saved pages from Chromium's autofill tests, each with a `.out` file of the field types Chromium predicts.

**Firefox** (`fetch-firefox.sh`): 46 saved checkout, shipping, and sign-in pages from 19 retailers (Best Buy, Costco, Home Depot, Walmart, and others), from Firefox's form autofill tests. Firefox's tests list the fields it finds on each page in order, by autocomplete name, without saying which element each is. [firefox-labels.js](firefox-labels.js) drafts a Chromium-style `.out` for each page by lining those up with the page's controls, and the drafts were then checked by hand and committed in [labels/firefox/](labels/firefox): fields Firefox misses (passwords, a membership number) were added, and fields it gets wrong were corrected, such as an address nickname it calls an address line, a captcha it calls a card security code, and a ZIP+4 box it calls a postal code. Each changed line says what Firefox said. The pages themselves aren't open source, so like Chromium's they're fetched rather than committed. Card fields Firefox finds inside payment iframes aren't labeled, since Fill doesn't reach into those.

Besides the corpora, [fixtures/](fixtures) holds Umete's own small forms with hand-written labels (split phone boxes, dropdowns inside labels, and older layouts: labels in the cell beside a field, validation messages inside a label, area code and exchange boxes, "Name" before "Surname", an apartment box before a second address line, labels in a row above their fields, starting values that name a field, and Japanese and Korean sign-up forms whose fields only their labels describe). They're committed and always run.

There are two variants. **learned** gets every answer from that one remembered form, its address folded into one structured answer as Remember does. **structured** learns name, email, phone, and company, and uses a structured address as entered in the app.

## Outcomes

| Outcome | Meaning |
|---|---|
| correct | filled with the right value |
| wrong | filled with the wrong value, or filled when the person has no answer for that field |
| sensitive fill | a password or card number, expiry, CVC, or card type got a value; this fails the run |
| missed | the person had an answer, but the field was left empty |
| review | filled a field Chromium calls `UNKNOWN_TYPE` or a card name; it may be fine |
| unmapped | a labeled field couldn't be found on the page |
| hidden | the field isn't visible on the saved page, so Umete rightly skips it |
| already set | the field already held the right value before Fill |

## Caveats

- Chromium's `.out` files are its own predictions kept as regression baselines, not hand-checked truth. Some are debatable, such as a gift recipient's email labeled `EMAIL_ADDRESS`.
- The pages of both corpora are old static snapshots. They don't exercise shadow DOM, custom comboboxes, or forms built by JavaScript.
- Fields hidden on the saved page, and fields that already held the right value, are left out of the score.
