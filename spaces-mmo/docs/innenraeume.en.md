# Interiors: going into a house (plan)

Status 2026-11-10: a plan, nothing of it is built. It extends [siedeln.en.md](siedeln.en.md) (buildings, recipes, chests,
the rest after work) and [welt.en.md](welt.en.md) (rooms and exits).

## What it is for

Today everything a building offers is done from outside, standing beside it: cooking at a hut („Rührei“, roasts,
cheese), its chest (`truhe`, `verstaue`, `entnimm`), baking at the bakehouse, slaughtering at the butcher's shop, the
workshop's tools. A building is a block on the map.

With interiors a figure steps through the door into the house. Inside stand the furnishings that do the work: a hearth
for cooking, a bed for sleeping, the chest; an oven and a kneading trough in the bakehouse, a block and hooks at the
butcher's, a bench in the workshop. What a building does becomes visible and has a place, and the hut becomes a home.

## Decisions (2026-11-10)

1. **Who goes in:** the owner and the guests they invite. Nobody else, not even into a bakehouse or a butcher's shop.
   What a building offers from outside stays as it is, so a stranger still bakes at anyone's bakehouse from beside it.
2. **Sleep replaces the rest after work:** no more waiting out a rest after each work point. Tiredness builds up, and a
   bed takes it away (see "Sleep").
3. **A plan first**, then the hut, then the other buildings one after the other (see "Order").

## The interior room

- **A room of its own per building**, made when the site becomes a building (build.ts, where a site completes), with
  the id `in-<buildId>`. It is a normal Room entry like the rooms a builder digs (`dig` in builder.ts): ground, spawn,
  exits. It lies in the region of its building; a dug room already stays in the region it was dug in (regions.ts
  `regionOfRoom`), so the interior needs no new region rule.
- **Its size and layout come from the plan**: `PlanDef.interior = { w, h, ground: string[], furniture: [...] }` in
  world-def.ts, with the layout in world.ts beside the plan (a hut 6×5, a bakehouse 7×5 …). New tiles for the floor
  (`_` planks) and the walls (`#`, not walkable), defined in `world.tiles` like the others.
- **The door**: an Exit „hinein“ on the cell in front of the building's door side (outside, walkable, free), arriving
  on the spawn inside, and an Exit „hinaus“ inside, arriving in front of the door. Its locks carry the access (below).
- **Its life follows the building**: the building decays, falls to a ruin or is voted away (demolishByVote): the room
  goes with it. Figures inside are put in front of the door, and things lying on the floor go to the estate (`nachlass`) as a
  chest's do. A sweep at start gives every standing building of a plan with an interior its room once (as the jetty
  sweep did, `jettiesMoved` in build.ts).
- **Not in the atlas or the room list**: an interior is no place of the island. The atlas (gateway `#stops`, AtlasView)
  leaves `in-` rooms out; the figure's place in the atlas is its building's room.
- **No fog, no wild, no tide, no light points inside**: the jobs that walk over rooms (wild.ts, fire.ts flood and
  storm, fog) skip interiors. The fire's light counts the building outside as today.

## Access

- `einladen <name>` beside or inside one's building: that player may go in (a list on the Building, `guests: string[]`
  of charIds); `ausladen <name>` takes it back; `einladen` alone lists them. In a settlement nothing changes: a
  building belongs to its owner.
- The exit „hinein“ lets in the owner and the invited (an exit lock as a builder writes them, `traverse:` with a new
  lock function `host()`/`guest()`, or a check in the move code for exits into `in-` rooms; the check is simpler and
  does not need the lock language). Everyone else hears „Die Tür ist zu. Nur … und wen sie einlädt.“
- Uninvited, an invited guest is put outside with a message; leaving the owner's settlement or the game does not
  matter, the invitation stays until taken back or the building goes.
- NPCs do not go in. Settler NPCs (settlers.ts) keep working from outside.

## Furnishings

Furnishings are things placed in the interior, `fixed` (not taken, not moved), each with its menu. Their place is in
the plan's `interior.furniture: [{ kind, x, y }]`.

