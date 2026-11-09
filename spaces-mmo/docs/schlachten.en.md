# Slaughtering, cooking and the butcher's trade

What becomes of the farm's animals besides what they give alive (docs/siedeln.en.md "Animals on the farm"): slaughtering,
what the hearth and the smokehouse make of the meat, what else an animal gives, and who buys and sells it. This document
lists every option that was weighed. **Built** marks what the game has (step 1 and step 2, both 2026-11-09); everything
else is a possibility for later steps.

## 1. Slaughtering

| Point | Option | State |
| --- | --- | --- |
| Command | `schlachte [tier]` (aliases `schlachten`, `slaughter`, `butcher`) beside one's own coop or pen; the animal named must be the kind living there | **built** (`server/engine/commands/animals.ts`) |
| Who | only the owner of the house | **built** |
| Where | (a) directly at the coop or pen | **built** |
| | (b) a **butcher's shop** (`metzgerei`, from the village) in the room: every animal gives one more of its first yield (`animals.butcher.shop`), and the shop makes salted sausage and cured meat; beside it `schlachte` takes an animal one carries (no pair to keep, it has left its herd), and its map menu offers each carried animal | **built** (step 2) |
| Tool | the shell knife (`muschelmesser`, wear 5), worn by one each time, breaking at the end of its wear | **built** |
| | a **butcher's knife** (`schlachtmesser`, workshop: 2 stone, 1 plank, 1 kelp rope; wear 20), taken before the shell knife (`animals.butcher.tools`, the best first) | **built** (step 2) |
| The herd goes on | the last `keep` animals of a kind stay (`animals.butcher.keep` = 2: the last pair) | **built** |
| | **chicks and piglets** (`kueken`, `ferkel`; Gesa sells them): put in like the kind (`AnimalKindDef.young`), they take a place, give nothing and grow up after three real days (`PrototypeFields.turns` with `into`, turned by the sweep) | **built** (step 2) |
| Not slaughtered | bees (a kind without `slaughter`), dogs and cats (the keepers) | **built** |
| Map menu | "Ein Tier schlachten" on one's own coop or pen while carrying a butcher's or shell knife (`client/cellActions.ts`) | **built** |
| Herd yields | what the herd gave up to now is settled before (settleHerd), so nothing waiting is lost | **built** |

## 2. What each animal gives (raw)

The data is `AnimalKindDef.slaughter` in `worlds/leuchtfeuer/world.ts`.

| Animal | Meat | By-products | State |
| --- | --- | --- | --- |
| Hen | 1 chicken meat (`huehnchen`) | 2 feathers (`federn`) | **built** |
| Duck | 1 duck meat (`entenfleisch`) | 2 feathers | **built** |
| Goose | 2 goose meat (`gaensefleisch`) | 2 down, 1 lard (`schmalz`) | **built** |
| Sheep | 3 lamb (`lammfleisch`) | 1 sheepskin (`schaffell`), 1 tallow (`talg`) | **built** |
| Goat | 2 goat meat (`ziegenfleisch`) | 1 goatskin (`ziegenfell`) | **built** |
| Pig | 3 pork (`schweinefleisch`), 2 pork belly (`speckseite`) | 1 lard, 1 bristles (`borsten`) | **built** |
| Cow | 4 beef (`rindfleisch`), 1 beef fillet (`rinderfilet`) | 2 leather, 2 tallow | **built** |
| Sheep, goat, pig, cow | | bones (`knochen`): 1 each, a cow 2, ground to bone meal at the mill | **built** (step 2) |

## 3. What is made of it

Recipes of `world.recipes`, made with `craft <name>`. All dishes are food (`world.food.foods`): eaten, they shorten the rest
after work, at most 24 hours ahead.

