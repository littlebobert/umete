// The App Store product page header video (iOS 27's Product Page Header asset):
// output/header/<locale>/header.mp4, 3840×1646, muted, a 7.1 s loop. Just the glass plum
// of umete.jp's header, filling up and draining, alone on the icon's backdrop; the same
// video in every locale. scripts/landing-animation.py --header draws and encodes it.
// Upload in App Store Connect → Asset Library → Product Page Information → Header.
//
//   npm run header

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { header, locales } from "../config.mjs";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { width, height, backdrop, plum, file } = header.video;

// The plum within the 1024 px app icon, from the icon's pixels.
const ICON = { left: 228, top: 155, width: 576, height: 702 };
const scale = plum.height / ICON.height;
const size = 1024 * scale;
const x = (width - ICON.width * scale) / 2 - ICON.left * scale;
const y = plum.top - ICON.top * scale;

const run = spawnSync("/usr/bin/python3", [
  join(here, "scripts/landing-animation.py"), "--header",
  ...[x, y, size, width, height, ...backdrop].map(String),
  ...locales.map((locale) => join(here, "output/header", locale, file)),
], { stdio: "inherit" });
if (run.status !== 0) process.exit(run.status ?? 1);
