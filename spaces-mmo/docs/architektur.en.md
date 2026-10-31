# Architecture

## Processes

As in codemode-chat, every role is a process of its own around a Space (cf. `codemode-chat/server/launch.ts`,
`space-host.ts`):

| Process | Task | Model |
| --- | --- | --- |
| `space` | Holds the Space (phi-spaces store `openSqliteHost`, in tests `openOwnMemoryHost`), serves it via `serveSpace` (Unix socket/TCP) | `codemode-chat/server/space-host.ts`, `src/standalone.ts` |
| `world` | Takes `Intent`s, executes commands, world ticks (tide, fire, fog), spawner | `codemode-chat/server/judge-host.ts` (take under transaction) |
| `npc` | Script NPCs, later model NPCs; write only `Intent`s | `codemode-chat/server/agent-host.ts`, `model-host.ts` |
| `model` | Translates free sentences into commands and provides the model choice (`server/model-host.ts`) | `codemode-chat/server/model-host.ts` |
| `automaton` | Player programs in the sandbox (phase 6, planned, not yet built, [automaten.en.md](automaten.en.md)); write only `Intent`s | `codemode-chat/server/judge-host.ts` |
| `web` | Next.js app, HTTP API, WebSocket gateway, login, sessions, quotas | `codemode-chat/server/index.ts`, `hub.ts`, `quota.ts`, `phi-spaces/ws` |

All except `space` talk to the Space via `RemoteSpace` + `socketTransport`. `world` and `npc` can be started several
times. The browser loads no Space code; `src/` remains pure server code.

Every process registers, as in the codemode chat, with a `Process` entry in the world Space (`announce` in
`server/space.ts`: role, host name, CPU, vCPU, memory, pid; lease 30 s, renewed every 10 s, a terminated process drops
out after 30 s at the latest). `GET /api/system` of the web process summarizes them per host (at most one query of the
Space per 5 s), and the bar below the game shows from it "Testsystem: big (web, world, npc, model) · CPU · vCPU · GiB ·
nano (space, world) · … · N Entries". The host name is set by `SPACES_MMO_HOST_NAME` (Docker:
`NANO_HOST_NAME`/`BIG_HOST_NAME`, default `nano` and `big`), otherwise the name of the machine applies.

```
Browser ──WebSocket──▶ web ──RemoteSpace──▶ space ◀──RemoteSpace── world (1..n)
                                              ▲
                                              └────RemoteSpace──── npc (0..n)
```

## Data flow to the browser

- **In:** The browser sends only commands (`{t:"cmd", line}`), movement clicks become text commands in the client. The
  gateway writes `Intent` entries from them and enforces quotas per session and IP (pattern `quota.ts`,
  `CODEMODE_REQ_PER_MIN`).
- **Out:** `changes(afterRev)` delivers a global stream of all commits. The gateway reads it once and filters per session
  by area of interest (current room, inventory, subscribed channels). A newly connected client first gets a snapshot of
  the room (`readAll({fields:{location}})`), afterwards only deltas.
- **Frame size:** `phi-spaces/ws` limits frames to 1 MiB; the gateway sends rooms small (tile map compressed,
  descriptions reloadable), like `hub.ts` with code snapshots.
- If the `changes` cursor falls behind the retention, the gateway restarts with a snapshot (like the feed hub of the
  help-site, commit b85073d).

## Tick

- Movement on a grid, one step per command, checked on the server. The own figure runs ahead of the answer
  (`client/walk.ts`): Every step gets a number and is drawn immediately; the server confirms every numbered step at the
  figure (`Character.ack`, only to the connection that sent it), also one that did not go (a wall, someone stands there).
  The page strikes the confirmed steps and draws the figure at the place of the server plus the steps that are still on
  their way. A position without a newer confirmation does not count while steps are on their way; only without any answer
  for 15 s (`RESYNC_MS`) does the page take the place of the server again. A held arrow key runs at its own pace
  (`WALK_MS`, 150 ms per cell, the map glides at the same pace), not with the repeat of the keyboard; letting go stops
  immediately. In the 3D view the arrows follow the rotation: up means away from the camera (rounded to the next quarter
  turn, `screenToGrid`), so rotated by 180° up is down in the grid. At most eight steps run ahead of the confirmation.
  Other figures are interpolated between the positions of the server.
