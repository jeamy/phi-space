// A lighthouse's lamp in the 3D view (a building of plan `leuchtturm`, buildings3d.ts lighthouse): from dusk on it lights
// the ground round the tower and two beams turn over the land and the sea, brighter the darker it is; by day it is out.
// Visual only: what the lighthouse does in the game (20 light points for its fire, its light in the rooms beside it) is
// the server's (engine/commands/build.ts, engine/fire.ts).
import type { T } from "./props3d.ts";

type Geo = import("three").BufferGeometry;
export type LighthouseLamp = { light: import("three").PointLight; rays: import("three").Object3D; glow: import("three").MeshBasicMaterial };

/** Where the lantern burns, above the tower's middle (buildings3d.ts lighthouse: the lamp from 1.65 to 1.91). */
export const LANTERN_Y = 1.78;
/** The beams: their length and the radius of their open end (cells), the turns per second (radians), how strongly they
 *  show at night, and the lamp's light round the tower (intensity, reach). */
export const BEAM = { length: 9, radius: 0.9, turnPerSec: 0.55, opacity: 0.25, light: 9, reach: 7 };

let beamGeometry: Geo | null = null;
/** One beam, shared by every lighthouse: a cone open at its far end, its tip at the lamp, along +x and a little down
 *  towards the water; its colour falls to black along its length, so, added to what is behind it, it fades out. */
function beamGeo(t: T): Geo {
	if (beamGeometry) return beamGeometry;
	const g = new t.ConeGeometry(BEAM.radius, BEAM.length, 20, 1, true);
	g.translate(0, -BEAM.length / 2, 0); g.rotateZ(Math.PI / 2 - 0.06);
	const pos = g.getAttribute("position"), col: number[] = [];
	for (let i = 0; i < pos.count; i++) { const f = Math.max(0, 1 - Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)) / BEAM.length); col.push(f, f * 0.9, f * 0.7); }
	g.setAttribute("color", new t.Float32BufferAttribute(col, 3));
	g.userData.shared = true;
	return (beamGeometry = g);
}

/** The lamp of a lighthouse, added to its group: the light is there from the start (at 0), so lighting it compiles no
 *  shader anew; the beams cast no shadow and take no tap. */
export function lighthouseLamp(t: T, group: import("three").Object3D): LighthouseLamp {
	const light = new t.PointLight(0xffd79a, 0, BEAM.reach, 1.4); light.position.y = LANTERN_Y;
	const glow = new t.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: t.AdditiveBlending, depthWrite: false, side: t.DoubleSide, fog: false });
	const rays = new t.Group(); rays.position.y = LANTERN_Y; rays.visible = false;
	for (const turn of [0, Math.PI]) {
		const ray = new t.Mesh(beamGeo(t), glow); ray.rotation.y = turn; ray.raycast = () => {}; ray.userData.unshaded = true; ray.renderOrder = 2;
		rays.add(ray);
	}
	group.add(light, rays);
	return { light, rays, glow };
}

/** How much the lamp is lit at this daylight (1 day, 0 night): out by day, full from deep dusk on (as the own lantern). */
export const lampOn = (daylight: number) => Math.min(1, Math.max(0, (0.7 - Math.max(0, daylight)) / 0.4));

/** One frame of the lamp: its light and beams by the daylight, the beams turned by the time (seconds). */
export function lighthouseTick(lamp: LighthouseLamp, daylight: number, time: number): void {
	const on = lampOn(daylight);
	lamp.light.intensity = on * BEAM.light; lamp.glow.opacity = on * BEAM.opacity; lamp.rays.visible = on > 0.02;
	lamp.rays.rotation.y = time * BEAM.turnPerSec;
}
