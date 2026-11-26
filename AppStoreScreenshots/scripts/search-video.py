#!/usr/bin/env python3
"""The search result video's frames, from the spec scripts/search.mjs writes: the phone of
the still search card, playing the fill recording, with a camera that pushes in on Umete's
sheet for the tap on Fill this form, pans up to the fields as they fill, and pulls back to
the card; the headline changes on the way back. 10 s, looping without a seam. Every
locale shares the frames but its headlines, so each frame is drawn once and piped to one
ffmpeg per locale.

    /usr/bin/python3 scripts/search-video.py SPEC.json

Needs Pillow (macOS's /usr/bin/python3 has it) and ffmpeg.
"""
import json
import subprocess
import sys
from bisect import bisect_right
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

spec = json.loads(Path(sys.argv[1]).read_text())
W, H = spec["width"], spec["height"]
FPS = 30
DURATION = 10.0
bezel = spec["bezel"]
screen = bezel["screen"]
CW, CH = screen["width"], screen["height"]

# The recording, at the moments used: the empty form, Umete's sheet sliding up, and the
# tap on Fill this form through to the filled form. The recorder only writes a frame when
# the screen changes, and it skipped the wait while Umete matched, so the tap, "Matching
# saved answers…" and the filled form are each held below rather than played.
EMPTY, SLIDE, SHEET, PRESSED, MATCHING, FILLED = 0.0, (3.86, 4.75), 4.84, 14.915, 14.95, 15.83
times = [float(v.strip(",")) for v in subprocess.run(
    ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", spec["clip"]],
    capture_output=True, text=True, check=True).stdout.split()]
frames_kept = {}


def index_at(t):
    """The recording's frame showing at `t` seconds: the last one written by then."""
    return max(0, bisect_right(times, t + 1e-4) - 1)


def capture(t):
    i = index_at(t)
    return frames_kept.get(i), i


def ease(k):
    k = min(1.0, max(0.0, k))
    return k * k * (3 - 2 * k)


def span(t, a, b):
    return ease((t - a) / (b - a))


# What the phone shows, by the video's time.
def screen_at(t):
    if t < 1.0:
        return capture(EMPTY)
    if t < 1.9:
        return capture(SLIDE[0] + (SLIDE[1] - SLIDE[0]) * (t - 1.0) / 0.9)
    if t < 3.5:
        return capture(SHEET)
    if t < 3.8:
        return capture(PRESSED)
    if t < 4.4:
        return capture(MATCHING)
    if t < 9.2:
        return capture(FILLED)
    if t < 9.8:
        # Back to the empty form, for the loop.
        k = span(t, 9.2, 9.8)
        filled, _ = capture(FILLED)
        empty, _ = capture(EMPTY)
        if filled is None:
            return None, ("fade", k)
        return Image.blend(filled, empty, k), ("fade", round(k, 3))
    return capture(EMPTY)


# Decode the recording once, in order, keeping only the frames the video shows, so each
# frame's index matches its time in ffprobe's list.
wanted = {index_at(EMPTY), index_at(FILLED)}
for i in range(round(DURATION * FPS)):
    t = i / FPS
    if not 9.2 <= t < 9.8:
        wanted.add(screen_at(t)[1])
