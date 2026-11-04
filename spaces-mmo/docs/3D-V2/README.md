# 3D view, version 2: mockups

Mockups for a second version of the optional 3D view (`client/MapView3D.tsx`), drawn 2026-11-03. Nothing here is implemented; the pictures show the direction. Everything in them is the client's view of the same room data: the grid, walkability and every action stay as they are on the server (docs/architektur.en.md, "3D-Ansicht").

The idea: every room is a diorama block, the island is the group of blocks, and one zoom slider goes from the island down to a figure's face. The camera elevation is a function of the zoom, so a pinch does both. Levels of detail cross-fade over half a second.

| Level | Zoom | Camera | Picture |
| --- | --- | --- | --- |
| 1 Island | ≤ 0.3 | 60° | `stage1-island.png` |
| 2 Approach | 0.3 to 0.6 | 52° | `stage2-approach.png` |
| 3 Room | 0.6 to 2 | 40° to 30° | `stage3-room.png` |
| 4 Close | 2 to 5 | 30° to 22° | `stage4-close.png` |

`ladder.png` shows all four side by side with the slider.

- **1 Island.** Every room a block with a lid; the own room rendered in full, neighbours by lid colour, a few landmarks and a name card with the figure count, unvisited rooms as grey raw blocks. Ferries as dashed lines, figures as dots. One mesh per block. A tap flies in. Replaces the minimap.
- **2 Approach.** The block fills the frame, its edges are the room's edges: rock strata on the land side, the sea as a volume with fish and the sand slope showing through. Neighbours blurred at the edge; a tap on one is the ferry.
- **3 Room.** Today's play view with terraces and side faces (today the tile heights lie between 0.08 and 0.36 units), sun shadows (off today), lit windows. The block edge stays in view, neighbours on the horizon.
- **4 Close.** The zoom limit moves from 3 to 5. Near the camera, models swap for detailed twins (face, hat, satchel, barrel hoops, cobbles as geometry); the fire is a real point light; chat as bubbles; the background out of focus.

The game's fog levels (0, 20 %, 35 %, 50 %) map onto the ladder: on level 1 the fog hides neighbour blocks, on 2 it fades the block's side faces, on 3 and 4 it tightens the vignette.

## Catalogue of today's objects

Four sheets redraw every object the 3D view has today in the v2 style (closed roofs with ridge and overhang, two tones per material, bevelled edges). Nothing new is invented; the sheets are the target look for the existing builders.

| Sheet | Contents | Builders |
| --- | --- | --- |
| `sheet1-plants.png` | tree, conifer, bush, berrybush, flower, herb, grass, fern · bed sorts flower, rose, mist, cabbage, carrot, hops · field crops grain, tuber, beet, flax · bed stages, fence, weedy bed | `props3d.ts` plantGeometry, cropGeometry, fieldCropGeometry, fenceGeometry |
| `sheet2-buildings1.png` | hut, rain barrel, scarecrow, windmill, bakery, hen house, pen (sheep, goat, cattle, duck, goose), loom, jetty · boat, barrels, crates, stall, salt basin, hull, rocks, wall, tower stump, kiln · signal fire, fire ring | `props3d.ts` buildingGeometry, fireGeometry · `buildings3d.ts` sceneryModel, signalFire |
| `sheet3-buildings2.png` | storehouse, quarry, clay pit, brickworks, chapel, park, town hall, workshop, smokehouse, department store, counting house, brewery, glassworks, shipyard, greenhouse, lighthouse, station · site, ruin, signpost | `buildings3d.ts` buildingModel · `props3d.ts` siteGeometry, ruinGeometry, signGeometry |
| `sheet4-animals-vehicles.png` | hare, deer, fox, mouse, gull · dog, cat · sheep, goat, cattle, duck, goose, hen · figure (own, npc) · cart, train and carriage, liner, track | `props3d.ts` wildGeometry, keeperGeometry, pen · `figure3d.ts` · `MapView3D.tsx` cart, train, track · `buildings3d.ts` linerGeometry |

The roofs in the first v2 pictures (stage 2 and 3) were drawn open by mistake; the game's roofs are closed (`gable` in `buildings3d.ts` builds both gables, both slabs and the ridge). The catalogue sheets show them closed.

## Implemented

`built-stage1.jpg` to `built-stage4.jpg` are screenshots of the implemented levels (island, approach, room, close), taken from the local dev container with headless Chromium. The ladder, the blocks, the terraces, the sun's shadows, the island level, the bubbles, the vignette, hats and satchels on the figures and fascia boards on the roofs are in the client (`client/camera3d.ts`, `client/block3d.ts`, `client/MapView3D.tsx`; docs/architektur.en.md, "Zoom ladder and diorama"). The server needed nothing: `AtlasView` already carries every room's place, ground and links, and `AtlasState` its fog and people. Two points differ from the pictures: there is no "not yet visited" state, so a neighbour's lid is greyed by its fog instead of drawn as a raw block, and tapping a neighbour's block does nothing (changing rooms stays a command; the beam on the world map is unchanged).

Added afterwards (2026-11-04): a seabed and fish behind the sea sides, and day and night from the world's clock with
glowing windows, lanterns and kiln mouths (`built-night.jpg`, `built-sea.jpg`).

Not done from the pictures: detail twins that swap in near the camera (the figures' new details are always on, which the
model budget allows), the fire as a real point light, and a measured frame budget on a real phone. The catalogue sheets match the existing builders; apart from the figures and the roof edges the models are
unchanged, because the builders already have what the sheets show (closed gable roofs, flat-shaded two-tone faces, 3D
flowers, herbs, grass and ferns).
