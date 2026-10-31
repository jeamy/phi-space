# The world grows: archipelago, inhabitants, trade

Status 2026-10-25, world version 9; extended up to world version 13 (2026-10-28), the world file is now at version 31 (`worlds/leuchtfeuer/world.ts`, tests in `tests/world.test.ts` and
`tests/economy.test.ts`).

## How worlds are extended

There are three ways. All write the same entries (`Room`, `Exit`, `Item`, `Beacon`, …); the engine knows no
difference.

1. **The world file** (`worlds/<world>/world.ts`): rooms, exits, prototypes, help, fires, NPCs, markets, recipes,
   orders. Whoever changes it raises `version`; the first world worker that sees a newer version replaces rooms, exits,
   prototypes and help on loading in one transaction under the world lock (`server/engine/loader.ts`).
   New NPCs and newly placed things are added; what players have picked up does not come back; an NPC figure
   that already exists stays where it stands.
2. **Building in the game**: Builders create rooms and things with `dig`, `open`, `create`, `spawn`, `set`, `lock`, `tag`, `destroy`
   (`server/engine/commands/builder.ts`). These rooms have no place on the overview map; the world file
   never touches them.
3. **Gods** (planned, [goetter.en.md](goetter.en.md)): model NPCs that design islands, orders and events by rules;
   a reviewer lets them go live.

## The archipelago

37 rooms of 24 × 16 cells each (14,208 cells) on eight islands (up to world version 12 it was 25 rooms on five):

| Island | Rooms | Special features |
| --- | --- | --- |
| Graue Insel | Graue Bucht, Klippenpfad, Fischerdorf, Torfmoor, Dünen, Salzwiesen, Klippenkopf, Anleger | Start; market and board at the Graue Bucht; ferries to all other islands |
| Möwenfels | Möwenstrand, Vogelklippen, Möwennest, Alte Warte | Shells; the northernmost fire |
| Kupferhafen | Kai, Markt, Werft, Speicher, Hafenviertel | the largest market; wood is scarce, pearls and nets bring a lot |
| Tangriff | Tangstrand, Riffdorf, Wrackbucht, Perlengrund | Kelp, amber, pearls; market and board in the Riffdorf |
| Nebelholm | Ufer, Moorwald, Steinkreis, Verlorener Hain | nobody tends the fire; whoever lights it clears the whole island |
| Schären | Schärenhafen, Robbenbank, Leuchtklippe, Seehundstrand | behind the Alte Warte; start bay with fire, market and board; shells |
| Rauchholm | Rauchhafen, Köhlerwald, Schwarzer Strand, Kraterhang | behind the Speicher of Kupferhafen; start bay; wood is plentiful here, amber on the black beach |
| Krabbensand | Krabbenbucht, Salzgarten, Watt, Muschelbank | behind the Perlengrund; start bay; Watt and Muschelbank with pearls |

- **Terrain from a generator** (`worlds/leuchtfeuer/islands.ts`): sea on the sides a room names, beach,
  grass or dune sand, a paved square, paved paths from every door to the centre (a path into the sea is a jetty).
  The same seed (the room ID) always yields the same ground; the generator supplies only data, no rules. The
  Graue Bucht and the Klippenpfad stay cell for cell as before; they only get new exits.
- **Exits**: Rooms of an island that lie next to each other on the overview are connected via `nord`/`ost`/`süd`/`west`
  (door in the middle of the side). **Ferries** connect the islands (exit at the jetty, named after the
  target island, e.g. `kupferhafen`; where only one leaves, also `fähre`). Fog of level 3 closes the ways, except the one to the light: the exit on the shortest path to the fire that keeps the room clear stays passable so that nobody gets stuck where no fire stands. The refusal says where that fire stands.
- **Fire**: one per island, each covers the rooms of its island (the first still only bay and path).
- **Tide**: Beaches wash up their own flotsam (kelp at the Torfmoor, amber in the Wrackbucht, pearls in the
  Perlengrund). **Storm surge** (`storm`, every 20 game minutes): six things at once on one beach, the harbour channel
  says where.
- **Fuels**: Driftwood (10 minutes), wood bundle (40), **train oil** (60 minutes; Marta sells it at the market of
  Kupferhafen, the keepers buy it, a storm rarely washes up a barrel, an order in Kupferhafen wants one for the
  Alte Warte).
- **Starting equipment with fixed IDs** (`npc-<id>-<proto>-<n>`): a new world version creates whatever of it no longer
  exists anywhere; this way a new thing in the world file also reaches an NPC that already exists.
