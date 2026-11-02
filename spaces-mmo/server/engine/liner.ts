// The large ship (docs/siedeln.en.md, step 8): when it lies in a bay and where. Pure, so the commands (fishing.ts) and the
// browser's view share it: what the map shows and what `einschiffen` allows come from the same world time.

/** When the line's ship lies in a bay: the first half of every period. The time to it, 0 while it lies there. */
export const shipIn = (now: number, everyWorldMs: number) => { const at = now % everyWorldMs; return at < everyWorldMs / 2 ? 0 : everyWorldMs - at; };

/** Cells the ship is long. */
export const SHIP_LENGTH = 4;

/** Where the ship lies in a bay: the strip of SHIP_LENGTH water cells along x or y nearest the spawn whose cells around
 *  are water too (or beyond the room's edge, the open sea), so it floats clear of the shore. Its first cell and the
 *  direction, or null when the bay has no such water. */
export function berth(ground: string[], spawn: { x: number; y: number }, water = "~"): { x: number; y: number; along: "x" | "y" } | null {
	const h = ground.length, w = ground[0]?.length ?? 0;
	const wet = (x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h || ground[y]![x] === water;
	const clear = (x0: number, y0: number, along: "x" | "y") => {
		const [lx, ly] = along === "x" ? [SHIP_LENGTH, 1] : [1, SHIP_LENGTH];
		if (x0 < 0 || y0 < 0 || x0 + lx > w || y0 + ly > h) return false;
		for (let y = y0 - 1; y <= y0 + ly; y++) for (let x = x0 - 1; x <= x0 + lx; x++) if (!wet(x, y)) return false;
		return true;
	};
	let best: { x: number; y: number; along: "x" | "y" } | null = null, bestD = Infinity;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (const along of ["x", "y"] as const) {
		if (!clear(x, y, along)) continue;
		const mx = along === "x" ? x + SHIP_LENGTH / 2 : x + 0.5, my = along === "y" ? y + SHIP_LENGTH / 2 : y + 0.5;
		const d = Math.hypot(mx - spawn.x, my - spawn.y);
		if (d < bestD) { bestD = d; best = { x, y, along }; }
	}
	return best;
}

/** The bays of a world: per island the first room with a spawn (the world's bays are written first). */
export function baysOf<R extends { roomId: string; island?: string; spawn?: { x: number; y: number } }>(rooms: R[]): Map<string, R> {
	const seen = new Map<string, R>();
	for (const r of rooms) if (r.island && r.spawn && !seen.has(r.island)) seen.set(r.island, r);
	return seen;
}
