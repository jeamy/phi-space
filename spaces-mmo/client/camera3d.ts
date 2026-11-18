// The zoom ladder of the 3D view (docs/3D-V2/README.md): one slider from the island down to a figure's face. The camera's
// elevation is a function of the zoom, so a pinch both comes closer and flattens the view, and the zoom names the level of
// detail the scene shows. Pure numbers, visual only.

/** The ends of the slider: 0.2 shows the island, 5 a figure close up. */
export const ZOOM_MIN = 0.2, ZOOM_MAX = 5;

/** Where each level begins (by zoom) and the camera's elevation there, in degrees. Between two marks the elevation runs
 *  with the logarithm of the zoom, so every step of the wheel changes it by the same amount. */
const MARKS: ReadonlyArray<readonly [zoom: number, degrees: number]> = [[ZOOM_MIN, 60], [0.3, 60], [0.6, 52], [1, 44], [2, 32], [ZOOM_MAX, 22]];

/** The camera's elevation over the ground, in radians, for a zoom. */
export function elevationAt(zoom: number): number {
	const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
	for (let i = 1; i < MARKS.length; i++) {
		const [z0, d0] = MARKS[i - 1]!, [z1, d1] = MARKS[i]!;
		if (z <= z1) {
			const k = z1 === z0 ? 1 : Math.log(z / z0) / Math.log(z1 / z0);
			return ((d0 + (d1 - d0) * k) * Math.PI) / 180;
		}
	}
	return (MARKS[MARKS.length - 1]![1] * Math.PI) / 180;
}

/** The four levels of the ladder: the island of blocks, the approach to one block, the room, close up. */
export type ZoomLevel = "island" | "approach" | "room" | "close";
export function levelAt(zoom: number): ZoomLevel {
	return zoom <= 0.3 ? "island" : zoom <= 0.6 ? "approach" : zoom < 2 ? "room" : "close";
}

/** One click of a zoom button: a fixed factor, so the slider takes as many clicks per level at either end. */
export const ZOOM_STEP = 1.25;
export const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
export const clampTilt = (degrees: number): number => Number.isFinite(degrees) ? Math.max(-25, Math.min(25, degrees)) : 0;
export const cameraElevation = (zoom: number, tilt: number): number => Math.max(14 * Math.PI / 180, Math.min(75 * Math.PI / 180, elevationAt(zoom) + clampTilt(tilt) * Math.PI / 180));
export const wheelView = (deltaY: number, alt: boolean) => ({ zoomFactor: alt ? 1 : Math.exp(-Math.sign(deltaY) * 0.12), tiltDelta: alt && deltaY !== 0 ? -Math.sign(deltaY) * 3 : 0 });

/** How light it is at a world hour (0 to 24): full from 7 to 19, dark from 21 to 5, a smooth dawn and dusk between. The
 *  3D view dims its sun and sky by it and lights the windows; the game's rules keep their own hours (wild.ts). */
export function daylightAt(hour: number): number {
	const h = ((hour % 24) + 24) % 24, ease = (k: number) => k * k * (3 - 2 * k);
	if (h >= 7 && h <= 19) return 1;
	if (h > 5 && h < 7) return ease((h - 5) / 2);
	if (h > 19 && h < 21) return ease(1 - (h - 19) / 2);
	return 0;
}

export type V3 = readonly [x: number, y: number, z: number];
const DEG = Math.PI / 180;
/** A body on its arc: `k` 0 at its rise in the east, 0.5 at its top in the south, 1 at its set in the west, on to 2 below. */
const onArc = (k: number, top: number): { dir: V3; elevation: number } => {
	const elevation = Math.sin(Math.PI * k) * top * DEG, flat = Math.cos(elevation);
	return { dir: [Math.cos(Math.PI * k) * flat, Math.sin(elevation), Math.sin(Math.PI * k) * flat], elevation };
};
/** Where the sun and the moon stand at a world hour (3D v3, docs/3D-V3): the sun rises at 5:30 in the east (+x), stands
 *  58° high in the south (+z, the bottom of the map) at 13:00 and sets at 20:30; the moon is up from 18:30 to 7:30, 42° at
 *  its top. Directions point from the ground to the body; an elevation below 0 is under the horizon. Visual only. */
export function skyAt(hour: number): { sun: V3; sunElevation: number; moon: V3; moonElevation: number } {
	const h = ((hour % 24) + 24) % 24, since = (from: number) => (h - from + 24) % 24;
	const s = since(5.5), m = since(18.5);
	const sun = onArc(s <= 15 ? s / 15 : 1 + (s - 15) / 9, 58), moon = onArc(m <= 13 ? m / 13 : 1 + (m - 13) / 11, 42);
	return { sun: sun.dir, sunElevation: sun.elevation, moon: moon.dir, moonElevation: moon.elevation };
}
/** The one light that casts shadows at a world hour: the sun while it is up, else the moon. `strength` (0 to 1) fades
 *  to nothing as the body nears the horizon, and the moon's only comes as the sun sinks 6° below it, so the change from
 *  one to the other is never seen; the direction never lies
 *  flatter than 12°, so a shadow stays inside the room's shadow map. `warm` is 1 at the horizon and 0 from 25° up. */
export function shadowLightAt(hour: number): { dir: V3; body: "sun" | "moon"; strength: number; warm: number } {
	const sky = skyAt(hour), body = sky.sunElevation > 0 ? "sun" : "moon";
	const from = body === "sun" ? sky.sun : sky.moon, elevation = Math.max(0, body === "sun" ? sky.sunElevation : sky.moonElevation);
	const ease = (k: number) => { const c = Math.min(1, Math.max(0, k)); return c * c * (3 - 2 * c); };
	const lifted = Math.max(elevation, 12 * DEG), flat = Math.hypot(from[0], from[2]) || 1, scale = Math.cos(lifted) / flat;
	const strength = ease(elevation / (10 * DEG)) * (body === "moon" ? ease(-sky.sunElevation / (6 * DEG)) : 1);
	return { dir: [from[0] * scale, Math.sin(lifted), from[2] * scale], body, strength, warm: 1 - ease(elevation / (25 * DEG)) };
}
