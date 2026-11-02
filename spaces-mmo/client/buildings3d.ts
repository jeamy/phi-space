// The rest of the 3D models (props3d.ts has the first ones): the buildings of the later epochs and the things the world
// leaves lying about (a boat, barrels, crates, a stall, a salt basin, a ship's hull on the stocks, rocks, a wall, a tower
// stump, a charcoal kiln). Same style as there: primitives merged into one coloured geometry per kind, shared. A thing
// without a model here keeps the one it had (a hut, the scaffold), so a new plan or scenery piece is drawn from the start.
// Everything here is visual only (docs/architektur.en.md, "3D-Ansicht").
import { BARK, cached, hut, merge, rand, STONE, STONE_DARK, THATCH, WOOD, WOOD_DARK, type Geo, type Part, type T, type V3 } from "./props3d.ts";

const SLATE = 0x5a5f70, BRICK = 0xa5503a, COPPER = 0xb87333, PLASTER = 0xd9cfb5, LAMP = 0xf2c46a, GLOW = 0xff8a2a, IRON = 0x3a3d44, SACK = 0xd8c9a0;

const b = (t: T, w: number, h: number, d: number, c: number, x: number, y: number, z: number, r?: V3): Part => ({ g: new t.BoxGeometry(w, h, d), c, p: [x, y, z], ...(r ? { r } : {}) });
/** A cylinder (or a cone frustum) standing on `y`: `r0` at its foot, `r1` at its top. */
const cy = (t: T, r0: number, r1: number, h: number, c: number, x: number, y: number, z: number, seg = 8, r?: V3): Part => ({ g: new t.CylinderGeometry(r1, r0, h, seg), c, p: [x, y + h / 2, z], ...(r ? { r } : {}) });
const ball = (t: T, r: number, c: number, x: number, y: number, z: number, s?: V3): Part => ({ g: new t.IcosahedronGeometry(r, 0), c, p: [x, y, z], ...(s ? { s } : {}) });
/** The upper half of a sphere, `rx`×`ry`×`rz`, standing on `y`. */
const dome = (t: T, rx: number, ry: number, rz: number, c: number, x: number, y: number, z: number, seg = 9): Part => ({ g: new t.SphereGeometry(1, seg, Math.ceil(seg / 2), 0, Math.PI * 2, 0, Math.PI / 2), c, p: [x, y, z], s: [rx, ry, rz] });

/** A gable roof over walls `ww`×`dd` whose top is at `y`: the two gables, the two slabs, the ridge along x. */
function gable(t: T, parts: Part[], ww: number, dd: number, y: number, rise: number, wall: number, roof: number, over = 0.08): void {
	const tri = new t.Shape(); tri.moveTo(-dd / 2, 0); tri.lineTo(dd / 2, 0); tri.lineTo(0, rise); tri.closePath();
	parts.push({ g: new t.ExtrudeGeometry(tri, { depth: ww, bevelEnabled: false }), c: wall, p: [-ww / 2, y, 0], r: [0, Math.PI / 2, 0] });
	const slope = Math.atan2(rise, dd / 2), len = Math.hypot(rise, dd / 2) + 0.14;
	for (const side of [-1, 1]) parts.push(b(t, ww + 2 * over, 0.06, len, roof, 0, y + rise / 2 + 0.04, side * (dd / 4 + 0.04), [side * slope, 0, 0]));
	parts.push(b(t, ww + 2 * over, 0.07, 0.1, WOOD_DARK, 0, y + rise + 0.05, 0));
}
/** A plain house: a plinth, walls with corner posts, a gable roof. The door and the rest are the caller's. */
function house(t: T, parts: Part[], w: number, d: number, o: { wall: number; roof: number; wh: number; rise: number; wide?: number }): { ww: number; dd: number; top: number } {
	const ww = w * (o.wide ?? 0.86), dd = d * 0.78, top = 0.1 + o.wh;
	parts.push(b(t, w * 0.94, 0.1, d * 0.9, STONE, 0, 0.05, 0), b(t, ww, o.wh, dd, o.wall, 0, 0.1 + o.wh / 2, 0));
	for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) parts.push(b(t, 0.1, o.wh + 0.04, 0.1, WOOD_DARK, (sx * ww) / 2, 0.1 + o.wh / 2 + 0.02, (sz * dd) / 2));
	gable(t, parts, ww, dd, top, o.rise, o.wall, o.roof);
	return { ww, dd, top };
}
const door = (t: T, parts: Part[], x: number, z: number, wide = 0.3, high = 0.48): void => { parts.push(b(t, wide, high, 0.04, 0x3a2a18, x, 0.1 + high / 2, z + 0.015)); };
const lit = (t: T, parts: Part[], x: number, y: number, z: number): void => { parts.push(b(t, 0.26, 0.22, 0.04, WOOD_DARK, x, y, z + 0.015), b(t, 0.18, 0.14, 0.05, LAMP, x, y, z + 0.02)); };
const chimney = (t: T, parts: Part[], x: number, y: number, z: number, h: number, c = STONE_DARK): void => { parts.push(b(t, 0.16, h, 0.16, c, x, y + h / 2, z), b(t, 0.21, 0.04, 0.21, STONE, x, y + h + 0.02, z)); };
/** An upright barrel: staves bulging in the middle, two hoops, a lid. */
const barrelAt = (t: T, parts: Part[], x: number, y: number, z: number): void => {
	parts.push(cy(t, 0.17, 0.2, 0.2, WOOD, x, y, z, 8), cy(t, 0.2, 0.17, 0.2, WOOD, x, y + 0.2, z, 8), cy(t, 0.185, 0.185, 0.03, WOOD_DARK, x, y + 0.06, z, 8), cy(t, 0.185, 0.185, 0.03, WOOD_DARK, x, y + 0.31, z, 8), cy(t, 0.165, 0.165, 0.015, 0xa88a5c, x, y + 0.4, z, 8));
};
const crateAt = (t: T, parts: Part[], x: number, y: number, z: number, s: number, turn = 0): void => {
	parts.push({ g: new t.BoxGeometry(s, s, s), c: WOOD, p: [x, y + s / 2, z], r: [0, turn, 0] }, { g: new t.BoxGeometry(s * 1.04, s * 0.14, s * 1.04), c: 0xa88a5c, p: [x, y + s * 0.93, z], r: [0, turn, 0] }, { g: new t.BoxGeometry(s * 1.04, s * 0.14, s * 1.04), c: WOOD_DARK, p: [x, y + s * 0.07, z], r: [0, turn, 0] });
};
const sackAt = (t: T, parts: Part[], x: number, y: number, z: number): void => { parts.push(ball(t, 0.1, SACK, x, y + 0.11, z, [1, 1.2, 0.9])); };
/** The bare hull of a ship on a keel along x: stem and stern posts, ribs leaning out, a few planks at the stern. */
function hullFrame(t: T, parts: Part[], len: number, wide: number, y: number, high: number): void {
	parts.push(b(t, len, 0.08, 0.09, WOOD_DARK, 0, y + 0.05, 0), b(t, 0.08, high * 0.95, 0.08, WOOD_DARK, len / 2, y + high * 0.5, 0, [0, 0, -0.35]), b(t, 0.08, high * 0.8, 0.08, WOOD_DARK, -len / 2, y + high * 0.42, 0, [0, 0, 0.18]));
	const n = Math.max(3, Math.round(len * 2.4));
	for (let i = 0; i < n; i++) {
		const f = (i + 0.5) / n - 0.5, spread = 1 - Math.pow(f * 2, 2) * 0.8, bottom = wide * spread * 0.1, top = wide * spread * 0.5;
		for (const side of [-1, 1]) parts.push(b(t, 0.05, Math.hypot(high, top - bottom), 0.05, WOOD, f * len, y + 0.05 + high / 2, (side * (bottom + top)) / 2, [side * Math.atan2(top - bottom, high), 0, 0]));
		parts.push(b(t, 0.05, 0.05, top * 2, WOOD, f * len, y + 0.07 + high * 0.55, 0));
	}
	for (let k = 0; k < 3; k++) for (const side of [-1, 1]) parts.push(b(t, len * 0.4, 0.045, 0.03, 0xb08a58, -len * 0.26, y + 0.12 + k * 0.1, (side * wide * (0.2 + k * 0.07)) / 1, [side * 0.3, 0, 0]));
}

