"""Crop a chrome region out of a full-window shot and stack light beside dark.

A 2160px screenshot shown whole loses exactly the detail a glow review is about,
so this keeps the rail, the selected tree rows and the tabstrip at 1:1.
Usage: python tests/crop.py <prefix> [sidebar|tabs|urlbar]
"""
import sys
import tempfile
from pathlib import Path

from PIL import Image

REGIONS = {
    "sidebar": (0, 0, 480, 460),
    "tabs": (0, 0, 1180, 60),
    "urlbar": (470, 55, 1500, 200),
}

name = sys.argv[1]
region = sys.argv[2] if len(sys.argv) > 2 else "sidebar"
left, top, right, bottom = REGIONS[region]
tile = (right - left, bottom - top)
gap = 12
out = Image.new("RGB", (tile[0] * 2 + gap, tile[1]), (128, 128, 128))
for i, theme in enumerate(("light", "dark")):
    im = Image.open(Path(tempfile.gettempdir()) / ("%s-%s.png" % (name, theme))).convert("RGB")
    out.paste(im.crop((left, top, right, bottom)), (i * (tile[0] + gap), 0))
path = str(Path(tempfile.gettempdir()) / ("crop-%s-%s.png" % (name, region)))
out.save(path)
print("wrote", path, out.size, "(left=light, right=dark)")
