// The large ship (docs/siedeln.en.md, step 8): when it lies in a bay and where. Pure, so the commands (fishing.ts) and the
// browser's view share it: what the map shows and what `einschiffen` allows come from the same world time.

/** The line's ship sails one loop over the bays of all islands and lies a while in each. Everything about it is a pure function of
 *  the world time, so every region, the commands, the figures and the browser agree without any state of its own. */
export type Stop = { island: string; room: string; x: number; y: number };
/** `legMs[i]` is the time the ship sails from stop i to the next (the last one back to the first); a loop is the stays and the legs. */
export type Timetable = { stops: Stop[]; stayMs: number; legMs: number[]; cycleMs: number };

/** The stops in the order the ship visits them: the bays of the islands round the middle of the map, so the legs do not cross.
 *  A leg takes `unitWorldMs` per cell of the map between the two bays (at least a few minutes). */
export function timetable(rooms: Array<{ roomId: string; island?: string; spawn?: { x: number; y: number }; map?: { x: number; y: number } }>, d: { stayWorldMs: number; unitWorldMs: number }): Timetable | null {
	const at = [...baysOf(rooms.filter((r) => r.map))].map(([island, r]) => ({ island, room: r.roomId, x: r.map!.x, y: r.map!.y }));
	if (at.length < 2) return null;
	const cx = at.reduce((a, r) => a + r.x, 0) / at.length, cy = at.reduce((a, r) => a + r.y, 0) / at.length;
	const stops = at.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx) || a.island.localeCompare(b.island));
	const legMs = stops.map((a, i) => { const b = stops[(i + 1) % stops.length]!; return Math.max(5 * 60_000, Math.round(Math.hypot(b.x - a.x, b.y - a.y) * d.unitWorldMs)); });
	return { stops, stayMs: d.stayWorldMs, legMs, cycleMs: legMs.reduce((a, l) => a + d.stayWorldMs + l, 0) };
}

export type ShipState = { /** The stop it lies at, or null while it sails. */ lies: number | null; /** The stop it came from and the one it goes to (the same while it lies). */ from: number; to: number; /** Progress of the leg, 0 to 1 (0 while it lies). */ f: number; /** Time left of the stay or of the leg. */ leftMs: number };

export function shipState(t: Timetable, now: number): ShipState {
	let at = ((now % t.cycleMs) + t.cycleMs) % t.cycleMs;
	for (let i = 0; i < t.stops.length; i++) {
		const next = (i + 1) % t.stops.length;
		if (at < t.stayMs) return { lies: i, from: i, to: i, f: 0, leftMs: t.stayMs - at };
		at -= t.stayMs;
		if (at < t.legMs[i]!) return { lies: null, from: i, to: next, f: at / t.legMs[i]!, leftMs: t.legMs[i]! - at };
		at -= t.legMs[i]!;
	}
	return { lies: 0, from: 0, to: 0, f: 0, leftMs: t.stayMs };
}

/** Time until the ship lies at stop `i` (0 while it lies there). */
export function shipComes(t: Timetable, now: number, i: number): number {
	const s = shipState(t, now);
	if (s.lies === i) return 0;
	let start = 0;
	for (let k = 0; k < i; k++) start += t.stayMs + t.legMs[k]!;
	return (((start - (((now % t.cycleMs) + t.cycleMs) % t.cycleMs)) % t.cycleMs) + t.cycleMs) % t.cycleMs;
}

/** The stop a passenger aboard (boarded in room `from`, bound for room `to`) can leave the ship at next, and how long until
 *  the ship lies there (0: it lies there now); null when that stop is the destination itself. While the ship still lies in
 *  the bay it was boarded in, the next is the one after. A passenger of an older entry has no `from`: a stop the ship lies at
 *  counts as the next. */
export function nextStop(t: Timetable, now: number, from: string | undefined, to: string): { i: number; stop: Stop; inMs: number } | null {
	const s = shipState(t, now), n = t.stops.length;
	const i = s.lies !== null ? (t.stops[s.lies]!.room === from ? (s.lies + 1) % n : s.lies) : s.to;
	const stop = t.stops[i]!;
	return stop.room === to ? null : { i, stop, inMs: shipComes(t, now, i) };
}

type Pt = { x: number; y: number };
/** The way of each leg over the water of the map, for drawing: `wet(x, y)` says where the map's fine grid (a pixel per
 *  cell of a room) is water, `at` where a stop's room lies on it. Each way runs from the water nearest one bay to the water
 *  nearest the next, around the land, and is pulled straight where the water allows; a leg without one is the straight
 *  line. The timetable stays as it is: the ship only takes this way on the map. */
