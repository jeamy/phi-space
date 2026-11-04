# 3D view, version 2: mockups

Mockups for a second version of the optional 3D view (`client/MapView3D.tsx`), drawn 2026-11-03. The original pictures show the design direction; the implementation status and its differences are recorded below. Everything in them is the client's view of the same room data: the grid, walkability and every action stay as they are on the server (docs/architektur.en.md, "3D-Ansicht").

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

All four catalogue families now have cached procedural far, room and near geometry variants (`client/modelDetail3d.ts`), including plants, every bed stage and field crop, early and later buildings, scenery, wild and domestic animals, figures, carts, trains, liners and track pieces. Far geometry uses fewer facets; room geometry adds bevelled box edges and consistent light/dark face tones. Near variants add finer curved forms and family-specific details: leaf midribs and fern leaflets, tree bark, grain awns and flax blossoms, a hop trellis and branching baby's breath, roof courses, door planks and knobs, window crosses and sills, chimney courses, barrel seams and hoops, crate braces, animal eyes and whiskers, sheep wool and cattle patches, and figure eyebrows, ears, buckles and seams. Existing catalogue forms are retained and upgraded procedurally, not replaced by imported art assets.

Far geometry enters below zoom 0.55 and stays until zoom exceeds 0.65. Near detail requires zoom 2 or above and a camera distance of at most 16 world units; it remains until 18 units (hysteresis). A shared selector updates at most every 150 ms, prioritizes nearby models, and limits near detail to 48 meshes and 120,000 model triangles including instances; the rest retain room detail. These are geometry budgets, not a measured phone frame-rate guarantee. Plants are instanced in 4×4-cell batches so that nearby detail does not upgrade every plant in the room. Rain barrels retain their separate detailed staves, hoops and rivets. Up to 24 nearby paving cells gain instanced cobblestones (16 per cell). The original mouth, hats and satchels remain visible at every distance; the new fine facial and clothing details appear only close up.

Alt+mouse wheel tilts the camera without zooming, in 3° steps. The manual offset is limited to ±25° relative to the zoom ladder, with the actual elevation limited to 14°–75°. Ordinary wheel and trackpad pinch still zoom. Dragging uses the actual camera elevation so the ground remains under the pointer. The offset is saved per browser, set to +15° for a new guest or registration, and can be cleared with the inclination-reset button when nonzero.

The development canvas exposes `probeCatalogue(names, level)` for visual checks of these builders; reload to return to the game. The catalogue tests verify all model families, stages, geometry attributes, shared variants, capsule dimensions, hysteresis, budgets and animated figure parts. Browser checks render all four catalogue sheets at all three detail levels.

The close view also gains depth-aware background blur (`client/closeuppost3d.ts`, Three.js BokehPass), fading in from zoom 2 to 5. The focus plane passes through figure height at the camera's look centre. Name cards and speech bubbles are rendered afterwards and remain sharp. Other zoom levels bypass postprocessing. Postprocessing targets are capped at one render pixel per CSS pixel, and the shadow map is updated only once per frame rather than again for the depth pass. Speech bubbles already appear at zoom 1.6 for eight seconds; the vignette fades in above zoom 1 rather than switching on abruptly at the close level.

The signal fire already has an actual `PointLight`, with intensity 4 while lit; windows and kiln mouths use emissive material instead of a light per building. Not every decorative fire is a separate light.

A measured frame budget on a real phone remains outstanding. The `FPS messen` button in the 3D controls captures 30 seconds after a two-second warm-up, with FPS, median/p95/p99 frame interval, draw calls, the final frame's triangle count, geometry count, zoom range, viewport, pixel ratio and browser identification. A countdown includes the two-second warm-up. Completion shows an explicit result below the measurement buttons, above the small minimap, with separate JSON-download and close buttons; nothing is uploaded. Results stay in the current view and are cleared by a full page reload. Hiding the page or restarting the renderer cancels the sample and shows an explanation. Keep the page visible, repeat at island, room and close zoom, and record the physical phone model, browser and thermal state alongside the files. Browser emulation is not a substitute for this measurement. The existing `built-*.jpg` screenshots predate these close-up additions.