- World ticks at 1 Hz for state with visible time (fog, tide), everything slower via leases and on-demand calculation.
  The persisted clock with world hour and pausable domain appointments is described in [weltzeit.en.md](weltzeit.en.md) and
  implemented.
- Goal for phase 3: command to display < 150 ms on the LAN, < 400 ms over the network.
- The path of a step (since 2026-10-27, measurements in [betrieb.en.md](betrieb.en.md#load-and-latency)): The gateway writes the
  `Intent` (one call). The world worker serves up to `SPACES_MMO_WORLD_LANES` figures at the same time, each figure in
  turn (its `ActorToken`), and takes each waiting figure in the order of its oldest command. A step reads figure, exits
  and the own tile as a snapshot (`readAll`, without commit), writes the new `Spot` with the `unique` check and the
  figure, and commits: no locking of a room, no account, no command sets. The gateway follows the change stream, which the
  Space wakes at commit (before, the service looked every 50 ms).

## Scaling

- **Phase 0–5:** one Space for the whole world. For a few hundred simultaneous players, one Space with a gateway that
  filters the stream suffices. Since 2026-10-28 the world runs in four regions with one Space each
  ([welt-aufteilen.en.md](welt-aufteilen.en.md), [betrieb.en.md](betrieb.en.md#regions)).
- **Regions and zones:** separate Spaces per region. A change between zones is no longer a shared transaction, because
  transactions apply only within a Space. Solution: two-step handover with a `Travel` entry (take in zone A, write in
  zone B, receipt back), idempotent via a travel ID.
- Federation and replication (`src/runtime.ts`, `primary-sync.ts`) are available, but not needed for the game before
  phase 7.

## Rights

- All processes of the game talk to the Space as the same internal peer (role `member`, `server/space-host.ts`); the
  Space does not separate roles, and the ports belong only on internal addresses ([betrieb.en.md](betrieb.en.md#ports)). The
  credentials therefore live in a Space of their own on a socket of their own, which only the web process reaches.
- Players have no direct access to the Space; only the gateway knows their identity.
- Builder and admin rights are world rights (`perms` on the account, locks), not Space roles.

## Overview map

At the top left, above the room map, lies an overview of all rooms with place (`RoomDef.map`, `island`), see
[welt.en.md](welt.en.md#overview-map). The gateway sends `atlas` (terrain, fires, connections) once per connection and
`atlasState` (own room, fog, burning fires, people present per room) after changes, at most once per second. It is drawn
with a simple 2D canvas, independent of the 2D/3D room map.

## Input in natural language

Whoever types a sentence instead of a command is understood in two stages:

1. **Rules** (`server/engine/translate.ts`, free, always on) translate common sentences with a view to the room:
   "gehe nach osten" → `go ost`, "nimm das holz auf" → `get holz`, "kaufe muschel am markt" → `market kaufe 1`,
   "biete muschel am markt für 2 an" → `market biete muschel für 2`, "lege holz ins feuer" → `put holz in feuer`,
   "schau dich um" → `look`, "gib ines ein stück holz" → `give holz an Ines`. Typed commands and speech (`say`, `kanal`)
   stay unchanged. A sentence that addresses someone in the room ("hallo ines, leg holz ins feuer", "Bo: wohin?") is
   speech (`say …`), not a command for the player: the addressee hears it and acts on her own (docs/modell-npcs.en.md). A
   greeting without a name ("hallo, leg holz ins feuer") is passed over. Names of things may have typos, plural, numbers
   and attached units: "lege 5 holstücke ins feuer" adds up to five driftwood.
2. **A cheap model** (`server/model-host.ts`, only with `SPACES_MMO_LLM=1`) gets what the rules do not understand, and
   every sentence whose command is not understood (an unknown name of thing, person, exit, channel or recipe, a command
   without what is needed: "lege 2 brennstücke ins feuer", "give holz"), before an error message comes. Only when the
   model too does not know further does the player see the rejection. What fails on the game state (too far away, fog,
   too few coins, currently occupied) is rejected immediately; the model could change nothing there. The world worker
   writes a `Translate` entry for this; the model process shows the model the commands and what the player sees, and
   writes the answer back as a new job with the original sentence (`asked`). An answer that does not start with a known
   command is discarded; a translation is never translated again. Quotas: per account and day (guests less), plus the
   shared limits per minute and day.

The player sees each time how he was understood: "gehe nach osten" → go ost. Only spoken text not: "hallo kalle" becomes
`say hallo kalle`, the spoken line already shows it (a line "→ say …" afterwards read as if the saying were still
pending).

## Accounts and login

From phase 0 both exist: play immediately as a guest or with an account. A guest can register at any time and keeps his
progress (see [Guest access](#guest-access)). Login built on the pattern of `help-site/server/admin/admin-controller.ts`,
but for many accounts instead of one admin password, without a new dependency (`node:crypto`):

- **Registering:** username + password; stored is `scrypt(password, salt)`, comparison with `timingSafeEqual`. Usernames
  are unique: one `Credential` entry per name, written under a transaction that checks beforehand via `readIfExists` (two
  simultaneous registrations of the same name: one fails).
- **Separate Space for credentials:** `Credential` and `WebSession` entries lie in the Space `accounts`. The Space process
  serves it from a **store of its own on a socket of its own** (`SPACES_MMO_ACCOUNTS`), whose address only the web
  process gets. (A named Space in the same store would have been reachable via the world socket; the service does not
  separate roles per Space.) World, NPCs and automata see only `Account{accountId, name, guest, admin}` in the world
  Space, never a hash.
- **Unique names:** Every registration takes in one transaction the one `Lock{name:"names"}` entry, checks the name
  (waiting for a currently held credential) and writes the claim; afterwards it puts the lock back.
- **Session:** HttpOnly cookie (`SameSite=Strict`, `Secure` behind HTTPS). Instead of a CSRF token every POST requires the
  header `x-mmo: 1`, which a foreign form cannot set (like codemode-chat). The WebSocket checks cookie and `Origin` on
  upgrade. Server-side a `WebSession` entry with lease (12 h, renewed on use), so that a restart of the web process logs
  nobody out.
- **Protection:** Login attempts limited per IP and per account (like `#loginAttempts`), registrations limited per IP and
  day, minimum length for passwords.
- **Roles:** `perms` on the account (`Player`, `Builder`, `Admin`); the first admin is created via an environment variable
  or a one-time setup token (like the enroll token of the help-site).
- **Later:** Passkeys (WebAuthn) are possible, but not planned.

### Guest access

- **Play immediately:** "Als Gast spielen" creates without input an account `Account{id, name, guest: true}`, with a
  random name ("Strandläufer-4821"), and sets the same session cookie as a login. The guest gets a normal character;
  world, NPCs and automaton workers treat him like any account.
- **Lifetime:** The guest account has a lease (7 days), which is renewed on every activity. When it expires, a clean-up
  worker in the world clears up: character and inventory are removed, carried raw materials return to the beach as
  flotsam. Whether the worker recognizes the expiry on the `changes` stream or by periodic comparison
  (`readAll({type:"Character", fields:{guest:true}})` against existing accounts) is decided at build time; the comparison
  is the safe fallback.
- **One device:** The guest hangs on the cookie. Cookie deleted or another device → new guest. The interface permanently
  shows for guests "Registrieren, um den Fortschritt zu behalten".
- **Restrictions against abuse** (otherwise raw materials could be shoveled onto a main account with many guests):
  - Guests can neither give items to others nor trade or offer on the market (`give`, `offer` and the market are locked
    by lock `perm(Player) and not guest()`). They may add wood to the shared beacon.
  - At most one automaton instead of two, no model-NPC access.
  - Guest creation limited per IP (e.g. 5 per hour, 20 per day), tighter command quotas and channel write rate.
  - The reputation of guests counts, but is displayed publicly only after registration.

### Taking over progress on registration

A guest registers from the running session (username + password). In doing so **the same account** is converted, not a new
one created: account ID, character, inventory, reputation, automata and history stay, because everything hangs on the
account or character ID and nothing has to be copied.

Because credentials (Space `accounts`) and account (world Space) lie in two Spaces and transactions apply only within a
Space, the conversion runs in three idempotent steps:

1. `accounts`: write `Credential{name, hash, accountId, state: "pending"}` with a short lease after `readIfExists` has
   shown that the name is free (in a transaction; the name is thereby reserved).
2. World Space, one transaction: `take Account{id, guest: true}` → `write Account{id, name, guest: false}` without lease;
   rewrite the character field `guest` likewise.
3. `accounts`: rewrite the credential to `state: "active"` without lease.

If the sequence breaks off, the next login heals: A `pending` credential whose account is already `guest: false` becomes
active; one whose account is still a guest expires with its lease and frees the name. The guest keeps playing
undisturbed in both cases.

If a guest instead logs in to an **existing** account, nothing is merged (that would open raw-material shoveling again):
The interface warns that the guest progress lapses, and the guest account expires with its lease.

## Graphics

Goal: hybrid interface. Left a tile map of the room, right or below text log and command line. Without graphics (screen
reader, weak device, agent) the game remains fully playable.

**Model:** A room has a small grid (e.g. 24×16 tiles, `grid` field: ground layer as a string, tile IDs from a tileset).
Objects in the room have `x`, `y`. Exits lie at the edge or on door tiles. World map = graph of rooms, no endless
territory.

**Renderer: PixiJS** (decided; package `pixi.js`, exactly `8.22.0`, only in `spaces-mmo/package.json`). This is the
current stable version (released 2026-10-01). It is fixed without `^`, like `next`/`react` in help-site and
codemode-chat, so that Docker builds stay reproducible; an update is a separate step with a test. PixiJS is only a
renderer: no game loop or physics of its own that would compete with the server as the truth.

- **Integration into Next.js:** A client component `MapView` loads `pixi.js` via dynamic `import()` only in the browser
  (no SSR), creates an `Application` on a `<canvas>` and cleans it up on unmount. React controls frame, text log and
  command line; PixiJS only the map.
- **Scene:** Containers per layer: ground (from `grid`, once per room as tile sprites or a pre-rendered texture image),
  objects (`Sprite` per entry, sorted by `y`), figures, fog (semi-transparent layer with mask by fog level), markers
  (target, selection).
- **Deltas:** The gateway sends `{t:"delta"}` with added, removed and moved objects; `MapView` holds a
  `Map<entryId, Sprite>`, movements are interpolated over ~200 ms (ticker of PixiJS).
- **Input:** Click/tap on the map → **one step** in this direction (longer axis first, otherwise the other; the client
  avoids occupied tiles), exactly like an arrow key; from it `step dx dy` is made. **Space bar** picks up the next thing
  in reach (the own tile first), without a thing it adds firewood to the nearby fire. **Enter** jumps to the command
  line, **Esc** back to the map; an **arrow key** in the command line also goes back to the map and makes the step
  (up/down always, left/right only with an empty line, otherwise they move the cursor). On an object (from phase 1) →
  context menu with text commands (`get`, `look`, `talk`). Everything becomes a text command; the typed command `move x y`
  in contrast goes the whole way.
- **Display:** `scaleMode: "nearest"` for sharp pixels, integer zoom levels (1×–3×, the camera follows the own figure,
  dragging shifts the view, two fingers change the level), `resolution` = `devicePixelRatio`, text at triple resolution.
  Instead of an atlas the sheets are loaded once and their cut-outs cached.
- **Autotiles:** A tile with `auto` (water) is assembled according to the RPG Maker VX scheme from four quarter tiles per
  cell (center, inner corner, edge, outer corner, depending on the neighbors). Each block of the list is one frame of the
  wave animation; outside the room counts as the same tile (the sea continues).
- **Movement and life:** Figures glide in about 140 ms from tile to tile and show their four walking frames while doing
  so, the fire flickers, the fog spares the own figure and burning fires.
- **Context menu:** long press or right click on a tile; the entries (look, pick up, add wood, walk there) are text
  commands.

### Graphics: Intersect assets

For Leuchtfeuer the tilesets are taken from [Intersect-Assets](https://github.com/AscensionGameDev/Intersect-Assets)
(branch `main_full`, folder `resources/`). This is a package for a 2D fantasy MMORPG: tilesets, figures, animations,
items, interface, sounds and music, all in one style.

- **Why this one:** Water autotiles with shore edges to sand, grass and rock, plus caves and overworld. This is the
  archipelago of Leuchtfeuer almost without graphics of its own. Figures (`resources/entities/`, 112 files) and equipment
  layers (`paperdolls`) fit.
- **Format:** Tiles 32×32 px. Water and ground exist as autotiles in RPG Maker VX format (block of 2×3 tiles, assembled
  from quarter tiles depending on neighbors). `MapView` needs a small autotile logic for this (neighbor mask → four
  quarter tiles); it is computed once per room on loading, not per frame.
- **License:** According to the commit history, the chosen tilesets are under CC BY 4.0 (Zetasis, George, Murdoc; e.g.
  `Ground.png`, `Terrain.png`, `Autotiles_Water.png`, `Overworld.png`, `Caves Etc.png`). Commercial use is allowed,
  attribution is mandatory. Most item icons (Joe Williamson) are under CC BY-SA 3.0 and are not adopted as long as nobody
  wants the share-alike obligation for changed images. The repo has no overall license; the license of every adopted file
  is checked individually in the commit history.
- **Adoption:** Only selected files (a few MB) into `spaces-mmo/worlds/leuchtfeuer/assets/`, no submodule and no copy of
  the whole repo (~120 MB). Beside it `CREDITS.md` with file, author, license and source commit; the interface shows the
  attribution under "Über".
- **Plants:** Flowers, herbs, bushes and small trees lie as a layer of their own `decor` above the ground (same grid as
  `ground`, key from `world.decor`, cut out of `Overworld.png` into `tilesets/Plants.png`). `plants()` in `islands.ts`
  places them by seed only on grass, never on or next to paths, doors, start point, people, fires and things; how much
  grows is stated by `flora` per island or place (no tree on Möwenfels and Tangriff, forest on Nebelholm). They are only
  for the eye: all fields stay walkable, no game rule changes. 2D draws flat plants under the things and upright
  (`upright`) ones between the figures, 3D sets them up as images facing the camera.
- **Fallback:** Kenney packages (CC0, no attribution) for test scenes or when a tile is missing; within the same room the
  styles are not mixed.
- **Fallback:** No WebGL available → PixiJS canvas fallback or text mode. The switch "text only" is always there
  (accessibility, weak devices, agents).
- Field of view and pathfinding are computed by the server (world worker), not by the renderer.

### 3D view: Three.js

The optional spatial map uses **Three.js `0.186.1`** (MIT, pinned exactly). The first prototype is a **2.5D view of the
existing grid world**, not a new three-dimensional world or movement model. Three.js renders and interpolates in the
client; it brings no authoritative game simulation or physics. `MapRenderer` is the shared boundary for 2D and 3D: Both
views receive the same room, figure and object views and return grid cells to the same input callbacks. `MapView3D` loads
Three.js dynamically in the browser, runs a `requestAnimationFrame` render loop and holds `Map<entryId, Object3D>` for
figures and objects. Godot or Bevy, in contrast, would be no integration but a platform change, because their export
takes over the whole canvas.

The things of the world are drawn by `client/props3d.ts` as own low-poly models from Three.js primitives, without model
files (in style modeled on cubic dioramas like mitsuhiko's "dungeon-crawler", but nothing adopted from it): trees,
conifers and bushes (`model` on an entry of `decor` in the world; without `model` the image stays), the hut and the rain
barrel according to their plan (`ObjView.plan`), a building site whose walls and scaffolding grow with progress (one
geometry per tenth) and whose wood pile shrinks in the process, the ruin, the stone ring of the fire and a signpost at
the exit. Each model is a merged geometry with colors at the vertices (faceted, each face slightly lighter or darker),
built once per kind and variant and shared (`userData.shared`, the `dispose` of the map leaves them standing); variant,
rotation and size come from the place (`stableHash`), so a room looks the same on every build. Plants do not grow on cells
occupied by a building, a building site, a ruin or a bed: the plants are a group of their own that is recreated when these
cells change. All this is only presentation; rules, paths and occupancy stay 2D.

The user can switch between text, 2D and 3D independently of the server; the choice remains stored in the browser. If
Three.js or WebGL cannot start, the client falls back to 2D. If the 2D map also fails, text mode remains. Drawn are
instanced tile cuboids, simple geometries and name billboards; low-poly models, water shader, decor, measured phone
budgets and WFC-generated rooms are not yet an implemented 3D acceptance.

**Calm image:** Renderer, camera and render loop arise **once**; a room change replaces only ground and things
(`MapView3D`, effect per `roomId`). The camera looks at the **center of the room** from a distance that shows the whole
room, and stays there: A step moves only the figure, not the ground. Only rotating and zooming move the camera. `setSize`
runs only when the size really changes (it clears the image), and the fog is a single `FogExp2` whose density changes.
Measured with Chromium and SwiftShader: after six steps the ground is unchanged pixel for pixel, there is one WebGL
context and two size adjustments in total.

**Textures:** The ground uses the tile images of the world, the same sheets as the 2D map (`client/tiles3d.ts`). Each tile
kind is cut into a small canvas texture of its own (so mipmaps do not bleed over the edge), near with `NearestFilter`, in
the distance with mipmaps (nothing flickers); water consists of the single frames of the autotile and changes at the pace
of `frameMs`. The textures lie in a cache per world. The cuboids join without a gap; the small height scatter from
`terrain3d.ts` stays off in the view, because even a hundredth of difference between neighbors appears as a dark seam. The
sides are plain earth.

**Figures:** `client/figure3d.ts` builds every figure from primitives into a human (head with hair and eyes, neck, torso
with belt, arms, legs, boots, shadow). Appearance from skin number (tunic, trousers) and figure ID (skin tone, hair); the
own figure wears green and a ring, AI figures blue. It turns in the direction of walking, the limbs swing while walking,
standing it breathes and looks around. The figures are drawn 1.3 times a cell high so that they remain legible in the
overall view. Real models (glTF) would be the next step; they need files with a license and an entry in `CREDITS.md`.

Authoritative generation and presentation are two separate paths:

```
Bauanweisung → serverseitiger Generator/Prüfer → persistiertes ground-Raster → Spielregeln
                                                        ├───────────────→ 2D-Renderer
                                                        └───────────────→ 3D-Renderer
```

The `ground` grid, `TileDef.walk` and the `x`/`y` positions of the entries remain the only truth. Height, lighting and
purely visual decor may change neither walkability nor reach, line of sight or collision. Bridges, overlapping surfaces,
jumps and vertical paths would be a later change of the server model and are expressly not covered by this outlook.

**3D presentation contract:** Three.js creates no new world state, but builds a view of the persisted grid:

- **Coordinates:** A grid cell corresponds to a fixed world unit. `x` becomes the horizontal X axis, `y` the horizontal Z
  axis; the vertical Y position is delivered by exactly one versioned function
  `terrainHeight(roomId, ground, tiles, x, y)` in `client/terrain3d.ts`. Figures, items, exits and effects use the same
  function.
- **Terrain:** A world defines the visual base height per tile type. Stepped terrain uses a few `InstancedMesh` groups per
  geometry and material; smoothed terrain uses a shared height field. Small height deviations may lie only within fixed
  visual limits, so that a tile walkable on the server does not look like an insurmountable wall.
- **Determinism:** A stable string hash and a fixed PRNG generate noise from `roomId`, tile coordinates and
  `TERRAIN_RENDERER_VERSION`. The prototype uses FNV-1a and no `Math.random()`. A separate world seed or a fixed PRNG is
  needed only when further deterministic decor is generated besides the small height variation. An additional library such
  as `simplex-noise` is not a prerequisite for this.
- **Water:** The prototype keeps water flat and renders it as a simple material in the terrain instance group. The goal
  for the extended view is a layer of its own. A later `Water` effect is bound as an explicitly imported Three.js add-on
  to the `WebGLRenderer`; normal map, renderer and simple fallback are then versioned together with the asset.
- **Figures and objects:** First billboards, later optionally low-poly glTF models (`GLTFLoader`), e.g. from CC0 kits.
  Models are loaded and reused per asset; GPU resources are released on room change. The foot point lies on
  `terrainHeight(...)`, not on an independently estimated height.
- **Decor:** Grass, bushes and stones may be scattered deterministically, but are not selectable, walkable or part of the
  game physics. Everything relevant to the game remains an entry.
- **Scope:** Small rooms need no chunking or LOD, but several batched meshes or InstancedMeshes per room (terrain
  materials, water, decor, figures) are normal. One mesh per tile is avoided. Chunking and LOD are needed only for a later
  continuous terrain.

## Procedural rooms: Wave Function Collapse (option)

For rooms that are not drawn by hand (above all the islands of the gods, see [goetter.en.md](goetter.en.md)): **Wave Function
Collapse** in the tiled model — a constraint solver that generates a `ground` grid from tiles and explicitly defined
neighbor rules. An RPG Maker autotile describes how an existing terrain tile is drawn depending on its neighbors; it is
not yet a complete WFC grammar. Each domain palette therefore defines its tile weights and permissible neighbors
separately, e.g. water ↔ shore ↔ sand ↔ grass ↔ rock.

- **Place and time:** The generator runs on the server when creating a draft or before the first publication of a static
  world, never in the client and never again on every restart. The finished `ground` is stored as server state; text mode,
  2D and 3D client receive the same grid.
- **Reproduction:** The draft stores `algorithm`, `generatorVersion`, `palette`, `seed` and the generated output. A stable
  hash and a fixed PRNG of its own make the same attempt repeatable byte for byte. The metadata serve diagnosis and test,
  not the regeneration of an already published room.
- **Procedure:** Preassigned exits, spawn cells, fire places and anchor places restrict the possibilities. Then the solver
  propagates all restrictions and collapses a still open cell with minimal entropy. Choosing only cells next to already
  occupied cells is no guarantee of connectivity.
- **Limit of WFC:** WFC guarantees only local tile compatibility. A downstream checker verifies via BFS walkable paths
  between spawn, all exits and special places as well as the way back and minimum areas.
- **Failure:** A contradiction or a globally unplayable map leads only up to a fixed maximum number to a deterministic
  follow-up attempt (`seed` plus attempt number). After that the draft path uses a checked fallback floor plan or rejects
  the draft; it never runs unboundedly.
- **Implementation:** A tiled solver of its own avoids a runtime dependency. The expected scope is no architectural
  guarantee: backtracking, limits, diagnosis and tests belong to the implementation.

**Acceptance:** Same seed, same palette and same generator version deliver byte-identical `ground`; every neighborhood is
allowed; spawn, exits and special places are reachable. A restart changes no published room. 2D and 3D client address the
same grid cells, and no 3D height or decor changes the walkability on the server. For the 3D view an FPS and memory target
on the target phone is added.

## Directory layout

```
spaces-mmo/
  package.json          Paket phi-spaces-mmo (next, react, react-dom, pixi.js, phi-spaces: "file:..")
  tsconfig.json         eigene; nicht Teil des Root-`tsc`; moduleResolution "bundler" wie codemode-chat
  server/               die Engine
    launch.ts           startet space, world, npc, model, web (Entwicklung)
    space-host.ts       Space-Prozess (Welt-Space oder Region + Space `accounts`)
    world-host.ts       Befehle, Ticks, Spawner
    npc-host.ts         Skript-NPCs (später Agenten)
    model-host.ts       Übersetzen freier Sätze, Modellauswahl
    automaton-host.ts   Automaten im Sandbox (Phase 6, geplant)
    index.ts            Web-Prozess, Gateway, Login
    engine/             typeclasses/, commands/, cmdsets.ts, locks.ts, prototypes.ts, funcparser.ts, combat/ (optional)
  client/               React-Oberfläche, MapView (PixiJS), Textlog, Login
  app/                  Next.js-Routen
  worlds/
    leuchtfeuer/        Räume, Prototypen, Typklassen-Erweiterungen, Hilfe, Automaten-Vorlagen, assets/
  tests/                node:test, starten die Prozesse wie test:codemode-chat
  docs/                 dieses Verzeichnis
```

The engine loads exactly one world (`SPACES_MMO_WORLD=leuchtfeuer`). A world brings data (rooms, prototypes, help,
graphics) and can add type classes and commands, but not change engine rules (transactions, locks, rights).

**Separate from phi-spaces:** No game code goes into `src/`. Helper code that all projects need in the same form lies
once in the library: the WebSocket gateway (`phi-spaces/ws`, the message limit as an option, spaces-mmo 600 per minute)
and the Space helpers (`connectSpace`, `readExisting`/`StillHeld`, `peek`, `awaitWork`, `keepAlive`, `takeAll` from
`phi-spaces`, `src/space-client.ts`). `server/space.ts` now only inserts the values of spaces-mmo (addresses, waiting
times, trace). Pure interface (`client/lib/palettes.ts`, `markdown.ts`) remains a copy per project, because Next.js
bundles nothing outside the project directory; `test/test-shared-copies.test.ts` keeps the copies equal.

## Integration of phi-spaces

As a package: `"phi-spaces": "file:.."` and `import { RemoteSpace, socketTransport } from "phi-spaces"`, without build and
without special Node flags (see [paket.en.md](paket.en.md)). `npm run check:durable` applies here too, so no pi-durable, chord or
pi-ai in the game. Model NPCs go via the `agent/` package as a process of their own.
