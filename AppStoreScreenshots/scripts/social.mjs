// A video for social posts, output/social/umete-duo-<locale>.mp4: the iPhone Duo preview's
// recordings and voice, timed the same, in the closed Duo's frame on the screenshots'
// paper, with what's said as subtitles beneath it. The frame is smoothed as in Karui's
// duo-social-video.mjs, since it's hard-aliased at 720 px.
//
//   npm run social

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { preview, screenshot, social } from "../config.mjs";
import { seconds } from "./narrate.mjs";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(here, "output/social");
const work = join(out, "work");
mkdirSync(work, { recursive: true });

const { fps, tail, crossfade } = preview;
const { width: W, height: H, frame, screen } = social;
// As in preview.mjs: the voice starts this long into its scene.
const lead = 0.4;
const fade = 0.15;
const paper = screenshot.background.slice(1);
const bezel = resolve(here, social.bezel);
if (!existsSync(bezel)) throw new Error(`Missing ${bezel}; see README.md.`);

const ffmpeg = (...args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });

// The frame over the paper, with its screen left transparent.
const framePNG = join(work, "frame.png");
const smooth = `scale=${frame.width * 8}:${frame.height * 8}:flags=bicubic,gblur=sigma=12:steps=3,geq=lum='if(gt(lum(X,Y),127),255,0)',scale=${frame.width}:${frame.height}:flags=area`;
const dark = "if(lt(min(min(r(X,Y),g(X,Y)),b(X,Y)),200),255,0)";
ffmpeg("-i", bezel, "-filter_complex", [
  "[0:v]format=rgba,split=3[src][src2][srca]",
  `[src]format=rgb24,geq=r='${dark}':g='${dark}':b='${dark}',format=gray,split[bin][bin2]`,
  `[bin]${smooth}[outline]`,
  `[srca]alphaextract,${smooth}[newa]`,
  "[src2]format=rgb24,split[rgb][rgb2]",
  "[rgb2]erosion,erosion,erosion[eroded]",
  "[eroded][rgb][bin2]maskedmerge[rgbfixed]",
  "[rgbfixed]format=rgba[shellrgb]",
  "[shellrgb][outline]alphamerge[shell]",
  `color=c=0x${paper}:s=${frame.width}x${frame.height}:d=1,format=rgba[page]`,
  "[page][shell]overlay,format=rgb24[rgbpage]",
  "[rgbpage][newa]alphamerge[out]",
].join(";"), "-map", "[out]", "-frames:v", "1", "-update", "1", framePNG);

// The screen's shape: nearly square on the hinge side, which the frame covers, and round
// on the open side.
const maskPNG = join(work, "mask.png");
const r = screen.corner;
const cx = screen.width - 1 - r;
const cb = screen.height - 1 - r;
const top = `clip(${r}+0.5-sqrt(pow(max(X-${cx},0),2)+pow(max(${r}-Y,0),2)),0,1)`;
const bottom = `clip(${r}+0.5-sqrt(pow(max(X-${cx},0),2)+pow(max(Y-${cb},0),2)),0,1)`;
ffmpeg("-f", "lavfi", "-i", `color=c=white:s=${screen.width}x${screen.height}:d=1`,
  "-vf", `format=gray,geq=lum='255*min(${top},${bottom})'`, "-frames:v", "1", "-update", "1", maskPNG);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
const subtitleTop = frame.y + frame.height + 16;

