# Settling, building and gardening (draft)

Status 2026-10-28, revised 2026-10-29 (logic errors and gaps of the first version), implementation status 2026-10-31.
Built are the chat between players, step 1 (hut and building site), step 2 (beds, seeds, watering, harvest, sponsorship;
ornamental and communal beds, crossing and naming, the gardener; hares, fence and scarecrow), step 3 (fields, windmill
and bakery, animals, deer, foxes and mice with their guardians), step 4 (epochs, settlement) and, from step 5, the
storehouse, the quarry and the workshop, plus the settlers (see "Order"); everything else is a proposal for how
Leuchtfeuer grows beyond gathering, fire and trade:
gardens, houses, workshops, roads, churches, department stores, later a railway. It builds on [spielidee.en.md](spielidee.en.md),
[welt.en.md](welt.en.md), [goetter.en.md](goetter.en.md) and [automaten.en.md](automaten.en.md).

**Proposal: a shared build-up simulation.** Closest are Settlers- and Anno-style goods chains that many people operate
together. From Civilization only the **epochs** are taken, as progress of the whole world, not of one player: when enough
has been built and maintained, the world unlocks the next level. From Age of Empires nothing is taken except the feeling
that work visibly changes the map.

The conflict of goals stays the same: what one gathers can go into one's own house or into what belongs to everyone
(fire, road, church).

Two **equal** paths carry the build-up: **buildings**, which stay and need many hands, and **gardens**, which grow and
demand daily care. Both count equally towards the progress of an island: a settlement reaches village and town from
gardens just as from houses, and the most beautiful places of the archipelago are more gardens than showpiece
buildings. The one is the large shared work, the other the quiet permanent rhythm that keeps the world alive even with
two or three players.

## Chat between players (first, built)

Building together means agreeing, also across islands and with someone who is standing elsewhere right now. `say` is
heard only by the room, a channel (`channel hafen`) by all. What was missing was the conversation between two and in a
small group. It therefore came **before** everything else (order, step 0). Built since 2026-10-29: `server/chat.ts`,
`client/chatcrypto.ts`, `client/useChat.ts`, `client/ChatPanel.tsx`, test `tests/chat.test.ts`.

**Between two**

- Command `chat <name> <text>` (also `tell`, `flüstere`). `chat <name>` without text only opens the conversation.
- On the map, the right mouse button (on the phone a long tap) over a figure opens a menu: **Chat with …** and **Invite
  … to "group"** (per group one is in), plus Look and Offer trade. NPCs have no chat entry.
- The page shows every conversation as a tab of its own next to the log, with a counter for unread ones (what has been
  read is remembered by the browser). The tab "Chats" is the overview: encryption, invitations, groups, new
  conversation, ignored. A closed tab comes back with the next message.
- A conversation works across regions. If the other is not online, the message stays (lease seven days, the last 50 of a
  conversation per reader) and appears at the next login; every page gets the history.

**In the group**

- `gruppe neu <name>` founds a group; whoever founds it manages it (at most ten per account).
- `gruppe lade <spieler> in <name>` (or the map menu) writes an invitation with a lease (one world day; any member may
  invite). The invitee sees it in the log and in the tab "Chats" with **Annehmen** (accept) and **Ablehnen** (decline)
  (`gruppe annehmen <name>`, `gruppe ablehnen <name>`); without an answer it expires.
- Further commands: `gruppe verlasse <name>` (management passes to the oldest member, the last one dissolves the
  group), `gruppe entferne <spieler> aus <name>` (only the manager), `gruppe <name> <text>` or the tab of the group;
  `gruppe` alone shows one's own groups. Joining, leaving and removal appear as a notice in the group.
- At most 20 members.
- A settlement later has its group by itself: whoever becomes a settler is a member, whoever stops being one is not.

**End-to-end encrypted**

- Only the members of a conversation can read it, not the server and not its operator.
- Every account has a key pair (ECDH P-256), generated in the browser. The private key leaves the browser only sealed
  with the **chat password** (PBKDF2-SHA-256 with 600,000 rounds, then AES-GCM); the server keeps this backup and the
  public key (`ChatKey`), so that another device unlocks the same key with the same password. The chat password is not
  the login password and never goes to the server. On the device the key lies non-exportable in IndexedDB; logging out
  forgets it.
- A message is sealed individually for each reader (AES-GCM, key from ECDH between sender and reader via HKDF); the
  additional data bind the copy to message, sender, reader and group. The server only checks who may read and stores the
  sealed copies. A typed line `chat <name> <text>` is sealed by the page; the server does not accept an unencrypted
  message.
- **Forgetting the chat password means: the histories are lost.** Nobody can restore them. A new key reads nothing that
  was sealed for the old one. The page says so during setup and offers **Verlauf sichern** (save history; a text file of
  the open conversations); the chat password can be changed as long as one knows it.
- Every conversation shows the **fingerprint** of one's own and the other's key. Whoever compares them outside the game
  knows that nobody slipped a different key in between.
- What the server still sees: who writes with whom and when, group names and members, the notices of the groups (joining,
  leaving). And it serves the code of the page: an operator who secretly changes it could read along — this applies to
  every encryption in the browser. WebCrypto needs HTTPS (or `localhost`).

**Where it lives**

- In the **accounts Space** (nano), as types of their own (`ChatMsg`, `ChatKey`, `ChatGroup`, `ChatMember`,
  `ChatInvite`, `ChatBlock`, `ChatReport`): it applies across all regions, only the web process reaches it, and the
  dashboard deliberately leaves it out. A separate Space `social` would have needed a third socket, port and tunnel,
  without more protection.
- Chat does not go through the world worker: the gateway intercepts chat lines and frames before they would go to the
  world. Delivery goes through the change stream of the accounts Space (also invitations and memberships).

**Protection**

- `ignoriere <name>` blocks messages and invitations from a player (also in groups he no longer gets a copy);
  `ignoriere` alone lists the blocked ones, `erlaube <name>` lifts it.
- For chat lines and frames the same limits per account apply as for typed commands (gateway). Guests may chat, but not
  invite anyone into a group and not found a group.
- Conversations do not appear in the log of the room. No NPC and no model reads them, the translation never sees them.
- **Report** on a message sends its text, as the reader decrypted it, with the sender to the admins (admin window,
  "Gemeldete Nachrichten", 30 days). The server cannot check the text against the sealed copy; admins otherwise see no
  conversations.

## Light is building land

Building happens only where a fire keeps the fog away. A building needs light, and every building uses some of it:

- A **fire** covers rooms ([welt.en.md](welt.en.md)); a **lighthouse** (extension of a fire) covers more rooms or burns longer
  per fuel.
- If the fire goes out, the buildings in its light do not decay immediately, but they **do not work** (no goods, no
  market), and the fog gnaws at them (decay, below).
- **Light suffices for a certain number of buildings.** Every fire carries **light points** (example: 20, a lighthouse
  50), distributed over all rooms it covers. Every building and every garden occupies as many of them as it counts
  towards the holdings of the epoch (below, "Epochs"); if a room is covered by two fires, both count together. If the
  light is full, `bau` accepts no new plan there until a lighthouse or another fire is added. The fuel of the fire is
  not used up faster by this: the price of building is the limit, not a faster fire.
- This keeps the core idea sound: whoever builds has a reason to keep the fire — and whoever wants to build more has a
  reason for the lighthouse.

## What one builds and lays out

By epochs; each level presupposes the previous one. Buildings and gardens are in the same tables because they are equal
— the garden rows are continued in the section "Gardens" further below.

### Epoch 1: huts (fishing village)

| Building | Cost (example) | Effect |
| --- | --- | --- |
| **Hut** | 6 driftwood, 2 kelp ropes | a place of one's own: chest (storage), logging out without loss, return point |
| **Drying rack** | 4 wood | slowly turns kelp into kelp rope |
| **Smokehouse** | 8 wood, 4 stones | fish → smoked fish (goods, food for workers) |
| **Jetty** | 6 wood | a landing at the shore of the room (no new room and no exit): boats moor there, fishing is done from there |
| **Rain barrel** | 3 wood, 1 kelp rope | water for watering: fills by one can every world day, fully at a storm tide; without it there is no water before the well |
| **Kitchen garden** | a free area, a spade (recipe: 2 driftwood, 1 kelp rope) | the first bed: vegetables and herbs, care in stages |
| **Chicken coop** | 4 wood | a few chickens: eggs every world day; they eat kelp and vegetable scraps from the kitchen garden, from epoch 2 also grain |

### Epoch 2: village (workshops and paths)

| Building | Effect |
| --- | --- |
| **Workshop** (carpentry, ropery, smithy) | recipes that do not exist without it; a tool lasts longer there |
| **Quarry** (at rocks), **clay pit**, **brickworks** | stone, clay and brick in quantity — basic material of buildings from here on |
| **Paved path** | cells that are walked faster (a step costs half the time) |
| **Storehouse** | shared storage of a village: everyone with the right deposits and withdraws (escrow as at the market) |
| **Well, bakery** | water in quantity for gardens and stables; bread (below, "Food") |
| **Fields** | shared plots at the edge of the settlement: grain, maize, potatoes, flax — sowing and harvest in bursts |
| **Windmill** | grinds grain to flour for the bakery, at a fixed pace, faster on storm days (wind as weather comes only with the seasons) |
| **Communal garden, orchard** | beds for everyone with the right; trees that grow over many game days |
| **Pen, stable** | sheep (wool → cloth), goats (milk), ducks and geese (eggs, down); they eat hay and turnips from the fields |
| **Chapel** | visible place of the gods ([goetter.en.md](goetter.en.md)): offerings, blessing (lease), festival — voluntary, the gods work without it too |

