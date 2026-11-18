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
- **Download size.** A budget per room, loaded per room (to be set in phase 2).

## Phases

| Phase | Contents | Status |
| --- | --- | --- |
| 1 Light and picture | sky and sun from the world's clock, the sky's light as an environment map, a filmic tone curve, shadows that turn with the sun, ambient occlusion, bloom, the close-up blur as a pass | done, except rain and wet surfaces |
| 2 Asset pipeline | glTF models with Meshopt, KTX2 textures, a catalogue from today's builder keys to model files with three levels of detail, the procedural builder as the fallback | open |
| 3 Terrain and water | a smoothed height field instead of hard terraces, PBR ground materials blended at the seams, rock on the block's sides; the water's surface | water done, the rest open |
| 4 Vegetation | tree and bush models with leaf cards, wind, translucent leaves, instanced grass, crops per stage | open |
| 5 Buildings and things | models in the order hut, site, ruin, later epochs, scenery; a small shared set of materials; lit interiors | open |
| 6 Figures and animals | rigged figures with skeletal animation, the chosen look (`shared/appearance.ts`) as parts and colour masks | open |
| 7 Zoom ladder and distance | neighbours as simplified models on the island level, soft changes of level, loading in the background | open |
| 8 Acceptance | comparison pictures per phase, the frame rate on a real phone | open |

## Implemented

Pictures of the room Graue Bucht from the dev page with headless Chromium (software rendering): `built-day.jpg` (11:00),
`built-dusk.jpg` (19:54), `built-night.jpg` (23:00), `built-fog.jpg` (fog level 2, 9:00), `built-close.jpg` (zoom 2.4, 15:00).

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

Dev probes on the canvas (not in a production build): `probeHour(hour)`, `probeFog(level)`, `probeLight()`,
`probeTune(light, post)`.

## Open in phase 1

- Rain, storm and wet surfaces: the view receives the fog level only; the weather has to be passed to `MapRenderer` first.
- A frame rate measured on a real phone (the `FPS` button). The pictures above come from software rendering and say
  nothing about speed.
