# Form eval

Replays saved real-world forms in WebKit and scores what Umete's local matching fills, so matching can be measured without filling out forms by hand.

```bash
cd eval
npm install
npx playwright install webkit
npm run fetch     # Chromium's autofill corpus into corpus/ (git-ignored)
npm run eval      # writes reports/<time>-<variant>.md and .json
```

`node run.js --only 017 --verbose` runs a single form.

### AI matching

`--ai dry` reports which fields local matching missed that Fill would ask the AI about, and how many requests that takes, without sending anything. `--ai openai` sends them to the OpenAI Decisions API with `OPENAI_API_KEY`, as **OpenAI Decisions (your key)** does: same questions, `gpt-6-luna` (or `--model`), the same 0.6 confidence cutoff, applied through `UME_APPLY_MAPPINGS`. [ai.js](ai.js) is a port of the app's Swift request code, so keep the two in step. A full run is about 530 requests across both variants.

### Scenarios

`node scenarios.js` fills pages that imitate one site's widgets closely, with their own scripts running, using answers typed in Settings (a phone with its country code, a date of birth, a gender), and checks each field. [scenarios/delta-passenger.html](scenarios/delta-passenger.html) is Delta's passenger form, whose dropdowns are `<button role="combobox">` lists. It exits non-zero on any wrong field.

## How it works

1. A fictional person ([persona/persona.json](persona/persona.json)) remembers [persona/learn-full.html](persona/learn-full.html) through the real content scripts (`UME_COLLECT`), as **Remember my answers** does.
2. Each corpus page opens with its own scripts and all network access off. The content scripts are injected and `UME_FILL` runs with those saved answers.
3. Each field Chromium labeled is compared with what the person should get ([expect.js](expect.js)).

Besides the Chromium pages, [fixtures/](fixtures) holds Umete's own small forms with hand-written labels (split phone boxes, dropdowns inside labels). They're committed and always run.

There are two variants. **learned** gets every answer from that one remembered form. **structured** learns name, email, phone, and company, and uses a structured address as entered in the app.

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

- The `.out` files are Chromium's own predictions kept as regression baselines, not hand-checked truth. Some are debatable, such as a gift recipient's email labeled `EMAIL_ADDRESS`.
- The pages are old static snapshots. They don't exercise shadow DOM, custom comboboxes, or forms built by JavaScript.
- Fields hidden on the saved page, and fields that already held the right value, are left out of the score.
