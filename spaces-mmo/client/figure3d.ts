// A person for the 3D map: head, neck, torso, two arms and two legs that swing while the figure walks, hair, eyes, boots,
// a shadow on the ground. Built from primitives, so it needs no model file; the shapes of each moving part are one mesh. A player's chosen look (shared/appearance.ts:
// figure type, colours, hat, glasses, gloves) decides it; without one it comes from the character's skin number and id (the
// same skin number picks the sprite in the 2D map). Everything here is visual only.
import { stableHash } from "./terrain3d.ts";
import { cached, merge } from "./props3d.ts";
import { COATS, HAIRS, SKINS, type Appearance } from "../shared/appearance.ts";

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
/** felt and wool for hats and caps */
const HAT = [0x4a3a2c, 0x5a4a3a, 0x2f3a4a, 0x7a3426, 0x3f4f3a];

/** `style`: what the player chose (none: from the id and skin number). */
export type Look = { id: string; skin: number; own: boolean; ai: boolean; style?: Appearance };
/** Proportions of the figure types (appearance.ts FIGURES): width, height, dress (a long skirt instead of trousers), long hair. */
const BUILD = [
	{ wide: 1, tall: 1, dress: false, long: false },
	{ wide: 0.94, tall: 0.98, dress: true, long: true },
	{ wide: 1.18, tall: 0.95, dress: false, long: false },
	{ wide: 0.88, tall: 1.1, dress: false, long: false },
];
const GLOVE = 0x5a3a22, RIM = 0x2a2a2e;
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

type V3 = [number, number, number];
type Geo = import("three").BufferGeometry;
/** One shape of a figure's part: its primitive (made anew for every level of detail), colour, place, turn and scale. */
type Shape = { g: () => Geo; c: number; p: V3; r?: V3; s?: V3 };

let cloth: import("three").MeshStandardMaterial | null = null;
/** The one material of every figure: the colours are in the vertices, as for the models (props3d.ts). */
function figureMaterial(t: T): import("three").MeshStandardMaterial {
	if (!cloth) { cloth = new t.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }); cloth.userData.shared = true; }
	return cloth;
}

/** The shapes of one moving part (a leg, the head) as one mesh: a figure is drawn with a handful of calls instead of one
 *  per shape. The geometry is shared by every figure with the same part and has its three levels of detail (cached). */
function part(t: T, parent: G, shapes: Shape[], detailOnly = false): void {
	if (!shapes.length) return;
	const key = shapes.map((s) => { const g = s.g(), k = `${g.type}${JSON.stringify((g as Geo & { parameters?: unknown }).parameters)}`; g.dispose(); return `${k}|${s.c}|${s.p}|${s.r ?? ""}|${s.s ?? ""}`; }).join(";");
	const mesh = new t.Mesh(cached(`figure:${key}`, () => merge(t, shapes.map((s) => ({ g: s.g(), c: s.c, p: s.p, ...(s.r ? { r: s.r } : {}), ...(s.s ? { s: s.s } : {}), m: "none" as const })), "figure")), figureMaterial(t));
	if (detailOnly) { mesh.userData.detailOnly = true; mesh.visible = false; }
	parent.add(mesh);
}

