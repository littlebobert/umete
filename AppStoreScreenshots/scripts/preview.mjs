// Assembles the App Previews (H.264 and AAC, 30 fps): output/preview/<locale>.mp4 for
// iPhone (886 × 1920), output/preview/<locale>-ipad.mp4 for iPad (1200 × 1600), and
// output/preview/<locale>-duo.mp4 for iPhone Duo (1920 × 886). Each scene's recording
// sits in a rounded frame under its caption (beside it on the Duo, in a drawn frame), on
// the screenshots' paper, crossfaded into the next, with that language's voice-over.
// Japanese comes from `npm run narrate`; English from voiceover/en-US/line-<n>.*
// when it's there, and otherwise the English preview is silent, timed like Japanese.
// All devices share the voice and the scene timing.
//
//   npm run preview           # or: npm run preview -- duo, for one device

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { locales, preview, screenshot } from "../config.mjs";
import { seconds } from "./narrate.mjs";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = join(here, "output/preview/work");
mkdirSync(work, { recursive: true });

const { fps, tail, crossfade } = preview;
// The voice starts this long into its scene.
const lead = 0.4;

// Each device: its page size, where the recording's frame sits (its width, its height
// from the screen's shape, set at the bottom with a margin; the caption fills the band
// above), the corner radius, the caption size, and its recordings.
const formats = [
  {
    id: "iphone",
    suffix: "",
    width: preview.width,
    height: preview.height,
    screen: { width: 720, aspect: 2868 / 1320, bottom: 64, radius: Math.round(190 * (720 / 1320)) },
    captionSize: { "en-US": 64, ja: 56 },
    scenes: preview.scenes,
  },
  {
    id: "ipad",
    suffix: "-ipad",
    width: preview.ipad.width,
    height: preview.ipad.height,
    screen: { width: 900, aspect: 2752 / 2064, bottom: 56, radius: 36 },
    captionSize: { "en-US": 60, ja: 52 },
    scenes: preview.scenes.map((scene, index) => ({ ...scene, ...preview.ipad.scenes[index] })),
  },
  {
    id: "duo",
    suffix: "-duo",
    width: preview.duo.width,
    height: preview.duo.height,
    // 0.364 of the closed Duo's display, on the right; the caption fills the left.
    screen: { width: 508, aspect: 740 / 508, left: 1066, top: 73, corners: "8px 63px 63px 8px", bezel: 23, rim: 5 },
    side: true,
    captionSize: { "en-US": 76, ja: 66 },
    locales: preview.duo.locales,
    voiceEnd: preview.duo.voiceEnd,
    scenes: preview.scenes.map((scene, index) => ({ ...scene, ...preview.duo.scenes[index] })),
  },
].filter((format) => !process.argv[2] || format.id === process.argv[2]).map((format) => {
  const height = Math.round((format.screen.width * format.screen.aspect) / 2) * 2;
  return {
    ...format,
    locales: format.locales ?? locales,
    frame: {
      width: format.screen.width,
      height,
      left: format.screen.left ?? (format.width - format.screen.width) / 2,
      top: format.screen.top ?? format.height - height - format.screen.bottom,
      radius: format.screen.corners ?? `${format.screen.radius}px`,
    },
  };
});

function probe(file) {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
}

function voiceover(locale, index) {
  const folder = locale === "ja" ? join(here, "output/preview/narration/ja") : join(here, "voiceover", locale);
  if (!existsSync(folder)) return null;
  const file = readdirSync(folder).find((name) => new RegExp(`^line-${index + 1}\\.(m4a|mp3|wav|aiff?)$`).test(name));
  return file ? join(folder, file) : null;
}

// The backgrounds with their captions, and the masks that round the recordings' corners.
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function still(markup, width, height, file) {
  await page.setViewportSize({ width, height });
  await page.setContent(markup);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, omitBackground: true });
}
const font = (locale) => locale === "ja" ? `"Hiragino Mincho ProN", serif` : `"New York", "Iowan Old Style", Georgia, serif`;
for (const format of formats) {
  const { width, height, frame, screen } = format;
  // On the Duo, the caption is beside the device, in its drawn frame.
  const captionBox = format.side
    ? `left: 90px; width: ${frame.left - screen.bezel - 170}px; top: 0; height: ${height}px;`
    : `left: 60px; right: 60px; top: 0; height: ${frame.top}px;`;
  const shell = format.side
    ? `<div style="position: absolute; left: ${frame.left - screen.bezel}px; top: ${frame.top - screen.bezel}px; width: ${frame.width + screen.bezel * 2}px; height: ${frame.height + screen.bezel * 2}px; border-radius: 31px 86px 86px 31px; background: #000; box-shadow: inset 0 0 0 1px #9aa5b6, inset 0 0 0 ${screen.rim}px #56657c;"></div>`
    : "";
  for (const locale of format.locales) {
    for (const [index, scene] of format.scenes.entries()) {
      await still(`<!doctype html><html><head><meta charset="utf-8"><style>
        html, body { margin: 0; width: ${width}px; height: ${height}px; background: ${screenshot.background}; }
        h1 { position: absolute; ${captionBox} margin: 0; display: flex; align-items: center; justify-content: center; text-align: center; font-family: ${font(locale)}; font-size: ${format.captionSize[locale]}px; font-weight: 600; line-height: 1.15; letter-spacing: ${locale === "ja" ? "0" : "-0.03em"}; color: ${screenshot.ink}; text-wrap: balance; word-break: ${locale === "ja" ? "keep-all" : "normal"}; }
        .shadow { position: absolute; left: ${frame.left + 30}px; top: ${frame.top + 40}px; width: ${frame.width - 60}px; height: ${frame.height - 20}px; border-radius: ${frame.radius}; background: rgb(48 54 43 / 25%); filter: blur(36px); }
      </style></head><body><h1>${scene.caption[locale]}</h1><div class="shadow"></div>${shell}</body></html>`, width, height, join(work, `bg-${format.id}-${locale}-${index + 1}.png`));
    }
  }
  await still(`<!doctype html><html><body style="margin:0;background:transparent"><div style="width:${frame.width}px;height:${frame.height}px;border-radius:${frame.radius};background:#fff"></div></body></html>`, frame.width, frame.height, join(work, `mask-${format.id}.png`));
}
await browser.close();

