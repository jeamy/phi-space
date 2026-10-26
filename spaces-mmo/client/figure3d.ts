// A person for the 3D map: head, neck, torso, two arms and two legs that swing while the figure walks, hair, eyes, boots,
// a shadow on the ground. Built from primitives, so it needs no model file; the look comes from the character's skin number
// and id (the same skin number picks the sprite in the 2D map). Everything here is visual only.
import { stableHash } from "./terrain3d.ts";

type T = typeof import("three");
type G = import("three").Group;

const SKIN = [0xf0c8a0, 0xdcae82, 0xc08a5c, 0x95643f, 0xe8b894];
const HAIR = [0x2a1c12, 0x5b3a1e, 0xc4952e, 0x8d8d90, 0x15120f, 0x9a3b1f];
/** tunic and trousers per skin number (the five 2D skins) */
const TUNIC = [0x3f6fa8, 0xb5533c, 0x4f8a4a, 0x8a5aa8, 0xc9a23c];
const TROUSERS = [0x3a3f4d, 0x4a3a2c, 0x33402f, 0x2f2a3a, 0x4a4436];
/** a person a little larger than life, so that they read from the whole-room view */
const FIGURE_SCALE = 1.3;
const AI_TUNIC = 0x4aa3d8, OWN_TUNIC = 0x9bc92f;

export type Look = { id: string; skin: number; own: boolean; ai: boolean };
export type Figure = {
	group: G; body: G; legL: G; legR: G; armL: G; armR: G; head: G;
	heading: number; phase: number; swing: number; last: { x: number; z: number };
};

let shadowTexture: import("three").CanvasTexture | null = null;
function shadow(t: T): import("three").CanvasTexture {
	if (shadowTexture) return shadowTexture;
	const c = document.createElement("canvas"); c.width = c.height = 64;
	const g = c.getContext("2d")!, grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
	grad.addColorStop(0, "rgba(0,0,0,.55)"); grad.addColorStop(1, "rgba(0,0,0,0)");
	g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
	shadowTexture = new t.CanvasTexture(c); shadowTexture.userData.shared = true;
	return shadowTexture;
}