// ---- buildings ----

/** The storehouse: a broad barn with a double door, sacks and a crate by it. */
function storehouse(t: T, w: number, d: number, variant: number): Geo {
	return cached(`lagerhaus:${w}x${d}:${variant}`, () => {
		const parts: Part[] = [], { ww, dd } = house(t, parts, w, d, { wall: 0x9a7a4a, roof: THATCH[variant % 3]!, wh: 0.62, rise: 0.38 }), front = dd / 2 + 0.02;
		parts.push(b(t, 0.7, 0.52, 0.04, WOOD_DARK, 0, 0.36, front));
		for (const a of [0.85, -0.85]) parts.push(b(t, 0.56, 0.04, 0.045, WOOD, 0, 0.36, front + 0.02, [0, 0, a]));
		for (let i = 0; i < 3; i++) sackAt(t, parts, ww / 2 + 0.16 + (i % 2) * 0.05, i > 1 ? 0.2 : 0, dd * 0.25 + (i % 2) * 0.2);
		crateAt(t, parts, -ww / 2 - 0.2, 0, dd * 0.3, 0.3); crateAt(t, parts, -ww / 2 - 0.2, 0.3, dd * 0.3, 0.22, 0.4);
		return merge(t, parts, "lagerhaus");
	});
}
/** The quarry: a worked floor, three terraces of the face, cut blocks, a crane, a pickaxe in a block. */
function quarry(t: T, w: number, d: number): Geo {
	return cached(`steinbruch:${w}x${d}`, () => {
		const r = rand("quarry"), parts: Part[] = [cy(t, w * 0.48, w * 0.46, 0.06, 0x9a9384, 0, 0, 0, 10)];
		for (let i = 0; i < 3; i++) { const hh = 0.2 + i * 0.2; parts.push(b(t, w * 0.8 - i * 0.16, hh, d * 0.17, i % 2 ? STONE : STONE_DARK, 0, 0.06 + hh / 2, -d * 0.14 - i * d * 0.13)); }
		for (let i = 0; i < 4; i++) parts.push(b(t, 0.2 + r() * 0.12, 0.16 + r() * 0.1, 0.2 + r() * 0.1, i % 2 ? 0xa39e90 : STONE, -w * 0.3 + i * w * 0.2, 0.14 + (i % 2) * 0.05, d * 0.22 + r() * 0.1, [0, r() * 0.6, 0]));
		parts.push(b(t, 0.06, 0.95, 0.06, WOOD_DARK, w * 0.3, 0.5, d * 0.05, [0, 0, -0.08]), b(t, 0.6, 0.06, 0.06, WOOD_DARK, w * 0.3 - 0.28, 0.95, d * 0.05), b(t, 0.015, 0.4, 0.015, 0xcdb98d, w * 0.3 - 0.5, 0.75, d * 0.05), b(t, 0.14, 0.12, 0.14, STONE, w * 0.3 - 0.5, 0.5, d * 0.05));
		parts.push(b(t, 0.04, 0.4, 0.04, WOOD, -w * 0.05, 0.4, d * 0.1, [0, 0, 0.5]), b(t, 0.22, 0.05, 0.05, IRON, -w * 0.05 - 0.07, 0.6, d * 0.1, [0, 0, 0.5]));
		return merge(t, parts, "steinbruch");
	});
}
/** The clay pit: a ring of clay mounds round a darker hollow, a spade, a bucket. */
function clayPit(t: T, w: number, d: number): Geo {
	return cached(`lehmgrube:${w}x${d}`, () => {
		const r = rand("clay"), parts: Part[] = [cy(t, w * 0.47, w * 0.45, 0.05, 0xb98350, 0, 0, 0, 12), cy(t, w * 0.3, w * 0.3, 0.03, 0x8b5a34, 0, 0.05, 0, 12)];
		for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; parts.push(ball(t, 0.15 + r() * 0.05, i % 2 ? 0xb98350 : 0xa8723f, Math.cos(a) * w * 0.37, 0.07, Math.sin(a) * d * 0.37, [1.2, 0.6, 1.2])); }
		for (let i = 0; i < 3; i++) parts.push(ball(t, 0.07, 0x9c6a3e, (i - 1) * 0.2, 0.1, (r() - 0.5) * 0.3));
		parts.push(b(t, 0.04, 0.55, 0.04, WOOD, w * 0.18, 0.32, d * 0.3, [0, 0, 0.25]), b(t, 0.13, 0.15, 0.02, 0x9aa0a6, w * 0.18 + 0.15, 0.1, d * 0.3, [0, 0, 0.25]), cy(t, 0.11, 0.13, 0.17, WOOD, -w * 0.25, 0.04, d * 0.32), cy(t, 0.1, 0.1, 0.02, 0x8b5a34, -w * 0.25, 0.2, d * 0.32));
		return merge(t, parts, "lehmgrube");
	});
}
/** The brickworks: a brick kiln with a fire in its mouth and a tall chimney, bricks stacked beside it. */
function brickworks(t: T, w: number, d: number): Geo {
	return cached(`ziegelei:${w}x${d}`, () => {
		const parts: Part[] = [b(t, w * 0.9, 0.06, d * 0.9, 0x9a8160, 0, 0.03, 0), b(t, w * 0.5, 0.7, d * 0.5, BRICK, -w * 0.12, 0.41, -d * 0.1), b(t, w * 0.56, 0.08, d * 0.56, 0x7a3a2a, -w * 0.12, 0.8, -d * 0.1)];
		parts.push(cy(t, 0.14, 0.1, 0.8, STONE_DARK, -w * 0.12, 0.84, -d * 0.1), b(t, 0.3, 0.3, 0.04, 0x1a1210, -w * 0.12, 0.2, d * 0.15 + 0.02), b(t, 0.2, 0.14, 0.05, GLOW, -w * 0.12, 0.17, d * 0.15 + 0.03));
		for (let k = 0; k < 3; k++) for (let i = 0; i < 3 - k; i++) for (const z of [0, 0.11]) parts.push(b(t, 0.2, 0.07, 0.1, k % 2 ? 0xb85a3e : BRICK, w * 0.3 + i * 0.21 + k * 0.1, 0.1 + k * 0.075, d * 0.15 + z));
		return merge(t, parts, "ziegelei");
	});
}
/** The chapel: a plastered nave under slate, a bell tower with a spire and a cross, an arched door, blue windows. */
function chapel(t: T, w: number, d: number): Geo {
	return cached(`kapelle:${w}x${d}`, () => {
		const dd = d * 0.78, nw = w * 0.6, cx = -w * 0.12, tw = Math.min(0.62, w * 0.2), tx = cx + nw / 2 + tw / 2 - 0.04, parts: Part[] = [b(t, w * 0.94, 0.1, d * 0.9, STONE, 0, 0.05, 0), b(t, nw, 0.62, dd, PLASTER, cx, 0.41, 0)];
		gable(t, parts, nw, dd, 0.72, 0.42, PLASTER, SLATE);
		parts.push(b(t, tw, 1.5, tw, PLASTER, tx, 0.85, 0), b(t, tw + 0.08, 0.06, tw + 0.08, STONE, tx, 1.62, 0), b(t, 0.2, 0.3, tw + 0.02, IRON, tx, 1.3, 0));
		parts.push({ g: new t.ConeGeometry(tw * 0.78, 0.8, 4), c: SLATE, p: [tx, 2.05, 0], r: [0, Math.PI / 4, 0] }, b(t, 0.04, 0.26, 0.04, 0xd8b84a, tx, 2.58, 0), b(t, 0.16, 0.04, 0.04, 0xd8b84a, tx, 2.62, 0));
		const front = dd / 2 + 0.02;
		parts.push(b(t, 0.32, 0.46, 0.04, WOOD_DARK, cx, 0.33, front), cy(t, 0.16, 0.16, 0.04, WOOD_DARK, cx, 0.56, front, 8, [Math.PI / 2, 0, 0]));
		for (const s of [-1, 1]) parts.push(b(t, 0.13, 0.28, 0.04, 0x6a8fb8, cx + s * nw * 0.32, 0.5, front));
		return merge(t, parts, "kapelle");
	});
}
/** The park: a lawn with two crossing paths, a fountain, benches, hedges at the corners, a tree at each. */
function park(t: T, w: number, d: number): Geo {
	return cached(`park:${w}x${d}`, () => {
		const r = rand("park"), parts: Part[] = [b(t, w * 0.94, 0.04, d * 0.94, 0x6fa04a, 0, 0.02, 0), b(t, w * 0.94, 0.05, 0.4, 0xd8caa0, 0, 0.03, 0), b(t, 0.4, 0.05, d * 0.94, 0xd8caa0, 0, 0.03, 0)];
		parts.push(cy(t, 0.42, 0.4, 0.16, STONE, 0, 0.05, 0, 10), cy(t, 0.34, 0.34, 0.03, 0x6aa7c8, 0, 0.19, 0, 10), cy(t, 0.07, 0.05, 0.4, STONE_DARK, 0, 0.19, 0, 6), cy(t, 0.16, 0.12, 0.05, STONE, 0, 0.55, 0, 8));
		for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
			const x = sx * w * 0.24, z = sz * d * 0.24, turn = sx ? Math.PI / 2 : 0;
			parts.push({ g: new t.BoxGeometry(0.4, 0.05, 0.14), c: WOOD, p: [x + sz * 0.3, 0.2, z + sx * 0.3], r: [0, turn, 0] }, { g: new t.BoxGeometry(0.4, 0.14, 0.03), c: WOOD, p: [x + sz * 0.3 + sx * 0.07, 0.3, z + sx * 0.3 + sz * 0.07], r: [0, turn, 0] });
		}
		for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
			const x = sx * w * 0.36, z = sz * d * 0.36;
			parts.push(cy(t, 0.05, 0.05, 0.3, BARK, x, 0.04, z, 6), cy(t, 0.3, 0.02, 0.45, 0x4f8f3a, x, 0.28, z, 7), cy(t, 0.24, 0.02, 0.4, 0x5c9c42, x, 0.55, z, 7));
		}
		for (let i = 0; i < 10; i++) parts.push(ball(t, 0.04, [0xd9534f, 0xf0c040, 0xe8e0f0, 0xe58bb0][i % 4]!, (r() - 0.5) * w * 0.8, 0.07, (r() - 0.5) * d * 0.8));
		return merge(t, parts, "park");
	});
}
/** The town hall: a stone hall under a red roof, a porch with columns and steps, a clock tower. */
function townHall(t: T, w: number, d: number): Geo {
	return cached(`rathaus:${w}x${d}`, () => {
		const parts: Part[] = [], { ww, dd, top } = house(t, parts, w, d * 0.9, { wall: 0xcfc6b0, roof: 0x8a3a2c, wh: 0.78, rise: 0.46, wide: 0.9 }), front = dd / 2;
		parts.push(b(t, 0.6, 1.5, 0.6, 0xcfc6b0, 0, 0.85, -dd * 0.1), b(t, 0.68, 0.06, 0.68, STONE, 0, 1.63, -dd * 0.1), { g: new t.ConeGeometry(0.5, 0.65, 4), c: SLATE, p: [0, 2.0, -dd * 0.1], r: [0, Math.PI / 4, 0] });
		parts.push(cy(t, 0.17, 0.17, 0.04, 0xf0ead8, 0, 1.4, -dd * 0.1 + 0.31, 12, [Math.PI / 2, 0, 0]), b(t, 0.02, 0.12, 0.02, IRON, 0, 1.44, -dd * 0.1 + 0.34), b(t, 0.08, 0.02, 0.02, IRON, 0.035, 1.4, -dd * 0.1 + 0.34), b(t, 0.04, 0.24, 0.04, 0xd8b84a, 0, 2.45, -dd * 0.1));
		for (let i = 0; i < 4; i++) parts.push(cy(t, 0.045, 0.045, 0.6, PLASTER, -0.45 + i * 0.3, 0.12, front + 0.2, 8));
		parts.push(b(t, 1.3, 0.06, 0.44, 0x8a3a2c, 0, 0.74, front + 0.2), b(t, 1.2, 0.05, 0.3, STONE, 0, 0.13, front + 0.22), b(t, 1.0, 0.05, 0.4, STONE, 0, 0.1, front + 0.4), b(t, 0.36, 0.5, 0.04, WOOD_DARK, 0, 0.35, front + 0.015));
		for (const s of [-1, 1]) for (const x of [0.62, 0.95]) lit(t, parts, s * Math.min(x, ww / 2 - 0.15), 0.5, front);
		void top;
		return merge(t, parts, "rathaus");
	});
}
/** The workshop: a plank house with a chimney, an anvil on a stump, a grindstone and a stack of boards outside. */
function workshop(t: T, w: number, d: number): Geo {
	return cached(`werkstatt:${w}x${d}`, () => {
		const parts: Part[] = [], { ww, dd, top } = house(t, parts, w, d, { wall: 0x8a6a44, roof: 0x6b4a2e, wh: 0.55, rise: 0.3, wide: 0.66 }), front = dd / 2;
		door(t, parts, -0.2, front); lit(t, parts, 0.25, 0.46, front); chimney(t, parts, ww * 0.28, top, -dd * 0.18, 0.5);
		const ax = ww / 2 + 0.35;
		parts.push(cy(t, 0.13, 0.12, 0.22, BARK, ax, 0.04, 0.2, 7), b(t, 0.28, 0.1, 0.14, IRON, ax, 0.31, 0.2), { g: new t.ConeGeometry(0.05, 0.14, 5), c: IRON, p: [ax + 0.2, 0.31, 0.2], r: [0, 0, -Math.PI / 2] });
		parts.push(cy(t, 0.14, 0.14, 0.06, 0x8f8676, ax, 0.04, -0.3, 10, [0, 0, 0]), b(t, 0.04, 0.32, 0.04, WOOD_DARK, ax - 0.16, 0.2, -0.3), b(t, 0.04, 0.32, 0.04, WOOD_DARK, ax + 0.16, 0.2, -0.3));
		for (let i = 0; i < 4; i++) parts.push(b(t, 0.42, 0.04, 0.12, i % 2 ? WOOD : 0xa88a5c, -ww / 2 - 0.3, 0.04 + i * 0.045, 0.1 + (i % 2) * 0.02));
		return merge(t, parts, "werkstatt");
	});
}
/** The smokehouse: a dark plank house with slits and a tall chimney, a rack with fish drying beside it. */
function smokehouse(t: T, w: number, d: number): Geo {
	return cached(`raeucherei:${w}x${d}`, () => {
		const parts: Part[] = [], { ww, dd, top } = house(t, parts, w, d, { wall: 0x5f4630, roof: 0x3d3128, wh: 0.85, rise: 0.3, wide: 0.6 }), front = dd / 2;
		door(t, parts, 0, front, 0.28, 0.5); chimney(t, parts, ww * 0.25, top, -dd * 0.1, 0.55, 0x4a4540);
		for (let i = 0; i < 3; i++) parts.push(b(t, 0.34, 0.035, 0.03, IRON, 0, 0.72 + i * 0.07, front + 0.01));
		const rx = ww / 2 + 0.3;
		parts.push(b(t, 0.05, 0.62, 0.05, WOOD_DARK, rx, 0.31, 0.25), b(t, 0.05, 0.62, 0.05, WOOD_DARK, rx, 0.31, -0.25), b(t, 0.05, 0.05, 0.6, WOOD, rx, 0.58, 0));
		for (let i = 0; i < 5; i++) parts.push(b(t, 0.03, 0.2, 0.07, 0xb8c4c8, rx, 0.45, -0.2 + i * 0.1), b(t, 0.03, 0.05, 0.1, 0x8a98a0, rx, 0.33, -0.2 + i * 0.1));
		return merge(t, parts, "raeucherei");
	});
}
/** The department store: two floors, a striped awning over big shop windows, a sign on the roof. */
function department(t: T, w: number, d: number): Geo {
	return cached(`kaufhaus:${w}x${d}`, () => {
		const ww = w * 0.9, dd = d * 0.72, parts: Part[] = [b(t, w * 0.96, 0.1, d * 0.9, STONE, 0, 0.05, 0), b(t, ww, 0.62, dd, 0xcdb98d, 0, 0.41, 0), b(t, ww * 0.96, 0.5, dd * 0.96, 0xb89a68, 0, 1.0, 0)];
		gable(t, parts, ww * 0.96, dd * 0.96, 1.25, 0.34, 0xb89a68, 0x7a4a30);
		const front = dd / 2 + 0.02;
		for (let i = 0; i < 8; i++) parts.push(b(t, ww / 8, 0.04, 0.34, i % 2 ? 0xf2e8d0 : 0xc0392b, -ww / 2 + ww / 16 + (i * ww) / 8, 0.62, dd / 2 + 0.17, [0.35, 0, 0]));
		for (const x of [-ww * 0.3, ww * 0.3]) parts.push(b(t, ww * 0.22, 0.3, 0.04, WOOD_DARK, x, 0.36, front), b(t, ww * 0.19, 0.25, 0.05, 0xf2d98a, x, 0.36, front + 0.01));
		parts.push(b(t, 0.34, 0.46, 0.04, 0x3a2a18, 0, 0.33, front));
		for (let i = 0; i < 4; i++) lit(t, parts, -ww * 0.34 + i * ww * 0.226, 1.0, dd * 0.48 + 0.01);
		parts.push(b(t, ww * 0.3, 0.16, 0.05, WOOD_DARK, 0, 1.0 + 0.32, dd * 0.49 + 0.06, [0.0, 0, 0]));
		return merge(t, parts, "kaufhaus");
	});
}
/** The counting house: two storeys of brick under slate, a hoist beam over a loading door, crates and sacks below it. */
function counting(t: T, w: number, d: number): Geo {
	return cached(`kontor:${w}x${d}`, () => {
		const ww = w * 0.8, dd = d * 0.78, parts: Part[] = [b(t, w * 0.94, 0.1, d * 0.9, STONE, 0, 0.05, 0), b(t, ww, 0.6, dd, BRICK, 0, 0.4, 0), b(t, ww, 0.5, dd, 0xb35a42, 0, 0.95, 0)];
		gable(t, parts, ww, dd, 1.2, 0.4, 0xb35a42, SLATE);
		const front = dd / 2;
		door(t, parts, -ww * 0.25, front, 0.3, 0.46); lit(t, parts, ww * 0.25, 0.42, front); lit(t, parts, -ww * 0.25, 0.95, front);
		parts.push(b(t, 0.3, 0.34, 0.04, WOOD_DARK, ww * 0.25, 0.95, front + 0.015), b(t, 0.07, 0.07, 0.55, WOOD_DARK, ww * 0.25, 1.25, front + 0.25), b(t, 0.015, 0.4, 0.015, 0xcdb98d, ww * 0.25, 1.05, front + 0.5), b(t, 0.16, 0.14, 0.16, WOOD, ww * 0.25, 0.8, front + 0.5));
		crateAt(t, parts, ww * 0.1, 0, front + 0.28, 0.26); crateAt(t, parts, ww * 0.1 + 0.3, 0, front + 0.28, 0.3, 0.3); sackAt(t, parts, -ww / 2 - 0.2, 0, 0.1); sackAt(t, parts, -ww / 2 - 0.2, 0, 0.32);
		return merge(t, parts, "kontor");
	});
}
/** The brewery: a stone house with a tall chimney, a copper kettle on a stand and barrels stacked beside it. */
function brewery(t: T, w: number, d: number): Geo {
	return cached(`brauerei:${w}x${d}`, () => {
		const parts: Part[] = [], { ww, dd, top } = house(t, parts, w, d, { wall: 0xb5a88a, roof: 0x7a4a30, wh: 0.6, rise: 0.34, wide: 0.66 }), front = dd / 2;
		door(t, parts, -0.15, front); lit(t, parts, 0.25, 0.45, front); chimney(t, parts, ww * 0.3, top, -dd * 0.15, 0.6);
		const kx = ww / 2 + 0.34;
		parts.push(cy(t, 0.2, 0.2, 0.14, STONE_DARK, kx, 0.04, 0.1, 8), cy(t, 0.22, 0.24, 0.3, COPPER, kx, 0.18, 0.1, 10), dome(t, 0.24, 0.2, 0.24, COPPER, kx, 0.48, 0.1, 10), b(t, 0.04, 0.3, 0.04, COPPER, kx - 0.1, 0.76, 0.1), b(t, 0.04, 0.04, 0.22, COPPER, kx - 0.1, 0.9, 0.0));
		barrelAt(t, parts, -ww / 2 - 0.25, 0.04, 0.2); barrelAt(t, parts, -ww / 2 - 0.25, 0.04, -0.2); barrelAt(t, parts, -ww / 2 - 0.25, 0.46, 0);
		return merge(t, parts, "brauerei");
	});
}
/** The glassworks: a stone house with a domed kiln behind it and a tall chimney, bottles on a bench. */
function glassworks(t: T, w: number, d: number): Geo {
	return cached(`glashuette:${w}x${d}`, () => {
		const parts: Part[] = [], { ww, dd, top } = house(t, parts, w, d, { wall: 0x8d949c, roof: 0x4f5560, wh: 0.55, rise: 0.3, wide: 0.66 }), front = dd / 2;
		door(t, parts, -0.2, front); lit(t, parts, 0.22, 0.44, front);
		const kx = ww * 0.15;
		parts.push(dome(t, 0.45, 0.5, 0.4, STONE_DARK, kx, 0.1, -dd / 2 - 0.1, 10), b(t, 0.2, 0.2, 0.04, 0x1a1210, kx, 0.28, -dd / 2 + 0.3), b(t, 0.14, 0.11, 0.05, GLOW, kx, 0.26, -dd / 2 + 0.31));
		chimney(t, parts, kx, 0.6, -dd / 2 - 0.1, 0.5);
		const bx = ww / 2 + 0.3;
		parts.push(b(t, 0.34, 0.04, 0.2, WOOD, bx, 0.3, 0.15), b(t, 0.05, 0.3, 0.05, WOOD_DARK, bx - 0.14, 0.15, 0.15), b(t, 0.05, 0.3, 0.05, WOOD_DARK, bx + 0.14, 0.15, 0.15));
		for (let i = 0; i < 3; i++) parts.push(cy(t, 0.05, 0.03, 0.14, 0x9fd8c8, bx - 0.1 + i * 0.1, 0.32, 0.15, 6));
		parts.push(ball(t, 0.09, 0xbfe6dc, bx, 0.5, 0.15));
		return merge(t, parts, "glashuette");
	});
}
/** The shipyard: a platform with a ship's hull on blocks, a crane at one end, planks stacked at the back. */
function shipyard(t: T, w: number, d: number): Geo {
	return cached(`werft:${w}x${d}`, () => {
		const parts: Part[] = [b(t, w * 0.92, 0.08, d * 0.86, 0x9a8160, 0, 0.04, 0)];
		for (const x of [-0.5, 0, 0.5]) parts.push(b(t, 0.12, 0.16, d * 0.3, WOOD_DARK, x * w * 0.5, 0.16, 0));
		hullFrame(t, parts, w * 0.72, d * 0.5, 0.2, 0.55);
		const cx = w * 0.4;
		for (const s of [-1, 1]) parts.push(b(t, 0.06, 1.05, 0.06, WOOD_DARK, cx, 0.6, s * 0.28, [-s * 0.25, 0, 0]));
		parts.push(b(t, 0.08, 0.06, 0.5, WOOD, cx, 1.1, 0), b(t, 0.015, 0.4, 0.015, 0xcdb98d, cx, 0.9, 0.05), b(t, 0.14, 0.12, 0.14, IRON, cx, 0.65, 0.05));
		for (let i = 0; i < 5; i++) parts.push(b(t, w * 0.3, 0.05, 0.14, i % 2 ? WOOD : 0xa88a5c, -w * 0.3, 0.1 + i * 0.05, -d * 0.36));
		return merge(t, parts, "werft");
	});
}
/** The greenhouse: a frame of dark timber with a roof of glass strips (gaps between them), plants and pots inside. */
function greenhouse(t: T, w: number, d: number): Geo {
	return cached(`gewaechshaus:${w}x${d}`, () => {
		const r = rand("greenhouse"), ww = w * 0.88, dd = d * 0.78, wh = 0.5, rise = 0.32, glass = 0xcfe8e4, parts: Part[] = [b(t, w * 0.94, 0.08, d * 0.9, STONE, 0, 0.04, 0)];
		for (const sz of [-1, 1]) {
			parts.push(b(t, ww, 0.05, 0.05, WOOD_DARK, 0, 0.1, (sz * dd) / 2), b(t, ww, 0.05, 0.05, WOOD_DARK, 0, 0.1 + wh, (sz * dd) / 2));
			for (let i = 0; i <= 4; i++) parts.push(b(t, 0.05, wh, 0.05, WOOD_DARK, -ww / 2 + (i * ww) / 4, 0.1 + wh / 2, (sz * dd) / 2));
		}
		for (const sx of [-1, 1]) parts.push(b(t, 0.05, 0.05, dd, WOOD_DARK, (sx * ww) / 2, 0.1, 0), b(t, 0.05, 0.05, dd, WOOD_DARK, (sx * ww) / 2, 0.1 + wh, 0), b(t, 0.04, wh * 0.45, dd * 0.9, glass, (sx * ww) / 2, 0.1 + wh * 0.25, 0));
		const slope = Math.atan2(rise, dd / 2), len = Math.hypot(rise, dd / 2);
		for (const side of [-1, 1]) {
			parts.push(b(t, ww + 0.1, 0.05, 0.05, WOOD_DARK, 0, 0.1 + wh + rise + 0.02, 0));
			for (let i = 0; i < 5; i++) parts.push(b(t, ww / 6, 0.025, len * 0.9, glass, -ww / 2 + ww / 10 + (i * ww) / 5 + ww / 20, 0.1 + wh + rise / 2 + 0.03, side * (dd / 4), [side * slope, 0, 0]));
			for (let i = 0; i <= 4; i++) parts.push(b(t, 0.035, 0.035, len, WOOD_DARK, -ww / 2 + (i * ww) / 4, 0.1 + wh + rise / 2 + 0.02, side * (dd / 4), [side * slope, 0, 0]));
		}
		for (let i = 0; i < 7; i++) { const x = -ww * 0.4 + (i % 4) * ww * 0.27, z = i < 4 ? -dd * 0.22 : dd * 0.22; parts.push(cy(t, 0.07, 0.06, 0.1, 0xb4673a, x, 0.08, z, 6), ball(t, 0.09 + r() * 0.04, [0x5c9c42, 0x4f8f3a, 0x6aaa4a][i % 3]!, x, 0.28, z), ball(t, 0.035, [0xd9534f, 0xf0c040][i % 2]!, x + 0.05, 0.36, z)); }
		parts.push(b(t, 0.34, 0.5, 0.04, WOOD_DARK, 0, 0.35, dd / 2 + 0.01));
		return merge(t, parts, "gewaechshaus");
	});
}
/** The lighthouse: a tapering tower in red and white bands, a gallery with a rail, a lit lantern under a cap. */
function lighthouse(t: T, w: number): Geo {
	return cached(`leuchtturm:${w}`, () => {
		const parts: Part[] = [cy(t, w * 0.42, w * 0.38, 0.1, STONE, 0, 0, 0, 10)];
		for (let i = 0; i < 5; i++) parts.push(cy(t, 0.34 - i * 0.03, 0.31 - i * 0.03, 0.3, i % 2 ? 0xf0ead8 : 0xc0392b, 0, 0.1 + i * 0.3, 0, 10));
		parts.push(cy(t, 0.28, 0.28, 0.05, IRON, 0, 1.6, 0, 10), cy(t, 0.14, 0.14, 0.26, LAMP, 0, 1.65, 0, 8), cy(t, 0.2, 0.01, 0.2, SLATE, 0, 1.91, 0, 8));
		for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; parts.push(b(t, 0.02, 0.1, 0.02, IRON, Math.cos(a) * 0.26, 1.7, Math.sin(a) * 0.26)); }
		parts.push(b(t, 0.2, 0.34, 0.04, WOOD_DARK, 0, 0.27, 0.3));
		return merge(t, parts, "leuchtturm");
	});
}

