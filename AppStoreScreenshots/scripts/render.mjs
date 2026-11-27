// Renders the App Store screenshots (output/<locale>-6.3/<n>-<id>.png at 1206 × 2622
// and output/<locale>-6.9/… at 1320 × 2868), the product page header (output/header/<locale>/)
// and the search results card (output/search/<locale>/) with Playwright, from the
// Simulator captures in captures/ and the copy in config.mjs. Kaketa's renderer, with
// the bezel put on here rather than when capturing.
//
//   npm run render

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { bezel, duo, header, ipad, locales, screenshot, search, slides } from "../config.mjs";
import { fieldsCSS, fontFamily } from "./paper.mjs";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function dataURL(relative) {
  const file = resolve(here, relative);
  if (!existsSync(file)) throw new Error(`Missing ${file}; see README.md for how to make it.`);
  return `data:image/png;base64,${readFileSync(file).toString("base64")}`;
}

const bezelURL = dataURL(bezel.file);

// The fill captures predate the app icon's umber backdrop (the iPhone's and iPad's, the
// glass icon too): Umete's sheet in them still shows an older icon, so the app's icon is
// drawn over that tile. Its left, top and size in the capture's pixels; the sheet's own
// colour goes under it first, so none of the old tile's corners show round the new one.
const appIconURL = dataURL("../Safari/Ume/Shared (App)/Assets.xcassets/AppIcon.appiconset/AppIcon-256.png");
const sheetColour = "rgb(255 250 246)";
const iconPatches = {
  "captures/fill-sheet.png": { x: 90, y: 1633, size: 141 },
  "captures/ipad-fill.png": { x: 926, y: 224, size: 97 },
  "captures/duo-closed/fill-sheet.png": { x: 92, y: 1130, size: 138 },
};

// The phone: the capture in the bezel's screen opening, rounded to it so its corners
// stay under the bezel, at `width` pixels wide.
function phone(capture, width, style) {
  const scale = width / bezel.width;
  const { x, y, width: w, height: h, radius } = bezel.screen;
  return `<div style="position: absolute; ${style} width: ${width}px; height: ${bezel.height * scale}px;">
    <img src="${capture}" style="position: absolute; left: ${x * scale}px; top: ${y * scale}px; width: ${w * scale}px; height: ${h * scale}px; border-radius: ${radius * scale}px;">
    <img src="${bezelURL}" style="position: absolute; inset: 0; width: 100%; height: 100%;">
  </div>`;
}

// One page: the headline at the top, the whole phone below it, clear of the bottom.
function html({ width, height, hero, capture, locale }) {
  const { background, ink, device } = screenshot;
  const scale = width / screenshot.width;
  const deviceWidth = device.width * scale;
  const deviceHeight = (bezel.height / bezel.width) * deviceWidth;
  const heroSize = (locale === "ja" ? 92 : 104) * scale;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: ${background}; }
    .copy { position: absolute; z-index: 3; top: ${190 * scale}px; left: ${90 * scale}px; right: ${90 * scale}px; color: ${ink}; text-align: center; }
    h1 { margin: 0; font-family: ${fontFamily(locale)}; font-size: ${heroSize}px; font-weight: 600; line-height: 1.12; letter-spacing: ${locale === "ja" ? "0" : "-0.035em"}; }
    .shadow { position: absolute; z-index: 1; left: ${(width - deviceWidth) / 2 + 60 * scale}px; width: ${deviceWidth - 120 * scale}px; bottom: ${(device.bottom - 10) * scale}px; height: ${200 * scale}px; border-radius: 50%; background: rgb(48 54 43 / 22%); filter: blur(${56 * scale}px); }
  </style></head><body>
    <div class="copy"><h1>${hero}</h1></div>
    <div class="shadow"></div>
    ${phone(capture, deviceWidth, `z-index: 2; left: ${(width - deviceWidth) / 2}px; top: ${height - device.bottom * scale - deviceHeight}px;`)}
  </body></html>`;
}

function headerHTML({ width, height }, locale) {
  const { background, accent } = screenshot;
  const japanese = locale === "ja";
  // As tall as fits the height, but no wider than about the middle 55%, which the
  // store's crops of the wider size keep.
  const fontSize = Math.min(height * (japanese ? 0.42 : 0.36), width * (japanese ? 0.17 : 0.148));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: ${background}; }
    .paper { ${fieldsCSS(height)} }
    .paper::after { content: ""; position: absolute; inset: 0; background: radial-gradient(ellipse ${japanese ? 45 : 55}% 55% at 50% 50%, ${background} 40%, transparent 100%); }
    h1 { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; margin: 0; font-family: ${fontFamily(locale)}; font-weight: 600; font-size: ${fontSize}px; letter-spacing: ${japanese ? "0.06em" : "-0.03em"}; color: ${accent}; }
  </style></head><body><div class="paper"></div><h1>${header.text[locale]}</h1></body></html>`;
}

