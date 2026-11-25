// Counters (docs/zanzibar-agent-filesystem-plan.en.md, phase 5: health reporting, counters; the workload fixture
// records queue wait, operation latency and evaluator work): process-wide, in memory, reset by a restart. They hold
// operation names, error codes and times only, never a path, an actor, a tenant's content or a handle.

/** Upper bounds of the time buckets, in milliseconds; the last bucket is unbounded. */
export const BUCKETS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000] as const;

export type HistogramView = { count: number; sumMs: number; maxMs: number; buckets: Array<{ leMs: number | null; count: number }>; p50Ms: number | null; p99Ms: number | null };

export class Histogram {
	readonly #counts = new Array<number>(BUCKETS_MS.length + 1).fill(0);
	#n = 0;
	#sum = 0;
	#max = 0;
	add(ms: number): void {
		const v = Math.max(0, ms);
		let i = BUCKETS_MS.findIndex((b) => v <= b);
		if (i < 0) i = BUCKETS_MS.length;
		this.#counts[i]++;
		this.#n++; this.#sum += v; if (v > this.#max) this.#max = v;
	}
	/** The bucket bound at or above the quantile (an upper estimate), or the maximum in the last bucket. */
	#quantile(q: number): number | null {
		if (this.#n === 0) return null;
		const want = Math.ceil(q * this.#n);
		let seen = 0;
		for (let i = 0; i < this.#counts.length; i++) {
			seen += this.#counts[i];
			if (seen >= want) return round(i < BUCKETS_MS.length ? Math.min(BUCKETS_MS[i], this.#max) : this.#max);
		}
		return this.#max;
	}
	view(): HistogramView {
		return {
			count: this.#n, sumMs: round(this.#sum), maxMs: round(this.#max),
			buckets: this.#counts.map((count, i) => ({ leMs: i < BUCKETS_MS.length ? BUCKETS_MS[i] : null, count })),
			p50Ms: this.#quantile(0.5), p99Ms: this.#quantile(0.99),
		};
	}
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Evaluator work across every decision of this process: decisions made, lookups charged, the most one decision used. */
export const evaluator = { decisions: 0, lookups: 0, maxPerDecision: 0 };

export class Metrics {
	readonly started = Date.now();
	readonly queueWait = new Histogram();
	readonly queueRun = new Histogram();
	readonly #ops = new Map<string, { latency: Histogram; errors: Map<string, number> }>();
	refusedAtGate = 0;

	/** One adapter call: its operation name, how long it took, and its public error code if it failed. */
	op(name: string, ms: number, errorCode: string | null): void {
		let o = this.#ops.get(name);
		if (!o) { o = { latency: new Histogram(), errors: new Map() }; this.#ops.set(name, o); }
		o.latency.add(ms);
		if (errorCode !== null) o.errors.set(errorCode, (o.errors.get(errorCode) ?? 0) + 1);
	}

	snapshot(): { uptimeMs: number; queueWait: HistogramView; queueRun: HistogramView; refusedAtGate: number; evaluator: typeof evaluator; ops: Record<string, { latency: HistogramView; errors: Record<string, number> }> } {
		const ops: Record<string, { latency: HistogramView; errors: Record<string, number> }> = {};
		for (const [k, v] of [...this.#ops].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) ops[k] = { latency: v.latency.view(), errors: Object.fromEntries(v.errors) };
		return { uptimeMs: Date.now() - this.started, queueWait: this.queueWait.view(), queueRun: this.queueRun.view(), refusedAtGate: this.refusedAtGate, evaluator: { ...evaluator }, ops };
	}
}