- **New things and recipes**: Kelp → kelp rope; two kelp ropes + knife → net; amber + two shells + kelp rope +
  knife → amber necklace. Pearl and amber are finds.
- **Markets and boards** at the Graue Bucht, in Kupferhafen and in the Riffdorf; each board has its own offers
  and orders (orders apply per place, `kinds[].rooms`). One delivers one's own order at any board.

**World version 13 (2026-10-28):** three new island groups, each with a bay where newcomers can begin, with fire,
keeper (Arne, Frida, Thies), collectors (Wiebke, Okke, Imke), traders (Hauke, Bente, Momme), market and board. The Graue
Bucht gets a script keeper (Hinnerk): Ines is a model role and without a model adds no fuel; in the load test
the start bay therefore lay in fog ([lasttest-2026-10-28.en.md](lasttest-2026-10-28.en.md)). The loader writes rooms and
exits in transactions of twelve rooms each: a whole world in one exceeded `maxCommitBytes`.

**Later on 2026-10-28:**
- Two more model roles that are always there: Merle, cartographer at the market of Kupferhafen (knows ways,
  ferries, flotsam and prices), and Hark, an old captain in Schärenhafen. With Ines that makes three, one each in West,
  East and North; the Stranger joins when the fog becomes dense. Together 31 figures of the world.
- **Doors are passages:** on an exit cell and the cells next to it nobody holds a cell
  (`isPassage` in `server/engine/occupancy.ts`): one walks onto and through others, and whoever arrives lands on the
  arrival cell even if someone already stands there. Otherwise a crowd at a door blocked the way for the arrow keys.
- **More flotsam with more people:** for every three humans online on an island one more piece may lie on each of its beaches,
  and with every tide one more arrives (`flood.perPlayers`, default 3).

## The inhabitants

16 new script NPCs (`server/npc/economy.ts`), without model calls. They act only via the commands of a player
(`npc.act` → `Intent`); every exchange, purchase and every refuelling is thus the same transaction as with humans, nothing
is lost or doubled. A command counts as done when the world worker has completed its transaction
(reading the `ActorToken` waits for it), otherwise the script's next round would still see the old world.

| Role | Who | What |
| --- | --- | --- |
| `sammler` | Hanne, Henning, Jan | collects in his rooms what the tide brings and puts it up at his market |
| `huter` | Mats, Svea, Greta, Nele | keeps the fire of his island burning; collects or buys wood for it |
| `haendler` | Kalle, Ruben, Marta | travels between the markets of his route (Marta stays), buys cheap, sells dearer; on the way he stays three rounds where players are (again after an answer) so that he can be addressed |
| `handwerker` | Jorin, Piet | collects and buys ingredients, produces (and replaces his tool), sells the result |
| `plauderer` | Tilde, Lotte, Kaspar, Eske | walks around, tells stories and true things: prices, extinguished fires, good orders, also on the harbour channel |

- **Prices** per NPC and prototype (`prices: { proto: [buys up to, sells for] }`). Offers to an NPC it answers
  accordingly: what it receives is worth what it would pay; what it gives away costs what it demands; coins count
  one each. A gift it accepts. Otherwise it declines and says the most it gives.
- **On its own**: Traders, keepers and craftspeople offer those present coins for things they look for (per person and
  thing at most every ten game minutes). Whoever addresses an NPC learns what it buys and sells.
- **Starting equipment** (`carry`): coins, wood, a knife; once, when the world creates the figure. Coins otherwise arise
  only as wages from the boards.
- **Model roles** listen only to humans: NPC chatter does not wake Ines and costs no call (`fromId` of each
  message, NPCs begin with `npc-`).
- **Who plays**: `SPACES_MMO_NPCS` names the roles of an npc process (comma list; empty: all). The tests of the
  earlier phases play only Ines, Bo and the Stranger; `tests/economy.test.ts` plays the inhabitants themselves, one of them
  all at once with a coin balance.

## Overview map

At the top left above the map (`client/Atlas.tsx`): all rooms in their place, one cell one pixel, on it fog,
burning fires, humans (light dots) and NPCs (dark dots), ferries dashed, the own room outlined,
the island names. Tapping enlarges, "Karte" folds it in (remembered in the browser). The gateway sends the terrain
once per connection (`atlas`) and then the state at most once per second (`atlasState`).

## Still open

- Coins accumulate with collectors who never spend them; traders can run empty over time until players buy.
  A cycle (collectors deliver orders, buy tools) follows if this shows in operation.
- Model roles are four (Ines, Merle, Hark, the Stranger); more cost tokens and need approval.
- Ferries leave immediately; departure times and a crossing as a room of its own are possible but not built.
