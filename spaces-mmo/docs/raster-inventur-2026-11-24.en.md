# Grid switch, phase 0: inventories

**Date:** 2026-11-24 · **Branch:** `new-world` · **Plan:** [3D world and grid plan](3d-welt-und-raster-plan-2026-11-21.en.md), phase 0

Phase 0 inventories what the grid switch touches before any format changes. This document holds the inventories in the order of the plan:

1. [Rule values in cells](#regeln) (plan section 2.4)
2. [Reactions to entering a cell](#betreten) (plan section 3, "Execution")
3. [Coordinate fields and their class](#klassen) (plan section 2.2)
4. [Cells that codemode-chat keeps](#codemode) (plan section 2.2, "Arena and codemode-chat")
5. [Decisions for phase 1](#offen), collected from the four
6. [References at scale 1](#referenzen) (plan section 6, cases 4 and 6, phase 0; semantic examples in 6.6)
7. [Plot writers and readers, the occupancy query](#belegung) (plan section 3, "Occupancy"; phase 1; the searches on the shared grid in 7.7, a road's cells in 7.8)

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

- `BotEpisode` (as `judge.ts` `episodeEntries` writes it, not the task's `BotEpisode` type): `path`, `jumps` (pairs of steps) and `subgoalAt`, each `[room, x, y]`. It keeps no `start` or `setup` (corrected 2026-11-28; those are in the task definitions in code).
- `PlanMemory` (`MemoryPath`): `path`, `obs` (`TideSeen` `x, y`; `ChanceSeen` `rooms[].pieces[].x, y`). Its `memoryId` is made of its content (`memoryIdOf`, `observationIdOf`), and `MemoryFreeze.memoryIds` names those ids. `fromFire` counts exits between rooms, not cells.
- `Subgoals`: `subgoals[].near` (found 2026-11-28).
- `BotRoom`: `geo`. Not converted, read anew from the arena (plan section 2.2).
- `BotRun`/`BotCall`: a durable judge's log of a run in flight (6 h lease), with the calls of its scale.

**Not cells.** `PATH_MAX = 200` (`judge.ts:517`, the number of path points kept) and `MAX_MEMORY`.

**Toy islands: a world of their own at scale 1.** `server/toyisland.ts` and `server/toyarena.ts` play bots in the judge's own process on generated islands. Each room is "24 × 16 cells of ground inside a rim of water" (`toyisland.ts:3`), with the rules of `move`, exits, driftwood and fire written there. The Graue Insel is copied by its room names and exits (`island.ts` `ISLAND_ROOMS`), not by its cells. It shares no store or code with the engine. Open decision (5); decided 2026-11-24 (plan section 2.3) and built 2026-11-27 (plan step 6): at scale 2 an island is the island of scale 1 with every cell two by two (`codemode-chat/server/grid.ts`).

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

**After growth steps 2 and 3 (phase 1 step 7, 2026-11-25).** A room's lock carries its occupancy version (`RoomLock.version`), which every holder counts up when it writes the lock back (`holdRoomVersion`, `room-lock.ts`, `room_lock.rs`). Growth decides each room first on a view, before it takes anything (`growthStep` in `commands/growth.ts`, `growth_step` in `growth.rs`). The view is the world worker's copy (`Mirror`; Rust: the copy behind `Space::with_mirror`, `world_host.rs`) after `fresh`, or the space outside a transaction.
- A room whose lock is not visible (held right now), whose decision is kept, or that has no step is passed over: no lock, nothing sent to the change stream.
- A decision of no step is kept with its key (`growthKey`). The key holds the version and the Room entry's id, plus as values every rectangle, the footprints, the fires and the exits: what is written without the room's lock (fires, zones, motions, mill loads, site orders) and what a test writes by hand. So a fire that goes out lets the room grow on the next run.
- Only a room with a step takes WORLD_LOCK, its island's lock and its own. Its version must still be the one the view showed, else the room changed since and is left to the next run. Then the decision is made again on the transaction's reads, as before, and only that decision is executed.

`tests/growth-gate.test.ts` holds this:
- a run that grows nothing sends no revision;
- a fire on the only way keeps the room from growing, and once it is out the room grows on the next run;
- a version that changed between the view and the take leaves the room alone;
- over 80 rounds of random changes written by hand (footprints, fires, zones), runs that keep their decisions grow exactly what runs without them grow.

With the fires, or the version comparison, removed, these tests fail. `growth.rs` has a test that every input changes the key and that a rewrite keeping its rectangles does not.

The same measurement (`tests/perf/growth-lock.ts`, now also with `cold`, a run with the kept decisions forgotten, `kept`, and samples of one room that grows), medians in ms on this machine. Here the view is the space outside a transaction, not the copy:

| Space server | Lock held per run that grows nothing (reference) | Revisions per such run (reference) | Run, TS engine | Run, Rust engine (first, then kept) | One growing room: lock held, longest hold | Revisions of that run |
| --- | --- | --- | --- | --- | --- | --- |
| Rust | 0 (335 TS, 513 Rust) | 0 (53) | 69 | 108, 82 | 26, 35 | 11 |
| TypeScript | 0 (400) | 0 (53) | 97 | 166, 113 | 69, 78 | 11 |

A run still takes about as long as before step 2: it reads the rooms through the space. Keeping a decision saves the computation, not those reads; a run on the copy (the world worker) reads nothing from the space. What a run holds the lock for is now the room that grows, about one room's former share. A busy world no longer meets growth's lock unless a room has a step.

**How often a run comes.** The world worker runs growth in the job `epoch`, every world hour (`epochs.checkWorldMs`). The world clock on big runs at rate 24 (`WorldClock.rate`, read on 2026-11-24). So a region's growth run comes every 150 s of real time, not once an hour.

**What a run sends to the mirrors.** Growth takes the world lock and then the room in its transaction. Both disappear for plain readers until the transaction ends. When no seam is valid the transaction is aborted, and both come back. So every room a run reaches costs 4 revisions in the change stream (2 `del`, a `put` of the lock and a `put` of the whole `Room` entry), and nothing has changed in the end. Every mirror receives them: the gateway and the world worker. Measured with one run of the TypeScript engine on a TypeScript space:

| Space | Rooms reached | Revisions | Bytes in the change stream | of them `Room` puts |
| --- | --- | --- | --- | --- |
| the fixture alone | 13 | 53 | 16,901 | 11,962 |
| the loaded world and the fixture | 50 | 201 | 77,759 | 58,345 |

At scale 2 a `Room` entry carries four times the cells. Phase 1 should record this per run as well. With the occupancy version (plan section 3, growth step 2) a run that finds nothing changed would not take the room at all; see "After growth steps 2 and 3" below.

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

**Under load after growth steps 2 and 3 (phase 1, 2026-11-26).** Same script, same Rust stack, on this development machine.
- A room without a step takes no lock any more, so the worst case alone reaches no room at all.
- For that reason the script now keeps a room with a step waiting beside the fixture in each window with growth: as full as the others, with its first row free.
  - `GROWTH_GROWING` sets how many such rooms per window, one after the other, each written once the last one grew. The default is 1; `0` gives the configuration measured above.
  - More than a few make the store heavier window by window. A run that wrote one after every growth (24 in the idle window) slowed even the `load` window to 355 / 1,031 ms and is not counted.
- `refused` counts the takes a run was refused, by type. A `RoomGrowth` count there is a room that never grew, so it has no entry yet. A `Lock` count is `WORLD_LOCK`.

| Run | Window | Growth runs | Longest single hold | Rooms with a step | Answers p50 / p95: all, during a run, outside one |
| --- | --- | --- | --- | --- | --- |
| A: none waiting | idle | 29, no room reached | 0 | – | – |
| | load | – | – | – | 52 / 253 |
| | load+growth | 20, no room reached | 0 | – | 203 / 684; 266 / 1,092 (386 commands); 174 / 580 (896) |
| | load again | – | – | – | 550 / 1,378 |
| B: one | idle | 29 | 44 ms | grew in its first run, 164 ms after it was written | – |
| | load | – | – | – | 61 / 343 |
| | load+growth | 17 | 70 ms | grew in its first run, after 494 ms; lock held 70 ms | 286 / 1,063; 366 / 1,225 (497); 246 / 857 (789) |
| | load again | – | – | – | 777 / 1,655 |
| C: five | idle | 28 | 44 ms | 5 of 5 in their first run, 136 ms (median); lock held 37 ms | – |
| | load | – | – | – | 91 / 509 |
| | load+growth | 11; `WORLD_LOCK` refused in 8 | 84 ms | 3 grew after 2 runs (median), at most 4; 4.7 s, at most 13.4 s; the fourth still waiting after 4 runs (29 s); lock held 81 ms | 572 / 1,304; 560 / 1,356 (566); 602 / 1,248 (555) |
| | load again | – | – | – | 1,041 / 2,471 |

What it says:

- **Case 6 under load is met.** The longest single hold is 70 to 84 ms against 104 ms at phase 0. The comparable ratio is run A, the same fixture without a room waiting. There, commands sent during a run answered at 1.5 times the median of the others and 1.9 times their p95. At phase 0 the ratios were 2.8 and 2.4. A run holds no lock there; what is left is the cost of its reads through the space. In run C the ratio is about 1: runs took 1.7 s (median) under load, so half the commands fall during one and the split no longer tells them apart.
- **A busy region's room still grows, but late.** Without load a room with a step grows in the first run. Under the load of 50 figures, `WORLD_LOCK` refused 8 of 11 runs (`NO_WAIT`, a command open), and a room took up to 4 runs. The servers run growth 150 s apart (6.1 above, "How often a run comes"), so 4 runs there are 600 s.
- **The open question is not fixed in phase 1.** Making growth get through under steady load would change how growth takes `WORLD_LOCK`: waiting for it, a bounded retry, or a turn before new commands. Every one of these changes every command's wait. That is a decision for plan section 3, not part of the switch at the same behaviour.
- **The windows still drift.** As before, `load again` is the slowest of all windows in every run, without growth. Only the split inside a window compares.

**A bounded wait for `WORLD_LOCK` (2026-11-27, the owner's choice of the three above: a bounded retry).** The take of `WORLD_LOCK` in a growth run waited up to 2 s (`GROWTH_LOCK_WAIT_MS`) instead of `NO_WAIT`. Measured as run C (five rooms with a step, the Rust stack, `GROWTH_GROWING=5`). `timedLock` (`tests/growth-worst.ts`) now starts a hold when the lock is held, not when the take begins; with `NO_WAIT` that is the same, so the rows above stand.

| Run | Window | Growth runs | Longest single hold | Rooms with a step | Answers p50 / p95: all, during a run, outside one |
| --- | --- | --- | --- | --- | --- |
| D: five, wait 2 s | idle | 28, median 117 ms | 46 ms | 5 of 5 in their first run, 159 ms (median) | – |
| | load | – | – | – | 111 / 500 |
| | load+growth | 8, median 6.4 s; `WORLD_LOCK` refused in 5 | 92 ms | 3 grew in their first run, 2.2 s (median), at most 4.7 s; the fourth still waiting after 5 runs (42.5 s); lock held 79 ms | 617 / 1,523; 533 / 1,213 (695); 815 / 1,711 (488) |
| | load again | – | – | – | 1,232 / 2,444 |

- **The wait does not get growth through.** With 50 figures the commands that read `WORLD_LOCK` overlap without a gap of 2 s: 5 of 8 runs were still refused, against 8 of 11 with `NO_WAIT`. One room waited 5 runs, as long as before. A first run without the measurement fix gave the same: 5 of 7 refused, a room waiting 5 runs (43.6 s).
- **It only makes a run longer.** Each refused run waits the full 2 s, so a run took 6.4 s (median) against 1.7 s. A hold, once taken, is as short as before (79 to 92 ms), and the commands answer no worse than in run C; the windows drift as before.
- A longer wait would not change this: a take that waits gets the lock only in a moment when no command holds it, and under this load there is none. What would get growth through is a turn before new commands (they wait for a growth run that is waiting). That changes every command, so the wait alone was not kept (the 10 s answers at p99 in both load windows are timeouts of the figures, with and without growth).

**A turn before new commands (2026-11-27, the owner's decision after run D).** Before a growth run takes `WORLD_LOCK` for a room with a step, it writes a `GrowthTurn` outside a transaction (lease 5 s, `GROWTH_TURN_MS`) and takes it away when the room is done. The world workers' intent loops (`server/world-host.ts`, `world_host.rs`) start no command while a turn is visible. They read it from their copy of the world, so the check costs no call to the space. The commands already open run out, and the take, waiting up to 2 s as in run D, gets the lock. A turn whose run died lapses with its lease, and both copies drop a lapsed entry. Registrations, ferries and the other `pinTerrain` users are not held back: they are rare and wait for the lock themselves. Measured as runs C and D.

| Run | Window | Growth runs | Longest single hold | Rooms with a step | Answers p50 / p95: all, during a run, outside one |
| --- | --- | --- | --- | --- | --- |
| E: five, turn | idle | 28, median 105 ms | 36 ms | 5 of 5 in their first run, 148 ms (median) | – |
| | load | – | – | – | 71 / 428 |
| | load+growth | 10, median 4.6 s; `WORLD_LOCK` refused in none | 69 ms | 5 of 5 in their first run, 1.9 s (median), at most 5.0 s; none waiting; lock held 63 ms | 547 / 1,268; 558 / 1,314 (633); 536 / 1,259 (593) |
| | load again | – | – | – | 965 / 1,893 |

- **Growth gets through under load.** No run was refused the lock, and every room with a step grew in its first run, against up to 4 or 5 runs in C and D. At the servers' 150 s between runs a room now grows in the run that finds it, not 600 s later.
- **The commands pay no more than before.** Those sent during a run answer like the others (558 against 536 ms at p50), and the window with growth answers as in run C. A hold is as short as before (63 to 69 ms).
- **A run takes longer under load** (4.6 s median against 1.7 s in C): with a room to grow it waits until the open commands have run out. It holds no lock while it waits; only new commands wait, at most until the run's room is done.

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

The decision of 2026-11-25 (plan section 3, "Locks"): step 6 does not read the objects' own entries. Each object gets one `Footprint` entry {room, of, x, y, w, h}, written and taken only by a holder of the room's lock, so it stays visible while the object itself is taken. The footprint query reads the Footprint entries in place of the Plot entries.

### 7.4 The room and island locks (step 5)

One `RoomLock` {room} per room and one `IslandLock` {island} per island (`server/engine/room-lock.ts`, `rust/mmo-engine/src/room_lock.rs`). The loader writes them with the rooms, `dig` with a dug room and `makeInterior` with an inside. On every start the loader also gives each Room entry of the store that has no lock its lock, so dug rooms and insides from before step 5 get one. It takes the Room first, so a room being dropped is left alone. `dropInterior` takes the inside's lock away first; if the lock is still held after `LOCK_WAIT_MS`, the drop is aborted and left to the next sweep. Otherwise a holder committing later would write the lock back for a room that is gone. A holder takes the lock in its transaction and writes it back there, so the lock is held until the commit and comes back by the space's rules on an abort or an expired lease. Order: WORLD_LOCK, the island lock, then the room locks by ID (since step 8 a fire's LightUse entry after them, section 7.6).

| Who | Lock | When it is held |
| --- | --- | --- |
| `bau`, `abriss`, digging a bed (`umgraben`), staking a field (`stake`), giving up a bed or a field, planting a tree (`plantTree`), felling one (`treeHere`), clearing scenery (its last take), `versetze` | room, refused (`LOCK_HELD`; since step 8 after a wait of up to `COMMAND_LOCK_WAIT_MS`, 100 ms, section 7.6) | before the decisive overlap check, which then reads the plots (since step 6 the Footprint entries) inside the transaction (`refusal(..., locked)`, `blockedIn(..., txn)`) |
| a jetty to the water, the sweep (a site lapses, a building on an old road, a ruin ends), the vote's demolition, a bed's or a field's tick when it lapses | room, waits `LOCK_WAIT_MS` | before the take; still held, the change waits for the next run |
| a road's vote and plan | island and the rooms it crosses, refused | before the Route take, or after the trace (the cells are checked again inside the transaction) |
| the road tick | island and its rooms, waits | before the take |
| growth | island, `NO_WAIT` after WORLD_LOCK, then the grown room's lock, `NO_WAIT` (since step 6) | held: this round leaves the island, or that room, alone |

Settlers (`server/npc/settlers.ts`) set `later(plan, …)` before each `bau`, `umgraben` and `straße plane` and do not read the answer, so a `LOCK_HELD` refusal is tried again after that many rounds. It is a `CommandError`, not a line the model is asked to understand.

Beacons, people and items are still read from the process's copy: a transaction read of them would hold up steps and fires. Every test stack checks one lock per room and per island when it closes (`lockReport`), the engine walks on every state; `tests/room-lock.test.ts` holds a room's lock from the test and sees `bau`, `umgraben` and `abriss` refused, a step go through, and `bau` go through once the lock is free. With the refusal removed it fails, against the TypeScript world and against the Rust one (`SPACES_MMO_WORLD_CMD=rust/target/release/mmo-world`). A second test loads the world into a store with lockless rooms (an inside, a world room whose lock is gone) and finds one lock per room.

A gap was left here: a delivery rewrites a road's parts, so a road is not visible to others during that transaction. It is the same visibility gap the objects had. Step 6 left roads as they were. Step 10 closes it with an entry of its own for a road's cells (7.8). The inventory of step 5 also named a builder's `destroy` of a Building as leaving its plots behind: `destroy` never takes a Building (it refuses buildings, sites and ruins), so that gap was not there.

### 7.5 One Footprint entry per object (step 6)

Every place of 7.1 writes and takes one `Footprint` entry {room, of, x, y, w, h} (`shared/model.ts` `FootprintFields`; grid class "area") instead of one Plot per cell, in the transaction that holds the room's lock (7.4): `writeFootprint`, `takeFootprint`, `footprintsIn` and `claimedIn` in `server/engine/occupancy.ts` (`occupancy.rs` the same). `freeCells` (`build.ts`) takes it; `versetze` and `jettyToWater` take the old one and write the new one in the same transaction without `unique`, because a taken entry keeps its `unique` key until the commit. Every reader of 7.1 reads `claimedIn` (cell → object) in place of the plots: `blockedIn`, `refusal`, `takeNear` (an object whose footprint is there and which cannot be read is held), `moveTo`, the loader's scenery (under each room's lock now), `fire.ts`, `wild.ts`, growth (the share and the shift of the footprints with the room), the settlers and the economy. The stack check and the walk check compare the objects with their Footprint entries (`storeOccupancyReport`, the default `against: "footprints"`) and report a second Footprint entry for an object. A Plot written by a test or a walk fails it. The fixtures that placed bare plots as an obstacle place a footprint (`placeFootprint` in `tests/stack.ts`).

The store's format (`shared/grid-format.ts`): `SUPPORTED_FORMAT` is {gridScale 1, occupancy "footprints"}. An empty store gets its `GridFormat` entry in the loader's first transaction. A store with a `WorldLoaded` entry but no `GridFormat` entry is legacy and refused at start, as is a store that holds Plot entries; both refusals name the migration.

The migration, `npm --prefix spaces-mmo run migrate:footprints -- --space <address> [--check] [--drop-orphans] [--follow-objects]` (`scripts/migrate-footprints.ts`), runs with the world stopped, on each region's space, from a backup:

1. `--check` writes nothing. It lists the cells where the plots and the objects differ, plots of no object, and rooms and islands without their lock.
2. Without `--check`, a store whose plots differ from its objects is refused before anything is written. `--follow-objects` takes the objects' rectangles instead. Objects that overlap each other or reach outside their room are refused either way. `--drop-orphans` takes plots of no object.
3. Then: the `GridFormat` entry with state "running"; the missing locks; one transaction per object (the room's lock, its Footprint entry written, its plots taken); the result checked (no plot left, every object's footprint, one lock per room and island); the entry "complete".
4. A run that was cut off goes on where it stopped. A migrated store is left as it is, except that a road without its RoadCells entries gets them (since step 10, 7.8), also in a store whose footprints were migrated before. `tests/migrate-footprints.test.ts` covers this.

The copies of the local test bed's region stores (2026-11-24) were run on copies in the scratchpad:
- nord, ost and sued lacked only the locks. They migrated in 3 to 12 s each (101, 136 and 40 objects; 21, 28 and 8 locks), and the start check then let them start.
- west is refused. The `test:play` huts and two test railway stations were written by hand without plots. One station, at graue-bucht 13,6, also overlaps the boat scenery and a bed; that overlap is left to the store's owner. On 2026-11-25 the owner had the two stations removed from the test bed's west store (with the two estates of a test account that does not exist and the 32 items in them; a backup was kept); a `--check` now lists only the `test:play` huts, which `--follow-objects` takes as they stand.

Again on 2026-11-26, after step 10 and with the master of then (new-world merged into it), on fresh copies of the same four stores taken from the stopped test bed. The test bed itself was not touched.
- `--check` listed the missing locks and, now, every road's rooms without RoadCells: 16, 28, 8 and 12 entries. Since that day the check also counts both in its summary line, as the migration does; before, it printed 0 for them.
- `--follow-objects` migrated each store:

  | Store | Objects | Locks written | RoadCells written | Time |
  | --- | --- | --- | --- | --- |
  | nord | 101 | 21 | 16 | 3.4 s |
  | ost | 136 | 28 | 28 | 4.5 s |
  | sued | 40 | 8 | 8 | 2.1 s |
  | west | 180 | 35 | 12 | 6.6 s |

  In west, `--follow-objects` took the `test:play` huts as they stand, as above.
- A second run answered "already" and wrote nothing, and a `--check` after it listed nothing.
- The start check (`checkGridFormat`, server/engine/grid-format.ts) passed on all four.

Whether the stores on big and nano hold such objects is shown by a `--check` on a copy of each. Master is not deployed there before the cut, and a local store with data from before step 6, or with roads but no RoadCells, is refused until it is migrated.

**big and nano, 2026-11-27 (the owner's word).** Copies taken at 12:35 UTC from the running servers, each database with its WAL and no checkpoint between (the copy loop of 2026-11-16; nothing on the servers was stopped or changed): big's four region stores and nano's accounts store, kept on this machine in `~/phi-backup/2026-11-27-grid-check/`. Every run below was on a further working copy in the scratchpad, behind the Rust `mmo-space` of master.
- `--check`: in all four region stores the plots and the objects agree on every cell, no plot belongs to no object, and no object overlaps another or reaches outside its room. Missing are only the locks of every room and island and the RoadCells of every road, which the migration writes. The accounts store holds no world ("nothing to migrate").
- The migration without `--follow-objects` or `--drop-orphans`:

  | Store | Objects | Locks written | RoadCells written | Time |
  | --- | --- | --- | --- | --- |
  | west | 238 | 32 | 18 | 5.8 s |
  | nord | 101 | 18 | 16 | 3.0 s |
  | ost | 156 | 29 | 24 | 3.8 s |
  | sued | 44 | 8 | 8 | 1.2 s |

- A second run answered "already", a `--check` after it listed nothing, and the start check (`checkGridFormat`) passed on all four; on an unmigrated copy it refused and named the migration.

So the cut needs no hand work on these stores: the plain migration takes them as they stand (as of this copy; it is run again on the day of the cut).

### 7.6 Contention at the room lock (step 8)

`tests/contention.test.ts` runs two world workers with one lane each (`SPACES_MMO_WORLD_LANES=1`), so two characters' commands sent at once run in two processes; with `SPACES_MMO_WORLD_CMD` one or both are the Rust worker (`SPACES_MMO_WORLD_MIXED=1`: one of each).
- *Two attempts on the same cells.* The admin moves its hut onto a rectangle (`versetze`, which takes no fire's light) while a player stakes out a hut on it, and two players stake out a hut there, each for `CONTENTION_ROUNDS` rounds (default 12). The move is sent a little later each round, across the time `bau` takes before its lock. Each round leaves exactly one object on the cells, and the objects, their Footprint entries and the locks agree. With `holdRoomOrRefuse` made a no-op, round 0 leaves two objects there, in both cases.
- *A world worker killed in such a round.* The intent it held comes back with its transaction's lease (`SPACES_MMO_TXN_MS` 4 s in the test) and the other worker runs it; one object, every lock back.
- *A holder killed while it holds the lock* (`tests/lock-holder.ts`, killed with SIGKILL). Until its lease runs out, `bau` is refused and leaves no footprint and no light used. Then the lock is back with the version it had (the killed transaction's write-back is gone), and the same `bau` goes through and counts the version up.
- *Building against growth.* A command reads `WORLD_LOCK` in its transaction (`pinTerrain`, or the read in the world worker's first batch), and a read under a transaction keeps any other transaction from taking that entry. Growth takes `WORLD_LOCK` with `NO_WAIT`, so it cannot commit while a command runs, and a command does not start while growth holds it. A command never sees the room's grid change under it. `tests/growth-gate.test.ts` holds a command's transaction open in its search (`pinTerrain`, no room lock yet): growth grows nothing, then the command takes the room's lock and rewrites a footprint, commits, and the room grows with that footprint there once. With `pinTerrain` made a no-op the room grows during the search and the test fails. It runs in a space process of the stack, so with `SPACES_MMO_SPACE_SERVER=rust/target/release/mmo-space` against the Rust core as well. Left open: growth gives up its run (`NO_WAIT` on WORLD_LOCK) while any command of the region is open, and commands now run up to 100 ms longer when they wait for a lock. Measured on 2026-11-26 (6.1, "Under load after growth steps 2 and 3"): under 50 figures a room with a step grows after up to 4 runs, `WORLD_LOCK` refused in 8 of 11. The longest hold (84 ms) and the ratio of the answers (1.5 / 1.9) are within the phase 0 reference.
- *Abort and retry* is `tests/room-lock.test.ts` (refused while held, through once free), with the killed holder above.

The test found two defects at the fire's light use (`LightUse`, `build.ts` `lightFor`), both in TypeScript and Rust.
- A command took the fire's LightUse entry before its search, and `count` was meant to tell a held entry from none. A count does not see a held entry, so a second builder took the path of a fire's first use. It searched, took the room's lock, and failed only at the unique write, while the first builder, holding the light, had been refused at that lock: both were refused. The take now uses `takeExisting`, which tells a held entry from a missing one.
- The order was an inversion. `bau`, `umgraben`, `stake` and `plantTree` took the light before the room lock, while `abriss`, giving a bed, a field or a tree back and every job take the room lock and then the light (`releaseLight`). Since step 8 `lightFor` only reads (the same fire and the same refusal as before, so the walks do not change), and `useLight` takes the light after the room lock, waiting up to `COMMAND_LOCK_WAIT_MS`, and refuses if it no longer suffices. Order everywhere: WORLD_LOCK, island lock, room locks, then LightUse.

*Refusal rate* (plan section 3, at most 1 %): `tests/perf/lock-refusals.ts` runs two world workers, the npc process with the bay's three settlers (no model calls, each given the material of its three buildings), and two players beside each other in the bay, who stake out a hut and give it up again with a random pause of up to 1.5 s between their commands, for 180 s. That is one building command per player about every 0.85 s, far denser than play. The settlers add 4 to 11 building commands a run at their 8 s rounds.

| Variant | Runs | Building commands per run | Refused for the lock |
| --- | --- | --- | --- |
| refused at once, light before the lock | 2 (TypeScript) | 431 to 439 | 2.05 %, 1.86 % (the second: 4 `bau`, 4 `abriss`) |
| 100 ms wait, light before the lock | 4 (TS twice, Rust, mixed) | 414 to 445 | 0.67 %, 2.17 %, 0.70 %, 0.95 %, every refusal a `bau` (the inversion) |
| refused at once, light after the lock | 1 (TypeScript) | 436 | 3.44 % (two builders now meet at the room lock) |
| 100 ms wait, light after the lock (step 8) | 3 each of TS, Rust, mixed | 418 to 445 | 0 % in all nine; no refusal for the light either |

On the Rust space server (`SPACES_MMO_SPACE_SERVER=rust/target/release/mmo-space`, as on big and nano) both cores report a held LightUse entry to `takeExisting` (StillHeld); `tests/contention.test.ts` passes with the TypeScript and the mixed world workers, and one measurement with the Rust world workers gave 0 of 470 building commands refused.

A command now waits up to `COMMAND_LOCK_WAIT_MS` (100 ms, below a tick of 150 ms) for a room's or an island's lock before it refuses with `LOCK_HELD`. A job still waits `LOCK_WAIT_MS`.

### 7.7 The searches on the shared grid (step 9)

The plan's shared grid (section 3, "Performance strategy") was there for growth since growth step 1 (`components` in `shared/grid.ts`, `grid.rs`). Since step 9 the searches over a room use it too, in TypeScript and Rust:

| Search | Before | On the grid |
| --- | --- | --- |
| `findPath` (`world.ts`, `world.rs`): `move`, the step check, the arena's trail | a map of indices, every cell read through `walkable`, blocked cells as "x,y" strings | `pathIn` / `Grid::path` on `walkGrid(...)` with the blocked cells closed (`closing`) |
| the reach of a building check (`build.ts`, `build.rs` `refusal`) | a set of "x,y" strings | `reachIn` / `Grid::reach` |
| the road's trace (`road.ts`, `road.rs` `trace`) | distances and predecessors in maps of strings | the same open list over indices |
| `freeCellNear` (`occupancy.ts`, `occupancy.rs`) | a set of "x,y" strings for the cells reached | `nearestOpen` / `grid::nearest_open`: the cells reached by their index, each checked as it comes |
| `nextStep` on the page (`client/walk.ts`) | a set of "x,y" strings | cells keyed by a number; the page's free cells (`App.tsx` `freeCells`) are one grid per call |

- **Same answers.** The neighbour order (right, left, down, up), the levels of `findPath`'s `max`, the stable order of the trace's open list and `nextStep`'s limit of 1024 cells looked at stay as they were. `tests/grid-search.test.ts` holds every TypeScript search to the one it replaced (`tests/legacy-search.ts`) over random rooms of the world's tiles: blocked cells inside and outside the room, cut-offs at `max` and `radius`, blocked and unreachable targets, a start on its target. The test in `grid.rs` does the same for Rust. With the neighbour order changed, both fail. The engine walks pass all 28 against the oracle c391cfe, unchanged.
- **The occupied sets stay keyed by strings at the callers.** `blockedIn`, `claimedIn` and the callers' own sets are built once per command from the entries, and a search turns them into its mask once (`closing`: one pass over the keys). Making them grids where they are built would touch every reader of 7.1 again for little at scale 1. Only the page's free cells are now one grid.
- **`freeCellNear` does not build the room's grid.** It ends after a few rings as a rule, so a grid of the whole room cost more than its search (TypeScript at scale 2: 4 µs before, 120 µs with the whole grid). It looks only at the cells it reaches.
- **The phase 0 references are unchanged.** `tests/perf/target-choice.ts` counts 966, 828 and 132,970 cells for the legacy choice and 312 for the one search, as in 6.2. `tests/perf/growth-cases.ts` gives the 37 rooms and 179 steps of `growth-scale1.json`, and `tests/semantic-examples.test.ts` passes. The movers' commits (6.3) do not depend on how a path is searched.

*Cost* (`tests/perf/search-cost.ts`; Rust: `cargo test --release --lib search_cost -- --ignored --nocapture`). Two rooms of the world's tiles: one of the largest size at scale 1 (36 × 24) and one of the maximal size at scale 2 (72 × 48). In each, a sixth of the cells is blocked and a wall of water runs across with one gap; the way runs corner to corner. Medians of 200 runs in µs, before → after, on this machine:

| Search | TS 36 × 24 | TS 72 × 48 | Rust 36 × 24 | Rust 72 × 48 |
| --- | --- | --- | --- | --- |
| `findPath`, max 40 (`COMMAND_PATH`) | 93 → 43 | 207 → 146 | 247 → 41 | 479 → 150 |
| `findPath`, room-wide | 169 → 55 | 794 → 230 | 406 → 45 | 1,937 → 177 |
| reach of a building check | 281 → 114 | 1,247 → 490 | 758 → 49 | 3,251 → 154 |
| road trace | 717 → 320 | 3,868 → 1,985 | 1,320 → 180 | 6,466 → 1,219 |
| `freeCellNear`, radius 8 | 12 to 13 → 13 to 19 | 3 → 8 | – | – |

The TypeScript values are one of two quiet runs, which differ by up to a fifth; `freeCellNear` shows the spread of both. Its few µs more at scale 2 are the same cells looked at (the free cell is next to the start there), below what one tick notices. The Rust searches were slower than the TypeScript ones before (strings and `walkable` on UTF-16 slices, 1.4 above) and are faster now. The trace keeps sorting its open list at every step, as the TypeScript one does, so it stays the most expensive search; it runs once per road plan.

### 7.8 A road's cells (step 10)

**The gap.** A builder reads a road's cells as an obstacle: `refusal` in `build.ts` answers "Dort führt eine Straße entlang" for a cell of one, via `roadCellsIn`. Until step 10 `roadCellsIn` read the road's `Road` parts. Every delivery, vote and mend rewrites those parts (`roadSave`) without the island's lock, and a transaction holding them taken hides them from everyone else. So for that moment a builder could stake out a site across the road. `tests/road-cells.test.ts` showed it before the change: with a test transaction holding the road's Route and Road parts as a delivery does, `bau hütte` on a road cell staked out the hut.

**The entry.** One `RoadCells` entry {routeId, room, cells} per road and room (`shared/model.ts` `RoadCellsFields`; grid class "path"). `roadCellsIn` reads it instead of the parts, in `road.ts` and `road.rs`.
- A road's cells are set once, when it is planned, so its RoadCells entries are written only then, `unique` on road and room (`roadSave` with `fresh`). They are taken only when the road goes (`roadGone`: a vote lost, a road lapsed or not built in time).
- Each of those callers holds the island's lock and both rooms' locks (`straße plane`, the vote, `roadTick`). A builder holds the room's lock, so it never meets a RoadCells entry that another transaction holds.
- A delivery, a vote that keeps the road and a mend rewrite the Route and its parts, never the RoadCells entries.

The page still draws the Road parts. Growth does not move a road's cells yet (plan section 3, "Growth", the road rule). When it does, it has to shift the Route's cells, the Road parts and the RoadCells entries together.

**The check.** `roadReport` (`road.ts`, `road.rs` `road_report`) wants per road and room one RoadCells entry with the Route's cells of that room, and the Road part's cells the same where there is one. It reports RoadCells of no road. Every test stack runs it when it closes, and the engine walks run it on every state. Fixtures that write a Route by hand write its RoadCells with it (`roadCellsEntries`), in the tests, the walks and `tests/play/epochs.ts`.

**A store of before.** A store holding Route entries but no RoadCells entry is refused at start, naming the migration (`gridRefusal`, `grid_refusal`). Plan section 5 says a binary of the target state converts nothing at start. `npm run migrate:footprints` writes the missing entries per road, holding its island's and rooms' locks. It does so in a legacy store as part of the migration, and in a store whose footprints were migrated before step 10. `--check` lists the missing entries. No store on big or nano is in the footprint format yet, so this concerns only local stores that were migrated earlier.

`tests/road-cells.test.ts`:
1. With the road visible, `bau` on a road cell is refused.
2. With a delivery's transaction holding the road's Route and Road parts, the same `bau` is refused too, and nothing is staked.

`tests/migrate-footprints.test.ts` covers a store migrated before step 10: refused at start, then migrated with two RoadCells entries, then it starts.

*Seen meanwhile, and explained (2026-11-26):* the railway tests of `tests/cart.test.ts` (freight by rail, the island railway) failed now and then under load. `zug` answered "Der Zug hält nur an Bahnhöfen" though the test had written the station beside the figure. The commit before step 9 failed as often, so it was older than steps 9 and 10.

It was the tests, not the engine. A new figure holds no cell until it comes online. The gateway then sends its `arrive`, and the world worker runs it a moment later; if someone stands on the figure's cell (an NPC passing, a second newcomer), `arrive` moves it aside. The tests read the figure's place right after `play()`, sometimes before that move, and wrote the station beside a cell the figure was about to leave. In one run the figure was read at 13,10, the station went to 14,10, and the figure stood at 12,10 when `zug` ran. `tests/festival.test.ts` failed the same way ("Dieses Fest eröffnet man direkt neben einem Park"): two newcomers in one bay may pick the same cell.

`arrived` in `tests/stack.ts` waits for the Spot that `arrive` claims and for the figure on it. Every test that reads a newcomer's place to put things beside it now uses it (cart, festival, growth, harbour, planks, quarry, rule-gaps, scenery, townhall). A read after a walk keeps the plain read: on a door cell a figure holds no Spot.

`tests/planks.test.ts` failed for a reason of its own. It put a workshop, two huts and the cell to walk to beside wherever the newcomer started, and from some cells around the spawn that cell fell on the bay's fire. It now walks the figure to 18,12 first. With these changes, six parallel runs of the railway tests and four of planks all pass.

## 8. The grid migration (phase 2 step 7)

`npm --prefix spaces-mmo run migrate:grid -- --space <address> [--check]` (`scripts/migrate-grid.ts`) takes a world or region store from gridScale 1 to 2 (plan section 5). It runs with the world stopped, on each region's space, on a copy of the backup, after the footprint migration (7.5).

**Rules.** Each entry changes by the grid class of its fields (`GRID_CLASSES`, section 3). The script refuses to load if a class row has a `path`, `growth` or `text` field without a rule of its own.
- An area: position and size × 2. A fire and an exit, cells at scale 1, become areas of 2 × 2; a tree becomes 2 × 2.
- A cell point: × 2, once. A thing keeps the carried sentinel (-1, -1). A thing at a place that is no room of the store is refused with its ID.
- A room: ground and decor are resampled with `scaleGround`/`scaleDecor`, as `world:json` does for the definition. Its growth history doubles: east, south, the base, each step's `at` and `size`, and each element of a step's `fill` twice, in order.
- A room of the definition is also reconstructed: the scale-2 definition grown by the scaled history must equal the resampled terrain. Where the stored terrain already differs from the definition at scale 1, the script tells it and keeps it.
- A road: each cell doubles, and the cell between two neighbours of one room is inserted. At a fire end the script adds one more cell, so the road still meets the fire's area. A road that began on the fire's west or north side would otherwise end one cell short of it after doubling.
- A road's Road and RoadCells entries are written anew from its Route. Votes, deliveries, work and deadlines stay.
- `paved` follows the work done, `floor(cells · work / workNeed)`, as the engine computes it at every write. So it is not the prefix through the last old paved point; it can differ from that by up to two cells (one cell of scale 1). *Decision:* the engine's rule, since the next delivery or work would write it so anyway.
- A field's needs (sowing: seed and work; harvest: work) are computed anew from the scale-2 definition and must equal the stored ones.
- NpcMemory is cleared. Msg and Notice keep their texts.

**Refusals.** Nothing is written when the store has:
- no footprints, or a footprint migration that has not finished;
- Plot, Handover or unexecuted Intent entries;
- an entry type without a grid class;
- anything the check of the result finds.

**Order.**
1. The whole result is computed in memory and checked at scale 2: the occupancy, the locks and the roads as the engine checks them, plus the grid's own rules:
   - trees, fires and exits 2 × 2;
   - points inside their rooms, an exit's arrival inside its destination;
   - a bed's plants inside it, one per cell, at most `bedCapacity`;
   - a road's neighbours.
2. Then the `GridFormat` entry is written with gridScale 2, derivedFrom 1, state "running".
3. The entries are written in batches of at most 100 entries or 64 kB of new fields. A room goes on its own and a road with its parts. Each transaction holds `WORLD_LOCK`, taken without waiting, so a running world stops the migration.
4. The store is read back and compared with the result, entry by entry.
5. The `GridFormat` entry becomes "complete".

A run cut off is not resumed, because a coordinate doubled twice has no repair. The store says "running" and is refused, by the script and by every binary, until it is restored from its backup. A migrated store is only checked ("already"). Trees are planted at `gridScale` × `gridScale` (`trees.ts`, `trees.rs`; `TreeFields.w`/`h` are numbers since), and `baum ansehen x y` and `fälle x y` take any cell of a tree. `tests/migrate-grid.test.ts` covers these rules and refusals on a loaded world. Its fixture adds a room grown by two steps, a bent half-built road from the west of a fire, a bed with plants, a field being sown and a ripe one, a tree, a passenger on board, a motion's zone and an NPC's memory.

**Rehearsal on big's stores, 2026-11-27.** The copies of 7.5 (`~/phi-backup/2026-11-27-grid-check/big`) were used again, each on a further working copy in the scratchpad behind the Rust `mmo-space`. On each, `migrate:footprints`, then `migrate:grid --check`, then `migrate:grid`, then a second run:

| Store | Entries changed | Taken | Transactions | Time |
| --- | --- | --- | --- | --- |
| sued | 172 | 16 | 13 | 1.3 s |
| nord | 374 | 33 | 28 | 3.3 s |
| ost | 604 | 49 | 44 | 3.5 s |
| west | 741 | 38 | 46 | 5.3 s |

- The check found nothing to refuse and no note: every room of the definition matched its reconstruction. No store held a Handover or an Intent entry at the time of the copy.
- The second run answered "already", and the start check at scale 2 (`checkGridFormat`) passed on all four.
- On west, the TS loader of the scale-2 region world ran twice and left every room as migrated.
- The Rust `mmo-world` at scale 2 started on west, with the four migrated regions behind it, and ran 40 s without an error. The check of the store afterwards found nothing.

### The codemode-chat Space

`npm --prefix codemode-chat run migrate:grid -- --space <address> [--check]` (`codemode-chat/server/migrate-grid.ts`) takes the Space's cells (section 4) from scale 1 to 2:

- Every cell point of `BotEpisode` (`path`, `jumps`, `subgoalAt`), `PlanMemory` (`path`, the observations' cells) and `Subgoals` (`near`) is doubled. A path is the arena's turn points (`arena.ts` `pathOf`) and `recall` costs a step by its Manhattan length, so the doubled turn points are the same way at scale 2. Their cost doubles as `NEAR` and `JUMP_CELLS` do, and nothing is inserted, unlike a Route. `fromFire` and the minutes stay.
- A `PlanMemory`'s id is computed anew from its doubled content, and every `MemoryFreeze` names the new ids of its block, in its order. A judge at scale 2 that walks a remembered way finds it a duplicate. A day of the chance tide keeps its id (it names no cell).
- `BotRoom` is taken; the next verdicts store the rooms anew from the arena.
- The script refuses before a write when a `BotRun` or `BotCall` entry is there, or a `Process` entry other than the Space's own, or a `GridFormat` entry at gridScale 2 "running".
- The order is the world stores' order: computed in memory, `GridFormat` { gridScale 2, derivedFrom 1 } "running", batches each entry taken without waiting, read back and compared, "complete". A Space without the entry is at scale 1.
- The entries written anew get a fresh lease of `CODEMODE_TTL_HOURS`, since the Space does not tell an entry's remaining one; `ts`, which orders the memory and its eviction, stays.
- Text is not migrated: the models' plans and critiques, chat messages and a verdict's case lines. Neither is the bots' code.

`codemode-chat/tests/migrate-grid.test.ts` writes a landing and a day of the chance tide as a judge logs them at scale 1, migrates, and compares with what a judge at scale 2 logs of the same island and seed (computed in a process at `CODEMODE_GRID_SCALE=2`): the observations, their ids, the freeze's order, `remember` adding nothing. It runs against the TypeScript and the Rust space. Observations of six toy islands, four seeds each, and the Graue Insel were compared the same way: at scale 2 each is the one of scale 1 with its cells doubled. The local test bed's store (October, 160 MB, no planning entries yet) migrated with nothing to change.

**Rehearsal on nano's store, 2026-11-28.** A read-only copy of nano's codemode-chat Space (1.7 GB with its WAL, no checkpoint between them; `~/phi-backup/2026-11-28-grid-codemode/`, the same on nano) was migrated on a working copy behind the Rust `codemode-space`. It holds no `BotEpisode`, `PlanMemory`, `MemoryFreeze` or `Subgoals` entry, and none of its 102 `CodeScore` entries has episodes: no planning task has been judged in production yet. Only its 22 `BotRoom` entries were taken. The check, the migration and the second run ("already") took under a second each, and no `BotRun`, `BotCall` or foreign `Process` entry was there. The cut on nano is therefore a marker and the rooms' geometry; the conversion of paths and memory is held by the test alone.

Open: a start check of codemode-chat's processes, so that a judge at `CODEMODE_GRID_SCALE` 2 refuses a Space without the "complete" entry at that scale (and one at 1 a migrated Space). Today the Space's scale and the processes' scale agree only by the operator's order of steps.
