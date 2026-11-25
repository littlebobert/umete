#!/usr/bin/env python3
"""The header animation on the umete.jp pages (the sibling littlebobert.github.io
repository), in the app icon's glass, as Karui's is: an empty glass shell fills up with
the plum's colour, the way a form is filled in (埋めて), catches the light, and drains
back to empty; the page's <video loop> repeats it. Built on the app icon itself, so the
full plum is exactly the icon. Writes umete-icon-sketch.mp4; the full plum as
umete-icon-sketch.jpg, for no motion or a blocked video; and the empty glass, the video's
first frame, as umete-icon-sketch-first.jpg, to show while it starts, all 224 px. The
pages load them with ?v= cache versions: bump those after a change. Umete for Mac's
About window plays the same files. Nothing is committed or pushed. Replaces sketch.mjs,
the pencil flipbook it used to be.

    /usr/bin/python3 AppStoreScreenshots/scripts/landing-animation.py [--mac] [--frames] [ICON_1024.png] [OUT_DIR]

ICON defaults to the app icon in the asset catalog, OUT_DIR to the site's assets, or with
--mac to the Mac app's sources, for its About window. --frames also writes a few 512 px
stills of the cycle, to look at without the video. Needs Pillow (macOS's
/usr/bin/python3 has it) and ffmpeg.
"""
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageMath

root = Path(__file__).resolve().parents[2]
args = [a for a in sys.argv[1:] if not a.startswith("--")]
icon_path = Path(args[0]) if args else root / "Safari/Ume/Shared (App)/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
default_out = root / "Safari/Ume/macOS (App)" if "--mac" in sys.argv else root.parent / "littlebobert.github.io/assets"
out_dir = Path(args[1]) if len(args) > 1 else default_out
PREVIEW = "--frames" in sys.argv  # Also keep a few stills, to look at without the video.

SIZE = 1024
OUT = 224
FPS = 30

base = Image.open(icon_path).convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)
background = base.getpixel((20, 20))

# The plum, stem, and leaf: everything that isn't the flat backdrop, with its holes (the
# glass is clear in places) filled in. The soft shadow under it stays backdrop.
# Compared with the backdrop at the same brightness, so the soft shadow under the plum
# (the backdrop, only darker) doesn't count.
luma = base.convert("L")
backdrop_luma = sum(c * w for c, w in zip(background, (0.299, 0.587, 0.114)))
channels = []
for band, c in zip(base.split(), background):
    channels.append(ImageMath.lambda_eval(
        lambda e: e["convert"](abs(e["float"](e["v"]) - e["float"](e["l"]) * (c / backdrop_luma)), "L"),
        v=band, l=luma))
spread = ImageChops.lighter(ImageChops.lighter(channels[0], channels[1]), channels[2])
# The glass's bright rims are close to the backdrop's hue: count being much lighter too.
spread = ImageChops.lighter(spread, luma.point(lambda v: max(0, int(v - backdrop_luma - 12)) * 2))
shape = spread.point(lambda v: 255 if v > 25 else 0).filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(9))
outside = shape.copy()
ImageDraw.floodfill(outside, (0, 0), 128)
shape = outside.point(lambda v: 0 if v == 128 else 255).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.5))

