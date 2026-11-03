// Draws the umete.jp landing page's icon as a pencil sketch flipbook, in the way of
// Karui's (Scripts/make-landing-sketch.mjs there): a bud opens into a plum blossom, its
// petals fall as the fruit swells, the fruit is shaded in, and after a while it drops
// and the next bud comes. Each drawing is redrawn with fresh wobble, a few alternating
// takes for what holds still, so it boils like pencil on paper. Writes
// output/landing/umete-icon-sketch.mp4, and the finished fruit as umete-icon-sketch.jpg
// for no motion; copy both to the site's assets/ to publish.
//
//   npm run sketch

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(here, "output/landing");
mkdirSync(out, { recursive: true });

const fps = 12;
// Drawn large for its detail, then brought down to 3.5 times the page's 64-point icon.
const drawnSize = 560;
const outputSize = 224;
// Fine lines go pale when brought down that far: deepens the pencil and leaves the paper.
const deepen = "curves=all='0/0 0.45/0.2 0.72/0.6 0.86/0.86 1/1'";
const graphite = "#34342f";
const paper = "#f5f1e9";
// Mostly pencil, as Karui's is: greys for the fruit, leaf, and petals, and its one red for
// the blossom's eye and the fruit's blush.
const fruitTone = "#a3a199";
const fruitShade = "#7c7a72";
const leafTone = "#6a6862";
const petalTone = "#bdbab2";
const red = "#d63a2c";

let seed = 11;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const j = (a) => (rand() - 0.5) * 2 * a;
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const line = (a, b, n = 8) => Array.from({ length: n + 1 }, (_, i) => lerp(a, b, i / n));
function bez(p0, c1, c2, p1, n = 10) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, u = 1 - t;
    return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * p1[k]);
  });
}
const pathOf = (points) => `M${points.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L")}Z`;

// One pressed line as a filled shape: thin where the pencil lands and lifts, fuller in the
// middle, with the pressure drifting along the way. As in Karui's.
function brush(points, width, opacity, { color = graphite, wobble = 2.5, shift = 2, overshoot = 6, heavy = 0.6 } = {}) {
  const ox = j(shift), oy = j(shift), phase = rand() * 6.28, freq = 0.012 + rand() * 0.01, drift = rand() * 6.28;
  const dense = [];
  points.forEach((p, i) => {
    dense.push(p);
    if (i < points.length - 1) dense.push(lerp(p, points[i + 1], 1 / 3), lerp(p, points[i + 1], 2 / 3));
  });
  let travelled = 0;
  const pts = dense.map((p, i) => {
    if (i) travelled += Math.hypot(p[0] - dense[i - 1][0], p[1] - dense[i - 1][1]);
    return [p[0] + ox + Math.sin(travelled * freq + phase) * wobble, p[1] + oy + Math.cos(travelled * freq * 1.3 + phase) * wobble];
  });
  const first = pts[0], next = pts[1], last = pts[pts.length - 1], before = pts[pts.length - 2];
  const reach = (p, q, by) => { const d = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1; return [p[0] + ((p[0] - q[0]) / d) * by, p[1] + ((p[1] - q[1]) / d) * by]; };
  pts.unshift(reach(first, next, rand() * overshoot));
  pts.push(reach(last, before, rand() * overshoot));
  const left = [], right = [];
  pts.forEach((p, i) => {
    const q = pts[Math.min(i + 1, pts.length - 1)], o = pts[Math.max(i - 1, 0)];
    const d = Math.hypot(q[0] - o[0], q[1] - o[1]) || 1, nx = -(q[1] - o[1]) / d, ny = (q[0] - o[0]) / d;
    const t = i / (pts.length - 1);
    const pressure = (1 - heavy + heavy * Math.sin(Math.PI * t) ** 0.55) * (0.82 + 0.18 * Math.sin(t * 9 + drift));
    const half = (width * pressure) / 2;
    left.push([p[0] + nx * half, p[1] + ny * half]);
    right.unshift([p[0] - nx * half, p[1] - ny * half]);
  });
  const outline = [...left, ...right];
  let d = `M${outline[0][0].toFixed(1)} ${outline[0][1].toFixed(1)}`;
  for (let i = 1; i < outline.length; i++) {
    const m = lerp(outline[i], outline[(i + 1) % outline.length], 0.5);
    d += `Q${outline[i][0].toFixed(1)} ${outline[i][1].toFixed(1)} ${m[0].toFixed(1)} ${m[1].toFixed(1)}`;
  }
  return `<path d="${d}Z" fill="${color}" opacity="${(opacity * (0.82 + rand() * 0.3)).toFixed(2)}"/>`;
}

