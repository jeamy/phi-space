// The shape of the island railway's track in one cell, shared by the 2D and the 3D map (engine/rail.ts gives the cells of
// a run): a straight piece along the way, or a quarter circle where the way turns, so the rails run on in a curve and not in
// two overlapping straights. Cell units, the cell's centre at (0, 0), x to the right, y down (rows), a cell one unit wide.

export type Dir = readonly [number, number];
export type Spot = { x: number; y: number; /** the sleeper's long axis */ ax: number; ay: number };

/** The way a run enters and leaves its cell `i`: the steps from the cell before and to the cell after (the ends go straight on). */
export function stepsAt(run: Array<{ x: number; y: number }>, i: number): { d1: Dir; d2: Dir } {
	const c = run[i]!, prev = run[i - 1], next = run[i + 1];
	const d2: Dir = next ? [next.x - c.x, next.y - c.y] : prev ? [c.x - prev.x, c.y - prev.y] : [1, 0];
	const d1: Dir = prev ? [c.x - prev.x, c.y - prev.y] : d2;
	return { d1, d2 };
}

const turns = (d1: Dir, d2: Dir) => d1[0] !== d2[0] || d1[1] !== d2[1];
/** The centre of the quarter circle of a turn, and where on it the way enters and leaves (angles). */
function arc(d1: Dir, d2: Dir) {
	const cx = (d2[0] - d1[0]) / 2, cy = (d2[1] - d1[1]) / 2;
	const a0 = Math.atan2(-d1[1] / 2 - cy, -d1[0] / 2 - cx), a1 = Math.atan2(d2[1] / 2 - cy, d2[0] / 2 - cx);
	let delta = a1 - a0;
	while (delta > Math.PI) delta -= 2 * Math.PI;
	while (delta <= -Math.PI) delta += 2 * Math.PI;
	return { cx, cy, a0, delta };
}

/** One rail of the piece, `off` to the left of the way (negative: right), as a polyline from the cell's entry to its exit. */
export function railPoints(d1: Dir, d2: Dir, off: number, steps = 8): Array<{ x: number; y: number }> {
	if (!turns(d1, d2)) {
		const nx = -d1[1] * off, ny = d1[0] * off;
		return [{ x: -d1[0] / 2 + nx, y: -d1[1] / 2 + ny }, { x: d1[0] / 2 + nx, y: d1[1] / 2 + ny }];
	}
	const { cx, cy, a0, delta } = arc(d1, d2);
	// the left of the way is the outer side when it points away from the circle's centre
	const out = (-d1[0] / 2 - cx) * -d1[1] + (-d1[1] / 2 - cy) * d1[0] > 0, r = 0.5 + (out ? off : -off);
	return Array.from({ length: steps + 1 }, (_, k) => ({ x: cx + r * Math.cos(a0 + (delta * k) / steps), y: cy + r * Math.sin(a0 + (delta * k) / steps) }));
}

/** Where the sleepers of the piece lie and which way they point: two across a straight, three on a quarter circle. */
export function sleeperSpots(d1: Dir, d2: Dir): Spot[] {
	if (!turns(d1, d2)) return [-0.25, 0.25].map((t) => ({ x: d1[0] * t, y: d1[1] * t, ax: -d1[1], ay: d1[0] }));
	const { cx, cy, a0, delta } = arc(d1, d2);
	return [1 / 6, 3 / 6, 5 / 6].map((f) => { const a = a0 + delta * f; return { x: cx + 0.5 * Math.cos(a), y: cy + 0.5 * Math.sin(a), ax: Math.cos(a), ay: Math.sin(a) }; });
}
