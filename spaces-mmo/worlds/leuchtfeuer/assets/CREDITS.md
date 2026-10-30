# Credits

All graphics in this directory come from [Intersect-Assets](https://github.com/AscensionGameDev/Intersect-Assets),
branch `main_full`, commit `7653835384e682819717a56405f4687845ed8d2f`, folder `resources/`. They are used unchanged
and are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) as stated in the commit that added
each file. The game shows this attribution under "About".

| File | Original path | Authors | License (source commit) |
| --- | --- | --- | --- |
| `tilesets/Ground.png` | `resources/tilesets/Ground.png` | Zetasis | CC BY 4.0 (`1196a9f2a0`: "Tileset additions and updates by Zetasis! Licensed CC BY 4.0.") |
| `tilesets/Autotiles_Water.png` | `resources/tilesets/Autotiles_Water.png` | George, Murdoc, Zetasis | CC BY 4.0 (`f63e82f1b3`: "Water and Lava autotiles meeting various terrains. Credit goes to George, Murdoc, and Zetasis for making several extras. Licensed CC BY 4.0.") |
| `entities/Misc_George.png` | `resources/entities/Misc_George.png` | PixelFox | CC BY 4.0 (`db524ad177`: "Characters and Monsters from PixelFox. Licensed CC BY 4.0.") |
| `entities/Misc_PixelFox.png` | `resources/entities/Misc_PixelFox.png` | PixelFox | CC BY 4.0 (`db524ad177`) |
| `entities/Misc_jcsnider.png` | `resources/entities/Misc_jcsnider.png` | PixelFox | CC BY 4.0 (`db524ad177`) |
| `entities/Misc_Zetasis.png` | `resources/entities/Misc_Zetasis.png` | Zetasis, after designs by PixelFox | CC BY 4.0 (`58b2c06c3e`: "Sprites commissioned from Zetasis. Draws from PixelFox's original designs. Licensed CC BY 4.0.") |
| `entities/Misc_Kibbelz.png` | `resources/entities/Misc_Kibbelz.png` | Zetasis, after designs by PixelFox | CC BY 4.0 (`58b2c06c3e`) |

Item icons of the pack (mostly CC BY-SA 3.0) are deliberately not included.

## Plants (`tilesets/Plants.png`)

Cut unchanged (32 px cells, rearranged onto one small sheet) from `resources/tilesets/Overworld.png` of the same commit.
Authors: George (AGD), commissioned and extended by Murdoc; licensed CC BY 4.0 (`7b19f8ee6b`: "Tilesets commissioned by
Murdoc. Includes, and is based off tiles originally released by George at AGD. Licensed CC BY 4.0. Original Tiles
Release: https://www.ascensiongamedev.com/topic/742-16x16-custom-assets/"). The game tints some of the white flowers.

| Cut in `Plants.png` (x, y, w×h px) | Cell of `Overworld.png` (column, row of the 32 px grid) |
| --- | --- |
| 0, 0, 32×32 flowers | (2, 4) |
| 32, 0, 32×32 flowers | (3, 4) |
| 64, 0, 32×32 flowers | (4, 4) |
| 96, 0, 32×32 flower stalk | (1, 4) |
| 128, 0, 32×32 leafy plant | (0, 4) |
| 160, 0, 32×32 fern | (2, 5) |
| 192, 0, 32×32 rose bush | (3, 6) |
| 224, 0, 32×32 round bush | (4, 6) |
| 0, 32, 32×64 small tree | (5, 6) and (5, 7) |
| 32, 32, 32×64 conifer | (2, 6) and (2, 7) |

## Item icons (`items/`)

32×32 icons cut unchanged from the sheet `#1 - Transparent Icons.png` of
[Shikashi's Fantasy Icons Pack](https://shikashipx.itch.io/shikashis-fantasy-icons-pack) v2 (19 April 2020) by
**Matt Firth (shikashipx)**, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (as stated on the itch.io
page). Many icons of the pack are based on designs from [game-icons.net](https://game-icons.net) (CC BY 3.0).

| File | Icon of the pack (column, row of the 32 px sheet) |
| --- | --- |
| `items/treibholz.png` | wood (0, 17) |
| `items/holzbuendel.png` | wooden beam (11, 19) |
| `items/muschel.png` | fossil (13, 16) |
| `items/tang.png` | herb (15, 11) |
| `items/muenze.png` | crown coin (7, 12) |
| `items/muschelmesser.png` | broad dagger (6, 5) |
| `items/tangseil.png` | rope (13, 10) |
| `items/bernstein.png` | orange orb (3, 18) |
| `items/kette.png` | gold necklace (6, 8) |
| `items/tran.png` | full orange flask (7, 19) |

`items/perle.png` is `I_Opal.png` of [496 pixel art icons for medieval/fantasy RPG](https://opengameart.org/node/39455)
by Henrique Lazarini (7Soul1), [CC0](https://creativecommons.org/publicdomain/zero/1.0/), its one-pixel transparent
border cut off (34 → 32 px).

`items/netz.png` was drawn for this world in the style and with the colours of the pack above, by the script
`items-src/net.py` (same license as this project).

The garden's things (`items/spaten.png`, `items/wasserkanne.png`, the five `items/samen-*.png`, `items/strandnelke.png`,
`items/duenenrose.png`, `items/nebelblume.png`, `items/kohl.png`, `items/moehre.png`), the hare (`items/hase.png`) and the field crops
(`items/weizen.png`, `items/gerste.png`, `items/hafer.png`, `items/kartoffel.png`, `items/ruebe.png`,
`items/samen-ruebe.png`, `items/flachs.png`, `items/leinsamen.png`) and what mill, bakery and spindle make of them
(`items/mehl.png`, `items/brot.png`, `items/spindel.png`, `items/leinen.png`), the farm's animals and what they give
(`items/huhn.png`, `items/schaf.png`, `items/ziege.png`, `items/ei.png`, `items/wolle.png`, `items/milch.png`, `items/ente.png`, `items/gans.png`, `items/daunen.png`), and what is made of
it (`items/tuch.png`, `items/decke.png`, `items/kaese.png`) were drawn for this world in the
same way, by the script `items-src/garden.py` (same license as this project).

