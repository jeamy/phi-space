// Models for the 3D map: trees and bushes, the hut and the rain barrel, a site that grows with its progress, a ruin, the
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

/** A building by its plan: the hut, the rain barrel, any other plan a hut in its colour. */
export function buildingGeometry(t: T, plan: string | undefined, w: number, d: number, color: number, variant: number): Geo {
	return plan === "regentonne" ? barrel(t) : hut(t, w, d, color, variant % 3);
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
