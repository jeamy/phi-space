# The tiles of a building's inside (docs/innenraeume.en.md): wooden planks for the floor and a wall of timber and
# plaster, two 32x32 tiles side by side in tilesets/Interior.png (planks at x 0, the wall at x 32).
# Usage: python3 interior.py <tilesets dir>
import sys
from PIL import Image, ImageDraw

W = 32


def rgb(h, a=255):
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16), a)


def planks(img, ox):
    d = ImageDraw.Draw(img)
    tones = ["#9a7048", "#8c6440", "#a27a50", "#946a44"]
    for i in range(4):
        y = i * 8
        d.rectangle([ox, y, ox + W - 1, y + 7], fill=rgb(tones[i]))
        d.line([ox, y, ox + W - 1, y], fill=rgb("#b48a5c"))  # light edge
        d.line([ox, y + 7, ox + W - 1, y + 7], fill=rgb("#5e4028"))  # gap between boards
        cut = (i * 11 + 7) % W  # where one board ends and the next begins
        d.line([ox + cut, y + 1, ox + cut, y + 6], fill=rgb("#5e4028"))
        for k in range(3):  # grain
            gx = ox + (cut + 5 + k * 8) % W
            d.point((gx, y + 3 + k % 2), fill=rgb("#7a5634"))
            d.point((gx + 1, y + 3 + k % 2), fill=rgb("#7a5634"))


def wall(img, ox):
    d = ImageDraw.Draw(img)
    d.rectangle([ox, 0, ox + W - 1, W - 1], fill=rgb("#d8ccb2"))  # plaster
    for x in range(0, W, 2):
        for y in range(0, W, 3):
            if (x * 7 + y * 13) % 5 == 0:
                d.point((ox + x, y), fill=rgb("#c8bc9e"))
    beam = rgb("#5a3e26")
    d.rectangle([ox, 0, ox + W - 1, 4], fill=beam)  # the top beam
    d.rectangle([ox, W - 5, ox + W - 1, W - 1], fill=beam)  # the sill
    d.rectangle([ox, 0, ox + 3, W - 1], fill=beam)  # posts
    d.rectangle([ox + W - 4, 0, ox + W - 1, W - 1], fill=beam)
    d.line([ox + 4, W - 6, ox + W - 5, 5], fill=beam, width=3)  # a brace
    d.line([ox, 0, ox + W - 1, 0], fill=rgb("#7a5634"))
    d.line([ox, W - 1, ox + W - 1, W - 1], fill=rgb("#2a1d10"))


img = Image.new("RGBA", (2 * W, W), (0, 0, 0, 0))
planks(img, 0)
wall(img, W)
img.save(f"{sys.argv[1]}/Interior.png")
