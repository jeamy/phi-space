// Models for the 3D map: trees and bushes, the hut, the rain barrel, the windmill, the bakery, the coop and the pen, a site that grows with its progress, a ruin, the
// fire's stone ring, a signpost at an exit. Built from primitives in a chunky low-poly style (faceted faces, a few warm
// colours, every face a shade lighter or darker), so they need no model file. Each model is one merged geometry with
// vertex colours, made once per kind and variant and shared (userData.shared: the map's dispose keeps it); where it
// stands, how it is turned and how large it is come from the place, so a room looks the same every time it is drawn.
// Everything here is visual only (docs/architektur.md, "3D-Ansicht").
import { stableHash } from "./terrain3d.ts";

type T = typeof import("three");
type Geo = import("three").BufferGeometry;
type V3 = [number, number, number];
/** One primitive of a model: its geometry, colour, place, turn and size. */
type Part = { g: Geo; c: number; p?: V3; r?: V3; s?: V3 };

export type PlantModel = "tree" | "conifer" | "bush" | "berrybush";
/** How many shapes of each plant there are; a place picks one. */
export const PLANT_VARIANTS = 3;

const BARK = 0x6b4a2e, LEAF = [0x4f8f3a, 0x5c9c42, 0x437d33], NEEDLE = [0x2f6b3a, 0x3a7a42, 0x285c33];
const STONE = 0x8a8577, STONE_DARK = 0x6a675e, WOOD = 0x8a6a44, WOOD_DARK = 0x5b3a22, THATCH = [0xb8954e, 0xa98545, 0xc4a25c];

/** A place's own numbers: which variant, how far turned, how large (0.88 to 1.12). */
export function placeLook(key: string): { variant: number; turn: number; size: number } {
	const h = stableHash(key);
	return { variant: h % PLANT_VARIANTS, turn: (((h >>> 4) & 255) / 256) * Math.PI * 2, size: 0.88 + (((h >>> 12) & 255) / 255) * 0.24 };
}

/** A small deterministic random stream for the shape of one variant. */
function rand(seed: string): () => number {
	let h = stableHash(seed) || 1;
	return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10_000) / 10_000; };
}

/** The parts merged into one geometry: positions, flat normals and a colour per face (a little lighter or darker). */
function merge(t: T, parts: Part[], seed: string): Geo {
	const pos: number[] = [], col: number[] = [], r = rand(`${seed}:shade`);
	const m = new t.Matrix4(), q = new t.Quaternion(), e = new t.Euler(), c = new t.Color();
	for (const part of parts) {
		const g = part.g.index ? part.g.toNonIndexed() : part.g;
		m.compose(new t.Vector3(...(part.p ?? [0, 0, 0])), q.setFromEuler(e.set(...(part.r ?? [0, 0, 0]))), new t.Vector3(...(part.s ?? [1, 1, 1])));
		g.applyMatrix4(m);
		const a = g.getAttribute("position");
		for (let i = 0; i < a.count; i += 3) {
			c.setHex(part.c).multiplyScalar(0.9 + r() * 0.18);
			for (let k = 0; k < 3; k++) { pos.push(a.getX(i + k), a.getY(i + k), a.getZ(i + k)); col.push(c.r, c.g, c.b); }
		}
		g.dispose(); if (g !== part.g) part.g.dispose();
	}
	const out = new t.BufferGeometry();
	out.setAttribute("position", new t.Float32BufferAttribute(pos, 3));
	out.setAttribute("color", new t.Float32BufferAttribute(col, 3));
	out.computeVertexNormals(); // not indexed: every face keeps its own normal (faceted)
	out.computeBoundingSphere();
	out.userData.shared = true;
	return out;
}

let material: import("three").MeshStandardMaterial | null = null;
/** The one material of every model: the colours are in the vertices. */
export function propMaterial(t: T): import("three").MeshStandardMaterial {
	if (!material) { material = new t.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.88, metalness: 0 }); material.userData.shared = true; }
	return material;
}

const cache = new Map<string, Geo>();
function cached(key: string, make: () => Geo): Geo {
	let g = cache.get(key);
	if (!g) { g = make(); cache.set(key, g); }
	return g;
}

// ---- plants ----

