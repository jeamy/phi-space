// The island railway's tracks (docs/siedeln.en.md, step 8): where they run, derived from the stations alone. Pure, so the
// browser draws them from what it knows (the rooms and their links, the rooms with a station, this room's exits and
// buildings) as the commands see the stations. Tracks are drawn on the ground; they never block a cell.

/** The links between rooms the tracks follow: per island, a tree of the shortest ways from the station of the lowest room
 *  id to every other station of that island, both directions as "a|b". An island with one station has none. */
export function railLinks(rooms: Array<{ roomId: string; island?: string }>, links: Array<[string, string]>, stations: string[]): Set<string> {
	const island = new Map(rooms.map((r) => [r.roomId, r.island ?? ""]));
	const next = new Map<string, string[]>();
	for (const [a, b] of links) {
		if (island.get(a) !== island.get(b)) continue; // the ferries and the ship cross the water, the railway does not
		for (const [x, y] of [[a, b], [b, a]] as const) { const n = next.get(x) ?? []; if (!n.includes(y)) n.push(y); next.set(x, n); }
	}
	const out = new Set<string>(), all = [...new Set(stations)].filter((s) => island.has(s));
	for (const isle of new Set(all.map((s) => island.get(s)))) {
		const mine = all.filter((s) => island.get(s) === isle).sort();
		if (mine.length < 2) continue;
		const parent = new Map<string, string>([[mine[0]!, ""]]), queue = [mine[0]!];
		for (let i = 0; i < queue.length; i++) for (const n of [...(next.get(queue[i]!) ?? [])].sort()) if (!parent.has(n)) { parent.set(n, queue[i]!); queue.push(n); }
		for (const s of mine.slice(1)) for (let at = s; parent.get(at); at = parent.get(at)!) { const p = parent.get(at)!; out.add(`${at}|${p}`); out.add(`${p}|${at}`); }
	}
	return out;
}

/** When the train stands at the stations: the first half of every period, all of them at once (a ride is quick). The
 *  time to it, 0 while it stands there; without a timetable always 0. */
export const trainIn = (now: number, everyWorldMs?: number) => { if (!everyWorldMs) return 0; const at = now % everyWorldMs; return at < everyWorldMs / 2 ? 0 : everyWorldMs - at; };

type Cell = { x: number; y: number };
type Rect = Cell & { w: number; h: number };

/** Where a track meets a station: the cells left and right of its front row, where its own short track runs out. */
export const stationEnds = (s: Rect): Cell[] => [{ x: s.x - 1, y: s.y + s.h - 1 }, { x: s.x + s.w, y: s.y + s.h - 1 }];

/** The cells of the track in one room: from its station (or, without one, the first exit) to each exit the railway
 *  leaves by, the shortest way over land around what stands (`blocked`), else over land at all. In order, each run from
 *  the station (its first cell the end of the station's own track, inside it) or first exit outwards. */
export function trackCells(ground: string[], station: Rect | null, exits: Cell[], blocked: Set<string>, water = "~"): Cell[][] {
	const h = ground.length, w = ground[0]?.length ?? 0;
	const land = (c: Cell) => c.x >= 0 && c.y >= 0 && c.x < w && c.y < h && ground[c.y]![c.x] !== water;
	const way = (from: Cell[], to: Cell, around: boolean): Cell[] | null => {
		const key = (c: Cell) => `${c.x},${c.y}`, before = new Map<string, string>(), queue: Cell[] = [];
		// an end of the station inside what stands (a bed beside it) is no start, unless no way around is left
		for (const f of from) if (land(f) && !(around && blocked.has(key(f)))) { before.set(key(f), ""); queue.push(f); }
		for (let i = 0; i < queue.length; i++) {
			const c = queue[i]!;
			if (c.x === to.x && c.y === to.y) {
				const path: Cell[] = [];
				for (let k = key(c); k; k = before.get(k)!) { const [x, y] = k.split(",").map(Number); path.unshift({ x: x!, y: y! }); }
				return path;
			}
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
				const n = { x: c.x + dx, y: c.y + dy }, k = key(n);
				if (before.has(k) || !land(n) || (around && blocked.has(k) && !(n.x === to.x && n.y === to.y))) continue;
				before.set(k, key(c)); queue.push(n);
			}
		}
		return null;
	};
	const hub = station ? stationEnds(station) : exits.slice(0, 1), rest = station ? exits : exits.slice(1);
	const runs: Cell[][] = [];
	for (const e of rest) {
		const p = way(hub, e, true) ?? way(hub, e, false);
		// from the station's own track: its end cell inside the station leads the run, so the rails join
		if (p && station) p.unshift({ x: p[0]!.x < station.x ? station.x : station.x + station.w - 1, y: p[0]!.y });
		if (p) runs.push(p);
	}
	return runs;
}