export function makeFigure(t: T, look: Look): Figure {
	const h = stableHash(look.id), s = Math.abs(look.skin), st = look.style;
	const skin = st ? SKINS[st.skin]!.color : SKIN[(h >>> 3) % SKIN.length]!, hair = st ? HAIRS[st.hair]!.color : HAIR[(h >>> 7) % HAIR.length]!;
	// a chosen colour shows on one's own figure too (the ring and the label mark it); a figure a model plays stays blue
	const tunic = look.ai ? AI_TUNIC : st ? COATS[st.coat]!.color : look.own ? OWN_TUNIC : TUNIC[s % TUNIC.length]!;
	const trousers = TROUSERS[(st ? st.coat : s) % TROUSERS.length]!;
	const build = BUILD[st?.body ?? 0]!;
	const mesh = (geo: Geo, m: import("three").Material, x = 0, y = 0, z = 0) => { const o = new t.Mesh(geo, m); o.position.set(x, y, z); return o; };
	const shape = (g: () => Geo, c: number, x = 0, y = 0, z = 0, r?: V3, sc?: V3): Shape => ({ g, c, p: [x, y, z], ...(r ? { r } : {}), ...(sc ? { s: sc } : {}) });
	const group = new t.Group(); group.userData.owned = true;
	const blob = mesh(new t.CircleGeometry(0.34, 20), new t.MeshBasicMaterial({ map: shadow(t), transparent: true, depthWrite: false }), 0, 0.012);
	blob.rotation.x = -Math.PI / 2; blob.renderOrder = 1;
	group.add(blob);
	if (look.own) {
		const ring = mesh(new t.RingGeometry(0.27, 0.33, 28), new t.MeshBasicMaterial({ color: 0xaed83c, transparent: true, opacity: 0.85, depthWrite: false }), 0, 0.02);
		ring.rotation.x = -Math.PI / 2; ring.renderOrder = 2; group.add(ring);
	}
	// the body stands on y = 0 and faces +z; everything inside `body` is in metres of the cell (a person ≈ 0.9 high)
	const body = new t.Group(); body.scale.set(FIGURE_SCALE * build.wide, FIGURE_SCALE * build.tall, FIGURE_SCALE * build.wide); group.add(body);
	const leg = (side: number) => {
		const g = new t.Group(); g.position.set(side * 0.075, 0.4, 0);
		part(t, g, [shape(() => new t.CapsuleGeometry(0.052, 0.27, 4, 8), trousers, 0, -0.2), shape(() => new t.BoxGeometry(0.1, 0.06, 0.17), 0x2a2018, 0, -0.385, 0.03)]);
		body.add(g); return g;
	};
	const legL = leg(-1), legR = leg(1);
	const torso = new t.Group(); body.add(torso);
	const chest: Shape[] = [
		shape(() => new t.CapsuleGeometry(0.115, 0.17, 6, 12), tunic, 0, 0.58, 0, undefined, [1.12, 1, 0.78]),
		shape(() => new t.CylinderGeometry(0.128, 0.134, 0.035, 14), 0x3a2a1c, 0, 0.46), // belt
		build.dress
			? shape(() => new t.CylinderGeometry(0.135, 0.19, 0.34, 14, 1, true), tunic, 0, 0.3) // a long skirt down to the boots
			: shape(() => new t.CylinderGeometry(0.135, 0.15, 0.1, 14, 1, true), tunic, 0, 0.42), // tunic skirt
	];
	const arm = (side: number) => {
		const g = new t.Group(); g.position.set(side * 0.172, 0.69, 0);
		const shapes = [shape(() => new t.CapsuleGeometry(0.038, 0.2, 4, 8), tunic, 0, -0.13), st?.gloves ? shape(() => new t.SphereGeometry(0.046, 10, 8), GLOVE, 0, -0.275) : shape(() => new t.SphereGeometry(0.04, 10, 8), skin, 0, -0.275)];
		if (st?.gloves) shapes.push(shape(() => new t.CylinderGeometry(0.045, 0.042, 0.05, 10), GLOVE, 0, -0.235)); // the cuff
		part(t, g, shapes);
		body.add(g); return g;
	};
	const armL = arm(-1), armR = arm(1);
	const head = new t.Group(); head.position.set(0, 0.8, 0); body.add(head);
	const face: Shape[] = [
		shape(() => new t.CylinderGeometry(0.036, 0.042, 0.07, 10), skin, 0, -0.065), // neck
		shape(() => new t.SphereGeometry(0.094, 20, 16), skin, 0, 0.02),
		shape(() => new t.SphereGeometry(0.1, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.58), hair, 0, 0.03, -0.008, [-0.18, 0, 0]),
		shape(() => new t.SphereGeometry(0.014, 8, 6), 0x1c1612, -0.034, 0.03, 0.085), shape(() => new t.SphereGeometry(0.014, 8, 6), 0x1c1612, 0.034, 0.03, 0.085),
		shape(() => new t.SphereGeometry(0.016, 8, 6), skin, 0, 0.005, 0.094), // nose
	];
	if (build.long) face.push(shape(() => new t.CapsuleGeometry(0.075, 0.13, 4, 10), hair, 0, -0.05, -0.05, undefined, [1.15, 1, 0.6])); // long hair down the back
	if (st?.glasses) { // two round rims and a bridge, before the eyes
		for (const side of [-1, 1]) face.push(shape(() => new t.TorusGeometry(0.024, 0.0045, 6, 16), RIM, side * 0.036, 0.03, 0.094));
		face.push(shape(() => new t.BoxGeometry(0.026, 0.005, 0.005), RIM, 0, 0.034, 0.098));
		for (const side of [-1, 1]) face.push(shape(() => new t.BoxGeometry(0.005, 0.005, 0.09), RIM, side * 0.088, 0.032, 0.05));
	}
	// v2 (docs/3D-V2, catalogue sheet 4): a mouth, and from the figure's id a hat or a cap and a satchel, so that a crowd
	// up close is not a row of twins
	face.push(shape(() => new t.BoxGeometry(0.036, 0.008, 0.006), 0x7a3f2c, 0, -0.028, 0.09, [-0.25, 0, 0]));
	// the hat: the chosen one (appearance.ts HATS: none, hat, cap, captain's cap), else from the id
	const wear = st ? [-1, 0, 1, 2][st.hat]! : [0, 1, -1, -1][(h >>> 11) % 4]!, felt = HAT[(st ? st.coat : h >>> 13) % HAT.length]!;
	if (wear === 0) { // a brimmed hat
		face.push(shape(() => new t.CylinderGeometry(0.15, 0.15, 0.012, 20), felt, 0, 0.085, -0.004));
		face.push(shape(() => new t.CylinderGeometry(0.075, 0.088, 0.075, 16), felt, 0, 0.125, -0.006));
		face.push(shape(() => new t.CylinderGeometry(0.089, 0.089, 0.014, 16), 0x3a2a1c, 0, 0.097, -0.006));
	} else if (wear === 1) { // a knitted cap
		face.push(shape(() => new t.SphereGeometry(0.104, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), felt, 0, 0.045, -0.01));
		face.push(shape(() => new t.TorusGeometry(0.098, 0.016, 6, 18), felt, 0, 0.05, -0.01, [Math.PI / 2, 0, 0]));
	} else if (wear === 2) { // a captain's cap: a flat crown, a band and a visor over the eyes
		face.push(shape(() => new t.CylinderGeometry(0.112, 0.098, 0.05, 18), 0x1f2a3e, 0, 0.105, -0.008));
		face.push(shape(() => new t.CylinderGeometry(0.099, 0.099, 0.02, 18), 0x111111, 0, 0.083, -0.008));
		face.push(shape(() => new t.CylinderGeometry(0.07, 0.07, 0.008, 16, 1, false, -Math.PI / 2, Math.PI), 0x111111, 0, 0.078, 0.05, [0.18, 0, 0]));
		face.push(shape(() => new t.BoxGeometry(0.03, 0.02, 0.006), 0xc49c49, 0, 0.1, 0.1)); // the badge
	}
	const satchel = (h >>> 17) % 3 !== 0;
	if (satchel) { // a satchel on the left hip, its strap across the chest
		chest.push(shape(() => new t.BoxGeometry(0.05, 0.11, 0.12), 0x8a6a44, -0.17, 0.47, 0.02));
		chest.push(shape(() => new t.BoxGeometry(0.018, 0.36, 0.012), 0x5b3a22, 0, 0.6, 0.095, [0, 0, -0.62]));
	}
	part(t, head, face); part(t, torso, chest);
	// shown only close up: brows and ears, a buckle, a seam, the satchel's clasp
	const fineFace: Shape[] = [], fineChest: Shape[] = [];
	for (const side of [-1, 1]) {
		fineFace.push(shape(() => new t.BoxGeometry(0.033, 0.007, 0.008), hair, side * 0.035, 0.052, 0.083));
		fineFace.push(shape(() => new t.SphereGeometry(0.02, 8, 4), skin, side * 0.092, 0.008, 0));
	}
	fineChest.push(shape(() => new t.BoxGeometry(0.035, 0.03, 0.012), 0xc49c49, 0, 0.46, 0.13));
	fineChest.push(shape(() => new t.BoxGeometry(0.005, 0.15, 0.005), 0xd4c6a7, 0.025, 0.59, 0.105));
	if (satchel) fineChest.push(shape(() => new t.BoxGeometry(0.009, 0.027, 0.019), 0xb9a16c, -0.198, 0.49, 0.02));
	part(t, head, fineFace, true); part(t, torso, fineChest, true);
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
