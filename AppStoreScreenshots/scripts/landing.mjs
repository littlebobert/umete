// Renders the umete.jp landing page's carousel: each marketing screen's capture in the
// iPhone bezel on transparent, 900 px wide (the page shows it at most 300 CSS px), as
// output/landing/umete-landing-<id>.webp. Copy them to the site's assets/ to publish.
//
//   npm run landing

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { bezel, slides } from "../config.mjs";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(here, "output/landing");
mkdirSync(out, { recursive: true });

function dataURL(relative) {
  const file = resolve(here, relative);
  if (!existsSync(file)) throw new Error(`Missing ${file}; see README.md for how to make it.`);
  return `data:image/png;base64,${readFileSync(file).toString("base64")}`;
}

const width = 900;
const scale = width / bezel.width;
const height = Math.round(bezel.height * scale);
const { x, y, width: w, height: h, radius } = bezel.screen;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width, height } });
for (const slide of slides) {
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
    <div style="position:relative;width:${width}px;height:${height}px">
      <img src="${dataURL(slide.capture)}" style="position:absolute;left:${x * scale}px;top:${y * scale}px;width:${w * scale}px;height:${h * scale}px;border-radius:${radius * scale}px">
      <img src="${dataURL(bezel.file)}" style="position:absolute;inset:0;width:100%;height:100%">
    </div></body></html>`);
  const png = join(out, `umete-landing-${slide.id}.png`);
  await page.screenshot({ path: png, omitBackground: true });
  const webp = png.replace(/\.png$/, ".webp");
  execFileSync("cwebp", ["-quiet", "-q", "86", "-alpha_q", "100", png, "-o", webp]);
  rmSync(png);
  console.log(`Wrote ${webp} (${width} × ${height})`);
}
await browser.close();