/** The model of a building by its plan, null for one without its own (it stays a hut). */
export function buildingModel(t: T, plan: string | undefined, w: number, d: number, variant: number): Geo | null {
	switch (plan) {
		case "lagerhaus": return storehouse(t, w, d, variant % 3);
		case "steinbruch": return quarry(t, w, d);
		case "lehmgrube": return clayPit(t, w, d);
		case "ziegelei": return brickworks(t, w, d);
		case "kapelle": return chapel(t, w, d);
		case "park": return park(t, w, d);
		case "rathaus": return townHall(t, w, d);
		case "werkstatt": return workshop(t, w, d);
		case "raeucherei": return smokehouse(t, w, d);
		case "kaufhaus": return department(t, w, d);
		case "kontor": return counting(t, w, d);
		case "brauerei": return brewery(t, w, d);
		case "glashuette": return glassworks(t, w, d);
		case "werft": return shipyard(t, w, d);
		case "gewaechshaus": return greenhouse(t, w, d);
		case "leuchtturm": return lighthouse(t, w);
		case "bahnhof": return station(t, w, d);
		default: return null;
	}
}

/** The railway station w×d: a brick house in the back half with a pitched slate roof, a stone platform before it under
 *  a canopy on posts, a clock over the door, and a short track of two rails on sleepers along the front (+z). */
