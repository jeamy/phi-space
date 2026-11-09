# What slaughtering gives and what the hearth and the smokehouse make of it (docs/schlachten.en.md), in the style of
# garden.py (32x32, dark outline, a light edge on top, shade below): raw meat of each animal, fells, feathers, tallow, lard
# and bristles; roasts, soups, sausages, bacon, ham and a slice of bread with lard; the butcher's knife, salt, cured and
# dried meat, bones and bone meal, a leather bag and boots, a chick, a piglet and a feast.
# Usage: python3 meat.py <items dir> [sheet.png]
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




def poly(img, pts, col):
    from PIL import ImageDraw
    ImageDraw.Draw(img).polygon(pts, fill=col)


def rawmeat(colour, fat="#f4e4d8"):
    img = new(); px = img.load()
    M = rgb(colour)
    for (x, y, r) in ((13, 17, 8), (19, 15, 7), (18, 20, 6)):
        disc(px, x, y, r, M)
    line(px, 9, 13, 22, 11, rgb(fat), 2)       # a streak of fat
    line(px, 12, 21, 21, 19, rgb(fat))
    return outline(img)


def bird_roast(colour):
    img = new(); px = img.load()
    disc(px, 8, 25, 0, rgb("#000000"), light=False)
    line(px, 4, 26, 27, 26, rgb("#c8c0b0"), 2)   # a plate
    disc(px, 15, 17, 8, rgb(colour))
    line(px, 21, 13, 27, 8, rgb("#e8dcc8"), 2)    # a drumstick bone
    px[27, 7] = rgb("#f4ecdc"); px[28, 8] = rgb("#f4ecdc")
    return outline(img)


def roast(colour):
    img = new(); px = img.load()
    line(px, 3, 26, 28, 26, rgb("#c8c0b0"), 2)
    for (x, y, r) in ((12, 19, 7), (19, 18, 7)):
        disc(px, x, y, r, rgb(colour))
    for x in (11, 15, 19, 23):                     # slices
        line(px, x, 13, x - 1, 24, shade(rgb(colour), 0.7))
    return outline(img)


def bowl(colour):
    img = new(); px = img.load()
    disc(px, 16, 14, 10, rgb(colour), light=False)
    for x in range(W):
        for y in range(0, 14):
            px[x, y] = (0, 0, 0, 0)
    line(px, 5, 14, 26, 14, rgb(colour), 2)
    for (x, y) in ((11, 16), (17, 18), (21, 15)):
        px[x, y] = rgb("#e8902c"); px[x + 1, y] = rgb("#7fae6a")
    line(px, 13, 6, 12, 10, rgb("#d8d8d8")); line(px, 19, 5, 18, 10, rgb("#d8d8d8"))  # steam
    return outline(img)


def sausage(colour, many=1):
    img = new(); px = img.load()
    for i in range(many):
        dy = i * 7 - (many - 1) * 3
        line(px, 6, 18 + dy, 26, 14 + dy, rgb(colour), 4)
        px[5, 19 + dy] = OUT; px[27, 15 + dy] = OUT
    return outline(img)


def steak():
    img = new(); px = img.load()
    for (x, y, r) in ((14, 17, 8), (20, 16, 6)):
        disc(px, x, y, r, rgb("#8a3a2a"))
    for i in range(4):
        line(px, 9 + i * 4, 12, 13 + i * 4, 22, rgb("#5a2418"))   # grill marks
    disc(px, 10, 15, 2, rgb("#f0e0c8"), light=False)
    return outline(img)


def ham(colour):
    img = new(); px = img.load()
    disc(px, 14, 18, 9, rgb(colour))
    disc(px, 14, 18, 4, rgb("#e8a098"), light=False)
    line(px, 21, 12, 27, 6, rgb("#e8dcc8"), 2)
    return outline(img)


def bacon():
    img = new(); px = img.load()
    for i, y in enumerate((10, 16, 22)):
        line(px, 5, y + 2, 26, y - 2, rgb("#c87868"), 3)
        line(px, 6, y + 3, 26, y - 1, rgb("#f0d8c8"))
    return outline(img)


def slab(colour, stripe):
    img = new(); px = img.load()
    for x in range(6, 26):
        for y in range(10, 23):
            px[x, y] = shade(rgb(colour), 1.15 if y < 12 else 0.8 if y > 20 else 1)
    for y in (13, 17):
        line(px, 7, y, 24, y, rgb(stripe))
    return outline(img)


def fur(colour):
    img = new(); px = img.load()
    poly(img, [(6, 8), (12, 10), (20, 10), (26, 8), (24, 16), (27, 25), (19, 23), (13, 23), (5, 25), (8, 16)], rgb(colour))
    for (x, y) in ((11, 14), (16, 13), (21, 15), (13, 19), (19, 19)):
        px[x, y] = shade(rgb(colour), 0.75)
    return outline(img)


