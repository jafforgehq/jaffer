#!/usr/bin/env python3
"""Quantize docs/screenshots/*.png to 256-colour palettes (about 55% smaller, no visible loss on UI screenshots).

    npm run screenshots && python3 scripts/shrink-screenshots.py

Needs Pillow (pip install pillow). Optional: the screenshots are committed shrunk, but regenerating without this still works.
"""
import glob
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required: pip install pillow")

folder = os.path.join(os.path.dirname(__file__), "..", "docs", "screenshots")
before = after = 0
for f in sorted(glob.glob(os.path.join(folder, "*.png"))):
    a = os.path.getsize(f)
    Image.open(f).convert("RGB").quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(f, optimize=True)
    b = os.path.getsize(f)
    before += a
    after += b
    print(f"{os.path.basename(f):28s} {a // 1024:5d} KB -> {b // 1024:5d} KB")
print(f"{'total':28s} {before // 1024:5d} KB -> {after // 1024:5d} KB")
