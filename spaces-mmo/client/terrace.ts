// The outlines of the 3D ground's terraces (terrain3d.ts, docs/architektur.en.md "3D presentation contract"): which cells
// stand at or above a height, as closed loops around them with rounded corners. Pure, without three.js, so node tests it.
// Visual only: the grid stays the truth, and the middle of every cell keeps its height.

/** A point in cell units: x along the row, y down the rows (cell x,y covers [x, x+1] × [y, y+1]). */
export type Pt = readonly [number, number];
/** A closed loop of corners; `outer` is a boundary with the inside to its right (as the grid runs, y down), a hole the other way. */
export type Loop = { pts: Pt[]; outer: boolean };

/** The loops around the cells for which `inside` holds, over the cells from -pad to w+pad-1 (and the same in y). Cells
 *  outside that range count as outside. Two cells that touch only at a corner give two loops, not one through the corner. */
export function outlineLoops(w: number, h: number, inside: (x: number, y: number) => boolean, pad = 0): Loop[] {
	const x0 = -pad, y0 = -pad, x1 = w + pad, y1 = h + pad;
	const isIn = (x: number, y: number) => x >= x0 && y >= y0 && x < x1 && y < y1 && inside(x, y);
	type Edge = { ax: number; ay: number; bx: number; by: number; used: boolean };
	const edges: Edge[] = [], from = new Map<string, Edge[]>();
	const add = (ax: number, ay: number, bx: number, by: number) => {
		const e = { ax, ay, bx, by, used: false }, k = `${ax},${ay}`;
		edges.push(e); const list = from.get(k); if (list) list.push(e); else from.set(k, [e]);
	};
	// every side of an inside cell that faces an outside one, clockwise around the cell on the screen (y down)
	for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (isIn(x, y)) {
		if (!isIn(x, y - 1)) add(x, y, x + 1, y);
		if (!isIn(x + 1, y)) add(x + 1, y, x + 1, y + 1);
		if (!isIn(x, y + 1)) add(x + 1, y + 1, x, y + 1);
		if (!isIn(x - 1, y)) add(x, y + 1, x, y);
	}
	const loops: Loop[] = [];
	for (const start of edges) {
		if (start.used) continue;
		const pts: Pt[] = [];
		let e: Edge | undefined = start;
		while (e && !e.used) {
			e.used = true; pts.push([e.ax, e.ay]);
			const dx: number = e.bx - e.ax, dy: number = e.by - e.ay;
			// where two cells touch at a corner, turn towards the inside (right on the screen): the two stay apart
			const turn = (n: Edge): number => { const nx = n.bx - n.ax, ny = n.by - n.ay; return nx === -dy && ny === dx ? 0 : nx === dx && ny === dy ? 1 : 2; };
			const next: Edge[] = (from.get(`${e.bx},${e.by}`) ?? []).filter((n) => !n.used);
			e = next.sort((a, b) => turn(a) - turn(b))[0];
		}
		const corners = pts.filter((p, i) => {
			const a = pts[(i - 1 + pts.length) % pts.length]!, b = pts[(i + 1) % pts.length]!;
			return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
		});
		loops.push({ pts: corners, outer: area(corners) > 0 });
	}
	return loops;
}

/** Twice the signed area (positive for an outer loop as outlineLoops gives it). */
export function area(pts: readonly Pt[]): number {
	let a = 0;
	for (let i = 0; i < pts.length; i++) { const p = pts[i]!, q = pts[(i + 1) % pts.length]!; a += p[0] * q[1] - q[0] * p[1]; }
	return a;
}

export function inside(pt: Pt, pts: readonly Pt[]): boolean {
	let c = false;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const [xi, yi] = pts[i]!, [xj, yj] = pts[j]!;
		if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
	}
	return c;
}

/** The outer loops, each with the holes it holds: a hole belongs to the smallest outer loop around it (an island in a lake
 *  in an island has its own). */
export function withHoles(loops: readonly Loop[]): Array<{ outer: Pt[]; holes: Pt[][] }> {
	const outers = loops.filter((l) => l.outer).map((l) => ({ outer: l.pts, holes: [] as Pt[][], size: Math.abs(area(l.pts)) }));
	for (const hole of loops.filter((l) => !l.outer)) {
		// a point just inside the hole's first edge, on the side away from the hole's inside: in the land round it
		const [a, b] = [hole.pts[0]!, hole.pts[1]!], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
		const dx = Math.sign(b[0] - a[0]), dy = Math.sign(b[1] - a[1]);
		// the land lies to the right of every edge on the screen (y down), a hole's as well
		const probe: Pt = [mx - dy * 0.25, my + dx * 0.25];
		const home = outers.filter((o) => inside(probe, o.outer)).sort((p, q) => p.size - q.size)[0];
		home?.holes.push(hole.pts);
	}
	return outers.map(({ outer, holes }) => ({ outer, holes }));
}