// The fruit hangs from the stem's foot, round with a dip where the stem goes in.
const stemFoot = [512, 404];
const fruitCenter = [512, 615];
const fruitRadius = 255;
const fruitOutline = Array.from({ length: 49 }, (_, k) => {
  const a = -Math.PI / 2 + (k / 48) * Math.PI * 2;
  const fromTop = Math.abs(Math.atan2(Math.sin(a + Math.PI / 2), Math.cos(a + Math.PI / 2)));
  const dip = fromTop < 0.5 ? 40 * Math.cos((fromTop / 0.5) * (Math.PI / 2)) ** 2 : 0;
  return [fruitCenter[0] + fruitRadius * 1.03 * Math.cos(a), fruitCenter[1] + fruitRadius * 0.97 * Math.sin(a) + dip];
});
const stem = bez(stemFoot, [512, 340], [520, 280], [548, 226], 8);
const leafBase = [534, 292];
const leafTip = [800, 206];
const leafOutline = [...bez(leafBase, [580, 196], [720, 160], leafTip, 10), ...bez(leafTip, [740, 290], [610, 330], leafBase, 10).slice(1)];
// A petal pointing up from the blossom's middle, notched at its tip, in its own space.
const petalOutline = [
  ...bez([0, -8], [64, -40], [92, -128], [34, -166], 8),
  ...bez([34, -166], [16, -174], [5, -162], [0, -150], 3).slice(1),
  ...bez([0, -150], [-5, -162], [-16, -174], [-34, -166], 3).slice(1),
  ...bez([-34, -166], [-92, -128], [-64, -40], [0, -8], 8).slice(1),
];
const blossomCenter = [512, 540];
// The blossom and bud are drawn this much larger than their outlines.
const bloom = 1.35;

// The light comes from the upper right, as in Karui's: the fruit is toned in grey, with a
// red blush and pencil shade on its lower left, and fewer strokes where it's lit. Each stroke
// keeps where it starts across, so colouring in can sweep from left to right.
function fruitColour() {
  const strokes = [];
  const slope = 0.58;
  const add = (x, svg) => strokes.push({ x, svg });
  for (let x = -80; x < 820; x += 16 + rand() * 6) {
    const top = 330 + rand() * 30, from = [x, 890], to = [x + (890 - top) * slope, top];
    add(x, brush(line(from, to, 4), 26, 0.45, { color: fruitTone, wobble: 2, overshoot: 0, heavy: 0.35 }));
  }
  for (let x = -80; x < 830; x += 7 + rand() * 3) {
    if (rand() < Math.max(0, (x - 420) / 420) * 0.45) continue;
    const top = 340 + rand() * 40, from = [x, 890 + j(6)], to = [x + (from[1] - top) * slope, top];
    add(x, brush(line(from, to, 4), 8, 0.85, { color: rand() < 0.3 ? fruitShade : fruitTone, wobble: 2, shift: 1, overshoot: 3 }));
  }
  // The blush, heaviest low on the left.
  for (let x = 20; x < 600; x += 9 + rand() * 4) {
    const top = 470 + rand() * 90 + Math.max(0, x - 380) * 0.5, from = [x, 880 + j(5)], to = [x + (from[1] - top) * slope, top];
    add(x, brush(line(from, to, 4), 9, 0.6 * Math.max(0.3, 1 - Math.max(0, x - 140) / 460), { color: red, wobble: 2, shift: 1, overshoot: 3 }));
  }
  // Pencil shade, crossed the other way, in the deepest part.
  for (let x = 220; x < 560; x += 9 + rand() * 4) {
    const top = 700 + rand() * 50 + (x - 220) * 0.18, from = [x + 80, 880 + j(4)], to = [x + 80 - (from[1] - top) * 0.72, top];
    add(x, brush(line(from, to, 3), 6, 0.7, { wobble: 1.5, shift: 1, overshoot: 2 }));
  }
  return strokes.sort((a, b) => a.x - b.x);
}

