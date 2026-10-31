# Game world: Leuchtfeuer

The first world on the spaces-mmo engine (`spaces-mmo/worlds/leuchtfeuer/`).

## Core idea

An archipelago of small islands, permanently in fog. Where a beacon burns, the fog is light: there one can
sail, trade and build safely. Where it goes out, the fog advances, paths disappear and fog creatures appear.
No player can keep a fire burning permanently alone; the world lives on many people (and agents) working
for each other.

Players are beachcombers, boat people, traders or keepers. There are no fixed classes; the role
emerges from what one does.

## Why this idea

The game mechanics *are* the Space semantics. The game thereby shows phi-spaces instead of merely using it:

| Game mechanic | Space operation | What this guarantees |
| --- | --- | --- |
| Picking up flotsam | `take` on a `Flotsam` entry | Exactly one gets it, even if ten type "get" at the same time |
| The tide washes flotsam away | The entry's lease expires | No cleanup job; the Space removes it itself |
| Refilling a beacon | `renew` on the lease of the `Beacon` fuel entry | Goes out by itself if nobody adds fuel |
| Trade between two players | `take` of both goods + `write` of both results in **one** transaction | No duplication, no half trade |
| Order board (building orders) | Master worker: `Order` entries, workers `take` them | Load spreads across everyone who feels like it |
| Fog creatures appear | World worker reacts to `changes` when a fire goes out | Event-driven, no polling over the whole world |
| Spell/buff "lantern" | Entry with a 10-minute lease | Expiry = the effect ends |

## Game loop

1. **Salvaging:** The tide (world tick, about every 30 s per beach section) writes `Flotsam` entries with a short lease
   (2-5 min). Driftwood, kelp, shells, rarely finds with a story.
2. **Processing:** Raw materials become fuel, boat parts and tools (recipes as prototypes).
3. **Keeping the fire:** Putting fuel into a beacon extends its lease. Every fire publicly shows who
   contributed how much (reputation).
4. **Exploring:** Only from a burning fire can new islands in the fog be reached. New islands = new
   rooms, later from builders or generated.
5. **Trading:** Market (offers as entries) and direct exchange. The market board is a Space pattern without
   special logic.

The conflict of aims that carries the game: burn fuel yourself (for your own boat, your own hut) or put it into the
shared fire.

## Agents as fellow players

Because every action is a text command that goes into the Space as an `Intent` entry, agents from `agent/` can use exactly
the same interface as humans:

- **Script NPCs** (no model): ferryman, trader, lighthouse keeper with fixed routines. Run as workers.
- **Model NPCs** (cost tokens, only with explicit approval, quotas as in codemode-chat
  `quota.ts`/`limits.ts`): narrator, rumour mill, keepers who ask for fuel.
- **Automata** (late phase): players write small programs ("buoys", "collector robots") that run in the
  pi-codemode sandbox, like the contributions in codemode-chat. An automaton has a command budget per minute.

## Framework

- Low on rounds, not twitchy: movement on a grid, world ticks at about 1 Hz. A Space round trip is not a
  60 Hz game-loop beat.
- Low on violence at the core; fog creatures are an obstacle, not an opponent, in most zones. **Combat is optional:** a
  module that can be switched off, which applies only in specially marked fog zones, turn-based and only against fog creatures (see
  [phasen.en.md](phasen.en.md#module-k--combat-optional)).
- Guests can play immediately; whoever registers keeps everything achieved as a guest (character, reputation,
  automata). Trading and handing things on is possible only with an account.