export function makeFigure(t: T, look: Look): Figure {
	const h = stableHash(look.id), s = Math.abs(look.skin);
	const skin = SKIN[(h >>> 3) % SKIN.length]!, hair = HAIR[(h >>> 7) % HAIR.length]!;
	const tunic = look.own ? OWN_TUNIC : look.ai ? AI_TUNIC : TUNIC[s % TUNIC.length]!;
	const trousers = TROUSERS[s % TROUSERS.length]!;
	const mat = (color: number, roughness = 0.82) => new t.MeshStandardMaterial({ color, roughness });
	const mesh = (geo: import("three").BufferGeometry, m: import("three").Material, x = 0, y = 0, z = 0) => { const o = new t.Mesh(geo, m); o.position.set(x, y, z); return o; };
	const group = new t.Group(); group.userData.owned = true;
	const blob = mesh(new t.CircleGeometry(0.34, 20), new t.MeshBasicMaterial({ map: shadow(t), transparent: true, depthWrite: false }), 0, 0.012);
	blob.rotation.x = -Math.PI / 2; blob.renderOrder = 1;
	group.add(blob);
	if (look.own) {
		const ring = mesh(new t.RingGeometry(0.27, 0.33, 28), new t.MeshBasicMaterial({ color: 0xaed83c, transparent: true, opacity: 0.85, depthWrite: false }), 0, 0.02);
		ring.rotation.x = -Math.PI / 2; ring.renderOrder = 2; group.add(ring);
	}
	// the body stands on y = 0 and faces +z; everything inside `body` is in metres of the cell (a person ≈ 0.9 high)
	const body = new t.Group(); body.scale.setScalar(FIGURE_SCALE); group.add(body);
	const leg = (side: number) => {
		const g = new t.Group(); g.position.set(side * 0.075, 0.4, 0);
		g.add(mesh(new t.CapsuleGeometry(0.052, 0.27, 4, 8), mat(trousers), 0, -0.2));
		g.add(mesh(new t.BoxGeometry(0.1, 0.06, 0.17), mat(0x2a2018, 0.9), 0, -0.385, 0.03));
		body.add(g); return g;
	};
	const legL = leg(-1), legR = leg(1);
	const torso = new t.Group(); body.add(torso);
	const chest = mesh(new t.CapsuleGeometry(0.115, 0.17, 6, 12), mat(tunic), 0, 0.58); chest.scale.set(1.12, 1, 0.78); torso.add(chest);
	torso.add(mesh(new t.CylinderGeometry(0.128, 0.134, 0.035, 14), mat(0x3a2a1c, 0.9), 0, 0.46)); // belt
	const hem = mesh(new t.CylinderGeometry(0.135, 0.15, 0.1, 14, 1, true), mat(tunic), 0, 0.42); hem.material.side = t.DoubleSide; torso.add(hem); // tunic skirt
	const arm = (side: number) => {
		const g = new t.Group(); g.position.set(side * 0.172, 0.69, 0);
		g.add(mesh(new t.CapsuleGeometry(0.038, 0.2, 4, 8), mat(tunic), 0, -0.13));
		g.add(mesh(new t.SphereGeometry(0.04, 10, 8), mat(skin, 0.7), 0, -0.275));
		body.add(g); return g;
	};
	const armL = arm(-1), armR = arm(1);
	const head = new t.Group(); head.position.set(0, 0.8, 0); body.add(head);
	head.add(mesh(new t.CylinderGeometry(0.036, 0.042, 0.07, 10), mat(skin, 0.7), 0, -0.065)); // neck
	head.add(mesh(new t.SphereGeometry(0.094, 20, 16), mat(skin, 0.7), 0, 0.02));
	const cap = mesh(new t.SphereGeometry(0.1, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.58), mat(hair, 0.9), 0, 0.03, -0.008); cap.rotation.x = -0.18; head.add(cap);
	head.add(mesh(new t.SphereGeometry(0.014, 8, 6), mat(0x1c1612, 0.4), -0.034, 0.03, 0.085), mesh(new t.SphereGeometry(0.014, 8, 6), mat(0x1c1612, 0.4), 0.034, 0.03, 0.085));
	head.add(mesh(new t.SphereGeometry(0.016, 8, 6), mat(skin, 0.7), 0, 0.005, 0.094)); // nose
	return { group, body, legL, legR, armL, armR, head, heading: 0, phase: 0, swing: 0, last: { x: 0, z: 0 } };
}

const turn = (from: number, to: number, k: number) => { let d = ((to - from + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return from + d * k; };

/** Walks the limbs and turns the figure towards where it goes. `dx`/`dz`: how far it moved this frame, `dt` in seconds. */
export function animateFigure(f: Figure, dx: number, dz: number, dt: number, time: number): void {
	const speed = dt > 0 ? Math.hypot(dx, dz) / dt : 0;
	if (speed > 0.15) f.heading = turn(f.heading, Math.atan2(dx, dz), 1 - Math.exp(-14 * dt));
	f.group.rotation.y = f.heading;
	const target = Math.min(1, speed / 2.2);
	f.swing += (target - f.swing) * (1 - Math.exp(-12 * dt));
	f.phase += dt * (4 + 7 * f.swing);
	const s = Math.sin(f.phase) * f.swing;
	f.legL.rotation.x = s * 0.75; f.legR.rotation.x = -s * 0.75;
	f.armL.rotation.x = -s * 0.6; f.armR.rotation.x = s * 0.6;
	f.body.position.y = Math.abs(Math.cos(f.phase)) * 0.025 * f.swing;
	f.body.rotation.z = Math.sin(f.phase) * 0.04 * f.swing;
	const idle = 1 - f.swing; // a slow breath and a glance about while standing
	f.body.scale.y = 1 + Math.sin(time * 1.8 + f.phase * 0) * 0.008 * idle;
	f.head.rotation.y = Math.sin(time * 0.6 + f.heading) * 0.22 * idle;
}
