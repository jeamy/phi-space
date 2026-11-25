# Grid switch, phase 0: inventories

**Date:** 2026-11-24 · **Branch:** `new-world` · **Plan:** [3D world and grid plan](3d-welt-und-raster-plan-2026-11-21.en.md), phase 0

Phase 0 inventories what the grid switch touches before any format changes. This document holds the inventories in the order of the plan:

1. [Rule values in cells](#regeln) (plan section 2.4)
2. [Reactions to entering a cell](#betreten) (plan section 3, "Execution")
3. [Coordinate fields and their class](#klassen) (plan section 2.2)
4. [Cells that codemode-chat keeps](#codemode) (plan section 2.2, "Arena and codemode-chat")
5. [Decisions for phase 1](#offen), collected from the four
6. [References at scale 1](#referenzen) (plan section 6, cases 4 and 6, phase 0; semantic examples in 6.6)
7. [Plot writers and readers, the occupancy query](#belegung) (plan section 3, "Occupancy"; phase 1)

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
| `server/accounts.ts:337` scatter `randomInt(-3, 4)`, `randomInt(-2, 3)` around the spawn | ±3, ±2 | length | where a new character starts, before `freeCellNear` |

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
- `npc/economy.ts:540` (found with the rule table): an idle NPC wanders up to `±4` across and `±3` down. Length: 8 and 6. Its target is clamped to `1…22` and `1…14`, the inner edge of the base room of 24 × 16. That clamp is not a length (at scale 2 it is `1…46`, `1…30`, or better the room's own size, since a grown room is larger): *open for phase 2*. The Rust engine has the same at `npc/economy.rs:694`.
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

Found with the rule table, beside these: `client/cellActions.ts:62` (the `±2` window of "Hier möglich", the site reach), `:198` (a cell's reach, `<= 1`), `:304,309,310,316` (scenery, trees, sites from two cells, buildings from beside), `client/App.tsx:595` (a site's orders from two cells) and `:1032` (the action button's things within reach). They take `SITE_REACH`, `REACH_POINT` and `BESIDE`.

### 1.6 Generator

`worlds/leuchtfeuer/islands.ts:72,84,105,108` (rings and the one-cell clearance of plants from paths and doors): with `derivedFrom: 1` the generator runs with scale-1 values and is resampled (plan section 2.1). Its numbers stay. They become physical units only for a later native design (plan section 2.4).

### 1.7 Result for the plan

The table of plan section 2.4 gets the values of 1.1–1.3 and 1.5 by name. The 30 "beside" literals and the eight reach literals go through two named entries (`BESIDE`, `REACH_POINT`), so the switch changes two numbers instead of 38.

**Done in phase 1 (86881a5, on master).** The table is `shared/rules.ts`, with 22 rows: name, scale-1 value, kind, places. The Rust engine's copy is `rust/mmo-engine/src/rules.rs`, and `tests/rules.test.ts` holds the two together and holds every value to the literal it replaced. The reach to a fire is a row of its own (`FEED_FIRE`), apart from `REACH_POINT`, because at scale 2 it measures to the fire's footprint. The same goes for `FIRE_CLEARANCE` and `PASSAGE`. The ring beside and the flower's neighbour are "1 to the reach" (`onRing`, `flowerNeighbour`). `findPath`, `freeCellNear`, `stepBeside`, `besideOf` and `chooseTarget` take their bound as an argument without a default. `tests/semantic-examples.test.ts` takes the scale-2 bounds from the table (`ROW`) and holds each rule's scale-1 bound to its row. Not in the table:
- the values of the world definition (1.1);
- the client's search budget of `nextStep` (cells looked at, becomes the room area in phase 2);
- the step check;
- the ship's landing search (`shared/liner.ts:70`, Rust `liner.rs`): its ring is bounded by the room's own size (`Math.max(w, h)`), not by a constant, so it scales by itself.

*Open:* codemode-chat's lengths (section 4: `NEAR`, `JUMP_CELLS`, its copy of the subgoal reach, "3 cells in from the exit", and the texts that state them) are copies of its own. It imports nothing from spaces-mmo. They are tied to this table with the codemode-chat step of the cut (plan section 2.2, "Arena and codemode-chat"), through the repository's check of copies (`checks/shared-copies.test.mjs`), and not before.

**Rust, line by line.** Every TS place has its Rust counterpart with the same rule. The only difference in number is fishing: the four TS checks are one helper and the drop-off in Rust (1.4), so 28 Rust places for 30. The spawn scatter is in `rust/mmo-web/src/accounts.rs`, which takes it from the engine's table. No difference in value was found.

<a id="betreten"></a>

## 2. Reactions to entering a cell

The plan demands that an intent of two steps triggers in the cell between them whatever a single step would have triggered (section 3, "Execution"). Read for this: the movement commands (`commands/default.ts`: `step`, `moveTo`, `move`, `traverse`, `relocate`, `placeIn`; Rust `commands/default.rs`: `step`, `move_to`, `traverse`), every reader of `Character` positions in the engine, the world worker and the NPC process, and the client's walk.

**Server: one reaction, the exit.** `moveTo` checks the target cell against the room's exits (`default.ts:38`) and calls `traverse` on a hit. `traverse` (`default.ts:129`):

- checks the exit's locks (`check(c, exit.locks, "traverse")`);
- refuses in fog above `exit.fogMax` (`throughFog`, `default.ts:108`);
- hands the figure to another region (`handOff`, `engine/handover.ts`) or places it in the target room at the arrival cell, moved by the growth of the target room (`grownPoint`) and to the nearest free cell (`placeIn`);
- drops the figure's trade offers (`dropOffers`) and tells both rooms.

At scale 2 the exit is a 2×2 area (plan section 2.2): the hit becomes a footprint test, so leg one of a double step that enters any cell of it takes the exit and ends the intent.

**Server: what a step itself checks, per cell.** For a double step each of these must hold for both legs, in order:

- `walkable` terrain (`default.ts:246`);
- the cell is not blocked by an object (`blockedIn`, with the leaving-a-bed exception and the fire's own refusal text, `default.ts:42–46`);
- no other online figure holds the cell (the `Spot` with `unique`, `claimSpot`, `occupancy.ts`);
- on a passage cell around an exit (`isPassage`) the figure holds no Spot (`releaseSpot`, `default.ts:55`).

The step writes `ack`, or on a refusal `refused` with the position kept (`default.ts:248–254`). A double step writes one `ack` with the cell actually reached (plan section 3, "Acknowledgement").

**Nothing else reacts to a figure entering a cell.** Checked and not reactions:

- *Wild animals:* scaring them off is a command (`commands/wild.ts:298`, within `scareReach`), not an entry. No tick looks at where figures stand.
- *Zones* (`Zone`, `Motion.zone`): they restrict building (`zoneRefusal`, `commands/build.ts:87`); entering one does nothing.
- *Ship and train:* boarding and landing are commands and intents (`commands/passage.ts`, `commands/cart.ts`); landing is sent by the liner tick.
- *Fire light, fog, island counts:* `fire.ts:283` counts people per island, by room, not by cell.
- *NPC loops* (`npc/economy.ts`, `npc/settlers.ts`, `npc/requests.ts`): they walk with `move` and then act. They react to where they arrived, not to the cells crossed.

The Rust engine has the same single reaction (`default.rs:25` `move_to` → `default.rs:165` `traverse`). Both gateways check the step's shape (`server/gateway.ts:310`; `rust/mmo-web/src/gateway.rs:374`: `|dx|+|dy| = 1`); with the double step they admit length two on one axis (plan section 3).

**Client: three reactions, all on arrival.**

- Fetching a thing: when the own figure stands within reach of it, the page stops walking and picks it up (`client/App.tsx:1147`).
- Walking to a fire first (`App.tsx:1138`).
- A walk ending on an exit hands over to the room change (`client/walk.ts:76`).

They test the figure's acknowledged position against a reach (inventory 1.5), so a double step that passes the reach cell without stopping there is caught on the next acknowledged cell. The reach is 2 at scale 2, and a double step moves 2, so the figure cannot jump over it on a straight line.

**Result.** Phase 1 needs no general "entered cell" hook. The intermediate cell of a double step runs the same per-cell checks as a single step, and the exit test becomes a footprint test. The plan's phrase "whatever the inventory of phase 0 finds besides" finds nothing besides.

<a id="klassen"></a>

## 3. Coordinate fields and their class

From `shared/model.ts`, `server/engine/handover.ts` (`HandoverFields`), `server/engine/courier.ts` and every entry type the server writes (`space.write({ type: … })`, 94 types). Classes as in plan section 2.2.

**Area (position and footprint × `gridScale`)**

| Type | Fields |
| --- | --- |
| `Site`, `Building`, `Ruin`, `Scenery` | `x, y, w, h` |
| `Bed`, `Field`, `Tree` | `x, y, w, h` (`Tree.w/h` typed as literal `1`: plan section 2.1) |
| `Zone` | `x, y, w, h` |
| `Motion` | `zone: {x, y, w, h}` |
| `MillLoad` | `x, y, w, h` (the mill's place kept for when it is gone) |
| `SiteOrder` | `x, y, w, h` (the site's place) |
| `Room` | `building: {x, y, w, h}` (the outer footprint of an interior's building) |
| `Beacon` | `x, y` (gets `w, h`, plan section 2.2) |
| `Exit` | `x, y` (gets `w, h`) |

**Cell point (one exact cell, `(2x, 2y)` on conversion)**

| Type | Fields |
| --- | --- |
| `Character` | `x, y`; `aboard.spot: {x, y}` |
| `Handover` | `character.x, character.y` (and `character.aboard.spot`) |
| `Spot` | `x, y` |
| `Item` | `x, y` on the ground (`location` a room) |
| `Animal` | `x, y` |
| `Cart` | `x, y` |
| `Bed` | `plants[].x, plants[].y` (absolute, plan section 5) |
| `Exit` | `arrive: {x, y}` |
| `Room` | `spawn: {x, y}` |
| `Route` | `cells[]: {room, x, y}`, a path; plan section 5, "Roads and progress" (insert the missing cell) |
| `Road` | `cells[]: {x, y}`, the same path per room |
| `Plot` | `x, y`. Not converted: the occupancy migration removes plots before the grid migration (plan section 5) |

**Growth history: its own rule** (plan section 5, "Terrain, spawn and growth"). `RoomGrowth`: `east`, `south`, `baseWidth`, `baseHeight` (lengths, × 2); `steps[].at`, `steps[].size` (lengths, × 2); `steps[].fill` (each element twice).

**No room reference, unchanged**

- `Room.map` (atlas)
- `Item.x/y = -1` while carried (the inventory sentinel)

**Terrain itself.** `Room.ground`, `Room.decor`: resampled (plan section 2.4), not a coordinate field.

**Coordinates in text.**

- `Intent.line` (`move 5 7`, `versetze …`): an unexecuted intent blocks the release (plan section 5).
- `NpcMemory.text` (≤ 4 KiB, written by the model): may name cells. Phase 1 decides whether to clear it at the cut or keep it as stale prose.
- `Msg`, `Notice` texts: past messages, not converted.

**No coordinates.** Checked: the other written types. Their `at`, `from`, `to` are times, room or character ids or names (`Offer`, `Msg`, `Passage`, `Courier`, `Listing`, `Wanted`, `Variety`, `ShowEntry`, `Epoch`, `StoreLog`, `WorldLoaded`, …).

**Accounts space (`nano`).** `Account`, `Credential`, `NameAlias`, `WebSession`: no coordinates. A new character's place is computed from `Room.spawn` of the world region (`server/accounts.ts:329–338`), not stored in the accounts space. Step 1 of the cut still checks the actual store (plan section 5).

The class table of plan section 2.2 is this list. The start check fails on a coordinate field of a written type that has no class. Phase 0 implements it with exactly these rows.

<a id="codemode"></a>

## 4. Cells that codemode-chat keeps

**Task definitions in code (Leuchtfeuer cells, scaled with the cut).**

- `codemode-chat/server/island.ts:39–47, 94–…`: episodes as `[room, x, y]` for the start and the driftwood, in the rooms of the Graue Insel.
- `ANLEGER_FIRE = {room, x: 7, y: 5}` (`island.ts:92`): the fire of the Anleger, named in the task text (`tasks.ts:158–159`).
- Start cells become cell points `(2x, 2y)`. The fire becomes the centre of its 2×2 footprint where a text names it.

**Rule values (lengths, × 2).**

- `server/memory.ts:30` `NEAR = 3`: Manhattan, "near" for recall.
- `server/memory.ts:32` `JUMP_CELLS = 10`: cost of a jump between remembered paths.
- `server/subgoals.ts:13` "within 3 cells of `near`": the same as spaces-mmo's `SUBGOAL_NEAR`.
- `server/tides.ts:48`, `server/toyisland.ts:147`: "3 cells in from the exit".
- The model-facing texts that state them: `bottask.ts:140–141, 152–153`, `llm.ts:354`, `tasks.ts:135–136`.

**Stored entries (cell points, scaled with the cut, plan section 2.2).**

- `BotEpisode`: `path: PathStep[]` (`[room, x, y]`), `start`, `setup.items`.
- `PlanMemory` (`MemoryPath`): `path`, `obs` (tide observations with `x, y`).
- `BotRoom`: `geo`. Not converted, read anew from the arena (plan section 2.2).

**Not cells.** `PATH_MAX = 200` (`judge.ts:517`, the number of path points kept) and `MAX_MEMORY`.

**Toy islands: a world of their own at scale 1.** `server/toyisland.ts` and `server/toyarena.ts` play bots in the judge's own process on generated islands. Each room is "24 × 16 cells of ground inside a rim of water" (`toyisland.ts:3`), with the rules of `move`, exits, driftwood and fire written there. The Graue Insel is copied by its room names and exits (`island.ts` `ISLAND_ROOMS`), not by its cells. It shares no store or code with the engine. Open decision (5).

<a id="offen"></a>

## 5. Decisions for phase 1

1. **Rings at exactly 1** (1.3: `build.ts:124`, `npc/economy.ts:172`). Proposal: within the doubled reach and not on the footprint (1 to 2).
2. **Neighbouring flowers** (1.3: `garden.ts:297`). Proposal: Manhattan `<= 2`, two plants never on one cell.
3. **`MAX_TRAIL` of the arena** (1.2). Proposal: double it, so the trail keeps the same physical length.
4. **`NpcMemory` at the cut** (3). Proposal: clear it. The model writes it anew, and stale cells would send NPCs to the wrong place.
5. **Toy islands of codemode-chat** (4). Either they stay at scale 1, or they are scaled with the cut. Staying at scale 1:
   - their task texts and the `NEAR`/`JUMP_CELLS` values then differ from the arena's;
   - a remembered path from one world means nothing in the other.

   Proposal: scale them with the cut too, so the bots and the judge know one grid.

<a id="referenzen"></a>

## 6. References at scale 1

### 6.1 World lock per growth run

**Fixture.** `tests/growth-worst.ts` writes the worst case of room growth, and `tests/growth.test.ts` holds it to that. The case has every room of the largest region, which is `ost` with 13 rooms. Each room is all grass at (maxW − strip) × (maxH − strip) = 32 × 20 cells, the largest size that still has seams to try; at 36 × 24 there is no candidate at all. Its plots look like this:

- 505 of 640 cells are plots, so 79 % is taken and the room is full enough to grow (70 %).
- Only the upper-left part below half the width and height is free: 135 cells, with the spawn in the corner.
- Every seam lies at or beyond half the room, so the cells on both sides of it are plots.
- No rectangle crosses a seam. So all 28 candidates (17 east, 11 south) reach the seam check and are rejected. Before growth step 1 (the reference below) that check was `connected`, which ran two searches over the grown room for each candidate.

The sizes come from `w.growth`, so the same fixture serves the finer grid after the switch.

**Measurement.** `node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/growth-lock.ts`:

- It writes the fixture into a space process (`SPACES_MMO_SPACE_SERVER` selects the Rust one).
- It runs five growth runs of the TypeScript engine, then five of the Rust engine (`rust/mmo-engine/tests/growth_cost.rs`, started by the script) against the same space.
- It repeats both with no room full enough. Each room then stops after its reads, so the difference to a full run is the seam search.

The lock is taken once per room and released between rooms. Values are medians of five runs on this development machine, in ms per run of all 13 rooms:

| Space server | Engine | Run | Reads only | Search (difference) | Longest single hold |
| --- | --- | --- | --- | --- | --- |
| Rust (`mmo-space`, as on big and nano) | Rust (as on big and nano) | 513 | 211 | about 300 | – |
| Rust | TypeScript | 338 | 152 | about 186 | 42 |
| TypeScript | Rust | 766 | 461 | about 305 | – |
| TypeScript | TypeScript | 586 | 434 | about 152 | 70 |

**After growth step 1 (d5a2853, 2026-11-24).** The seam check labels the room's parts once (`shared/grid.ts`, `rust/mmo-engine/src/grid.rs`) and looks only at the cells beside each seam. It gives the same answer as `connected` (`tests/growth-seams.test.ts` and the test in `commands/growth.rs`, 300 random rooms). Same measurement, same machine, medians of five runs in ms:

| Space server | Engine | Run (reference) | Run | Reads only | Search (difference) | Longest single hold (reference) |
| --- | --- | --- | --- | --- | --- | --- |
| Rust | Rust (as on big and nano) | 513 | 192 | 184 | about 8 | – |
| Rust | TypeScript | 338 | 166 | 160 | about 6 | 21 (42) |
| TypeScript | Rust | 766 | 499 | 477 | about 22 | – |
| TypeScript | TypeScript | 586 | 400 | 431 | none measurable | 65 (70) |

The search is gone from the lock time. What is left is the 19 type reads per room. The Rust engine read them one after the other. Since 7b179b2 it sends them at once, as TypeScript does (`space::join_all`). Its runs went from 192 to 183 ms on the Rust space server and from 499 to 452 ms on the TypeScript one, about the spread between runs. So the reads are bound by the space server's work on each read, not by the round trips. Making them cheaper is a question for the occupancy query of growth step 2 (one rectangle query instead of 17 type reads), not for the engine. Under load the step does not change the behaviour: growth still takes the lock without waiting and defers while commands are open.

**On the servers.** The same measurement ran once on big and once on nano, on 2026-11-24, then everything was removed again. Each run used a throwaway container:

- the server's own `phi-spaces-mmo:rust` image (Node 22, `mmo-space`), with no network and at most 2 CPUs, removed after the run;
- the scripts and the world in a folder of their own, mounted read-only and deleted afterwards;
- the Rust measurement as a test binary built in `rust:1.99-bookworm`, the base of that image (`GROWTH_RUST_BIN`).

The deployed checkout and the running containers were not touched. The game kept running beside the measurement, so the values include its load. Medians in ms per run:

| Host | Space server | Engine | Run | Reads only | Longest single hold (TS) |
| --- | --- | --- | --- | --- | --- |
| big | Rust | Rust | 452 | 165 | – |
| big | Rust | TypeScript | 273 | 100 | 34 |
| big | TypeScript | Rust | 688 | 363 | – |
| big | TypeScript | TypeScript | 472 | 318 | 56 |
| nano | Rust | Rust | 840 | 323 | – |
| nano | Rust | TypeScript | 514 | 230 | 81 |
| nano | TypeScript | Rust | 1470 | 873 | – |
| nano | TypeScript | TypeScript | 1025 | 708 | 112 |

big runs the world. Its production pair holds the lock about 450 ms per worst-case run, which is close to this machine. nano is slower by about a factor of two. The order of the four pairs is the same everywhere.

For TypeScript the script also times the lock itself, from its take to the commit or abort of that transaction. The lock time is the run time less the first read of the rooms (Rust space: 335 of 338 ms).

**What this says for phase 1:**

- **Reference.** The production pair holds the lock about half a second per worst-case epoch run, in 13 holds. The 513 ms are measured. The hold per room (about 40 ms) is derived: the run divided by the rooms. The longest single hold is measured for the TypeScript engine only. This is the value the target of case 6 ("at most the reference") is measured against.
- **A relative reference.** The fixture's space holds only the worst-case rooms. A live region also has its exits, characters and items, which a room's reads under the lock take in as well (all `Exit` entries, unfiltered, per room). So the absolute values are lower than on big. They hold only against the same fixture at scale 2, measured the same way. They are not a statement about the live servers.
- **Reads under the lock.** The Rust engine reads its 19 entry groups of a room one after another inside the transaction (`commands/growth.rs`). The TypeScript engine sends them together (`Promise.all`). The reads are close to half of the Rust run. Sending them together, or reading the candidates from the mirror outside the lock (plan section 3, growth step 3), removes most of that part.
- **Search.** The Rust search is slower than the TypeScript one. It keys cells by strings and reads every cell through `walkable` on UTF-16 slices. The shared `Grid` (plan section 3, "Performance strategy") replaces both. At scale 2 the search does 8 times the work, about 2.4 s per run with today's code, so it cannot stay as it is.
- **Under load:** see below.

**How often a run comes.** The world worker runs growth in the job `epoch`, every world hour (`epochs.checkWorldMs`). The world clock on big runs at rate 24 (`WorldClock.rate`, read on 2026-11-24). So a region's growth run comes every 150 s of real time, not once an hour.

**What a run sends to the mirrors.** Growth takes the world lock and then the room in its transaction. Both disappear for plain readers until the transaction ends. When no seam is valid the transaction is aborted, and both come back. So every room a run reaches costs 4 revisions in the change stream (2 `del`, a `put` of the lock and a `put` of the whole `Room` entry), and nothing has changed in the end. Every mirror receives them: the gateway and the world worker. Measured with one run of the TypeScript engine on a TypeScript space:

| Space | Rooms reached | Revisions | Bytes in the change stream | of them `Room` puts |
| --- | --- | --- | --- | --- |
| the fixture alone | 13 | 53 | 16,901 | 11,962 |
| the loaded world and the fixture | 50 | 201 | 77,759 | 58,345 |

At scale 2 a `Room` entry carries four times the cells. Phase 1 should record this per run as well. With the occupancy version (plan section 3, growth step 1) a run that finds nothing changed would not take the room at all.

**Under load.** `node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/growth-load.ts` runs a stack as on the servers with the world loaded (world worker, npc process without model calls, web process) and the fixture beside it. It has four windows of 60 s:

- `idle`: growth runs alone;
- `load`: 50 guest figures of `tests/perf/live-load.ts` (they pick up, carry, sell and walk; they do not build);
- `load+growth`: the same figures with growth runs;
- `load again`: the figures alone once more.

A TypeScript growth run starts every 2 s. That samples many runs; it is not the production cadence. Every command reads the world lock in its transaction (`world-host.ts`), and a read inside a transaction makes the entry untakable for every other transaction until it ends (`spaces/src/core.ts`, `readBy`). Growth takes the lock without waiting. So a run stops as soon as a command is open. And while a run holds a room, every new command waits for it.

Rust space server, world worker, npc and web process, on this development machine:

| Window | Growth runs | Rooms reached per run (of 50) | Longest single hold | Answers p50 / p95 |
| --- | --- | --- | --- | --- |
| idle | 23, 17 complete; lock held 851 ms per complete run (median) | 50 | 38 ms | – |
| load | – | – | – | 60 / 265 ms |
| load+growth | 28, none complete | 0 (median) | 104 ms | 244 / 999 ms |
| of which sent while a run was open | | | | 611 / 2,094 ms (122 commands) |
| of which sent outside a run | | | | 222 / 873 ms (1,125 commands) |
| load again | – | – | – | 556 / 10,002 ms |

What it says:

- **Growth does not get through under steady load.** In 28 runs with 50 figures, no run reached all rooms, and the median run reached none. A full room in a busy region would not grow at scale 1 today. This is the behaviour of the code as it is ("a busy world defers growth"). Whether it happens on the servers is not measured. In copies of the local test bed's four region stores (2026-11-24, not production) the fullest room has 70 plots of 384 cells, far below 70 %.
- **A run slows the commands sent during it.** Inside the same window, commands sent while a run was open answered at about 2.8 times the median of the others, and at 2.4 times the p95. This split is the comparable value. The windows themselves are not comparable with each other: the answers drift over the run of the figures ("load again" is the slowest of all, without growth).
- **For case 6 this means:** under load "the time `WORLD_LOCK` is held per run" has no value to compare, because no run completes. What can be compared under load is the longest single hold and the ratio of the answers during a run to those outside one. Without load the lock time per run is the reference (6.1 above).
- **The Rust engine under load was not measured.** This script cannot see how far a Rust run gets (`growth_cost.rs` reports its time only). On the fixture alone it ran complete runs (table above).

### 6.2 Cells looked at per target choice

**Measurement.** `node --no-warnings --experimental-strip-types tests/perf/target-choice.ts`, with no browser and no space:

- The search is `nextStep` of `client/walk.ts`, with a `free` that counts its calls.
- The choice is copied from `walkTo` in `client/App.tsx`: the goal when it is free, else the first cell of rings 1 to 6 around it that is free and has a way. Keep the two alike until phase 1 replaces the choice by one search.
- The room is the largest one (36 × 24 = 864 cells), all grass, with three cases:

| Case | Candidates tried | Searches | Cells looked at | Time on this machine (node) |
| --- | --- | --- | --- | --- |
| reachable: free goal in the open room | 0 | 1 | 966 | 0.5 ms |
| unreachable: free goal, the figure on a strip behind a column of water | 0 | 1 | 828 | 0.5 ms |
| occupied and enclosed: the goal in a 3 × 3 building, everything around it beyond the water | 169 | 160 | 132,970 | 56 ms |

The third case is the one case 6 is about. Each free cell of the rings starts a search of its own, and each search floods the far side of the water (up to its limit of 1024 cells). So the cost is the number of candidates times the room, about 154 times the room's cells already at scale 1. On a phone it is a multiple of the 56 ms, close to one tick (150 ms) or above it. Case 6 sets the target "at most room area plus candidates". At scale 2 the same choice has 624 candidates in a room of 3456 cells. One search from the figure, as the plan says, is the fix. The phone's own time is recorded on the phone (case 5).

**After the one search (phase 1, 2026-11-24, `chooseTarget` in `client/walk.ts`).** The same script measures both. `legacy` is the choice as it was, `oneSearch` is the one search that replaced it. `oneSearch` is the choice alone: for a free goal `walkTo` still checks the way once (`nextStep`), as before.

| Case | Cells looked at before → after | Time before → after |
| --- | --- | --- |
| reachable | 966 → 1 (+ the way check) | 0.6 → 0.001 ms |
| unreachable | 828 → 1 (+ the way check) | 0.4 → 0.001 ms |
| occupied and enclosed | 132,970 → 312 | 53 → 0.2 ms |

`tests/walk.test.ts` holds the one search to the search per candidate over 400 random rooms, with the bound "at most room area plus candidates".

### 6.3 Commits of the server-driven movers

**Measurement.** `node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/mover-commits.ts`:

- It runs a stack as on the servers, without players: the space, a world worker that loads the world, and an npc process without model calls.
- It waits 20 s to settle, then counts 60 s.
- Every commit that changes what a reader sees is one revision (`statsWithRevision`). The batches of the change stream say which entry types each commit touched.

The world has 95 NPC characters, 0 animals and 0 carts after loading. TypeScript and Rust processes (`SPACES_MMO_SPACE_SERVER`, `SPACES_MMO_WORLD_CMD`, `SPACES_MMO_NPC_CMD`) give the same result:

- 214 commits in 60 s, 3.6 per second;
- 97 of them change nothing visible (lease renewals);
- of the rest: `Msg` 24, `WorldSchedule` 21, `Process` 18, `Driftwood` 10–14, `Restock` 9, … `Character` 3.

So without players the NPCs barely move: 3 `Character` commits a minute. Most of the commit load at scale 1 is the world's schedule and the leases, not the movers. The NPCs move by `move x y`, one commit per move, so finer cells do not add commits by themselves. The comparison "before and after, target unchanged" is made with this same run at scale 2. With 50 guest figures playing (`growth-load.ts`, all four windows) the NPC characters moved in 2 commits a minute, of 7,000 to 11,000 commits a minute in all. The figures of `live-load.ts` hardly call on NPCs, so this is the movers' own pace. Load with talking figures would need a load script of its own.

### 6.4 Frame sizes and the atlas

**Measurement.** `node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/frame-bytes.ts` (plan case 4):

- It starts a server as in production and connects one player.
- It measures the frames the page gets. The gateway sends each frame as its JSON text, so the bytes are those of the parsed frame.
- Then every room grows without the fill condition until none can grow, and the player connects again.

TypeScript and Rust processes give the same sizes, up to 1–2 bytes in `hello` and `atlasState`. Bytes, UTF-8:

| State | `hello` | its `room` | `atlas` | `atlasState` | Rooms in the atlas, their cells |
| --- | --- | --- | --- | --- | --- |
| base (as loaded; the player's room 24 × 16) | 30,623 | 1,124 | 21,355 | 805 | 37, 14,208 |
| maximal (every room grown; the player's room 36 × 24) | 32,162 | 2,132 | 39,067 | 807 | 37, 31,104 |

The plan's target for `atlas` is 25 KiB (25,600 bytes) for 37 base rooms. The base atlas takes 21,355 bytes of that already at scale 1. At scale 2 a base room has four times the cells. The gateway's preview must therefore sample 2 × 2 game cells per preview cell (plan section 4, "Atlas"), which brings it back to about the size measured here. The room's share of `hello` is small (4 to 7 %). Most of `hello` is the world's definition (tiles, skins, prototypes).

### 6.5 Reproducible growth cases

**Measurement.** `node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/growth-cases.ts`:

- It loads the world and grows every room without the fill condition until none can grow.
- For each room it records the steps it took (axis, seam, size) and its final size.
- It compares them with `tests/reference/growth-scale1.json`; `--write` writes that file anew.

Growth draws no chance, so a second run gives the same file, also with the Rust space and world worker loading the world. The cases cover 37 rooms and 179 steps. 34 rooms end at 36 × 24. `perlengrund`, `watt` and `wrackbucht` end at 36 × 16: none of their southern seams passed the checks of `growth.ts` (land, fill, reachability). After the switch the same run at scale 2 is held to this file: every seam and size times `gridScale`, the same sides in the same order.


### 6.6 Semantic examples of the distance rules

**What they are.** The plan asks for "semantic examples" at scale 1 and, for every range, to "test all sides and the first cell outside reach" (section 2.1). `tests/semantic-examples.ts` holds 15 rules of section 1 with their metric and their places:

- `BESIDE`, `REACH_POINT`, `FEED_FIRE`, `SITE_REACH`, `EXIT_REACH`, `FIRE_CLEARANCE`, `PASSAGE`;
- `RING_BESIDE`, `ON_FOOTPRINT`, `SCARE_REACH`, `SCARECROW_REACH`, `GREENHOUSE_REACH`, `SETTLER_CLEARANCE`, `MOVE_BUILDING`;
- `FLOWER_CROSS`.

Each rule has one target: an area of 3 × 2, a cell, or a fire or exit point. Its examples put the actor on all eight sides of the target, from on the target to two cells beyond the edge of the rule. Each example records the distance and the answer at scale 1. That gives 504 examples, kept in `tests/reference/semantic-scale1.json` (`node --no-warnings --experimental-strip-types tests/semantic-examples.ts --write`).

**What `tests/semantic-examples.test.ts` holds** (part of `npm test`):

- the file is what the rules give;
- every rule has answers on both sides of its edge;
- at scale 1 the distances are those of the engine's helpers (`distTo` of `commands/build.ts`, `reach` of `context.ts`); the rules whose formula stands inline in the code (`wild.ts` `gap`, `garden.ts:535`, `garden.ts:297`, `settlers.ts:91`) are written out in the file with their place;
- at scale 2 every example converted by plan section 2.2 keeps its answer:
  - a legacy point becomes (2x, 2y);
  - an area keeps its position and footprint × 2;
  - a fire or exit point becomes a 2 × 2 area, measured to its footprint;
  - a length doubles;
  - a ring "beside" becomes 1 to 2 and not on the footprint;
  - Manhattan `=== 1` between plants becomes `<= 2`, not the same cell (decision 2.3).

  A length left undoubled makes this test fail.

**Result.** All 504 answers hold at scale 2 under these conversions. This includes the sides where the converted footprint lies one cell closer (east and south: 2d − 1 instead of 2d), because every threshold doubles with it.

**For phase 1.** The scale-2 side of the test uses the conversions written in this file. When phase 1 writes the rule table into both engines, the test takes its thresholds from that table. The examples then hold the engines, not only the plan. The examples cover converted legacy points only. Cells a scale-2 world adds between them (odd coordinates) answer by the same doubled thresholds; the plan's acceptance case 1 covers them in a real room.

<a id="belegung"></a>

## 7. Plot writers and readers, the occupancy query

Phase 1, step 4. Every object that has a Plot per cell today, the places that write, take and read those plots, and the query that takes their place.

### 7.1 What stands on plots

Each plot carries the ID of its object in `of`. The objects:

| Object | ID field | Plots written (TS) | Plots taken |
|---|---|---|---|
| Site, Building | `buildId` | `build.ts` `bau` (the site), `jettyToWater` (an old jetty moved onto the water), `builder.ts` `versetze` | `freeCells` (`build.ts`): `abriss`, a site that lapsed, `jettyToWater`, `demolishByVote` |
| Ruin | `buildId` | none: it keeps the building's plots | `freeCells`: `abriss` of a ruin, the sweep at its end |
| Bed | `bedId` | `garden.ts`, `interior.ts` (a greenhouse's beds, in the inside's room), `versetze` | `freeCells` (`garden.ts`), `dropInterior` |
| Field | `fieldId` | `field.ts`, `versetze` | `freeCells` (`field.ts`: given up, lapsed) |
| Tree | `treeId` | `trees.ts`, `versetze` | `freeCells` (`trees.ts`: felled) |
| Scenery, not `through` | `sceneryId` | `loader.ts` (the world's scenery), `interior.ts` (the furnishings, in the inside's room) | `freeCells` (`scenery.ts`: cleared), `dropInterior` |

MillLoad, Zone and Motion have a rectangle but no plots. A fire (`Beacon`) has no plot either. Its cell blocks steps and building through `blockedIn` (`occupancy.ts`) and the clearance rule, but it does not count for the growth share (`growth.ts`: the share counts plots, `blocked` counts plots and fires).

Plot **readers**:
- `occupancy.ts` `blockedIn`;
- `build.ts` `refusal` (its own cells for `versetze`) and `takeNear` (the `held` case);
- `default.ts` `moveTo` (who stands on a bed or field walks off over it: the cell one stands on and the target must have the same `of`);
- `loader.ts` (scenery is not placed where a plot lies);
- `fire.ts` (free cells for wild seeds);
- `wild.ts` (cells covered);
- `growth.ts` (blocked cells, share, the shift of the plots with the room);
- `npc/settlers.ts`, `npc/economy.ts` (busy cells).

The Rust engine has the same places, file for file.

### 7.2 The query

`shared/footprints.ts` and `rust/mmo-engine/src/footprints.rs`:
- `occupancyOf` gives, per cell of a room, the object on it and three flags: `MOVE`, `BUILD` and `SHARE`. It derives them from the room's objects in the form of the shared grid (index y·w + x).
- `plotOccupancy` gives the same from the plots and the fires.
- `occupancyReport` names, by room, cell and object, what differs between the two: overlapping footprints or plots, a footprint beyond the room, a cell where the two give a different object or different flags. The migration (plan section 5, "Legacy plots and new occupancy") reports with the same function: `storeOccupancyReport` with `rooms: "required"`, so occupied cells in a room that is not there are reported too.

The two copies are held together by the same cases and the same report lines (`tests/footprints.test.ts`, the tests in `footprints.rs`). They are held to the game by two checks:
- Every test stack checks, when it closes, that the footprints give the plots' occupancy in every room (`tests/stack.ts`, also each region of `startRegions`). It runs after the workers have stopped and before the space stops. After a worker was killed it is skipped, because its open transaction keeps its objects taken while their plots stay readable until the lease runs out. A difference fails the test file through its exit code and does not hide a failure the test threw itself.
- The engine walks run the Rust query on every state they reach (`rust/mmo-engine/tests/common/walk.rs`, `Walk::compare`). What a walk writes or takes by hand (`Walk::write`, `Walk::take`) is left out in the same way as below.

Many fixtures write objects over the test's own connection without the plots a command writes, or take a site and leave its plots. In the first full run that gave 53 reports in 27 files. Their first lines all named objects a test had written itself; each of these fixtures writes its objects whole, by hand. The stack's connection therefore notes what a test writes or takes itself (`noting` in `tests/stack.ts`). The check leaves out only two cases: an object the test wrote that has no plot at all, and plots the test wrote, or left by taking their object, that belong to no object. It also leaves out the cell of an overlap with such an object. An object whose plots exist stays checked even when the test touched it: a building a test placed with its plots and the game then moved is the code step 6 replaces. Mutations held this. A bed written with one plot fewer (`garden.ts`) and `versetze` keeping the old plots of a building placed by the test are both reported. Two fixtures were corrected: the overlapping hut of `animals.test.ts`, and the single plots of the `sweeping` walk, now one per cell. Most of the left-out fixtures already have the target shape: an object without plots. The fixtures that place bare plots as an obstacle (`tonne-x`, `old-road`, `shed`, `wall` and others) change in step 6. A sporadic `plots say <id>, footprints nothing` at close would be a worker that ended on SIGTERM with a transaction open, not the game.

### 7.3 The readers stay on plots until step 6

The query switches no reader. An object taken in an open transaction (a site during a delivery, a bed while it is watered, what `takeNear` picks) is not read by other transactions, but its plots are. `takeNear`'s `held` case and every overlap check of `refusal` and `blockedIn` rely on that. A reader moved onto footprints before the room lock (step 5) lets two buildings overlap in that window. Step 6 switches the readers and writers together, behind the room lock, and the migration removes the plots.