| Building | Furnishings | Inside, beside it |
| --- | --- | --- |
| Hut | hearth, bed, chest, table | the hut's recipes at the hearth; sleep in the bed; truhe / verstaue / entnimm at the chest |
| Bakehouse | oven, kneading trough | bread and cake (the recipes at backhaus) |
| Butcher's shop | block, hooks | schlachte a carried animal, metzgerwurst, salted meat |
| Smokehouse | smoking rack, chest | the smokehouse's recipes, its chest |
| Workshop | bench, tool wall | the workshop's recipes (planks, cart, case …) |
| Loom house | loom | cloth, quilt |
| Brewery, glassworks, tannery, brickworks, shipyard | their one piece each | their recipes |
| Warehouse, department store, counting house, town hall | later, if wanted | their commands stay outside first |

Windmill, quarry, clay pit, salt garden, park, greenhouse, lighthouse, signal fire, station, coop, pen and hive get no
interior: their work is outside or the building is a place, not a house.

## Commands inside

The commands keep their words. What changes is where they count as "at the building":

- `craft`, `backe`, `truhe`, `verstaue` (beside: this chest), `entnimm`, `schlachte` (at the butcher's), the
  smokehouse's: today `distTo(actor, building) <= 1` in the room of the building. New: **or** standing beside the
  furnishing that does it in that building's interior. One helper in build.ts, `atBuilding(c, plan)`, answers both and
  returns the building; every such command calls it instead of reading Buildings beside the figure itself (they do
  it in several ways today: trade.ts craft, mill.ts backe, build.ts chestHere, animals.ts schlachte).
- The menus (client/cellActions.ts): the furnishing's cell offers what the building's cell offers today (hearth →
  the hut's recipes one carries enough for and „Was man hier herstellen kann“; chest → „Truhe ansehen“ and the kinds to
  take out; bed → „Schlafen“). The building's own menu outside gets „Hineingehen“ for who may.
- The pack's recipes (itemEntries) need no change: they already offer a recipe anywhere and the server says where.

## Sleep

Today each work point (`tire` in build.ts and field.ts, quarry.ts, fishing.ts `segle`/`schaufle`) writes a WorkRest
until which the figure may not work again: 15 world minutes (setting `work.rest`), halved by the chapel's blessing,
shortened by being sated.

New:

- **Tiredness instead of a rest**: each work point adds to the figure's tiredness (`Tired` entry per figure: points and
  when last changed) what the rest was: `work.rest` minutes, halved blessed, shortened sated. The figure works on while
  its tiredness stays below a limit (setting `sleep.need`, proposed 8 work points' worth, 120 world minutes);
  at the limit it is exhausted: „Du bist zu müde; schlaf dich aus.“
- **Sleeping in a bed**: `schlafe` beside one's bed (or an invited guest beside the host's bed) lays the figure down.
  It is asleep until its tiredness is gone, at a rate of `sleep.rate` (proposed: 1 world hour of sleep takes 2 hours of
  tiredness). Asleep it does nothing; any command wakes it (`Du wachst auf`) with what is left of its tiredness.
  The map shows it lying in the bed.
- **Without a bed**: tiredness also wears off by itself, slowly (proposed: at a quarter of the bed's rate, the same
  amount of rest as today spread out), so a guest without a hut and a new player still play. Whether this is wanted or
  only a bed helps is open (see "Open questions").
