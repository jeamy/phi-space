// The searches over a room as they were before the shared grid (shared/grid.ts, phase 1 of the grid plan): cells keyed by
// "x,y" strings and every cell read through `walkable`. Kept to hold the grid searches to the same answers
// (tests/grid-search.test.ts) and to time them against each other (tests/perf/search-cost.ts).
import { walkable, type WorldDef } from "../server/engine/world.ts";

export type Cell = { x: number; y: number };
export const key = (c: Cell) => `${c.x},${c.y}`;
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

export function legacyFindPath(w: WorldDef, ground: string[], from: Cell, to: Cell, max: number, blocked: ReadonlySet<string> = new Set()): Cell[] | null {
	if (!walkable(w, ground, to.x, to.y) || blocked.has(`${to.x},${to.y}`)) return null;
	if (from.x === to.x && from.y === to.y) return [];
	const width = ground[0]!.length, k = (x: number, y: number) => y * width + x;
	const prev = new Map<number, number>([[k(from.x, from.y), -1]]);
	let frontier = [from];
	for (let step = 0; step < max && frontier.length; step++) {
		const next: Cell[] = [];
		for (const c of frontier) for (const [dx, dy] of STEPS) {
			const x = c.x + dx, y = c.y + dy, kk = k(x, y);
			if (prev.has(kk) || !walkable(w, ground, x, y) || blocked.has(`${x},${y}`)) continue;
			prev.set(kk, k(c.x, c.y));
			if (x === to.x && y === to.y) {
				const path: Cell[] = [];
				for (let at = kk; at !== k(from.x, from.y); at = prev.get(at)!) path.unshift({ x: at % width, y: Math.floor(at / width) });
				return path;
			}
			next.push({ x, y });
		}
		frontier = next;
	}
	return null;
}

export function legacyReachable(w: WorldDef, ground: string[], from: Cell, blocked: ReadonlySet<string>): Set<string> {
	const seen = new Set<string>([key(from)]);
	let ring = [from];
	while (ring.length) {
		const next: Cell[] = [];
		for (const c of ring) for (const [dx, dy] of STEPS) {
			const n = { x: c.x + dx, y: c.y + dy }, k = key(n);
			if (seen.has(k) || blocked.has(k) || !walkable(w, ground, n.x, n.y)) continue;
			seen.add(k); next.push(n);
		}
		ring = next;
	}
	return seen;
}

export function legacyFreeCellNear(w: WorldDef, ground: string[], at: Cell, avoid: ReadonlySet<string>, radius: number): Cell | null {
	const seen = new Set<string>([key(at)]);
	let ring: Cell[] = [at];
	for (let r = 0; r <= radius && ring.length; r++) {
		for (const c of ring) if (walkable(w, ground, c.x, c.y) && !avoid.has(key(c))) return c;
		const next: Cell[] = [];
		for (const c of ring) for (const [dx, dy] of STEPS) {
			const n = { x: c.x + dx, y: c.y + dy };
			if (!seen.has(key(n)) && n.y >= 0 && n.y < ground.length && n.x >= 0 && n.x < (ground[0]?.length ?? 0)) { seen.add(key(n)); next.push(n); }
		}
		ring = next;
	}
	return null;
}

export function legacyTrace(w: WorldDef, ground: string[], from: Cell, to: Cell[], blocked: ReadonlySet<string>): Cell[] | null {
	const h = ground.length, wd = ground[0]?.length ?? 0, goal = new Set(to.map(key));
	const dist = new Map<string, number>([[key(from), 0]]), before = new Map<string, string>(), open: Array<{ c: Cell; d: number }> = [{ c: from, d: 0 }];
	while (open.length) {
		open.sort((a, b) => a.d - b.d);
		const { c, d } = open.shift()!, k = key(c);
		if (d > (dist.get(k) ?? Infinity)) continue;
		if (goal.has(k)) {
			const out: Cell[] = [c];
			for (let at = k; before.has(at); ) { at = before.get(at)!; const [x, y] = at.split(",").map(Number); out.unshift({ x: x!, y: y! }); }
			return out;
		}
		for (const [dx, dy] of STEPS) {
			const n = { x: c.x + dx, y: c.y + dy }, nk = key(n);
			if (n.x < 0 || n.y < 0 || n.x >= wd || n.y >= h || !walkable(w, ground, n.x, n.y) || blocked.has(nk)) continue;
			const nd = d + (ground[n.y]![n.x] === ":" ? 1 : 3);
			if (nd < (dist.get(nk) ?? Infinity)) { dist.set(nk, nd); before.set(nk, k); open.push({ c: n, d: nd }); }
		}
	}
	return null;
}
