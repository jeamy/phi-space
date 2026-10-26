// The ground of Leuchtfeuer's rooms, drawn by a seeded generator instead of by hand: every room is 24×16 cells, the sea
// on the sides a room names, a beach between sea and grass (or sand in the dunes), a cobble plaza and cobble paths from
// every door to the middle (a path into the sea is a pier). The same seed always gives the same ground, so a world
// version stays the same world. Doors sit in the middle of each side; the cell one step inside is where one arrives.
export type Side = "n" | "e" | "s" | "w";
export type Cell = { x: number; y: number };
export type LandSpec = {
	seed: string;
	/** Sides that are open sea. */
	sea: Side[];
	/** Sides with a door (a way to the next room, or a pier where a ferry lands). */
	doors: Side[];
	/** Cells of beach between water and the inland. */
	beach?: number;
	/** The inland tile: grass, or sand for the dunes. */
	soil?: "," | ".";
	/** A cobble disc (a market square, the ring around a fire). */
	plaza?: Cell & { r: number };
};

export const W = 24, H = 16;
export const DOOR: Record<Side, Cell> = { n: { x: 12, y: 0 }, e: { x: 23, y: 8 }, s: { x: 12, y: 15 }, w: { x: 0, y: 8 } };
/** Where one arrives coming in through the door on that side. */
export const ARRIVE: Record<Side, Cell> = { n: { x: 12, y: 1 }, e: { x: 22, y: 8 }, s: { x: 12, y: 14 }, w: { x: 1, y: 8 } };
export const OPPOSITE: Record<Side, Side> = { n: "s", e: "w", s: "n", w: "e" };

/** A number in [0, 1) from a seed and a cell (FNV-1a, then a mix). */
function hash(seed: string, x: number, y: number): number {
	let h = 2166136261;
	for (const ch of `${seed}:${x}:${y}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
	h ^= h >>> 15; h = Math.imul(h, 2246822507); h ^= h >>> 13; h = Math.imul(h, 3266489909); h ^= h >>> 16;
	return (h >>> 0) / 4294967296;
}

/** Smooth noise in [0, 1): hashed corners every `step` cells, blended. */
function noise(seed: string, x: number, y: number, step = 4): number {
	const gx = Math.floor(x / step), gy = Math.floor(y / step), fx = (x % step) / step, fy = (y % step) / step;
	const s = (t: number) => t * t * (3 - 2 * t);
	const a = hash(seed, gx, gy), b = hash(seed, gx + 1, gy), c = hash(seed, gx, gy + 1), d = hash(seed, gx + 1, gy + 1);
	return a + (b - a) * s(fx) + (c - a) * s(fy) + (a - b - c + d) * s(fx) * s(fy);
}

export function land(spec: LandSpec): string[] {
	const beach = spec.beach ?? 2, soil = spec.soil ?? ",";
	const g: string[][] = [];
	for (let y = 0; y < H; y++) {
		const row: string[] = [];
		for (let x = 0; x < W; x++) {
			const dist: Record<Side, number> = { n: y, s: H - 1 - y, w: x, e: W - 1 - x };
			const wobble = (noise(spec.seed, x, y) - 0.5) * 3 + (noise(`${spec.seed}+`, x, y, 2) - 0.5);
			const coast = spec.sea.length ? Math.min(...spec.sea.map((s) => dist[s])) + wobble : Infinity;
			if (coast < 2.5) row.push("~");
			else if (coast < 2.5 + beach) row.push(".");
			else row.push(soil === "," && noise(`${spec.seed}#`, x, y, 3) > 0.8 ? "." : soil === "." && noise(`${spec.seed}#`, x, y, 3) > 0.75 ? "," : soil);
		}
		g.push(row);
	}
	if (spec.plaza) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - spec.plaza.x) ** 2 + (y - spec.plaza.y) ** 2 <= (spec.plaza.r + 0.5) ** 2) g[y]![x] = ":";
	const mid = { x: 12, y: 8 };
	for (const side of spec.doors) {
		const d = DOOR[side];
		for (let x = Math.min(d.x, mid.x); x <= Math.max(d.x, mid.x); x++) g[d.y]![x] = ":";
		for (let y = Math.min(d.y, mid.y); y <= Math.max(d.y, mid.y); y++) g[y]![d.x] = ":";
	}
	return g.map((r) => r.join(""));
}

