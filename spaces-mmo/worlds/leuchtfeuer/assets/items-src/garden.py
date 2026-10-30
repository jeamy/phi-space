# The garden's things in the style of Shikashi's icons (32x32, dark outline, a light edge on top, shade below):
# spade, can of water, seed bags in the colour of their sort, three flowers, a cabbage and a carrot; and the hare that
# comes from the fog for them (wild.ts). The field crops (field.ts): three ears of grain, a potato, a beet and a bundle
# of flax.
# Usage: python3 garden.py <items dir>
import sys
from PIL import Image

OUT = (0x17, 0x11, 0x1a, 255)
W = 32


def rgb(h, a=255):
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16), a)


def shade(c, f):
    return (max(0, min(255, int(c[0] * f))), max(0, min(255, int(c[1] * f))), max(0, min(255, int(c[2] * f))), 255)


def new():
    return Image.new("RGBA", (W, W), (0, 0, 0, 0))


def disc(px, cx, cy, r, col, light=True):
    for x in range(W):
        for y in range(W):
            d = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) ** 0.5
            if d <= r:
                f = 1.0
                if light:
                    f = 1.25 if (y + 0.5 - cy) < -r * 0.45 and (x + 0.5 - cx) < 0 else 0.75 if (y + 0.5 - cy) > r * 0.4 else 1.0
                px[x, y] = shade(col, f)


def rect(px, x0, y0, x1, y1, col):
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            px[x, y] = col


def line(px, x0, y0, x1, y1, col, width=1):
    n = max(abs(x1 - x0), abs(y1 - y0), 1)
    for i in range(n + 1):
        x, y = round(x0 + (x1 - x0) * i / n), round(y0 + (y1 - y0) * i / n)
        for dx in range(width):
            for dy in range(width):
                if 0 <= x + dx < W and 0 <= y + dy < W: px[x + dx, y + dy] = col


def outline(img):
    px = img.load()
    drawn = {(x, y) for x in range(W) for y in range(W) if px[x, y][3] and px[x, y] != OUT}
    for x in range(W):
        for y in range(W):
            if (x, y) in drawn: continue
            if any((x + dx, y + dy) in drawn for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))): px[x, y] = OUT
    return img


WOOD, WOODD, WOODL = rgb("#b5674f"), rgb("#6e3534"), rgb("#ffa070")
ROPE = rgb("#8fb06a")
METAL, METALD, METALL = rgb("#9aa3ad"), rgb("#55586a"), rgb("#e6edf2")


def spade():
    img = new(); px = img.load()
    line(px, 22, 4, 13, 18, WOOD, 2)        # the handle, diagonal
    line(px, 23, 4, 14, 18, WOODD)
    rect(px, 20, 3, 25, 4, WOODL)           # the grip
    line(px, 13, 16, 16, 19, ROPE, 2)       # the lashing
    for y in range(17, 29):                 # the blade
        half = 5 if y < 25 else 5 - (y - 24)
        for x in range(10 - half, 10 + half + 1):
            cx = 10 + (y - 17) * -0.3
            px[int(x + (y - 17) * -0.3), y] = METALL if x < cx - 1 else METAL if x < cx + 2 else METALD
    return outline(img)


def can():
    img = new(); px = img.load()
    WATER, WATERD, WATERL = rgb("#5aa0d8"), rgb("#2f5f94"), rgb("#bfe3ff")
    for x in range(8, 22):                  # the body
        for y in range(12, 28):
            px[x, y] = METALL if x < 10 else METAL if x < 18 else METALD
    rect(px, 8, 12, 21, 13, METALD)
    rect(px, 10, 13, 19, 15, WATER)         # the water inside, seen from above
    rect(px, 11, 13, 14, 13, WATERL)
    line(px, 21, 16, 28, 9, METAL, 2)       # the spout
    disc(px, 28.5, 9, 1.6, WATER)
    line(px, 9, 11, 15, 6, METALD)          # the handle
    line(px, 15, 6, 21, 11, METALD)
    for (x, y) in ((27, 12), (29, 13), (28, 15)):  # drops
        px[x, y] = WATERL
    return outline(img)


