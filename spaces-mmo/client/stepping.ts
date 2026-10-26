// The pace of the own character's steps. A key held down or a tap on the map sends `step dx dy`; the server answers with
// the character's new place a moment later (about 0.15 s). So that walking feels immediate and a held key still stops
// when it is let go:
//  - a step is sent as soon as `STEP_MS` have passed since the last one, with at most `MAX_IN_FLIGHT` not yet answered;
//  - the figure moves at once to the cell the step leads to (a prediction), and the answers that confirm it do not pull it
//    back to an earlier cell while later steps are on their way;
//  - an answer that differs (the server refused or placed the figure elsewhere) drops the predictions: the server decides.
export const STEP_MS = 170;
export const MAX_IN_FLIGHT = 2;
/** An unanswered step stops counting after this long (a refused step is answered by a message, not by a place). */
export const EXPIRE_MS = 700;

type Cell = { x: number; y: number };

export class StepPacer {
	#sent: number[] = [];
	#last = 0;
	#predicted: Cell[] = [];

	/** May a step be sent now? */
	canSend(now: number): boolean {
		this.#sent = this.#sent.filter((t) => now - t < EXPIRE_MS);
		if (!this.#sent.length) this.#predicted = [];
		return this.#sent.length < MAX_IN_FLIGHT && now - this.#last >= STEP_MS;
	}

	/** A step was sent; `to` is the cell it leads to when the client is sure about it. */
	sent(now: number, to?: Cell): void {
		this.#sent.push(now); this.#last = now;
		if (to) this.#predicted.push(to);
	}

	/** After `EXPIRE_MS` without an answer: true when predicted steps were never confirmed (the server refused them), so
	 *  the figure must go back to the place the server last reported. */
	settle(now: number): boolean {
		this.#sent = this.#sent.filter((t) => now - t < EXPIRE_MS);
		if (this.#sent.length) return false;
		const stale = this.#predicted.length > 0;
		this.#predicted = [];
		return stale;
	}

	/** The server says where the own character is. `ahead`: later steps are still on their way, keep the figure where the
	 *  prediction put it. `apply`: take this place. */
	answer(at: Cell): "ahead" | "apply" {
		this.#sent.shift();
		const i = this.#predicted.findIndex((c) => c.x === at.x && c.y === at.y);
		if (i < 0) { this.#predicted = []; return "apply"; }
		this.#predicted = this.#predicted.slice(i + 1);
		return this.#predicted.length ? "ahead" : "apply";
	}
}
