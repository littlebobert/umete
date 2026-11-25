// Renders the umete.jp landing page's carousel: each marketing screen's capture in a
// device frame on transparent, 900 px wide (the page shows it at most 300 CSS px), as
// output/landing/umete-landing-<id>.webp. Copy them to the site's assets/ to publish.
//
// The frame is the closed iPhone Duo, drawn as render.mjs draws it for the Duo's App
// Store screenshots, around captures/duo-closed/. With --iphone, the iPhone 18 Pro Max
// bezel around the iPhone captures instead.
//
//   npm run landing
//   npm run landing -- --iphone

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { bezel, duo, slides } from "../config.mjs";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(here, "output/landing");
mkdirSync(out, { recursive: true });
const iphone = process.argv.includes("--iphone");

function dataURL(relative) {
  const file = resolve(here, relative);
  if (!existsSync(file)) throw new Error(`Missing ${file}; see README.md for how to make it.`);
  return `data:image/png;base64,${readFileSync(file).toString("base64")}`;
}

const width = 900;

function iphoneHTML(slide) {
  const scale = width / bezel.width;
  const height = Math.round(bezel.height * scale);
  const { x, y, width: w, height: h, radius } = bezel.screen;
  return {
    height,
    markup: `<!doctype html><html><body style="margin:0;background:transparent">
    <div style="position:relative;width:${width}px;height:${height}px">
      <img src="${dataURL(slide.capture)}" style="position:absolute;left:${x * scale}px;top:${y * scale}px;width:${w * scale}px;height:${h * scale}px;border-radius:${radius * scale}px">
      <img src="${dataURL(bezel.file)}" style="position:absolute;inset:0;width:100%;height:100%">
    </div></body></html>`,
  };
}

// The closed Duo: the capture in its drawn shell, the hinge side (left) nearly square,
// the open side round, a thin rim, and the camera.
function duoHTML(slide) {
  const { screen, bezel: rimmed, rim, camera } = duo;
  const shellWidth = screen.width + rimmed * 2;
  const shellHeight = screen.height + rimmed * 2;
  const scale = width / shellWidth;
  const height = Math.round(shellHeight * scale);
  const px = (value) => `${value * scale}px`;
  const corners = (extra) => `${px(screen.left + extra)} ${px(screen.right + extra)} ${px(screen.right + extra)} ${px(screen.left + extra)}`;
  return {
    height,
    markup: `<!doctype html><html><head><style>
    html, body { margin: 0; background: transparent; }
    .device { position: relative; width: ${px(shellWidth)}; height: ${px(shellHeight)}; border-radius: ${corners(rimmed)}; background: #000; box-shadow: inset 0 0 0 ${px(3)} #9aa5b6, inset 0 0 0 ${px(rim)} #56657c; }
    .screen { position: absolute; left: ${px(rimmed)}; top: ${px(rimmed)}; width: ${px(screen.width)}; height: ${px(screen.height)}; border-radius: ${corners(0)}; }
    .camera { position: absolute; left: ${px(rimmed + camera.x - camera.diameter / 2)}; top: ${px(rimmed + camera.y - camera.diameter / 2)}; width: ${px(camera.diameter)}; height: ${px(camera.diameter)}; border-radius: 50%; background: #000; }
  </style></head><body>
    <div class="device"><img class="screen" src="${dataURL(duo.captures[slide.id])}"><div class="camera"></div></div>
  </body></html>`,
  };
}

const browser = await chromium.launch();
for (const slide of slides) {
  const { height, markup } = iphone ? iphoneHTML(slide) : duoHTML(slide);
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width, height } });
  await page.setContent(markup);
  await page.waitForTimeout(100);
  const png = join(out, `umete-landing-${slide.id}.png`);
  await page.screenshot({ path: png, omitBackground: true });
  await page.close();
  const webp = png.replace(/\.png$/, ".webp");
  execFileSync("cwebp", ["-quiet", "-q", "86", "-alpha_q", "100", png, "-o", webp]);
  rmSync(png);
  console.log(`Wrote ${webp} (${width} × ${height})`);
}
await browser.close();
