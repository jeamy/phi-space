// Admission (docs/zanzibar-agent-filesystem-plan.en.md, section 6.1): one bounded queue per tenant, each running its
// operations one at a time in arrival order, and one gate above all of them. Closing the gate refuses every operation
// that has not started and resolves once every started one has reached its outcome; a suspended tenant refuses alone.
// The queues give order and fairness, not fault isolation: every tenant shares one store and one writer.

/** The public error `unavailable`: retrying later can help. */
export class Unavailable extends Error {
	readonly code = "unavailable";
	readonly retryAfterMs?: number;
	constructor(message: string, retryAfterMs?: number) { super(message); this.name = "Unavailable"; this.retryAfterMs = retryAfterMs; }
}

type Pending = { run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void; at: number };
type Queue = { pending: Pending[]; running: boolean };

export type AdmissionOptions = {
	/** Operations of one tenant waiting behind the running one; one more is refused with `unavailable`. */
	maxQueuedPerTenant?: number;
	/** The retry delay a refusal suggests. */
	retryAfterMs?: number;
	/** Told of every operation that ran: how long it waited in its queue and how long it ran (milliseconds). */
	observe?: (waitMs: number, runMs: number) => void;
};

export class Admission {
	readonly #queues = new Map<string, Queue>();
	readonly #suspended = new Map<string, string>();
	readonly #maxQueued: number;
	readonly #retryAfterMs: number;
	readonly #observe: AdmissionOptions["observe"];
	#open = true;
	#started = 0;
	#drained: Array<() => void> = [];

	constructor(o: AdmissionOptions = {}) {
		this.#maxQueued = o.maxQueuedPerTenant ?? 64;
		this.#retryAfterMs = o.retryAfterMs ?? 1000;
		this.#observe = o.observe;
		if (!Number.isSafeInteger(this.#maxQueued) || this.#maxQueued < 0) throw new RangeError("maxQueuedPerTenant must be a non-negative integer");
	}

	get open(): boolean { return this.#open; }

	/** Runs `op` in the tenant's queue once every earlier operation of that tenant has finished. */
	run<T>(tenant: string, op: () => Promise<T>): Promise<T> {
		try { this.#check(tenant); } catch (e) { return Promise.reject(e); }
		let q = this.#queues.get(tenant);
		if (!q) { q = { pending: [], running: false }; this.#queues.set(tenant, q); }
		if (q.running && q.pending.length >= this.#maxQueued) return Promise.reject(new Unavailable(`the queue of tenant ${tenant} is full`, this.#retryAfterMs));
		const queue = q;
		return new Promise<T>((resolve, reject) => {
			queue.pending.push({ run: op, resolve: resolve as (v: unknown) => void, reject, at: performance.now() });
			this.#next(tenant, queue);
		});
	}

	/** Closes the gate: refuses every queued operation that has not started, and resolves once the started ones are done. */
	async close(): Promise<void> {
		this.#open = false;
		for (const [tenant, q] of this.#queues) this.#refuseQueued(tenant, q, `admission is closed`);
		if (this.#started > 0) await new Promise<void>((r) => this.#drained.push(r));
	}

	/** Opens the gate again. */
	reopen(): void { this.#open = true; }

	/** Suspends one tenant (inconsistentState, a pending security action): it refuses until `resume`. */
	suspend(tenant: string, reason: string): void {
		this.#suspended.set(tenant, reason);
		const q = this.#queues.get(tenant);
		if (q) this.#refuseQueued(tenant, q, `tenant ${tenant} is suspended: ${reason}`);
	}

	resume(tenant: string): void { this.#suspended.delete(tenant); }

	suspended(tenant: string): string | undefined { return this.#suspended.get(tenant); }

	#check(tenant: string): void {
		if (!this.#open) throw new Unavailable("admission is closed", this.#retryAfterMs);
		const reason = this.#suspended.get(tenant);
		if (reason !== undefined) throw new Unavailable(`tenant ${tenant} is suspended: ${reason}`);
	}

	#refuseQueued(tenant: string, q: Queue, why: string): void {
		const refused = q.pending.splice(0);
		for (const p of refused) p.reject(new Unavailable(why, this.#retryAfterMs));
		if (!q.running) this.#queues.delete(tenant);
	}

	#next(tenant: string, q: Queue): void {
		if (q.running) return;
		const p = q.pending.shift();
		if (!p) { this.#queues.delete(tenant); return; }
		// the gate is checked again when an operation leaves the queue, not only when it enters
		try { this.#check(tenant); }
		catch (e) { p.reject(e); this.#next(tenant, q); return; }
		q.running = true;
		this.#started++;
		const start = performance.now();
		void (async () => {
			try { p.resolve(await p.run()); }
			catch (e) { p.reject(e); }
			finally {
				this.#observe?.(start - p.at, performance.now() - start);
				q.running = false;
				if (--this.#started === 0) for (const r of this.#drained.splice(0)) r();
				this.#next(tenant, q);
			}
		})();
	}
}
