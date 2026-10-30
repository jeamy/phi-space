# The garden's things in the style of Shikashi's icons (32x32, dark outline, a light edge on top, shade below):
# spade, can of water, seed bags in the colour of their sort, three flowers, a cabbage and a carrot; and the hare that
# comes from the fog for them (wild.ts). The field crops (field.ts): three ears of grain, a potato, a beet and a bundle
# of flax. What the mill and the bakery make of them (mill.ts): a sack of flour and a loaf; and the spindle and the
# linen spun from the flax. The farm's animals (animals.ts): a hen, a sheep and a goat, and what they give: an egg, a
# ball of wool and a jug of milk; a duck, a goose and its down; cloth woven of the wool, a down blanket and a cheese.
# The other wild from the fog (wild.ts): a deer, a fox and a mouse; and the guards against it: a dog, a cat, a mousetrap.
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


def sack():
    img = new(); px = img.load()
    S, SD = rgb("#d8ccb0"), rgb("#9a8a6a")
    for y in range(10, 30):                 # a sack, wider below, tied at the neck
        half = 6 + (y - 10) * 0.35 if y < 26 else 13 - (y - 26) * 1.2
        for x in range(round(16 - half), round(16 + half) + 1):
            px[x, y] = shade(S, 1.15 if x < 13 and y < 18 else 0.8 if y > 25 or x > 21 else 1.0)
    rect(px, 13, 7, 19, 9, S)
    line(px, 12, 10, 20, 10, ROPE, 1)
    for (x, y) in ((14, 4), (17, 3), (19, 5), (15, 6)):  # flour dusting out of the open neck
        px[x, y] = rgb("#f4f1e8")
    line(px, 13, 20, 19, 20, SD)            # the miller's mark: a little wheel
    line(px, 16, 17, 16, 23, SD)
    return outline(img)


def loaf():
    img = new(); px = img.load()
    B, BD, BL = rgb("#c88a3a"), rgb("#7a4a1a"), rgb("#f0c070")
    for x in range(4, 28):                  # a round-topped loaf on a flat bottom
        top = 14 - ((1 - ((x - 16) / 12.5) ** 2) ** 0.5) * 7
        for y in range(round(top), 26):
            px[x, y] = shade(B, 1.2 if y < top + 3 and x < 16 else 0.75 if y > 22 else 1.0)
    for i in range(3):                      # the baker's cuts
        line(px, 9 + i * 6, 11 - (1 if i == 1 else 0), 13 + i * 6, 16 - (1 if i == 1 else 0), BD)
        line(px, 10 + i * 6, 11 - (1 if i == 1 else 0), 14 + i * 6, 16 - (1 if i == 1 else 0), BL)
    return outline(img)


def linen():
    img = new(); px = img.load()
    L, LD, LL = rgb("#e8e0cc"), rgb("#a89c80"), rgb("#fbf8f0")
    for y in range(9, 25):                  # a roll of cloth, its end hanging down in front
        for x in range(5, 25):
            px[x, y] = shade(L, 1.1 if y < 12 else 0.8 if y > 21 else 1.0)
    for y in range(9, 25): disc(px, 25.5, y + 0.5, 3.2, LD, light=False)
    disc(px, 25.5, 16.5, 4, LD, light=False)
    disc(px, 25.5, 16.5, 1.4, LL, light=False)
    rect(px, 7, 24, 18, 29, L)              # the loose end
    for x in range(7, 19, 3): line(px, x, 25, x, 29, LD)
    for y in range(12, 24, 3): line(px, 6, y, 23, y, LL)  # the weave
    return outline(img)


def spindle():
    img = new(); px = img.load()
    line(px, 16, 2, 16, 29, WOOD, 2)        # the shaft
    line(px, 17, 3, 17, 28, WOODD)
    disc(px, 16.5, 22.5, 6, WOODD)          # the whorl, a flat disc near the foot
    disc(px, 16.5, 21.5, 5, WOOD)
    for i in range(5):                      # flax thread wound on above it
        line(px, 13, 9 + i * 2, 20, 8 + i * 2, rgb("#c9b88a"))
    return outline(img)


