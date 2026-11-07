# The beekeeper's things in the style of the others (32x32, dark outline, light on top, shade below): a colony in its
# straw skep, a pot of honey, a lump of wax and a candle (engine/commands/animals.ts, recipe "kerze").
# Usage: python3 bees.py <items dir>
import sys
from PIL import Image, ImageDraw

OUT = (0x17, 0x11, 0x1a, 255)


def rgb(h):
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16), 255)


def new():
    img = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def bee(d, x, y):
    d.ellipse([x - 2, y - 1, x + 2, y + 1], fill=rgb("#e8b830"), outline=OUT)
    d.point([x, y], fill=OUT)
    d.point([x - 1, y - 2], fill=rgb("#e8f0f8")); d.point([x + 1, y - 2], fill=rgb("#e8f0f8"))


def skep():
    img, d = new()
    d.rectangle([4, 26, 27, 28], fill=rgb("#6a4a2a"), outline=OUT)
    d.chord([5, 5, 26, 40], 180, 360, fill=rgb("#d8a83a"), outline=OUT)
    d.rectangle([5, 22, 26, 26], fill=rgb("#d8a83a"), outline=OUT)
    for y in (10, 15, 20, 24):
        d.line([8 if y > 12 else 11, y, 23 if y > 12 else 20, y], fill=rgb("#a87a22"))
    d.line([11, 7, 20, 7], fill=rgb("#f0cc6a"))
    d.ellipse([13, 21, 18, 26], fill=rgb("#2a1a10"))
    bee(d, 25, 6); bee(d, 28, 12); bee(d, 4, 10)
    return img


def honey():
    img, d = new()
    d.rounded_rectangle([7, 9, 24, 28], radius=5, fill=rgb("#c8781a"), outline=OUT)
    d.rounded_rectangle([9, 13, 22, 26], radius=4, fill=rgb("#e8a830"))
    d.line([11, 15, 11, 23], fill=rgb("#f8d070"), width=2)
    d.rectangle([9, 5, 22, 9], fill=rgb("#d8c8a0"), outline=OUT)
    d.line([8, 9, 23, 9], fill=rgb("#8a6a44"))
    d.polygon([(15, 9), (18, 9), (17, 14), (16, 14)], fill=rgb("#e8a830"))
    return img


def wax():
    img, d = new()
    d.polygon([(5, 14), (14, 9), (27, 12), (27, 22), (18, 27), (5, 23)], fill=rgb("#d8b850"), outline=OUT)
    d.polygon([(6, 14), (14, 10), (26, 12), (18, 16)], fill=rgb("#f0d878"))
    for x, y in ((10, 19), (15, 21), (21, 19), (12, 24)):
        d.regular_polygon((x, y, 2), 6, fill=rgb("#b89838"))
    return img


def candle():
    img, d = new()
    d.ellipse([7, 24, 25, 30], fill=rgb("#8a6a44"), outline=OUT)
    d.rectangle([12, 10, 19, 27], fill=rgb("#f4e8b0"), outline=OUT)
    d.line([13, 11, 13, 25], fill=rgb("#fff8e0"))
    d.line([18, 11, 18, 26], fill=rgb("#d8c890"))
    d.line([15, 7, 15, 10], fill=OUT)
    d.ellipse([12, 1, 18, 9], fill=rgb("#f8a830"))
    d.ellipse([14, 4, 17, 8], fill=rgb("#fff0a0"))
    return img


out = sys.argv[1]
for key, img in {"bienenvolk": skep(), "honig": honey(), "wachs": wax(), "kerze": candle()}.items():
    img.save(f"{out}/{key}.png")
