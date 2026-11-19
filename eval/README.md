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

## Caveats

- The `.out` files are Chromium's own predictions kept as regression baselines, not hand-checked truth. Some are debatable, such as a gift recipient's email labeled `EMAIL_ADDRESS`.
- The pages are old static snapshots. They don't exercise shadow DOM, custom comboboxes, or forms built by JavaScript.
- Only local matching is scored. The AI step (`UME_SCHEMAS`, then the native app) isn't run yet.