/** A plant's geometry (about 1.7 units for a tree, 0.6 for a bush), standing on y = 0. */
export function plantGeometry(t: T, model: PlantModel, variant: number): Geo {
	return cached(`${model}:${variant}`, () => {
		const r = rand(`${model}:${variant}`), parts: Part[] = [];
		const blob = (radius: number, c: number, p: V3) => parts.push({ g: new t.IcosahedronGeometry(radius, 0), c, p, r: [r() * 3, r() * 3, r() * 3] });
		if (model === "tree") {
			const trunk = 0.62 + r() * 0.18;
			parts.push({ g: new t.CylinderGeometry(0.07, 0.11, trunk, 6), c: BARK, p: [0, trunk / 2, 0] });
			for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2 + r(); parts.push({ g: new t.BoxGeometry(0.22, 0.06, 0.07), c: BARK, p: [Math.cos(a) * 0.1, 0.03, Math.sin(a) * 0.1], r: [0, -a, 0.25] }); }
			blob(0.46 + r() * 0.08, LEAF[variant % 3]!, [0, trunk + 0.42, 0]);
			for (let i = 0; i < 3 + (variant % 2); i++) { const a = (i / 3.5) * Math.PI * 2 + r(); blob(0.28 + r() * 0.1, LEAF[(variant + i) % 3]!, [Math.cos(a) * 0.3, trunk + 0.28 + r() * 0.42, Math.sin(a) * 0.3]); }
		} else if (model === "conifer") {
			parts.push({ g: new t.CylinderGeometry(0.06, 0.09, 0.4, 6), c: BARK, p: [0, 0.2, 0] });
			const tiers = 3 + (variant % 2);
			for (let i = 0; i < tiers; i++) {
				const k = i / tiers, rad = 0.46 - k * 0.3, hi = 0.62 - k * 0.12;
				parts.push({ g: new t.ConeGeometry(rad, hi, 7), c: NEEDLE[(variant + i) % 3]!, p: [0, 0.48 + i * 0.36 + hi / 2 - 0.2, 0], r: [0, r() * 3, 0] });
			}
		} else {
			const n = 3 + (variant % 2);
			for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + r(); blob(0.2 + r() * 0.09, LEAF[(variant + i) % 3]!, [Math.cos(a) * 0.15, 0.2 + r() * 0.14, Math.sin(a) * 0.15]); }
			blob(0.24, LEAF[variant % 3]!, [0, 0.34, 0]);
			if (model === "berrybush") for (let i = 0; i < 9; i++) {
				const a = r() * Math.PI * 2, up = 0.18 + r() * 0.3;
				parts.push({ g: new t.IcosahedronGeometry(0.045, 0), c: 0xc8323a, p: [Math.cos(a) * 0.3, up, Math.sin(a) * 0.3] });
			}
		}
		return merge(t, parts, `${model}:${variant}`);
	});
}

// ---- buildings ----

/** A plank hut w×d on a stone plinth: corner posts, a straw gable roof with a ridge beam, a door and a window towards +z,
 *  a stone chimney, a stack of firewood beside it. About 1.7 units high for 2×2. */
function hut(t: T, w: number, d: number, wall: number, variant: number): Geo {
	return cached(`hut:${w}x${d}:${wall}:${variant}`, () => {
		const r = rand(`hut:${variant}`), parts: Part[] = [], ww = w * 0.8, dd = d * 0.78, wh = 0.72, roofC = THATCH[variant % 3]!;
		parts.push({ g: new t.BoxGeometry(w * 0.9, 0.12, d * 0.9), c: STONE, p: [0, 0.06, 0] });
		parts.push({ g: new t.BoxGeometry(ww, wh, dd), c: wall, p: [0, 0.12 + wh / 2, 0] });
		// planks: a darker strip every so often around the walls
		for (let i = 1; i < 4; i++) parts.push({ g: new t.BoxGeometry(ww + 0.02, 0.03, dd + 0.02), c: WOOD_DARK, p: [0, 0.12 + (wh * i) / 4, 0] });
		for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) parts.push({ g: new t.BoxGeometry(0.11, wh + 0.06, 0.11), c: WOOD_DARK, p: [sx * ww / 2, 0.12 + wh / 2 + 0.03, sz * dd / 2] });
		// the gables (a triangle, extruded along x) and the two roof planes over them, the ridge along x
		const rise = 0.5, top = 0.12 + wh;
		const tri = new t.Shape(); tri.moveTo(-dd / 2, 0); tri.lineTo(dd / 2, 0); tri.lineTo(0, rise); tri.closePath();
		parts.push({ g: new t.ExtrudeGeometry(tri, { depth: ww, bevelEnabled: false }), c: wall, p: [-ww / 2, top, 0], r: [0, Math.PI / 2, 0] });
		const slope = Math.atan2(rise, dd / 2), len = Math.hypot(rise, dd / 2) + 0.16;
		for (const side of [-1, 1]) parts.push({ g: new t.BoxGeometry(w * 0.98, 0.07, len), c: roofC, p: [0, top + rise / 2 + 0.04, side * (dd / 4 + 0.04)], r: [side * slope, 0, 0] });
		parts.push({ g: new t.BoxGeometry(w * 1.0, 0.08, 0.1), c: WOOD_DARK, p: [0, top + rise + 0.05, 0] });
		// door and window on the front (+z), the chimney on one side of the ridge
		const front = dd / 2 + 0.015;
		parts.push({ g: new t.BoxGeometry(0.3, 0.48, 0.04), c: 0x3a2a18, p: [w > 1.5 ? -0.25 : 0, 0.12 + 0.24, front] });
		if (w > 1.5) {
			parts.push({ g: new t.BoxGeometry(0.28, 0.24, 0.04), c: WOOD_DARK, p: [0.35, 0.12 + 0.44, front] });
			parts.push({ g: new t.BoxGeometry(0.2, 0.16, 0.05), c: 0xf2c46a, p: [0.35, 0.12 + 0.44, front] }); // lamplight
		}
		const cx = (variant % 2 ? 1 : -1) * ww * 0.28;
		parts.push({ g: new t.BoxGeometry(0.16, 0.5, 0.16), c: STONE_DARK, p: [cx, top + rise * 0.55 + 0.2, -dd * 0.18] });
		// firewood stacked against the left wall
		for (let i = 0; i < 5; i++) parts.push({ g: new t.CylinderGeometry(0.045, 0.045, 0.34, 6), c: i % 2 ? BARK : WOOD, p: [-ww / 2 - 0.08, 0.17 + Math.floor(i / 3) * 0.08, -0.15 + (i % 3) * 0.1 + (i >= 3 ? 0.05 : 0)], r: [Math.PI / 2, 0, 0] });
		void r;
		return merge(t, parts, `hut:${variant}`);
	});
}

