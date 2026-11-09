# The pig and what it roots up in its pen (engine/commands/animals.ts, kind "schwein"), in the style of garden.py
# (32x32, dark outline, a light edge on top, shade below): a pink pig with a curly tail and a truffle.
# Usage: python3 pigs.py <items dir> [sheet.png]
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


def pig():
    img = new(); px = img.load()
    P, PD, PL = rgb("#e8a0a0"), rgb("#b06a6e"), rgb("#f6c4c0")
    for x in (10, 13, 18, 21):              # short legs
        line(px, x, 22, x, 27, PD, 2)
    disc(px, 15, 17, 8, P)                  # the round body
    disc(px, 24, 15, 5, P)                  # the head
    disc(px, 28, 16, 2.4, PL, light=False)  # the snout
    px[28, 15] = PD; px[28, 17] = PD        # nostrils
    line(px, 22, 10, 24, 8, PD, 2)          # an ear, flopping forward
    px[25, 13] = OUT                        # the eye
    line(px, 7, 15, 5, 13, PD)              # a curly tail
    line(px, 5, 13, 6, 11, PD)
    px[7, 11] = PD
    return outline(img)


def truffle():
    img = new(); px = img.load()
    T, TL = rgb("#4a3428"), rgb("#8a6a50")
    for (x, y, r) in ((14, 18, 7), (19, 15, 6), (18, 21, 5.5)):  # a lumpy tuber
        disc(px, x, y, r, T)
    for (x, y) in ((11, 15), (15, 13), (20, 12), (13, 21), (19, 19), (22, 17), (16, 24)):  # its warty skin
        px[x, y] = TL
    line(px, 6, 27, 25, 27, rgb("#6e5434"))  # a little earth under it
    line(px, 9, 28, 22, 28, rgb("#6e5434"))
    return outline(img)


out = sys.argv[1]
things = {"schwein": pig(), "trueffel": truffle()}
for key, img in things.items():
    img.save(f"{out}/{key}.png")
if len(sys.argv) > 2:
    sheet = Image.new("RGBA", (len(things) * 110, 110), (58, 72, 52, 255))
    for i, img in enumerate(things.values()):
        sheet.alpha_composite(img.resize((96, 96), Image.NEAREST), (i * 110 + 7, 7))
    sheet.save(sys.argv[2])