def hen():
    img = new(); px = img.load()
    F, FD = rgb("#b0703a"), rgb("#6e3e1a")
    disc(px, 15, 20, 8, F)                  # the body
    for i in range(5):                      # the tail feathers, up and back
        disc(px, 7 - i * 0.3, 15 - i * 1.2, 2.2 - i * 0.2, FD, light=False)
    disc(px, 22, 11, 4.3, F)                # the head
    disc(px, 21.5, 6.5, 1.6, rgb("#d83a2a"), light=False)  # the comb
    disc(px, 23.5, 6.8, 1.4, rgb("#d83a2a"), light=False)
    line(px, 26, 11, 28, 12, rgb("#e8b030"), 2)  # the beak
    disc(px, 24.5, 14.5, 1.1, rgb("#d83a2a"), light=False)  # the wattle
    px[23, 10] = OUT                        # the eye
    line(px, 12, 18, 18, 22, FD)            # the folded wing
    line(px, 13, 28, 13, 30, rgb("#e8b030")); line(px, 18, 28, 18, 30, rgb("#e8b030"))
    return outline(img)


def sheep(fleece, face):
    img = new(); px = img.load()
    W_, F_ = rgb(fleece), rgb(face)
    for (x, y, r) in ((10, 17, 5), (15, 15, 5.5), (20, 17, 5), (13, 20, 5), (18, 20, 5)):  # a cloud of wool
        disc(px, x, y, r, W_)
    disc(px, 25, 14, 3.6, F_)               # the head, dark
    disc(px, 23, 11, 1.4, F_, light=False)  # an ear
    px[26, 13] = OUT
    for x in (11, 15, 19):                  # thin legs
        line(px, x, 25, x, 29, F_)
    return outline(img)


def goat():
    img = new(); px = img.load()
    G, GD = rgb("#a89a80"), rgb("#5e5240")
    disc(px, 14, 18, 7, G)                  # the body
    disc(px, 23, 11, 3.8, G)                # the head
    line(px, 21, 8, 18, 3, GD, 2)           # the horns, curving back
    line(px, 23, 8, 21, 3, GD, 2)
    line(px, 25, 15, 25, 18, GD, 2)         # the beard
    px[24, 10] = OUT
    for x in (10, 13, 16, 19):
        line(px, x, 24, x, 29, GD)
    line(px, 7, 14, 6, 11, GD)              # a short tail up
    return outline(img)


def egg():
    img = new(); px = img.load()
    E = rgb("#e8d0a8")
    cy = 18
    for y in range(4, 30):                  # an egg: a taller half above the middle, a rounder one below
        ry = 13 if y < cy else 10
        q = 1 - ((y + 0.5 - cy) / ry) ** 2
        if q <= 0: continue
        half = 8 * q ** 0.5
        for x in range(round(16 - half), round(16 + half)):
            px[x, y] = shade(E, 1.2 if x < 13 and y < 14 else 0.78 if y > 24 or x > 20 else 1.0)
    px[13, 16] = rgb("#c8a878"); px[18, 21] = rgb("#c8a878"); px[15, 24] = rgb("#c8a878")  # speckles
    return outline(img)


def wool():
    img = new(); px = img.load()
    W_, WD = rgb("#f0ece0"), rgb("#b8b0a0")
    disc(px, 16, 17, 10, W_)                # a ball of yarn
    for i in range(-2, 3):                  # the windings
        line(px, 9 + i * 2, 9, 23 + i * 2, 25, WD)
    line(px, 7, 18, 25, 12, WD)
    line(px, 22, 25, 28, 29, W_, 2)         # the loose end
    return outline(img)


def jug():
    img = new(); px = img.load()
    C, CD = rgb("#b0604a"), rgb("#6e3426")
    for y in range(9, 29):                  # a clay jug, bellied
        half = 5 + 3.5 * (1 - abs(y - 20) / 10) if y > 11 else 4
        for x in range(round(15 - half), round(15 + half) + 1):
            px[x, y] = shade(C, 1.2 if x < 12 and y < 18 else 0.75 if y > 25 or x > 19 else 1.0)
    rect(px, 11, 6, 19, 8, rgb("#f4f1e8"))  # milk at the brim
    line(px, 10, 6, 20, 6, CD)
    for i in range(7):                      # the handle
        disc(px, 23.5 + (1.5 if 1 < i < 5 else 0), 12.5 + i * 1.6, 1.2, CD, light=False)
    return outline(img)


def bird(body, head, beak, neck=0, ring=None):
    img = new(); px = img.load()
    B, H = rgb(body), rgb(head)
    disc(px, 14, 21, 8, B)                  # the body, low and long
    disc(px, 8, 18, 4, B)                   # the tail end
    for i in range(neck + 1):               # the neck (long for the goose)
        disc(px, 20 + i * 0.3, 16 - i * 1.6, 3, B if i < neck else H, light=False)
    hx, hy = 21 + neck * 0.3, 13 - neck * 1.6
    disc(px, hx, hy, 3.8, H)                # the head
    line(px, round(hx + 3), round(hy + 1), round(hx + 6), round(hy + 1), rgb(beak), 2)  # the beak
    px[round(hx + 1), round(hy - 1)] = OUT  # the eye
    if ring: line(px, round(hx - 2), round(hy + 3), round(hx + 2), round(hy + 3), rgb(ring))
    line(px, 11, 19, 18, 22, shade(B, 0.7))  # the wing
    rect(px, 12, 29, 15, 29, rgb(beak)); rect(px, 16, 29, 19, 29, rgb(beak))  # feet
    return outline(img)


