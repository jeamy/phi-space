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
 *  Longer than a busy world takes to answer (2 to 9 s with 200 figures, docs/lasttest-2026-10-28.md): sooner, the
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