// Scene lengths come from the Japanese voice unless a language has its own.
function lengths(locale, format) {
  return format.scenes.map((scene, index) => {
    const voice = voiceover(locale, index) ?? voiceover("ja", index);
    const end = format.voiceEnd?.[locale]?.[index + 1] ?? Infinity;
    const spoken = voice ? lead + Math.min(seconds(voice), end) + tail : 0;
    return Math.max(spoken, scene.minimum ?? 0, 3);
  });
}

// The recording at a steady frame rate, or only its `keep` stretches, joined.
function source(scene) {
  if (!scene.keep) return `[1:v]fps=${fps}`;
  const parts = scene.keep.map((_, index) => `[k${index}]`);
  return `[1:v]fps=${fps},split=${scene.keep.length}${parts.join("")};` +
    scene.keep.map(([from, to], index) => `[k${index}]trim=${from}:${to},setpts=PTS-STARTPTS[t${index}]`).join(";") + ";" +
    scene.keep.map((_, index) => `[t${index}]`).join("") + `concat=n=${scene.keep.length}:v=1:a=0`;
}

for (const format of formats) {
  const { frame } = format;
  for (const locale of format.locales) {
    const durations = lengths(locale, format);
    // Each scene: the recording at a steady 30 fps, cut or held on its last frame to
    // its length, rounded, over its background.
    const scenes = format.scenes.map((scene, index) => {
      const out = join(work, `scene-${format.id}-${locale}-${index + 1}.mp4`);
      const duration = durations[index] + (index < format.scenes.length - 1 ? crossfade : 0);
      execFileSync("ffmpeg", [
        "-loglevel", "error", "-y",
        "-loop", "1", "-i", join(work, `bg-${format.id}-${locale}-${index + 1}.png`),
        "-i", join(here, scene.clip),
        "-loop", "1", "-i", join(work, `mask-${format.id}.png`),
        "-filter_complex",
        `${source(scene)}[src];[src]scale=${frame.width}:${frame.height},tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS,format=rgba[clip];` +
        `[2:v]format=gray,trim=duration=${duration}[mask];[clip][mask]alphamerge[rounded];` +
        `[0:v]trim=duration=${duration},fps=${fps}[bg];[bg][rounded]overlay=${frame.left}:${frame.top}:shortest=1,format=yuv420p[v]`,
        "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-r", String(fps), out,
      ]);
      return { out, duration };
    });

    // Crossfade the scenes, and lay each line of the voice-over at its scene's start.
    const inputs = scenes.flatMap(({ out }) => ["-i", out]);
    let video = "[0:v]";
    let offset = 0;
    const filters = [];
    const starts = [0];
    for (let index = 1; index < scenes.length; index += 1) {
      offset += scenes[index - 1].duration - crossfade;
      starts.push(offset);
      filters.push(`${video}[${index}:v]xfade=transition=fade:duration=${crossfade}:offset=${offset.toFixed(3)}[x${index}]`);
      video = `[x${index}]`;
    }
    const total = offset + scenes.at(-1).duration;
    const voices = format.scenes.map((_, index) => voiceover(locale, index));
    const audioInputs = [];
    const delayed = [];
    voices.forEach((file, index) => {
      if (!file) return;
      const input = scenes.length + audioInputs.length / 2;
      audioInputs.push("-i", file);
      const delay = Math.round((starts[index] + lead) * 1000);
      // A line can be cut short, with a quick fade, to lose what follows the speech.
      const end = format.voiceEnd?.[locale]?.[index + 1];
      const cut = end ? `atrim=end=${end},afade=t=out:st=${end - 0.12}:d=0.12,` : "";
      filters.push(`[${input}:a]${cut}aresample=48000,aformat=channel_layouts=stereo,adelay=${delay}|${delay}[a${index}]`);
      delayed.push(`[a${index}]`);
    });
    const silence = scenes.length + audioInputs.length / 2;
    filters.push(`${delayed.join("")}[${silence}:a]amix=inputs=${delayed.length + 1}:normalize=0:duration=longest,atrim=duration=${total.toFixed(3)}[a]`);
    const file = join(here, "output/preview", `${locale}${format.suffix}.mp4`);
    execFileSync("ffmpeg", [
      "-loglevel", "error", "-y", ...inputs, ...audioInputs,
      "-f", "lavfi", "-t", total.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-filter_complex", filters.join(";"),
      "-map", video, "-map", "[a]",
      "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", file,
    ]);
    const silent = voices.some((voice) => !voice) ? " (no voice-over yet)" : "";
    console.log(`Wrote ${file}: ${probe(file).toFixed(1)} s${silent}`);
  }
}