export function seaWays(t: Timetable, w: number, h: number, wet: (x: number, y: number) => boolean, at: (s: Stop) => Pt): Pt[][] {
	const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;
	const water = (x: number, y: number) => inside(x, y) && wet(x, y);
	const key = (x: number, y: number) => y * w + x;
	// the water nearest a point (a bay's middle is often land)
	const shore = (p: Pt): Pt | null => {
		const from = { x: Math.round(p.x), y: Math.round(p.y) };
		for (let r = 0; r < Math.max(w, h); r++) {
			let best: Pt | null = null, d = Infinity;
			for (let y = from.y - r; y <= from.y + r; y++) for (let x = from.x - r; x <= from.x + r; x++) {
				if ((Math.abs(x - from.x) !== r && Math.abs(y - from.y) !== r) || !water(x, y)) continue;
				const e = Math.hypot(x - from.x, y - from.y); if (e < d) { d = e; best = { x, y }; }
			}
			if (best) return best;
		}
		return null;
	};
	// a straight line over water only (sampled finely, so no corner of land is cut)
	const clear = (a: Pt, b: Pt) => { const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 8); for (let i = 0; i <= n; i++) { const f = n ? i / n : 0; if (!water(Math.round(a.x + (b.x - a.x) * f), Math.round(a.y + (b.y - a.y) * f))) return false; } return true; };
	const way = (a: Pt, b: Pt): Pt[] | null => {
		const before = new Map<number, number>([[key(a.x, a.y), -1]]), queue = [a];
		for (let i = 0; i < queue.length; i++) {
			const c = queue[i]!;
			if (c.x === b.x && c.y === b.y) {
				const path: Pt[] = [];
				for (let k = key(c.x, c.y); k !== -1; k = before.get(k)!) path.unshift({ x: k % w, y: Math.floor(k / w) });
				// pulled straight: from each point on to the farthest one in plain sight
				const out = [path[0]!];
				for (let j = 0; j < path.length - 1;) { let k = path.length - 1; while (k > j + 1 && !clear(path[j]!, path[k]!)) k--; out.push(path[k]!); j = k; }
				return out;
			}
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
				const x = c.x + dx, y = c.y + dy;
				// no corner cut between two cells of land
				if (!water(x, y) || before.has(key(x, y)) || (dx && dy && (!water(c.x + dx, c.y) || !water(c.x, c.y + dy)))) continue;
				before.set(key(x, y), key(c.x, c.y)); queue.push({ x, y });
			}
		}
		return null;
	};
	return t.stops.map((st, i) => {
		const next = t.stops[(i + 1) % t.stops.length]!, a = shore(at(st)), b = shore(at(next));
		return (a && b && way(a, b)) || [at(st), at(next)];
	});
}

/** Where the ship is on a drawn way (seaWays) at `f` of its leg (0 to 1), and the point it heads for. */
export function alongWay(way: Pt[], f: number): Pt & { ahead: Pt } {
	const lens = way.slice(1).map((p, i) => Math.hypot(p.x - way[i]!.x, p.y - way[i]!.y)), all = lens.reduce((a, l) => a + l, 0);
	if (f >= 1 || way.length < 2) return { ...way.at(-1)!, ahead: way.at(-1)! };
	let left = Math.max(0, f) * all;
	for (let i = 0; i < lens.length; i++) {
		if (left <= lens[i]! || i === lens.length - 1) { const a = way[i]!, b = way[i + 1]!, g = lens[i] ? Math.min(1, left / lens[i]!) : 0; return { x: a.x + (b.x - a.x) * g, y: a.y + (b.y - a.y) * g, ahead: b }; }
		left -= lens[i]!;
	}
	return { ...way[0]!, ahead: way[1] ?? way[0]! };
}

/** How long the ship takes to run into its bay and out of it again (world time): it does not appear and vanish, it comes and goes. */
export const SHIP_GLIDE_MS = 10 * 60_000;

/** Where the ship is in the bay of stop `i`: "lies" (at its berth, boarding), "arriving" and "leaving" (on its way in and out:
 *  `away` runs from 0 at the berth to 1 beyond the bay's edge, eased), or "away" (at sea, not in view). */
export function shipPlace(t: Timetable, now: number, i: number): { phase: "lies" | "leaving" | "arriving" | "away"; away: number } {
	const s = shipState(t, now), ease = (x: number) => x * x * (3 - 2 * x);
	if (s.lies === i) return { phase: "lies", away: 0 };
	const leg = t.legMs[s.from]!, glide = Math.min(SHIP_GLIDE_MS, leg / 3);
	if (s.to === i && s.leftMs <= glide) return { phase: "arriving", away: ease(s.leftMs / glide) };
	if (s.from === i && s.f * leg <= glide) return { phase: "leaving", away: ease((s.f * leg) / glide) };
	return { phase: "away", away: 1 };
}

/** The way the ship takes out of its berth: along its axis towards the end where the open water is longer. `dist` is how far it
 *  goes (cells of the ship's own length beyond the berth's end, to the room's edge when the water reaches it). */
export function lane(ground: string[], b: { x: number; y: number; along: "x" | "y" }, water = "~"): { sx: number; sy: number; dist: number } {
	const h = ground.length, w = ground[0]?.length ?? 0, wet = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && ground[y]![x] === water;
	const [dx, dy] = b.along === "x" ? [1, 0] : [0, 1];
	const run = (sign: 1 | -1) => {
		const sx = sign === 1 ? b.x + (b.along === "x" ? SHIP_LENGTH : 1) : b.x - 1, sy = sign === 1 ? b.y + (b.along === "y" ? SHIP_LENGTH : 1) : b.y - 1;
		let n = 0, x = b.along === "x" ? sx : b.x, y = b.along === "y" ? sy : b.y;
		while (wet(x, y)) { n++; x += dx * sign; y += dy * sign; }
		const edge = x < 0 || y < 0 || x >= w || y >= h;
		return { n, edge };
	};
	const fwd = run(1), back = run(-1), pick = fwd.edge !== back.edge ? (fwd.edge ? 1 : -1) : fwd.n >= back.n ? 1 : -1, r = pick === 1 ? fwd : back;
	return { sx: dx * pick, sy: dy * pick, dist: r.n + (r.edge ? SHIP_LENGTH : 0) };
}

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

const cache = new WeakMap<object, Timetable | null>();
/** The timetable of a world's line (its bays over all regions), or null when it has none. */
export function linerOf(w: { liner?: { stayWorldMs: number; unitWorldMs: number }; allRooms?: Parameters<typeof timetable>[0]; rooms: Parameters<typeof timetable>[0] }): Timetable | null {
	if (!w.liner) return null;
	if (!cache.has(w)) cache.set(w, timetable(w.allRooms ?? w.rooms, w.liner));
	return cache.get(w)!;
}
