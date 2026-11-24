# Grid switch, phase 0: inventories

**Date:** 2026-11-24 · **Branch:** `new-world` · **Plan:** [3D world and grid plan](3d-welt-und-raster-plan-2026-11-21.en.md), phase 0

Phase 0 inventories what the grid switch touches before any format changes. This document holds the inventories in the order of the plan:

1. [Rule values in cells](#regeln) (plan section 2.4)
2. [Reactions to entering a cell](#betreten) (plan section 3, "Execution")
3. [Coordinate fields and their class](#klassen) (plan section 2.2)
4. [Cells that codemode-chat keeps](#codemode) (plan section 2.2, "Arena and codemode-chat")
5. [Decisions for phase 1](#offen), collected from the four
6. [References of acceptance case 6 at scale 1](#referenzen) (plan section 6, case 6)

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

The table of plan section 2.4 gets the values of 1.1–1.3 and 1.5 by name. The 30 "beside" literals and the eight reach literals go through two named entries (`BESIDE`, `REACH_POINT`), so the switch changes two numbers instead of 38.

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

## 6. References of acceptance case 6 at scale 1

### 6.1 World lock per growth run

**Fixture.** `tests/growth-worst.ts` writes the worst case of room growth, and `tests/growth.test.ts` holds it to that. The case has every room of the largest region, which is `ost` with 13 rooms. Each room is all grass at (maxW − strip) × (maxH − strip) = 32 × 20 cells, the largest size that still has seams to try; at 36 × 24 there is no candidate at all. Its plots look like this:

- 505 of 640 cells are plots, so 79 % is taken and the room is full enough to grow (70 %).
- Only the upper-left part below half the width and height is free: 135 cells, with the spawn in the corner.
- Every seam lies at or beyond half the room, so the cells on both sides of it are plots.
- No rectangle crosses a seam. So all 28 candidates (17 east, 11 south) reach `connected`. Each runs both of its searches and is rejected.

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

For TypeScript the script also times the lock itself, from its take to the commit or abort of that transaction. The lock time is the run time less the first read of the rooms (Rust space: 335 of 338 ms).

**What this says for phase 1:**

- **Reference.** The production pair holds the lock about half a second per worst-case epoch run, in 13 holds. The 513 ms are measured. The hold per room (about 40 ms) is derived: the run divided by the rooms. The longest single hold is measured for the TypeScript engine only. This is the value the target of case 6 ("at most the reference") is measured against.
- **A relative reference.** The fixture's space holds only the worst-case rooms. A live region also has its exits, characters and items, which a room's reads under the lock take in as well (all `Exit` entries, unfiltered, per room). So the absolute values are lower than on big. They hold only against the same fixture at scale 2, measured the same way. They are not a statement about the live servers.
- **Reads under the lock.** The Rust engine reads its 19 entry groups of a room one after another inside the transaction (`commands/growth.rs`). The TypeScript engine sends them together (`Promise.all`). The reads are close to half of the Rust run. Sending them together, or reading the candidates from the mirror outside the lock (plan section 3, growth step 3), removes most of that part.
- **Search.** The Rust search is slower than the TypeScript one. It keys cells by strings and reads every cell through `walkable` on UTF-16 slices. The shared `Grid` (plan section 3, "Performance strategy") replaces both. At scale 2 the search does 8 times the work, about 2.4 s per run with today's code, so it cannot stay as it is.
- **Not yet measured.** This run has no load. Case 6 measures the same run "while players build". That needs `tests/perf/live-load.ts` beside it, and its reference is recorded together with the commits per second of the movers (6.2).

