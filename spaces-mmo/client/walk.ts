// The own character's walk (client-side prediction with reconciliation). The page does not wait for the server: every
// step gets a number, the figure is drawn at once where the step leads, and the server answers each numbered step on
// the character (CharacterFields.ack), also a step it could not take. On an answer the page drops the steps up to that
// number and draws the figure at the server's place plus the steps still on their way. So a held key walks evenly at
// WALK_MS per cell however slow the answers are, letting go stops the figure at once, and nothing pulls it back except
// the server's real place: a position without a newer answer (arriving, a session, someone else's move) is ignored
// while steps are on their way.
export const WALK_MS = 150;
/** Steps the page may walk ahead of the answers: a guard against running away from a server that stopped answering. */
export const MAX_AHEAD = 8;
/** No answer for this long while steps are on their way (an intent lost): the page takes the server's place again.
 *  Longer than a busy world takes to answer (2 to 9 s with 200 figures, docs/lasttest-2026-10-28.en.md): sooner, the
 *  figure jumped back to where the answers stood and forward again when they came. A lost intent lapses after 30 s. */
export const RESYNC_MS = 15_000;

type Cell = { x: number; y: number };
export type Step = { seq: number; dx: number; dy: number };

export class Walker {
	#seq = 0;
	#pending: Step[] = [];
	#server: Cell | null = null;
	#acked = 0;
	#progress = 0;

