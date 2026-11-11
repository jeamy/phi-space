# What the cabbage makes (docs/siedeln.en.md recipes), in the style of meat.py (32x32, dark outline, a light edge on top,
# shade below): a crock of sauerkraut, a bowl of cabbage soup and cabbage rolls on a plate.
# Usage: python3 cabbage.py <items dir>
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


def sauerkraut():
    img = new()
    ellipse(img, (6, 24, 26, 30), rgb("#8a6a4a"))        # the crock's foot
    rect(img, (6, 10, 26, 27), rgb("#b89470"))           # the crock, stoneware
    rect(img, (6, 10, 8, 27), rgb("#cfae88"))            # its light side
    rect(img, (6, 15, 26, 16), rgb("#6a7aa0"))           # a blue band
    ellipse(img, (5, 6, 27, 13), rgb("#7a5a3a"))         # the rim
    ellipse(img, (8, 7, 24, 12), rgb("#e0d890"))         # the kraut in it
    for (x, y) in ((11, 9), (15, 8), (19, 10), (13, 10)):
        rect(img, (x, y, x + 2, y), rgb("#b8b060"))      # its shreds
    return outline(img)


def cabbage_soup():
    img = new()
    ellipse(img, (3, 12, 29, 28), rgb("#8a5a3a"))        # the bowl
    ellipse(img, (3, 10, 29, 20), rgb("#a06a44"))
    ellipse(img, (6, 12, 26, 18), rgb("#c8c890"))        # the broth
    for (x, y, c) in ((9, 14, "#7fae6a"), (14, 13, "#7fae6a"), (19, 15, "#7fae6a"), (12, 16, "#e8d088"), (21, 13, "#e8d088")):
        rect(img, (x, y, x + 2, y + 1), rgb(c))          # cabbage and potato
    return outline(img)


def cabbage_rolls():
    img = new()
    ellipse(img, (2, 18, 30, 28), rgb("#e8e4dc"))        # the plate
    for x in (5, 16):
        ellipse(img, (x, 12, x + 11, 24), rgb("#8aa060"))  # a roll in its leaf
        rect(img, (x + 3, 13, x + 4, 23), rgb("#6a8448"))  # the leaf's fold
        rect(img, (x + 7, 14, x + 7, 22), rgb("#b0c888"))  # its light vein
    rect(img, (4, 23, 28, 24), rgb("#b06040"))           # the gravy
    return outline(img)


out = sys.argv[1]
for key, img in {"sauerkraut": sauerkraut(), "kohlsuppe": cabbage_soup(), "kohlroulade": cabbage_rolls()}.items():
    img.save(f"{out}/{key}.png")