| Ware | From | Where | Fed | State |
| --- | --- | --- | --- | --- |
| Roast chicken (`grillhaehnchen`) | 1 chicken meat, 1 driftwood | hut (hearth) | 8 h | **built** |
| 2 chicken soups (`huehnersuppe`) | 1 chicken meat, 1 carrot, 1 cabbage, 1 can of water | hut | 8 h | **built** |
| Roast duck (`entenbraten`) | 1 duck meat, 1 driftwood | hut | 10 h | **built** |
| Roast goose (`gaensebraten`) | 2 goose meat, 1 driftwood | hut | 14 h | **built** |
| Roast lamb (`lammbraten`) | 2 lamb, 1 driftwood | hut | 12 h | **built** |
| 3 stews (`eintopf`) | 1 goat meat, 2 potatoes, 1 beet, 1 can of water | hut | 10 h | **built** |
| Roast pork (`schweinebraten`) | 2 pork, 1 driftwood | hut | 12 h | **built** |
| 3 sausages (`bratwurst`) | 2 pork, with the shell knife | hut | 6 h | **built** |
| 5 sausages (`metzgerwurst`) | 2 pork, 1 salt, with the butcher's knife | butcher's shop | 6 h | **built** (step 2) |
| 2 steaks (`steak`) | 1 beef fillet, 1 driftwood | hut | 10 h | **built** |
| Roast beef (`rinderbraten`) | 2 beef, 1 driftwood | hut | 14 h | **built** |
| 2 breads with lard (`schmalzbrot`) | 1 lard, 1 bread | hut | 6 h | **built** |
| 2 tallow candles (`talgkerze`, they are candles) | 2 tallow, 1 linen | hut | – | **built** |
| Bacon (`speck`) | 1 pork belly, 1 driftwood | smokehouse | 6 h | **built** |
| Ham (`schinken`) | 2 pork, 1 driftwood | smokehouse | 10 h | **built** |
| 2 smoked sausages (`raeucherwurst`) | 2 sausages, 1 driftwood | smokehouse | 8 h | **built** |
| Smoked duck, smoked lamb | raw meat, driftwood | smokehouse | | later |
| Goulash | beef, potatoes (and an onion, a new crop) | hut | | later |
| 2 cured meat (`poekelfleisch`) | 2 pork, 1 salt | butcher's shop | 8 h | **built** (step 2) |
| 2 dried meat (`trockenfleisch`) | 2 beef, 1 salt, 1 driftwood | smokehouse | 8 h | **built** (step 2) |
| Leather (`leder`, `ziegenleder`) | 1 sheepskin or goatskin, 1 salt | **tannery** (`gerberei`, town) | | **built** (step 2) |
| Leather bag (`ledertasche`) | 2 leather, 1 kelp rope, shell knife | workshop | | **built** (step 2) |
| Leather boots (`lederstiefel`) | 3 leather, shell knife | workshop | | **built** (step 2, a ware) |
| Feast (`festessen`) | 1 roast goose, 1 roast pork, 2 bread, 2 beer | hut | 24 h | **built** (step 2) |
| Belt | leather | workshop | | later |
| Soap | tallow, ash | hut | | later (needs ash) |
| Brush | bristles, driftwood | workshop | | later |
| Feather pillow | feathers, cloth | loom | | later |
| Bone meal (`knochenmehl`) | bones | mill (`mill.grinds`) | | **built** (step 2) |

## 4. New raw materials

| Point | Option | State |
| --- | --- | --- |
| Salt | a **salt garden** (`salzgarten`, village: 4 stone, 4 clay, 2 driftwood): `harke` beside it gives 3 salt as work, without a tool (`world.salt`, `server/engine/commands/quarry.ts`); Wilma sells it too | **built** (step 2) |
| | salt only in fair weather (no salt in a gale) | later |
| Ash | falls when wood is put on a fire or burns in a hearth | later |

## 5. What it is good for

