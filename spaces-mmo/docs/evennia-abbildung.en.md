# Evennia → phi-spaces

Model: [Evennia Components Overview](https://www.evennia.com/docs/latest/Components/Components-Overview.html).
Evennia keeps its world in a relational database (Django) and Python classes. In spaces-mmo the world is a set
of entries in a Space; behaviour lives in workers that take and write entries.

## Principles

- **One game object = one entry.** `id` is the object ID, `fields` are its attributes.
- **Typeclasses = entry types with subtypes.** Templates match via subtypes (`core.matches`: `e.types` contains
  `t.type`). A sword has the types `["Object", "Item", "Weapon", "Sword"]`; `readAll({ type: "Item", fields: {
  location: roomId } })` finds it together with all other items in the room.
- **Templates are equality per field.** Missing or `null` fields are wildcards, values are compared deeply,
  there are no ranges and no "contains" query on arrays. It follows that everything that is searched for is a
  scalar field of its own (`location`, `owner`, `zone`) or an entry of its own (tags, see below).
- **Change = take + write in one transaction.** An object is not "edited" but taken and written anew. This is also the locking
  concept: Whoever is currently changing an object holds it.
- **Only the world writes world state.** Browsers and agents write exclusively `Intent` entries. Enforced
  via `Policy` in `src/service.ts` (`RolePolicy.types`): role `player` may write only `Intent`; role `world`
  may write everything.

## Components in detail

### Basic components

| Evennia | phi-spaces | Remark |
| --- | --- | --- |
| Typeclasses | Entry type list + behaviour module per type in the world worker | A registry `typeclass → hooks` (`atGet`, `atDrop`, `atTraverse`, `atTick` …) |
| Objects | Entry `Object` with `name`, `desc`, `location` | `location` is an entry ID (room, character, container) |
| Rooms | Entry `["Object","Room"]` with `zone`, `grid` (tile map, phase 3) | No `location` |
| Exits | Entry `["Object","Exit"]` with `location` (start room), `destination`, `dir` | Passage = hook `atTraverse` |
| Characters | Entry `["Object","Character"]` with `account`, `location`, `x`, `y` | Player figure, also for NPCs |
| Accounts | Entry `Account{id, name, perms, guest}` (outside the game world), identity from the web login | Guests with a lease; registration converts the same account. Password hash only as `Credential` in the dedicated Space `accounts` |
| Sessions | Entry `Session` with a lease, held by the gateway, `renew` as long as the WebSocket is open | Disconnect → lease expires → character "sleeps" |
| Scripts | Worker + entries with a lease (`Script{target, kind, interval}`) | Time logic without threads of its own |
| Channels | Entry `Channel` + `ChannelMsg{channel, from, text}` with a lease | Like `ChatMessage` in codemode-chat |
| Msg / TempMsg | `Msg{to, text}` with a short lease; TempMsg = not written at all, directly from the gateway | Output to sessions |
| Attributes | `fields` of the entry | Large/rare data as an entry of its own `Attr{target, key, value}` |
| NAttributes (not persistent) | Memory in the world worker | Cache only, reconstructible from the Space after a restart |
| Nicks | Entry `Nick{account, from, to}` | Gateway replaces before writing the intent |
| Tags | Entry `Tag{target, key, category}` | Because templates cannot do "array contains"; search: `readAll({type:"Tag", fields:{key, category}})` |
| Aliases | Tag with `category: "alias"` | |
| Spawner / Prototypes | Entry `Prototype{key, parent, types, fields}` | Spawning = read prototype, resolve inheritance, write object |
| Help System | Entry `HelpEntry{key, category, text}` | Same principle as the help articles of help-site |
| Permissions | Field `perms` on the account + roles of the `Policy` | Builder/admin correspond to Evennia's hierarchy |
| Locks | Field `locks` (lock string as in Evennia, e.g. `get:perm(Builder) or holds(key_7)`) | Evaluated in the world worker before every hook |
| Portal / Server | Web process (gateway) / Space host + world worker | As in Evennia the portal survives a restart of the world |

### Commands

| Evennia | phi-spaces | Remark |
| --- | --- | --- |
| Commands | `Intent{actor, session, line, seq}` + command class in the world worker | `parse()` / `func()` as in Evennia |
| Command Sets | Command sets per character, room and carried object, merged on execution | Merge rules (union, replace, priority) as in Evennia; the source is the world state, no additional storage |
| Default Commands | `look`, `go`/directions, `get`, `drop`, `give`, `inventory`, `say`, `emote`, `help`, `who` | Phase 0/1 |
| Builder commands | `dig`, `open`, `create`, `spawn`, `set`, `tag`, `lock`, `destroy` | Only with `perm(Builder)` |
| Batch Processors | World files (JSON/TS) → `npm run world:load`; loaded in one transaction | Idempotent via fixed IDs |
| Inputfuncs | WebSocket messages `{t:"cmd"}`, `{t:"move"}`, `{t:"ping"}` | Graphics clicks become text commands (`move 4 7`) |
| Outputfuncs | Gateway frames `{t:"text"}`, `{t:"room"}`, `{t:"delta"}` | Text and map separate |

### Utilities

| Evennia | phi-spaces |
| --- | --- |
| EvMenu | Dialog entry `Menu{session, node, state}` with a lease; nodes as data |
| EvTable / EvForm / EvMore | Formatting in the world worker, paging in the client |
| EvEditor | Multi-line input field in the browser; result as one intent |
| FuncParser | Inline functions in descriptions (`$you()`, `$conj()`), evaluated before output |
| TickerHandler | One ticker worker; subscriptions as `Ticker{target, every}` |
| OnDemandHandler | Timestamp in the entry, state computed on reading (plants grow, fire burns down) |
| MonitorHandler / Signals | `changes(afterRev)` in the gateway and in the world worker; `notify` for individual patterns |

### Web

| Evennia | phi-spaces |
| --- | --- |
| Webclient | Next.js app: text log + command line + tile map |
| Web Admin | Admin area like help-site/codemode-chat (`AdminPanel.tsx`), plus dashboard (`npm run dashboard`) |
| REST API | Read-only HTTP endpoints of the web process (e.g. `/api/me`, `/api/system`) |

## Flow of a command

```
Browser   ──ws {t:"cmd", line:"get treibholz"}──▶  Gateway (Web-Prozess)
Gateway   ── write Intent{actor, session, line, seq} (Lease 30 s) ──▶  Space
Welt      ── take Intent  (txn) ─────────────────────────────────────▶  Space
Welt      cmdset zusammenführen → Befehl finden → parse → Locks prüfen
Welt      readAll Flotsam{location:raum} → Namensabgleich „treibholz“ im Worker → id
Welt      ── take {id}                                     (txn)
Welt      ── write Item{…, location: charakter}           (txn)
Welt      ── write Msg{to: raum, text:"$you() hebt Treibholz auf."} (txn)
Welt      ── commit
Gateway   changes() → Delta für alle Sessions im Raum → ws {t:"text"}, {t:"delta"}
```

If the `take` fails because someone was faster, the transaction aborts and the player gets "Zu spät –
jemand anderes war schneller." Duplicate items are ruled out without the world worker needing a lock
of its own.

`seq` per session keeps the order; several world workers may work in parallel as long as commands of the same
character run one after another (one `ActorLock` entry per character, like `RoomLock` in codemode-chat).

## Deliberate deviations from Evennia

- **No Python class inheritance in the database.** Types are data, behaviour is code in the world worker. A
  restart loads no class paths but reads type names.
- **No global object cache as truth.** The world worker may cache, but the truth is the Space. After a
  crash the state is the last commit.
- **Output is world state** (`Msg` entries) and not a function call to sessions. As a result agents,
  spectators and a newly connected device see the same history.

## Status of phase 1

Implemented in `server/engine/` (engine) and `worlds/leuchtfeuer/world.ts` (world). Where the implementation deviates
from the tables above:

- **Items** are entries of their typeclass type with the supertypes `Item` and `Object` (a coin: `Coin` <
  `Item` < `Object`); fields `itemId`, `name`, `aliases`, `desc`, `location` (room or figure), `x`/`y`, `glyph`,
  `locks`, `proto`. Figures keep `room` instead of `location`: A figure always stands in a room.
- **Exits** lie on a tile (`x`/`y`) and have an arrival point (`arrive`). Stepping on the tile
  or `go <name>` or just the name leads through. Instead of an `atTraverse` hook the world worker checks the lock
  `traverse`.
- **Hooks** (`atGet`, `atDrop` …) do not exist yet; behaviour lives in the commands, the typeclasses carry only the
  type chain. That comes as soon as a world needs behaviour of its own (phase 2: fire, tide).
- **Command sets:** Standard (priority 0), builder (1, with a `cmd` lock per command), one command per exit (10). Sets on
  carried objects come later.
- **Locks:** `all()`, `none()`, `perm(level)`, `id(figure)`, `holds(itemId|prototype)`, `guest()`, `not`, `and`, `or`,
  parentheses. Levels Guest < Player < Builder < Admin; an admin has all, `perm <name> = Builder` grants builder. A
  stored lock string that does not parse denies.
- **FuncParser:** `$you()` and `$conj(you-form|other-form)`; German verbs are irregular, therefore `$conj` names
  both forms. The gateway renders per recipient, also the history in the greeting.
- **Prototypes** are held in full in the world; `parent` inherits fields that a child leaves empty.
- **Loading the world:** under `Lock{name:"world"}` in one transaction. Missing parts are always written; rooms,
  exits, prototypes and help are replaced if the world has a newer `version` (or `--replace`). A
  placed item arises only on (re)loading and only if its `itemId` exists nowhere.
- **Item graphics:** Glyphs (circle, square, diamond) instead of sprites, because the item icons of Intersect assets
  are mostly CC BY-SA 3.0.
- **Order per figure:** Every figure has an `ActorToken`. A world worker takes it into the command's transaction,
  then the oldest job of this figure, and puts it back on commit. Commands of one figure thus run one after another and
  in the order sent, commands of different figures in parallel on several workers. If a worker dies, the
  token returns with its transaction. Tokens arise with the figure; for older figures each worker writes them
  on start (under the world lock).
- **Language:** Every command has an English key and German aliases (`get`/`nimm`, `dig`/`grabe`,
  `examine`/`untersuche` …); both always apply, without a toggle, and `help` shows all names. Items and exits
  also have English aliases (`driftwood`, `shell`, `east`). Output in the recipient's language (`names: {de, en}`,
  see [automaten.en.md](automaten.en.md#language-german-and-english)) follows later; until then the messages are German.
  Items already placed keep the aliases with which they were created.

## Status of phase 2

- **Scripts/TickerHandler** are, since the world time ([weltzeit.en.md](weltzeit.en.md)), `WorldSchedule{scheduleId, dueWorldMs, kind,
  payload}` entries: Every world worker looks; whoever takes a due appointment (in one transaction) runs the job and
  writes the next appointment in the same transaction. This way each job runs exactly once, no matter how many workers run. Jobs
  (kind `tick`): `fire` (notices extinguished fires), `fog` (one fog step), `flood` (flotsam), `storm`, `sweep`, `orders`, `market`.
  A new appointment is due only after its interval. (Before: `Ticker{key, due}` in real time.)
- **On demand instead of counting:** The burn duration is not counted down. The `Flame` entry says until which **world time** it
  burns (`until`); the clock decides whether it burns, and a paused world keeps its fire. Adding fuel takes the
  `Beacon` entry as a lock, takes fuel and old flame and writes a longer one (at most `fire.maxMs`). The
  fire appointment writes only the state `lit` and the message.
- **Fog** is a `Fog{room, level}` entry per room that a beacon covers (`covers`). Exits with `fogMax`
  are closed in denser fog; the world worker rejects the passage.
- **Flotsam** are items with `flotsam: true` and a lease (`flood.lifetimeMs`); whoever picks one up writes
  it anew without a lease, then it stays.
- **Channels:** instead of a `ChannelMsg` type of its own, a `Msg` with `to: "#hafen"`, which the gateway sends to everyone.
- **Reputation:** `Contribution{beaconId, charId, pieces, ms}` per figure and fire, counted up under the fire lock.
- **Script NPCs** (process `npc`, `server/npc/`): figures with an account of their own (`npc: true`), created by the loader. They hold
  a session and write only intents, one after another. Their names are blocked for registrations.
- **Game time:** The world has a clock (`WorldClock`, [weltzeit.en.md](weltzeit.en.md)): burn duration, fog step, tide, deadlines and
  the NPCs' timers run in world time; `SPACES_MMO_TIME_SCALE` is now only the initial rate of a new clock. Leases of the
  system (sessions, transactions, roles) remain real time.

### Collision

Two figures never stand on the same tile (`server/engine/occupancy.ts`). A tile is occupied only by figures that are
online; an offline figure is not on the map and blocks nobody.

- A figure that is online holds its tile as a `Spot` entry (`room`, `x`, `y`, `charId`, `name`). A step writes
  the new `Spot` with the Space's `unique` check on room and tile and removes the old one, both in the
  command's transaction. The Space rejects a second `Spot` on the same tile even if the first has only been written in
  an open transaction. Checking and entering are thus one step, also across several world workers
  (test: ten players walk onto one tile at the same time, exactly one arrives).
- There is no lock per room any more: steps in the same room run side by side, only two steps onto the same tile
  exclude each other. Until 2026-10-27 every step took the `RoomToken` of its room; all steps of a room ran
  one after another, and a step against an occupied tile lost the token (see [betrieb.en.md](betrieb.en.md#load-and-latency)).
- The `Spot` of a figure that went offline blocks nobody: Whoever steps onto the tile takes it over in their
  transaction. The world worker also clears such `Spot`s away every 30 s (`SPACES_MMO_SPOT_SWEEP_MS`).
- Beacons stand fixed where the world definition puts them; their tiles come from the world, not from the Space.
- `step` onto an occupied tile is rejected ("Dort steht schon …"). `move` finds a way around figures. An
  occupied arrival point of an exit leads to the nearest free tile, never onto an exit tile.
- New figures arise on a free tile. On connecting, the gateway sends `arrive`: If someone now stands
  on the figure's tile, it steps onto the next free one.

## Status of phase 4

- **Exchange without escrow:** An `Offer` names the offered items (they stay in the offerer's inventory) and
  the wishes (name and number). `accept` takes both sides in one transaction and writes them swapped; if anything is
  missing, everything aborts. An offer lives two minutes of real time.
- **Market with escrow:** On listing, the goods go to the place `market` (with `listing` and `seller`), the `Listing`
  has a world-time end (`expiresWorldMs`; the cleanup round `sweep` takes it). Buying takes listing, coins and goods in one transaction. A ticker (`market`) returns goods
  whose listing no longer exists; a listing that is currently held counts as alive.
- **Order board (master–worker):** The world writes `Order` entries (ticker `orders`), a player takes one via
  `take` and writes it back with `takenBy`; delivering consumes the things and creates the wages.
- **Crafting:** Recipes are in the world; a tool carries `wear` and breaks at 0. This is a count per
  use instead of on-demand time.
- **Guests** can neither exchange nor trade nor accept orders; they may view the list.
- **Operation:** Offers and orders are text commands; since phase 5 the page also has buttons for them (exchange, market board, orders in `client/App.tsx`).
