# Measuring protocol for acceptance case 5 (phone and image quality)

**Plan:** [3D world and grid plan](3d-welt-und-raster-plan-2026-11-21.en.md), section 6, case 5 · **Phase:** 0 (scale-1 reference), repeated in phase 2 (grid switch alone) and phase 3 (rendering work)

Case 5 compares the 3D view before and after on the same phone. The comparison is only valid when everything but the change stays the same: the phone, its browser, the world data, the resolution and the scene. This protocol fixes those, step by step. Fill in the tables at the end and keep them, with the screenshots, beside the result.

## What the page measures

The `FPS` button of the 3D view measures 2 s of warm-up and then 30 s of frames. It shows five lines:

1. FPS, frame time median and 95 %;
2. JavaScript time per frame (moving, drawing);
3. draw calls, thousand triangles, zoom;
4. picture size in pixels, sharpness, device ratio, and the fixed pixel ratio when one is set;
5. frame time 99 %, how often the shadow map was drawn whole (full shadow updates, counted apart from the ordinary frames), and the time of the last room change (from the new room's arrival to its first frame drawn).

The same values are printed on the browser's console as one line beginning with `[fps]`, for a remote debugger.

**Measuring mode.** `?ratio=<n>` in the page's address fixes the pixels per CSS pixel at `n` (0.5 to 2) and switches off the automatic resolution (`sharpen()`). Without it the page lowers its resolution when frames are slow, and two measurements would draw different numbers of pixels. Use the same `n` for every measurement of a comparison.

## 1. Preparation (once per series)

- [ ] **Phone:** always the same one. Note its browser and browser version.
- [ ] **Phone state:** battery above 50 % or on the charger (note which, and keep it so for the whole series); power saving off; screen brightness fixed; no other apps open.
- [ ] **Server:** the local test bed on this machine, reached from the phone over the LAN. Build the image of the commit to be measured first, then start it on the LAN address: `HOST_BIND=<LAN address> npm --prefix spaces-mmo run docker:local:rust:up`. The page is at `http://<LAN address>:3910`.
- [ ] **Data state:** note the commit and keep a copy of the test bed's volumes (the stores) for the series. A later series is measured on the same copy, migrated where the format changed.
- [ ] **Ratio:** open the page once without `?ratio`, run `FPS` once and read "Gerät x×" (the device ratio). Choose `n` = half of it ("half resolution", as in case 5). Note `n`.
- [ ] **Account:** an admin account (for the clock, step 2). The figure stands in Graue Bucht.

## 2. Scenes

All in **Graue Bucht**, at the start view's angle and tilt (reload the page to get it back).

| Scene | How |
| --- | --- |
| Day | world time 14:00 |
| Night | world time 23:00 |

Set the world time with the admin clock: `clock rate 3600` until the time is reached, then `clock pause`; `clock weiter` and `clock rate 24` afterwards. Note the times actually used.

| Zoom | How (from the start view, zoom 1.4) |
| --- | --- |
| Room | the start view: reload, do not zoom |
| Close | `+` four times (zoom about 3.4) |
| Island | `−` seven times (zoom about 0.29) |

The third line of the result shows the zoom: check it.

## 3. Runs

Open `http://<LAN address>:3910/?ratio=<n>`, switch to 3D, wait one minute (warm-up), then for each scene and zoom:

- [ ] three runs of `FPS`, one after the other. Do not touch the screen during a run, and do not let the screen lock.
- [ ] For the **room zoom** walk out of Graue Bucht through an exit and back in before each run. That run's fifth line then gives the room change time.
- [ ] Write down the lines of each run, or photograph them, or copy the `[fps]` lines from the remote console.

## 4. Pictures and checks

- [ ] Screenshots of Graue Bucht at day, dusk, night, fog, close view and island.
- [ ] 2D view: the water moves; four figures on neighbouring cells stand apart; the touch targets of figures and things hit what they show (plan section 4).

## 5. Tables

Series: date ______, commit ______, phone ______, browser ______, ratio `n` ______, data copy ______

| Scene, zoom | Run | FPS | Frame p50 / p95 ms | Draw calls | Thousand triangles | Full shadow updates | Room change ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Day, room | 1 | | | | | | |
| Day, room | 2 | | | | | | |
| Day, room | 3 | | | | | | |
| Day, close | 1 | | | | | | – |
| Day, close | 2 | | | | | | – |
| Day, close | 3 | | | | | | – |
| Day, island | 1 | | | | | | – |
| Day, island | 2 | | | | | | – |
| Day, island | 3 | | | | | | – |
| Night, room | 1 | | | | | | |
| Night, room | 2 | | | | | | |
| Night, room | 3 | | | | | | |

The other zooms at night are optional for the reference. The night scene in the room zoom is the one case 5 sets the target of phase 3 for.

## 6. How the result is read (case 5)

- Per scene and zoom: the median of the three runs and the spread (largest minus smallest median frame time).
- **Grid switch alone (phase 2):**
  - draw calls and triangles at most 5 % above this reference, a hard bound;
  - the median frame time at most 5 % above it, or above it by the spread of the three reference runs, whichever is larger.
- **With the rendering work (phase 3):**
  - the night scene at least at this reference's median, target 30 FPS;
  - in the ordinary room frame at most 200 draw calls and 180,000 triangles.
