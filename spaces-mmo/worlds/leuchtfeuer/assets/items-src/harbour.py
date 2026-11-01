# The harbour's things in the style of the others (32x32, dark outline, light on top, shade below): a cow and its leather, a
# fish and a smoked fish (engine/commands/fishing.ts, animals.ts).
# Usage: python3 harbour.py <items dir>
import sys
from PIL import Image, ImageDraw

OUT = (0x17, 0x11, 0x1a, 255)


def rgb(h):
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16), 255)


def new():
    img = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def cow():
    img, d = new()
    for x in (8, 12, 20, 24): d.rectangle([x - 1, 21, x + 1, 27], fill=rgb("#4a3522"), outline=OUT)
    d.ellipse([5, 11, 26, 23], fill=rgb("#7a5a3a"), outline=OUT)
    d.ellipse([12, 13, 18, 18], fill=rgb("#f0ece0"))
    d.ellipse([20, 7, 30, 16], fill=rgb("#8a6a48"), outline=OUT)
    d.line([21, 6, 19, 3], fill=rgb("#e8e4d8"), width=2)
    d.line([28, 6, 30, 3], fill=rgb("#e8e4d8"), width=2)
    d.rectangle([24, 13, 29, 16], fill=rgb("#e8b8a0"))
    d.point([23, 10], fill=OUT); d.point([27, 10], fill=OUT)
    return img


def leather():
    img, d = new()
    d.polygon([(7, 6), (13, 9), (19, 9), (25, 6), (27, 13), (24, 19), (26, 26), (19, 24), (13, 24), (6, 26), (8, 19), (5, 13)], fill=rgb("#9a6a3a"), outline=OUT)
    d.line([12, 13, 20, 13], fill=rgb("#b98a55"), width=2)
    d.line([11, 19, 21, 19], fill=rgb("#7a5228"), width=2)
    return img


def fish(body, belly, smoked=False):
    img, d = new()
    d.polygon([(23, 16), (30, 9), (30, 23)], fill=rgb(body), outline=OUT)
    d.ellipse([3, 9, 25, 23], fill=rgb(body), outline=OUT)
    d.chord([4, 13, 24, 23], 10, 170, fill=rgb(belly))
    d.point([9, 14], fill=OUT)
    d.line([12, 11, 12, 21], fill=rgb("#17111a") if smoked else rgb(belly))
    if smoked:
        for x in (15, 18, 21): d.line([x, 11, x, 20], fill=rgb("#4a2a14"))
    return img


def beer():
    img, d = new()
    d.rectangle([9, 9, 21, 27], fill=rgb("#c89030"), outline=OUT)
    d.rectangle([7, 7, 23, 11], fill=rgb("#f0ece0"), outline=OUT)
    d.arc([19, 13, 28, 23], 270, 90, fill=OUT, width=2)
    return img


def heap():
    img, d = new()
    d.polygon([(4, 26), (16, 9), (28, 26)], fill=rgb("#d9c48a"), outline=OUT)
    d.line([12, 20, 20, 20], fill=rgb("#b9a46a"))
    return img


def pane():
    img, d = new()
    d.rectangle([7, 5, 25, 27], fill=rgb("#a8d0e0"), outline=OUT)
    d.line([11, 20, 20, 9], fill=rgb("#f0f8fc"), width=2)
    return img


def boat():
    img, d = new()
    d.polygon([(3, 15), (29, 15), (24, 25), (8, 25)], fill=rgb("#8a6a44"), outline=OUT)
    d.line([4, 18, 28, 18], fill=rgb("#b98a55"))
    d.line([20, 7, 12, 22], fill=rgb("#e8d8b0"), width=2)
    return img


def sailboat():
    img, d = new()
    d.polygon([(4, 21), (28, 21), (24, 28), (8, 28)], fill=rgb("#8a6a44"), outline=OUT)
    d.line([15, 4, 15, 21], fill=OUT, width=2)
    d.polygon([(17, 5), (27, 19), (17, 19)], fill=rgb("#e8e0c8"), outline=OUT)
    d.polygon([(13, 8), (13, 19), (6, 19)], fill=rgb("#d8d0b8"), outline=OUT)
    return img


def cart():
    img, d = new()
    d.rectangle([5, 12, 27, 20], fill=rgb("#8a6a44"), outline=OUT)
    d.line([6, 15, 26, 15], fill=rgb("#b98a55"))
    d.ellipse([11, 18, 21, 28], fill=rgb("#5a4028"), outline=OUT)
    d.line([1, 10, 6, 13], fill=OUT, width=2)
    return img


out = sys.argv[1]
for key, img in {"rind": cow(), "leder": leather(), "fisch": fish("#7f9fb0", "#d8e4e8"), "raeucherfisch": fish("#b0702a", "#d8a860", True), "bier": beer(), "sand": heap(), "glas": pane(), "ruderboot": boat(), "segelboot": sailboat(), "karren": cart()}.items():
    img.save(f"{out}/{key}.png")