function station(t: T, w: number, d: number): Geo {
	return cached(`station:${w}x${d}`, () => {
		const RAIL = 0x9aa0a8, hw = w * 0.8, hd = d * 0.38, hz = -d * 0.22, wh = 0.8, top = 0.12 + wh;
		const parts: Part[] = [
			{ g: new t.BoxGeometry(w * 0.94, 0.12, d * 0.9), c: STONE, p: [0, 0.06, 0] },
			{ g: new t.BoxGeometry(hw, wh, hd), c: BRICK, p: [0, 0.12 + wh / 2, hz] },
			{ g: new t.BoxGeometry(hw + 0.04, 0.05, hd + 0.04), c: STONE_DARK, p: [0, 0.12 + wh * 0.62, hz] },
			{ g: new t.BoxGeometry(0.34, 0.52, 0.04), c: 0x3a2a18, p: [0, 0.12 + 0.26, hz + hd / 2 + 0.015] },
			...[-1, 1].map((sx) => ({ g: new t.BoxGeometry(0.26, 0.24, 0.04), c: 0xf2c46a, p: [sx * hw * 0.3, 0.12 + 0.46, hz + hd / 2 + 0.015] as V3 })),
			// the clock over the door
			{ g: new t.CylinderGeometry(0.11, 0.11, 0.04, 12), c: 0xf4f0e2, p: [0, top - 0.12, hz + hd / 2 + 0.03], r: [Math.PI / 2, 0, 0] },
			{ g: new t.BoxGeometry(0.015, 0.08, 0.01), c: 0x222222, p: [0, top - 0.09, hz + hd / 2 + 0.055] },
			// the platform and its canopy
			{ g: new t.BoxGeometry(w * 0.92, 0.1, d * 0.22), c: STONE_DARK, p: [0, 0.17, d * 0.08] },
			{ g: new t.BoxGeometry(w * 0.9, 0.05, d * 0.3), c: SLATE, p: [0, top - 0.05, d * 0.04], r: [-0.12, 0, 0] },
			...[-1, 0, 1].map((i) => ({ g: new t.BoxGeometry(0.06, top - 0.2, 0.06), c: WOOD_DARK, p: [i * w * 0.38, 0.22 + (top - 0.2) / 2 - 0.05, d * 0.16] as V3 })),
			// the track: two rails on sleepers
			...[-1, 1].map((sz) => ({ g: new t.BoxGeometry(w * 0.96, 0.04, 0.04), c: RAIL, p: [0, 0.18, d * 0.34 + sz * 0.1] as V3 })),
		];
		// the roof: two slate planes over the house, the ridge along x
		const rise = 0.42, slope = Math.atan2(rise, hd / 2), len = Math.hypot(rise, hd / 2) + 0.12;
		const tri = new t.Shape(); tri.moveTo(-hd / 2, 0); tri.lineTo(hd / 2, 0); tri.lineTo(0, rise); tri.closePath();
		parts.push({ g: new t.ExtrudeGeometry(tri, { depth: hw, bevelEnabled: false }), c: BRICK, p: [-hw / 2, top, hz], r: [0, Math.PI / 2, 0] });
		for (const side of [-1, 1]) parts.push({ g: new t.BoxGeometry(hw + 0.14, 0.06, len), c: SLATE, p: [0, top + rise / 2 + 0.03, hz + side * (hd / 4 + 0.03)], r: [side * slope, 0, 0] });
		for (let i = 0; i < Math.round(w * 4); i++) parts.push({ g: new t.BoxGeometry(0.08, 0.03, 0.34), c: WOOD_DARK, p: [-w * 0.45 + (i + 0.5) * (w * 0.9) / Math.round(w * 4), 0.135, d * 0.34] });
		return merge(t, parts, "station");
	});
}

