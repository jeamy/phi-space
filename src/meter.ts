// Process-local counters and sliding-window rates. Not stored in the space document on purpose: a read does not
// change the space, and counting it there would turn every read into a document change that wakes every waiter.
import type { Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { Space } from "./doc.ts";
import * as core from "./core.ts";

/** `events`: delivered; `failures`: events never delivered (target gone, or given up); `retries`: failed attempts. */
export type Counter = "writes" | "reads" | "takes" | "misses" | "events" | "failures" | "retries";
export const COUNTERS: readonly Counter[] = ["writes", "reads", "takes", "misses", "events", "failures", "retries"];

const SLOTS = 300; // seconds of history kept

export class Meter {
	private totals = new Map<Counter, number>();
	private ring = new Map<Counter, { t: number; c: number }[]>();
	private started: number;
	private now: () => number;
	constructor(now: () => number = Date.now) {
		this.now = now;
		this.started = now();
	}

	inc(name: Counter, n = 1): void {
		const t = Math.floor(this.now() / 1000);
		this.totals.set(name, (this.totals.get(name) ?? 0) + n);
		let r = this.ring.get(name);
		if (!r) this.ring.set(name, (r = Array.from({ length: SLOTS }, () => ({ t: -1, c: 0 }))));
		const b = r[t % SLOTS]!;
		if (b.t !== t) { b.t = t; b.c = 0; } // a slot from SLOTS seconds ago: reuse
		b.c += n;
	}

	total(name: Counter): number { return this.totals.get(name) ?? 0; }

	/**
	 * Events per second over the last `windowSec` completed seconds (at most SLOTS - 1). The running second is left out:
	 * it is only partly over, and counting it as a full second under-reports (by up to 1/windowSec, and a 1 s window
	 * would read ~0 at every second's start). The price is up to 1 s of lag. Divides by the time those seconds actually
	 * covered since the meter started, so a fresh meter does not under-report either.
	 */
	rate(name: Counter, windowSec = 10): number {
		const r = this.ring.get(name);
		if (!r) return 0;
		const t = Math.floor(this.now() / 1000); // the running second
		const w = Math.min(Math.max(1, Math.floor(Number.isFinite(windowSec) ? windowSec : 10)), SLOTS - 1);
		const coveredMs = t * 1000 - Math.max((t - w) * 1000, this.started);
		if (coveredMs <= 0) return 0; // no completed second yet
		let sum = 0;
		for (const b of r) if (b.t >= t - w && b.t < t) sum += b.c;
		return sum / (coveredMs / 1000);
	}

	snapshot(windowSec = 10): MeterSnapshot {
		const totals = {} as Record<Counter, number>, rates = {} as Record<Counter, number>;
		for (const c of COUNTERS) { totals[c] = this.total(c); rates[c] = this.rate(c, windowSec); }
		return { totals, rates, windowSec };
	}

	reset(): void { this.totals.clear(); this.ring.clear(); this.started = this.now(); }
}
export type MeterSnapshot = { totals: Record<Counter, number>; rates: Record<Counter, number>; windowSec: number };

/** The meter the client and tools count into by default: one per process, like the harness that owns the space. */
export const meter = new Meter();

export type Live = { gauges: core.SpaceStats; meter: MeterSnapshot };

/** One status line, e.g. `space 12 entries · 2 txn · 3 waiting · w4.0/s r9.1/s t3.0/s`. */
export function formatStatus(l: Live): string {
	const g = l.gauges, r = l.meter.rates;
	const f = (n: number) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1));
	const parts = [`${g.entries} entries`];
	if (g.txns) parts.push(`${g.txns} txn`);
	if (g.waiters) parts.push(`${g.waiters} waiting`);
	if (g.outbox) parts.push(`${g.outbox} queued`);
	return `space ${parts.join(" · ")} · w${f(r.writes)}/s r${f(r.reads)}/s t${f(r.takes)}/s`;
}

/** Multi-line version for a widget: gauges, per-type counts, rates and totals. */
export function formatWidget(l: Live): string[] {
	const g = l.gauges, r = l.meter.rates, t = l.meter.totals;
	const types = Object.entries(g.byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
	return [
		`space: ${g.entries} entries${types ? ` (${types})` : ""}, ${g.locked} locked, ${g.uncommitted} uncommitted, ${g.expired} expired, ${g.returned} returned`,
		`       ${g.txns} txn, ${g.waiters} waiting, ${g.registrations} subscriptions, ${g.outbox} queued`,
		`rates (${l.meter.windowSec}s): write ${r.writes.toFixed(1)}/s  read ${r.reads.toFixed(1)}/s  take ${r.takes.toFixed(1)}/s  miss ${r.misses.toFixed(1)}/s`,
		`total: ${t.writes} written, ${t.reads} read, ${t.takes} taken, ${t.events} events, ${t.failures} undeliverable, ${t.retries} retries`,
	];
}

/**
 * Sample gauges (a snapshot, no commit, nobody is woken) and rates every `intervalMs`. Returns a stop function.
 * One sample at a time (a slow snapshot skips ticks instead of overlapping, so an older state never follows a newer
 * one), nothing is reported after stop(), and an error thrown by `cb` goes to `onError` instead of vanishing.
 */
export function watchLive(harness: Harness, ctx: Context, cb: (l: Live) => void, o: { intervalMs?: number; windowSec?: number; meter?: Meter; now?: () => number; onError?: (e: unknown) => void } = {}): () => void {
	const m = o.meter ?? meter;
	const now = o.now ?? Date.now;
	const onError = o.onError ?? ((e) => console.error("phi-spaces live:", e));
	let stopped = false;
	let busy = false;
	const sample = async () => {
		if (stopped || busy) return;
		busy = true;
		try {
			let s;
			try { s = await harness.snapshot(Space, ctx); } catch { return; } // the harness may be closing; the next tick or stop() ends it
			if (stopped) return;
			try { cb({ gauges: core.stats(s ?? core.initialState(), now()), meter: m.snapshot(o.windowSec ?? 10) }); } catch (e) { onError(e); }
		} finally {
			busy = false;
		}
	};
	const timer = setInterval(() => void sample(), o.intervalMs ?? 1000);
	timer.unref?.();
	void sample();
	return () => { stopped = true; clearInterval(timer); };
}