/** The rain barrel: staves, two iron hoops, rainwater at the top, on a flat stone. */
function barrel(t: T): Geo {
	return cached("barrel", () => merge(t, [
		{ g: new t.CylinderGeometry(0.36, 0.38, 0.08, 8), c: STONE, p: [0, 0.04, 0] },
		{ g: new t.CylinderGeometry(0.27, 0.24, 0.62, 12), c: WOOD, p: [0, 0.39, 0] },
		{ g: new t.TorusGeometry(0.265, 0.025, 4, 14), c: 0x44464a, p: [0, 0.22, 0], r: [Math.PI / 2, 0, 0] },
		{ g: new t.TorusGeometry(0.275, 0.025, 4, 14), c: 0x44464a, p: [0, 0.58, 0], r: [Math.PI / 2, 0, 0] },
		{ g: new t.CylinderGeometry(0.24, 0.24, 0.02, 12), c: 0x3d7fa0, p: [0, 0.68, 0] },
	], "barrel"));
}

/** The scarecrow: a driftwood post and crossbar in a patched shirt, a straw head under a wide hat, straw sticking out
 *  of the sleeves, on a little mound. About 1.3 units high. */
function scarecrow(t: T, variant: number): Geo {
	return cached(`scarecrow:${variant}`, () => {
		const shirt = [0x8a4a3a, 0x4a6a8a, 0x6a7a3a][variant % 3]!, straw = 0xd8b45a, parts: Part[] = [
			{ g: new t.CylinderGeometry(0.22, 0.3, 0.1, 8), c: 0x6b5236, p: [0, 0.05, 0] },
			{ g: new t.BoxGeometry(0.07, 1.05, 0.07), c: WOOD_DARK, p: [0, 0.55, 0] },
			{ g: new t.BoxGeometry(0.78, 0.06, 0.06), c: WOOD_DARK, p: [0, 0.82, 0] },
			{ g: new t.BoxGeometry(0.3, 0.36, 0.18), c: shirt, p: [0, 0.74, 0], r: [0, 0, 0.04] },
			{ g: new t.BoxGeometry(0.62, 0.12, 0.13), c: shirt, p: [0, 0.84, 0] },
			{ g: new t.BoxGeometry(0.1, 0.06, 0.19), c: 0xc8a050, p: [0.06, 0.66, 0.0] }, // a patch
			{ g: new t.ConeGeometry(0.06, 0.16, 5), c: straw, p: [0.39, 0.82, 0], r: [0, 0, -Math.PI / 2] },
			{ g: new t.ConeGeometry(0.06, 0.16, 5), c: straw, p: [-0.39, 0.82, 0], r: [0, 0, Math.PI / 2] },
			{ g: new t.ConeGeometry(0.1, 0.14, 6), c: straw, p: [0, 0.52, 0], r: [Math.PI, 0, 0] }, // straw from the shirt's hem
			{ g: new t.IcosahedronGeometry(0.14, 0), c: straw, p: [0, 1.05, 0] },
			{ g: new t.BoxGeometry(0.035, 0.035, 0.02), c: 0x2a2018, p: [-0.05, 1.07, 0.13] },
			{ g: new t.BoxGeometry(0.035, 0.035, 0.02), c: 0x2a2018, p: [0.05, 1.07, 0.13] },
			{ g: new t.CylinderGeometry(0.26, 0.26, 0.03, 9), c: 0x7a5a30, p: [0, 1.16, 0], r: [0.12, 0, 0.05] },
			{ g: new t.ConeGeometry(0.13, 0.2, 7), c: 0x7a5a30, p: [0, 1.27, 0], r: [0.12, 0, 0.05] },
		];
		return merge(t, parts, `scarecrow:${variant}`);
	});
}