### Epoch 3: town (trade and administration)

| Building | Effect |
| --- | --- |
| **Department store** | a shop with stock and prices of its own (below, "Settlements and ownership"), delivery orders on the board |
| **Counting house, bank** | exchange, credit with a deadline (a debt is an entry with a lease, the pledge lies in escrow at the counting house: if repaid, it goes back to the debtor; if the deadline runs out, it goes to the creditor) |
| **Church, bell tower** | festival of the whole island; the bell calls (message to all rooms, an appointment of the world clock); one can build it, one need not |
| **Town hall** | rules of a settlement: zones and building rights, taxes into the storehouse, votes (proposals and votes as on the work board of codemode-chat) |
| **Shipyard** | larger boats: more cargo, new voyages into the fog ([spielidee.en.md](spielidee.en.md), "Erkunden") |
| **Dovecote** | carrier pigeons carry small letters between islands — mail before the timetable ferry |
| **Brewery** | beer from malt and hops — festive drink, trade good |
| **Glassworks** | glass from sand — windows, and the gardeners' greenhouse |
| **Park, greenhouse** | reputation of the settlement, place for festivals; year-round growing behind glass |
| **Lighthouse** | extension of a fire (above) |

### Epoch 4: network (infrastructure)

| Building | Effect |
| --- | --- |
| **Road** | connects rooms not across island borders, but within an island; carts drive on it |
| **Cart, wagon** | an automaton ([automaten.en.md](automaten.en.md)) with cargo that drives a route |
| **Ferry line with timetable** | ferries run at set times, the crossing is a room of its own ([welt.en.md](welt.en.md), "Noch offen") |
| **Island railway** | tracks are cells, a train is an automaton with a timetable; stations are exits; cargo like a storehouse on wheels |
| **Signal fire chain** | fires that see each other share their light: a chain burns only as long as every link burns |
| **Botanical garden** | gathering place of rare varieties, seed archive of all islands, place of the breeders |

A railway fits the tone (islands, fog, wood and coal), but only late: it pays off only when there are many goods that
have to travel far. Coal (from the peat bog, later mining) would be its fuel and a new conflict of goals with the fire.

### Raw materials and where they come from

Every epoch needs its basic materials, and some lie only where something has to be opened up first — so building stays
interlocked with exploring:

| Material | Source | From when |
| --- | --- | --- |
| Driftwood, kelp, shells | beaches (today) | start |
| Stones | gather rubble at cliffs and rocky coasts (like flotsam, sparse), from epoch 2 the quarry in quantity | epoch 1 |
| Clay, brick | clay pit at the bog or shore, brickworks fires brick (needs fuel) | epoch 2 |
| Peat, coal | peat cutting in the peat bog — fuel as well as building material; later mining on a minor island | epoch 2/4 |
| Iron ore | rare in cliffs and old wrecks; a mine is a building on a later island | epoch 3 |
| Sand → glass | gather sand at dunes, the glassworks melts it | epoch 3 |
| Fish | at the jetty with the net (new recipe: 3 kelp ropes; today the net is only a trade good) | epoch 1 |
| Seeds, seedlings | the wild flora of the rooms (`flora`: flowers, bushes, trees) rarely yields seeds when gathered; plus gardener and trade | epoch 1 |

What is scarce travels through trade: Kupferhafen stays poor in wood, a mining island poor in food — goods chains run
via markets and ferries, not via storage out of nothing.

### Boats and fishing

- Fishing is done at the **jetty** (`wirf netz`): the net (recipe above) brings fish in world-time beats, rarely a find —
  a small, quiet yield next to the flotsam.
- A **rowing boat** is a thing (epoch 2, workshop) that travels from every jetty of the island to every other (an exit
  that only a boat opens, like a ferry without a timetable); the **shipyard** (epoch 3) builds sailing boats for farther
  and heavier trips. A boat has ownership like a hut and a small cargo hatch of its own.

## Epochs: what the level unlocks

An epoch applies **per island** — not per settlement or room — and counts the **held holdings** of the whole island:
buildings in maintained condition and with paid upkeep, weighted by size. Buildings and gardens count **equally**.
Example values (world configuration):

| Points | Buildings | Gardens |
| --- | --- | --- |
| 1 | Hut, drying rack, rain barrel, jetty, chicken coop | tended bed, sown field |
| 2 | Smokehouse, well, bakery, windmill, pen | Orchard, hedge, herb garden |
| 3 | Workshop, quarry, clay pit, brickworks, storehouse, chapel, dovecote | Communal garden, park |
| 5 | Department store, counting house, church, town hall, shipyard, brewery, glassworks, lighthouse | Greenhouse, botanical garden |

An island can reach the town level from gardens alone — an archipelago of garden settlements is a legitimate path.
Example thresholds per island: village from 15 points, town from 40, network from 80. A settlement is not a prerequisite
for this (it arises from huts, below); the epoch counts what stands on the island and is maintained.

- An `Epoch` entry per island holds the level; building plans and recipes check it.
- **Fallback by itself:** Because only held holdings count, an island loses the level again when too much decays —
  without a second mechanic. Buildings of the higher level remain standing and keep working as long as their condition
  and upkeep suffice; only new plans of this level are blocked until the holdings suffice again. So a fallback tears no
  goods chain apart, it only halts growth.
- The counting runs as a ticker in the world worker (once per world day and after every finished or decayed building)
  and writes the `Epoch` entry only when the level changes.