| Point | Option | State |
| --- | --- | --- |
| Food | every dish in the food list, long-lasting (roasts 12–14 h, roast chicken and soup 8 h, sausage 6 h): fed, one rests less after work | **built** |
| Spoiling (a new mechanic) | raw meat spoils after three real days, cooked dishes after five; smoked and cured things keep. A thing carries `turns`/`turnsAtMs` (spawned by `server/engine/prototypes.ts` from `PrototypeFields.turns`, on the second clock), the sweep job takes it then and tells whoever carries it (`server/engine/sweep.ts`); a listed thing waits. What the loader hands out before the clock exists (an NPC's stock) keeps | **built** (step 2) |
| Leather goods | a leather bag carried raises what one carries by 250, each kind once (`pack.bags`, `server/engine/pack.ts` packMax; the page adds it too) | **built** (step 2) |
| | boots let one walk faster or reach further | later (boots are a ware for now) |
| Bone meal as fertiliser | `dünge` beside a growing field: 2 bone meal raise its harvest by half, once a crop; the next fallow forgets it (`fields.dung`, `FieldFields.dunged`, `server/engine/commands/field.ts`) | **built** (step 2) |
| The wild | mice also go for sausage, bacon, ham and smoked sausage in a hut's chest, gulls for bacon, ham, smoked sausage and dried meat at the smokehouse (`wild.prey[].eats`) | **built** (step 2) |

## 6. Traders and buyers

| Who | Buys | Sells | State |
| --- | --- | --- | --- |
| **Wilma**, butcher at the Kupferhafen market (NPC `wilma`, script `haendler`) | raw meat, fillet, sheepskin, goatskin, leather, tallow, lard | sausage, bacon, ham, smoked sausage, roast chicken (carries 4 sausages, 2 bacon, 1 ham) | **built** |
| Marta | ham, bacon, smoked sausage (long-distance goods) | | **built** |
| Gesa | feathers, sheepskin, goatskin, bristles, tallow | | **built** |
| Gesa | | chicks (1/3) and piglets (3/6), cheaper than grown animals | **built** (step 2) |
| Department store | sausage, bacon, ham, roast chicken at fixed prices | | **built** |
| Inn in the harbour quarter (job board, Kupferhafen market) | 2 roast chickens (12 coins), 4 sausages (10), a roast goose for a feast (16) | | **built** |
| Reef fishers (job board, Riffdorf) | a ham and a bacon as provisions (14) | | **built** |
| Wilma, Marta, department store | Wilma sells salt and cured meat and buys bones; Marta buys cured and dried meat, leather bags and boots; the store salt, cured and dried meat, leather bags | | **built** (step 2) |
| Reef fishers, ferry, a pilot (job boards) | 2 cured meat (Riffdorf, 14), 2 dried meat (Schärenhafen, Kupferhafen, 14), leather boots (Kupferhafen, Rauchhafen, 16) | | **built** (step 2) |
| Harvest festival (job board, Kupferhafen market) | a feast (40) | | **built** (step 2) |
| Chapel | a roast (goose, lamb, pork, beef) or a feast as an offering (`chapel.offerings`) | | **built** (step 2) |

## 7. What else changes

- **Help and docs:** the help's article on animals has a section "Schlachten und Küche" / "Slaughtering and cooking"
  (`client/help/articles.ts`, `help.game.animals#slaughter`), the command table a row for `schlachte`, the help topic
  `tiere` a sentence; docs/siedeln.en.md no longer says that nothing is slaughtered.
- **Help (step 2):** the same article's sections on spoiling, salt, the tannery, bone meal, chicks and piglets, feasts and
  offerings (`#spoil`, `#salt`, `#leather`, `#bonemeal`, `#young`, `#feast`), the command rows of `harke` and `dünge`, the
  epoch table, the wild animals' list; the world's help topics `tiere`, `kapelle` and `bauen` (the bag).
- **Map menus (step 2):** "Salz harken" at a salt garden, "Düngen" at a growing field while carrying bone meal, the
  butcher's shop's and the tannery's recipes, chicks and piglets put into a coop or pen. The salt garden has a picture
  of its own in 2D and 3D (`client/buildings2d.ts`, `client/buildings3d.ts`); the butcher's shop and the tannery are
  houses in their colour.
- **Icons:** `worlds/leuchtfeuer/assets/items-src/meat.py` draws the 29 things of step 1 and the 11 of step 2
  (CREDITS.md).
- **Rust port (R8.2):** `schlachte` is engine code in `animals.ts`, written after the frozen commit the Rust engine is held
  against (docs/rust-portierung.en.md); the Rust engine follows when the oracle moves on. Recipes, things, prices, orders
  and the NPC are world data only (`world.json`). Step 2's engine code (the knife list and the shop in `schlachte`, young ones in
  `einstallen`/`ausstallen`/`stall`, `harke`, `dünge`, spoiling and growing up in `spawn` and the sweep, the bag in
  `packMax`) follows likewise.
- **Tests:** `tests/animals.test.ts` "slaughtering" (owner, knife and its wear, the last pair, bees, dogs, another's animals)
  and "the butcher's trade" (the butcher's knife first, the shop's bonus, a piglet in the pen growing up, meat spoiling
  in the sweep, bacon keeping, salt, the bag); `tests/field.test.ts` fertilises the field (its harvest and the next crop).