def seeds(colour):
    img = new(); px = img.load()
    CLOTH, CLOTHD, CLOTHL = rgb("#d9b98a"), rgb("#8a6a44"), rgb("#f2dcb4")
    for y in range(10, 29):                 # a cloth bag, wider at the bottom
        half = 6 + (y - 10) * 0.35
        for x in range(int(16 - half), int(16 + half) + 1):
            px[x, y] = CLOTHL if x < 16 - half + 2 else CLOTHD if x > 16 + half - 2 or y > 26 else CLOTH
    rect(px, 12, 8, 20, 10, CLOTHD)         # the neck, tied
    line(px, 11, 10, 21, 10, ROPE)
    c = rgb(colour)
    for (x, y) in ((13, 6), (16, 5), (19, 6), (14, 4), (18, 4)):  # seeds spilling out on top
        px[x, y] = c; px[x + 1, y] = shade(c, 0.7)
    for (x, y) in ((14, 17), (18, 20), (15, 23)):  # the mark of the sort on the bag
        disc(px, x + 0.5, y + 0.5, 1.6, c, light=False)
    return outline(img)


def flower(colour, petals=5):
    import math
    img = new(); px = img.load()
    STEM, STEMD = rgb("#5f9a4a"), rgb("#2f5a2a")
    line(px, 16, 15, 15, 29, STEM, 2)
    line(px, 16, 22, 21, 19, STEM)          # a leaf
    disc(px, 22, 18.5, 2.2, STEM)
    line(px, 15, 25, 10, 23, STEMD)
    disc(px, 9.5, 22.5, 2, STEMD)
    c = rgb(colour)
    for i in range(petals):
        a = math.pi * 2 * i / petals - math.pi / 2
        disc(px, 16 + math.cos(a) * 5, 11 + math.sin(a) * 5, 3.6, c)
    disc(px, 16, 11, 2.4, rgb("#ffd34a"))
    return outline(img)


def cabbage():
    img = new(); px = img.load()
    G, GD, GL = rgb("#7fae6a"), rgb("#3f6e3a"), rgb("#c4e6a0")
    disc(px, 16, 18, 11, GD, light=False)
    disc(px, 16, 17, 9, G)
    disc(px, 15, 15, 5.5, GL, light=False)
    disc(px, 16, 16, 3.5, G, light=False)
    line(px, 16, 8, 16, 27, GD)             # the veins of the leaves
    line(px, 9, 14, 16, 20, GD)
    line(px, 23, 14, 16, 20, GD)
    return outline(img)


def carrot():
    img = new(); px = img.load()
    O, OD, OL = rgb("#e8902c"), rgb("#a0521a"), rgb("#ffc070")
    for i in range(19):                     # the root, from the top right down to the left
        r = 4.5 - i * 0.22
        cx, cy = 20 - i * 0.55, 10 + i
        disc(px, cx, cy, max(0.8, r), O)
    for (y, x) in ((14, 16), (19, 13), (23, 11)):  # rings
        line(px, x, y, x + 3, y - 1, OD)
    STEM, STEMD = rgb("#6fb04a"), rgb("#2f5a2a")
    for (x1, y1) in ((24, 2), (28, 5), (19, 1)):   # the green top
        line(px, 21, 8, x1, y1, STEM, 2)
    line(px, 21, 8, 26, 3, STEMD)
    return outline(img)


def hare():
    img = new(); px = img.load()
    F, FD, FL = rgb("#a08a6a"), rgb("#6a5640"), rgb("#d8c8a8")
    disc(px, 15, 21, 7.5, F)               # the body, sitting
    disc(px, 22, 14, 4.6, F)               # the head
    for i in range(9):                      # two long ears, leaning back
        disc(px, 20.5 - i * 0.35, 9 - i, 1.4, F, light=False)
        disc(px, 23.5 - i * 0.15, 9.5 - i, 1.3, FD, light=False)
    for i in range(6):
        px[int(20.5 - i * 0.35), int(8 - i)] = FL
    disc(px, 8.5, 21, 2.3, FL, light=False)  # the white tail
    rect(px, 17, 27, 21, 28, FD)            # a hind foot
    px[24, 13] = OUT                        # the eye
    px[26, 15] = rgb("#e88fb0")             # the nose
    return outline(img)


