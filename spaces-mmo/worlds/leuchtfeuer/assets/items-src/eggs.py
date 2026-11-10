# What the eggs make (docs/siedeln.en.md recipes), in the style of meat.py (32x32, dark outline, a light edge on top,
# shade below): scrambled eggs in a pan, pancakes on a plate and a cake.
# Usage: python3 eggs.py <items dir>
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


def scrambled():
    img = new()
    rect(img, (24, 15, 30, 17), rgb("#6a4a30"))          # the handle
    ellipse(img, (3, 9, 25, 25), rgb("#4a4a50"))         # the pan
    ellipse(img, (6, 12, 22, 22), rgb("#f0d050"))        # the eggs
    for (x, y) in ((10, 15), (15, 18), (18, 14), (12, 19)):
        rect(img, (x, y, x + 1, y), rgb("#fff4b0"))
    return outline(img)


def pancakes():
    img = new()
    ellipse(img, (3, 18, 29, 27), rgb("#e8e4dc"))        # the plate
    for i, y in enumerate((19, 16, 13)):
        ellipse(img, (6, y, 26, y + 6), rgb("#d8a050" if i % 2 else "#e8b860"))
    rect(img, (14, 13, 18, 14), rgb("#f8f0c0"))          # a dab of butter
    return outline(img)


def cake():
    img = new()
    ellipse(img, (4, 20, 28, 28), rgb("#c89050"))        # the cake's foot
    rect(img, (4, 14, 28, 24), rgb("#d8a060"))
    ellipse(img, (4, 10, 28, 18), rgb("#f4ecd8"))        # the icing
    for (x, y) in ((9, 13), (15, 12), (21, 14)):
        rect(img, (x, y, x + 1, y + 1), rgb("#c84050"))  # berries
    rect(img, (4, 19, 28, 19), rgb("#b87840"))
    return outline(img)


out = sys.argv[1]
for key, img in {"ruehrei": scrambled(), "pfannkuchen": pancakes(), "kuchen": cake()}.items():
    img.save(f"{out}/{key}.png")