/** The windmill: a tapering eight-sided tower of planks on a stone plinth, a thatched cap, and four linen sails on a hub
 *  towards +z (one turned a little per variant), a door at the foot. About 2.6 units high. */
function windmill(t: T, variant: number): Geo {
	return cached(`windmill:${variant}`, () => {
		const LINEN = 0xe8e0cc, parts: Part[] = [
			{ g: new t.CylinderGeometry(0.85, 0.9, 0.14, 8), c: STONE, p: [0, 0.07, 0] },
			{ g: new t.CylinderGeometry(0.42, 0.7, 1.6, 8), c: WOOD, p: [0, 0.94, 0] },
			{ g: new t.CylinderGeometry(0.6, 0.6, 0.05, 8), c: WOOD_DARK, p: [0, 0.6, 0] },
			{ g: new t.CylinderGeometry(0.5, 0.5, 0.05, 8), c: WOOD_DARK, p: [0, 1.2, 0] },
			{ g: new t.ConeGeometry(0.58, 0.55, 8), c: THATCH[variant % 3]!, p: [0, 2.0, 0] },
			{ g: new t.BoxGeometry(0.28, 0.46, 0.06), c: 0x3a2a18, p: [0, 0.37, 0.66], r: [-0.12, 0, 0] },
			{ g: new t.CylinderGeometry(0.07, 0.07, 0.36, 6), c: WOOD_DARK, p: [0, 1.85, 0.5], r: [Math.PI / 2, 0, 0] },
		];
		const turn = (variant * Math.PI) / 7;
		for (let i = 0; i < 4; i++) {
			const a = turn + (i * Math.PI) / 2, cx = Math.cos(a), cy = Math.sin(a), y = 1.85, z = 0.7;
			parts.push({ g: new t.BoxGeometry(0.05, 1.05, 0.04), c: WOOD_DARK, p: [-cy * 0.52, y + cx * 0.52, z], r: [0, 0, a] }); // the stock
			parts.push({ g: new t.BoxGeometry(0.24, 0.8, 0.02), c: LINEN, p: [-cy * 0.6 + cx * 0.13, y + cx * 0.6 + cy * 0.13, z + 0.02], r: [0, 0, a] }); // the sail
		}
		return merge(t, parts, `windmill:${variant}`);
	});
}

/** The bakery: a squat stone house with a plank roof, and beside it the round clay oven with its mouth and chimney.
 *  About 1.5 units high for 2×2. */
function bakery(t: T, w: number, d: number, variant: number): Geo {
	return cached(`bakery:${w}x${d}:${variant}`, () => {
		const CLAY = 0xb0604a, ww = w * 0.55, dd = d * 0.75, wh = 0.62, parts: Part[] = [
			{ g: new t.BoxGeometry(w * 0.92, 0.1, d * 0.9), c: STONE, p: [0, 0.05, 0] },
			{ g: new t.BoxGeometry(ww, wh, dd), c: STONE_DARK, p: [-w * 0.18, 0.1 + wh / 2, 0] },
			{ g: new t.BoxGeometry(ww + 0.16, 0.08, dd + 0.16), c: WOOD_DARK, p: [-w * 0.18, 0.1 + wh + 0.04, 0], r: [0, 0, 0.12] },
			{ g: new t.BoxGeometry(0.26, 0.42, 0.04), c: 0x3a2a18, p: [-w * 0.18, 0.1 + 0.21, dd / 2 + 0.015] },
			{ g: new t.SphereGeometry(0.42, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), c: CLAY, p: [w * 0.27, 0.1, 0.05] },
			{ g: new t.BoxGeometry(0.2, 0.16, 0.06), c: 0x2a1a10, p: [w * 0.27, 0.18, 0.46] },
			{ g: new t.BoxGeometry(0.14, 0.12, 0.05), c: 0xf2a04a, p: [w * 0.27, 0.17, 0.47] }, // embers
			{ g: new t.CylinderGeometry(0.07, 0.09, 0.4, 6), c: STONE_DARK, p: [w * 0.27, 0.62, -0.1] },
		];
		for (let i = 0; i < 3; i++) parts.push({ g: new t.CylinderGeometry(0.04, 0.04, 0.3, 6), c: i % 2 ? BARK : WOOD, p: [w * 0.27 + (i - 1) * 0.09, 0.14, -0.42], r: [0, 0, Math.PI / 2] });
		return merge(t, parts, `bakery:${variant}`);
	});
}