# The empty glass: the backdrop seen through it, a little brighter, keeping only the
# icon's light (its rims, highlights, and the curve of its shoulders), not its colour.
light = ImageChops.subtract(luma, luma.filter(ImageFilter.GaussianBlur(28)), scale=1, offset=0)
dark = ImageChops.subtract(luma.filter(ImageFilter.GaussianBlur(28)), luma, scale=1, offset=0)
pane = Image.blend(Image.new("RGB", base.size, background), Image.new("RGB", base.size, (255, 250, 242)), 0.30)
pane = ImageChops.add(pane, Image.merge("RGB", [light.point(lambda v: min(255, int(v * 1.6)))] * 3))
pane = ImageChops.subtract(pane, Image.merge("RGB", [dark.point(lambda v: min(255, int(v * 0.9)))] * 3))
# A bright rim all the way round, as thick glass has.
rim = ImageChops.subtract(shape, shape.filter(ImageFilter.MinFilter(15))).filter(ImageFilter.GaussianBlur(4))
pane.paste(Image.new("RGB", base.size, (255, 252, 246)), (0, 0), rim.point(lambda v: v * 150 // 255))
empty = base.copy()
empty.paste(pane, (0, 0), shape)


# The body apart from the leaf. Column by column, the leaf is the first stretch of glass
# from the top when that starts above the body's shoulders; where the two touch, the
# line between them is drawn straight across from the columns either side.
solid = shape.point(lambda v: 255 if v > 128 else 0)
spx = solid.load()
split = {}
for x in range(SIZE):
    y = 0
    while y < 460 and not spx[x, y]:
        y += 1
    if y >= 290:
        continue  # No leaf over this column.
    while y < 460 and spx[x, y]:
        y += 1
    split[x] = y if y < 460 else None
known = [x for x, y in split.items() if y is not None]
for x, y in split.items():
    if y is None:
        a = max((k for k in known if k < x), default=None)
        b = min((k for k in known if k > x), default=None)
        if a is None or b is None:
            split[x] = split[a if b is None else b]
        else:
            split[x] = split[a] + (split[b] - split[a]) * (x - a) / (b - a)
leaf_area = Image.new("L", base.size, 0)
draw = ImageDraw.Draw(leaf_area)
for x, y in split.items():
    draw.line([(x, 0), (x, y + 2)], fill=255)
leaf = ImageChops.multiply(leaf_area.filter(ImageFilter.GaussianBlur(1.5)), shape)
body = ImageChops.subtract(shape, leaf)
solid_body = body.point(lambda v: 255 if v > 128 else 0)
rows = {}
for y in range(SIZE):
    box = solid_body.crop((0, y, SIZE, y + 1)).getbbox()
    if box:
        rows[y] = (box[0], box[2])
BODY_TOP, BODY_BOTTOM = min(rows), max(rows)
SURFACE_LIGHT = Image.new("RGB", base.size, (255, 249, 234))


def ease(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def polygon(points):
    m = Image.new("L", base.size, 0)
    ImageDraw.Draw(m).polygon(points, fill=255)
    return m


def liquid(level, tilt, ripple, phase):
    """The liquid at `level` (0 empty, 1 full), seen a little from above as in a round
    glass: everything below its surface, the surface itself (an ellipse as wide as the
    glass at that height), and the surface's front and back edges. `tilt` leans it as it
    sloshes, and `ripple` wrinkles it."""
    y = BODY_BOTTOM + 12 - (BODY_BOTTOM + 12 - (BODY_TOP - 50)) * level
    x0, x1 = rows[min(max(int(y), BODY_TOP), BODY_BOTTOM)]
    cx, hw = (x0 + x1) / 2, max(1.0, (x1 - x0) / 2)
    depth = 0.17 * hw
    front, back = [], []
    for x in range(x0 - 24, x1 + 25, 6):
        u = (x - cx) / hw
        s = math.sqrt(max(0.0, 1 - u * u))
        lean = tilt * (x - cx) + ripple * math.sin(x / 38 + phase) * s
        front.append((x, y + depth * s + lean))
        back.append((x, y - depth * s + lean))
    left, right = (0, y - tilt * cx), (SIZE, y + tilt * (SIZE - cx))
    below = polygon([left] + back + [right, (SIZE, SIZE), (0, SIZE)]).filter(ImageFilter.GaussianBlur(1.5))
    surface = polygon(back + front[::-1]).filter(ImageFilter.GaussianBlur(1.5))
    return below, surface, front, back


def filled(level, tilt=0.0, ripple=0.0, phase=0.0, leaf_k=0.0, surface_k=1.0):
    """The empty glass with the liquid in it, and the leaf coloured in by `leaf_k`."""
    frame = empty.copy()
    below, surface, front, back = liquid(level, tilt, ripple, phase)
    frame.paste(base, (0, 0), ImageChops.multiply(below, body))
    if surface_k > 0:
        # The surface catches the light: paler than the liquid under it, brightest at
        # the front lip, where it meets the glass.
        frame.paste(SURFACE_LIGHT, (0, 0), ImageChops.multiply(surface, body).point(lambda v: int(v * 0.34 * surface_k)))
        edges = Image.new("L", base.size, 0)
        draw = ImageDraw.Draw(edges)
        draw.line(back, fill=120, width=4)
        draw.line(front, fill=255, width=6)
        edges = ImageChops.multiply(edges.filter(ImageFilter.GaussianBlur(2.5)), body)
        frame.paste(SURFACE_LIGHT, (0, 0), edges.point(lambda v: int(v * 0.75 * surface_k)))
    if leaf_k > 0:
        frame.paste(base, (0, 0), leaf.point(lambda v: int(v * leaf_k)))
    return frame


def glint(progress):
    """A diagonal band of light that crosses the plum as `progress` goes from 0 to 1."""
    band = Image.new("L", (SIZE * 2, SIZE * 2), 0)
    centre = -300 + (SIZE * 2 + 600) * progress
    ImageDraw.Draw(band).rectangle((centre - 30, 0, centre + 30, SIZE * 2), fill=255)
    band = band.filter(ImageFilter.GaussianBlur(22)).rotate(-28, center=(SIZE, SIZE))
    return band.crop((SIZE // 2, SIZE // 2, SIZE // 2 + SIZE, SIZE // 2 + SIZE))


# The cycle, in seconds: it starts on the empty glass shell, which fills up with the
# plum's colour, catches the light, and drains back to empty, so it loops without a seam.
EMPTY, FILL, REST, SHINE, HOLD, DRAIN = 0.6, 2.5, 0.3, 0.9, 1.2, 1.6
marks = [EMPTY, FILL, REST, SHINE, HOLD, DRAIN]
starts = [sum(marks[:i]) for i in range(len(marks))]
total = sum(marks)
frames = round(total * FPS)


def frame_at(t):
    empty_at, fill, rest, shine, hold, drain = starts
    if t < fill:
        return empty.copy()
    if t < rest:
        k = (t - fill) / FILL
        # Poured in: the surface sways as it rises and calms as it fills, and the leaf
        # takes its colour last.
        return filled(ease(k), tilt=0.085 * math.sin(t * 5.2) * (1 - 0.75 * k), ripple=7 * (1 - k) + 2, phase=t * 7,
                      leaf_k=ease((k - 0.78) / 0.22), surface_k=1 - ease((k - 0.86) / 0.14))
    if t < shine:
        return base.copy()
    if t < hold:
        frame = base.copy()
        light_band = ImageChops.multiply(glint(ease((t - shine) / SHINE)), shape).point(lambda v: v * 165 // 255)
        frame.paste(Image.new("RGB", base.size, (255, 253, 246)), (0, 0), light_band)
        return frame
    if t < drain:
        return base.copy()
    k = (t - drain) / DRAIN
    # Runs out quickly at first, and slows as the glass empties; the leaf clears first.
    return filled((1 - k) ** 2, tilt=0.035 * math.sin(k * 9) * (1 - k), ripple=3 * (1 - k), phase=t * 6,
                  leaf_k=1 - ease(k / 0.3), surface_k=ease(k / 0.12))


out_dir.mkdir(parents=True, exist_ok=True)
work = Path(tempfile.mkdtemp())
try:
    for i in range(frames):
        frame_at(i / FPS).resize((OUT, OUT), Image.LANCZOS).save(work / f"f{i:04d}.png")
    if PREVIEW:
        for name, t in [("empty", 0), ("filling", starts[1] + FILL * 0.4), ("nearly", starts[1] + FILL * 0.75), ("shine", starts[3] + SHINE * 0.5), ("draining", starts[5] + DRAIN * 0.4)]:
            frame_at(t).resize((512, 512), Image.LANCZOS).save(out_dir / f"umete-anim-{name}.png")
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", str(work / "f%04d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "veryslow",
        "-movflags", "+faststart", "-an", str(out_dir / "umete-icon-sketch.mp4"),
    ], check=True)
    base.resize((OUT, OUT), Image.LANCZOS).save(out_dir / "umete-icon-sketch.jpg", quality=90)
    # The video's first frame, the empty glass, to show under it while it starts, so the
    # full plum doesn't flash first.
    empty.resize((OUT, OUT), Image.LANCZOS).save(out_dir / "umete-icon-sketch-first.jpg", quality=90)
finally:
    shutil.rmtree(work)
print(f"{frames} frames, {total:.1f} s, into {out_dir}")
