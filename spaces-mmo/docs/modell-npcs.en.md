# Model NPCs (phase 5)

**NPC** stands for *non-player character*: a figure of the world that no human controls but a script or a language model
does (here Ines, the keeper of the beacon, Bo, the ferryman, and the Stranger in the fog). NPCs have a registered account (not a guest account)
and may do everything that signed-in players may do: speak, walk, pick up, put down, add fuel, hand on, exchange, buy and sell at the market, craft,
accept orders. They may not build or grant rights, any more than a player without building or admin rights.

Figures with a model (agent from `agent/`) behind them: a lighthouse keeper who asks for driftwood, a narrator
in the evening, a stranger in the fog. They play via the same text commands as humans (`Intent` entries) and are marked as AI
(`von: "npc"` in every view and in the display). They cost tokens and are off by default
(`SPACES_MMO_LLM=0`).

## Fixed roles

Which model NPCs exist is fixed by the world file (`worlds/<world>/npcs.ts`), not by chance:

```ts
{ id: "waerterin", name: "Ines", ort: "Graue Bucht", rolle: "Hütet das Leuchtfeuer, bittet um Treibholz, kennt jede Boje.",
  persona: "…", plan: { tag: "06-22" }, wecken: ["fire.low", "person.enters", "spoken"], budgetTag: 40 }
```

- **Durable identity:** name, place, role and a **summary** of what she has experienced
  (`NpcMemory` entry, ≤ 4 KiB, updated by the model after every conversation). After a restart she is the same
  Ines and remembers regulars.
- **Plan:** times when she is there (Ines 6 to 22 o'clock world time, afterwards "at home"; the narrator from evening; contract
  and implementation path see [weltzeit.en.md](weltzeit.en.md)). Whoever
  is not there is missing from the world, that is part of the story and costs nothing.

## Three states

| State | In the world | Model | Cost |
| --- | --- | --- | --- |
| **absent** | not there (plan, ferry gone) | no | none |
| **dozing** | stands at her place, script lines ("Ines flickt ein Netz.") | no | none |
| **awake** | speaks and acts | yes | tokens, counts towards `SPACES_MMO_NPC_MAX` |

She becomes **awake** when an event from her `wecken` list occurs, and falls asleep again after 5 minutes without being addressed and
without an event (the `NpcAwake` entry has a lease; when it expires she is dozing again). If
`SPACES_MMO_NPC_MAX` is reached, she waits for a free place and keeps dozing meanwhile (a line says: "Ines
ist in Gedanken.").

## Events that wake or bring wanderers

All events come from what the world writes anyway (`changes` of the Space, no polling):

| Event | Source | Who reacts |
| --- | --- | --- |
| `person.enters` | human enters the role's room | roles with a place in this room (keeper, rumour mill) |
| `spoken` | human addresses her or says her name | the one addressed |
| `fire.low` | fire level under 20 % in the room | keeper asks for driftwood; also counts as a reputation chance for players |
| `fire.out` | fire extinguished | keeper calls for help; wanderer "Verirrter Fischer" (lost fisherman) appears in the fog |
| `fog.dense` | fog level 3 in the room for longer than 2 minutes | wanderer "Fremder" (stranger) asks the way |
| `tide.storm` | big tide (much flotsam at once) | wanderer "Schiffbrüchiger" (castaway) lies on the beach and needs help |
| `ferry.arrives` | ferry docks (fixed schedule) | wanderer "Händler" (trader) offers goods |
| `market.stale` | offer at the market board without a buyer for longer than 30 minutes | trader makes a counter-offer |
| `newcomer` | a guest enters the world for the first time | narrator/keeper greets and explains in two sentences |
| `evening` | world time 20:00 | narrator begins a story if people are in the tavern |
| `creature.appears` | fog creature appears | keeper warns in the channel *hafen* |

**Wanderers** are roles of their own (`wanderer: true`) with a lifetime: They appear only through their event, at most
once per event and 30 minutes, stay until their concern is dealt with or 10 minutes without being addressed have passed
and then move on in the story ("Der Fremde verschwindet im Nebel"). A wanderer without anyone present does not
even become awake: If it appears when nobody is in the room, it stays mute and leaves after 2 minutes.

Waking is cheap because the script only counts events; only the first answer calls the model.

## Costs and limits

- `SPACES_MMO_LLM` (off/on), `SPACES_MMO_NPC_MAX` (simultaneously **awake** NPCs, default 10), daily quota per NPC
  (`budgetTag` in the role, model calls per world-time day) and a shared quota as in codemode-chat
  (`quota.ts`). All values in the admin's configuration window ([automaten.en.md](automaten.en.md#settings-for-operators)).
- **Only humans wake:** Messages carry the speaker's `fromId`; what NPCs say (including the inhabitants from
  [welt.en.md](welt.en.md)) wakes no model role and does not keep it in conversation.