/** A hen, small, facing +z, at a place: body, tail, head, red comb. */
function henParts(t: T, x: number, z: number, turn: number): Part[] {
	const c = Math.cos(turn), s = Math.sin(turn), at = (dx: number, y: number, dz: number): V3 => [x + dx * c + dz * s, y, z - dx * s + dz * c];
	return [
		{ g: new t.IcosahedronGeometry(0.11, 0), c: 0xb0703a, p: at(0, 0.12, 0), s: [1, 0.9, 1.3] },
		{ g: new t.ConeGeometry(0.06, 0.12, 4), c: 0x6e3e1a, p: at(0, 0.2, -0.12), r: [-0.8, turn, 0] },
		{ g: new t.IcosahedronGeometry(0.065, 0), c: 0xb0703a, p: at(0, 0.24, 0.1) },
		{ g: new t.BoxGeometry(0.02, 0.05, 0.06), c: 0xd83a2a, p: at(0, 0.31, 0.1) },
	];
}

/** The hen house w×1: a little plank shed on legs, a pent roof, a ramp to its hatch towards +z, and hens about it. */
function coop(t: T, w: number, variant: number): Geo {
	return cached(`coop:${w}:${variant}`, () => {
		const ww = w * 0.55, parts: Part[] = [
			...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => ({ g: new t.BoxGeometry(0.06, 0.22, 0.06), c: WOOD_DARK, p: [-w * 0.18 + sx! * ww * 0.45, 0.11, sz! * 0.25] as V3 })),
			{ g: new t.BoxGeometry(ww, 0.4, 0.6), c: WOOD, p: [-w * 0.18, 0.42, 0] },
			{ g: new t.BoxGeometry(ww + 0.14, 0.05, 0.74), c: THATCH[variant % 3]!, p: [-w * 0.18, 0.66, 0], r: [0.22, 0, 0] },
			{ g: new t.BoxGeometry(0.14, 0.14, 0.03), c: 0x2a1a10, p: [-w * 0.18, 0.4, 0.31] },
			{ g: new t.BoxGeometry(0.14, 0.03, 0.42), c: WOOD_DARK, p: [-w * 0.18, 0.18, 0.48], r: [0.55, 0, 0] },
		];
		const r = rand(`coop:${variant}`);
		for (let i = 0; i < 3; i++) parts.push(...henParts(t, w * 0.12 + r() * w * 0.3, -0.25 + r() * 0.5, r() * Math.PI * 2));
		return merge(t, parts, `coop:${variant}`);
	});
}

/** The pen w×d: a driftwood fence of posts and two rails, a trough, a little shelter in a corner, a sheep inside. */
function pen(t: T, w: number, d: number, variant: number): Geo {
	return cached(`pen:${w}x${d}:${variant}`, () => {
		const ww = w * 0.92, dd = d * 0.92, parts: Part[] = [];
		const posts = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n - 0.5);
		for (const f of posts(Math.round(w * 2))) for (const sz of [-1, 1]) parts.push({ g: new t.BoxGeometry(0.07, 0.42, 0.07), c: WOOD_DARK, p: [f * ww, 0.21, (sz * dd) / 2] });
		for (const f of posts(Math.round(d * 2))) for (const sx of [-1, 1]) parts.push({ g: new t.BoxGeometry(0.07, 0.42, 0.07), c: WOOD_DARK, p: [(sx * ww) / 2, 0.21, f * dd] });
		for (const y of [0.16, 0.33]) {
			for (const sz of [-1, 1]) parts.push({ g: new t.BoxGeometry(ww, 0.04, 0.04), c: WOOD, p: [0, y, (sz * dd) / 2] });
			for (const sx of [-1, 1]) parts.push({ g: new t.BoxGeometry(0.04, 0.04, dd), c: WOOD, p: [(sx * ww) / 2, y, 0] });
		}
		parts.push({ g: new t.BoxGeometry(0.5, 0.12, 0.18), c: WOOD_DARK, p: [ww * 0.2, 0.06, dd * 0.32] }); // the trough
		parts.push({ g: new t.BoxGeometry(0.7, 0.45, 0.6), c: WOOD, p: [-ww * 0.3, 0.23, -dd * 0.3] });  // the shelter
		parts.push({ g: new t.BoxGeometry(0.82, 0.05, 0.74), c: THATCH[variant % 3]!, p: [-ww * 0.3, 0.5, -dd * 0.3], r: [0.2, 0, 0] });
		const wool = [0xe8e4d8, 0xd8d0c0, 0xf0ece0][variant % 3]!;
		parts.push({ g: new t.IcosahedronGeometry(0.2, 0), c: wool, p: [ww * 0.1, 0.28, 0], s: [1.3, 0.9, 1] });
		parts.push({ g: new t.IcosahedronGeometry(0.09, 0), c: 0x3a3430, p: [ww * 0.1 + 0.27, 0.32, 0] });
		for (const [dx, dz] of [[-0.12, -0.08], [-0.12, 0.08], [0.14, -0.08], [0.14, 0.08]] as const) parts.push({ g: new t.BoxGeometry(0.04, 0.16, 0.04), c: 0x3a3430, p: [ww * 0.1 + dx, 0.08, dz] });
		return merge(t, parts, `pen:${variant}`);
	});
}