/** The large ship of the timetable, `len` cells long along x (engine/liner.ts): a coastal steamer that still carries sail.
 *  The hull is lofted from one plan (shipHull): a sharp bow (+x) that rises a little, a round cruiser stern, red below the
 *  waterline, dark above, a white sheer strake; the deck lies inside the bulwark. On it a white deckhouse with lit windows
 *  and the bridge, a raked black funnel with a red band, two masts with furled sails, lifeboats, a flag astern. Its
 *  waterline at 0. */
export function linerGeometry(t: T, len: number): Geo {
	return cached(`liner:${len}`, () => {
		const RED = 0x8e2a22, HULL = 0x23272e, WHITE = 0xece6d6, DECK = 0xa88456, LINEN = 0xe8e0cc, BEAM = 0.5, L = len * 0.96;
		const hull = shipHull(L, BEAM, 0.42), mid = hull.deck(0.45), parts: Part[] = [
			...hull.bands(t, [[-0.26, -0.01, RED], [-0.01, 0.3, HULL], [0.3, 0.42, WHITE]], DECK),
			// the deckhouse with two rows of windows, the bridge with its wings on top
			b(t, L * 0.3, 0.28, BEAM * 1.2, WHITE, -L * 0.04, mid + 0.14, 0),
			b(t, L * 0.31, 0.03, BEAM * 1.28, DECK, -L * 0.04, mid + 0.295, 0),
			b(t, L * 0.11, 0.2, BEAM * 1.0, WHITE, L * 0.06, mid + 0.41, 0),
			b(t, L * 0.03, 0.03, BEAM * 1.7, WHITE, L * 0.1, mid + 0.42, 0),
			b(t, L * 0.012, 0.08, BEAM * 0.9, 0x3a4a5a, L * 0.115, mid + 0.45, 0),
			...[-3, -2, -1, 0, 1, 2, 3].flatMap((i) => [-1, 1].map((sz) => b(t, 0.07, 0.07, 0.02, LAMP, -L * 0.04 + i * L * 0.038, mid + 0.15, sz * BEAM * 0.6))),
			// the funnel, raked aft, with its red band and black top
			cy(t, 0.11, 0.1, 0.62, 0x1c1d21, -L * 0.07, mid + 0.25, 0, 12, [0, 0, 0.12]),
			// the band sits on the leaning funnel: its middle 0.17 above the funnel's, so sin(0.12) × 0.17 further aft
			cy(t, 0.125, 0.12, 0.1, RED, -L * 0.07 - Math.sin(0.12) * 0.17, mid + 0.68, 0, 12, [0, 0, 0.12]),
			// ventilators beside the funnel
			...[-1, 1].map((sz) => cy(t, 0.03, 0.04, 0.16, WHITE, -L * 0.16, mid + 0.29, sz * BEAM * 0.35, 6)),
			// the masts, their yards and the furled sails; a boom over the hatch forward
			...[L * 0.3, -L * 0.33].flatMap((x, i) => {
				const y = hull.deck(0.5 + x / L), top = i ? 1.35 : 1.55;
				return [
					cy(t, 0.032, 0.02, top, WOOD_DARK, x, y, 0, 6),
					b(t, 0.035, 0.035, BEAM * 1.5, WOOD_DARK, x, y + top * 0.78, 0),
					{ g: new t.CylinderGeometry(0.045, 0.045, BEAM * 1.35, 6), c: LINEN, p: [x + 0.03, y + top * 0.78 - 0.05, 0] as V3, r: [Math.PI / 2, 0, 0] as V3 },
					{ g: new t.CylinderGeometry(0.02, 0.02, L * 0.16, 5), c: WOOD_DARK, p: [x - L * 0.08, y + 0.25, 0] as V3, r: [0, 0, Math.PI / 2 - 0.08] as V3 },
				];
			}),
			// a cargo hatch forward and aft
			b(t, L * 0.08, 0.06, BEAM * 0.8, WOOD_DARK, L * 0.22, hull.deck(0.72) + 0.03, 0),
			b(t, L * 0.07, 0.06, BEAM * 0.8, WOOD_DARK, -L * 0.25, hull.deck(0.25) + 0.03, 0),
			// two lifeboats on the deckhouse roof, the flag astern on its staff
			...[-1, 1].map((sz): Part => ({ g: new t.SphereGeometry(1, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), c: WHITE, p: [-L * 0.13, mid + 0.4, sz * BEAM * 0.5], r: [Math.PI, 0, 0], s: [L * 0.06, 0.06, 0.07] })),
			cy(t, 0.012, 0.012, 0.45, WOOD_DARK, -L * 0.47, hull.deck(0.03), 0, 5),
			b(t, 0.2, 0.12, 0.01, RED, -L * 0.47 - 0.1, hull.deck(0.03) + 0.38, 0),
		];
		return merge(t, parts, "liner");
	});
}