// The search card: the headline on the left, centered on the card's height; the phone
// on the right, its top on the card and its bottom off it.
function searchHTML({ width, height, hero, capture, locale }) {
  const { background, ink } = screenshot;
  const { device } = search;
  const margin = 260;
  const deviceLeft = width - margin - device.width;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: ${background}; }
    .paper { ${fieldsCSS(height)} }
    /* The fields fade out behind the headline so it reads first. */
    .paper::after { content: ""; position: absolute; inset: 0; background: linear-gradient(to right, ${background} 0%, ${background} 38%, transparent 62%); }
    .copy { position: absolute; z-index: 3; top: 50%; transform: translateY(-50%); left: ${margin}px; width: ${deviceLeft - margin - 120}px; color: ${ink}; }
    h1 { margin: 0; font-family: ${fontFamily(locale)}; font-size: ${locale === "ja" ? 220 : 230}px; font-weight: 600; line-height: 1.05; letter-spacing: ${locale === "ja" ? "0" : "-0.035em"}; }
    .shadow { position: absolute; z-index: 1; left: ${deviceLeft + 40}px; top: ${device.top + 60}px; width: ${device.width - 80}px; height: ${height}px; border-radius: 160px; background: rgb(48 54 43 / 18%); filter: blur(70px); }
  </style></head><body>
    <div class="paper"></div>
    <div class="copy"><h1>${hero}</h1></div>
    <div class="shadow"></div>
    ${phone(capture, device.width, `z-index: 2; left: ${deviceLeft}px; top: ${device.top}px;`)}
  </body></html>`;
}

// The iPad page: the headline, then the capture in a drawn frame, whole and clear of
// the bottom.
function ipadHTML({ hero, capture, locale }) {
  const { background, ink } = screenshot;
  const { width, height, frame } = ipad;
  const screenHeight = (ipad.capture.height / ipad.capture.width) * frame.screenWidth;
  const deviceWidth = frame.screenWidth + frame.bezel * 2;
  const left = (width - deviceWidth) / 2;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: ${background}; }
    .copy { position: absolute; z-index: 3; top: 190px; left: 120px; right: 120px; color: ${ink}; text-align: center; }
    h1 { margin: 0; font-family: ${fontFamily(locale)}; font-size: ${locale === "ja" ? 118 : 132}px; font-weight: 600; line-height: 1.08; letter-spacing: ${locale === "ja" ? "0" : "-0.035em"}; }
    .shadow { position: absolute; z-index: 1; left: ${left + 80}px; width: ${deviceWidth - 160}px; bottom: ${frame.bottom - 12}px; height: 220px; border-radius: 50%; background: rgb(48 54 43 / 22%); filter: blur(60px); }
    .device { position: absolute; z-index: 2; left: ${left}px; bottom: ${frame.bottom}px; width: ${deviceWidth}px; height: ${screenHeight + frame.bezel * 2}px; box-sizing: border-box; padding: ${frame.bezel}px; border-radius: ${frame.radius}px; background: #1c1c1e; box-shadow: inset 0 0 0 2px #3a3a3c; }
    .screen { display: block; width: ${frame.screenWidth}px; height: ${screenHeight}px; border-radius: ${frame.radius - frame.bezel}px; }
  </style></head><body>
    <div class="copy"><h1>${hero}</h1></div>
    <div class="shadow"></div>
    <div class="device"><img class="screen" src="${capture}"></div>
  </body></html>`;
}