/** A building by its plan: the hut, the rain barrel, the scarecrow, the windmill, the bakery, the coop, the pen, any other plan a hut in its colour. */
export function buildingGeometry(t: T, plan: string | undefined, w: number, d: number, color: number, variant: number): Geo {
	return plan === "regentonne" ? barrel(t) : plan === "vogelscheuche" ? scarecrow(t, variant % 3) : plan === "windmuehle" ? windmill(t, variant % 3) : plan === "backhaus" ? bakery(t, w, d, variant % 3) : plan === "huehnerstall" ? coop(t, w, variant % 3) : plan === "gehege" ? pen(t, w, d, variant % 3) : hut(t, w, d, color, variant % 3);
}

/** A hare, sitting up a little, its nose towards +z: body, haunches, head, long ears, a white scut. About 0.4 high. */
export function hareGeometry(t: T, variant: number): Geo {
	return cached(`hare:${variant}`, () => {
		const fur = [0x9a7f5e, 0x8a7258, 0xa88e6a][variant % 3]!, belly = 0xd9c9ae;
		return merge(t, [
			{ g: new t.IcosahedronGeometry(0.15, 0), c: fur, p: [0, 0.16, -0.04], s: [1, 0.95, 1.35] },
			{ g: new t.IcosahedronGeometry(0.1, 0), c: fur, p: [0.09, 0.1, -0.12] },
			{ g: new t.IcosahedronGeometry(0.1, 0), c: fur, p: [-0.09, 0.1, -0.12] },
			{ g: new t.IcosahedronGeometry(0.09, 0), c: belly, p: [0, 0.13, 0.08], s: [1, 1.1, 0.8] },
			{ g: new t.IcosahedronGeometry(0.095, 0), c: fur, p: [0, 0.3, 0.13], s: [0.95, 0.9, 1.15] },
			{ g: new t.BoxGeometry(0.045, 0.2, 0.025), c: fur, p: [0.04, 0.45, 0.09], r: [-0.35, 0, 0.18] },
			{ g: new t.BoxGeometry(0.045, 0.2, 0.025), c: fur, p: [-0.04, 0.45, 0.09], r: [-0.35, 0, -0.18] },
			{ g: new t.BoxGeometry(0.025, 0.14, 0.01), c: 0xd8a0a0, p: [0.04, 0.45, 0.105], r: [-0.35, 0, 0.18] },
			{ g: new t.BoxGeometry(0.025, 0.14, 0.01), c: 0xd8a0a0, p: [-0.04, 0.45, 0.105], r: [-0.35, 0, -0.18] },
			{ g: new t.IcosahedronGeometry(0.02, 0), c: 0x3a2a2a, p: [0, 0.3, 0.23] },
			{ g: new t.BoxGeometry(0.02, 0.02, 0.02), c: 0x111111, p: [0.055, 0.33, 0.19] },
			{ g: new t.BoxGeometry(0.02, 0.02, 0.02), c: 0x111111, p: [-0.055, 0.33, 0.19] },
			{ g: new t.IcosahedronGeometry(0.045, 0), c: 0xf2efe8, p: [0, 0.17, -0.25] },
			{ g: new t.BoxGeometry(0.04, 0.04, 0.12), c: fur, p: [0.05, 0.03, 0.12] },
			{ g: new t.BoxGeometry(0.04, 0.04, 0.12), c: fur, p: [-0.05, 0.03, 0.12] },
		], `hare:${variant}`);
	});
}

/** A fence round a bed w×d: driftwood posts of uneven height at the corners and between the cells, two rails on each
 *  side, a little gate in the front rail. */
