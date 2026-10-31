# spaces-mmo: multiplayer engine on phi-spaces

`spaces-mmo` is a game for many people in the browser, and at the same time the engine behind it. The first world is called
**Leuchtfeuer** (Beacon): an archipelago in the fog where the players tend fires together, gather, trade, build and lay out
gardens. It can be played with a 2D or 3D map or with text only.

The package is called `phi-spaces-mmo`. The whole world lives in phi-spaces; no game state is kept in the browser. Text is the foundation (as in a MUD), with a tile graphic using PixiJS
and a 3D view using Three.js on top. The structure of the game world follows
[Evennia](https://www.evennia.com/docs/latest/Components/Components-Overview.html), the process layout follows
`codemode-chat/` (see `docs/codemode-space-architektur.en.md` in the root). Engine (`server/`) and world
(`worlds/leuchtfeuer/`) are separate so that further worlds can run on the same engine.

## Status 2026-10-30

The game is playable, from the first login to the village. Automata, gods and the large buildings of the later epochs
are still missing. For operation it is laid out for the machines big and nano ([betrieb.en.md](betrieb.en.md)).

| Area | Status |
| --- | --- |
| Phases P to 4b ([phasen.en.md](phasen.en.md)) | built: accounts, world core, fire and fog, graphics, trade, archipelago and inhabitants |
| Phase 3b, 3D view | built, without acceptance on a target phone; own low-poly models have been added (`client/props3d.ts`) |
| Phase 5, model NPCs ([modell-npcs.en.md](modell-npcs.en.md)) | built, tested with scripted models; model calls only with `SPACES_MMO_LLM=1` |
| World | eight islands, 37 rooms, nine fires (`worlds/leuchtfeuer/world.ts`); plus 40 settlers, of whom at least 30 figures play by default |
| Chat ([siedeln.en.md](siedeln.en.md), step 0) | built: one-to-one and in groups, end-to-end encrypted |
| Building and gardens (steps 1 and 2) | built: hut, chest, decay; beds, crossbreeding, hares, fence, scarecrow |
| Fields and farm (step 3) | built: fields with crop rotation, mill, bakehouse, animals, loom, game, guards |
| Epochs and settlements (step 4) | built: islands become a village; settlements with ranks and a door. Town and network have no plans yet |
| Regions ([welt-aufteilen.en.md](welt-aufteilen.en.md)) | built: four regions on big, accounts space on nano ([betrieb.en.md](betrieb.en.md)) |
| Planned | gods ([goetter.en.md](goetter.en.md)), automata ([automaten.en.md](automaten.en.md)), zones and combat ([phasen.en.md](phasen.en.md)), from step 5 in [siedeln.en.md](siedeln.en.md) workshops up to the island railway |

## Starting

The source starts without containers, with all processes on one machine. Model calls stay off.

```sh
npm --prefix spaces-mmo run build
npm --prefix spaces-mmo start                 # port 3900; SPACES_MMO_MEM=1 keeps everything in memory
npm --prefix spaces-mmo test                  # the tests start the processes themselves
npm --prefix spaces-mmo run typecheck
```

With Docker there are `docker:local:up` (big and nano together on this machine, port 3910, image built beforehand with
`docker:image`) and `docker:dev:up` (one container with the source mounted, recompiles on every change,
port 3920). Production: `docker:nano:up` and `docker:big:up` on the respective machine. Details are in
[betrieb.en.md](betrieb.en.md).

## Documents

[spielidee.en.md](spielidee.en.md) and [architektur.en.md](architektur.en.md) are enough to get started. The help for players is
not kept here but in `client/help/articles.ts` (in the game under "?") and as topics in `worlds/leuchtfeuer/world.ts`
(`help <topic>`).

| File | Contents |
| --- | --- |
| [spielidee.en.md](spielidee.en.md) | The game world "Leuchtfeuer" and why it fits a Space |
| [architektur.en.md](architektur.en.md) | Processes, data flow, accounts and login, graphics (PixiJS), directory layout |
| [betrieb.en.md](betrieb.en.md) | Docker: image, profiles nano/big/dev, local test setup, production, load and latency |
| [phasen.en.md](phasen.en.md) | Implementation in phases with acceptance criteria |
| [siedeln.en.md](siedeln.en.md) | Settling, building and gardening: design and order; steps 0 to 4 are built, the rest is a plan |
| [paket.en.md](paket.en.md) | Preparatory work in the root: phi-spaces as a package for all projects built on it |
| [evennia-abbildung.en.md](evennia-abbildung.en.md) | Evennia components → entries, templates, leases, workers |
| [weltzeit.en.md](weltzeit.en.md) | Persisted world clock, calendar, scheduler, restart and multi-host contract |
| [welt.en.md](welt.en.md) | How worlds grow; the archipelago, the inhabitants and their trade, the overview map (status 2026-10-25, 25 rooms on five islands; later extended by three island groups, now 37 rooms on eight islands) |
| [welt-aufteilen.en.md](welt-aufteilen.en.md) | The world in region Spaces: how it is built and the design before it |
| [modell-npcs.en.md](modell-npcs.en.md) | Phase 5: model NPCs as fixed roles, waking by events, wanderers, costs, durable dialogues |
| [goetter.en.md](goetter.en.md) | Plan: model NPCs that create islands, orders and events by rules; review instead of approval |
| [automaten.en.md](automaten.en.md) | Phase 6, plan: player programs, example automata, small help system |
| [lasttest-2026-10-28.en.md](lasttest-2026-10-28.en.md) | Load tests on big and nano: response times, bottleneck, proposals |
| [messung-vpsc-2026-10-29.en.md](messung-vpsc-2026-10-29.en.md) | Measurement: how much one core on vpsc achieves as a host for regions |

## Decisions made

These questions were decided at the start. Since then only decision 3 has changed, on 2026-10-27.

| # | Question | Decision |
| --- | --- | --- |
| 1 | Name | Directory `spaces-mmo/`, package `phi-spaces-mmo`; "Leuchtfeuer" is the first world |
| 2 | Graphics | PixiJS `8.22.0` renders the 2D map; the optional 2.5D view uses Three.js `0.186.1`. Both are only views of the same authoritative grid and are pinned exactly. Tilesets come from Intersect assets (CC BY 4.0, with attribution). |
| 3 | Space and game | Stay separate: no game code in `src/`. What all projects need alike lives once in the library instead of as a copy: the WebSocket gateway (`phi-spaces/ws`) and the Space helpers (`connectSpace`, `readExisting`/`StillHeld`, `awaitWork`, `keepAlive`, `takeAll` from `phi-spaces`); changed on 2026-10-27 because the copies drifted apart |
| 4 | Integration | phi-spaces becomes a proper package (`exports`) **before phase 0**, and all projects built on it import `phi-spaces` instead of `../../src/…` ([paket.en.md](paket.en.md)) |
| 5 | Accounts | From phase 0 guest access and login (user name + password); on registration the guest's progress is carried over ([architektur.en.md](architektur.en.md#guest-access)) |
| 6 | Combat | Optional: a module that can be switched off, enabled per zone, off by default |

## Short answers to the initial questions

These questions stood at the start of the project. The answers still hold.

**Does it run in the browser like help-site/codemode-chat?** Yes. Same pattern: Next.js 16 + React 19 as the interface,
a web process with its own WebSocket gateway, and the Space processes behind it. The browser never talks
directly to a Space; it only sends commands and receives views.

**Is the Space implementation separate?** Yes, the dependency goes in one direction only: `src/` knows neither
help-site nor codemode-chat nor spaces-mmo. spaces-mmo depends on the package as `"phi-spaces": "file:.."` and imports
`phi-spaces` ([paket.en.md](paket.en.md)).

**Evennia as a basis?** Evennia's components can be mapped almost one to one onto entries and workers. The
typeclasses become entry types with subtype matching, see [evennia-abbildung.en.md](evennia-abbildung.en.md).
