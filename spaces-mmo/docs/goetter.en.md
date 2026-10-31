# Gods: agents that extend the world (after phase 5)

A god is a model NPC ([modell-npcs.en.md](modell-npcs.en.md)) with a domain and the authority to build. It extends the running
world by rules; whether something goes live is decided by a **review**, not by an approval from the admin. The admin can
switch gods and individual authorities off and roll everything back.

## Who is a god

A fixed role in the world file (`worlds/<world>/goetter.ts`), like the other model NPCs, with its own memory
(`NpcMemory`), marker `von: "npc"` and in addition a **domain** and a list of **authorities**:

```ts
{ id: "nebel", name: "Die Nebelmutter", domaene: "Nebel, Inseln im Dunst, Wanderer",
  befugnisse: ["insel", "auftrag", "ereignis"], plan: { inselnTag: 1 }, budgetTag: 60 }
```

It has its own cmdset `GodCmdSet`: a subset of the builder commands (`engine/commands/builder.ts`) that act only on
drafts and zones of the god. Standard builder and admin commands remain blocked.

## What gods can create

| Authority | What arises | Stage |
| --- | --- | --- |
| `insel` | new island: rooms, exits, flotsam, fire pit; reachable only from a burning fire | 1 |
| `auftrag` | orders at the order board ("Bring three bundles of driftwood to the keeper") with a reward from the world's supply | 1 |
| `ereignis` | weather and world events: dense fog, storm surge, ferry, wanderer ([events](modell-npcs.en.md#events-that-wake-or-bring-wanderers)) | 1 |
| `geschichte` | texts: room descriptions, rumours, letters, names, chronicle of the world | 1 |
| `gegenstand` | new items and recipes (prototypes) with limited value | 2 |
| `wesen` | fog creatures and script NPCs with simple behaviour (no model, script only) | 2 |
| `markt` | offers and trader scripts at the market board | 2 |
| `welt` | **draft of a new world** (own world file); goes live only with the admin's approval, because it needs a process and a Space | 3 |

Not allowed, ever: changing engine rules, touching accounts, reputation and possessions of players, changing or deleting existing rooms or
items, commands outside the `GodCmdSet`, automata of others.

## When they create

- **On occasion:** Players put oil or flotsam into the fire as an offering, the god "hears" it and builds (the offering pays
  at the same time for the cost limit).
- **On its own:** by plan (`inselnTag` per god, scheduled [world time](weltzeit.en.md)) and on events, e.g. after `fire.out` an order,
  or when many players have progress and the goal "unexplored islands" falls below a threshold. For this it wakes
  like a model NPC and counts towards `SPACES_MMO_NPC_MAX`.
- **On demand instead of in stock:** An island is built only when players can reach it (or a free
  daily slot remains), not fifty in advance.

## How a god builds: generator instead of freehand

A god does not have to write `grid` strings. In the draft it supplies per room a **build instruction**:
size, biome (beach, rock, swamp, clearing …), position of the exits, special places (fire pit,
anchorage), plus the texts. A **generator** (script, not a model, in the same sandbox as the reviewer)
builds the `ground` string from it with **Wave Function Collapse** in the tiled model. Each domain owns a
versioned palette with explicitly defined tile weights and adjacency rules — these are not derived from
the autotile images. The Nebelmutter can therefore use a different palette than a fire god. A
stable hash and a fixed PRNG derive the seed from draft, room and attempt keys. The
build instruction acts as a *pre-seed*: exits, spawn, fire pit and anchorage are fixed cells whose
constraints are propagated over the whole grid before the first collapse.

Besides the finished `ground`, the draft also contains `algorithm`, `generatorVersion`, `palette` and `seed`. The grid
is checked and stored on publishing; a restart does not generate it again. This way rooms already
published remain unchanged even after changes to the generator. The exact separation between the authoritative
grid and an optional 3D representation is described in [architektur.en.md](architektur.en.md#3d-view-threejs).

This divides the work where it is reliable:

- **The model** supplies meaning: theme, names, descriptions, order hooks, where exits lead.
- **The generator** supplies form and guarantees local tile compatibility. It can still
  run into a contradiction or produce a locally valid but globally unplayable map. The model does not have to invent a complete
  24×16 string, which saves tokens and syntax errors.
- **The reviewer** remains the boundary (see below): It checks the finished draft exactly like a
  hand-written one (reachability, budget, texts). A contradiction or missing reachability leads, up to a
  fixed maximum number, to deterministic follow-up attempts. After that a checked fallback floor plan is used or
  the draft is rejected; the generator never runs indefinitely.

Hand-drawn rooms remain allowed (fixed places of the domain, special buildings); the generator is meant for
the terrain rooms that would otherwise all have to look alike. The model *can* also supply a
`grid` itself — the generator then fills in only the free areas.

## Review (instead of approval)

A god writes its work as a **draft** (`Draft` entry in the format of the world files). The reviewer (not a model, a
script, in the sandbox like the judge) lets it through only if all points hold:

- format valid, size under the maximum, all rooms reachable, at least one way back;
- no unknown commands, locks or types; names do not collide with existing ones;
- conservation check: the draft's items are not larger than the daily budget for new things (inflation limit);
- texts: length, no URLs, no names of real persons, language de/en complete (`names: {de, en}`);
- the work touches only its own zone (`zone: "gott:nebel:<id>"`), nothing existing.

If the draft passes, it is written live in **one** transaction; otherwise the god receives the error message and may
improve it up to 3 times, after which it is discarded for this occasion. The reviewer is part of the game and has
tests of its own; a god cannot bypass it because `GodCmdSet` may only write drafts.

## Undo and switch off

- Every work carries `zone` and `by` (god, draft, time). The admin can **remove** a zone in the configuration window
  (rooms, items and orders of the zone disappear, players in it are brought to the harbour, their belongings
  stay with them) or "roll back" a whole god.
- The admin can switch off **gods altogether**, **one god** or **one authority**; works already built remain,
  no new ones arise.

## Settings (configuration window, `.env` for the initial values)

| Field | Environment variable | Default |
| --- | --- | --- |
| Gods allowed (needs `SPACES_MMO_LLM=1`) | `SPACES_MMO_GODS` | off |
| New islands per day (all gods) | `SPACES_MMO_ISLANDS_PER_DAY` | 1 |
| Islands in total (from gods) | `SPACES_MMO_ISLANDS_MAX` | 20 |
| Size of an island (rooms) | `SPACES_MMO_ISLAND_ROOMS_MAX` | 12 |
| Orders from gods at the same time | `SPACES_MMO_GOD_QUESTS_MAX` | 10 |
| Drafts a god may submit per day (attempts count) | `SPACES_MMO_GOD_DRAFTS_PER_DAY` | 6 |

In addition the daily budget per god (`budgetTag`) and the shared model quotas. When a limit is reached, the
god waits until the next day and shows a script line.

## Acceptance

- A draft with an unreachable room, an unknown command, too many items or an intervention in a foreign
  zone is rejected; a valid one goes live in one transaction.
- The same seed, same palette and same generator version yield byte-identical `ground`; all adjacencies
  conform to the palette. Spawn, all exits and special places are mutually reachable by BFS.
- A restart does not regenerate a published room; a later generator update changes only new drafts.
- A scripted god cannot change or delete an existing room with the `GodCmdSet`.
- With `SPACES_MMO_GODS=0` or an authority switched off, nothing new arises; existing things remain.
- "Remove zone" deletes all entries of the zone and leaves players and their belongings intact.
- Daily limits (islands, drafts) hold even with many offerings; offerings without a free slot remain as an offering in the fire
  and count for the next day.
- Restart: running drafts are not lost and not written live twice (lease per draft).
- A live run with a real model only on explicit approval.
