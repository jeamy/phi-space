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
