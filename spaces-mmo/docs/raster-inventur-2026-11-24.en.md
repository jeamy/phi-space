# Grid switch, phase 0: inventories

**Date:** 2026-11-24 · **Branch:** `new-world` · **Plan:** [3D world and grid plan](3d-welt-und-raster-plan-2026-11-21.en.md), phase 0

Phase 0 inventories what the grid switch touches before any format changes. This document holds the inventories in the order of the plan:

1. [Rule values in cells](#regeln) (plan section 2.4): **done**, below.
2. Reactions to entering a cell (plan section 3, "Execution"): to follow.
3. Coordinate fields and their class (plan section 2.2): to follow.
4. Cells that codemode-chat keeps (plan section 2.2, "Arena and codemode-chat"): to follow.

Each inventory names the TypeScript place. The Rust engine (`rust/mmo-engine/src`) mirrors it file for file and function for function (`commands/build.ts` → `commands/build.rs`, `npc/economy.ts` → `npc/economy.rs`). The plan's single table of rule values is written in phase 1 from this list in both engines. When it is written, every Rust counterpart is checked line by line, and differences are added here.

<a id="regeln"></a>

## 1. Rule values in cells

**Kinds.** A *length* (a distance, a radius, a path limit, cells per unit of something laid out along a line) doubles at scale 2. An *area* (cells per unit of something laid out over an area) quadruples. A test *on the footprint* (`distTo(...) === 0`) and anything that is not a cell count do not scale. Physical reach keeps its metric (Chebyshev, `distTo` against a rectangle) and doubles its radius (plan section 2.1, "Ranges").

**Method.** Search both engines for named constants, numeric default arguments, uses of the distance helpers (`distTo`, `reach`, `dist`, `Math.abs`/`.abs()`), and the rule values of the world definition. Then read each hit. TS server and shared code: 82 lines with a distance helper. Rust engine and web: 75 lines. Client: listed separately (1.5). Not part of this inventory: the generator (`worlds/leuchtfeuer/islands.ts`, 1.6) and the 3D renderer's world-unit sizes (plan section 4).

### 1.1 World definition (`worlds/leuchtfeuer/world.ts`, types in `shared/world-def.ts`)

`world:json` scales these with `derivedFrom: 1`. `world.ts` stays in scale-1 cells.

| Path | Value | Kind | Read in |
| --- | --- | --- | --- |
| `growth.strip` | 4 | length | `commands/growth.ts` |
| `growth.maxW`, `growth.maxH` | 36, 24 | length | `commands/growth.ts` |
| `growth.fullShare` | 0.7 | ratio, stays | `commands/growth.ts` |
| `field.seedPerCells`, `field.sowPerCells`, `field.harvestPerCells` | 4, 8, 2 | area | `commands/field.ts:196,265,320` |
| crop `perCell` (yield per cell, as a divisor) | per crop | area | `commands/field.ts:55` |
| `cart.route.stonePer`, `cart.route.workPer` (cells per stone, per work) | 2, 4 | length | `commands/road.ts:260–261` |
| `wild.scareReach` | 3 | length | `commands/wild.ts:298` (also in the refusal text: "… Schritte") |
| `wild.scarecrowReach` | 3 | length | `commands/wild.ts:66,155` |
| `garden.greenhouse.reach` | 3 | length | `commands/garden.ts:535` |
| `townhall.zoneRadius` | 3 | length | `commands/townhall.ts:110` (written into `Motion.zone`) |

The plan's section 2.4 names only `growth.*`, `field.*PerCells` and `perCell`. The road costs, both wild reaches, the greenhouse reach and the zone radius are added to the table by this inventory. Footprint sizes (`w`/`h` of plans, `garden.bed`, `garden.commons`, `field`, interiors) are positions and footprints: `world:json` scales them by the class "area" (plan section 2.2), not by this table.

### 1.2 Named constants and default arguments

| Place (TS) | Value | Kind | Meaning |
| --- | --- | --- | --- |
| `commands/build.ts:270` `SITE_REACH` | 2 | length | reach to a site, tree, bed, scenery, mill load, road part (`build.ts:299,302`, `trees.ts:127,129,170,179`, `garden.ts:94,395`, `mill.ts:87`, `scenery.ts:12`, `road.ts:162,294`) |
| `commands/build.ts:80` `EXIT_REACH` | 2 | length | "belongs beside an exit" (`build.ts:388`), and settlers keep clear of exits (`npc/settlers.ts`) |
| `occupancy.ts:51` `freeCellNear(…, radius = 8)` | 8 | length | free cell near a point |
| `world.ts:139` `findPath(…, max = 40)` | 40 | length | command-bound path (`commands/default.ts:53`, `move` at `default.ts:230`) |
| `server/arena.ts:301` literal `400` | 400 | length | path for the bot's drawn trail (plan: 800) |
| `server/arena.ts:112` `SUBGOAL_NEAR` | 3 | length | subgoal reached within 3 cells (`arena.ts:325`); also in codemode-chat (inventory 4) |
| `server/arena.ts:73` `PATH_STEPS` | 200 | count of trail points shown, stays | `pathOf` thins the trail; not cells |
| `server/arena.ts:72` `MAX_TRAIL` | 20,000 | length | trail steps kept. Twice the steps for the same walk: decide in phase 2 whether to double it |
| `npc/economy.ts:167` `stepBeside(…, reach = 1)` | 1 | length | NPC stands beside a building |
| `npc/settlers.ts:74` `besideOf(…, reach = 1)` | 1 | length | the same for settlers |
| `commands/build.ts:662` `MOVES_PER_COMMAND` | 100 | things, stays | not cells |

### 1.3 Bare numbers in distance comparisons (TS server)

**"Beside" an object, `distTo(actor, object) <= 1`: length, becomes 2.** This is the largest group: one rule ("stand directly beside"), 30 places:

- `commands/build.ts:566,619,632,680,712,805,817,818`
- `commands/animals.ts:73,171,307,353`
- `commands/interior.ts:155,160,174,207`
- `commands/fishing.ts:27,47,84,124`
- `commands/chapel.ts:26`, `festival.ts:32`, `mill.ts:49`, `quarry.ts:15`, `townhall.ts:72,101`, `cart.ts:226`, `wild.ts:322`
- the refusing form `> 1`: `sleep.ts:84`, `shop.ts:183`

These should take one named reach (`BESIDE`) from the table rather than 30 literals.

**Reach to a point, `reach(...)`/Chebyshev `<= 1`: length, becomes 2.**

- `commands/default.ts:288`: pick up an item
- `commands/default.ts:418`: feed a fire (`> 1`). The fire becomes a 2×2 area, so this becomes a footprint distance (plan section 2.2).
- `commands/cart.ts:46`: own cart
- NPCs feeding a fire: `npc/settlers.ts:135,451`, `npc/economy.ts:403`, `npc/requests.ts:62,65`

**Clearance around fires and exits: becomes a footprint test plus radius** (plan section 2.1).

- `commands/build.ts:102`: "So nah am Feuer baut man nicht", Chebyshev `<= 1` around the fire point
- `occupancy.ts:34`: `isPassage`, Chebyshev `<= 1` around the exit point. The passage radius is kept separately (plan section 2.2, cell points).

**Rings at exactly 1 (`=== 1`, `!== 1`).**

- `commands/build.ts:124`: candidate rectangles touching a cell
- `npc/economy.ts:172`: `stepBeside`'s free cell at distance exactly 1

*Decision for phase 1:* a ring "beside" becomes "within the doubled reach and not on the footprint", 1 to 2. Otherwise a figure on the ring at distance 1 would block the cell at distance 2 that was meant.

**Other lengths.**

- `commands/build.ts:185`: candidate places for moving a building, tested within `distTo > 3` of the old one, over a window of `±2`. Length: 6 and `±4`.
- `npc/settlers.ts:91`: a settler's new place keeps Chebyshev `<= 2` from exits and fires. Length: 4.
- `commands/garden.ts:297`: crossing of flowers needs a neighbouring plant, Manhattan `=== 1`. *Open question for phase 1:* plants are cell points in a bed whose capacity is `w·h/gridScale²` (plan section 2.1). At scale 2 two plants of a converted bed stand two cells apart. The rule becomes Manhattan `<= 2`, plants not on the same cell.

**Not cells or not scaled.**

- `distTo(...) === 0` (on the footprint): `build.ts:48,103,112,169,401,480`, `scenery.ts:13`, `interior.ts:174`
- `npc/requests.ts:51` `> 0`
- `npc/economy.ts:168` `> 0`
- `commands/default.ts:241` and `server/gateway.ts:310`, `|dx|+|dy| !== 1`: the step check. The plan's double step replaces it (section 3, "Movement"); not a rule value.
- `commands/beam.ts:28`: atlas room steps (`Room.map`)
- `context.ts:76`: an edit distance of words
- `context.ts:140`, `npc/economy.ts:181`, `npc/requests.ts:48`, `arena.ts:242`: sort by distance, no bound
- `shared/liner.ts:70`: ring of the ship's landing search. Its radius is a loop variable; check its bound in phase 1.

### 1.4 Rust engine

The same rules sit in the same files: `commands/build.rs` (16 hits), `animals.rs` (4), `interior.rs` (5), `fishing.rs` (2: the four TS checks of `fishing.ts` go through one helper at `fishing.rs:37` and the drop-off at `:77`), `chapel.rs`, `festival.rs`, `mill.rs`, `quarry.rs`, `shop.rs`, `sleep.rs`, `townhall.rs`, `wild.rs`, `cart.rs`, `default.rs`, `scenery.rs`, `road.rs:232,447`. In `occupancy.rs:39` the `is_passage` check, `context.rs:250` `reach`. NPCs: `npc/economy.rs:229,551`, `npc/settlers.rs:104,168`, `npc/requests.rs:66,82,85`. In `mmo-web` the step check of the gateway (`rust/mmo-web/src/gateway.rs`). The constants of 1.2 have their Rust names in the same files (`SITE_REACH`, `EXIT_REACH`, `find_path` and `free_cell_near` take their bound as an argument without a default).

### 1.5 Client (`client/`)

The client mirrors several server rules to show and pre-check actions. It takes the same table (from `shared/`) so that both sides agree.

| Place | Value | Kind | Meaning |
| --- | --- | --- | --- |
| `client/walk.ts:78` `nextStep(…, limit = 1024)` | 1024 | cells looked at | becomes the room area (plan section 3, "Path finding") |
| `client/walk.ts` `MAX_AHEAD`, `WALK_MS` | 8, 150 | intents, ms; stay (starting values, plan section 3) | |
| `client/App.tsx:964` rings `r <= 6` of the target choice | 6 | length → 12 | target choice (plan section 3, performance strategy) |
| `client/App.tsx:444,1147`, `client/cellActions.ts:198,275,295` | `<= 1` | length → 2 | "close enough to pick up / use" |
| `client/App.tsx:1138` | `> 1` | length → 2 | walk to the fire first |
| `client/App.tsx:925` | `<= 1` around exit | footprint test + radius | client copy of `isPassage` |
| `client/cellActions.ts:255`, `client/MapView.tsx:351` | `<= 2` | length → 4 | "near a road / own figure" in the menu |
| `client/Atlas.tsx:92` | `=== 1` on `Room.map` | atlas steps, stays | |

### 1.6 Generator

`worlds/leuchtfeuer/islands.ts:72,84,105,108` (rings and the one-cell clearance of plants from paths and doors): with `derivedFrom: 1` the generator runs with scale-1 values and is resampled (plan section 2.1). Its numbers stay. They become physical units only for a later native design (plan section 2.4).

### 1.7 Result for the plan

- The table of plan section 2.4 gets the values of 1.1–1.3 and 1.5 by name. The 30 "beside" literals and the eight reach literals go through two named entries (`BESIDE`, `REACH_POINT`), so the switch changes two numbers instead of 38.
- Three questions for phase 1:
  - the ring at exactly 1 (1.3);
  - neighbouring flowers (1.3);
  - `MAX_TRAIL` of the arena (1.2).