- **Food and blessing** keep their effect: they make each work point tire less, as they shortened the rest.
- The help and the stats say how tired one is (`ich` / the figure's panel), the menu shows „Schlafen“ at the bed once
  one is tired at all.
- NPCs and settlers keep their rest as today (they have no beds; settlers.ts works around WorkRest).

This changes the rhythm of the game for everyone: many short works, then a sleep, instead of a work every quarter
hour. It is the largest part of this plan in its effect and goes in step 2, after the interiors stand.

## Client

- **2D map** (MapView.tsx): the new tiles (planks, wall) and an icon per furnishing; the interior is a small room like
  any other.
- **3D map** (MapView3D.tsx, props3d.ts, buildings3d.ts): an interior is drawn as a room with walls on its edges, a
  door, a window light, no roof; furnishings as small models (hearth with fire, bed, chest, oven, block, bench, loom).
  The camera comes closer in a room this small (the close-up level of camera3d.ts).
- **The door**: stepping on it or „Hineingehen“ in the building's menu (go hinein). Inside the room's name is
  „Hütte von Mira“, and „hinaus“ leads out.
- The atlas and the travel note ignore `in-` rooms.

## Server parts

| Part | Where |
| --- | --- |
| `PlanDef.interior`, the tiles, the layouts | shared/world-def.ts, worlds/leuchtfeuer/world.ts, world:json |
| Room and exits at completion, the sweep for standing buildings, the room's end with the building | server/engine/commands/build.ts (completion, decay, ruin, demolishByVote, buildSweep) |
| `einladen` / `ausladen`, the door check | build.ts (Building `guests`), server/engine/commands/default.ts or the move code (exits into `in-` rooms) |
| `atBuilding(c, plan)` and the commands that use it | build.ts, trade.ts craft, mill.ts backe, animals.ts schlachte, the chest commands |
| Tiredness and sleep | a new server/engine/commands/sleep.ts; `tire` in build.ts, field.ts, fishing.ts, quarry.ts, road.ts; settings `sleep.need`, `sleep.rate` (server/settings.ts) |
| Jobs that skip interiors | wild.ts, fire.ts (flood, storm), fog, the atlas in gateway.ts |
| Furnishings as objects | gateway.ts ObjView kind "furniture" (or fixed scenery with a `use`), shared/frames.ts |

## Tests

- An interior made at completion with its exits; the sweep gives old buildings one, once; the room goes with a ruin and a
  vote, figures put outside, things to the estate.
- The door: owner in, invited in, stranger refused, an uninvited guest put out.
- Each command at its furnishing inside as beside the building outside, and refused inside at the wrong furnishing.
- Tiredness: work up to the limit, refused beyond; sleeping takes it at its rate; a command wakes; without a bed it
  wears off slowly (if kept); food and blessing tire less.
- Settlers and NPCs unchanged (settlers.test.ts, the economy).
- cell-actions: the furnishings' menus, „Hineingehen“ only for who may.
- The play test (`test:play`) through a hut: in, cook, store, sleep, out.

## Order

1. **The hut**: its interior with hearth, bed, chest and table; the door with invitations; cooking and the chest inside;
   2D tiles and a plain 3D room. Sleep not yet: the bed is there, `schlafe` says what it will do.
2. **Sleep** replaces the rest (tiredness, the bed, the slow wearing off), with its settings and the help.
3. **Bakehouse and butcher's shop** with their furnishings.
4. **The other workshops** (smokehouse, workshop, loom, brewery, glassworks, tannery, brickworks, shipyard).
5. **3D finish**: models of the furnishings, light, the figure lying in its bed.

Each step is deployed on its own after the full suite.

## The Rust port

The engine is being ported to Rust against a frozen TypeScript commit (docs/rust-portierung.en.md R8.2). Everything
here is new engine behaviour after that commit: it is ported after R8 or as a step of its own, and the walks
(`tests/engine_walk.rs`) need it then. It does not block R8; it only grows what is left to port.

## Open questions

- **Without a bed**: should tiredness wear off by itself (slowly), or only in a bed? Without it a guest (no account,
  no hut) can only sleep as someone's guest.
- **The limit and the rates** (`sleep.need`, `sleep.rate`): the numbers above are proposals.
- **A shared bed for guests**: may an invited guest sleep in the host's bed, or only the owner?
- **Inns**: a bed for anyone at a fee (a tavern building) would give guests and travellers a place to sleep; not part
  of this plan unless wanted.
- **Furnishing more**: may an owner place more furniture (a second chest, a table bought from the workshop), or is the
  interior fixed by the plan? Fixed first.
