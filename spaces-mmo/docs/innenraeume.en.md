# Interiors: going into a house (plan)

Status 2026-11-11: step 1 (the hut) is built: server/engine/commands/interior.ts, tests/interior.test.ts; step 2 (sleep) as
well: server/engine/commands/sleep.ts, tests/sleep.test.ts; step 3 (bakehouse and butcher's shop) too: their layouts in
worlds/leuchtfeuer/world.ts, tests/interior-shops.test.ts. It extends [siedeln.en.md](siedeln.en.md) (buildings, recipes, chests,
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
2. **Sleep puts the rest off, it does not replace it**: without a bed the rest after work stays as it is. A sleep in a
   bed makes the figure rested: afterwards it works without a rest for a while, up to 8 works, more the longer it
   slept (see "Sleep").
3. **A plan first**, then the hut, then the other buildings one after the other (see "Order").
4. **An invited guest may sleep in the host's bed.**
5. **The furnishings are fixed by the plan** for now; placing more furniture may come later.

## The interior room

- **A room of its own per building**, made when the site becomes a building (build.ts, where a site completes), with
  the id `in-<buildId>`. It is a normal Room entry like the rooms a builder digs (`dig` in builder.ts): ground, spawn,
  exits. It lies in the region of its building; a dug room already stays in the region it was dug in (regions.ts
  `regionOfRoom`), so the interior needs no new region rule.
- **Its size and layout come from the plan**: `PlanDef.interior = { w, h, ground: string[], furniture: [...] }` in
  world-def.ts, with the layout in world.ts beside the plan (a hut 6×5, a bakehouse 7×5 …). New tiles for the floor
  (`_` planks) and the walls (`#`, not walkable), defined in `world.tiles` like the others.
- **The door**: no exit leads in from outside. `betrete` beside the building (its menu: „Hineingehen“) takes the owner or
  an invited guest to the spawn inside; an Exit „hinaus“ on the door cell inside leads out in front of the building
  (a free cell below its middle first). An exit on the map outside would stand on every hut for everyone, stop a
  stranger's walk at the door and show up in every room description and NPC's way list.
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
- `betrete` lets in the owner and the invited; everyone else hears „Die Tür ist zu. Hinein dürfen nur … und wer
  eingeladen ist.“
- Uninvited (`ausladen`), a guest inside is put outside with a message; leaving the owner's settlement or the game does not
  matter, the invitation stays until taken back or the building goes.
- NPCs do not go in. Settler NPCs (settlers.ts) keep working from outside.

## Furnishings

Furnishings are things placed in the interior, `fixed` (not taken, not moved), each with its menu. Their place is in
the plan's `interior.furniture: [{ kind, x, y }]`.

| Building | Furnishings | Inside, beside it |
| --- | --- | --- |
| Hut | hearth, bed, chest, table | the hut's recipes at the hearth; sleep in the bed; truhe / verstaue / entnimm at the chest |
| Bakehouse | oven, kneading trough | bread and cake (the recipes at backhaus) |
| Butcher's shop | block, hooks, pickling barrel | schlachte a carried animal, metzgerwurst, salted meat at the block; the barrel is its chest |
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
shortened by being sated. This stays: **without a bed nothing changes.**

New:

- **Sleeping in a bed**: `schlafe` beside one's bed (or an invited guest beside the host's bed) lays the figure down
  (a `Sleep` entry: the bed, since when). The bed holds one. Asleep it does nothing: the next command it sends only
  wakes it („Du wachst auf nach …“) and is not run. The command path looks for a `Sleep` only when the actor is inside a
  building, so a step outside costs no read. Logged out in bed, it sleeps on; coming back (the page's `arrive`) wakes it. Put out of the house (`ausladen`, the
  building gone) it wakes outside with what it slept. The map showing it lying in the bed comes with step 5.
- **Rested**: the sleep gives the figure rested works (a `Rested` entry per figure: how many are left). The longer it
  slept, the more: proposed 1 work per 30 world minutes of sleep (setting `sleep.rate`), at most 8 (setting
  `sleep.max`), so 4 world hours of sleep give the full 8. Waking earlier keeps what was slept so far.
- **A rested work writes no rest**: `tire` takes one rested work instead of writing a WorkRest while any are left;
  when they are used up, the rest after work comes back as today. So sleep only puts the tiredness off.
- **Food and blessing** keep their effect on the rest when there is one.
- Waking and every rested work say how many are left (there is no `ich` command); the bed's menu shows „Schlafen“.
- Like `WorkRest` and `Sated`, `Rested` is an entry of the house's region: crossing to another region leaves it there.
- NPCs and settlers keep their rest as today (they have no beds; settlers.ts works around WorkRest).

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
| Sleep and rested works | a new server/engine/commands/sleep.ts; `tire` in build.ts, field.ts, fishing.ts, quarry.ts, road.ts; settings `sleep.rate`, `sleep.max` (server/settings.ts) |
| Jobs that skip interiors | wild.ts, fire.ts (flood, storm), fog, the atlas in gateway.ts |
| Furnishings as objects | gateway.ts ObjView kind "furniture" (or fixed scenery with a `use`), shared/frames.ts |

## Tests

- An interior made at completion with its exits; the sweep gives old buildings one, once; the room goes with a ruin and a
  vote, figures put outside, things to the estate.
- The door: owner in, invited in, stranger refused, an uninvited guest put out.
- Each command at its furnishing inside as beside the building outside, and refused inside at the wrong furnishing.
- Sleep: rested works by the length of the sleep, at most 8; a rested work writes no rest; used up, the rest comes back;
  a command wakes; a guest sleeps in the host's bed; without a bed nothing changes.
- Settlers and NPCs unchanged (settlers.test.ts, the economy).
- cell-actions: the furnishings' menus, „Hineingehen“ only for who may.
- The play test (`test:play`) through a hut: in, cook, store, sleep, out.

## Order

1. **The hut** (built): its interior with hearth, bed, chest and table; the door with invitations; cooking and the
   chest inside; 2D tiles and a plain 3D room.
2. **Sleep** (built): the bed, rested works, their settings and the help.
3. **Bakehouse and butcher's shop** (built) with their furnishings: oven and kneading trough; block, hooks and a pickling
   barrel as the chest. A furnishing's `use: "cook"` is where the building's recipes are made (the hearth, the oven, the
   block); at the butcher's the block also slaughters.
4. **The other workshops** (smokehouse, workshop, loom, brewery, glassworks, tannery, brickworks, shipyard).
5. **3D finish**: models of the furnishings, light, the figure lying in its bed.

Each step is deployed on its own after the full suite.

## The Rust port

The engine is being ported to Rust against a frozen TypeScript commit (docs/rust-portierung.en.md R8.2). Everything
here is new engine behaviour after that commit: it is ported after R8 or as a step of its own, and the walks
(`tests/engine_walk.rs`) need it then. It does not block R8; it only grows what is left to port.

## Open questions

- **The rate** (`sleep.rate`, 1 work per 30 world minutes, and `sleep.max` 8): settings in the admin page; the defaults are a proposal.
- **Inns**: a bed for anyone at a fee (a tavern building) would give guests and travellers a place to sleep; not part
  of this plan unless wanted.
