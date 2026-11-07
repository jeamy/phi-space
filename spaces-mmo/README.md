# spaces-mmo

> **Experimental — v0.1.0.** Use at your own risk; behaviour may still change.

A multiplayer game in the browser and the engine behind it, built on [phi-spaces](../README.md). The whole world lives in
Spaces; no game state is kept in the browser. The first world is **Leuchtfeuer**: an archipelago in the fog where the
players tend fires together, gather, trade, build and lay out gardens, with text, a 2D map (PixiJS) or a 3D view.
Engine (`server/`) and world (`worlds/leuchtfeuer/`) are separate so that further worlds can run on the same engine.

## Read first

- **[docs/siedeln.en.md](docs/siedeln.en.md)** ([Deutsch](docs/de-docs/siedeln.md)): settling, building and gardening. The
  design of the game beyond the first fires, the epochs from hut to network, and the order in which it is built, with the
  implementation status per step. This is where the game is going.
- [docs/README.en.md](docs/README.en.md) ([Deutsch](docs/de-docs/README.md)): the full overview, current status, how to
  start, every document, and the decisions made.

## Further documents

| Document | Contents |
| --- | --- |
| [docs/spielidee.en.md](docs/spielidee.en.md) | The game world Leuchtfeuer and why it fits a Space |
| [docs/architektur.en.md](docs/architektur.en.md) | Processes, data flow, accounts and login, graphics, directory layout |
| [docs/3D-V2/README.md](docs/3D-V2/README.md) | The 3D view, version 2: zoom ladder, diorama, detail levels, controls, FPS measuring |
| [docs/phasen.en.md](docs/phasen.en.md) | The implementation plan in phases with acceptance criteria |
| [docs/betrieb.en.md](docs/betrieb.en.md) | Operation with Docker: image, profiles nano/big/dev, local test setup, production |
| [docs/welt.en.md](docs/welt.en.md) | How the world grows: the archipelago, the inhabitants and their trade |
| [docs/welt-aufteilen.en.md](docs/welt-aufteilen.en.md) | The world in region Spaces |
| [docs/weltzeit.en.md](docs/weltzeit.en.md) | The persisted world clock, calendar and scheduler |
| [docs/modell-npcs.en.md](docs/modell-npcs.en.md) | Model NPCs: fixed roles, waking by events, costs, durable dialogues |
| [docs/goetter.en.md](docs/goetter.en.md) | Plan: gods, model NPCs that extend the world by rules |
| [docs/automaten.en.md](docs/automaten.en.md) | Plan: automata, programs the players write |
| [docs/evennia-abbildung.en.md](docs/evennia-abbildung.en.md) | How Evennia's components map onto entries, templates, leases and workers |

German versions of every document are in [docs/de-docs/](docs/de-docs/). The help for players is in the game itself
(`client/help/articles.ts`, under "?") and as topics in the world file (`help <topic>`).

## Starting

```sh
npm --prefix spaces-mmo run build
npm --prefix spaces-mmo start        # port 3900; SPACES_MMO_MEM=1 keeps everything in memory
npm --prefix spaces-mmo test         # the tests start the processes themselves
npm --prefix spaces-mmo run typecheck
```

Model calls stay off unless `SPACES_MMO_LLM=1` is set; they cost tokens. Docker: `docker:local:up` runs big and nano
together on this machine (port 3910), `docker:dev:up` one container with the source mounted (port 3920); production is
`docker:nano:up` and `docker:big:up` on the respective machine (`docker:nano:rust:up`, `docker:big:rust:up` with the Rust Space server). Details in [docs/betrieb.en.md](docs/betrieb.en.md).

Graphics credits: `worlds/leuchtfeuer/assets/CREDITS.md` (CC BY 4.0).
