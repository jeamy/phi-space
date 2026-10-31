# Splitting the world

Status 2026-10-28 (evening): **built**, after the third [load test](lasttest-2026-10-28.en.md) with 200 figures, in which one
core was no longer enough. How it is built is in the section [How it is built](#how-it-is-built); the design
below it is the consideration before.

## How it is built

- **Four regions** in `worlds/leuchtfeuer/world.ts` (`regions`): West (Graue Insel, Nebelholm), North (Möwenfels,
  Schären), East (Kupferhafen, Tangriff, Rauchholm), South (Krabbensand). Only ferries lead from one to another
  (`tests/regions.test.ts` checks this). Each region has a start bay with fire and keeper.
- **One Space per region**, each in its own Space process (`SPACES_MMO_REGION`, file `world-<region>.sqlite`),
  thus on a core of its own; in addition per region a world worker, an NPC process and a model process. Without
  `SPACES_MMO_REGIONS` the world is one Space as before.
- **The part of the world belonging to a region** (`regionWorld` in `server/engine/regions.ts`): its rooms, the exits out of them
  (including the ferries out), its things, fires, beaches, markets and boards. Prototypes, recipes, help and the clock are held
  by every region in full. Every region knows all NPCs (a trader travels across the border); an NPC is created only in
  the region where it begins, with a birth mark (`NpcBorn`) so that no region makes it a second time.
- **Handover at the ferry** (`server/engine/handover.ts`), in steps as in the design below: in the command's
  transaction, region A takes the figure, its cell and its account and writes a `Handover`; the pack stays
  in A at first. A world worker of A takes the `Handover` in a transaction and first carries the pack over,
  40 things at a time in a pair of transactions (first write in B, then take in A; a full backpack does not fit in
  one transaction). Then it writes the figure in a transaction of B (free cell at the jetty, account, token) and
  commits the transaction of A. If it dies in between, the `Handover` comes back; a thing or a figure that
  B already has is not written again.
- **The web process** follows the change stream of every region (entries as "region:ID"), writes commands and the
  session of a figure into the region where it stands (immediately after a crossing), and distributes new guests in turn over
  the start bays (`server/region-spaces.ts`). It writes settings and model choice into every region.
- **Moving a world from one Space** into the regions: `server/migrate-regions.ts` (every entry into the region of its
  room; `tests/migrate-regions.test.ts`: every figure exactly once, no coin lost).
- **Operation:** compose profile `big` (`npm --prefix spaces-mmo run docker:big:up`), [betrieb.en.md](betrieb.en.md),
  "Regionen".

Still open: `wer` shows only the own region; the daily counters of the translations apply per region; a command typed
during the crossing waits up to 3 s for the arrival.

## Design (before the build)

## Why

A Space is a process, and its core (core logic, commit, store) runs on one thread. The whole world is today one
Space: all commands of all figures go through this one thread, no matter how many world workers there are. The game uses more cores
only when the world consists of several Spaces, each with its own process (on the same or another
machine).

## Cut

- **One Space per region.** A region is an island group (`RoomDef.island` already exists): its rooms, exits,
  fog, fires, things, cells (`Spot`) and the figures currently there, with their tokens and commands. Almost every
  command stays within one region (steps, picking up, adding fuel, talking in the room).
- **One global Space** for what all regions share: accounts and characters as a record (where a figure currently
  is: `CharacterHome { charId, region }`), world clock and appointments, channels, market board and orders, prototypes, settings,
  `Process`. It is written rarely.
- The accounts store stays as it is.

## Handover between regions

phi-spaces has no transaction across two Spaces. A change (an exit, a ferry to another island group) is
therefore a handover in steps, each atomic and repeatable on its own:

1. In region A, in one transaction: take the figure (`Character`, token, cell), write a `Handover` entry
   (`{ charId, from: A, to: B, character: …, id }`), commit. The figure is now visible in no region.
2. In region B, with `unique` on `charId`: write the figure, its token, its cell at the arrival place. A second
   attempt after a crash fails on `unique` and is thereby done.
3. In the global Space set `CharacterHome` to B, then take the `Handover` entry in A.

A process that reads the `Handover` entries of A continues a stalled handover (steps 2 and 3 are
repeatable). What the figure carries moves with it (things with `location = charId` belong to the figure, not to the room).

## Processes

- **Space processes:** one per region and one for the global Space (`space-host.ts` already serves two stores
  on two sockets today; several are the same loop). Distributed over the cores of one machine or over several machines.
- **World workers:** per region (they take only the commands of their region), appointments and cleanup in the global Space.
- **Web:** follows the change stream of every region and the global one (today one); a connection receives the frames of the
  region of its figure. An `Intent` goes to the region where the figure currently is (`CharacterHome`).
- **NPCs:** per region, where they live; a wandering NPC changes like a figure.

## What it costs

- A command across the border costs three commits in two Spaces instead of one; that is rare (ferries, edges).
- The world map at the top left (atlas) and `wer` read all regions: from the web process's cache, not with a call
  per region.
- The engine needs the region for every read access (today `c.space`): most commands read only the figure's
  room, the region follows from that. Commands with global data (market, orders, channels) read the global Space.
- Tests: every test of a handover needs two Spaces; the existing tests continue to run with one region.

## Steps

1. Measure after the move to big: does one core suffice for the expected number of players (commands per second times CPU ms per
   command from `tests/perf/space-cost.ts`)?
2. If not: split off the global Space (accounts, clock, market, channels). That already relieves and needs no handover yet.
3. Then regions with handover, first two, with a test that sends a figure back and forth and survives a crash in every
   step.