/** A ship's hull lofted from its plan, `L` long along x (bow +x), `beam` half wide, the deck amidships at `deckY`. `deck(u)`
 *  is the deck's height at u (0 stern, 1 bow); `bands` gives one part per [from, to, colour] height band of the sides (the
 *  last one reaches up to the rail: its height is measured amidships and follows the sheer) and the deck in its colour, set
 *  below the rail with the bulwark's inner side. Closed at both ends, so nothing shows through. */
function shipHull(L: number, beam: number, deckY: number) {
	const N = 28;
	// half the width in plan: a round stern, the straight middle, the bow narrowing to a point
	const plan = (u: number) => u < 0.16 ? Math.sqrt(1 - ((0.16 - u) / 0.16) ** 2) : u < 0.58 ? 1 : Math.cos(((u - 0.58) / 0.42) * Math.PI / 2) ** 0.75;
	// the sheer: the bow rises, the stern a little
	const sheer = (u: number) => 0.14 * Math.max(0, (u - 0.55) / 0.45) ** 2 + 0.04 * Math.max(0, (0.25 - u) / 0.25) ** 2;
	// the sides draw in below the waterline (the bilge)
	const draw = (y: number) => y >= 0 ? 1 : 1 - 0.38 * (y / -0.26) ** 1.6;
	const deck = (u: number) => deckY + sheer(u);
	const xOf = (u: number) => (u - 0.5) * L;
	// a band's height at u: the top band follows the sheer, the lower ones stay level
	const yAt = (y: number, u: number) => y > deckY - 0.13 ? y + sheer(u) : y;
	const half = (u: number, y: number) => beam * plan(u) * draw(y);
	const quad = (out: number[], a: V3, b2: V3, c: V3, d: V3) => out.push(...a, ...b2, ...c, ...a, ...c, ...d);
	const geo = (t: T, pos: number[]) => { const g = new t.BufferGeometry(); g.setAttribute("position", new t.Float32BufferAttribute(pos, 3)); return g; };
	function bands(t: T, list: Array<[number, number, number]>, deckColor: number): Part[] {
		const parts: Part[] = [];
		const bottom = list[0]![0];
		list.forEach(([y0, y1, c], k) => {
			const pos: number[] = [], rows = y0 < 0 ? 3 : 1;
			for (let i = 0; i < N; i++) {
				const u0 = i / N, u1 = (i + 1) / N;
				for (let r = 0; r < rows; r++) {
					const ya = y0 + ((y1 - y0) * r) / rows, yb = y0 + ((y1 - y0) * (r + 1)) / rows;
					const p = (u: number, y: number, s: number): V3 => [xOf(u), yAt(y, u), s * half(u, y)];
					// starboard (+z) faces out along +z, port mirrored with the winding turned
					quad(pos, p(u0, ya, 1), p(u1, ya, 1), p(u1, yb, 1), p(u0, yb, 1));
					quad(pos, p(u1, ya, -1), p(u0, ya, -1), p(u0, yb, -1), p(u1, yb, -1));
				}
			}
			if (k === 0) for (let i = 0; i < N; i++) {
				// the flat of the bottom
				const u0 = i / N, u1 = (i + 1) / N, p = (u: number, s: number): V3 => [xOf(u), bottom, s * half(u, bottom)];
				quad(pos, p(u0, -1), p(u1, -1), p(u1, 1), p(u0, 1));
			}
			parts.push({ g: geo(t, pos), c });
		});
		// the deck, 0.07 below the rail, and the bulwark's inner side from it up to the rail
		const top = list.at(-1)![1], pos: number[] = [], wall: number[] = [];
		for (let i = 0; i < N; i++) {
			const u0 = i / N, u1 = (i + 1) / N, inset = 0.035;
			const d = (u: number, s: number): V3 => [xOf(u), deck(u) - 0.07, s * Math.max(0, half(u, 0) - inset)];
			const r = (u: number, s: number): V3 => [xOf(u), yAt(top, u), s * Math.max(0, half(u, 0) - inset)];
			quad(pos, d(u0, 1), d(u1, 1), d(u1, -1), d(u0, -1));
			quad(wall, d(u1, 1), d(u0, 1), r(u0, 1), r(u1, 1));
			quad(wall, d(u0, -1), d(u1, -1), r(u1, -1), r(u0, -1));
			// the rail's cap between the outer and the inner side
			const o = (u: number, s: number): V3 => [xOf(u), yAt(top, u), s * half(u, 0)];
			quad(wall, o(u0, 1), o(u1, 1), r(u1, 1), r(u0, 1));
			quad(wall, r(u0, -1), r(u1, -1), o(u1, -1), o(u0, -1));
		}
		parts.push({ g: geo(t, pos), c: deckColor }, { g: geo(t, wall), c: 0x4a3a2a });
		return parts;
	}
	return { deck: (u: number) => deck(u) - 0.07, bands };
}