	/** Where the figure is drawn: the server's place with the steps not yet answered. */
	get shown(): Cell | null {
		if (!this.#server) return null;
		let p = { ...this.#server };
		for (const s of this.#pending) p = { x: p.x + s.dx, y: p.y + s.dy };
		return p;
	}

	/** Steps on their way. */
	get ahead(): number { return this.#pending.length; }

	/** A new room or connection: the server's place, nothing on its way (the numbers go on, so a late answer to an old
	 *  step can never match a new one). */
	reset(at: Cell): void { this.#server = { x: at.x, y: at.y }; this.#pending = []; this.#acked = this.#seq; }

	/** The next step by (dx, dy), or null when the place is unknown or the page is MAX_AHEAD steps ahead. The caller has
	 *  checked that the cell it leads to is free. */
	step(dx: number, dy: number, now: number): Step | null {
		if (!this.#server || this.#pending.length >= MAX_AHEAD) return null;
		if (!this.#pending.length) this.#progress = now;
		const s = { seq: ++this.#seq, dx, dy };
		this.#pending.push(s);
		return s;
	}

	/** A place of the own character from the server, with the number of the last step it answers (`ack`) or without.
	 *  Returns where to draw the figure now, or null to leave it where it is drawn. */
	report(at: Cell, ack: number | undefined, now: number): Cell | null {
		if (ack !== undefined && ack > this.#acked) {
			this.#acked = ack;
			this.#server = { x: at.x, y: at.y };
			this.#pending = this.#pending.filter((s) => s.seq > ack);
			this.#progress = now;
			return this.shown;
		}
		// not an answer to a step: it counts only while nothing is on its way (else it is an older place)
		if (this.#pending.length) return null;
		this.#server = { x: at.x, y: at.y };
		return this.shown;
	}

	/** Now and then: steps without any answer for RESYNC_MS are given up; returns the server's place to draw then. */
	tick(now: number): Cell | null {
		if (!this.#pending.length || now - this.#progress < RESYNC_MS) return null;
		this.#pending = [];
		return this.shown;
	}
}

/** The first step of a shortest way from `from` to `to` over cells `free` allows (`to` itself need not be free when it is
 *  an exit the walk ends on: the caller says), or null when there is none or it is there. A way is searched anew at every
 *  step, so a figure that steps in is walked around. At most `limit` cells are looked at (a room has 384). The page walks
 *  by nextMove since the grid switch; this one stays the reference of the tests and tests/perf/target-choice.ts. */
export function nextStep(free: (x: number, y: number) => boolean, from: Cell, to: Cell, limit = 1024): [number, number] | null {
	if (from.x === to.x && from.y === to.y) return null;
	// from the goal back, so the first cell reached beside `from` is the step to take
	// cells keyed by a number (y·2^16 + x; a room is far narrower), not by "x,y" strings; a cell outside the room is
	// never free, so never seen, and one that shares a number with it is never in a room
	const key = (x: number, y: number) => y * 65_536 + x;
	const seen = new Set([key(to.x, to.y)]), queue: Cell[] = [to];
	for (let i = 0; i < queue.length && i < limit; i++) {
		const c = queue[i]!;
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) {
			const n = { x: c.x + dx, y: c.y + dy };
			if (n.x === from.x && n.y === from.y) return [dx ? -dx : 0, dy ? -dy : 0];
			if (seen.has(key(n.x, n.y)) || !free(n.x, n.y)) continue;
			seen.add(key(n.x, n.y));
			queue.push(n);
		}
	}
	return null;
}

/** The next move of a walk from `from` to `to` over the cells `free` allows in a room of `w` × `h` (`to` need not be free:
 *  an exit the walk ends on), or null when there is none or it is there. It is a shortest way, and among those it keeps
 *  the direction of the `last` move while that stays on one, else takes the direction whose straight run along a
 *  shortest way is longest (ties in the order right, left, down, up): so a way bends seldom, and its straight runs go
 *  as moves of up to `length` cells (STEP_LENGTH: two at scale 2, docs/3d-welt-und-raster-plan-2026-11-21.en.md section 3,
 *  "Path smoothing"). One search from the goal over the whole room (its area is the budget), anew at every move, so a
 *  figure that steps in is walked around. */
export function nextMove(free: (x: number, y: number) => boolean, from: Cell, to: Cell, w: number, h: number, length = 1, last: [number, number] | null = null): [number, number] | null {
	if (from.x === to.x && from.y === to.y) return null;
	const inRoom = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;
	if (!inRoom(from.x, from.y) || !inRoom(to.x, to.y)) return null;
	const dist = new Int32Array(w * h).fill(-1), queue = new Int32Array(w * h), at = (x: number, y: number) => y * w + x;
	const start = at(from.x, from.y);
	dist[at(to.x, to.y)] = 0; queue[0] = at(to.x, to.y);
	let tail = 1;
	for (let i = 0; i < tail && dist[start] < 0; i++) {
		const c = queue[i]!, x = c % w, y = (c - x) / w;
		for (const [dx, dy] of DIRS) {
			const nx = x + dx, ny = y + dy;
			if (!inRoom(nx, ny)) continue;
			const n = at(nx, ny);
			if (dist[n]! >= 0 || (n !== start && !free(nx, ny))) continue;
			dist[n] = dist[c]! + 1;
			if (n !== start) queue[tail++] = n;
		}
	}
	const d = dist[start]!;
	if (d < 0) return null;
	// how far a straight run in (dx, dy) goes down the way, cell by cell one nearer to the goal
	const run = ([dx, dy]: readonly [number, number]) => { let k = 0; while (k < d) { const x = from.x + dx * (k + 1), y = from.y + dy * (k + 1); if (!inRoom(x, y) || dist[at(x, y)] !== d - k - 1) break; k++; } return k; };
	let best: readonly [number, number] | null = null, bestRun = 0;
	if (last && Math.abs(last[0]) + Math.abs(last[1]) > 0) { const u = [Math.sign(last[0]), Math.sign(last[1])] as const, k = run(u); if (k > 0) { best = u; bestRun = k; } }
	if (!best) for (const dir of DIRS) { const k = run(dir); if (k > bestRun) { best = dir; bestRun = k; } }
	if (!best) return null;
	const n = Math.min(Math.max(1, length), bestRun);
	return [best[0] * n, best[1] * n];
}
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** Where a tap at `goal` leads (App.tsx walkTo): the goal itself when it is free; else the first cell of the rings 1 to
 *  `rings` around it (ring by ring, row by row) that is the figure's own cell, or free and reachable from `start` over
 *  free cells. One search from `start` over the room (`w` × `h`) answers every candidate, so a tap looks at no more
 *  than the room's cells plus the candidates (before, every candidate searched anew: about 150 times the room for an
 *  occupied goal beyond water). Null: no cell leads there. Same answer as a search per candidate within the room. */
export function chooseTarget(free: (x: number, y: number) => boolean, start: Cell, goal: Cell, w: number, h: number, rings: number): Cell | null {
	if (free(goal.x, goal.y)) return goal;
	let reached: Uint8Array | null = null;
	const reach = (c: Cell) => {
		if (c.x < 0 || c.y < 0 || c.x >= w || c.y >= h) return false;
		if (!reached) {
			// one breadth-first search from the figure over the free cells of the room
			reached = new Uint8Array(w * h);
			const seen = new Uint8Array(w * h), queue: number[] = [];
			if (start.x >= 0 && start.y >= 0 && start.x < w && start.y < h) { seen[start.y * w + start.x] = 1; queue.push(start.y * w + start.x); }
			for (let i = 0; i < queue.length; i++) {
				const at = queue[i]!, x = at % w, y = (at - x) / w;
				reached[at] = 1;
				for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) {
					const nx = x + dx, ny = y + dy, n = ny * w + nx;
					if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[n]) continue;
					seen[n] = 1;
					if (free(nx, ny)) queue.push(n);
				}
			}
		}
		return reached[c.y * w + c.x] === 1;
	};
	for (let r = 1; r <= rings; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
		if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
		const c = { x: goal.x + dx, y: goal.y + dy };
		if (c.x === start.x && c.y === start.y) return c;
		if (free(c.x, c.y) && reach(c)) return c;
	}
	return null;
}

/** An arrow on the screen (up is [0, -1]) as a step on the grid, for a 3D view whose camera stands at `angle` around the
 *  room (MapView3D: the camera at (cos a, sin a) of the room's middle, looking at it). Up walks away from the camera,
 *  right to the right of it; the view's turn is taken to the nearest quarter, so a slanted view still has one answer
 *  (at the start view, up is up). */
export function screenToGrid(d: [number, number], angle: number): [number, number] {
	const quarter = Math.round((angle - Math.PI / 2) / (Math.PI / 2));
	const a = Math.PI / 2 + quarter * (Math.PI / 2);
	const forward = [-Math.cos(a), -Math.sin(a)], right = [Math.sin(a), -Math.cos(a)];
	const x = d[0] * right[0]! - d[1] * forward[0]!, y = d[0] * right[1]! - d[1] * forward[1]!;
	return [Math.round(x) || 0, Math.round(y) || 0];
}