- The thresholds are in the `Setting` entries (configuration window as in
  [automaten.en.md](automaten.en.md#settings-for-operators)) and can be adapted per server to the number of players.

## Development: building rights, footprint, demolition

- **Blocked cells** (paths and squares of cobblestone blocked since world version 27, also for beds and fields): exits,
  the cell of a fire, paths, jetties and market squares are never buildable; `bau` checks this before it occupies the
  area. Nobody can build over a door, a fire or the path.
- **Footprint:** Every plan has a shape (hut 2×2, department store 4×3, church 3×5 …) and an orientation — the door
  faces a path or square when one borders it. `bau` occupies all cells of the shape in one transaction; there is never a
  partial piece.
- **Building right before the town hall:** Whoever builds on a free, lit, unblocked area develops it (claim via
  `unique`). The town hall (epoch 3) can later set zones — buildable, green zone, right of way — and, against votes, also
  order the demolition of a misplaced building. Until then: build where it does not block.
- **Demolition:** The owner (or a town hall decision) demolishes; part of the material goes back to the storage or to
  the demolisher, and the area is free in the same transaction (no ruin: that exists only on decay). A content (chest)
  goes to the owner or, if there is no room, into an estate as on decay.
- **Hut inside or outside:** Small buildings (hut, garden house, shed) are area, not a room of their own: chest and
  return point hang on the building (`oeffne truhe`, `ruhe`). Only buildings with an audience — department store,
  church, town hall, shipyard hall — get a room of their own behind a door with a lock. Otherwise every island would
  have dozens of nearly empty rooms.
- **Ownership changes:** `uebergib`/`verkaufe` on an area is a transaction like `offer`: land and building go together,
  co-residents run via rights (locks). What decays becomes free — the claim runs with the building.
- **Rooms grow, new ones arise:** If a room is full, it grows by a strip of cells — the world adds new building land to
  the same room, the claims stay; the strip goes to a side without an exit and without a beach, exits, fires and beaches
  of the world file stay where they are. And new rooms arise: the world file or a god (authority `insel`,
  [goetter.en.md](goetter.en.md)) creates new building land, reachable from a burning fire. A full room is therefore both:
  signal to grow and signal to expand.

## Gardens

Gardens are equal to buildings — no accessory, but the second, equally load-bearing path of the build-up. They are the
quietest, most frequent building, for guests as for settlers: whoever has no hut yet and may own nothing can already help
water and harvest. A garden makes time visible, and time is what the Space carries anyway with leases. And it makes
taste visible: two villages with the same huts differ more in their beds, their trees and their parks than in any
building. They range from the window box through the kitchen garden to the shared field that feeds a whole settlement.

### Kinds of gardens

| Kind | Where | What grows |
| --- | --- | --- |
| **Kitchen garden** | in front of the hut, behind the house | vegetables (potato, cabbage, beans, carrots, pumpkin), herbs |
| **Ornamental garden** | yard, window box, wayside | flowers (tulip, rose, Strandnelke, Dünenrose, Nebelblume only on Nebelholm) |
| **Communal garden** | village square, chapel | vegetables and flowers for everyone with the right; watering duty shared |
| **Orchard** | larger areas at the edge of the village | apple, pear, quince trees; grow over many game days |
| **Field** | plots at the edge of the settlement | grain (wheat, rye, oats, barley), maize, potatoes, turnips, flax, hops — one crop per plot |
| **Park** | town, epoch 3 | avenues, beds, fountains and benches: reputation of the settlement, place for festivals |
| **Hedge, copse** | on coasts and paths | breaks the wind of the storm tide, protects beds and buildings behind it |
| **Herb garden** | at the chapel | medicinal herbs (healing potion), offering herbs, dye herbs |
| **Greenhouse** | from epoch 3, needs glass | grows independent of the season, costs some fuel |

### How a garden lives

- **Laying out a bed**: dig up an area in the light (spade, `grabe`), with `unique` on the cells like any building. Small
  beds in front of the hut, communal gardens at the village square and chapel, orchards, parks in the town.
- **Sowing and planting**: seeds, bulbs, seedlings and young trees are things (the first ones from the wild flora of the
  rooms, raw materials above); `pflanze tulpe` puts them into a free cell of the bed. This becomes a **plant** that grows
  in stages (seed, sprout, bloom or fruit, wilted), each stage a deadline in world time ([weltzeit.en.md](weltzeit.en.md)).
- **Care**: Watering (`gieße`, water from rain barrel or well; seawater is no good) and weeding renew the lease of the
  plant; whoever forgets them lets it wilt. Fog makes plants grow more slowly, light faster: gardens are one more reason
  to keep the fire. A garden is teamwork like a fire (watering duty, contributions visible).
- **Sponsorship**: `pate` on a bed allows another figure — a fellow player or the village gardener (script NPC) — to
  water and weed there; visible on the bed sign, cancellable at any time. This keeps a bed tended when the owner is
  away for days: asynchronous help without ownership moving.
- **Harvesting**: Harvest is a `take`: ten people at the same apple tree, each apple goes to exactly one. A private bed
  is harvested by owner and sponsor into their own pocket. A communal bed is harvested by all with the right, but into
  the chest of the bed; from it everyone takes according to the quota of the storehouse (below, "Settlements and
  ownership").
- **Propagating and breeding**: Flowering plants give seeds; two varieties next to each other sometimes cross into a new
  color or shape (rare varieties, breeding). Whoever crosses a new variety may name it — its name and that of the breeder
  stay in the prototype. Trees grow over many game days and last long; an old tree stands in the reputation of its
  planters.
- **Buying and exchanging**: Seed merchants at the markets (a new NPC, gardener), flowers at the market board, exchange
  of cuttings between players (`offer` as today). Rare varieties have prices; the gardener posts jobs herself ("looking
  for a Nebelblume") and is thus a quest source without model costs. Bouquets are gifts to NPCs and offerings at the
  chapel.
- **What for**: Vegetables are food (smokehouse, bakery, workers), herbs are ingredients (healing potion, **dyes** for
  banners and festivals), fruit trees yield wood when felled (conflict of goals: wood now or apples every ripening
  time), flowers decorate (reputation of a settlement, festivals, flower show with a prize from the board), hedges and
  trees break the wind of the storm tide.

### Fields and grain

Fields are the big sister of the beds: the same stages, the same care — but over plots instead of cells, in bursts
instead of daily, and as joint work like a building site.

- **Laying out a plot**: a field is a contiguous area at the edge of the settlement (e.g. 4×4 to 8×8 cells), `unique`
  like any building, but **one** entry over the whole plot — not per cell. So a hundred field cells stay as cheap as one
  bed. A plot carries **one** crop: wheat, rye, oats, barley, maize, potato, turnip, flax or hops.
- **Sowing and harvesting**: A field needs little daily care, but two bursts of work: `bestelle` (plough, sow — seed from
  the gardener or the own harvest) and the **harvest** in the harvest window of a few game days. Until there are
  seasons, the harvest window opens a fixed deadline after sowing (per crop). Both are work points as at the building
  site: the harvest effort is a communal event — a "Schwengernte" where ten hands bring in within an hour what one would
  need days for. Whoever misses the window loses part of the yield to the plot. Day laborers and automata help (work
  points, the same cap on outside work).
- **Crop rotation**: The same crop twice in a row on a plot gives a tired soil and little yield; grain – potato – fallow
  (or turnip) stays healthy. The counter is at the plot, a glance suffices.
- **Goods chains**: grain → **windmill** → flour → **bakery** → bread (sates, below "Food"). Flax → linen → sails for the
  shipyard and nets for fishing. Barley and hops → **brewery** → beer (festival, trade good). Turnips and hay → fodder for
  sheep and goats, grain for the chickens. The mill grinds at a fixed pace and faster on storm days; calms exist only
  with the weather of the seasons.
- **Conflict of goals**: Grain is bread, seed and beer at once — what one grinds, one does not sow.

### Animals on the farm

Animals come early, not only late: already the chicken coop of the fishing village. An animal is a small figure with a
pen (own cell or area), a **feed lease** — if it eats nothing, it gives nothing more (eggs, milk, wool) until it is fed
again — and a yield that one may `take` like a harvest.

- **Chickens** (epoch 1): eggs every world day, eat kelp and vegetable scraps, from epoch 2 grain from the fields — the
  first step from gathering to keeping.
- **Ducks, geese** (epoch 2, pen): eggs and down (warm bedding, later clothing); the geese cackle at strangers and fog
  creatures — the living guard of the farm.
- **Cat** (epoch 2): catches mice in house and storage — grain and supplies spoil more slowly where a cat hunts. It
  belongs to no pen but to the farm: it roams on its own and stays with the figure that feeds it. Company like the dog.
- **Sheep, goats** (epoch 2, pen): wool → cloth at the loom in the workshop, milk → cheese; they eat hay and turnips from
  the fields — the fields feed the farm.
- **Dog** (epoch 2): follows a figure, warns of fog creatures — company instead of use.
- **Pigeons** (epoch 3, dovecote): carrier pigeons carry small letters between settlements and islands — mail long before
  the timetable ferry. A pigeon always flies home to its cote; whoever wants to write carries it along.
- **Songbird** (rare, from epoch 3): a thrush or canary in a cage sings in the house — no use except life and reputation;
  a gift of the bird seller at the market.
- **Falcon** (rare, from epoch 3): follows a figure and fetches small things back from the edge of the fog — a companion
  for beachcombers.
- **Ox, later horse** (epoch 3/4): draft animal for carts — a living wagon before the mechanical one.

Wild birds do not belong in the stable but in the world: **gulls** circle where the tide just brought flotsam (a hint
instead of a map), **herons** stand in the salt meadows, **puffins** nest on Nebelholm, and with the seasons flocks
migrate — the autumn flight is calendar and announcement of the harvest festival.

Animals are no fighters and no large-scale cattle market; they keep the farm alive and give the fields a second buyer. A
"stable hand" automaton (feed, collect) is an obvious template.

### Parks and what they give the settlement

A park is a public garden: avenues of trees, beds, a fountain, benches. It produces nothing, but it counts threefold
towards the held holdings of the epoch, gives reputation points to the tenders and is the place for festivals — the
**flower show** (rare varieties are shown, the board awards a prize), the **harvest festival** (after the harvest of the
plots of an island, with the seasons in autumn), weddings and market days. Between settlements the most beautiful park is
the nonviolent competition that the archipelago can bear.

### Seasons (later)

What blooms when, frost in winter, harvest in autumn; a harvest festival of the island at the church. A sowing calendar
of the gardener says what is worthwhile now — see [weltzeit.en.md](weltzeit.en.md).

### Automata in the garden

A watering robot is an obvious first automaton ([automaten.en.md](automaten.en.md)), with water as budget; a "bed helper"
template (water, weed, harvest into the bed chest) is among the examples.

| Garden mechanic | Space operation |
| --- | --- |
| Plant grows | stage as entry, next stage an appointment of the world clock |
| Watering, weeding | `renew` of the lease of the plant |
| Wilting | lease runs out, the world writes a wilted plant (or compost) |
| Harvest | `take` of every fruit: exactly one gets it |
| Crossing | ticker reads neighbors in the bed, rarely writes a new variety as a seed |
| Sponsorship | `locks` on the bed allows `renew` by the sponsor |
| New variety | prototype entry with name and breeder, `unique` on the name |
| Park reputation | settlement counter reads tended beds of the park |
| Greenhouse | building with its own fuel lease like a fire, only smaller |
| Field (plot) | one entry over the cell range, `unique` like a building — not one entry per cell |
| Sowing, harvest | work points as at the building site; harvest window as appointment of the world clock |
| Crop rotation | counter at the plot entry (last crop, last yield) |
| Windmill | ticker grinds at the fixed pace, faster during a storm tide |
| Animal in the pen | small figure with feed lease; yield as `take` with deadline |
| Festival, regatta | appointment of the world clock; scoring and rank as entries on the board |
| Automaton (body) | `craft` from three parts; program runs in the sandbox, oil lease as tank |

Many gardens mean many entries with lease and appointment. A plant writes only when it changes stage or is watered
(watering is a `renew`, so also a write), never per tick; the stages of a bed run via **one** appointment per bed, not
per plant. This way 10,000 plants burden the Space no more than a few dozen figures — watering must still be counted
(acceptance below).

## Wild in the fog: mice, hares, deer, foxes

The fog threatens not only the paths. From it comes the game that gnaws at what a settlement grows and keeps. It is no
opponent to fight: one drives it away, fences in, keeps dog and cat and above all the fire. So the core idea stays
sound: **whoever keeps the fire protects farm and fields.**

| Animal | Target | Damage | Protection |
| --- | --- | --- | --- |
| **Mice** | granary, storehouse, chests with grain or flour | eat part of the stock (a few pieces per visit) | cat in the building, mousetrap (recipe), granary of stone |
| **Hares** | beds, vegetables, young plants | gnaw a plant: it falls back one growth stage, a seedling is gone | fence, hedge, dog |
| **Deer** | fields (grain, turnips), orchard | eat their fill at a plot: its yield sinks; young trees are browsed | fence around the plot, scarecrow (holds for a while), dog |
| **Foxes** | chicken coop | take a chicken (it is gone, the coop gives fewer eggs) | coop with door and fence, dog, at night the fire |
| **Gulls** (on the coast) | smokehouse, fish at the jetty | steal fish | net over the rack |

- **The fog makes it easy for them.** How often game comes depends on the fog level of the room: at level 0 (the fire
  burns) it stays away, at 1 it comes rarely, at 2 more often, at 3 often. At night (world clock) more than by day; foxes
  almost only at night. An extinguished fire therefore costs not only the path but also the harvest.
- **Visible and shooable away.** An animal is a small figure on the map (script, no model, no account). It comes from the
  edge of the room, runs to its target and eats there after a short deadline. Whoever is with it beforehand scares it
  away (`scheuche <tier>`, or a click on the animal): it flees into the fog, nothing is lost. Whoever watches can save
  it; whoever is not there needs fence, dog, cat or light.
- **No fight, no excessive punishment for the absent.** Little is lost per visit, the number of animals per room is
  capped, and a protected farm loses nothing. An animal never eats the last one (the last seedling, the last chicken
  stays), so that nobody stands before nothing on return.
- **Protective buildings** thus enter the plans: fence and scarecrow (epoch 1, wood and kelp rope), mousetrap (recipe),
  cat and dog (animals, epoch 2, from trade or from the farm). A fence is a row of cells like a path, with a gate
  (passage for humans, not for game).
- **The fog creatures** ([spielidee.en.md](spielidee.en.md)) remain the more distant thing: in rooms without any fire at level
  3, at night, as an obstacle on the paths; fighting them only in the optional module K ([phasen.en.md](phasen.en.md)). The
  game is everyday, the fog creatures are the exception.
- **Technique:** A wild ticker in the world worker sees only rooms with gardens, fields, stables or granaries (otherwise no
  load) and rolls dice per room by fog level and time of day. An animal is an entry with a lease (it leaves by itself if
  nobody sees it); its eating is a transaction like any harvest (`take` of the plant, the grain, the chicken), so never
  twice and never half. Scaring away is a `take` of the animal: whoever comes first saves.

## Food (later)

Bakery, smokehouse, bread and eggs promise a use; without it they would be only trade goods. Proposal, deliberately
small: **being sated** is an entry with a lease on the figure (eating renews it, bread longer than an egg). Whoever is
sated has work points at building site and plot counted one and a half times and decaying faster. There is no hunger:
nobody loses anything, whoever does not eat only works at the base pace. A carrying limit that food raises does not exist
today and will not be added for this.

## How a building arises: the building site

No player builds a house alone in one command. A building site is a place where many contribute:

1. `bau hütte` on a free, lit area creates a **building site**: an entry with the plan (what is missing) and a lease (if
   it stays empty, it disappears).
2. Anyone can deliver (`liefere 3 treibholz an baustelle`) or do work (`arbeite an baustelle`), also from two cells away,
   so that a crowd has room around the site. Delivery and progress are one transaction: the goods are gone, the progress
   stands, never half. **Work is a resource like material:** `arbeite` sets work points (with a cooldown per figure and
   game day); a hut needs about twenty — a single figure manages it in days, many hands in hours.
3. What is delivered **in excess** goes back to the deliverer (nothing is lost, nothing stays hanging half).
4. When nothing is missing any more, the site becomes the **building** (in the same transaction). Whoever contributed is on
   a board at the building (as today the contributions at a fire: reputation).
5. **Jobs**: A building site can hang its missing parts and missing work points on the job board ([phasen.en.md](phasen.en.md),
   phase 4) — with a reward from the settlement's storage or the supply of the client. Gatherer NPCs, day laborers and
   automata then deliver (see "Few players").
6. **Abort**: `reisse baustelle ab` gives what has been delivered so far into the storehouse of the settlement (or to the
   client if there is none). An abandoned building site decays with its lease.

## Decay and upkeep

Without sinks the world only grows (more entries, more load, no goals left). Therefore what nobody tends decays:

- Every building has a **condition** with a lease. Fog, storm tide and time reduce it; `repariere` with material renews it
  (`renew`, like adding wood to the fire).
- "Stands still" means per building: no goods, no market, no effect — but the building stays walkable and repairable. A
  still paved path is a path like any cell again.
- A decayed building becomes a **ruin** (gives back part of the material, can be rebuilt) and disappears entirely after a
  deadline (example: ten world days); with it the claim on the area expires.
- **Content stays protected:** If a building with content decays (the chest of the hut, the storage of a bed), the
  content moves into an `Nachlass` (estate) package that only the owner can collect at the ruin — with a long lease,
  after which that decays too. Decay is noticeable but not a loss in one blow.
- Shared buildings (road, church, department store) cost **upkeep** from the storehouse of their settlement; if it is
  missing, they stop working. Refilling is the quiet permanent task of a settlement — like the fire, only at a monthly
  pace.

## Settlements and ownership

- A **settlement** arises when enough huts stand in a room (example: three huts of at least two owners); it has a name
  and rules. Its first shared building is usually the storehouse (epoch 2) — the epoch counts per island, a settlement is
  not a prerequisite for it, and the storehouse none for the settlement.
- **Ownership** is an entry with `unique` on the area: two players can never build on the same cell, even if they type
  `bau` at the same time.
- **Rights** (who may take something in the house, build on the area, withdraw from the storehouse) are locks as today at
  exits (`locks`, [phasen.en.md](phasen.en.md), phase 1) and have levels: **stranger**, **helper** (may deliver, work, water
  communal beds and harvest into their chest), **settler** (may build and withdraw from the storehouse). A guest account
  (without registration) is at most helper.
- The **storehouse** holds escrow, but not blindly: `lager log` shows the last withdrawals (who, what, when — short lease
  per line), and per right level a withdrawal quota per world day applies. A stranger cannot empty the village storage; a
  new settler only a little.
- **Taxes:** The town hall puts a small fee on turnovers of the department store and on withdrawals from the storehouse.
  This way flows what upkeep eats — currency and material sink at once.
- **Department store versus market board:** The market board stays what it is — escrow offers between figures that
  expire. The department store is a shop: it buys from the players' offer into its stock and sells from it, at prices
  that a manager sets or that a simple rule leads (empty stock → more expensive, full → cheaper). Missing stock is filled
  via delivery orders on the board. The shop closes the gap when nobody happens to be at the board — important with few
  players.
- Guest accounts can contribute work (deliver, work, water as helper), but own nothing; ownership needs a registered
  account (like trade today).

## Festivals and competition without violence

There is competition — for beauty, quantity and skill, never for fighting:

- **Flower show** and **harvest festival**: the board awards prizes — rarest variety, biggest pumpkin, most productive
  plot.
- **Regatta**: a boat race around buoys as soon as boats sail; the course is an appointment of the world clock.
- **Reputation of the settlements**: the board shows a rank — held holdings, goods turnover at the department store,
  tended parks. Nothing is taken from anyone; the comparison itself is the incentive.
- **Fire chain**: which island keeps its signal fires burning longest without going out — a standing counter, not an
  event.

## Few players: the world helps out

The shared way of building actually presupposes many hands. The gardens are the strand that carries from the start with
few hands: a single player keeps a garden alone — the help below applies mainly to the buildings. If only two or three
people play, mechanisms help that mostly already exist — all via the same commands and the job board, never through
invisible interventions:

- **Building site jobs are accepted.** The script NPCs ([welt.en.md](welt.en.md), "Die Bewohner") accept delivery jobs from
  building sites like any other job — against the reward the site posts. The gatherer gathers what is missing; the
  merchant buys it in. Nothing arises from nothing.
- **Day laborers.** A new script role `bauhelfer`: can `liefere` and `arbeite`, is hired via
  `heuere <name> an baustelle` or a board job with reward. Procuring material is not enough — labor is the bottleneck,
  and exactly this the day laborer fills — on the plots he is the harvest helper.
- **Automata as second hands.** `liefere` and `arbeite` enter the `AutomatonCmdSet` ([automaten.en.md](automaten.en.md)); a
  template "Baustellenhelfer" (fetch from storehouse or own chest, deliver, work) is among the examples. Two players with
  two automata each make six figures — the cap below, however, lets the four automata contribute at most as much as the
  two humans: twice as fast, not three times.
- **Settlement population.** For every five finished buildings a dozing villager (script, no model) is added: waters the
  communal beds, adds wood at the fire, talks on the square. Settlements become visibly livelier the more is built — even
  if only two humans play.
- **Gods and wanderers.** A god may serve building sites with the authority `auftrag` ([goetter.en.md](goetter.en.md)) ("Bring
  ten wood to the building site at the Graue Bucht", reward from the world supply). On `construction.stalled` (building
  site some days without progress) the world sends a wanderer ([modell-npcs.en.md](modell-npcs.en.md)): the traveling
  carpenter, who works along for pay — without a model a script NPC with two, three lines.
- **Master builder (optional, tokens).** A model role that reacts to `construction.stalled` and being addressed: calls in
  the channel *hafen* for material and hands, explains building to guests, suggests what is missing next. She coordinates
  — she may not build, like all model NPCs.
- **Watering sponsorships** (above at the gardens): the village gardener or a fellow player tends the beds of absentees.

- **Building material stays** (`flood.staples`, world version 27): If fewer than 8 driftwood, 6 kelp or 3 shells lie on the
  beaches of an island (more, the more people are there), every tide brings up to two more; they lie for 30 world minutes.
- **Settlers** (built 2026-10-30, `server/npc/settlers.ts`, test `tests/settlers.test.ts`, world version 26): So that the
  world never looks empty, at least `settlers.min` figures are always playing (setting, default 30, 0 switches them off).
  If humans are missing, settlers fill up: 40 script figures, each a fixed island, no model call. Every human who plays in
  a region replaces a settler there; the region carries its share according to the number of its settlers, and they go in
  a fixed order. They use only player commands: gather, twist rope, build hut, rain barrel and chicken coop, deliver and
  work at others' building sites, tend two beds, repair, feed the fire, sell and buy at the market of their island what
  their building site lacks. Map and `who` show them as settlers; animals, plots, mill and bakery they do not serve yet,
  and they do not take the ferry.

Limits, so that the AI does not play the game:

- Help exists only against **job or hiring**, paid from storage or pocket. No NPC starts a building site itself; the
  impulse stays human (or a town hall decision). Exception are the settlers: they stand in for missing humans, count as
  humans when building and leave a quarter of the light of every fire free (`settlers.reserve`).
- At most **half** of the deliveries and the work per building site may come from non-humans; the building site entry
  keeps both counters. Non-humans are NPCs and automata, also those of a player. A building of the players stays a
  building of the players.
- Keeper and village NPCs tend fires and shared buildings (storehouse, paths, parks, communal beds), **never private**
  huts and private beds — otherwise decay would be dead and absence without consequence.
- Buildings count towards the held holdings of the epoch, no matter who helped — the half-hands cap ensures that humans
  always carried the main load. The thresholds are world configuration (above).

## Automata: from when and how

Automata ([automaten.en.md](automaten.en.md)) are here a craft product, not a menu item. The prototype `Automat` arises from
**rope** (ropery), **gear** (smithy) and **housing** (carpentry) — at the earliest in **epoch 2**, when the workshops
stand, and still precious, because gears need iron and ore before the mine comes only as rare wreck and cliff finds.
Automata become common in **epoch 3**: a mine delivers iron in quantity, and whoever wants an automaton builds it — or
buys it from a craftsman or at the department store. Until then the world stays handmade; this is intended, because
automata are the reward of an economy that already stands.

Whoever has the body develops the automaton as in [automaten.en.md](automaten.en.md): template with fields, rule builder,
showing how or the assistant — the program runs in the sandbox, costs in operation only **oil** (the lease is the tank)
and uses the same commands as a human; at most two per character. New templates from this concept: "Baustellenhelfer",
"Beethelfer", "Erntehelfer" (works in the harvest window), "Stallknecht" (feeds, collects) — and in epoch 4 the
**wagon**, a driving automaton with cargo on a route, as a preliminary stage of the island railway.

## What the Space semantics carries

| Game mechanic | Space operation |
| --- | --- |
| Supply a building site | `take` of the goods + `write` of the progress in one transaction |
| Do work | work-point entry per figure with cooldown lease + progress `write` |
| Complete | building site `take`, building `write`, contributions `write`, one transaction |
| Occupy area | `write` with `unique` on (room, cell); footprint = all cells of the shape in one transaction |
| Building right/zone | settlement entry with `locks`; `bau` checks blocked cells and zone before occupying |
| Decay | lease of the condition runs out; `renew` on repair |
| Estate | `take` chest + `write` estate with `unique` on (owner, building), long lease — several estates per owner possible |
| Light points | counter per fire (occupied points); `bau` reads it and rewrites it in the same transaction |
| Being sated | entry with lease on the figure; eating is `renew` or a new `write` |
| Upkeep | ticker takes from the storehouse, otherwise sets the building to "stands still" |
| Withdrawal log/quota | `take` with day counter per right level; log lines with short lease |
| Cart, train, ferry | automata with timetable (appointments of the world clock, [weltzeit.en.md](weltzeit.en.md)) |
| Vote in the town hall | proposals and votes as entries, end with lease |
| Epoch reached | `Epoch` entry per island, written by the counting ticker; recipes and building plans check it |
| Day laborer | NPC `Intent` as with humans; job and reward at the board |
| Outside-work cap | two counters at the building site (own/foreign contributions) |
| Chat message | one sealed copy per reader as `ChatMsg` with lease in the accounts Space; delivered via its stream |
| Group, invitation | group and member as entries in the accounts Space; invitation with lease like an offer, accepting is `take` + `write` |
| Block | `ChatBlock` (who, whom); the web gives blocked ones no copy |
| Chat key | `ChatKey`: public key and the private one sealed with the chat password |

## Regions

Since 2026-10-28 the world runs as four Spaces, one island group per region ([welt-aufteilen.en.md](welt-aufteilen.en.md)).
Almost everything here stays within an island and thus in one Space: buildings, gardens, plots, settlement, storehouse,
epoch, road, cart and island railway. What crosses regions needs the handover or a path of its own:

- **Return point:** The hut is a return point only within its region; whoever logs out elsewhere returns to the hut if it
  stands in the region of the figure, otherwise to the bay of the region. A return across regions would go via the
  handover (`handover.ts`) and is not planned for now.
- **Ferries** are the only paths between regions. Timetable ferries and boats (shipyard) hand over the figure with cargo as
  today; a boat that travels to another region is a ferry.
- **Bell, rank, festivals:** The bell calls into all rooms of its island. The rank of the settlements and the fire chain
  of the board count across all regions: every region Space writes its numbers, the board reads all (like the system bar
  the processes of all regions).
- **Department store and counting house** trade in their region; goods go by ferry, not by storage across Spaces. A debt
  stays in the region of the counting house.

## What this means for operations

- **More entries that stay.** Buildings are permanent; every island with a town has hundreds. Reading by type is indexed
  ([lasttest-2026-10-28.en.md](lasttest-2026-10-28.en.md)), but a room with many buildings needs an index by room or types of
  their own per kind of building. Fields stay single entries despite their area (one per plot).
- **More tickers** (decay, upkeep, workshops, trains, plant stages). They belong in world workers, not in the Space
  process; a ticker that changes nothing writes nothing (like `fireTick`).
- **More script NPCs**: day laborers, villagers, gardener. They cost no model call, but CPU; the number per settlement is
  capped (population grows with the buildings).
- **The world is split** (above, "Regions"): settlements operate per island and thus within one Space; the ferry is the
  only handover between Spaces, the island railway stays in its island. If a region with towns becomes too full, it can be
  split further (one island per Space).
- **Map**: Buildings need graphics (sprites per kind of building and condition: building site, finished, decayed, ruin),
  gardens a representation per stage (seed to wilted); in the client a building-plan chooser, a building-site progress and
  the zones of the town hall as overlay.

## Order

0. **Chat between players** (above, built): `chat`, the right-mouse-button menu on the map, tab per conversation, left-over
   messages, groups with invitation, `ignoriere`, end-to-end encryption with chat password, reporting.
   Acceptance:
   - Two players in different regions write to each other.
   - A message to an absent person appears at his next login.
   - One invitation is accepted, another expires.
   - A blocked person no longer reaches anyone who blocks him.
   - A guest cannot found a group.
   - No conversation appears in the log of the room.
1. **Hut and building site** (epoch 1, without settlement): building plan as prototype, `bau`, `liefere`, `arbeite`,
   completion, chest, decay, estate. Plus the basic rules: blocked cells, footprint, claim, demolition, light points of the
   fires. Acceptance: 20 players
   supply the same building site at the same time, it is completed exactly once, no part is lost or doubled;
   over-delivery goes back; a hut on an exit is rejected; a demolished building frees the area;
   if the light of a fire is full, `bau` accepts no plan any more.
   - **Part 1, built 2026-10-29** (`server/engine/commands/build.ts`, test `tests/build.test.ts`): building plan "Hütte"
     in the world file (`building.plans`), `bau` (next to oneself or `bau hütte <x> <y>`), `liefere`, `arbeite` (one
     world hour of rest afterwards), `baustelle`, completion in the same transaction; areas as `Plot` with `unique` on
     room and cell, nobody walks into them (`blockedIn` in `occupancy.ts`, also flotsam, arrival and the page); blocked
     cells (exit and door, fire and its neighboring cells, things, persons) and the check that exits, spawn and one side
     of each fire stay reachable; light points per fire (`LightUse`, 20 per fire, the hut 1); at most half from non-humans;
     a building site without progress decays after two world days. The map shows building site (with progress) and house
     in 2D and 3D, the right mouse button offers delivering and helping. Delivering and helping work from up to two cells
     away (`SITE_REACH`): directly next to a 2×2 hut there are only twelve cells, with one figure per cell too few for
     twenty; at distance two there are 32. Chest, repair and demolition stay directly at the building. If another
     delivery currently holds the building site (it is taken in that transaction and therefore not readable), `liefere`
     waits for it via its cells instead of reporting "no building site". Acceptance: twenty deliver at the same time,
     exactly six driftwood are taken, the rest stays in the pockets, nobody hears "no building site"; twenty-one hands
     complete it exactly once; from three cells away it says "Geh näher".
   - **Part 2, built 2026-10-29:** the **chest** of the hut (12 slots, owner only: `truhe`, `verstaue`, `entnimm`, also
     "leg … in die truhe", "nimm … aus der truhe"); **decay**: a building lasts a week, `repariere` (1 driftwood, anyone)
     resets the deadline; a building that is not held becomes a **ruin** (ten world days, keeps covering its cells, frees
     the light), what lay in the chest waits as **estate** for a month for the owner (`nachlass` at the ruin);
     **demolition** (`abriss`, "reiß die hütte ab"): area and light free, half of the material and the chest back, an
     abandoned building site gives back everything delivered. The map shows the ruin, the cell menu offers repair, chest
     and estate. Not yet: faster decay in fog (comes with the game), rebuilding a ruin, the hut as return point.
2. **Gardens** (the equal strand, parallel to all buildings): spade, rain barrel, kinds of beds (kitchen, ornamental,
   communal), seeds from the wild flora, plants with growth stages, watering and weeding,
   sponsorship, harvest, crossing and naming, gardener with seed trade and search jobs. Acceptance: 1,000 plants
   grow for one game day and are watered twice, the Space writes only on stage changes and on watering
   (measured: writes per game day); a sponsorship waters a foreign bed without owning it.
   Plus the first **game**: hares in the beds, the wild ticker by fog level, `scheuche`, fence and scarecrow.
   Acceptance: with a burning fire no hare comes; at level 3 some do, a scared-away one eats nothing, a fenced bed loses
   nothing, the last little plant stays.
   - **Part 1, built 2026-10-29** (`server/engine/commands/garden.ts`, test `tests/garden.test.ts`): **spade** (recipe
     2 driftwood, 1 kelp rope), **rain barrel** as building plan (1×1, 3 driftwood, 1 kelp rope, 4 work; `schöpfe` fills
     a can of water), **beds** 2×2 in the light (`umgraben`, areas as `Plot` like buildings, one light point, at most
     three per account, `beet aufgeben`), **seeds** from the wild flora (`sammle samen`: in rooms with flowers or herbs in
     the decor, once per world hour, every second time a find), five varieties (Strandnelke, Dünenrose, Nebelblume only on
     Nebelholm, Strandkohl, Möhre), `pflanze`, **stages** seed, sprout, ripe, wilted in world time, `gieße` (one can
     for the whole bed), `jäte` (weeds and wilted), `ernte` (yield and one to two seeds, each plant exactly
     once), **sponsorship** (`pate <name>`, also for guests; `pate weg`). The plants lie in the entry of their bed,
     the bed carries one appointment: the next stage change of its plants. The garden ticker (every 60
     world seconds) writes only beds whose appointment has come; fog (every fog level makes a stage half as long again: at
     level 3 it takes 2.5 times as long) and weeds (1.5 times as long) slow down growth and are read when the bed is
     written anyway. Whoever stands without water for more than 16 world hours at the next step wilts; a bed that nobody
     tends for two weeks grows over.
     Map: beds with their plants per stage in 2D and 3D, the cell menu offers watering, weeding, harvesting, planting and
     at the barrel drawing water. Help: article "Gärten", topic `help garten`.
     Acceptance measured: 250 beds with 1,000 plants grow for one world day and are watered twice; the Space
     writes the beds 750 times, 500 times on watering and 250 times on stage change (in a bed the plants set
     together change together), and not once while no appointment comes. A sponsorship waters a foreign
     bed without owning it; two harvest at once, each ripe plant goes to exactly one.
     Deviations from the draft: the command is called `umgraben`, not `grabe` (that is the builder command `dig`); there is
     one kind of bed for vegetables and flowers at once; the rain barrel fills every eight world hours by one can (up to
     six), not once a day, otherwise one barrel would not suffice for a bed that needs water twice a day.
   - **Part 2, built 2026-10-29** (same files, world version 18): three kinds of beds. The **garden bed** (`umgraben`)
     carries vegetables and flowers. The **ornamental bed** (`umgraben zier`) carries only flowers, and only there do they
     **cross**: when a flower ripens next to which (not diagonally) another variety stands, the harvest gives, with a
     probability of a quarter, a **crossing seed** instead of a seed. It carries a color of its own between those of the
     parents and the breeder. Whoever grew it **names** the variety once (`benenne <name>`); then its seeds are called
     "<Name>-Samen" and its flowers "<Name>". A name has 3 to 24 letters. It may not be anything the world already means
     (no prototype, no variety, no command), so that `give kohl` never finds a flower that someone named "Kohl". It is
     `unique` (`Variety` entry). The **communal bed** (`umgraben gemeinschaft`) is 3×3, occupies two light points and lies
     at most once per fire (`BedCommons`, `unique` on the fire). It counts towards nobody's three beds. Anyone with an
     account may plant in it, all may water, weed and harvest, also guests; only the one who laid it out can give it up.
     The **gardener Gesa** (script `gaertnerin`, Kupferhafen) gathers like anyone with `sammle samen` and sells the seeds
     at the market. She buys flowers and vegetables. Her **search jobs** hang on the boards: a Nebelblume, Dünenrosen,
     cabbage and carrots, Strandnelken. The map colors plants of a crossing in their color, the cell menu offers at the
     communal bed watering, weeding and harvesting to all and planting with an account. Acceptance
     (`tests/garden.test.ts`):
     - Cabbage is rejected in the ornamental bed.
     - Four ripe flowers of two varieties cross at harvest.
     - The breeder names the crossing. "Kohl" and "ernte" are rejected as names, as is a name already taken.
     - From the seeds the variety grows under its name and in its color, and it gives a flower of this name.
     - A second communal bed at the same fire is rejected.
     - A guest does not plant there, but waters.
     - The measuring test still writes 750 times and, with the clock stopped, not once.

     Deviations from the draft:
     - The harvest of the communal bed goes into one's own pocket instead of a bed chest with the quota of the storehouse;
       both come only with step 5. Anyone with an account may plant instead of anyone "with the right", because rights
       exist only with the settlement in step 4.
     - Crossing happens at harvest, not at ripening: The harvest writes the bed anyway, so the number of writes stays the
       same.
     - A crossing is not a new prototype. It lives as `variety` on seed, plant and flower, keeps the prototype of its
       original variety and thus travels with its carrier into other regions.
     - The name is `unique` only per region, because there is no worldwide Space for it. A plant that was set before the
       naming receives the name at its harvest.

   - **Part 3, built 2026-10-29** (`server/engine/commands/wild.ts`, test `tests/wild.test.ts`, world version 19): the
     first **game**, the **hares**. The wild ticker (job `wild`, every 20 world minutes) sees only rooms with beds. By
     their fog level it rolls for a hare: level 0 (the fire burns) never, otherwise 4, 12 or 25 percent, doubled at night,
     at most two per room. A hare is an `Animal` entry next to a bed. After half a world hour it eats: A plant falls back
     one stage, a seedling is gone, the last living plant stays. Then it leaves. `scheuche hase` takes it away from up to
     three fields: Whoever comes first saves the bed, and a scared-away hare eats nothing. Permanent protection is given by
     the **fence** (`zäune`, 2 driftwood, 1 kelp rope, for a bed one may tend) and the **scarecrow** (building plan 1×1, 2
     driftwood, 1 kelp rope, 3 work, protects the beds within up to three fields, lasts three days). Writes happen only
     when a hare comes or eats. The map shows the hare (icon from `items-src/garden.py`) and the fence in 2D and 3D; the
     cell menu offers scaring away and setting a fence.
     Acceptance (`tests/wild.test.ts`):
     - With a burning fire no hare comes, at level 3 one comes to every bed.
     - A scared-away hare eats nothing.
     - A fenced bed and one at the scarecrow lose nothing.
     - The last little plant stays.
     - Only the open bed loses a stage.
     - There are never more than two hares per room.

     Deviations from the draft:
     - The fence is not a row of cells with a gate, but belongs to the bed: It stands around its edge and costs material
       once. Fences around whole plots come with the fields (step 3).
     - The hare appears right at the bed instead of running from the edge of the room.
     - A click on the hare opens the cell menu with "Verscheuchen".

     Not yet: the hedge as protection (the dog came with step 3, part 4), bouquets as gifts and offerings, the flower show.
3. **Fields and mills** (the big strand of the gardens): plot entries over cell ranges, one crop per plot,
   sowing and harvest effort as work points, crop rotation, windmill and the chain grain → flour → bread,
   flax → linen; **first animals** (chicken coop with kelp and scraps already before, pen, fodder from the plots);
   **deer** at the plots, **foxes** at the chicken coop, **mice** in the granary, dog and cat as protection.
   Acceptance: ten figures in the
   harvest effort bring in a plot exactly once; tired soil gives less.
   - **Part 1, built 2026-10-30** (`server/engine/commands/field.ts`, test `tests/field.test.ts`, world version 20):
     the **plots**.
     - **Laying out:** `flur anlegen [x y]` breaks up a plot of 4×4 with a spade next to oneself. It lies in the light of a
       fire, occupies two light points, and each account has at most one. The plot is **one** `Field` entry over its
       cells; the cells are `Plot` entries with `unique` as with buildings and beds.
     - **Crops:** wheat, barley, oats (grain), potatoes (root crop), turnips and flax. Grain is its own seed; turnips give
       turnip seed, flax gives linseed back. Barley, oats, turnip and linseed are found by `sammle samen` in the wild
       flora. Wheat and potatoes Gesa carries when the world is created (8 each), she buys and sells everything of it.
     - **Sowing** (`bestelle <frucht>`): Whoever laid out the plot chooses the crop. Then it needs 4 seed and 2 work. Every
       `bestelle` brings the seed one carries, and one work point with the same rest (`WorkRest`) as at the building site.
       The growing time (two to three days) is stretched by fog as in the bed.
     - **Harvest effort:** The plot stays ripe for two days. Every `ernte` at it is a work point (8 per plot) and
       immediately gives a share of the yield, which was fixed at sowing. The shares add up exactly to the yield, the last
       point makes the plot fallow again. After that it is overripe for two days (each share half), then the crop is spoiled.
       NPCs and automata give at most half of the points, as at the building site.
     - **Crop rotation:** The plot counts how often the same kind (grain, root crop, turnips, flax) came in a row: the
       second time 60 % yield, the third time 35 %. A different kind or three days of fallow heal the soil.
     - **Writes:** The plot ticker runs in the garden job and writes a plot only at its appointments (ripe, overripe,
       spoiled, overgrown after two weeks without work).
     - **Map and help:** The map shows furrows, sprouts and the ripe crop in its color in 2D and 3D. The cell menu offers
       laying out, sowing, harvesting and opening. Help: section "Äcker" in the article "Gärten", topic `help ackerbau`.

     Acceptance (`tests/field.test.ts`):
     - Ten figures harvest at once: eight work points, all 16 barley in exactly eight pockets, the plot is fallow
       afterwards, and whoever comes later hears "liegt brach".
     - Barley after barley, and also oats after barley, gives 60 %. Potatoes after grain or three days of fallow give
       everything again.

     Deviations from the draft:
     - The plot has a fixed size of 4×4 instead of 4×4 to 8×8, because larger areas hardly fit into rooms of 24×16
       without closing paths.
     - The owner and, on an open plot (`flur offen`), all may harvest, also guests. Everyone keeps his share; a barn does
       not exist yet.
     - The harvest window opens a fixed deadline after sowing; there are no seasons yet.

   - **Part 2, built 2026-10-30** (`server/engine/commands/mill.ts`, test `tests/mill.test.ts`, world version 21):
     **windmill, bakery** and the chains grain → flour → bread and flax → linen.
     - **Windmill** (building plan 2×2: 8 driftwood, 2 kelp rope, 2 linen for the sails, 16 work, two light points).
       Anyone may grind at any mill: `mahle [n|alle] <korn>` takes wheat, barley or oats (up to 12 at once, at most three
       waiting sacks per figure). Every load is an `MillLoad` entry of its own with the time at which it is finished. It
       begins when the load before it is ground (`busyUntilWorldMs` at the mill, which `mahle` takes in its transaction),
       and needs one world hour per handful. While the mill grinds, nobody writes. `abholen` (up to two fields away) takes
       only one's own finished loads, never the mill. `mahle` alone says how long it still grinds.
     - **Storm tide:** On its island the waiting loads and the queue advance six hours. This is the only write of a ticker,
       in the storm job next to the rain barrels.
     - **Nothing is lost:** If a mill falls (demolition or ruin), the loads that were not yet ground give their grain back,
       immediately collectable at the place of the mill. What nobody collects for two weeks is cleared by the sweep.
     - **Bakery** (building plan 2×2: 6 driftwood, 6 shells, 1 kelp rope, 12 work). Recipes can now be bound to a building
       (`at` in the recipe, the world checks the plan). `craft brot` or `backe brot` makes, directly next to a bakery,
       whoever owns it, three loaves from 2 flour, a can of water and one driftwood (`count` in the recipe).
     - **Linen:** `craft spindel` (1 driftwood, 1 shell; a tool that wears out), then `craft leinen` (3 flax).
     - **Use:** Marta in Kupferhafen buys and sells flour, bread and linen. Four new jobs ask for them: bread for the tavern
       and the reef fishermen, flour for Ines, linen for a sail of the shipyard.
     - **Buildings per account:** at most five instead of two, because rain barrel and scarecrow count, and a hut with a
       barrel would otherwise have no room left for mill or bakery.
     - **Map and help:** Mill (tower, cap, four linen sails) and bakery (stone house with clay oven) in 3D. The cell menu
       offers grinding per carried grain, collecting and baking. Help: section "Mühle und Backhaus" in the article
       "Gärten", topic `help brot`, the recipes in the article "Handel und Handwerk".

     Acceptance (`tests/mill.test.ts`):
     - Five figures grind at once: five loads, none overlaps the one before, and none is collectable before its time. All
       collect at once, each gets exactly her two flour, and no load remains.
     - A storm tide on the island advances everything six hours, one on another island does not.
     - A demolition and a ruin give back the unground grain.
     - Bread exists only next to a bakery; linen only with a spindle, which is not used up in the process.

     Deviations from the draft:
     - Mill and bakery are not bound to epoch 2; epochs come only with step 4.
     - Linen is spun without a loom, because the workshop is still missing (step 5).
     - Wind exists only as storm tide; calms come with the seasons.
     - Bread does not yet sate ("Food" is later); it is trade and job goods.

   - **Part 3, built 2026-10-30** (`server/engine/commands/animals.ts`, test `tests/animals.test.ts`, world version 22):
     the **first animals**.
     - **Stables:** Chicken coop (2×1: 4 driftwood, 1 kelp rope, 6 work, up to 6 chickens) and pen (3×3: 8 driftwood, 4
       kelp rope, 8 work, up to 4 sheep or goats, one kind per pen).
     - **Animals as things:** Chicken, sheep and goat are things that Gesa sells (she carries initially 4 chickens, 2 sheep,
       2 goats) and that can be carried and traded. `einstallen` puts one into one's own stable like into a chest (place:
       the buildId), `ausstallen` takes it out. Therefore demolition gives the animals back and a ruin puts them into the
       estate, without code of its own.
     - **Feeding** (`füttere`, anyone may): one feed makes an animal sated for a world day, up to three days ahead.
       Chickens eat kelp, cabbage, carrots and grain, sheep and goats turnips, oats, barley, cabbage and kelp: the plots
       feed the farm.
     - **Yield:** Sated, a chicken lays an egg a day, a goat gives milk a day, a sheep wool every two days; hungry ones give
       nothing and lose nothing. Up to three per animal wait in the stable, `einsammeln` (also `sammle eier`, `melke`,
       `schere`) fetches them, only the owner.
     - **Offspring:** Two sated animals of a kind now and then get a young one (chickens every four, goats every five,
       sheep every six days), until the stable is full. So the stock grows beyond Gesa's supply.
     - **Writes:** The stable carries its herd (`herd`: kind, sated until, yield and offspring since `atWorldMs`). As with the
       rain barrel it is only recalculated when a command takes the stable; no ticker writes for animals.
     - **Use:** Gesa buys eggs, wool and milk; three new jobs ask for them.
     - **Map and help:** Chicken coop (little house on stilts with ramp and chickens) and pen (fence, trough, shelter, a
       sheep) in 3D; the cell menu offers looking, feeding, stabling, collecting. Help: section "Tiere" in the article
       "Gärten", topic `help tiere`.

     Acceptance (`tests/animals.test.ts`):
     - A stranger may feed, but not stable and not collect. Only what fits in is fed.
     - Three sated chickens give three eggs in one day, exactly once. Hungry, they give nothing.
     - After four sated days a chick is there, the nest holds three eggs per chicken. Demolition gives the chickens back, and
       a pen takes only one kind.

     Deviations from the draft:
     - Instead of a feed lease per animal, the stable carries a deadline for the whole herd.
     - The stables are not bound to epochs.
   - **Part 3b, built 2026-10-30** (same files, world version 23): **ducks, geese** and what becomes of the farm.
     - **Ducks and geese** in the pen (one kind per pen): ducks lay an egg a day, geese give down every three days. Gesa
       sells them (initially 3 ducks, 2 geese) and buys down.
     - **Geese keep watch:** Sated geese keep the hares away from all beds of their room; the hare flees when the geese
       cackle (since part 4 `wild.guards`, `guardsIn` in `wild.ts`).
     - **Loom** (building plan 2×1: 6 driftwood, 2 kelp rope, 8 work): `craft tuch` weaves a cloth from 3 wool with a
       spindle, `craft decke` sews a down blanket from 2 cloth and 3 down.
     - **Cheese:** `craft käse` makes a cheese at the hearth of a hut from 3 milk and one driftwood. Recipes at a building
       existed since part 2; a building plan can now carry its dative ("neben einer Hütte").
     - Marta buys cloth, blankets and cheese; three new jobs (tailor, trousseau, cheese for the reef fishermen).
     - Map: the pen shows its animals (sheep, goat, ducks at a puddle, geese); the gateway passes along the kind of the
       herd for this. The loom is an open shelter with a weaving frame. Whoever takes out the last animal empties the stable,
       and a different kind may go in.

     Acceptance (`tests/animals.test.ts`): sated geese protect the beds of their room, hungry ones do not; after the last
     sheep geese move into the pen and the page sees them; cloth only next to a loom, cheese only next to a hut.

     Deviations from the draft: The loom is a small building of its own instead of a part of the workshop (step 5); linen
     is still spun without a loom.

   - **Part 4, built 2026-10-30** (`server/engine/commands/wild.ts`, `animals.ts`, test `tests/prey.test.ts`, world
     version 24): the remaining **game** and its **guardians**. The wild ticker now knows four kinds; each rolls per room
     on its own (level 0 never, at most two per kind and room) and comes only where it can take something.
     - **Deer** come to a growing plot (3, 8 or 16 percent by fog level, doubled at night) and eat after three quarters of
       an hour: each bite costs 15 percent of the whole harvest, at most three times, so that 55 percent always remain. The
       yield is recalculated from crop, area and soil and stored in the plot before the harvest begins; a ripe plot is not
       touched by a deer, so that the shares of the harvest helpers add up. `flur` shows the bites.
     - **Foxes** come almost only at night (by day a tenth) to a chicken coop with at least two animals. Before one takes a
       chicken, the herd is settled up to now (`settleHerd`, with the young), so that nothing is lost that the chickens have
       already given. The last chicken stays.
     - **Mice** come to the chest of a hut with at least two pieces of grain, flour, bread or cheese and eat up to two of
       them, never the last. What lies in the chest the ticker reads only once the roll has hit.
     - **Protection:** `zäune` puts a fence around a bed as before, around one's own (or open) plot (6 driftwood, 2 kelp
       rope; keeps deer away) or around one's own chicken coop (3 driftwood, 1 kelp rope; keeps foxes away). The scarecrow
       now also protects plots within three fields. A **mousetrap** (recipe: 1 driftwood, 2 shells, 1 kelp rope) in the
       chest catches the mouse.
     - **Guardians** (`wild.guards`): sated geese keep hares and foxes away, a sated **dog** hares, deer and foxes, a sated
       **cat** the mice, each in the whole room. Dog and cat Gesa sells (initially two each). `einstallen hund` lets him
       keep watch at one's own building (one per building; he lies there as a thing like a herd, but does not belong to the
       chest), `füttere hund` (anyone may; eggs, bread, cheese, milk, the cat milk, eggs, cheese) makes him sated for a
       day, up to three days ahead, `ausstallen hund` takes him along. `wache` shows who keeps watch in the room.
     - `scheuche reh|fuchs|maus` as with the hare; the animal is an `Animal` entry with `kind` and `target` (hares keep
       `bedId`, so that entries from before the rollout continue to work).
     - Map: deer, fox and mouse in 2D (icons) and 3D, the fence around plot and stable, dog or cat at the corner of their
       building (3D only); the cell menu offers scaring away, setting a fence, letting watch, feeding and taking along.

     Acceptance (`tests/prey.test.ts`):
     - At night one deer, one fox and one mouse each come to the open targets, none to the last chicken or the last grain,
       none where the fire burns.
     - Only the open plot loses (exactly one bite), only the open stable a chicken (the herd settled beforehand), only the
       open chest two wheat. The fenced plot, the plot at the sated dog, the fenced stable, the chest with trap and the one
       at the sated cat lose nothing.
     - A player lets the dog keep watch at his hut; it does not lie in the chest, eats only its food and only what fits in.
       `scheuche reh` and the fence around one's own plot work as typed.

     Deviations from the draft:
     - Dog and cat follow no figure; they keep watch at a building over the whole room, like the geese.
     - The fence around the plot is not a row of cells with a gate, but belongs to the plot, like the fence around the bed.
     - Young trees and the orchard do not exist yet, so no browsing either; a granary of stone comes with the storehouse
       (step 5). The gulls at smokehouse and jetty are missing because neither exists yet.
     - The animal appears right at the target instead of running from the edge of the room (like the hare).
4. **Epochs and settlement**: points per building and garden, the counting ticker, `Epoch` per island, thresholds in the
   `Setting` entries, fallback; the settlement from huts in a room (name, right levels stranger, helper, settler).
   Acceptance: an island reaches the village from beds alone; if enough decays, it falls back, its buildings keep working,
   new plans of the level are blocked. Without this step there is no epoch 2 for step 5.
   - **Part 1, built 2026-10-30** (`server/engine/commands/epoch.ts`, test `tests/epoch.test.ts`, world version 25): the
     **epochs**.
     - **Points:** Every building, every bed and every plot that still stands (`untilWorldMs` not elapsed) counts with its
       light points towards the held holdings of its island: hut, bed, chicken coop, rain barrel, scarecrow, loom 1 each,
       plot, communal bed, windmill, bakery, pen 2 each. A plot also counts fallow, otherwise an island near the threshold
       would fall back after every harvest.
     - **Thresholds** as settings in the operator's window: `epoch.dorf` 15, `epoch.stadt` 40, `epoch.netz` 80
       (`SPACES_MMO_EPOCH_*`). Every island has at least one fire with 20 light points, so the village is reachable
       everywhere, but not by one account alone (at most five buildings, three beds, one plot: about 10 points).
     - **Counting:** Job `epoch` every world hour and once at the start of the world worker, per region over the islands of
       its rooms. It writes the `Epoch` entry of an island only when the level changes, and tells all rooms of the island.
     - **Blocked** in the fishing village: new windmills, bakeries, pens, looms (`PlanDef.epoch`) and plots
       (`FieldDef.epoch`). `bau` and the cell menu show "ab Dorf". What already stands or is staked out as a building site
       works and is built on; recipes at a building (bread, cloth, cheese), grinding and collecting do not ask for the epoch.
     - `epoche` shows level, points (by buildings, beds, plots) and what the next level unlocks; help `help epochen`.

     Acceptance (`tests/epoch.test.ts`):
     - 14 beds are not enough, the 15th makes the Graue Insel a village; an overgrown bed does not count, another island
       counts for itself. Two beds fewer, and it is a fishing village again.
     - A player gets "braucht ein Dorf" in the fishing village for windmill and plot, in the village he may stake out the
       bakery. After the fallback a standing bakery keeps baking, a new windmill is blocked again.

     Deviations from the draft:
     - Counting is hourly instead of once per world day and after every building; this costs a few reads per region and
       hour, but writes only on a change.
     - "Maintained and upkeep paid" means for now: not decayed. Upkeep from the storehouse comes with step 5.
     - Mill, bakery, pen, loom and plots existed since step 3 without an epoch; they are now plans of the village as in the
       draft. Town and network have no plans of their own yet.

   - **Part 2, built 2026-10-30** (`server/engine/commands/settlement.ts`, test `tests/settlement.test.ts`, world version
     28): the **settlement**. If three huts of at least two owners stand in a room, a hut owner founds one with
     `siedlung gründen <name>` (one entry per room, `unique` on room and per region on the name). Hut owners are settlers,
     others are admitted by a settler (`siedlung aufnehmen <name> [helfer]`, `entlassen`), guests at most as helpers.
     When open, the levels bind nobody; `siedlung zu` restricts building, beds and plots to settlers, delivering and
     working to settlers and helpers. If too few huts stand, it ends with the counting of the epochs. Settlers (the script
     figures) found themselves, named after the room.

     Acceptance (`tests/settlement.test.ts`): too few huts, name, rights in open and closed settlement, guest as helper,
     end on decay.

     Deviations from the draft: Rights are levels on the settlement entry instead of locks; communal beds and the
     storehouse do not ask for them yet (the storehouse comes with step 5).
5. **Workshops, quarry, storehouse** (with withdrawal log and quota), new recipes, jobs of the building sites on the
   board; script NPCs accept them, the role `bauhelfer` is added, and `liefere`/`arbeite` move into the
   `AutomatonCmdSet` along with the template "Baustellenhelfer". **Automaton bodies** as workshop recipe (rope, gear,
   housing).
   - **Part 1, storehouse (built, `server/engine/commands/build.ts`):** Building plan from epoch village (3×2: 12
     driftwood, 4 kelp rope, 6 shells, 20 work, 3 points, room for 120 things). `verstaue` and `entnimm` work next to it
     as at the chest, but the own chest takes precedence; `lager` shows content and rest of the quota, `lager log` the
     storage book.
     - Without a settlement it is the chest of its owner. In a settlement the ranks apply, even when it is open: per world
       day strangers may take 2 things, helpers 5, settlers 20 (`building.store.quota`). Anyone may store, in a closed
       settlement strangers stay entirely outside.
     - Every movement is a `StoreLog` line with 3 days of lease; the quota is also counted from them.
     - Deviations from the draft: In a settlement the owner too has only the quota of his rank, and a storehouse with
       content cannot be demolished there. If it decays, the content goes, as with any building, to the owner (`nachlass`);
       `reisse baustelle ab` does not yet give anything into the storage. Open remain quarry, workshops, building-site
       jobs and `bauhelfer`.
   - **Part 2, stone and workshop (built, `server/engine/commands/quarry.ts`):** Stone lies as rubble on the beaches (a
     tide base load of 2 per island). From it arises the pickaxe (6 uses).
     - **Quarry** (from village, 2×2, 3 points): `breche` gives, next to it with the pickaxe, 3 stone and afterwards the
       same rest as `arbeite`. Anyone may break at any quarry, in a closed settlement helpers and settlers.
     - **Workshop** (from village, 3×2, 3 points, 8 stone): recipes plank, rope, housing (housing and rope are two of the
       three parts of the automaton body). Next to it a tool wears out only half as fast.
     - Deviations from the draft: The rubble comes with the tide to the beaches instead of only to cliffs; the quarry needs
       no rocks in the room yet; one workshop instead of carpentry, ropery and smithy. Gears are missing because there is no
       iron yet. Open remain clay and brick, building-site jobs, `bauhelfer` and the automaton body.
   - **Part 3, site orders and `bauhelfer` (built, `server/engine/commands/siteorder.ts`):** The owner of a site hangs out a
     wage with `aushang 5 treibholz je 1` or `aushang 4 arbeit je 2`. The coins lie with the order from then on; whoever
     delivers or works gets them in the same transaction, person or NPC, first come first paid. What was not paid goes back on
     `aushang ab`, on completion, demolition and decay, or waits as an estate while the owner is in another region. `baustelle`
     and the region's boards show the orders. Gatherers bring what their rooms pay for; four day labourers (Wolter, Bertje,
     Hinrich, Tette) work only for a wage. The NPC half limit still holds. Deviations: no `heuere`; traders do not buy for
     sites yet; the wage comes from the owner only; one labourer per region. Automata wait for phase 6.
   - **Part 4, clay and bricks (built, `server/engine/commands/quarry.ts`):** A clay pit gives 3 clay with `steche` and a
     spade, then a rest; the spade does not wear. Beside a brickworks `craft ziegel` burns 3 clay and 1 driftwood into 3
     bricks. Both plans from the village epoch. Deviation: the pit needs no moor or shore. No plan uses bricks yet.