/** The walkable cell of `tiles` nearest to `at` (rings around it), e.g. where an NPC or a fire stands. */
export function spot(ground: string[], at: Cell, tiles = ".,"): Cell {
	for (let r = 0; r < W; r++) {
		for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
			if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
			const x = at.x + dx, y = at.y + dy;
			if (y >= 0 && y < H && x >= 0 && x < W && tiles.includes(ground[y]![x]!)) return { x, y };
		}
	}
	throw new Error(`no ${tiles} cell near ${at.x},${at.y}`);
}

/** `n` distinct cells of `tiles`, chosen by the seed (things lying around when the world is first loaded). */
export function scatter(ground: string[], seed: string, n: number, tiles = ".,", avoid: Cell[] = []): Cell[] {
	const cells: Array<Cell & { k: number }> = [];
	ground.forEach((row, y) => [...row].forEach((t, x) => {
		if (tiles.includes(t) && !avoid.some((a) => Math.abs(a.x - x) <= 1 && Math.abs(a.y - y) <= 1)) cells.push({ x, y, k: hash(seed, x, y) });
	}));
	return cells.sort((a, b) => a.k - b.k).slice(0, n).map(({ x, y }) => ({ x, y }));
}

/** How much grows in a room: flowers and small plants, bushes, small trees (each 0 = none, 1 = the usual meadow). */
export type Flora = { flowers: number; bushes: number; trees: number };
/** The plant keys of the world's `decor` (world.ts): flower patches share one kind, so a patch is one colour. */
const FLOWERS = ["*", "+", "o", "x"], HERBS = ["i", "w", "v"], BUSHES = ["r", "b"], TREES = ["T", "A"];

/** Plants over the grass of a room, chosen by the seed: flowers in patches, now and then a herb, a bush or a small tree.
 *  Only on grass, never on or beside a path or a plaza, never on or beside a cell in `keep` (doors, the spawn, people,
 *  fires, things); bushes and trees only with grass all around and no other one beside them. Returns the `decor` grid
 *  (a space where nothing grows). Plants are for the eye: they change no rule, everyone walks through them. */
export function plants(ground: string[], seed: string, flora: Flora, keep: Cell[] = []): string[] {
	const g = ground.map((row) => [...row].map(() => " "));
	const at = (x: number, y: number) => ground[y]?.[x] ?? "~";
	const around = (x: number, y: number, ok: (t: string, x: number, y: number) => boolean) => {
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!ok(at(x + dx, y + dy), x + dx, y + dy)) return false;
		return true;
	};
	const kept = (x: number, y: number) => keep.some((c) => Math.abs(c.x - x) <= 1 && Math.abs(c.y - y) <= 1);
	const doors = Object.values(DOOR).concat(Object.values(ARRIVE));
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		if (at(x, y) !== "," || kept(x, y) || doors.some((d) => Math.abs(d.x - x) <= 1 && Math.abs(d.y - y) <= 1)) continue;
		if (!around(x, y, (t) => t !== ":")) continue;
		const r = hash(`${seed}/plant`, x, y);
		const tall = around(x, y, (t, ax, ay) => t === "," && !TREES.includes(g[ay]?.[ax] ?? "") && !BUSHES.includes(g[ay]?.[ax] ?? ""));
		if (tall && y > 0 && r < 0.045 * flora.trees) g[y]![x] = TREES[Math.floor(hash(`${seed}/tree`, x, y) * TREES.length)]!;
		else if (tall && r < 0.045 * flora.trees + 0.06 * flora.bushes) g[y]![x] = BUSHES[Math.floor(hash(`${seed}/bush`, x, y) * BUSHES.length)]!;
		else if (noise(`${seed}/patch`, x, y, 3) > 1 - 0.3 * flora.flowers && r < 0.75) g[y]![x] = FLOWERS[Math.floor(noise(`${seed}/colour`, x, y, 6) * FLOWERS.length)]!;
		else if (r > 0.97 - 0.05 * flora.flowers) g[y]![x] = HERBS[Math.floor(hash(`${seed}/herb`, x, y) * HERBS.length)]!;
	}
	return g.map((row) => row.join(""));
}
