# Implementation plan

Every phase ends with a playable state and automated tests (`node:test`; the tests start the processes like
`test:codemode-chat`). After every change: typecheck and tests of spaces-mmo, plus root `npm run typecheck` and
`npm test` if the root was touched. Decisions: see [README.en.md](README.en.md#decisions-made).

## Phase P – phi-spaces as a package (preparatory work in the root)

In detail in [paket.en.md](paket.en.md): `exports` directly onto the sources (without a condition), `pi-codemode` to `devDependencies`,
switch codemode-chat and help-site to `import … from "phi-spaces"`, check script against relative `src/` imports.

**Acceptance:** all existing suites green; the spaces-mmo scaffold starts only via `phi-spaces`, locally and in the Docker image.

## Phase 0 – Scaffold (guest + login, one room, text + map)

**Status 2026-10-24: implemented.** 12 acceptance tests green (`npm test` in `spaces-mmo/`), typecheck green, checked in headless
Chromium (guest, `look`, `say`, click on the map, phone width). Start: `npm run build`, then `npm start`
(port 3900; `SPACES_MMO_MEM=1` keeps everything in memory). Deviations from the plan: `accounts` as its own store/socket,
`x-mmo` header instead of a CSRF token ([architektur.en.md](architektur.en.md#accounts-and-login)); additionally tested: restart of the
Space process on SQLite.

- `spaces-mmo/package.json` (`phi-spaces-mmo`), `tsconfig.json`, `server/launch.ts` with space, world, web; Space in
  memory (tests) and on SQLite.
- **Login** (see [architektur.en.md](architektur.en.md#accounts-and-login)): register, sign in, sign out, cookie +
  CSRF, credentials in the dedicated Space `accounts`, first admin via setup token.
- **Guest access** (see [architektur.en.md](architektur.en.md#guest-access)): "Play as guest", guest account with lease,
  cleanup worker, registration from the guest session carries over the progress.
- One character per account, one `Session` with a lease, one room with a fixed grid.
- Commands: `look`, `say`, `who`, `help`, `move x y`.
- Browser: login page, text log + command line, `MapView` with PixiJS (ground + figures, still without interpolation).

**Acceptance:** Two signed-in browsers see each other on the map and in `say`. Wrong password ten times →
locked for one minute. Two simultaneous registrations of the same name: exactly one succeeds. A guest picks up
something, registers and afterwards has the same character with the same inventory; if `web` is killed between step 1
and 2 of the conversion, the guest keeps playing and the name is free again after the lease expires. A guest
account without activity disappears with its character after its lease expires. If a tab is
closed, the figure disappears from `who` after the session lease expires. Restarting `world` or `web` signs
nobody out and loses nothing.

## Phase 1 – World core after Evennia

**Status 2026-10-24: implemented.** Both acceptances as tests (`tests/phase1.test.ts`, with two world workers and with one
world worker that dies by SIGKILL in the middle of `give`), plus exits, items, builders, locks, tags and loading of the
world; unit tests for lock parser, FuncParser, cmdset merge and typeclasses (`tests/engine.test.ts`). New along the way:
`step <dx> <dy>` (click and arrow key, relative), `perm` (admin grants builder), `tag`, `lock`, `examine`;
`npm run world:load [-- --replace]`. Deviations and limits: [evennia-abbildung.en.md](evennia-abbildung.en.md#status-of-phase-1).

- Typeclass registry, objects/rooms/exits/characters, `location` model; engine and world separate
  (`server/engine/` vs. `worlds/leuchtfeuer/`).
- Commands + cmdsets with merge rules; `go`/directions, `get`, `drop`, `give`, `inventory`, `emote`.
- Tags, locks (lock strings), permissions, prototypes + spawner, help entries.
- Builder commands (`dig`, `open`, `create`, `spawn`, `set`, `destroy`); load world files (`world:load`).
- FuncParser basic form (`$you()`, `$conj()`).
- Map: exits and items as sprites, changing room loads the new map.

**Acceptance:** 20 simulated players type `get münze` on one coin at the same time, exactly one gets it. A
`give` transfers an item entirely or not at all, even if `world` is killed in the middle of the transaction.

## Phase 2 – Time: tide, fire, fog

**Status 2026-10-25: implemented.** Acceptance as tests (`tests/phase2.test.ts`, game time accelerated via
`SPACES_MMO_TIME_SCALE`): A fire goes out by itself at the computed time (the `Flame` entry names the world time until which it burns; since the world time, [weltzeit.en.md](weltzeit.en.md)), the fog rises to 3 and closes the exits, adding fuel lowers it and opens them. Bo commutes between the rooms for more
than a game hour without entries accumulating. Plus tide (flotsam with a world-time end,
at most 4 per room), channel `hafen`, `ruf`, Ines as fire keeper who warns and greets. Deviations:
[evennia-abbildung.en.md](evennia-abbildung.en.md#status-of-phase-2). Also: pages detect a new build and reload;
two figures never stand on the same tile (`Spot` entries with `unique`, `tests/collision.test.ts`); the space bar picks things up.

This phase implemented scaled durations, not yet a clock with world hour or world day. The persisted time and
scheduler contract has since been built: [weltzeit.en.md](weltzeit.en.md).

- Ticker worker, scripts as entries, on-demand computation.
- Flotsam with a lease, beacon with a renewable lease, fog levels per room.
- Channels (`ChannelMsg`), reputation counter per fire.
- Script NPCs (process `npc`): keeper, ferryman (only `Intent`s).

**Acceptance:** Without adding fuel a fire goes out at the computed time, the fog rises and exits close.
After adding fuel it is the other way round. A ferryman NPC runs his route for hours without a leak (entry count stays
bounded).

## Phase 3 – Extending the graphics (PixiJS)

**Status 2026-10-25: implemented.**
- **Graphics:** Water and shore as autotiles (RPG Maker VX blocks made of quarter tiles, the three wave images animated);
  figures glide from tile to tile with walking frames; the fire flickers.
- **Fog:** a veil with cut-outs around the own figure and around a burning fire.
- **Controls:** Zoom 1×/2×/3× with a camera that follows the own figure; dragging looks around; long press or
  right click opens a context menu; "Text only" toggle; without WebGL it continues as text.
- **Names:** In full rooms only the own name and those of nearby figures are shown.
- **Phone and tablet** (2026-10-26): two fingers zoom, in 2D in the integer steps 1×/2×/3× (the pixels
  stay sharp), in 3D continuously (`client/pinch.ts`); the maps take all fingers themselves (`touch-action: none`), the
  page scrolls beside them. A D-pad with an action button (`client/TouchPad.tsx`, like arrow keys and space bar) and
  larger tap targets appear only with `pointer: coarse`. A tablet in portrait (up to 1100 px) stacks map and
  side panel like the phone, in landscape they stand side by side. `viewport-fit=cover` with safe-area margins for
  notch devices, `100dvh` instead of `100vh`, a web app manifest (`app/manifest.ts`, icon `app/icon.svg`) for the
  home screen. Not yet checked on real devices.
- **Measured** (`tests/phase3.test.ts`, latency alone with `npm run test:perf`): greeting 3 KB with 12 figures (limit 64 KiB); from step to
  position report on average 105 ms with 90 % under 186 ms (target under 150 ms); each player receives only their room.
- **In headless Chromium** with 30 figures, 29 of them running bots: 38 frames/s at zoom 1, 37 at zoom 2. That is
  software rendering without a graphics chip; it has not been measured on a real phone.
- **A texture atlas** is not needed: The few sheets are loaded once and their sections cached.

- Deltas instead of snapshots, interpolation of movements, fog layer with mask, fire as an animated sprite.
- Tilesets from Intersect assets with `CREDITS.md`, autotiles (water, shore), texture atlas of the world Leuchtfeuer,
  figures from `entities`, integer zoom, touch (tap, drag, context menu).
- Gateway: area of interest per session; "text only" toggle; fallback without WebGL.

**Acceptance:** Latency targets from [architektur.en.md](architektur.en.md#tick). Frames stay under 64 KiB per room snapshot.
Playable on a phone. 30 figures in one room run smoothly (≥ 30 fps) on a mid-range phone.

## Phase 3b – optional 3D view (in parallel)

**Status 2026-10-25: first prototype implemented.** The work is decoupled from the world model and can be continued in parallel to
the further engine phases.

- `MapRenderer` passes the same server views and grid inputs on to either PixiJS or Three.js; text,
  2D and 3D can be switched in the running client.
- Three.js `0.186.1` is pinned exactly and loaded dynamically only for the 3D view. An error falls back first
  to 2D and then to the fully playable text mode.
- `terrainHeight` is versioned, deterministic and purely visual. Instanced terrain tiles, figures,
  game objects, fog, camera follow, rotation, zoom and grid clicks are present.
- A focused test checks deterministic and bounded heights as well as unknown tile types.

Since then own low-poly models have been added (`client/props3d.ts`).

**Still no acceptance:** water shader, GPU and memory budgets on a target phone, and a
browser E2E comparison of the 2D/3D grid inputs. These points block neither world logic nor phases 4 to 7.

## Phase 4 – Trade and economy

**Status 2026-10-25: implemented** (`tests/phase4.test.ts`).
- **Exchange:** `offer <things> an <person> [für <things>]`, `accept`, `decline`, `offer zurück`.
- **Market board:** at the Graue Bucht, prices in coins; the goods wait in escrow at the place `market`, a ticker
  brings them back after an offer has expired.
- **Crafting:** `craft` with shell knife and wood bundle; a tool wears out with every use.
- **Order board:** A ticker posts up to three orders; take, deliver, wages in coins.
- **Conservation fuzz:** 6 players, 2 world workers, 15 s of random exchanges, purchases, withdrawals and gifts; in the
  measured run 56 succeeded. Each of the 42 items used exists exactly once afterwards, with one player
  or at the market behind a living offer.
- **Sinks:** Fuel burns, tools break, orders consume the delivered things. Coins arise
  only as wages from the board.

- Direct exchange (`offer`/`accept`) as one transaction; market board (offers as entries with a lease).
- Recipes/crafting via prototypes; order board as master worker.
- Sinks against inflation: fuel burns, tools wear out (on demand).

**Acceptance:** Fuzz test with many simultaneous exchanges and aborts; the sum of all items afterwards is
equal to the sum before plus spawns minus consumption (conservation check).

## Phase 4b – Archipelago and inhabitants

**Status 2026-10-25: implemented** (`tests/world.test.ts`, `tests/economy.test.ts`); in detail in [welt.en.md](welt.en.md).
- **World**: 25 rooms on five islands (since grown to 37 on eight, see [welt.en.md](welt.en.md); generator `worlds/leuchtfeuer/islands.ts`), ferries, one fire per island,
  flotsam per beach, storm surge, new things and recipes, three markets and order boards.
- **Inhabitants**: 16 script NPCs (collectors, keepers, traders, craftspeople, chatterers) trade, exchange and talk via
  the same commands as players, without model calls. Model roles listen only to humans.
- **Overview map** at the top left.

**Acceptance:** every room reachable from the start, every path walkable in every room; letting all NPCs
play at once does not change the number of coins.

## Phase 5 – Model NPCs (cost tokens, only after approval)

**Status 2026-10-25: implemented, tested only with scripted models** (`tests/phase5.test.ts`); a live run with
a real model is outstanding and needs approval.
- **Ines** is a model role: woken by a weak or extinguished fire, being addressed or someone who
  comes in; awake she answers with the model (only `say`/`emote`) and remembers something with `NOTE:`.
- **The Stranger** is a wanderer who appears only in prolonged dense fog.
- **Limits:** `SPACES_MMO_NPC_MAX`, daily budget per role, shared quotas. Roles go to an
  npc process by lease; if it dies, another takes over.
- **Labelling:** Model roles are marked as AI on the map and in the log.
- **Deviations:** [modell-npcs.en.md](modell-npcs.en.md#status).
- **In addition: input in natural language** ([architektur.en.md](architektur.en.md#input-in-natural-language)) and
  buttons for exchange, market and orders.

In detail in [modell-npcs.en.md](modell-npcs.en.md): fixed roles that wake on events (dozing/awake/absent), wanderers through events, `SPACES_MMO_NPC_MAX` counts only the awake ones.

- The `npc` process uses the `agent/` package; agents play via the same commands as humans.
- Quotas per day/minute like `CODEMODE_LLM_PER_DAY`, `CODEMODE_LLM_PER_MIN`; off by default
  (`SPACES_MMO_LLM=0`).
- Tests with scripted models (filter out system messages before checking the last message, see
  `docs/examples.en.md`).

## Phase 5b – Gods (model NPCs that extend the world)

In detail in [goetter.en.md](goetter.en.md): islands, orders, events and stories in stage 1, items, creatures and market in stage 2, new worlds as a draft in stage 3. A reviewer lets drafts go live, the admin can switch off and roll back.

## Phase 6 – Automata (player programs)

In detail in [automaten.en.md](automaten.en.md): templates with fields, rule toolkit, demonstrating and assistant (description to code) from the start; model NPCs may build automata. German and English switchable (commands always in both, code and texts per user).

- Players write small programs (`schritt(sicht, merk) → { tue, merk }`) that run in the pi-codemode sandbox
  (like the contributions in codemode-chat), in a dedicated automata process.
- An automaton is a game item with its own figure; its budget is oil (lease), when it is empty it stands still.
- A selection of six tested example automata (greeter, beachcomber, fire keeper, messenger, fog buoy, trader),
  ordered by difficulty, adoptable in the game and in the editor.
- Small help system from one source: articles in the format of the codemode-chat help, in the game as `help automat …`,
  in the editor as reference, "?" tips and trial run.

**Acceptance:** see [automaten.en.md](automaten.en.md#acceptance).

## Phase 7 – Operation and scaling

- Zones as named Spaces with `Travel` handover; admin area; dashboard connection; Docker profiles like codemode-chat
  (nano/big).
- Starting containers on a shared server (`big`) only after asking.

Status: Docker profiles (nano/big) and operation are in [betrieb.en.md](betrieb.en.md); instead of named zones with `Travel` handover,
four region Spaces with `Handover` at the ferry divide the world ([welt-aufteilen.en.md](welt-aufteilen.en.md)).

## Module K – Combat (optional)

Not part of the core; an engine module `server/engine/combat/` that can be added at any time from phase 2.

- **Can be switched off:** off by default; a zone switches it on (`Room.fields.combat = true`, e.g. the dense
  fog zones). Where it is off, the commands do not exist at all (cmdset `CombatCmdSet` attaches only to such rooms).
- **Turn-based:** one `Encounter` entry per encounter with a lease; turns every 3 s, each participant gives one
  command (`hit`, `guard`, `flee`, `use <thing>`); the world worker evaluates a round in one transaction.
- **Opponents:** fog creatures as NPC figures; PvE only. PvP at most later and only in specially marked zones.
- **Mild consequences:** Whoever loses is carried back to the nearest burning beacon and loses part of the
  carried flotsam, no equipment.
- Automata may not fight (the cmdset of automata contains no combat commands).

**Acceptance:** With the module switched off no combat commands are reachable and all other suites stay green.
A round with simultaneous commands of many participants is evaluated exactly once, even after a crash of
`world` in the middle of the round.

## Performance (2026-10-27)

Load test with all NPCs, SQLite and a delayed connection between big and nano (`tests/perf/load.test.ts`); causes,
changes and measured values in [betrieb.en.md](betrieb.en.md#load-and-latency). Before, the Space with all NPCs and ten
players answered 0.3 steps per second (lost room tokens); now 20 players at ping 20 ms with median 55 ms, p99 119 ms.

## Still open

Nothing fundamental. Decided since the first draft:

- Tileset: Intersect assets, tilesets under CC BY 4.0, with `CREDITS.md` ([architektur.en.md](architektur.en.md#graphics-intersect-assets)).
- `pixi.js` exactly `8.22.0`.
- `agent/` stays with relative imports in phase P ([paket.en.md](paket.en.md#agent)).