6. **Town hall, chapel** (zones, taxes, votes, festivals with the gods), **settlement population**, first
   **parks** and the flower show.
   - **Part 1, settlement population (built, script `dorfbewohner` in `server/npc/settlers.ts`):** Two villagers per fire wait
     offline until a settlement in that fire's light has 5 and 10 buildings. Then they add wood when the fire burns low, water
     the community beds from a barrel of the village and chat on the square. When the settlement goes, they go.
     Deviation: at most two per fire instead of any number, because NPCs are fixed in the world file.
7. **Department store** (shop with stock), **counting house**, **lighthouse**, **brewery**, **glassworks and greenhouse**,
   fishing (net recipe, jetty) and boats; **food** (being sated), when bread and smoked fish exist.
8. **Roads, carts, timetable ferries**, then the **island railway** as automaton.

## Open questions

Decided: rooms grow **and** new ones arise; churches are voluntary (the gods work without them); competition is
nonviolent (festivals, reputation, regatta); animals come early. Still open:

- How far does a room grow before a new one arises — and does it grow in whole cell strips or graduated?
- How much livestock does the tone bear — chickens, sheep and goats on the farm, or also cattle trade and breeding as a
  chain of its own?
- How many light points does a fire carry, and does a fixed number suffice, or does it grow with the number of players of
  an island (like the flotsam, `flood.perPlayers`)?
- Does wind come as weather with the seasons, or does the storm tide stay the only weather (then the mill always grinds
  at the fixed pace)?
