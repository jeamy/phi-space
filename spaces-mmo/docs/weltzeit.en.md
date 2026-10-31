# World time

## Status

**All six steps of the [migration](#migration) are implemented** (2026-10-26). The clock determines when something is due:
fire, fog, tide, flotsam, orders, market offers and the NPC roles' own timers (waking hours, wanderer deadlines,
greeting blocks, chatter) run in world time, and a paused world stops them. `SPACES_MMO_TIME_SCALE` is now only the
initial value of the rate of a **new** clock (`rate = 1 / value`); `gameMs` no longer exists. Only the two points
of the section "Server time" are open (see the last lines of the table).

| Part | Status | Where |
| --- | --- | --- |
| `WorldClock` entry, computation, calendar, plans in world hours (pure) | done | `server/engine/worldtime.ts`, `model.ts` |
| Clock when the world is created (one per world, a restart keeps it) | done | `engine/loader.ts` under the world lock |
| Display: `worldTime` in `hello`, frame `time` on change and every 30 s, header line of the client | done | `gateway.ts`, `client/App.tsx` |
| Commands `time`/`zeit` (all), `clock`/`uhr` (admin: status, `pause`, `weiter`, `rate <n>`) | done | `engine/commands/clock.ts` |
| `WorldSchedule`, scheduler (`once`, `coalesce`; `replay-bounded` is rejected), fail-closed guard for the host time | done | `engine/schedule.ts`, `world-host.ts` |
| `evening`: one appointment per world (`WorldDef.evening`), one `WorldEvent` per world day and epoch (`evening:e1:d183`) | done | `engine/worldevents.ts`, `engine/loader.ts` |
| NPC plans (`NpcDef.plan`, also across midnight; Ines 6-22 o'clock) | done, differently than in the design (see below) | `npc-host.ts`, `engine/clockcache.ts` |
| Narrative daily budgets: the role's key carries epoch and world day (`npc:ines:e1:d183`); the limits per UTC day and minute remain | done | `engine/clockcache.ts` (`worldDayKey`), `llm.ts`, `npc/minds.ts` |
| Fire in world time (`Flame.until` in world milliseconds, without a lease; burns as long as `until > world time`; a fire in real-time form is deleted on loading) | done | `engine/fire.ts`, `engine/loader.ts` |
| The recurring jobs `fire`, `fog`, `flood`, `storm`, `orders`, `market` and `sweep` as `WorldSchedule` (kind `tick`, `payload: { job, everyMs }`); the real-time ticker (`engine/ticker.ts`) is removed | done | `engine/worldevents.ts` (`tickJobs`, `tickHandler`), `world-host.ts` |
| Deadlines as `expiresWorldMs` (flotsam, orders, market offers); `sweep` (every 10 world seconds) removes what has expired; `get` deletes the deadline | done | `engine/sweep.ts`, `engine/commands/default.ts`, `trade.ts` |
| Gateway: `ObjView.until` stays real time of the browser (computed from world time, resent on a clock change), burn duration in world minutes | done | `gateway.ts`, `fire.ts` (`burnText`) |
| `WorldClockOwner` lease and stored diagnostic state of the host time (section "Server time") | open (every world worker schedules; the protection against double processing is the transaction at the appointment) | |
| NPC roles: own timers in world time (`Npc.now()`: waking time `NpcAwake.untilWorldMs` without a lease, the block after a visit `NpcVisit.untilWorldMs`, greeting blocks, gossip, chatter, stay of wanderers); the rhythm of a round follows the clock's rate (`Npc.pace`), the rounds also run in a paused world (the roles keep listening); `sweep` clears expired `NpcAwake` | done | `npc/scripts.ts`, `npc/economy.ts`, `npc/minds.ts`, `npc-host.ts`, `engine/clockcache.ts` |
| `SPACES_MMO_TIME_SCALE` only the initial value of the rate (step 6); `gameMs` removed | done | `engine/time.ts`, `engine/loader.ts` |

**Deviation in the NPC plan:** The design has the NPC process generate appointments from the plan boundaries. Implemented instead
is a reconciliation before every round of the role: The figure is there if `presentAt(plan, world time)` says so, otherwise it leaves (with
"geht nach Hause.") and its script does not run. The world time comes from a cache of the clock (read every 15 s,
computed in between). This covers restart and takeover of the role by itself and needs no appointment, because showing and
hiding depends on the role's process (only it holds its session); appointments remain for events that a world worker
triggers. The plan does not apply to wanderers.

**Catching up:** `once` sets the next appointment from the missed one, `coalesce` from now (one event for all missed
days). The guard (`ClockGuard`, tolerance `SPACES_MMO_CLOCK_TOLERANCE_MS`, default 5 minutes) stops all new world-time events for ten seconds
on a host time that jumps back or forward too far, and reports this in the log
(`clock alarm`); events already triggered remain.

**When step 5 was introduced:** A fire that previously ran as a real-time entry with a lease is deleted when the world is loaded
(its `until` would lie decades ahead in world time); the keepers add fuel. Flotsam, orders and offers from before
expire with their lease (they have no `expiresWorldMs`). Everything is converted in one step: There is no longer a
real-time ticker that could trigger the same job twice.

**Note on the rate:** Durations in the world definition (fuel, fog step, tides, lifetime of flotsam) and the timers of the
NPC roles are world milliseconds without conversion. With `SPACES_MMO_TIME_SCALE=0.002` (rate 500) a new world creates its clock
accelerated; an existing world keeps its stored rate, and `clock rate <n>` changes it for everything at once
(also the rhythm of the roles). The cache of the clock in the role processes (15 s) lets a change take effect there
after this time at the latest.

Tests: `tests/weltzeit.test.ts`, `tests/weltzeit-budget.test.ts` (the key changes at the world-day boundary, the real limits keep counting) (computation, pause and rate without a jump, calendar, plans 6-22 and 20-2 at all four boundaries,
browser interpolation, the clock in the game with admin commands, appointments, the guard, a paused world stops fire, fog and tides, the cleanup round). The implementation status in
[modell-npcs.en.md](modell-npcs.en.md#status) remains authoritative for the NPCs.

This document fixes the contract for a real world time. It enables in particular NPC plans such as "Ines is
there from 6 to 22 o'clock", the event `evening`, works of the gods scheduled by world time, and narrative daily budgets.

## Goals and limits

- World time is reproducible after restarts and by default keeps running during a server outage.
- It can be paused and accelerated without business appointments having to be rewritten.
- Several world workers together trigger a due appointment exactly once.
- Server and client show the same world hour; decisions are made exclusively by the server.
- The world has its own calendar without time zone, daylight saving time or leap seconds.
- Sessions, transactions, role leases, network and model timeouts remain **real time**. A paused world must
  neither hold locks nor keep a failed process artificially alive.

Not part of this contract are an astronomical simulation, different time zones per island or arbitrary
rewinding of the world. Time running backwards would make already triggered events and budget keys
ambiguous and is therefore forbidden.

## Kinds of time

| Kind of time | Examples | Basis |
| --- | --- | --- |
| World time | time of day, NPC plans, fire, fog, tide, world stories | persisted `WorldClock` |
| Operational real time | sessions, transactions, `NpcOwner`, health checks | lease of the Space / server time |
| External real time | model timeout, shared cost limit per UTC day and minute | server time |

An NPC may thus stay awake longer because of a paused world, but its process role must still be renewed as a short
real-time lease. The global LLM cost limit remains a hard UTC real-time protection; in addition
a role can have a narrative quota per **world day**.

## Persisted clock model

In the world Space there is exactly one entry per world:

```ts
type WorldClockFields = {
  worldId: string;
  epoch: number;
  realAnchorMs: number;
  worldAnchorMs: number;
  rate: number;
  paused: boolean;
  version: number;
};
```

- `realAnchorMs` is a Unix timestamp from `Date.now()` at the last clock change.
- `worldAnchorMs` is the world time at the same moment, measured from world day 0, 00:00.
- `rate` gives world milliseconds per real millisecond. `1` means real time, `60` lets a world minute pass in one
  real second.
- `epoch` separates timelines after an explicitly incompatible administrative reinitialisation.
- `version` versions computation and calendar format, not the running day.

World time is derived and not counted up every second:

```ts
function worldNow(clock: WorldClockFields, realNow = Date.now()): number {
  if (clock.paused) return clock.worldAnchorMs;
  return clock.worldAnchorMs + (realNow - clock.realAnchorMs) * clock.rate;
}
```

When pausing, resuming or changing `rate`, an admin command takes the `WorldClock` entry in one
transaction, first materialises `worldNow`, sets both anchors to the current state and then writes rate and
pause state. This way there is no jump. `rate` must be finite and greater than zero; pause is represented exclusively
via `paused`.

### Relation to `SPACES_MMO_TIME_SCALE`

The existing value describes real duration per game duration: `0.002` lets a game hour pass in 7.2 real seconds.
When a clock is first created, `rate = 1 / SPACES_MMO_TIME_SCALE` is therefore used. After that the rate stored in
the `WorldClock` is authoritative; a restart with a different environment value does not change
an existing world.

## Calendar

The calendar uses days of equal length of 24 hours each:

```ts
const WORLD_DAY_MS = 24 * 60 * 60 * 1000;
const WORLD_HOUR_MS = 60 * 60 * 1000;

const day = Math.floor(worldMs / WORLD_DAY_MS);
const millisOfDay = worldMs % WORLD_DAY_MS;
const hour = Math.floor(millisOfDay / WORLD_HOUR_MS);
```

There is no tie to the host's local time zone. The world definition fixes only the initial world hour of a
new world, for example world day 0 at 08:00. Displays may derive names for weekdays or seasons from it;
persistence and comparisons continue to use the number `worldMs`.

## Appointments and expiry

Appointments that depend on world time must not be stored only as a phi-spaces lease: A real-time lease cannot represent
a pause or a later speed change. The business truth is therefore an entry of its own:

```ts
type WorldScheduleFields = {
  scheduleId: string;
  clockEpoch: number;
  dueWorldMs: number;
  kind: string;
  payload: Record<string, unknown>;
  missed: "once" | "coalesce" | "replay-bounded";
};
```

The world-time scheduler reads clock and appointments. For each due entry it opens a transaction and takes the
`WorldSchedule` entry. Only the worker that succeeds performs the state change and, where applicable, writes the
next appointment in the same transaction. Deterministic business keys such as `evening:tag-183` prevent
duplicates even after lost replies.

Recurring appointments are computed onward from the previous due time so that slow execution does not drift.
The catch-up rule is on the appointment:

- `once`: a one-off appointment is caught up at the next start.
- `coalesce`: any number of missed periods yield at most one current event; then the next
  future period follows. This is the default for tide, fog and daily events.
- `replay-bounded`: at most a fixed small number is caught up; only for business-necessary simulation.

A real-time lease or a timer may wake the scheduler efficiently at the expected real time. Before
execution it must always check again `dueWorldMs <= worldNow(clock)`.

## Restart and outage

`WorldClock` and `WorldSchedule` are by default in `world.sqlite` like the rest of the world. Only
`SPACES_MMO_MEM=1` makes them volatile. On a restart nothing is reconstructed from process memory:

1. The worker reads the persisted clock.
2. `worldNow` includes the real time that has passed since the last run.
3. The scheduler processes due appointments according to their catch-up rule.
4. A paused clock stays paused across the restart.

The planned behaviour is thus: The world keeps running during an unplanned outage. If maintenance is to
stop the world, the operator pauses it explicitly before shutting down.

## Server time and multiple hosts

`Date.now()` is only the carrier of the progression, not the business world time. The hosts must synchronise their
operating-system clocks via NTP/chrony. spaces-mmo must not silently accept a suspicious clock:

- The scheduler stores its last accepted real and world time state as diagnostic state.
- A backward jump of the system time or a deviation above a configured tolerance stops new
  world-time events fail-closed and raises an operational alarm.
- Events already triggered are never taken back.
- Only the holder of a short real-time lease `WorldClockOwner` schedules actively; the transaction at the appointment still remains
  the protection against double processing on takeover or lease expiry.

The first implementation may run on one host but must keep the same checks and the exactly-once contract
so that a later distribution does not change the time model.

## Use

### NPC plans

A role receives a plan in world hours:

```ts
plan: { presentFromHour: 6, presentUntilHour: 22 }
```

The NPC process generates appointments from the next boundaries. At the appointment the figure is shown or
hidden server-side. A restart or takeover of the role additionally checks the current plan directly, so that a
missed display appointment leaves no wrong presence. Plans running past midnight, for example 20 to 2 o'clock,
are explicitly supported.

`evening` is a deterministic event per world day. It is generated only if the world definition uses it;
whether the narrator actually speaks still depends on players present and its model limits.

### Fire, fog, tide and market

- Fire will store `untilWorldMs`; the existing real-time lease is at most a cache or
  wake-up aid. The check against world time decides whether it burns.
- Fog and tide use `WorldSchedule` instead of a `Ticker.due` computed finally in real time.
- Items with a world-time lifetime store `expiresWorldMs`. On picking up, this deadline is removed as it is today.
- Direct exchange offers and other interactions between humans currently present may deliberately stay real time;
  this decision is documented per entry type.

### Model budgets

The key for the narrative role budget contains `clockEpoch` and `worldDay`, for example
`npc:ines:e2:d183`. The global operator limit per UTC day and minute remains in addition and cannot be reset by a high
world rate or administrative time jumps.

### Gateway and client

The `hello` frame contains a clock view:

```ts
worldTime: {
  epoch: number;
  worldMs: number;
  rate: number;
  paused: boolean;
  serverNowMs: number;
}
```

The browser may interpolate the display between frames from it. On visibility, reconnect and regular
server update it resynchronises. No client decides on presence, expiry or events based on its interpolated clock.

## Migration

1. Introduce `WorldClock` and pure computation functions; the existing world initialises with the configured
   start hour and `rate = 1 / timeScale`.
2. Show the clock in the gateway and add admin commands for status, pause, resume and rate.
3. Switch NPC plans and `evening` to `WorldSchedule`.
4. Add narrative NPC daily budgets without replacing the real cost limits.
5. Migrate fire, fog, tide and further business game durations to world deadlines.
6. Only when no business timer depends directly on `gameMs()` any more is `SPACES_MMO_TIME_SCALE` downgraded to a pure
   initial value.

During a migration the same mechanism must not be triggered simultaneously by the old real-time ticker and the new
world-time scheduler. The world version switches each type atomically to exactly one owner.

## Acceptance

- Equal clock data and equal server time yield byte-identical the same world time and calendar decomposition.
- Pause stops world time and business appointments while sessions and role leases keep expiring.
- Rate changes cause no jump; existing world appointments keep their business due time.
- A restart preserves clock, pause, rate and appointments. The chosen catch-up rule is observed.
- Two world workers trigger the same due appointment exactly once; a process abort before commit lets it come back.
- A plan 6-22 and a plan 20-2 behave correctly at all four boundaries.
- `evening` arises at most once per `clockEpoch` and world day.
- World budgets change at the world-day boundary; real minute and UTC daily limits remain unaffected.
- Host time running backwards or jumping implausibly stops the scheduler and raises an alarm.
- Client display and server decision agree after reconnect and rate change.