function fruitLines() {
  const seam = bez([520, 420], [600, 470], [628, 650], [560, 852], 8);
  return brush(fruitOutline, 19, 1, { wobble: 1.5, heavy: 0.5, overshoot: 4 })
    + brush(fruitOutline, 9, 0.85, { wobble: 3, shift: 3, overshoot: 12 })
    + brush(seam, 9, 0.55, { wobble: 2, heavy: 0.8, overshoot: 2 });
}

function castShadow() {
  let s = "";
  for (let i = 0; i < 12; i++) {
    const y = 868 + i * 3.4 + j(1.5), start = 300 - i * 2 + j(14), end = 760 - i * 12 + j(24);
    s += brush(line([start, y], [end, y + j(2)], 5), 8, 0.78 - i * 0.03, { wobble: 1.5, shift: 0.5, overshoot: 8 });
  }
  return s;
}

function stemAndLeaf() {
  let s = brush(stem, 22, 1, { heavy: 0.5, overshoot: 4 }) + brush(stem, 10, 0.85, { wobble: 2, shift: 2, overshoot: 8 });
  s += `<path d="${pathOf(leafOutline)}" fill="${paper}"/><g clip-path="url(#leaf)">`;
  for (let t = 0; t < 1; t += 0.035 + rand() * 0.015) {
    const at = lerp(leafBase, leafTip, t);
    s += brush(line([at[0] - 40, at[1] + 90], [at[0] + 30, at[1] - 90], 3), 9, 0.85, { color: leafTone, wobble: 1.5, shift: 1, overshoot: 0 });
  }
  s += "</g>";
  const rib = bez(leafBase, [620, 260], [700, 230], [780, 210], 8);
  return s + brush(leafOutline, 14, 1, { wobble: 1.5, heavy: 0.5, overshoot: 6 }) + brush(rib, 8, 0.8, { heavy: 0.8, overshoot: 0 });
}

function petal() {
  let s = `<path d="${pathOf(petalOutline)}" fill="${paper}"/><g clip-path="url(#petal)">`;
  for (let x = -70; x <= 70; x += 11 + rand() * 4) {
    s += brush(line([x * 0.25, -10], [x * 1.1, -168], 3), 9, 0.75, { color: petalTone, wobble: 1.5, shift: 1, overshoot: 0, heavy: 0.3 });
  }
  return `${s}</g>` + brush(petalOutline, 11, 0.95, { wobble: 1.5, heavy: 0.5, overshoot: 4 });
}

