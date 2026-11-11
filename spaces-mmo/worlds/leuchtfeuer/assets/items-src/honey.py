# What the honey makes (docs/siedeln.en.md recipes), in the style of meat.py (32x32, dark outline, a light edge on top,
# shade below): a slice of bread with honey and a jug of mead.
# Usage: python3 honey.py <items dir>
import sys
from PIL import Image, ImageDraw

OUT = (0x17, 0x11, 0x1a, 255)
W = 32


def rgb(h, a=255):
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16), a)


def new():
    return Image.new("RGBA", (W, W), (0, 0, 0, 0))


def ellipse(img, box, col):
    ImageDraw.Draw(img).ellipse(box, fill=col)


def rect(img, box, col):
    ImageDraw.Draw(img).rectangle(box, fill=col)


def outline(img):
    px = img.load()
    drawn = {(x, y) for x in range(W) for y in range(W) if px[x, y][3] and px[x, y] != OUT}
    for x in range(W):
        for y in range(W):
            if (x, y) in drawn: continue
            if any((x + dx, y + dy) in drawn for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))): px[x, y] = OUT
    return img


def honey_bread():
    img = new()
    ellipse(img, (4, 8, 28, 20), rgb("#a8682a"))         # the crust, round on top
    rect(img, (4, 14, 28, 27), rgb("#a8682a"))
    ellipse(img, (6, 10, 26, 20), rgb("#f0dcae"))        # the crumb
    rect(img, (6, 15, 26, 25), rgb("#f0dcae"))
    ellipse(img, (7, 11, 25, 19), rgb("#e8a830"))        # the honey on it
    rect(img, (7, 15, 25, 21), rgb("#e8a830"))
    rect(img, (12, 21, 13, 24), rgb("#e8a830"))          # a drop running down
    for (x, y) in ((10, 13), (17, 12), (21, 16)):
        rect(img, (x, y, x + 1, y), rgb("#fcd870"))      # its shine
    return outline(img)


def mead():
    img = new()
    ellipse(img, (19, 11, 29, 23), rgb("#8a6a4a"))       # the handle
    ellipse(img, (21, 14, 26, 20), (0, 0, 0, 0))
    ellipse(img, (6, 24, 22, 30), rgb("#8a6a4a"))        # the jug's foot
    rect(img, (6, 8, 22, 27), rgb("#a07a52"))            # the jug, clay
    rect(img, (6, 8, 8, 27), rgb("#b88e62"))             # its light side
    ellipse(img, (6, 5, 22, 11), rgb("#6a4a30"))         # the rim
    ellipse(img, (8, 6, 20, 10), rgb("#e8b040"))         # the mead in it
    rect(img, (11, 7, 13, 7), rgb("#fcd870"))
    rect(img, (6, 16, 22, 17), rgb("#7a5a3a"))           # a band round it
    return outline(img)


out = sys.argv[1]
for key, img in {"honigbrot": honey_bread(), "met": mead()}.items():
    img.save(f"{out}/{key}.png")