export function fenceGeometry(t: T, w: number, d: number): Geo {
	return cached(`fence:${w}x${d}`, () => {
		const r = rand(`fence:${w}x${d}`), parts: Part[] = [], wood = 0x9a7a4a, grey = 0x8f8676;
		for (let i = 0; i <= w; i++) for (let j = 0; j <= d; j++) {
			if (i > 0 && i < w && j > 0 && j < d) continue;
			const hh = 0.34 + r() * 0.08;
			parts.push({ g: new t.BoxGeometry(0.07, hh, 0.07), c: r() < 0.5 ? wood : grey, p: [i - w / 2, hh / 2, j - d / 2], r: [0, r() * 0.6, (r() - 0.5) * 0.08] });
		}
		for (const y of [0.14, 0.27]) {
			parts.push({ g: new t.BoxGeometry(w, 0.04, 0.035), c: wood, p: [0, y, -d / 2] });
			parts.push({ g: new t.BoxGeometry(0.035, 0.04, d), c: wood, p: [-w / 2, y, 0] });
			parts.push({ g: new t.BoxGeometry(0.035, 0.04, d), c: wood, p: [w / 2, y, 0] });
			// the front: rails beside the gate, the gate's own boards a little darker
			parts.push({ g: new t.BoxGeometry(w / 2 - 0.25, 0.04, 0.035), c: wood, p: [-w / 4 - 0.125, y, d / 2] });
			parts.push({ g: new t.BoxGeometry(w / 2 - 0.25, 0.04, 0.035), c: wood, p: [w / 4 + 0.125, y, d / 2] });
			parts.push({ g: new t.BoxGeometry(0.46, 0.05, 0.03), c: WOOD_DARK, p: [0, y, d / 2 + 0.01] });
		}
		parts.push({ g: new t.BoxGeometry(0.04, 0.2, 0.03), c: WOOD_DARK, p: [0, 0.2, d / 2 + 0.01], r: [0, 0, 0.9] }); // the gate's brace
		return merge(t, parts, `fence:${w}x${d}`);
	});
}

/** A site w×d at `progress` (0..1): its corner posts and sill, the walls rising in planks, a scaffold that comes with
 *  them, a pile of driftwood and a coil of rope beside it. One geometry per tenth of progress. */
export function siteGeometry(t: T, plan: string | undefined, w: number, d: number, color: number, progress: number): Geo {
	const step = Math.round(Math.max(0, Math.min(1, progress)) * 10);
	return cached(`site:${plan}:${w}x${d}:${color}:${step}`, () => {
		const r = rand(`site:${step}`), parts: Part[] = [], ww = w * 0.8, dd = d * 0.78, done = step / 10, wh = 0.72 * done;
		parts.push({ g: new t.BoxGeometry(w * 0.9, 0.06, d * 0.9), c: 0x9a8160, p: [0, 0.03, 0] }); // trodden earth
		for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) parts.push({ g: new t.BoxGeometry(0.1, 0.85, 0.1), c: WOOD_DARK, p: [sx * ww / 2, 0.08 + 0.425, sz * dd / 2] });
		if (wh > 0.02) {
			const rows = Math.max(1, Math.round(done * 5));
			for (let i = 0; i < rows; i++) {
				const y = 0.08 + (i + 0.5) * (wh / rows);
				for (const side of [-1, 1]) {
					parts.push({ g: new t.BoxGeometry(ww, wh / rows - 0.015, 0.1), c: i % 2 ? color : WOOD, p: [0, y, side * dd / 2] });
					parts.push({ g: new t.BoxGeometry(0.1, wh / rows - 0.015, dd), c: i % 2 ? WOOD : color, p: [side * ww / 2, y, 0] });
				}
			}
		}
		// scaffold: a pole at each corner a little outside, rails at the height the walls have reached
		const sh = Math.max(0.5, wh + 0.3);
		for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) parts.push({ g: new t.CylinderGeometry(0.025, 0.025, sh, 5), c: 0xa58a5e, p: [sx * (ww / 2 + 0.16), sh / 2, sz * (dd / 2 + 0.16)] });
		for (const y of [sh * 0.45, sh - 0.04]) for (const side of [-1, 1]) {
			parts.push({ g: new t.BoxGeometry(ww + 0.32, 0.03, 0.03), c: 0xa58a5e, p: [0, y, side * (dd / 2 + 0.16)] });
			parts.push({ g: new t.BoxGeometry(0.03, 0.03, dd + 0.32), c: 0xa58a5e, p: [side * (ww / 2 + 0.16), y, 0] });
		}
		// what still waits to be built: the pile shrinks as the walls grow
		const logs = Math.max(1, Math.round((1 - done) * 6));
		for (let i = 0; i < logs; i++) parts.push({ g: new t.CylinderGeometry(0.045, 0.045, Math.min(0.5, ww * 0.6), 6), c: i % 2 ? WOOD : BARK, p: [(i % 3 - 1) * 0.1, 0.06 + Math.floor(i / 3) * 0.08, dd / 2 + 0.1], r: [0, 0, Math.PI / 2] });
		if (done < 1) parts.push({ g: new t.TorusGeometry(0.09, 0.035, 5, 10), c: 0x6f7a3c, p: [-ww / 2 + 0.12, 0.12, -dd / 2 - 0.08], r: [Math.PI / 2, 0, 0] });
		void r; void plan;
		return merge(t, parts, `site:${step}`);
	});
}