// The blossom at a scale, its petals flung out and falling by `scatter` (0 to 1).
function blossom(scale, scatter) {
  if (scale <= 0.02) return "";
  const [cx, cy] = blossomCenter;
  let s = "";
  for (let i = 0; i < 5; i++) {
    const angle = -90 + i * 72 + 8;
    const radians = ((angle - 90) * Math.PI) / 180;
    const fly = 200 * scatter, fall = 520 * scatter * scatter;
    const x = cx + Math.cos(radians) * fly, y = cy + Math.sin(radians) * fly + fall;
    const spin = angle + (i % 2 ? 1 : -1) * 70 * scatter;
    s += `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${spin.toFixed(1)}) scale(${(scale * bloom).toFixed(3)})" opacity="${(1 - scatter ** 2).toFixed(2)}">${petal()}</g>`;
  }
  if (scatter > 0.4) return s;
  // The middle: a red eye and dot-tipped stamens.
  s += `<g transform="translate(${cx} ${cy}) scale(${(scale * bloom * (1 - scatter * 2.5)).toFixed(3)})">`;
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + j(0.15), r = 58 + j(10), tip = [Math.cos(a) * r, Math.sin(a) * r];
    s += brush(line([0, 0], tip, 3), 5, 0.85, { wobble: 1, shift: 0.5, overshoot: 0 });
    s += brush(line(lerp([0, 0], tip, 0.92), tip, 2), 15, 1, { color: graphite, wobble: 0.5, shift: 1, overshoot: 0, heavy: 0.2 });
  }
  for (let i = 0; i < 4; i++) {
    const start = rand() * 6.28;
    const ring = Array.from({ length: 13 }, (_, k) => [Math.cos(start + (k / 12) * 6.6) * 20, Math.sin(start + (k / 12) * 6.6) * 20]);
    s += brush(ring, 14, 0.95, { color: red, wobble: 1.5, shift: 2, overshoot: 0 });
  }
  return `${s}</g>`;
}

function bud(scale) {
  if (scale <= 0.02) return "";
  const shape = [...bez([0, 0], [52, -18], [44, -96], [0, -122], 8), ...bez([0, -122], [-44, -96], [-52, -18], [0, 0], 8).slice(1)];
  // Hung from the stem's foot, pointing down, so it grows out of the stem.
  let s = `<g transform="translate(${stemFoot[0]} ${stemFoot[1] - 6}) scale(${(scale * bloom).toFixed(3)} ${(-scale * bloom).toFixed(3)})"><path d="${pathOf(shape)}" fill="${paper}"/>`;
  for (let y = -8; y > -118; y -= 10 + rand() * 3) {
    const half = 46 * Math.sin((Math.PI * -y) / 124);
    s += brush(line([-half, y + 8], [half, y - 8], 3), 11, 0.85, { color: petalTone, wobble: 1, shift: 1, overshoot: 0 });
  }
  return `${s}${brush(shape, 12, 1, { wobble: 1.5, heavy: 0.5, overshoot: 3 })}</g>`;
}

// The timing, in drawings at 12 a second. bud and blossom are scales, scatter how far the
// petals have gone, fruit the fruit's scale from the stem's foot, fill how much of it is
// coloured in, and fall how far it has dropped.
const easeOut = (t) => 1 - (1 - t) ** 3;
const timeline = [];
const bare = { bud: 0, blossom: 0, scatter: 0, fruit: 0, fill: 0, fall: 0 };
const at = (frame) => timeline.push({ ...bare, ...frame });
for (let i = 0; i < 3; i++) at({});
for (const bud of [0.3, 0.6, 0.85, 1, 1, 1, 1]) at({ bud });
for (const blossom of [0.35, 0.7, 1.08, 1.02, 1]) at({ blossom });
for (let i = 0; i < 10; i++) at({ blossom: 1 });
for (let i = 1; i <= 8; i++) at({ blossom: 1, scatter: i / 8, fruit: 0.2 + 0.8 * easeOut(i / 8) });
for (let i = 1; i <= 12; i++) at({ fruit: 1, fill: i / 12 });
const finished = { ...bare, fruit: 1, fill: 1 };
for (let i = 0; i < 26; i++) at(finished);
for (let i = 1; i <= 6; i++) at({ fruit: 1, fill: 1, fall: (i / 6) ** 2 });