- **Budget empty:** the NPC stays, is silent and shows a script line ("Ines brütet über dem Feuer.") until the
  next day. It does not disappear.
- Per awake NPC at most one model call at a time, at most 6 per minute; answers to the `Intent`s of several players
  are combined into one call.
- The model sees the same `sicht` (view) as an automaton (room, people, things heard), supplemented by its `NpcMemory`; it never sees
  accounts, passwords or data of other rooms.
- Own automata and the waiting time for code changes: [automaten.en.md](automaten.en.md#agents-as-owners-of-automata).

## Process

The process `npc` (`server/npc-host.ts`) holds a small state machine per role (absent/dozing/awake), writes
script lines and, only in the state *awake*, model answers as `Intent`s. It may write only `Intent`, `NpcMemory`, `NpcAwake` and
`NpcLog`. It can be started several times (the roles are distributed via a lease per role).

## Acceptance

- With `SPACES_MMO_LLM=0` all roles run as dozing script NPCs, no model call.
- With scripted models (filter out system messages before checking the last message, see
  `docs/examples.en.md`): `fire.low` wakes Ines, after 5 minutes without being addressed she falls asleep again, `NpcAwake` expires.
- `SPACES_MMO_NPC_MAX=1` and two wake events: exactly one role is awake, the other waits and gets its turn as soon as
  the first falls asleep. Sleeping and absent ones do not count.
- A wanderer appears only through its event, at most once per 30 minutes, and leaves after completion or after
  10 minutes without being addressed.
- Empty daily budget: no model call, script line instead of an answer, the next day it continues.
- Restart of the `npc` process: states and `NpcMemory` remain, no double start of a role with two processes.
- A live run with a real model only on explicit approval.

## Status

Implemented in `server/npc/minds.ts`, `server/npc/scripts.ts`, `server/npc-host.ts`, `server/llm.ts`; acceptance in
`tests/phase5.test.ts` with a scripted model (`tests/fake-llm.ts`). Deviations from the design above:

- **Roles in the world file:** in `worlds/leuchtfeuer/world.ts` (field `model` on the NPCs, `wanderer` for wanderers),
  not in a separate `npcs.ts`. Roles so far: Ines, Merle and Hark (keeper script with a model) and the Stranger (wanderer on `fog.dense`).
- **Plan (absent by time of day):** built since the world time (`NpcDef.plan`, Ines 6 to 22 o'clock); the Stranger comes only through
  his event. Contract and implementation in [weltzeit.en.md](weltzeit.en.md).
- **Events:** so far `fire.low`, `fire.out`, `spoken`, `person.enters`, `offer` (someone offers her an exchange), `fog.dense`. The npc processes read the Space for this
  every few game seconds (fire, fog, messages, those present) instead of following the change stream.
- **What a model may do:** every command of a signed-in player that has an effect (`say`, `emote`, `move`,
  `step`, `go`, `get`, `drop`, `put`, `give`, `offer`, `accept`, `decline`, `market`, `craft`, `order`); the model
  receives the help texts of the commands themselves (`server/npc/minds.ts`), so the list cannot deviate from the game.
  Commands that only show something (`look`, `inventory`, `who`, …) are missing: their answer would come after the model's, and what
  they show is already in the situation. At most four lines per answer, plus a `NOTE:` line for the memory
  (`NpcMemory`, at most 4 KiB, oldest notes drop out). The lines run like those of a player as an `Intent`
  through the world worker (reach, collision, locks, transaction); what fails, fails as for a player.
- **What a model sees (the situation):** memory, place, those present, fire level and position, its own position, what
  it carries, what lies in the room (with cells), the exits, exchange offers to it, at the market the market board, event and
  things heard; never accounts. If someone asks Ines to add wood, she does so if she carries wood, and otherwise says why
  not; if someone offers her wood, she accepts it.
- **Awake and roles:** `NpcAwake` (lease 5 game minutes, renewed on every address) and `NpcOwner` (lease per role,
  `SPACES_MMO_NPC_ROLE_LEASE_MS`) are written under `Lock{name:"npc"}`; this way never more than
  `SPACES_MMO_NPC_MAX` are awake and no role runs twice. A role taken over starts with a fresh script.
- **Budget empty:** a dozing line of the role ("Ines flickt ein Netz.") instead of the answer; full NPC_MAX: "ist in
  Gedanken."
- **Combining several players** into one call: Everything said since the last round goes into one
  call. At most one call per NPC at a time follows from the round; a limit of its own of 6 per minute does not exist
  (the shared minute limit applies).
- **Labelling:** Figures and messages of model roles carry `ai` and appear as "Name (KI)" or with a
  "KI" mark in the log.

## Durable dialogues

All model roles keep their conversation context across an NPC process restart by default.
`SPACES_MMO_DURABLE_NPCS=0` switches back to individual model calls; a list such as `ines,fremder` restricts
the durable dialogues to these roles. Non-model NPCs remain pure script roles.
`SPACES_MMO_LLM=1`, credentials and the admin's model approval remain required.

```sh
SPACES_MMO_LLM=1 node --experimental-strip-types spaces-mmo/server/npc-host.ts
```

The [connection](../server/npc/durable.ts) starts the separate agent process only for a selected
model NPC. The default path is `<SPACES_MMO_DATA or .local>/npc-agents/<world ID>/<region or world>.sqlite`.
`SPACES_MMO_DURABLE_STORE` overrides it. Each world/region thus gets a file of its own;
further NPC processes of the same world/region each need an explicitly different path.
A store belongs to exactly one worker. The distribution of roles remains the leased `NpcOwner` distribution in the
Space; the agent database is not a second role management and is not replicated across hosts.
It uses WAL/`synchronous=FULL` instead of the upstream default NORMAL.
[Sync policy and power-loss test limits](../../docs/agenten-stromausfalltest.en.md) are documented separately.

- A session is separated by world ID and NPC ID; other roles and worlds do not see its dialogue.
- Per answer at most one model attempt and 200 output tokens, without automatic SDK/harness retries or
  compaction calls. Approval and the existing NPC/UTC budgets are checked immediately before the actual model call,
  not only in a non-binding harness hook.
- The latest situation is authoritative. After a restart, on a new situation a still-open old turn is
  aborted instead of executing old game commands afterwards.
- The result goes through the same line/command check and then as an `Intent` to the world worker. The agent has
  no direct world, shell or file tools. Switching off the NPC process aborts its agent answer.
- `NpcMemory` and `NOTE:` remain the business summary in the Space. After 64 completed dialogue answers
  a new conversation begins with the current situation and this summary. This bounds the active
  context but deletes no earlier transcripts.

The existing quota logic counts **calls, not tokens or euros**. Conversation history raises the input tokens
and can therefore cost more even with the same number of calls. Transcripts contain player utterances; access,
retention and backup of the agent store are to be planned separately.
For this the compose NPC services mount `mmo-agent-data` under `/data` and use separate world/region files;
the dev container uses its existing `/data` volume. Own differing paths must additionally be mounted. No deployment
happens automatically.

[Offline regression check](../tests/durable-npcs.test.ts): reopening with dialogue history, isolation by
role/world, unchanged non-selected path, NPC budget, admin switch-off and no directly generated intents.
`SPACES_MMO_DURABLE_MODELS_MODULE` is intended exclusively for fixtures with `SPACES_MMO_TEST=1`.
