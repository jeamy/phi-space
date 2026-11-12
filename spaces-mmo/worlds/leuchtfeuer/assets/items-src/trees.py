# What the trees give and need (docs/siedeln.en.md "Bäume"), in the style of honey.py (32x32, dark outline, a light edge on
# top, shade below): a log, an axe, the seeds of birch, willow, apple, pear and oak, apples and pears, their juice and
# their compote.
# Usage: python3 trees.py <items dir>
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


def log():
    img = new()
    poly(img, [(4, 18), (22, 8), (28, 16), (10, 26)], rgb("#8a5a2e"))   # the split log, lying aslant
    poly(img, [(4, 18), (22, 8), (23, 10), (6, 20)], rgb("#b07a44"))    # its light upper edge
    ellipse(img, (21, 7, 29, 17), rgb("#d8b080"))                      # the cut end
    ellipse(img, (23, 9, 27, 15), rgb("#c09060"))                      # its rings
    ellipse(img, (24, 11, 26, 13), rgb("#a87a4a"))
    line(img, [(9, 21), (17, 16)], rgb("#6a4220"))                     # a crack in the bark
    return outline(img)


def axe():
    img = new()
    line(img, [(9, 28), (21, 6)], rgb("#8a6a44"), 3)                   # the handle
    line(img, [(9, 28), (20, 7)], rgb("#a88456"), 1)
    poly(img, [(17, 5), (27, 4), (29, 13), (21, 13)], rgb("#8a8a90"))  # the stone head
    poly(img, [(25, 4), (27, 4), (29, 13), (27, 13)], rgb("#c8ccd0"))  # its sharpened edge
    rect(img, (17, 9, 20, 12), rgb("#5a8a50"))                         # the kelp rope round it
    return outline(img)


def birch_seeds():
    img = new()
    for (x, y) in ((8, 10), (17, 7), (13, 18), (21, 17)):
        ellipse(img, (x - 3, y, x + 7, y + 6), rgb("#e8e0c0"))         # the wings
        ellipse(img, (x + 1, y + 1, x + 3, y + 5), rgb("#8a6a3a"))     # the seed between them
    return outline(img)


def willow_cutting():
    img = new()
    line(img, [(8, 28), (24, 5)], rgb("#7a6a3a"), 2)                   # the rod
    for (x, y, d) in ((12, 22, 1), (16, 16, -1), (19, 12, 1), (22, 8, -1)):
        ellipse(img, (x + (2 if d > 0 else -8), y - 2, x + (8 if d > 0 else -2), y + 1), rgb("#9ab86a"))  # narrow leaves
    return outline(img)


def pips(col, light):
    img = new()
    for (x, y) in ((8, 12), (16, 8), (20, 16), (11, 19)):
        ellipse(img, (x, y, x + 5, y + 8), rgb(col))
        rect(img, (x + 1, y + 2, x + 1, y + 3), rgb(light))
    return outline(img)


def acorn():
    img = new()
    ellipse(img, (9, 11, 23, 29), rgb("#b08a3a"))                      # the nut
    ellipse(img, (11, 13, 15, 20), rgb("#d0ac5a"))                     # its shine
    ellipse(img, (7, 7, 25, 16), rgb("#6a5028"))                       # the cup
    for x in range(9, 24, 3): rect(img, (x, 10, x, 11), rgb("#8a6a38"))
    rect(img, (15, 3, 17, 7), rgb("#5a4020"))                          # the stalk
    return outline(img)


def apple():
    img = new()
    ellipse(img, (5, 8, 27, 29), rgb("#c8322a"))
    ellipse(img, (7, 10, 16, 20), rgb("#e8604a"))                      # the red cheek in the light
    ellipse(img, (9, 12, 12, 15), rgb("#fca080"))
    rect(img, (15, 4, 16, 10), rgb("#5a3a1a"))                         # stalk and leaf
    ellipse(img, (17, 3, 24, 8), rgb("#5c9c42"))
    return outline(img)


def pear():
    img = new()
    ellipse(img, (6, 14, 26, 30), rgb("#c0b838"))                      # the round bottom
    ellipse(img, (10, 6, 22, 20), rgb("#c0b838"))                      # the narrow top
    ellipse(img, (9, 16, 16, 24), rgb("#e0d870"))
    rect(img, (15, 2, 16, 7), rgb("#5a3a1a"))
    ellipse(img, (17, 2, 23, 6), rgb("#5c9c42"))
    return outline(img)


def jug(col, light):
    img = new()
    ellipse(img, (19, 11, 29, 23), rgb("#8a6a4a"))                     # the handle
    ellipse(img, (21, 14, 26, 20), (0, 0, 0, 0))
    ellipse(img, (6, 24, 22, 30), rgb("#8a6a4a"))
    rect(img, (6, 8, 22, 27), rgb("#a07a52"))                          # the jug, clay
    rect(img, (6, 8, 8, 27), rgb("#b88e62"))
    ellipse(img, (6, 5, 22, 11), rgb("#6a4a30"))                       # the rim
    ellipse(img, (8, 6, 20, 10), rgb(col))                             # the juice in it
    rect(img, (11, 7, 13, 7), rgb(light))
    return outline(img)


def jar(col, light):
    img = new()
    rect(img, (7, 10, 25, 29), rgb("#c8dce0"))                         # the glass
    rect(img, (8, 12, 24, 28), rgb(col))                               # the compote in it
    for (x, y) in ((10, 15), (17, 18), (12, 23), (20, 24)):
        ellipse(img, (x, y, x + 4, y + 3), rgb(light))                 # pieces of fruit
    rect(img, (9, 12, 10, 26), rgb("#f0f8f8"))                         # the glass's shine
    rect(img, (6, 5, 26, 10), rgb("#d8c8a0"))                          # the cloth over the lid
    rect(img, (6, 9, 26, 10), rgb("#a83a2a"))                          # tied with a string
    return outline(img)


out = sys.argv[1]
for key, img in {
    "scheit": log(), "axt": axe(), "samen-birke": birch_seeds(), "weidensteckling": willow_cutting(),
    "apfelkern": pips("#6a4020", "#a0703a"), "birnenkern": pips("#3a2414", "#7a5030"), "eichel": acorn(),
    "apfel": apple(), "birne": pear(), "apfelsaft": jug("#e0b040", "#fcd870"), "birnensaft": jug("#d8d070", "#f8f0a0"),
    "apfelkompott": jar("#e8c070", "#f8e0a0"), "birnenkompott": jar("#e0d890", "#f8f0c0"),
}.items():
    img.save(f"{out}/{key}.png")