/** A loop with its corners rounded: each corner replaced by an arc of radius `r` (at most half of the sides next to it),
 *  `steps` segments each. Corners for which `sharp` holds stay as they are. */
export function rounded(pts: readonly Pt[], r: number, steps = 6, sharp: (p: Pt) => boolean = () => false): Pt[] {
	const n = pts.length, out: Pt[] = [];
	for (let i = 0; i < n; i++) {
		const p = pts[i]!, a = pts[(i - 1 + n) % n]!, b = pts[(i + 1) % n]!;
		if (sharp(p)) { out.push(p); continue; }
		const la = Math.hypot(a[0] - p[0], a[1] - p[1]), lb = Math.hypot(b[0] - p[0], b[1] - p[1]), k = Math.min(r, la / 2, lb / 2);
		const s: Pt = [p[0] + ((a[0] - p[0]) / la) * k, p[1] + ((a[1] - p[1]) / la) * k], e: Pt = [p[0] + ((b[0] - p[0]) / lb) * k, p[1] + ((b[1] - p[1]) / lb) * k];
		// the corners are right angles: a quarter circle from s to e round the point opposite p
		const c: Pt = [s[0] + e[0] - p[0], s[1] + e[1] - p[1]];
		const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
		let a1 = Math.atan2(e[1] - c[1], e[0] - c[0]);
		while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
		while (a0 - a1 > Math.PI) a1 += 2 * Math.PI;
		for (let j = 0; j <= steps; j++) { const t = a0 + ((a1 - a0) * j) / steps; out.push([c[0] + Math.cos(t) * k, c[1] + Math.sin(t) * k]); }
	}
	return out;
}

/** One terrace: the cells at or above its height (and of its kind where several kinds share that height), with the
 *  profile of its edge. `thick` is how far the edge rounds down, `size` how far in it starts; `bottom` is where its wall
 *  begins, hidden in the terrace below. */
export type Terrace = { key: string; height: number; at: (x: number, y: number) => boolean; thick: number; size: number; bottom: number };

/** The terraces of a room, lowest first: one per land kind. A kind's terrace holds its own cells and every higher one, so a
 *  terrace's edge lies only against lower ground, and where a higher kind meets a lower one the lower's edge is under it. */
export function terraces(ground: readonly string[], kind: (key: string) => { height: number; water: boolean }): Terrace[] {
	const h = ground.length, w = ground[0]?.length ?? 0;
	const cell = (x: number, y: number) => ground[Math.min(h - 1, Math.max(0, y))]?.[Math.min(w - 1, Math.max(0, x))] ?? "";
	const keys = [...new Set(ground.join(""))].filter((k) => !kind(k).water).sort((a, b) => kind(a).height - kind(b).height || a.localeCompare(b));
	const heights = [...new Set(keys.map((k) => kind(k).height))];
	const out: Terrace[] = [];
	for (const key of keys) {
		const height = kind(key).height;
		const at = (x: number, y: number) => { const k = cell(x, y), v = kind(k); return !v.water && (k === key || v.height > height); };
		// the lowest ground this terrace's edge meets inside the room: how far its edge may round down
		let low = height;
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (at(x, y)) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= w || ny >= h || at(nx, ny)) continue;
			low = Math.min(low, kind(cell(nx, ny)).height);
		}
		const thick = Math.min(0.26, Math.max(0, (height - low) * 0.85)), size = Math.min(0.34, thick * 1.3);
		const below = heights.filter((v) => v < height).at(-1);
		const under = out.filter((t) => t.height === below).reduce((m, t) => Math.max(m, t.thick), 0);
		out.push({ key, height, at, thick, size, bottom: below === undefined ? 0 : below - under });
	}
	return out;
}

/** Which sides of a cell lie on its terrace's rounded edge (the ground beyond is lower and inside the room): there the
 *  surface leaves its height within `size` of the side. */
export function edgeSides(ground: readonly string[], height: (key: string) => number, x: number, y: number): { n: boolean; e: boolean; s: boolean; w: boolean } {
	const h = ground.length, w = ground[0]?.length ?? 0, own = height(ground[y]?.[x] ?? "");
	const lower = (nx: number, ny: number) => nx >= 0 && ny >= 0 && nx < w && ny < h && height(ground[ny]![nx]!) < own;
	return { n: lower(x, y - 1), e: lower(x + 1, y), s: lower(x, y + 1), w: lower(x - 1, y) };
}
