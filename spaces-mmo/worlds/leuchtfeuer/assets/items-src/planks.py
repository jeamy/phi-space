# What the workshop makes of planks (docs/siedeln.en.md "Trees"), in the style of trees.py (32x32, dark outline, a light
# edge on top, shade below): a barrel, a fruit crate, a table and a pair of shutters.
# Usage: python3 planks.py <items dir>
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


def poly(img, pts, col):
    ImageDraw.Draw(img).polygon(pts, fill=col)


def line(img, pts, col, w=1):
    ImageDraw.Draw(img).line(pts, fill=col, width=w)


def outline(img):
    px = img.load()
    drawn = {(x, y) for x in range(W) for y in range(W) if px[x, y][3] and px[x, y] != OUT}
    for x in range(W):
        for y in range(W):
            if (x, y) in drawn: continue
            if any((x + dx, y + dy) in drawn for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))): px[x, y] = OUT
    return img


def barrel():
    img = new()
    ellipse(img, (6, 4, 26, 30), rgb("#8a5a2e"))                      # the belly
    rect(img, (8, 6, 24, 28), rgb("#8a5a2e"))
    for x in (11, 16, 21): line(img, [(x, 6), (x, 28)], rgb("#6a4220"))   # the staves
    rect(img, (9, 6, 10, 28), rgb("#b07a44"))                          # its light side
    for y in (9, 22): rect(img, (6, y, 26, y + 2), rgb("#5a8a50"))       # the hoops of rope
    ellipse(img, (8, 2, 24, 8), rgb("#c09060"))                        # the lid
    ellipse(img, (11, 3, 21, 7), rgb("#a87a4a"))
    return outline(img)


def crate():
    img = new()
    rect(img, (4, 12, 28, 28), rgb("#b08a50"))                         # the crate
    for y in (14, 20, 26): rect(img, (4, y, 28, y + 1), rgb("#8a6a38"))  # the gaps between its slats
    rect(img, (4, 12, 6, 28), rgb("#d0aa6a"))
    rect(img, (26, 12, 28, 28), rgb("#8a6a38"))
    for (x, col) in ((7, "#c8322a"), (13, "#c0b838"), (19, "#c8322a"), (24, "#c0b838")):
        ellipse(img, (x - 1, 6, x + 5, 13), rgb(col))                   # apples and pears on top
    ellipse(img, (7, 7, 9, 9), rgb("#fca080"))
    return outline(img)


def table():
    img = new()
    poly(img, [(3, 10), (29, 10), (27, 15), (5, 15)], rgb("#b07a44"))   # the top, seen from the front and above
    rect(img, (5, 15, 27, 17), rgb("#8a5a2e"))
    line(img, [(5, 11), (27, 11)], rgb("#d0a070"))
    for x in (6, 24): rect(img, (x, 17, x + 2, 29), rgb("#8a5a2e"))     # the legs
    for x in (10, 20): rect(img, (x, 17, x + 1, 25), rgb("#6a4220"))
    return outline(img)


def shutters():
    img = new()
    for x0 in (3, 17):
        rect(img, (x0, 4, x0 + 11, 28), rgb("#6a8a5a"))                 # a shutter of planks
        for x in range(x0 + 3, x0 + 11, 3): line(img, [(x, 4), (x, 28)], rgb("#4a6a3a"))
        rect(img, (x0, 4, x0 + 1, 28), rgb("#8aaa7a"))
        line(img, [(x0, 8), (x0 + 11, 24)], rgb("#8a5a2e"), 2)          # its brace
        rect(img, (x0 + 1, 7, x0 + 3, 9), rgb("#3a3a40"))               # the hinges
        rect(img, (x0 + 1, 23, x0 + 3, 25), rgb("#3a3a40"))
    return outline(img)


out = sys.argv[1]
for key, img in {"fass": barrel(), "obstkiste": crate(), "tisch": table(), "fensterlaeden": shutters()}.items():
    img.save(f"{out}/{key}.png")