const defs = `<defs>
<filter id="pencil" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.9 0.55" numOctaves="3" seed="4" result="grain"/>
<feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.6 2.05" result="tooth"/>
<feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="9" result="warp"/>
<feDisplacementMap in="SourceGraphic" in2="warp" scale="5" result="moved"/>
<feComposite in="moved" in2="tooth" operator="in"/>
</filter>
<filter id="paper" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="4" seed="21"/>
<feColorMatrix type="matrix" values="0 0 0 0 0.45  0 0 0 0 0.42  0 0 0 0 0.34  0 0 0 0.09 -0.03"/>
</filter>
<clipPath id="fruit"><path d="${pathOf(fruitOutline)}"/></clipPath>
<clipPath id="leaf"><path d="${pathOf(leafOutline)}"/></clipPath>
<clipPath id="petal"><path d="${pathOf(petalOutline)}"/></clipPath>
</defs>`;

// Takes of what holds still, alternating so its lines boil without every frame being new.
const takes = [0, 1, 2].map(() => ({ stem: stemAndLeaf(), fruit: fruitLines(), colour: fruitColour(), shadow: castShadow() }));

function page(frame, index, size) {
  seed = 1000 + index * 97;
  const take = takes[Math.floor(index / 2) % takes.length];
  let fruit = "";
  if (frame.fruit > 0) {
    const [fx, fy] = stemFoot;
    const reach = take.colour[0].x + (take.colour.at(-1).x - take.colour[0].x + 1) * frame.fill;
    const colour = take.colour.filter((stroke) => stroke.x < reach).map((stroke) => stroke.svg).join("");
    const drop = 700 * frame.fall, tilt = 25 * frame.fall;
    fruit = `<g transform="translate(0 ${drop.toFixed(1)}) rotate(${tilt.toFixed(1)} ${fx} ${fy + 210}) translate(${fx} ${fy}) scale(${frame.fruit.toFixed(3)}) translate(${-fx} ${-fy})">`
      + `<path d="${pathOf(fruitOutline)}" fill="${paper}"/><g clip-path="url(#fruit)">${colour}</g>${take.fruit}</g>`;
  }
  // The shadow grows with the fruit and goes as it drops.
  const shade = frame.fruit * (1 - frame.fall);
  const shadow = shade > 0.05 ? `<g opacity="${shade.toFixed(2)}" transform="translate(512 880) scale(${shade.toFixed(3)} 1) translate(-512 -880)">${take.shadow}</g>` : "";
  return `<!doctype html><body style="margin:0;background:${paper}"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}" style="display:block">${defs}
<rect width="1024" height="1024" fill="${paper}"/><rect width="1024" height="1024" filter="url(#paper)"/>
<g stroke="none" filter="url(#pencil)">
${shadow}${fruit}${take.stem}${blossom(frame.blossom, frame.scatter)}${bud(frame.bud)}
</g></svg></body>`;
}

const work = mkdtempSync(join(tmpdir(), "umete-sketch-"));
const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: drawnSize, height: drawnSize } });
for (const [index, frame] of timeline.entries()) {
  await tab.setContent(page(frame, index, drawnSize));
  await tab.screenshot({ path: join(work, `${String(index).padStart(4, "0")}.png`) });
}
await tab.setContent(page(finished, 0, drawnSize));
await tab.screenshot({ path: join(work, "still.png") });
await browser.close();

execFileSync("ffmpeg", ["-v", "error", "-y", "-framerate", String(fps), "-i", join(work, "%04d.png"),
  "-vf", `scale=${outputSize}:${outputSize}:flags=lanczos,${deepen},format=yuv420p`, "-r", "24", "-c:v", "libx264", "-profile:v", "high", "-crf", "22", "-preset", "slow",
  "-an", "-movflags", "+faststart", join(out, "umete-icon-sketch.mp4")]);
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(work, "still.png"), "-vf", `scale=${outputSize}:${outputSize}:flags=lanczos,${deepen}`, "-q:v", "2", "-update", "1",
  join(out, "umete-icon-sketch.jpg")]);
rmSync(work, { recursive: true, force: true });
console.log(`${timeline.length} drawings, ${(timeline.length / fps).toFixed(1)} s, in ${out}.`);
