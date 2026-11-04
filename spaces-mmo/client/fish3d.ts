// Fish for the 3D map (docs/3D-V2/README.md): the herring, the cod and the plaice of the coast, built from primitives in
// the models' style (props3d.ts: merged, vertex-coloured, shared, with far/room/near variants through `cached`). The body
// and the tail are two geometries, so the tail can beat while the fish swims (block3d.ts). The same bodies lie on the
// ground as the items "fisch" and "raeucherfisch". Visual only.
import { cached, merge, type Geo, type Part, type T } from "./props3d.ts";
import { modelLevel } from "./modelDetail3d.ts";

export type FishKind = "hering" | "dorsch" | "scholle";
export const FISH_KINDS: readonly FishKind[] = ["hering", "dorsch", "scholle"];

/** Each kind's length (nose at +x/2, tail root at −x/2), height, width and colours: back, belly, fins. */
const SHAPE: Record<FishKind, { len: number; high: number; wide: number; back: number; belly: number; fin: number }> = {
	hering: { len: 0.26, high: 0.05, wide: 0.03, back: 0x35607e, belly: 0xd6e0e6, fin: 0x8fa6b4 },
	dorsch: { len: 0.34, high: 0.07, wide: 0.044, back: 0x6c7448, belly: 0xe6dfc8, fin: 0x5c6440 },
	// the plaice lies flat: its "high" is its thickness, its "wide" the breadth of the disc
	scholle: { len: 0.28, high: 0.022, wide: 0.11, back: 0x7a6448, belly: 0xeeeae0, fin: 0x86704f },
};
/** Smoked: golden brown, darker on the back. */
const SMOKED = { back: 0x6e3f18, belly: 0xc98a34, fin: 0x5a3414 };

const sphere = (t: T, c: number, p: Part["p"], s: Part["s"], lower = false): Part =>
	({ g: new t.SphereGeometry(1, 10, 6, 0, Math.PI * 2, lower ? Math.PI / 2 : 0, Math.PI / 2), c, p, s });

/** A fish's body without its tail, nose towards +x, its middle at the origin. */
export function fishBody(t: T, kind: FishKind, smoked = false): Geo {
	return cached(`fish:${kind}:${smoked ? "smoked" : "fresh"}:body`, () => {
		const f = SHAPE[kind], col = smoked ? { ...f, ...SMOKED } : f, near = modelLevel() === "near", far = modelLevel() === "far";
		const L = f.len / 2, parts: Part[] = [];
		if (kind === "scholle") {
			// a flat disc, brown above and white below, a fringe of fin round it, both eyes on the upper side
			parts.push(sphere(t, col.back, [0, 0, 0], [L, f.high, f.wide / 2]), sphere(t, col.belly, [0, 0, 0], [L, f.high, f.wide / 2], true));
			if (!far) parts.push({ g: new t.SphereGeometry(1, 10, 4), c: col.fin, p: [-0.01, 0, 0], s: [L * 1.04, f.high * 0.25, f.wide * 0.6] });
			if (!far && !smoked) for (const [x, z] of [[0.04, 0.02], [-0.03, -0.025], [0.0, 0.035], [-0.06, 0.01], [0.07, -0.02]] as const) parts.push({ g: new t.CylinderGeometry(0.009, 0.009, 0.004, 8), c: 0xe0782a, p: [x, f.high * 0.9, z] });
			if (!far) for (const z of [0.012, -0.004]) parts.push({ g: new t.IcosahedronGeometry(0.007, 0), c: 0x1a1612, p: [L * 0.72, f.high * 0.85, z] });
			return merge(t, parts, `fish-${kind}`);
		}
		// a round fish: a dark back over a pale belly, a dorsal fin (three on the cod), pectoral fins, an eye on each side
		parts.push(sphere(t, col.back, [0, 0, 0], [L, f.high / 2, f.wide / 2]), sphere(t, col.belly, [0, 0, 0], [L, f.high / 2, f.wide / 2], true));
		// the head a little blunter: a cone towards the nose would be too sharp, a scaled sphere at the front rounds it
		parts.push({ g: new t.SphereGeometry(1, 8, 6), c: col.fin, p: [L * 0.62, -f.high * 0.08, 0], s: [L * 0.36, f.high * 0.38, f.wide * 0.44] });
		const dorsals = kind === "dorsch" ? [0.25, -0.05, -0.4] : [0.05];
		if (!far) for (const x of dorsals) parts.push({ g: new t.ConeGeometry(f.high * 0.32, f.high * 0.55, 4), c: col.fin, p: [x * L, f.high * 0.62, 0], s: [1.6, 1, 0.18] });
		if (!far) for (const side of [-1, 1]) parts.push({ g: new t.ConeGeometry(f.high * 0.18, f.high * 0.45, 3), c: col.fin, p: [L * 0.35, -f.high * 0.15, side * f.wide * 0.45], r: [side * 1.2, 0, 2.2], s: [1, 1, 0.3] });
		if (!far && !smoked) for (const side of [-1, 1]) parts.push({ g: new t.IcosahedronGeometry(f.high * 0.13, near ? 1 : 0), c: 0xf2efe6, p: [L * 0.68, f.high * 0.1, side * f.wide * 0.36] });
		for (const side of [-1, 1]) parts.push({ g: new t.IcosahedronGeometry(f.high * 0.08, 0), c: smoked ? 0x2a1a0c : 0x111111, p: [L * 0.7, f.high * 0.1, side * f.wide * 0.43] });
		if (near) {
			// up close: the gill cover's edge, the lateral line, the cod's barbel and its mottling
			for (const side of [-1, 1]) parts.push({ g: new t.BoxGeometry(0.004, f.high * 0.62, 0.004), c: col.back, p: [L * 0.45, 0, side * f.wide * 0.47], r: [0, 0, 0.2] });
			for (const side of [-1, 1]) parts.push({ g: new t.BoxGeometry(L * 1.3, 0.003, 0.003), c: kind === "dorsch" ? 0xe8e2cc : 0x9fb3c0, p: [-L * 0.1, f.high * 0.08, side * f.wide * 0.5] });
			if (kind === "dorsch") {
				parts.push({ g: new t.ConeGeometry(0.004, 0.03, 4), c: col.belly, p: [L * 0.78, -f.high * 0.42, 0] });
				if (!smoked) for (const [x, y, z] of [[0.08, 0.2, 1], [-0.02, 0.28, -1], [-0.1, 0.18, 1], [0.03, 0.15, -1], [-0.06, 0.25, 1]] as const) parts.push({ g: new t.IcosahedronGeometry(0.008, 0), c: 0xa89a62, p: [x, y * f.high, z * f.wide * 0.4], s: [1, 1, 0.4] });
			}
			if (kind === "hering") for (const side of [-1, 1]) parts.push({ g: new t.BoxGeometry(L * 1.4, f.high * 0.18, 0.003), c: 0xa9c4d2, p: [-L * 0.05, -f.high * 0.02, side * f.wide * 0.49] });
		}
		return merge(t, parts, `fish-${kind}`);
	});
}