for (const [locale, lines] of Object.entries(social.cues)) {
  const voices = lines.map((_, index) => join(here, "voiceover", locale, `line-${index + 1}.m4a`));
  const ends = preview.duo.voiceEnd[locale] ?? {};

  // The scenes, timed as in preview.mjs.
  const durations = preview.duo.scenes.map((scene, index) => {
    const spoken = lead + Math.min(seconds(voices[index]), ends[index + 1] ?? Infinity) + tail;
    return Math.max(spoken, preview.scenes[index].minimum ?? 0, 3);
  });
  const starts = durations.map((_, index) => durations.slice(0, index).reduce((sum, length) => sum + length, 0));
  const total = starts.at(-1) + durations.at(-1);

  // Each subtitle stays a little after the voice stops, until just before the next.
  const cues = lines.flatMap((cuesInLine, index) => cuesInLine.map((cue) => ({
    text: cue.text,
    start: starts[index] + lead + cue.start,
    end: starts[index] + lead + cue.end,
  })));
  for (const [index, cue] of cues.entries()) {
    const next = cues[index + 1]?.start ?? total;
    cue.end = Math.min(cue.end + 0.4, next - 0.05, total - 0.05);
    cue.start = Math.max(0, cue.start - 0.05);
  }
  for (const [index, cue] of cues.entries()) {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      html, body { margin: 0; width: ${W}px; height: ${H}px; background: transparent; }
      div { position: absolute; left: 70px; right: 70px; top: ${subtitleTop}px; height: ${H - subtitleTop - 28}px; display: flex; align-items: center; justify-content: center; text-align: center; font: 600 46px/1.3 -apple-system, "Helvetica Neue", sans-serif; letter-spacing: -0.01em; color: ${screenshot.ink}; text-wrap: balance; -webkit-font-smoothing: antialiased; }
    </style><div>${cue.text}</div>`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(work, `${locale}-cue-${index + 1}.png`), omitBackground: true });
  }

  const still = (file) => ["-loop", "1", "-framerate", String(fps), "-t", total.toFixed(3), "-i", file];
  const inputs = [
    "-f", "lavfi", "-i", `color=c=0x${paper}:s=${W}x${H}:r=${fps}:d=${total.toFixed(3)}`,
    ...still(framePNG),
    ...still(maskPNG),
    ...preview.duo.scenes.flatMap((scene) => ["-i", join(here, scene.clip)]),
    ...cues.flatMap((_, index) => still(join(work, `${locale}-cue-${index + 1}.png`))),
    ...voices.flatMap((file) => ["-i", file]),
  ];
  const firstClip = 3;
  const firstCue = firstClip + preview.duo.scenes.length;
  const firstVoice = firstCue + cues.length;

  // The recordings, each cut to its `keep` stretches and held on its last frame, then
  // crossfaded into a single screen.
  const filter = preview.duo.scenes.map((scene, index) => {
    const parts = scene.keep.map((_, part) => `[k${index}p${part}]`).join("");
    const cuts = scene.keep.map(([from, to], part) => `[k${index}p${part}]trim=${from}:${to},setpts=PTS-STARTPTS[t${index}p${part}]`).join(";");
    const joined = scene.keep.map((_, part) => `[t${index}p${part}]`).join("");
    const length = durations[index] + (index < durations.length - 1 ? crossfade : 0);
    return `[${firstClip + index}:v]fps=${fps},split=${scene.keep.length}${parts};${cuts};${joined}concat=n=${scene.keep.length}:v=1:a=0,` +
      `scale=${screen.width}:${screen.height}:flags=lanczos,tpad=stop_mode=clone:stop_duration=${length.toFixed(3)},trim=duration=${length.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p[s${index}]`;
  });
  let video = "[s0]";
  for (let index = 1; index < durations.length; index += 1) {
    filter.push(`${video}[s${index}]xfade=transition=fade:duration=${crossfade}:offset=${starts[index].toFixed(3)}[x${index}]`);
    video = `[x${index}]`;
  }
  filter.push(
    `${video}format=rgba[recording]`,
    "[2:v]format=gray[mask]",
    "[recording][mask]alphamerge[shaped]",
    `color=c=black:s=${frame.width}x${frame.height}:r=${fps}:d=${total.toFixed(3)}[display]`,
    `[display][shaped]overlay=${screen.x}:${screen.y}[lit]`,
    "[lit][1:v]overlay[device]",
    `[0:v][device]overlay=${frame.x}:${frame.y}[l0]`,
  );
  let last = "l0";
  cues.forEach((cue, index) => {
    filter.push(`[${firstCue + index}:v]format=rgba,fade=t=in:st=${cue.start.toFixed(2)}:d=${fade}:alpha=1,fade=t=out:st=${(cue.end - fade).toFixed(2)}:d=${fade}:alpha=1[c${index}]`);
    filter.push(`[${last}][c${index}]overlay[l${index + 1}]`);
    last = `l${index + 1}`;
  });
  filter.push(`[${last}]format=yuv420p[video]`);

  // The voice, each line at its scene's start, cut where the preview cuts it.
  voices.forEach((_, index) => {
    const end = ends[index + 1];
    const cut = end ? `atrim=end=${end},afade=t=out:st=${end - 0.12}:d=0.12,` : "";
    const delay = Math.round((starts[index] + lead) * 1000);
    filter.push(`[${firstVoice + index}:a]${cut}aresample=48000,aformat=channel_layouts=stereo,adelay=${delay}|${delay}[a${index}]`);
  });
  filter.push(`${voices.map((_, index) => `[a${index}]`).join("")}amix=inputs=${voices.length}:normalize=0,apad,atrim=duration=${total.toFixed(3)}[audio]`);

  const file = join(out, `umete-duo-${locale}.mp4`);
  ffmpeg(...inputs, "-filter_complex", filter.join(";"), "-map", "[video]", "-map", "[audio]",
    "-t", total.toFixed(3), "-r", String(fps), "-c:v", "libx264", "-profile:v", "high", "-crf", "18", "-preset", "slow",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", file);
  console.log(`Wrote ${file}: ${total.toFixed(1)} s`);
  for (const cue of cues) console.log(`  ${cue.start.toFixed(2)}–${cue.end.toFixed(2)}  ${cue.text}`);
}
await browser.close();