// ---- what lies about ----

/** An old boat turned over on the beach: a faded hull, the keel board along it, two oars and a coil of rope beside it. */
function boat(t: T, w: number, d: number): Geo {
	return cached(`boot:${w}x${d}`, () => {
		const len = w * 0.86, wide = Math.max(0.5, d * 0.62), parts: Part[] = [dome(t, len / 2, 0.38, wide / 2, 0x5b7b8f, 0, 0, 0, 10)];
		parts.push(b(t, len * 0.9, 0.05, 0.07, WOOD_DARK, 0, 0.37, 0), b(t, len * 0.2, 0.05, 0.05, WOOD, len * 0.22, 0.34, wide * 0.12), b(t, 0.1, 0.12, 0.1, 0xd8d2c0, len / 2 - 0.02, 0.1, 0, [0, 0, 0.5]));
		for (const s of [-1, 1]) parts.push({ g: new t.CylinderGeometry(0.018, 0.018, len * 0.8, 5), c: WOOD, p: [-len * 0.05, 0.03, s * (wide / 2 + 0.1)], r: [0, 0, Math.PI / 2] }, b(t, 0.2, 0.012, 0.07, WOOD, len * 0.35, 0.03, s * (wide / 2 + 0.1)));
		parts.push({ g: new t.TorusGeometry(0.07, 0.025, 5, 9), c: 0xcdb98d, p: [-len * 0.38, 0.03, wide / 2 + 0.3], r: [Math.PI / 2, 0, 0] });
		return merge(t, parts, "boot");
	});
}
/** Barrels: two standing, one lying, with tar stains (a dark patch on the lid). */
function barrels(t: T, w: number, d: number): Geo {
	return cached(`faesser:${w}x${d}`, () => {
		const parts: Part[] = [];
		barrelAt(t, parts, -w * 0.22, 0, -d * 0.12); barrelAt(t, parts, w * 0.1, 0, d * 0.1);
		parts.push(cy(t, 0.12, 0.12, 0.012, 0x2a2018, -w * 0.22, 0.4, -d * 0.12, 7), { g: new t.CylinderGeometry(0.19, 0.19, 0.4, 8), c: WOOD, p: [w * 0.3, 0.19, -d * 0.2], r: [0, 0.3, Math.PI / 2] }, { g: new t.CylinderGeometry(0.2, 0.2, 0.03, 8), c: WOOD_DARK, p: [w * 0.3 - 0.07, 0.19, -d * 0.2 + 0.02], r: [0, 0.3, Math.PI / 2] }, { g: new t.CylinderGeometry(0.2, 0.2, 0.03, 8), c: WOOD_DARK, p: [w * 0.3 + 0.07, 0.19, -d * 0.2 - 0.02], r: [0, 0.3, Math.PI / 2] });
		return merge(t, parts, "faesser");
	});
}
/** Crates, two below and one on top turned a little, and a crab basket (a cage of rods) beside them. */
function crates(t: T, w: number, d: number): Geo {
	return cached(`kisten:${w}x${d}`, () => {
		const parts: Part[] = [];
		crateAt(t, parts, -w * 0.25, 0, 0, 0.34); crateAt(t, parts, w * 0.08, 0, 0.06, 0.32, 0.2); crateAt(t, parts, -w * 0.08, 0.34, 0.02, 0.26, 0.5);
		parts.push(cy(t, 0.11, 0.09, 0.26, 0xa88a5c, w * 0.32, 0, -0.05, 7));
		for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; parts.push(b(t, 0.015, 0.26, 0.015, WOOD_DARK, w * 0.32 + Math.cos(a) * 0.1, 0.13, -0.05 + Math.sin(a) * 0.1)); }
		return merge(t, parts, "kisten");
	});
}
/** A market stall: four posts, a striped awning, a counter with goods, sacks and a crate behind it. */
function stall(t: T, w: number, d: number): Geo {
	return cached(`stand:${w}x${d}`, () => {
		const ww = w * 0.84, dd = d * 0.7, parts: Part[] = [];
		for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) parts.push(b(t, 0.06, 0.9, 0.06, WOOD_DARK, (sx * ww) / 2, 0.45, (sz * dd) / 2));
		for (let i = 0; i < 6; i++) parts.push(b(t, ww / 6, 0.04, dd + 0.3, i % 2 ? 0xf2e8d0 : 0xc0392b, -ww / 2 + ww / 12 + (i * ww) / 6, 0.95, 0, [0.18, 0, 0]));
		parts.push(b(t, ww * 0.94, 0.05, 0.3, WOOD, 0, 0.44, dd * 0.3), b(t, ww * 0.94, 0.4, 0.06, WOOD_DARK, 0, 0.22, dd * 0.42), b(t, ww * 0.9, 0.04, 0.2, 0xa88a5c, 0, 0.3, -dd * 0.3));
		for (let i = 0; i < 4; i++) parts.push(ball(t, 0.06, [0xd9534f, 0xe8b040, 0x8aa84a, 0xd9534f][i]!, -ww * 0.3 + i * 0.14, 0.52, dd * 0.3));
		parts.push(ball(t, 0.09, 0xe58b2a, ww * 0.25, 0.54, dd * 0.3), b(t, 0.2, 0.06, 0.12, 0xc89a5a, ww * 0.35, 0.49, dd * 0.3));
		sackAt(t, parts, -ww * 0.3, 0, -dd * 0.3); sackAt(t, parts, -ww * 0.18, 0, -dd * 0.3); crateAt(t, parts, ww * 0.3, 0, -dd * 0.3, 0.26);
		return merge(t, parts, "stand");
	});
}
/** A salt basin: a stone rim round a shallow white bed, a channel, a heap of salt and a wooden rake. */
function saltBasin(t: T, w: number, d: number): Geo {
	return cached(`becken:${w}x${d}`, () => {
		const bw = w * 0.82, bd = d * 0.78, parts: Part[] = [b(t, bw, 0.12, bd, STONE_DARK, 0, 0.06, 0)];
		for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) parts.push(b(t, (bw - 0.2) / 6 - 0.02, 0.03, (bd - 0.2) / 4 - 0.02, (i + j) % 2 ? 0xf1ede2 : 0xe4dfd0, -bw / 2 + 0.1 + ((i + 0.5) * (bw - 0.2)) / 6, 0.13, -bd / 2 + 0.1 + ((j + 0.5) * (bd - 0.2)) / 4));
		parts.push(b(t, bw + 0.1, 0.04, 0.12, 0x6aa7c8, 0, 0.05, bd / 2 + 0.1), { g: new t.ConeGeometry(0.2, 0.26, 6), c: 0xf6f3ea, p: [bw / 2 + 0.26, 0.13, -0.1] });
		parts.push(b(t, 0.04, 0.7, 0.04, WOOD, -bw * 0.2, 0.4, bd / 2 + 0.32, [0, 0, 0.5]), b(t, 0.22, 0.03, 0.05, WOOD, -bw * 0.2 - 0.23, 0.06, bd / 2 + 0.32));
		return merge(t, parts, "becken");
	});
}
/** A half-built hull on its stocks: keel, ribs and a few planks. */
function hull(t: T, w: number, d: number): Geo {
	return cached(`rumpf:${w}x${d}`, () => {
		const parts: Part[] = [];
		for (const x of [-0.35, 0, 0.35]) parts.push(b(t, 0.12, 0.2, d * 0.4, WOOD_DARK, x * w, 0.1, 0));
		hullFrame(t, parts, w * 0.86, d * 0.6, 0.2, 0.62);
		return merge(t, parts, "rumpf");
	});
}
/** Rocks: a few grey boulders, one big, with a patch of moss. */
function rocks(t: T, w: number, d: number): Geo {
	return cached(`felsen:${w}x${d}`, () => {
		const r = rand(`felsen:${w}x${d}`), parts: Part[] = [{ g: new t.DodecahedronGeometry(0.5, 0), c: STONE, p: [0, 0.3, 0], s: [w * 0.55, 0.9, d * 0.5], r: [0.3, r() * 3, 0.2] }];
		for (let i = 0; i < 4; i++) parts.push({ g: new t.DodecahedronGeometry(0.2 + r() * 0.1, 0), c: i % 2 ? STONE_DARK : 0x9a9588, p: [(r() - 0.5) * w * 0.95, 0.12, (r() - 0.5) * d * 1.3], r: [r() * 3, r() * 3, 0] });
		parts.push({ g: new t.DodecahedronGeometry(0.2, 0), c: 0x6f7a4a, p: [0.1, 0.6, 0], s: [1, 0.3, 1] });
		return merge(t, parts, "felsen");
	});
}
/** A dry-stone wall in courses, its top broken, a few stones fallen at its foot. */
function wall(t: T, w: number, d: number): Geo {
	return cached(`mauer:${w}x${d}`, () => {
		const r = rand(`mauer:${w}`), parts: Part[] = [], len = w * 0.96;
		for (let row = 0; row < 3; row++) {
			let x = -len / 2 + (row % 2) * 0.1;
			while (x < len / 2 - 0.1) {
				const bl = Math.min(0.2 + r() * 0.14, len / 2 - x), top = row === 2 && r() < 0.35;
				if (!top) parts.push(b(t, bl - 0.02, 0.15, d * 0.4 + r() * 0.04, r() < 0.12 ? 0x6f7a4a : r() < 0.5 ? STONE : 0x9a9588, x + bl / 2, 0.08 + row * 0.16, 0, [0, (r() - 0.5) * 0.08, 0]));
				x += bl;
			}
		}
		for (let i = 0; i < 4; i++) parts.push({ g: new t.DodecahedronGeometry(0.06 + r() * 0.05, 0), c: STONE, p: [(r() - 0.5) * len, 0.06, d * 0.36], r: [r() * 3, r() * 3, 0] });
		return merge(t, parts, "mauer");
	});
}
/** A tower stump: a round wall with a door arch, broken battlements, rubble. */
function towerStump(t: T, w: number, d: number): Geo {
	return cached(`turm:${w}x${d}`, () => {
		const r = rand("turm"), rad = Math.min(w, d) * 0.3, parts: Part[] = [cy(t, rad * 1.18, rad * 1.1, 0.12, STONE_DARK, 0, 0, 0, 10), cy(t, rad, rad * 0.92, 1.0, STONE, 0, 0.12, 0, 10)];
		for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; if (r() < 0.35) continue; parts.push({ g: new t.BoxGeometry(0.2, 0.2 + r() * 0.1, 0.1), c: i % 2 ? STONE : 0x9a9588, p: [Math.cos(a) * rad * 0.94, 1.22, Math.sin(a) * rad * 0.94], r: [0, -a + Math.PI / 2, 0] }); }
		parts.push(b(t, 0.26, 0.4, 0.06, 0x2a2018, 0, 0.32, rad * 0.95), b(t, 0.06, 0.2, 0.02, 0x2a2018, rad * 0.3, 0.8, rad * 0.9));
		for (let i = 0; i < 5; i++) parts.push({ g: new t.DodecahedronGeometry(0.07 + r() * 0.06, 0), c: STONE, p: [(r() - 0.5) * w * 1.1, 0.07, rad * 1.1 + r() * 0.2], r: [r() * 3, r() * 3, 0] });
		return merge(t, parts, "turm");
	});
}
/** A charcoal kiln: a mound of earth with a smoke hole, logs stacked at its foot. */
function kiln(t: T, w: number, d: number): Geo {
	return cached(`meiler:${w}x${d}`, () => {
		const rad = Math.min(w, d) * 0.36, parts: Part[] = [dome(t, rad, rad * 0.78, rad, 0x4d3b2a, 0, 0, 0, 10), cy(t, rad * 1.02, rad * 1.02, 0.1, 0x1f1a16, 0, 0, 0, 10), cy(t, 0.1, 0.07, 0.16, 0x1f1a16, 0, rad * 0.74, 0, 6), ball(t, 0.1, 0x8a8a88, 0.02, rad * 0.74 + 0.28, 0, [1.3, 0.8, 1.1])];
		for (let i = 0; i < 4; i++) for (let k = 0; k < 3 - (i % 2); k++) parts.push({ g: new t.CylinderGeometry(0.055, 0.055, 0.5, 6), c: k % 2 ? WOOD : BARK, p: [rad * 1.05 + k * 0.09 + 0.1, 0.06 + (i % 2) * 0.1, -0.2 + i * 0.13], r: [Math.PI / 2, 0, 0] });
		return merge(t, parts, "meiler");
	});
}

/** The model of a piece of scenery by its model name, null for one without its own (the map draws a ruin or a scaffold). */
export function sceneryModel(t: T, model: string | undefined, w: number, d: number, variant: number): Geo | null {
	switch (model) {
		case "boot": return boat(t, w, d);
		case "faesser": return barrels(t, w, d);
		case "kisten": return crates(t, w, d);
		case "stand": return stall(t, w, d);
		case "becken": return saltBasin(t, w, d);
		case "rumpf": return hull(t, w, d);
		case "felsen": return rocks(t, w, d);
		case "mauer": return wall(t, w, d);
		case "turm": return towerStump(t, w, d);
		case "meiler": return kiln(t, w, d);
		case "huette": return hut(t, w, d, 0x8c8576, variant % 3);
		default: return null;
	}
}