/** A fish's tail fin, its root at the origin, reaching towards −x: it turns about y (the plaice's about x, it lies flat). */
export function fishTail(t: T, kind: FishKind, smoked = false): Geo {
	return cached(`fish:${kind}:${smoked ? "smoked" : "fresh"}:tail`, () => {
		const f = SHAPE[kind], fin = smoked ? SMOKED.fin : f.fin, parts: Part[] = [], span = kind === "scholle" ? f.wide * 0.55 : f.high * 0.75;
		// the stalk, then the two lobes of the fork (one fan for the plaice)
		parts.push({ g: new t.SphereGeometry(1, 6, 4), c: kind === "scholle" ? f.back : (smoked ? SMOKED.back : f.back), p: [-0.012, 0, 0], s: [0.024, kind === "scholle" ? f.high * 0.6 : f.high * 0.22, kind === "scholle" ? f.wide * 0.18 : f.wide * 0.25] });
		const lobes = kind === "dorsch" || kind === "scholle" ? [0] : [-1, 1];
		for (const k of lobes) {
			const g = new t.BoxGeometry(0.06, kind === "scholle" ? 0.004 : span * (lobes.length > 1 ? 0.55 : 1), kind === "scholle" ? span : 0.004);
			parts.push(kind === "scholle" ? { g, c: fin, p: [-0.045, 0, 0] } : { g, c: fin, p: [-0.042, k * span * 0.24, 0], r: [0, 0, k * -0.45] });
		}
		return merge(t, parts, `fish-${kind}-tail`);
	});
}

/** A whole fish as one group: `body` and the `tail` beside it (the tail's pivot is the body's back end). */
export function fishModel(t: T, kind: FishKind, material: import("three").Material, smoked = false): { group: import("three").Group; tail: import("three").Mesh } {
	const group = new t.Group(), body = new t.Mesh(fishBody(t, kind, smoked), material), tail = new t.Mesh(fishTail(t, kind, smoked), material);
	tail.position.x = -SHAPE[kind].len / 2 + 0.01;
	group.add(body, tail);
	return { group, tail };
}

/** The item pictures that are fish: a fish lies on the ground instead of the picture (MapView3D object). */
export function fishItem(icon: string | undefined): { kind: FishKind; smoked: boolean } | null {
	if (!icon) return null;
	if (/(^|\/)raeucherfisch\.png$/.test(icon)) return { kind: "hering", smoked: true };
	if (/(^|\/)fisch\.png$/.test(icon)) return { kind: "dorsch", smoked: false };
	return null;
}