decoder = subprocess.Popen(["ffmpeg", "-v", "error", "-i", spec["clip"], "-fps_mode", "passthrough",
                            "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
size = CW * CH * 3
count = 0
while True:
    data = decoder.stdout.read(size)
    if len(data) < size:
        break
    if count in wanted:
        frames_kept[count] = Image.frombytes("RGB", (CW, CH), data)
    count += 1
decoder.wait()
if count != len(times):
    sys.exit(f"decoded {count} frames, but ffprobe lists {len(times)}")


# The camera: how many canvas pixels to a pixel of the recording (k), where the
# recording's left edge is on the canvas (x0), and which of its rows is at the canvas's
# middle (fy). "card" is the still search card's framing.
device = spec["device"]
s = device["width"] / bezel["width"]
phone_left = W - 260 - device["width"]
card = (s, phone_left + screen["x"] * s, (H / 2 - device["top"] - screen["y"] * s) / s)
sheet = (1.6, 1768.0, 1800.0)    # Umete's sheet, from its title to "Filled 9 fields."
fields = (1.6, 1768.0, 1000.0)   # the passenger's fields, with the sheet's top below
SHOTS = [(0.0, card), (1.3, card), (2.6, sheet), (4.6, sheet), (5.8, fields), (6.8, fields), (8.0, card), (10.0, card)]


def camera(t):
    for (a, from_), (b, to) in zip(SHOTS, SHOTS[1:]):
        if t <= b:
            k = span(t, a, b)
            return tuple(f + (g - f) * k for f, g in zip(from_, to))
    return SHOTS[-1][1]


# The phone, the recording in the bezel's opening, with the still card's soft shadow,
# on a padded canvas so the shadow isn't clipped.
PAD = 260
bezel_image = Image.open(bezel["file"]).convert("RGBA")
corner = Image.new("L", (CW, CH), 0)
ImageDraw.Draw(corner).rounded_rectangle((0, 0, CW - 1, CH - 1), radius=screen["radius"], fill=255)
shadow_mask = Image.new("L", (bezel["width"] + PAD * 2, bezel["height"] + PAD * 2), 0)
ImageDraw.Draw(shadow_mask).rounded_rectangle((PAD + 40 / s, PAD + 60 / s, PAD + bezel["width"] - 40 / s, PAD + bezel["height"]), radius=160 / s, fill=round(255 * 0.18))
shadow_mask = shadow_mask.filter(ImageFilter.GaussianBlur(70 / s))
shadow = Image.new("RGBA", shadow_mask.size, (48, 54, 43, 0))
shadow.putalpha(shadow_mask)


def phone(screen_image):
    layer = shadow.copy()
    body = Image.new("RGBA", (bezel["width"], bezel["height"]), (0, 0, 0, 0))
    body.paste(screen_image, (screen["x"], screen["y"]), corner)
    body.alpha_composite(bezel_image)
    layer.alpha_composite(body, (PAD, PAD))
    return layer


def phone_on_canvas(screen_image, cam):
    """The phone where the camera puts it: its layer, and the canvas point it goes at."""
    k, x0, fy = cam
    # Canvas point (X, Y) shows the recording's (X - x0) / k, fy + (Y - H/2) / k, which is
    # that plus the screen's offset in the bezel and the padding in the layer.
    ox = x0 - (screen["x"] + PAD) * k
    oy = H / 2 - (fy + screen["y"] + PAD) * k
    layer = phone(screen_image)
    left, top = max(0, int(ox)), max(0, int(oy))
    right, bottom = min(W, int(ox + layer.width * k) + 1), min(H, int(oy + layer.height * k) + 1)
    region = layer.transform((right - left, bottom - top), Image.AFFINE,
                             (1 / k, 0, (left - ox) / k, 0, 1 / k, (top - oy) / k), resample=Image.BICUBIC)
    return region, (left, top)


# The headlines: the first says what Umete does, the second why to trust it.
paper = Image.open(spec["paper"]).convert("RGBA")
ink = (40, 37, 31)
headlines = [[Image.open(f).getchannel("A") for f in output["lines"]] for output in spec["outputs"]]


def headline_levels(t):
    """How much of each headline shows, and how far below its place it is as it comes in."""
    # One at a time: each fades out before the other comes in.
    first = 1 - span(t, 6.8, 7.15) + span(t, 9.5, 9.9)
    second = span(t, 7.25, 7.7) - span(t, 9.1, 9.4)
    rise = lambda k: round(36 * (1 - k))
    return [(first, rise(first if t > 9 else 1)), (second, rise(second if t < 8 else 1))]


encoders = []
for output in spec["outputs"]:
    encoders.append(subprocess.Popen([
        "ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
        "-framerate", str(FPS), "-i", "-", "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-crf", "18", "-preset", "slow", "-movflags", "+faststart", "-an", output["out"],
    ], stdin=subprocess.PIPE))

last = None
frames = round(DURATION * FPS)
for i in range(frames):
    t = i / FPS
    screen_image, which = screen_at(t)
    cam = camera(t)
    key = (which, tuple(round(v, 3) for v in cam))
    if key != last:
        region, at = phone_on_canvas(screen_image, cam)
        base = paper.copy()
        base.alpha_composite(region, at)
        base = base.convert("RGB")
        last = key
    for masks, encoder in zip(headlines, encoders):
        frame = base.copy()
        for mask, (level, drop) in zip(masks, headline_levels(t)):
            if level > 0.002:
                frame.paste(ink, (0, drop), mask.crop((0, 0, W, H - drop)).point(lambda v: round(v * level)))
        encoder.stdin.write(frame.tobytes())
    if i % 30 == 0:
        print(f"  {t:.0f} s", end="\r", flush=True)

for encoder in encoders:
    encoder.stdin.close()
    if encoder.wait():
        sys.exit("ffmpeg failed")
print(f"{frames} frames, {DURATION:.0f} s: " + ", ".join(o["out"] for o in spec["outputs"]))