def ears(colour, awns=False, loose=False):
    img = new(); px = img.load()
    c = rgb(colour); cd, cl = shade(c, 0.65), shade(c, 1.2)
    for (bx, by, tx, ty) in ((10, 30, 9, 9), (16, 30, 16, 6), (22, 30, 23, 9)):  # three stalks, a little apart at the top
        line(px, bx, by, tx, ty + 8, cd)
        for i in range(7):                  # the ear: grains in pairs up the stalk (oats hang loose)
            gy = ty + i * 1.6
            dx = (2.5 if i % 2 else -2.5) if loose else 1.3
            disc(px, tx - dx + 0.5, gy + 0.5, 1.4, c, light=False)
            disc(px, tx + dx + 0.5, gy + 0.5, 1.4, cl if i < 2 else c, light=False)
        if awns:                            # barley's long bristles
            for i in range(4): line(px, tx + (i % 2) * 2 - 1, ty + i * 2, tx + (i % 2) * 6 - 3, ty + i * 2 - 6, cl)
    return outline(img)


def potato():
    img = new(); px = img.load()
    P, PD = rgb("#b08a5a"), rgb("#6e5434")
    disc(px, 14, 17, 8, P)
    disc(px, 19, 16, 7, P)
    for (x, y) in ((12, 14), (19, 19), (21, 12), (15, 20)):  # eyes
        px[x, y] = PD; px[x + 1, y] = PD
    return outline(img)


def beet():
    img = new(); px = img.load()
    R, RD = rgb("#9a3a5a"), rgb("#5a1a34")
    disc(px, 16, 19, 8, R)
    for i in range(6):                      # the root tip
        disc(px, 16 + i * 0.3, 27 + i * 0.6, max(0.6, 1.6 - i * 0.25), RD, light=False)
    STEM, STEMD = rgb("#6fb04a"), rgb("#2f5a2a")
    for (x1, y1, col) in ((10, 3, STEM), (16, 1, STEMD), (22, 3, STEM)):  # leaves with red stems
        line(px, 16, 11, x1, y1, col, 2)
        line(px, 16, 11, (16 + x1) // 2, (11 + y1) // 2, R)
    return outline(img)


def flax():
    img = new(); px = img.load()
    S, SD = rgb("#c9b88a"), rgb("#8a7a52")
    for i, x in enumerate(range(10, 23, 2)):   # a bundle of long stalks, tied in the middle
        line(px, x, 4 + (i % 2), 16 + (x - 16) // 2, 29, S if i % 2 else SD)
    line(px, 11, 18, 21, 18, ROPE, 2)
    for (x, y) in ((10, 3), (14, 2), (18, 3), (22, 4)):  # a few blue flowers left at the top
        disc(px, x + 0.5, y + 0.5, 1.5, rgb("#6a8fd0"), light=False)
    return outline(img)


out = sys.argv[1]
things = {
    "spaten": spade(), "wasserkanne": can(),
    "samen-strandnelke": seeds("#e88fb0"), "samen-duenenrose": seeds("#d9476b"), "samen-nebelblume": seeds("#9fb6e8"),
    "samen-strandkohl": seeds("#7fae6a"), "samen-moehre": seeds("#e8902c"),
    "strandnelke": flower("#e88fb0", 6), "duenenrose": flower("#d9476b", 5), "nebelblume": flower("#9fb6e8", 4),
    "kohl": cabbage(), "moehre": carrot(), "hase": hare(),
    "weizen": ears("#d9b44a"), "gerste": ears("#c8b06a", awns=True), "hafer": ears("#cdbf8a", loose=True),
    "kartoffel": potato(), "ruebe": beet(), "samen-ruebe": seeds("#9a3a5a"), "flachs": flax(), "leinsamen": seeds("#6a8fd0"),
}
for key, img in things.items():
    img.save(f"{out}/{key}.png")
# a sheet to look at them, six times the size
sheet = Image.new("RGBA", (len(things) * 110, 110), (58, 72, 52, 255))
for i, img in enumerate(things.values()):
    sheet.alpha_composite(img.resize((96, 96), Image.NEAREST), (i * 110 + 7, 7))
if len(sys.argv) > 2: sheet.save(sys.argv[2])
