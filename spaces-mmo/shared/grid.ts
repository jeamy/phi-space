// A room's cells as one array (docs/3d-welt-und-raster-plan-2026-11-21.en.md section 3, "Performance strategy"): index
// y·w + x instead of "x,y" strings, for searches over a room. The Rust engine has the same (rust/mmo-engine/src/grid.rs).

/** The open cells of a room of `w` × `h` (1: open). */
export type Grid = { w: number; h: number; open: Uint8Array };

export function gridOf(w: number, h: number, open: (x: number, y: number) => boolean): Grid {
	const cells = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (open(x, y)) cells[y * w + x] = 1;
	return { w, h, open: cells };
}

/** The connected parts of the open cells (four neighbours): a label per cell, the same for cells of one part, -1 for a
 *  closed cell. Labels count from 0 in the order the parts are first met, row by row. */
export function components(g: Grid): Int32Array {
	const label = new Int32Array(g.w * g.h).fill(-1), queue = new Int32Array(g.w * g.h);
	let next = 0;
	for (let first = 0; first < g.open.length; first++) {
		if (!g.open[first] || label[first] !== -1) continue;
		let head = 0, tail = 0;
		label[first] = next; queue[tail++] = first;
		while (head < tail) {
			const at = queue[head++]!, x = at % g.w;
			const near = [x + 1 < g.w ? at + 1 : -1, x > 0 ? at - 1 : -1, at + g.w < g.open.length ? at + g.w : -1, at - g.w];
			for (const n of near) if (n >= 0 && g.open[n] && label[n] === -1) { label[n] = next; queue[tail++] = n; }
		}
		next++;
	}
	return label;
}

/** A cell of a grid (x, y). */
export type At = { x: number; y: number };
/** The index of `c` in `g`, or -1 when it lies outside (or is not a whole cell). */
export const indexOf = (g: { w: number; h: number }, c: At): number =>
	Number.isInteger(c.x) && Number.isInteger(c.y) && c.x >= 0 && c.y >= 0 && c.x < g.w && c.y < g.h ? c.y * g.w + c.x : -1;
const NEAR = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** The cells of a room one can walk on (server/engine/world.ts `walkable`): `ground`'s tiles with `walk`, as wide as its
 *  first row. */
export function walkGrid(tiles: Readonly<Record<string, { walk?: boolean } | undefined>>, ground: readonly string[]): Grid {
	const w = ground[0]?.length ?? 0, h = ground.length, open = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) { const row = ground[y]!; for (let x = 0; x < w; x++) { const t = row[x]; if (t !== undefined && tiles[t]?.walk) open[y * w + x] = 1; } }
	return { w, h, open };
}

/** `g` with the cells of `keys` ("x,y" as occupancy.ts cellKey writes them) closed, as a copy; a key of no cell of the
 *  grid is left out. The occupied sets the callers keep become one mask per search this way. */
export function closing(g: Grid, ...keys: Array<Iterable<string>>): Grid {
	const open = g.open.slice();
	for (const set of keys) for (const k of set) {
		const comma = k.indexOf(","), x = Number(k.slice(0, comma)), y = Number(k.slice(comma + 1));
		const i = comma > 0 ? indexOf(g, { x, y }) : -1;
		if (i >= 0 && `${x},${y}` === k) open[i] = 0;
	}
	return { w: g.w, h: g.h, open };
}

/** The shortest walk from `from` to `to` over open cells (four neighbours in the order right, left, down, up), at most
 *  `max` steps; the cells after the start, the target last; [] when they are the same cell, null when there is none.
 *  The start need not be open. (world.ts findPath, which keyed its cells by strings.) */
export function pathIn(g: Grid, from: At, to: At, max: number): At[] | null {
	const goal = indexOf(g, to), start = indexOf(g, from);
	if (goal < 0 || !g.open[goal]) return null;
	if (from.x === to.x && from.y === to.y) return [];
	if (start < 0) return null;
	const prev = new Int32Array(g.w * g.h).fill(-2);
	prev[start] = -1;
	let frontier = [start];
	for (let step = 0; step < max && frontier.length; step++) {
		const next: number[] = [];
		for (const at of frontier) {
			const cx = at % g.w, cy = (at - cx) / g.w;
			for (const [dx, dy] of NEAR) {
				const x = cx + dx, y = cy + dy;
				if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
				const k = y * g.w + x;
				if (prev[k] !== -2 || !g.open[k]) continue;
				prev[k] = at;
				if (k === goal) {
					const path: At[] = [];
					for (let p = k; p !== start; p = prev[p]!) path.push({ x: p % g.w, y: Math.floor(p / g.w) });
					return path.reverse();
				}
				next.push(k);
			}
		}
		frontier = next;
	}
	return null;
}

/** The cells reachable from `from` over open cells (four neighbours), `from` itself included whether open or not: 1 per
 *  reached cell. */
export function reachIn(g: Grid, from: At): Uint8Array {
	const seen = new Uint8Array(g.w * g.h), start = indexOf(g, from);
	if (start < 0) return seen;
	const queue = [start];
	seen[start] = 1;
	for (let i = 0; i < queue.length; i++) {
		const at = queue[i]!, cx = at % g.w, cy = (at - cx) / g.w;
		for (const [dx, dy] of NEAR) {
			const x = cx + dx, y = cy + dy;
			if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
			const k = y * g.w + x;
			if (!seen[k] && g.open[k]) { seen[k] = 1; queue.push(k); }
		}
	}
	return seen;
}

/** The nearest cell to `at` (itself first) that is `open`, searching outwards ring by ring over every cell of a room
 *  of `g`'s size, open or not, in the order of the four neighbours; null when there is none within `radius`. Only the cells
 *  it reaches are looked at. (occupancy.ts freeCellNear.) */
export function nearestOpen(g: { w: number; h: number }, at: At, radius: number, open: (c: At) => boolean): At | null {
	// the cells reached by their index, in a set: as a rule it ends long before an array of the room would pay
	const first = indexOf(g, at), seen = new Set<number>(first >= 0 ? [first] : []);
	let ring: At[] = [at];
	for (let r = 0; r <= radius && ring.length; r++) {
		for (const c of ring) if (open(c)) return c;
		const next: At[] = [];
		for (const c of ring) for (const [dx, dy] of NEAR) {
			const n = { x: c.x + dx, y: c.y + dy }, i = indexOf(g, n);
			if (i >= 0 && !seen.has(i)) { seen.add(i); next.push(n); }
		}
		ring = next;
	}
	return null;
}