def down():
    img = new(); px = img.load()
    D, DD = rgb("#f4f1e8"), rgb("#c8c0b0")
    for (x, y, r) in ((11, 18, 5), (17, 14, 5.5), (21, 20, 5), (15, 22, 4.5)):  # soft tufts
        disc(px, x, y, r, D)
    for (x0, y0, x1, y1) in ((8, 16, 13, 20), (15, 11, 19, 16), (19, 18, 24, 22)):
        line(px, x0, y0, x1, y1, DD)       # the quills
    return outline(img)


def cloth(colour):
    img = new(); px = img.load()
    C = rgb(colour); CD, CL = shade(C, 0.7), shade(C, 1.25)
    for y in range(8, 26):                  # a folded stack of cloth
        for x in range(5, 28):
            px[x, y] = shade(C, 1.15 if y < 11 else 0.8 if y > 22 else 1.0)
    for y in (13, 18, 23): line(px, 5, y, 27, y, CD)  # the folds
    for x in range(7, 27, 4): line(px, x, 9, x, 11, CL)  # the weave at the top
    return outline(img)


def blanket():
    img = new(); px = img.load()
    C = rgb("#c8b0d8"); CD = shade(C, 0.7)
    for y in range(7, 27):                  # a puffy quilt, stitched in squares
        for x in range(4, 29):
            px[x, y] = shade(C, 1.2 if (x - 4) % 8 < 3 and (y - 7) % 7 < 3 else 0.85 if y > 23 else 1.0)
    for x in (12, 20): line(px, x, 7, x, 26, CD)
    for y in (14, 21): line(px, 4, y, 28, y, CD)
    return outline(img)


def cheese():
    img = new(); px = img.load()
    Y, YD, R = rgb("#e8c870"), rgb("#b8984a"), rgb("#c89040")
    for y in range(10, 26):                 # a round wheel with a wedge cut out
        for x in range(4, 28):
            if ((x + 0.5 - 16) / 12) ** 2 + ((y + 0.5 - 18) / 8) ** 2 > 1: continue
            if x > 18 and y < 18 and (x - 18) > (18 - y) * 0.6: continue
            px[x, y] = shade(Y, 1.15 if y < 14 else 0.75 if y > 22 else 1.0)
    line(px, 4, 18, 27, 18, R)              # the rind round the middle
    for (x, y) in ((10, 14), (14, 21), (22, 21), (9, 20)): disc(px, x + 0.5, y + 0.5, 1, YD, light=False)  # holes
    return outline(img)

def deer():
    img = new(); px = img.load()
    F, FD, FL = rgb("#a0703e"), rgb("#5a3a20"), rgb("#f2efe8")
    disc(px, 13, 17, 6.5, F)                # the body
    line(px, 18, 14, 22, 8, F, 3)           # the neck
    disc(px, 24, 8, 3.4, F)                 # the head
    disc(px, 21.5, 4, 1.4, F, light=False)  # the ears
    disc(px, 25.5, 3.5, 1.4, F, light=False)
    px[25, 7] = OUT                         # the eye
    px[27, 9] = OUT                         # the nose
    disc(px, 7, 15, 1.8, FL, light=False)   # the white scut
    for x in (9, 12, 15, 18):               # four long, thin legs
        line(px, x, 22, x, 30, FD)
    return outline(img)


def fox():
    img = new(); px = img.load()
    F, FD, FL = rgb("#c8642a"), rgb("#2a1a12"), rgb("#f2efe8")
    disc(px, 15, 19, 6, F)                  # the body, low
    for i in range(7):                      # the bushy tail, down and out, with a white tip
        disc(px, 8 - i * 0.7, 20 + i * 0.9, 2.8 - i * 0.12, F if i < 5 else FL, light=False)
    disc(px, 22, 14, 4, F)                  # the head
    line(px, 25, 15, 28, 16, F, 2)          # the pointed muzzle
    px[29, 16] = OUT
    disc(px, 23, 17, 2, FL, light=False)    # the white cheek
    line(px, 20, 11, 20, 7, FD, 2)          # the ears, black-tipped
    line(px, 23, 11, 24, 7, FD, 2)
    px[23, 13] = OUT                        # the eye
    for x in (12, 15, 18):                  # the black socks
        line(px, x, 24, x, 29, FD)
    return outline(img)