def feathers():
    img = new(); px = img.load()
    for (x0, y0, x1, y1) in ((8, 26, 18, 5), (14, 27, 26, 9)):
        line(px, x0, y0, x1, y1, rgb("#b0a898"))
        for i in range(2, 12):
            t = i / 12
            x, y = round(x0 + (x1 - x0) * t), round(y0 + (y1 - y0) * t)
            for dx in (-2, -1, 1, 2):
                if 0 <= x + dx < W: px[x + dx, y] = rgb("#f0ece0")
    return outline(img)


def pot(colour):
    img = new(); px = img.load()
    for x in range(8, 24):
        for y in range(12, 27):
            px[x, y] = shade(rgb("#a8784a"), 1.1 if x < 11 else 0.8 if x > 20 else 1)
    line(px, 7, 11, 24, 11, rgb(colour), 3)
    return outline(img)


def bristles():
    img = new(); px = img.load()
    for x in range(8, 25, 2):
        line(px, x, 8, x + (1 if x % 4 else -1), 20, rgb("#d8b0a0"))
    for x in range(7, 26):
        for y in range(20, 26): px[x, y] = rgb("#a07850")
    return outline(img)


def lardbread():
    img = new(); px = img.load()
    for x in range(6, 26):
        for y in range(11, 25):
            px[x, y] = rgb("#c89a5a") if x in (6, 25) or y in (11, 24) else rgb("#f4ecd8")
    return outline(img)


# step 2 (docs/schlachten.en.md): the butcher's knife, salt, cured and dried meat, bones, bone meal, leather goods, the
# young animals and the feast
def cleaver():
    img = new(); px = img.load()
    poly(img, [(8, 8), (22, 8), (22, 19), (8, 21)], rgb("#a8b0b8"))   # the broad blade
    line(px, 9, 9, 21, 9, rgb("#e0e6ea"))                               # its bright edge
    line(px, 22, 14, 28, 14, rgb("#7a5032"), 3)                         # the handle
    px[18, 11] = OUT
    return outline(img)


def heap(colour, speck):
    img = new(); px = img.load()
    for x in range(5, 27):
        top = 26 - int(11 * (1 - abs(x - 16) / 11) ** 0.7)
        for y in range(top, 27):
            px[x, y] = shade(rgb(colour), 1.1 if y < top + 2 else 0.85 if y > 24 else 1)
    for (x, y) in ((12, 22), (16, 19), (20, 23), (14, 25), (18, 21)):
        px[x, y] = rgb(speck)
    return outline(img)


def cured():
    img = slab("#b0504a", "#d87a70"); px = img.load()
    for (x, y) in ((9, 11), (14, 15), (19, 12), (23, 19), (11, 20), (17, 21)):
        px[x, y] = rgb("#ffffff")                                       # grains of salt
    return img


def jerky():
    img = new(); px = img.load()
    for i, y in enumerate((9, 15, 21)):
        line(px, 6 + i, y + 2, 26 - i, y, rgb("#7a3a2a"), 3)
        line(px, 7 + i, y + 1, 24 - i, y - 1, rgb("#9a5040"))
    return outline(img)


def bones():
    img = new(); px = img.load()
    B = rgb("#ece4cc")
    for (x0, y0, x1, y1) in ((7, 24, 24, 8), (8, 9, 23, 23)):
        line(px, x0, y0, x1, y1, B, 2)
        for (cx, cy) in ((x0, y0), (x1, y1)):
            disc(px, cx + 0.5, cy - 1, 2, B, light=False); disc(px, cx + 1.5, cy + 1, 2, B, light=False)
    return outline(img)


def bonemeal():
    img = new(); px = img.load()
    S = rgb("#b89a6a")
    for x in range(8, 24):
        for y in range(12, 27):
            px[x, y] = shade(S, 1.1 if x < 11 else 0.8 if x > 20 else 1)   # a sack
    line(px, 10, 11, 22, 11, rgb("#8a6a40"), 2)                           # tied at the top
    for x in range(10, 22):
        for y in range(6, 11):
            if abs(x - 16) + (10 - y) < 7: px[x, y] = rgb("#e8e0c8")          # the meal spilling over
    return outline(img)


def bag():
    img = new(); px = img.load()
    L = rgb("#8a5a32")
    for x in range(7, 25):
        for y in range(14, 27):
            px[x, y] = shade(L, 1.15 if y < 16 else 0.8 if y > 24 else 1)
    poly(img, [(7, 14), (25, 14), (22, 19), (10, 19)], rgb("#a06a3a"))   # the flap
    px[16, 18] = rgb("#d8b060")                                          # its buckle
    for (x, y) in ((8, 13), (10, 8), (14, 5), (18, 5), (22, 8), (24, 13)):  # the strap
        px[x, y] = rgb("#6a4024")
    line(px, 8, 13, 10, 8, rgb("#6a4024")); line(px, 10, 8, 14, 5, rgb("#6a4024")); line(px, 14, 5, 18, 5, rgb("#6a4024"))
    line(px, 18, 5, 22, 8, rgb("#6a4024")); line(px, 22, 8, 24, 13, rgb("#6a4024"))
    return outline(img)