/** A ruin w×d: the plinth cracked, two wall stubs with jagged tops, roof beams fallen across, stones about. */
export function ruinGeometry(t: T, w: number, d: number, variant: number): Geo {
	return cached(`ruin:${w}x${d}:${variant}`, () => {
		const r = rand(`ruin:${variant}`), parts: Part[] = [], ww = w * 0.8, dd = d * 0.78;
		parts.push({ g: new t.BoxGeometry(w * 0.84, 0.08, d * 0.84), c: STONE, p: [0, 0.04, 0] });
		for (let i = 0; i < 4; i++) { const hh = 0.2 + r() * 0.45; parts.push({ g: new t.BoxGeometry(ww / 4 - 0.02, hh, 0.1), c: i % 2 ? WOOD_DARK : 0x6e5a40, p: [-ww / 2 + ww / 8 + (i * ww) / 4, 0.1 + hh / 2, -dd / 2] }); }
		for (let i = 0; i < 3; i++) { const hh = 0.12 + r() * 0.35; parts.push({ g: new t.BoxGeometry(0.1, hh, dd / 3 - 0.02), c: 0x6e5a40, p: [-ww / 2, 0.1 + hh / 2, -dd / 2 + dd / 6 + (i * dd) / 3] }); }
		parts.push({ g: new t.BoxGeometry(0.11, 0.6, 0.11), c: WOOD_DARK, p: [ww / 2, 0.4, dd / 2] });
		for (let i = 0; i < 3; i++) parts.push({ g: new t.BoxGeometry(w * 0.7, 0.07, 0.09), c: i ? 0x7a6a4a : WOOD_DARK, p: [(r() - 0.5) * 0.3, 0.14 + i * 0.06, (r() - 0.5) * dd * 0.6], r: [0, (r() - 0.5) * 1.2, (r() - 0.5) * 0.3] });
		for (let i = 0; i < 6; i++) parts.push({ g: new t.DodecahedronGeometry(0.06 + r() * 0.06, 0), c: STONE, p: [(r() - 0.5) * w * 1.05, 0.08, (r() - 0.5) * d * 1.05], r: [r() * 3, r() * 3, 0] });
		return merge(t, parts, `ruin:${variant}`);
	});
}

// ---- the fire, exits, a shadow ----

/** The fire's stone ring on a low plinth, logs leaning together in it (the flame and its light are the map's). */
export function fireGeometry(t: T): Geo {
	return cached("fire", () => {
		const parts: Part[] = [{ g: new t.CylinderGeometry(0.42, 0.46, 0.1, 10), c: STONE_DARK, p: [0, 0.05, 0] }];
		for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2; parts.push({ g: new t.DodecahedronGeometry(0.1, 0), c: i % 3 ? STONE : STONE_DARK, p: [Math.cos(a) * 0.32, 0.15, Math.sin(a) * 0.32], r: [a, a * 2, 0] }); }
		for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + 0.4; parts.push({ g: new t.CylinderGeometry(0.04, 0.05, 0.42, 6), c: i % 2 ? BARK : 0x3a2a1a, p: [Math.cos(a) * 0.09, 0.26, Math.sin(a) * 0.09], r: [Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6] }); }
		return merge(t, parts, "fire");
	});
}

/** A signpost at an exit: a post and a board pointing on. */
export function signGeometry(t: T): Geo {
	return cached("sign", () => merge(t, [
		{ g: new t.BoxGeometry(0.08, 0.7, 0.08), c: WOOD_DARK, p: [0, 0.35, 0] },
		{ g: new t.BoxGeometry(0.42, 0.14, 0.04), c: WOOD, p: [0.1, 0.56, 0] },
		{ g: new t.ConeGeometry(0.1, 0.12, 3), c: WOOD, p: [0.36, 0.56, 0], r: [0, 0, -Math.PI / 2] },
		{ g: new t.DodecahedronGeometry(0.08, 0), c: STONE, p: [0.05, 0.03, 0.04] },
	], "sign"));
}

let shadowMaterial: import("three").MeshBasicMaterial | null = null, shadowGeo: Geo | null = null;
/** A soft round shadow on the ground, `w`×`d` across. */
export function propShadow(t: T, w: number, d: number): import("three").Mesh {
	if (!shadowMaterial) {
		const c = document.createElement("canvas"); c.width = c.height = 64;
		const g = c.getContext("2d")!, grad = g.createRadialGradient(32, 32, 4, 32, 32, 31);
		grad.addColorStop(0, "rgba(0,0,0,.42)"); grad.addColorStop(1, "rgba(0,0,0,0)");
		g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
		const tex = new t.CanvasTexture(c); tex.userData.shared = true;
		shadowMaterial = new t.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }); shadowMaterial.userData.shared = true;
		shadowGeo = new t.PlaneGeometry(1, 1).rotateX(-Math.PI / 2); shadowGeo.userData.shared = true;
	}
	const m = new t.Mesh(shadowGeo!, shadowMaterial); m.scale.set(w, 1, d); m.position.y = 0.012; m.renderOrder = 1;
	return m;
}

/** A mesh of a shared geometry with the shared material. */
export function propMesh(t: T, g: Geo): import("three").Mesh {
	return new t.Mesh(g, propMaterial(t));
}
