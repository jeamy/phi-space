// The row from jetty to jetty in the 3D view (engine/commands/fishing.ts `rudere`): the server moves the figure at once;
// the page shows its own figure casting off in a rowing boat and rowing out of the old place (the page holds that place
// for ROW_OUT_MS, App.tsx), then rowing in to the jetty of the new one and stepping ashore (ROW_IN_MS). The path is pure,
// so it is tested without a browser.
import { merge, plainMaterial, type T } from "./props3d.ts";

/** How long the boat rows out of the old place, and in to the new one. */
export const ROW_OUT_MS = 2_200, ROW_IN_MS = 2_800;
/** How far the boat rows out from the jetty, in cells. */
const REACH = 5;

type Rect = { x: number; y: number; w?: number; h?: number };
/** Where a boat lies at a jetty (`moor`, in the water just past its tip) and where it rows out to (`out`), in cell
 *  coordinates (a cell's middle is x + 0.5); the side of the jetty with the most water beyond its edge is its tip.
 *  Null where no side has water. */
export function rowPath(ground: readonly string[], water: (key: string) => boolean, jetty: Rect): { moor: { x: number; y: number }; out: { x: number; y: number } } | null {
	const w = jetty.w ?? 1, h = jetty.h ?? 1;
	const wet = (x: number, y: number) => { const row = ground[y]; return row === undefined || x < 0 || x >= row.length || water(row[x]!); };
	const sides = [
		{ dx: 1, dy: 0, cells: Array.from({ length: h }, (_, i) => [jetty.x + w, jetty.y + i] as const) },
		{ dx: -1, dy: 0, cells: Array.from({ length: h }, (_, i) => [jetty.x - 1, jetty.y + i] as const) },
		{ dx: 0, dy: 1, cells: Array.from({ length: w }, (_, i) => [jetty.x + i, jetty.y + h] as const) },
		{ dx: 0, dy: -1, cells: Array.from({ length: w }, (_, i) => [jetty.x + i, jetty.y - 1] as const) },
	].map((s) => ({ ...s, n: s.cells.filter(([x, y]) => wet(x, y)).length / s.cells.length }));
	// the tip: the side all water, and of those the one the jetty is long towards
	const best = sides.filter((s) => s.n > 0).sort((a, b) => b.n - a.n || (b.dx !== 0 ? w : h) - (a.dx !== 0 ? w : h))[0];
	if (!best) return null;
	const cx = jetty.x + w / 2, cy = jetty.y + h / 2;
	const moor = { x: cx + best.dx * (w / 2 + 0.6), y: cy + best.dy * (h / 2 + 0.6) };
	return { moor, out: { x: moor.x + best.dx * REACH, y: moor.y + best.dy * REACH } };
}

/** Smooth start and stop. */
export const ease = (p: number) => (p <= 0 ? 0 : p >= 1 ? 1 : p * p * (3 - 2 * p));

/** A rowing boat for one, its bow to +x, long enough for a figure on its thwart (a figure is about 1.2 high), with two
 *  oars that row (`oars`, turned by `rowOars`). */
export function rowboat(t: T): { group: import("three").Group; oars: import("three").Group[] } {
	const group = new t.Group();
	const wood = 0x8a6440, dark = 0x5a3e26, inside = 0x6e4e32;
	const hull = merge(t, [
		{ g: new t.BoxGeometry(1.5, 0.12, 0.62), c: wood, p: [-0.1, 0.06, 0], m: "none" },
		{ g: new t.BoxGeometry(1.5, 0.22, 0.06), c: wood, p: [-0.1, 0.17, 0.31], m: "none" },
		{ g: new t.BoxGeometry(1.5, 0.22, 0.06), c: wood, p: [-0.1, 0.17, -0.31], m: "none" },
		{ g: new t.BoxGeometry(0.06, 0.22, 0.62), c: wood, p: [-0.85, 0.17, 0], m: "none" },
		// the bow: two planks meeting in a point
		{ g: new t.BoxGeometry(0.5, 0.22, 0.06), c: wood, p: [0.82, 0.17, 0.16], r: [0, 0.58, 0], m: "none" },
		{ g: new t.BoxGeometry(0.5, 0.22, 0.06), c: wood, p: [0.82, 0.17, -0.16], r: [0, -0.58, 0], m: "none" },
		{ g: new t.BoxGeometry(0.42, 0.1, 0.5), c: wood, p: [0.78, 0.06, 0], r: [0, Math.PI / 4, 0], s: [1, 1, 0.6], m: "none" },
		{ g: new t.BoxGeometry(1.4, 0.02, 0.52), c: inside, p: [-0.1, 0.13, 0], m: "none" },
		// gunwales and the thwart the rower sits on
		{ g: new t.BoxGeometry(1.56, 0.04, 0.08), c: dark, p: [-0.1, 0.3, 0.32], m: "none" },
		{ g: new t.BoxGeometry(1.56, 0.04, 0.08), c: dark, p: [-0.1, 0.3, -0.32], m: "none" },
		{ g: new t.BoxGeometry(0.18, 0.04, 0.6), c: dark, p: [0.12, 0.24, 0], m: "none" },
	], "rowboat");
	group.add(new t.Mesh(hull, plainMaterial(t)));
	const oarMaterial = new t.MeshStandardMaterial({ color: dark, roughness: 0.9 });
	const oars: import("three").Group[] = [];
	for (const side of [1, -1]) {
		const pivot = new t.Group(); pivot.position.set(0.02, 0.32, side * 0.33);
		const shaft = new t.Mesh(new t.BoxGeometry(0.04, 0.04, 1.0), oarMaterial); shaft.position.z = side * 0.3;
		const blade = new t.Mesh(new t.BoxGeometry(0.16, 0.02, 0.3), oarMaterial); blade.position.z = side * 0.72;
		const arm = new t.Group(); arm.rotation.x = side * 0.32; arm.add(shaft, blade);
		pivot.add(arm); group.add(pivot); oars.push(pivot);
	}
	return { group, oars };
}

type Rower = { group: import("three").Object3D; body: import("three").Object3D; mesh: import("three").Object3D; legL: import("three").Object3D; legR: import("three").Object3D; armL: import("three").Object3D; armR: import("three").Object3D };
/** Seats a figure (figure3d.ts) on the boat's thwart facing the stern, as one rows, its legs stretched out before it;
 *  its shadow and ring stay ashore. */
export function seatRower(f: Rower): void {
	for (const c of f.group.children) if (c !== f.body && c !== f.mesh) c.visible = false;
	f.group.position.set(0.12, -0.26, 0); f.group.rotation.y = -Math.PI / 2;
	f.legL.rotation.x = f.legR.rotation.x = -Math.PI / 2;
}

/** The stroke at time `s` (seconds): the oars sweep and dip, the rower's arms pull them, both together. */
export function rowOars(oars: ReadonlyArray<import("three").Group>, s: number, rower?: Rower): void {
	const q = s * Math.PI * 2 * 0.8;
	for (const o of oars) { const side = Math.sign(o.position.z); o.rotation.y = Math.sin(q) * 0.5 * side; o.rotation.x = Math.max(0, Math.cos(q)) * 0.16 * side; }
	if (rower) rower.armL.rotation.x = rower.armR.rotation.x = -1.25 + Math.sin(q) * 0.4;
}