// The closed iPhone Duo page: the headline, then the capture in its drawn frame.
function duoHTML({ hero, capture, locale }) {
  const { background, ink } = screenshot;
  const { width, height, screen, bezel: rimmed, rim, camera, layout } = duo;
  const shellWidth = screen.width + rimmed * 2;
  const shellHeight = screen.height + rimmed * 2;
  const scale = Math.min(layout.maxWidth / shellWidth, (layout.bottom - layout.top) / shellHeight);
  const left = (width - shellWidth * scale) / 2;
  const px = (value) => `${value * scale}px`;
  const corners = (extra) => `${px(screen.left + extra)} ${px(screen.right + extra)} ${px(screen.right + extra)} ${px(screen.left + extra)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: ${background}; }
    .copy { position: absolute; z-index: 3; top: 110px; left: 90px; right: 90px; color: ${ink}; text-align: center; }
    h1 { margin: 0; font-family: ${fontFamily(locale)}; font-size: ${locale === "ja" ? 92 : 104}px; font-weight: 600; line-height: 1.12; letter-spacing: ${locale === "ja" ? "0" : "-0.035em"}; }
    .shadow { position: absolute; z-index: 1; left: ${left + 60}px; right: ${left + 60}px; top: ${layout.top + shellHeight * scale - 130}px; height: 170px; border-radius: 50%; background: rgb(48 54 43 / 24%); filter: blur(46px); }
    .device { position: absolute; z-index: 2; left: ${left}px; top: ${layout.top}px; width: ${px(shellWidth)}; height: ${px(shellHeight)}; border-radius: ${corners(rimmed)}; background: #000; box-shadow: inset 0 0 0 ${px(3)} #9aa5b6, inset 0 0 0 ${px(rim)} #56657c; }
    .screen { position: absolute; left: ${px(rimmed)}; top: ${px(rimmed)}; width: ${px(screen.width)}; height: ${px(screen.height)}; border-radius: ${corners(0)}; }
    .camera { position: absolute; left: ${px(rimmed + camera.x - camera.diameter / 2)}; top: ${px(rimmed + camera.y - camera.diameter / 2)}; width: ${px(camera.diameter)}; height: ${px(camera.diameter)}; border-radius: 50%; background: #000; }
  </style></head><body>
    <div class="copy"><h1>${hero}</h1></div>
    <div class="shadow"></div>
    <div class="device"><img class="screen" src="${capture}"><div class="camera"></div></div>
  </body></html>`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function shoot(markup, width, height, file) {
  await page.setViewportSize({ width, height });
  await page.setContent(markup);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  mkdirSync(dirname(file), { recursive: true });
  await page.screenshot({ path: file, type: "png", clip: { x: 0, y: 0, width, height } });
  console.log(`Wrote ${file}`);
}

// A capture as a data URL, with the app's icon drawn into it where `iconPatches` has it.
async function captureURL(relative) {
  const patch = iconPatches[relative];
  if (!patch) return dataURL(relative);
  const { x, y, size } = patch;
  await page.setContent(`<!doctype html><html><body style="margin: 0;">
    <div id="capture" style="position: relative; width: max-content;">
      <img src="${dataURL(relative)}" style="display: block;">
      <div style="position: absolute; left: ${x - 1}px; top: ${y - 1}px; width: ${size + 2}px; height: ${size + 2}px; background: ${sheetColour};"></div>
      <img src="${appIconURL}" style="position: absolute; left: ${x}px; top: ${y}px; width: ${size}px; height: ${size}px; border-radius: ${size * 0.225}px;">
    </div></body></html>`);
  const { width, height } = await page.evaluate(() => {
    const capture = document.querySelector("#capture img");
    return { width: capture.naturalWidth, height: capture.naturalHeight };
  });
  await page.setViewportSize({ width, height });
  const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height } });
  return `data:image/png;base64,${png.toString("base64")}`;
}

for (const locale of locales) {
  for (const [index, slide] of slides.entries()) {
    const capture = await captureURL(slide.capture);
    for (const size of screenshot.sizes) {
      await shoot(
        html({ width: size.width, height: size.height, hero: slide.hero[locale], capture, locale }),
        size.width, size.height, join(here, "output", `${locale}-${size.suffix}`, `${index + 1}-${slide.id}.png`),
      );
    }
  }
  await shoot(
    searchHTML({ width: search.width, height: search.height, hero: search.hero[locale], capture: dataURL(search.capture), locale }),
    search.width, search.height, join(here, "output/search", locale, search.file),
  );
}
for (const locale of locales) {
  for (const size of header.sizes) {
    await shoot(headerHTML(size, locale), size.width, size.height, join(here, "output/header", locale, size.file));
  }
}
// The 13-inch iPad set.
for (const locale of locales) {
  for (const [index, slide] of slides.entries()) {
    await shoot(
      ipadHTML({ hero: slide.hero[locale], capture: await captureURL(ipad.captures[slide.id]), locale }),
      ipad.width, ipad.height, join(here, "output", `${locale}-${ipad.suffix}`, `${index + 1}-${slide.id}.png`),
    );
  }
}
// The closed iPhone Duo set.
for (const locale of locales) {
  for (const [index, slide] of slides.entries()) {
    await shoot(
      duoHTML({ hero: slide.hero[locale], capture: await captureURL(duo.captures[slide.id]), locale }),
      duo.width, duo.height, join(here, "output", `${locale}-${duo.suffix}`, `${index + 1}-${slide.id}.png`),
    );
  }
}
await browser.close();
