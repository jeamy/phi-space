# Several worlds under one federation: plan

Status 2026-11-08: **plan**; step 0 (the transfer helper) is built. Nothing of steps 1 to 5 exists yet.

## Why worlds, and not a transaction across Spaces

phi-spaces has no transaction across two Spaces ([welt-aufteilen.en.md](welt-aufteilen.en.md), "Übergabe zwischen
Regionen"), and the federation does not add one: a transaction is bound to one member before it begins, a deviating
rule ends in `RoutingConflict` ([federation plan v3](../../docs/federation-plan-v3.en.md), 7.1 and 7.4: "no txns across
members"). A transaction across Spaces would need a two-phase commit between Space processes on different machines,
locks held across the network, transactions left in doubt after a crash that the primary/sync replication, promotion
and fencing would have to resolve, and all of it twice, in TypeScript and in Rust. It would also couple again what the
regions were split for: every region Space commits alone and in parallel (load test of 2026-11-08,
[lasttest-2026-11-08.en.md](lasttest-2026-11-08.en.md): four region Spaces carry 100 figures without one being the
bottleneck).

What touches two Spaces therefore stays a way in steps, each atomic and repeatable. Worlds are the natural unit to
spread over machines: two worlds hardly ever need one change together, so they need no such way except for what
deliberately crosses them (a figure travelling, a shared account).

## Step 0: the transfer helper (built)

`server/engine/transfer.ts` is the one shape every way out of a region has:

1. In region A, inside the transaction of the command that starts it, an order of its own entry type is written and
   what it carries is put where only the order names it.
2. A world worker of A takes the order in a transaction of A (`carryOut`, `carryOne`) and runs the order's steps
   against region B (`Carrier.carry`). Things go over by `moveThings`: in steps of `THINGS_PER_STEP` (a commit carries at
   most 192 KiB), each step one call to each Space, written in B first, then taken in A; what a boat's hatch or a bill
   holds goes before its holder; with `anywhere` a thing already anywhere in B (taken out of a chest since) is not
   written again.
3. A commits: the order is gone. A worker that dies before lets A's transaction lapse; the order is back and the next
   try finishes it.

A kind of order is a `Carrier`: its entry type, the region it goes to, its steps. There are two: `handovers`
(`handover.ts`, a character crossing: pack, arrival, old token) and `couriers` (`courier.ts`, things into one's chest in
another region, or the estate where the chest stood). Their entry types and fields are unchanged, so orders already on
their way when a new version starts are finished by it. Couriers now also take what a boat or a bill holds along, and
go in steps like the pack. Evidence: `tests/transfer.test.ts` (more than a step's worth, a try that died after writing,
`anywhere`, holders, an order whose steps fail is back), and the suites that cross regions (`regions`, `pack`, `beam`,
`room-growth`, `regions-live`, `migrate-regions`, `chat`).

A new way between regions is now a `Carrier` and a line in the world worker. The first candidate is the market selling
from a chest in another region (today refused, `chestForSale` in `commands/build.ts`): that order goes the other way
(the things are in B, the board in A), so it needs an order written into B that B's worker carries to A's board; the
command in A cannot hold B's chest in its transaction. That is a `Carrier` of B plus a reply to the seller; it is not
built.

## Today: one world, run by hand

- The world Leuchtfeuer is four region Spaces on big (Rust space server), a world worker, NPC and model process per
  region, and one web process; the accounts Space is on nano, reached through the tunnel `mmo-accounts-tunnel`
  ([betrieb.en.md](betrieb.en.md)).
- Where a region runs is in `.env` and compose files: `SPACES_MMO_REGIONS`, `SPACES_MMO_WEB_REGIONS`,
  `docker/docker-compose*.yml`. A deploy is `git pull` and `docker:big:rust:up`; a host that fails is a repair by hand
  from the volume backups.
- The arena (`server/arena.ts`) starts worlds of its own for the bots of codemode-chat: in memory, one Space process and
  one world worker each, gone when closed. They are throwaway by design.

## Target: worlds as entries of the control Space

A federation host (`src/runtime.ts`) runs on each machine; one of them holds the control Space. What the operations
extension of phi-spaces already provides ([implementation status](../../docs/implementierungsstand.en.md), B2 to B10), and
what each part would do here:

| Building block | In phi-spaces | For the worlds |
|---|---|---|
| Space lifecycle (`space-lifecycle.ts`) | create, archive, reactivate, delete named Spaces by signed host instructions | a world's region Spaces are created on their host, archived when the world closes |
| Deployment (`deployment.ts`, `npm run bootstrap`) | a declarative config, planned without effect, applied idempotently | one config lists the worlds: their regions, the host of each, the world definition |
| Workers (`workers.ts`) | desired worker state per host, signed, reconciled by the host's supervisor | world worker, NPCs and model process per region as worker kinds |
| Runs (`run-controller.ts`, `run-member.ts`) | start, pause, resume, stop through the core's RunGate | a world paused for maintenance, stopped at its end |
| Replication (`primary-sync.ts`, `replica-control.ts`, `container-fencing.ts`) | primary/sync per Space, promotion behind fencing, `degradeToSingle` | a standby for each region Space of the main world on a second machine |
| Recovery (`recovery.ts`, `restore.ts`) | restore a data Space onto another host | a region back after the loss of its host |
| Gate, identity, grants (`gate.ts`, `auth.ts`, `grants.ts`) | NetBird peers, key proof, short-lived grants | web processes and workers reach the region Spaces with a grant, not an open port |
| Alerts, audit, dashboard (`alerts.ts`, `dashboard.ts`) | derived alerts, admin audit, live view | one view of all worlds |

What a world adds on top, in spaces-mmo:

- **A world id.** A world is `{ worldId, definition, regions: { regionId → Space alias, host } }`. The world definition
  is a `worlds/<id>/world.json` as today; two worlds may share one (two copies of Leuchtfeuer) or have their own.
- **The accounts Space stays one, shared by all worlds.** An account has figures; a figure belongs to one world at a
  time (the home of a figure gains a world besides its region).
- **Travelling between worlds** is a `Carrier` like the crossing between regions: the figure and its pack leave a region
  of world A and arrive in a region of world B, and the accounts Space names the new home. What may cross (coins, things
  of one world in another) is a rule of the worlds, not of the helper.
- **The web process** follows the regions of every world it serves; a connection gets the frames of the world its figure
  is in. One web for all worlds, or one per world behind the same nginx, is open (below).

## Steps

1. **A second, persistent world on the local federation test bed.** `npm run testbed:federation` already runs a control
   host, the TLS register and Members in containers on this machine (`test/testbed/local-federation/`). A test world
   ("staging", a copy of Leuchtfeuer) is declared in a deployment config, its region Spaces created by the lifecycle,
   its world workers started as worker kinds, played by `tests/perf/live-load.ts` and `npm --prefix spaces-mmo run
   test:play`. This shows what is missing (below) without touching big.
2. **Worker kinds for processes.** Today a host's `WorkerSupervisor` runs workers as asynchronous loops inside the
   daemon process ("no CPU parallelism", implementation status B6). The world worker, NPC and model processes of a region
   are processes of their own (and containers on the servers). Either a worker kind that supervises a process or a
   container (start, stop, restart with backoff, its health back as `metrics.workers`), or the region's processes stay
   in compose and the control Space only records and checks them. To decide after step 1.
3. **Staging on the servers.** The staging world on big under a control host there, next to the main world, which stays
   as it is. NetBird and pairing are prerequisites the deployment plan shows as `blocked` until done (B8).
4. **The main world under the control Space.** Leuchtfeuer's four regions are taken over: their Spaces are registered
   with their existing stores (no copy), compose stops holding the addresses. Replication follows: a standby per region
   on a second machine, promotion behind the container fencing adapter, as `npm run testbed:federation -- replica`
   already exercises.
5. **Travelling between worlds**, once there are two worlds players use: the `Carrier`, the world in a figure's home,
   the web process across worlds.

## What is missing

- Worker kinds for processes or containers (step 2).
- Registering an existing Space with its store as part of a federation host, instead of creating it (step 4).
- The world id in the home of a figure, in the gateway and in the web process's choice of regions.
- The order that sells from a chest in another region (step 0, above), and the order of a journey between worlds.
- NetBird on nano and big for the game's processes, and the pairing of their hosts.

## Open questions

- One web process for all worlds or one per world?
- Is a figure bound to its world, or may it travel, and what does it take along (coins, things, buildings stay)?
- Who may create a world: only the admin, or a player too (a world of one's own, like the arena's)?
- Do the arena's throwaway worlds belong under the control Space at all? They live in memory for minutes; the lifecycle
  and replication give them little. They are left out of step 1.
