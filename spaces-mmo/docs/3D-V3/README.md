# 3D view, version 3: towards a detailed, near-photorealistic world

Plan and status of the rebuild of the optional 3D view (`client/MapView3D.tsx`) from the low-poly diorama of version 2
(`docs/3D-V2/README.md`) into a detailed view with physically based light and materials. Decided 2026-11-18. As before,
everything here is the client's view of the same room data: the grid, walkability and every action stay on the server
(docs/architektur.en.md, "3D-Ansicht").

## Decisions

- **The grid and the diorama blocks stay.** A house stands on one cell and a figure is larger than life, so the target
  is a realistic miniature (real materials, real light, a model-maker's scale), not true proportions; those would need
  larger footprints and changes to the world and the server.
- **Assets.** Textures and skies from CC0 libraries; buildings and figures as one consistent set. Licences go into the
  world's `assets/CREDITS.md`.
- **One quality level.** No reduced tier for phones; the 2D map stays the fallback for a device without WebGL 2.
- **Download size.** A budget per room, loaded per room (to be set in phase 2). The ground's six surfaces are 4.8 MB together, the models' five further ones 0.7 MB, loaded once.
- **Models.** Built in this project (the user's decision, 2026-11-18), not bought or commissioned.

## Phases

| Phase | Contents | Status |
| --- | --- | --- |
| 1 Light and picture | sky and sun from the world's clock, the sky's light as an environment map, a filmic tone curve, shadows that turn with the sun, ambient occlusion, bloom, the close-up blur as a pass | done, except rain and wet surfaces |
| 2 Asset pipeline | glTF models with Meshopt, KTX2 textures, a catalogue from today's builder keys to model files with three levels of detail, the procedural builder as the fallback | open |
| 3 Terrain and water | a smoothed height field instead of hard terraces, PBR ground materials blended at the seams, rock on the block's sides; the water's surface | water, ground materials and the block's sides done; the height field open |
| 4 Vegetation | tree and bush models with leaves, wind, translucent leaves, instanced grass, crops per stage | leaves done (as geometry, below); wind, translucency, grass and crops open |
| 5 Buildings and things | models in the order hut, site, ruin, later epochs, scenery; a small shared set of materials; lit interiors | a first step for every model: rounded shading and a surface grain (below) |
| 6 Figures and animals | rigged figures with skeletal animation, the chosen look (`shared/appearance.ts`) as parts and colour masks | open |
| 7 Zoom ladder and distance | neighbours as simplified models on the island level, soft changes of level, loading in the background | open |
| 8 Acceptance | comparison pictures per phase, the frame rate on a real phone | open |

## Implemented

Pictures of the room Graue Bucht from the dev page with headless Chromium (software rendering): `built-day.jpg` (14:00),
`built-dusk.jpg` (19:54), `built-night.jpg` (23:00), `built-fog.jpg` (fog level 2, 9:00), `built-close.jpg` (zoom 3.4, 14:00).

**Sky and sun (`client/atmosphere3d.ts`, `client/camera3d.ts`).** `skyAt(hour)` puts the sun and the moon on their
arcs: the sun rises at 5:30 in the east (+x), stands 58° high in the south (+z) at 13:00 and sets at 20:30; the moon is
up from 18:30 to 7:30. `shadowLightAt(hour)` names the one light that casts shadows (the sun while it is up, else the
moon), never flatter than 12°, fading to nothing at the horizon so the change is not seen. The sky is Three's `Sky`
(Rayleigh and Mie scattering, clouds) with three additions: a gain that fits it to the sun's strength, a dim blue glow
at night, and a darker lower half (a studio floor under the block). The game's fog level (0 to 3) raises its haze and
cloud cover. Every tenth of a world hour, and when the fog changes, the sky without its sun disc is rendered into an
environment map (`PMREMGenerator`): it lights every surface from all round and shows in reflections, which replaces most
of the hemisphere light. One pixel of the sky a little below the horizon gives the fog its colour.

**Light (`MapView3D.tsx`, `daylight`, `LIGHT`).** Exposure 0.55 under the ACES filmic curve, the sun 5, the moon 1.6,
the environment 0.45. The sun's colour warms towards the horizon. The shadow map is 4096², fitted to the room as before;
cascades were not needed, because a room is small and the map covers it whole. `daylightAt` (unchanged) still dims
nothing but the lamplight: windows, lanterns and kiln mouths glow by it.

**Picture (`client/post3d.ts`, `POST`).** At every zoom the scene is drawn into a half-float target with 4× multisampling,
then: a bloom whose threshold follows the daylight (3.4 by day, 1.2 at night), the close-up's depth-aware blur (v2, now
a pass, reading the depth the scene left in its target), and the tone curve with the display's colour space. The ambient
occlusion is no longer a pass: it is worked out once per room and read by the materials (`client/ao3d.ts`, below, "On a
phone"). Names and speech bubbles are drawn afterwards, straight to the screen, without the tone curve.

**Water (`client/water3d.ts`).** The surface no longer shows the tile art. `shoreDistances` gives every cell its
distance to the nearest land (a chamfer distance, at most 4 cells), kept as a small texture per room; the surface mixes
a shallow and a deep colour by it, puts a ragged band of foam at the land and lines of foam that run in, moves its
normal with a few sine waves and noise, and mirrors the sky.

**Ground (`client/ground3d.ts`, `public/materials/`).** The terraces of sand, grass, paving, a building's floor and its
walls carry photographed surfaces (colour, normals, and occlusion with roughness; Poly Haven, CC0, credited in
`worlds/leuchtfeuer/assets/CREDITS.md`) instead of the tile art; the wall under a terrace's edge is rock tinted as earth.
One picture covers 1.5 to 2.5 cells, and a slow noise over the room varies its brightness so the repeat does not show.
Sand within about a cell of the water is dark and smooth (the water's shore texture with land and water swapped). A
tile kind without a surface keeps the tile art; until the pictures are loaded, or where the page is served without them
(`SPACES_MMO_NO_NEXT`), a surface shows its plain colour. The close-up's cobbles of geometry (v2) are off on
photographed paving. The pictures are served by the page (`/materials/…`), not by the world's asset route, which serves
PNG only.

**The block's sides (`client/block3d.ts`, `rockSide`).** The land sides of a room's block and of its neighbours carry
the photographed rock; v2's strata bands tint it and waver a little along the side. Until the rock has loaded the bands
are the side's colour, as before.

**Every model's surface (`client/props3d.ts`, `client/modelDetail3d.ts`).** The procedural models (plants, buildings,
things, animals) are no longer faceted: `merge` gives faces that meet at less than 50° a shared normal
(`creaseNormals`), so a trunk, a barrel or a bevelled beam is round and a box keeps its edges; round primitives have
more segments (10 at room level, 16 near), and a ball larger than a berry (a crown, a bush, a boulder) is a lumpy mass
instead of a sphere. The one model material adds a grain by the place on the model: it varies colour and roughness a
little and bumps the surface, fading with distance. This is not yet phase 4 or 5: crowns are still solid masses without
leaves, and the figures of `figure3d.ts` are unchanged.

**The models' photographed surfaces (`client/surfaces3d.ts`).** The models have no texture coordinates, so a surface is
laid on them from three sides by the place on the model (triplanar). A part's colour chooses it: bark, thatch, brick,
slate, wood, stone, plaster (`surfaceLayer`; a part may name another with `m`, as the palm's trunk does). The pictures
sit in two array textures, one layer per surface (colour; occlusion with roughness), 512 pixels each. A surface keeps the
part's own colour, because the picture is divided by its mean, and takes its relief from the picture's brightness, so
no normal maps are loaded for the models. Open: the grain runs upright on every side, also along a lying beam; leaves,
cloth and the figures have no surface yet.

**Leaves (`client/props3d.ts`: `blade`, `leaves`, `crown`, `frond`).** A leaf is geometry, four triangles folded along
its midrib, not a picture with holes: it casts its own shadow and needs no second material. A tree's or a bush's crown
keeps a smaller dark mass inside each of its balls, and leaves stand on the ball's surface, pointing out and a little
down, in four greens (about 800 leaves per square cell of surface at room level, 1500 near; far away the balls stay
plain). A palm's frond is a rib that rises and hangs, with narrow leaflets down both sides. A conifer's tiers carry
twigs of needles on their slopes. Leaves have a sheen of their own (roughness 0.5) and no photographed surface.

### The cost of a frame

Counted in Graue Bucht (12 figures, a paved road, 26 objects) at 1280 by 800, software rendering: a frame was about 1470
draw calls and 9.7 ms of JavaScript in the render alone, because the scene is drawn up to four times (shadow map, the
picture, the occlusion's own pass, close up the blur's depth) and every shape of a figure and every slab of a road was
a mesh of its own (309 meshes for the figures, 160 for the road). Since then:

- A figure's shapes are one mesh per moving part (two legs, two arms, head, torso, and the fine parts shown close up),
  with the colours in the vertices and one material for all figures (`figure3d.ts`, `part`); the geometries are shared
  between figures and keep their three levels of detail.
- A road's beds, slabs and pegs are one mesh (`road`).
- The shadow map is drawn only in a frame in which something that casts a shadow moved, and every 250 ms for what
  changes slowly (`SHADOW_EVERY_MS`); a new sun position draws it at once.
- The occlusion worked at half the picture's size: its pass over the scene, its samples and its smoothing cost a
  quarter (since replaced by the occlusion worked out once per room, "On a phone").
- Drawing the sky after everything solid (so its shader runs only where sky shows) was tried and taken back: the sky
  box puts every point on the far plane, a face of it clipped at the camera's plane has no defined depth, and at single
  zoom steps it covered part of the scene.
- The canvas itself is not multisampled; the picture is smoothed in the post chain's own target.
- The resolution follows the frame rate on every device (`closeup3d.ts`, `sharpen`; the decision of one quality level
  stands, the resolution is what gives): below 42 frames a second it drops by 15 % a step, to half the screen's at
  most and never below 0.75 pixels per CSS pixel; after four seconds above 56 frames it rises again. A drop that brings
  no faster frames (a page held to 30 frames, a phone saving power) is taken back, and so is a rise that makes frames
  slow again; then the resolution stays for 30 seconds.

The same frame is now about 630 draw calls (560 close up) and 3.7 ms of JavaScript. The share of the graphics card is
not measured yet: that needs the `FPS` button on a real device.

### After the code analysis of 19 November 2026

The points of `docs/code-analyse-2026-11-19.md` (it says which were taken and which were left, and why):

- The soft shadows under a room's trees, bushes and palms are one instanced mesh (`propShadows`), not a mesh a plant.
- The wild flowers are one instanced mesh per sort and shape instead of one per colour as well: the blossoms are white
  in the geometry (`TINTED`, the attribute `tint`) and take the instance's colour (`setColorAt`); the model material
  tints only what is marked, so the stems stay green.
- The world's own small plants (flower, herb, grass, fern) are bundled in patches of 8×8 cells instead of 4×4, and its
  flowers of every colour are one mesh (the instance's colour again); trees and bushes keep 4×4, since the close level
  of detail is set per mesh. Counted over the world's 37 rooms: 427 meshes of such plants before, 383 after.
- A railway line is two meshes (sleepers, rails), a planned road's marks one, a cart, a train and a tree's fruit one
  each (made once and shared, with their levels of detail), a bed and a field one or two (`solidMesh`, `plainMaterial`).
- The fish are one instanced mesh per kind for the bodies and one for the tails (`fishSchool`, at most six draw calls);
  on the island level they are neither moved nor drawn.
- The model material reads a surface's pictures only for a part that has one (`textureGrad` with the slopes taken
  outside the branch, so the picture is the same): a leaf, a figure's neighbour, every plain part read nothing. The
  fine grain of the bump is worked out only within 34 units, where the bump shows.
- The pass that hides flat things from the occlusion and the blur skips what is invisible with all that is in it; so
  does the pass that sets the models' level of detail, which no longer allocates per mesh.
- A figure's primitives are data (`Prim`): the key of a part no longer builds and frees every geometry. The shadow
  under a figure and the ring under one's own are shared.
- `creaseNormals` keys a point by a whole number instead of a text; the normals are the same byte for byte.
- `sync` works out the raised cells, the things and the plants only when the objects changed, not at every step of a
  figure. The view is stored 300 ms after it last moved, not at every step of a zoom.
- What a room made and never used stays unmade (the water's material and shore texture in a dry room, the earth
  material, the box of the lesser waters, the ground's wall and wetness texture): it was never freed. The tile art is
  loaded only for a room with a kind of land that has no photographed ground. The stones of geometry on the paving,
  which never showed since the paving is photographed, are gone.
- Faults: a figure's breath set its height to 1, so every figure was as tall as the next and breathed in step with it
  (`Figure.tall`, `Figure.breath`); a figure made anew lost its speech bubble; during a change of room figures stood on
  the old ground; the chapel's roof sat beside its nave; the greenhouse had its ridge twice.

Graue Bucht at zoom 1.4, headless Chromium (software rendering), before and after: 693 and 520 draw calls, 303 and 220
meshes. The share of the graphics card is still not measured.

### On a phone

A phone drew the 3D view at 12 to 22 frames a second. The `FPS` button measures for 30 seconds and then shows four lines:
the frame rate with the median and the 95th percentile of a frame, the JavaScript in a frame (moving things, and handing
the draw calls over), the draw calls and triangles with the zoom, and the picture's size with how far the resolution gave
way. Under them "Nach Teilen messen" draws the same view several times for 4.5 seconds each, with one part of the picture
left out at a time and the resolution held still, and gives each part's frame time against the whole (`MapView3D.tsx`
`PARTS`, `measureParts`; `post3d.ts` `leaveOut`). What it showed on one phone, in ms of a frame:

| | 1484×668 px | 873×393 px |
|---|---|---|
| the whole picture | 114 | 50 |
| without the occlusion (GTAO) | 78 | 37 |
| GTAO with 8 samples instead of 16 | 105 | 49 |
| GTAO from the picture's own depth (no pass over the scene of its own, the normals from the depth) | | 48 |
| without the edges' smoothing (the 4× multisampling) | 100 | |
| without the plants | | 40 |
| without the things and figures | | 36 |
| only the ground and the water | 28 | 20 |
| the same without the post chain | | 20 |
| the same without the water | 28 | |

What follows from it, and what was done:

- The close-up blur no longer draws the scene once more for a depth of its own; it reads the depth the scene left in the
  target it was drawn into. The shadow map gives way with the resolution (`closeup3d.ts` `shadowSizeAt`: 4096 texels,
  2048 one step down, 1024 at the lowest), its softness following, so a shadow's edge stays as wide on the ground.
- GTAO cost a third of a frame however it was fed. It is gone. The ambient occlusion is worked out once per room
  (`client/ao3d.ts`): the room is drawn from straight above into a depth, which is the height of whatever stands at each
  point; the heights are blurred by the occlusion's reach (`AO.reach`, 0.45 cells), and every lit material reads the
  blurred height at its own point in the world and darkens its light by how far it lies below it (`AO.strength` 0.45,
  `AO.depth` 0.7 cells). The ground darkens at the foot of a wall and under a crown, a wall near its foot, a figure
  beside a house. Figures, the sky, sprites, points, lines and what is see-through without depth stay out of the
  heights; what lies under the ground and the water takes none (`userData.noAo`). The bake runs when the room is built
  and when its things or plants change, at most once a second. A material with an `onBeforeCompile` of its own calls
  `withAo` (the ground, the models); the others take it from `MeshStandardMaterial`'s prototype (`installAo`).
- The edges' smoothing and the water's shader cost nothing that could be measured; the post chain's own cost neither.
- The ground and water alone took 20 ms at 873×393 pixels whatever was left out (the water, the post chain, the
  anisotropic filtering of the ground's pictures): about the 16.7 ms a 60 Hz screen allows a frame at least. What lay
  above it in Graue Bucht at zoom 2 (headless Chromium): 294 draw calls and 464 thousand triangles in a frame that
  draws the shadow map; the shadow map 174 of the calls, the 11 figures 127, the plants 390 thousand of the triangles.
- A figure is one skinned mesh on seven bones (the body, the legs, the torso, the arms, the head; `figure3d.ts`
  `skinned`): every part's vertices placed where its bone holds them at rest and bound to that bone alone, the fine parts
  in it only at the near level. One draw call and one in the shadow map instead of six to eight each.
- The shadow map is drawn in two parts (`client/shadow3d.ts`): what stands still once a second (`SHADOW_EVERY_MS`), at
  once when the sun moved or the things changed, and kept in a copy; in a frame in which a figure moved the copy is put
  back and only the figures (their own layer, `MOVING_LAYER`) are drawn on top.
- A plant's leaves, petals, stems and fronds keep the few faces they are made with (`props3d.ts` `fixed`): a leaf is a
  flattened ball of radius 0.5, which the level of detail took for a crown and gave 320 triangles (1280 close up), and a
  thin stem got 10 or 16 sides. A flower had over 4000 triangles at room zoom and has 936 now, a fern close up 19656 and
  now about 6700.
- The same frame afterwards: 217 draw calls with the whole shadow map, about 120 in a frame with only the figures in it,
  and about 160 thousand triangles.
- The resolution judged a drop by the second right after it, when the picture's targets and the shadow map are made
  anew: a phone found it "no faster", took it back and drew at 85 % of the screen's resolution for half a minute (87 ms
  a frame where 873×393 pixels took 41). The frames of the first 700 ms after a change are no longer counted
  (`closeup3d.ts` `SETTLE_MS`), and a drop is taken back only when it made frames less than 5 % faster. Still the phone
  stopped at 72 % (1261×567, 64 ms a frame): its frames vary so much from one second to the next that a drop was judged
  no faster. A drop is now taken back only for frames of 38 ms or less (`SHARP.held`), where a page held to 30 frames a
  second or a phone saving power is what keeps them; slower frames are the drawing's, and the resolution goes down.

### The night

By moonlight the land was hardly to be seen on a real screen. The moon is brighter (`LIGHT.moon` 2.4 instead of 1.6),
and the exposure rises in the dark by `LIGHT.nightLift` (60 % at full night), as an eye gets used to it; the fires and
lanterns stay the brightest things.

Dev probes on the canvas (not in a production build): `probeHour(hour)`, `probeFog(level)`, `probeLight()`,
`probeTune(light, post)`, `probeState()` (the whole state of the view, for measurements).

## Open in phase 3

- The smoothed height field: the ground still stands on v2's rounded terraces.

## Open in phase 1

- Rain, storm and wet surfaces: the view receives the fog level only; the weather has to be passed to `MapRenderer` first.
- A frame rate measured on a real phone (the `FPS` button). The pictures above come from software rendering and say
  nothing about speed.
