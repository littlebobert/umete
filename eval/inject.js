const fs = require("node:fs");
const path = require("node:path");

const EXTENSION = path.join(__dirname, "..", "Extension");
const CONTENT_SCRIPT_FILES = ["lib/matcher.js", "lib/dom.js", "lib/date.js", "lib/phone.js", "content.js"];

// Stands in for Safari's extension API: content.js only registers a message
// listener, which the runner then calls directly.
const SHIM = `
  globalThis.browser = {
    runtime: {
      onMessage: {
        addListener(listener) { globalThis.__umeEvalListener = listener; },
        removeListener() {}
      }
    }
  };
  globalThis.__umeEvalSend = (message) => new Promise((resolve) => {
    const returned = globalThis.__umeEvalListener(message, {}, resolve);
    if (returned !== true) setTimeout(() => resolve(undefined), 0);
  });
`;

// Umete's content scripts run through Playwright's evaluate, so they work
// whether or not the page's own scripts are on.
const UMETE_SOURCES = [SHIM, ...CONTENT_SCRIPT_FILES.map((file) => fs.readFileSync(path.join(EXTENSION, file), "utf8"))];

async function injectUmete(page) {
  await page.evaluate((sources) => {
    for (const source of sources) new Function(source)();
  }, UMETE_SOURCES);
}

module.exports = { injectUmete };