def mouse():
    img = new(); px = img.load()
    F, FL, P = rgb("#8a8278"), rgb("#b8b0a6"), rgb("#d8a0a0")
    disc(px, 15, 20, 6, F)                  # the round body
    disc(px, 14, 21, 2.5, FL, light=False)  # the light belly
    disc(px, 21, 18, 3.5, F)                # the head
    line(px, 23, 19, 26, 20, F, 2)          # the snout
    px[27, 20] = P
    disc(px, 19.5, 13.5, 2.6, F, light=False)  # the big round ears, pink inside
    disc(px, 19.5, 13.5, 1.4, P, light=False)
    px[22, 17] = OUT                        # the eye
    for i in range(14):                     # the long thin tail, curling down
        px[int(9 - i * 0.5), int(23 + i * 0.45)] = P
    return outline(img)


def dog():
    img = new(); px = img.load()
    F, FD = rgb("#8a6a4a"), rgb("#3a2a1a")
    disc(px, 14, 18, 6.5, F)                # the body
    disc(px, 22, 11, 4.3, F)                # the head
    rect(px, 24, 11, 28, 13, F)             # the muzzle
    px[28, 11] = OUT                        # the nose
    disc(px, 20, 9, 2, FD, light=False)     # a floppy ear
    px[23, 9] = OUT                         # the eye
    line(px, 7, 15, 4, 9, F, 2)             # the tail up
    for x in (9, 12, 16, 19):
        line(px, x, 23, x, 29, F, 2)
    line(px, 18, 15, 25, 16, rgb("#c83a2a"))  # a red collar
    return outline(img)


def cat():
    img = new(); px = img.load()
    F, FD = rgb("#c8904a"), rgb("#8a5a2a")
    disc(px, 15, 21, 7, F)                  # sitting: the body
    for y in (17, 20, 23):                  # its stripes
        line(px, 10, y, 14, y + 1, FD)
    disc(px, 17, 11, 5, F)                  # the head
    line(px, 13, 8, 13, 4, F, 2)            # pointed ears
    line(px, 20, 8, 20, 4, F, 2)
    px[15, 10] = rgb("#6aa04a"); px[19, 10] = rgb("#6aa04a")  # green eyes
    px[17, 12] = rgb("#d8a0a0")             # the nose
    for i in range(8):                      # the tail, curled round the front
        px[int(22 + i * 0.6), int(27 - i * 0.5)] = FD
    return outline(img)


def trap():
    img = new(); px = img.load()
    B, BD, M = rgb("#a08060"), rgb("#6a5040"), rgb("#d8d0c0")
    for y in range(17, 25):                 # the little board, seen at a slant
        rect(px, 4 + (24 - y) // 2, y, 24 + (24 - y) // 2, y, B if y < 23 else BD)
    line(px, 8, 18, 22, 18, M, 2)           # the shell bow, sprung open
    line(px, 8, 18, 9, 12, M)
    line(px, 22, 18, 21, 12, M)
    line(px, 9, 12, 21, 12, M)
    disc(px, 17, 21, 2, rgb("#e8c870"), light=False)  # a crumb of cheese as bait
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
    "mehl": sack(), "brot": loaf(), "leinen": linen(), "spindel": spindle(),
    "huhn": hen(), "schaf": sheep("#e8e4d8", "#3a3430"), "ziege": goat(), "ei": egg(), "wolle": wool(), "milch": jug(),
    "ente": bird("#8a7a5a", "#2f6a4a", "#e8b030", ring="#f0ece0"), "gans": bird("#f0ece0", "#f0ece0", "#e8902c", neck=3), "daunen": down(),
    "tuch": cloth("#8a6a9a"), "decke": blanket(), "kaese": cheese(),
    "reh": deer(), "fuchs": fox(), "maus": mouse(), "hund": dog(), "katze": cat(), "mausefalle": trap(),
}
for key, img in things.items():
    img.save(f"{out}/{key}.png")
# a sheet to look at them, six times the size
sheet = Image.new("RGBA", (len(things) * 110, 110), (58, 72, 52, 255))
for i, img in enumerate(things.values()):
    sheet.alpha_composite(img.resize((96, 96), Image.NEAREST), (i * 110 + 7, 7))
if len(sys.argv) > 2: sheet.save(sys.argv[2])
