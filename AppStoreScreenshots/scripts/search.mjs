// The App Store search result video (iOS 27's Search Results asset), for each locale:
// output/search/<locale>/search.mp4, 3840×2560, muted, a 10 s loop. The still search
// card set in motion: Playwright draws the paper and each headline here, and
// scripts/search-video.py moves the phone, plays the fill recording on it, and encodes.
// Upload with asc (see README.md) or in App Store Connect → Asset Library.
//
//   npm run search

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { bezel, locales, screenshot, search } from "../config.mjs";
import { fieldsCSS, fontFamily } from "./paper.mjs";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { width, height } = search;
const { background, ink } = screenshot;
const video = search.video;

// The paper, its fields fading out on the left where the headline goes.
const paperHTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: ${background}; }
  .paper { ${fieldsCSS(height)} }
  .paper::after { content: ""; position: absolute; inset: 0; background: linear-gradient(to right, ${background} 0%, ${background} 38%, transparent 62%); }
</style></head><body><div class="paper"></div></body></html>`;

// One headline, alone on a clear page, centered on the card's height.
function lineHTML(text, locale) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: transparent; }
    h1 { position: absolute; top: 50%; transform: translateY(-50%); left: ${video.margin}px; margin: 0; white-space: nowrap; color: ${ink};
      font-family: ${fontFamily(locale)}; font-size: ${video.fontSize[locale]}px; font-weight: 600; line-height: 1.05; letter-spacing: ${locale === "ja" ? "0" : "-0.035em"}; }
  </style></head><body><h1>${text}</h1></body></html>`;
}

const work = mkdtempSync(join(tmpdir(), "umete-search-"));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width, height } });
  async function shoot(markup, file, transparent) {
    await page.setContent(markup);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: file, type: "png", omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
  }
  const paper = join(work, "paper.png");
  await shoot(paperHTML, paper, false);
  const outputs = [];
  for (const locale of locales) {
    const lines = [];
    for (const [index, text] of video.lines[locale].entries()) {
      await page.setContent(lineHTML(text, locale));
      await page.evaluate(() => document.fonts.ready);
      const right = await page.evaluate(() => document.querySelector("h1").getBoundingClientRect().right);
      if (right > video.textRight) throw new Error(`${locale} line ${index + 1} reaches ${Math.round(right)} px, past ${video.textRight}, under the phone; shorten it or make fontSize smaller`);
      const file = join(work, `${locale}-${index + 1}.png`);
      await shoot(lineHTML(text, locale), file, true);
      lines.push(file);
    }
    const out = join(here, "output/search", locale, video.file);
    mkdirSync(dirname(out), { recursive: true });
    outputs.push({ lines, out });
  }
  await browser.close();

  const spec = join(work, "spec.json");
  writeFileSync(spec, JSON.stringify({
    width, height, paper, outputs,
    clip: join(here, video.clip),
    bezel: { ...bezel, file: resolve(here, bezel.file) },
    device: search.device,
    margin: video.margin,
  }));
  const run = spawnSync("/usr/bin/python3", [join(here, "scripts/search-video.py"), spec], { stdio: "inherit" });
  if (run.status !== 0) throw new Error("search-video.py failed");
} finally {
  await browser.close().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