def boots():
    img = new(); px = img.load()
    L = rgb("#6a4428")
    for dx in (0, 11):
        poly(img, [(5 + dx, 6), (11 + dx, 6), (11 + dx, 20), (16 + dx, 22), (16 + dx, 26), (5 + dx, 26)], L)
        line(px, 5 + dx, 25, 16 + dx, 25, rgb("#3a2418"))                # the sole
        line(px, 6 + dx, 7, 10 + dx, 7, rgb("#8a6040"))
    return outline(img)


def chick():
    img = new(); px = img.load()
    Y = rgb("#f0d050")
    disc(px, 15, 20, 7, Y)
    disc(px, 20, 12, 4.5, Y)
    poly(img, [(24, 11), (28, 12), (24, 14)], rgb("#e08a30"))           # the beak
    px[21, 11] = OUT
    line(px, 13, 27, 13, 29, rgb("#e08a30")); line(px, 17, 27, 17, 29, rgb("#e08a30"))
    return outline(img)


def piglet():
    img = new(); px = img.load()
    P, PD, PL = rgb("#f2b8b4"), rgb("#c07a7e"), rgb("#f8d4d0")
    for x in (12, 18):
        line(px, x, 22, x, 26, PD, 2)
    disc(px, 15, 19, 6, P)
    disc(px, 22, 16, 4, P)
    disc(px, 25.5, 17, 1.8, PL, light=False)
    px[22, 14] = OUT
    line(px, 20, 12, 21, 11, PD)
    line(px, 9, 17, 8, 15, PD)
    return outline(img)


def feast():
    img = new(); px = img.load()
    for x in range(3, 29):
        for y in range(21, 27):
            if ((x - 16) / 13) ** 2 + ((y - 24) / 3.2) ** 2 <= 1: px[x, y] = rgb("#d8d0c0")   # the platter
    disc(px, 12, 18, 6, rgb("#b8702a"))                                   # a roast
    disc(px, 22, 19, 4, rgb("#c89a5a"))                                   # a loaf
    line(px, 25, 8, 25, 18, rgb("#d8a040"), 3)                            # a mug of beer
    line(px, 25, 7, 27, 7, rgb("#f4f0e0"), 2)
    return outline(img)


out = sys.argv[1]
things = {
    "huehnchen": rawmeat("#e8c8a8", "#f8ece0"), "entenfleisch": rawmeat("#b8605a"), "gaensefleisch": rawmeat("#c87a64"),
    "lammfleisch": rawmeat("#c8646a"), "ziegenfleisch": rawmeat("#b05a50"), "schweinefleisch": rawmeat("#e0868a"),
    "speckseite": slab("#e8b0a8", "#f8f0e8"), "rindfleisch": rawmeat("#a83a3a"), "rinderfilet": rawmeat("#c04848", "#d86060"),
    "federn": feathers(), "schaffell": fur("#e8e0cc"), "ziegenfell": fur("#a89a80"), "talg": slab("#f0e8d0", "#d8d0b8"),
    "schmalz": pot("#f4ecd8"), "borsten": bristles(),
    "grillhaehnchen": bird_roast("#c8782a"), "huehnersuppe": bowl("#e8c060"), "entenbraten": bird_roast("#a05a2a"),
    "gaensebraten": bird_roast("#b8702a"), "lammbraten": roast("#9a5030"), "eintopf": bowl("#9a6a3a"),
    "schweinebraten": roast("#b06030"), "bratwurst": sausage("#c07848", 2), "steak": steak(), "rinderbraten": roast("#7a3a2a"),
    "speck": bacon(), "schinken": ham("#c0605a"), "raeucherwurst": sausage("#8a4a32", 1), "schmalzbrot": lardbread(),
    "schlachtmesser": cleaver(), "salz": heap("#f4f4ee", "#c8ccd0"), "poekelfleisch": cured(), "trockenfleisch": jerky(),
    "knochen": bones(), "knochenmehl": bonemeal(), "ledertasche": bag(), "lederstiefel": boots(), "kueken": chick(),
    "ferkel": piglet(), "festessen": feast(),
}
for key, img in things.items():
    img.save(f"{out}/{key}.png")
if len(sys.argv) > 2:
    sheet = Image.new("RGBA", (10 * 110, 4 * 110), (58, 72, 52, 255))
    for i, img in enumerate(things.values()):
        sheet.alpha_composite(img.resize((96, 96), Image.NEAREST), ((i % 10) * 110 + 7, (i // 10) * 110 + 7))
    sheet.save(sys.argv[2])
