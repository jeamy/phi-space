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
then: ambient occlusion (GTAO, radius 0.45 cells), a bloom whose threshold follows the daylight (3.4 by day, 1.2 at
night), the close-up's depth-aware blur (v2, now a pass), and the tone curve with the display's colour space. Sprites,
lines, and glass or soft shadows that write no depth sit out the occlusion's and the blur's own depth passes. Names and
speech bubbles are drawn afterwards, straight to the screen, without the tone curve.

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
- The occlusion works at half the picture's size (`POST.aoScale`): its pass over the scene, its samples and its
  smoothing cost a quarter.
- The sky is drawn after everything solid, so its shader runs only where sky shows.
- The canvas itself is not multisampled; the picture is smoothed in the post chain's own target.

The same frame is now about 630 draw calls (560 close up) and 3.7 ms of JavaScript. The share of the graphics card is
not measured yet: that needs the `FPS` button on a real device.

Dev probes on the canvas (not in a production build): `probeHour(hour)`, `probeFog(level)`, `probeLight()`,
`probeTune(light, post)`, `probeState()` (the whole state of the view, for measurements).

## Open in phase 3

- The smoothed height field: the ground still stands on v2's rounded terraces.

## Open in phase 1

- Rain, storm and wet surfaces: the view receives the fog level only; the weather has to be passed to `MapRenderer` first.
- A frame rate measured on a real phone (the `FPS` button). The pictures above come from software rendering and say
  nothing about speed.
