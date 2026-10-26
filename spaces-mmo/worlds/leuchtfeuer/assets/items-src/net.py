# A fishing net in the style of Shikashi's icons (32x32, dark outline, warm rope tones, cork floats).
import sys
from PIL import Image, ImageDraw
OUT = (0x17, 0x11, 0x1a, 255)
DARK, MID, LIGHT, HI = (0x6e, 0x35, 0x34, 255), (0xb5, 0x67, 0x50, 255), (0xff, 0xa0, 0x70, 255), (0xff, 0xb2, 0x71, 255)
CORK, CORKD, WHITE = (0xff, 0xbf, 0x36, 255), (0xc4, 0x4d, 0x29, 255), (0xff, 0xff, 0xff, 255)
W = 32
img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
px = img.load()
poly = [(4.5, 10), (27.5, 10), (25, 22), (21, 27), (15.5, 29), (10, 27), (6, 22)]
def inside(x, y):
    c = False
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % len(poly)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c
region = {(x, y) for x in range(W) for y in range(W) if inside(x + 0.5, y + 0.5)}
# the mesh: diagonal strands every 6 cells, knots where they cross; the lower part in shade
STEP = 6
for (x, y) in region:
    a, b = (x + y) % STEP == 1, (x - y) % STEP == 1
    if a and b: px[x, y] = HI
    elif a or b: px[x, y] = MID if y < 19 else (0x83, 0x3d, 0x36, 255)
# the rim of the net: a darker cord along the sides and the bottom
for (x, y) in region:
    if any((x + dx, y + dy) not in region for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))) and y > 10: px[x, y] = DARK
# the head rope across the top
for x in range(3, 29):
    px[x, 9] = LIGHT if x % 3 else HI
    px[x, 10] = MID
# cork floats on the head rope: small ovals, light on top, shaded below
FLOAT = ["  oo  ", " oooo ", "oooooo", " dddd "]
for cx in (7, 16, 25):
    for fy, row in enumerate(FLOAT):
        for fx, ch in enumerate(row):
            if ch != " ": px[cx - 3 + fx, 7 + fy] = CORK if ch == "o" else CORKD
    px[cx - 1, 8] = WHITE
# weights on the bottom rim
STONE, STONED = (0x8a, 0x8f, 0x98, 255), (0x55, 0x58, 0x63, 255)
for (wx, wy) in ((10, 26), (15, 28), (21, 26)):
    px[wx, wy] = STONE; px[wx + 1, wy] = STONED; px[wx, wy + 1] = STONED; px[wx + 1, wy + 1] = STONED
# the outline: around everything that is drawn, but not in the holes of the mesh
drawn = {(x, y) for x in range(W) for y in range(W) if px[x, y][3] and px[x, y] != OUT}
for x in range(W):
    for y in range(W):
        if (x, y) in drawn or (x, y) in region: continue
        if any((x + dx, y + dy) in drawn for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))): px[x, y] = OUT
img.save(sys.argv[1])
# a comparison: rope, basket, net, at six times the size
row = [Image.open(p).convert("RGBA") for p in sys.argv[2:]] + [img]
cmp = Image.new("RGBA", (len(row) * 210, 210), (58, 72, 52, 255))
for i, im in enumerate(row): cmp.alpha_composite(im.resize((192, 192), Image.NEAREST), (i * 210 + 9, 9))
cmp.save(sys.argv[1].replace(".png", "-cmp.png"))
