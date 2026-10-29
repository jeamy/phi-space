// The dashboard's long statistics (docs/dashboard.md "Verlauf"): the polls of every app folded into one point per minute
// (the mean of its polls), kept for a week and, with a file, appended there so a restart loses at most the open minute.
// The file is one JSON line per minute and app; it is rewritten without the lapsed lines when it opens and every few hours.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type HistoryPoint = { at: number } & Record<string, number | null>;

export const HISTORY_KEEP_MS = 7 * 24 * 3600_000;
const MINUTE = 60_000;
const REWRITE_MS = 6 * 3600_000;

type Open = { minute: number; sums: Map<string, number>; counts: Map<string, number> };

export class StatsHistory {
	readonly #file: string | null;
	readonly #now: () => number;
	readonly #keepMs: number;
	readonly #done = new Map<string, HistoryPoint[]>();
	readonly #open = new Map<string, Open>();
	#rewritten = 0;

	constructor(o: { file?: string | null; now?: () => number; keepMs?: number } = {}) {
		this.#file = o.file ?? null;
		this.#now = o.now ?? Date.now;
		this.#keepMs = o.keepMs ?? HISTORY_KEEP_MS;
		if (this.#file && existsSync(this.#file)) {
			for (const line of readFileSync(this.#file, "utf8").split("\n")) {
				if (!line) continue;
				try {
					const { app, ...p } = JSON.parse(line) as HistoryPoint & { app: string };
					if (typeof app === "string" && typeof p.at === "number") this.#list(app).push(p as HistoryPoint);
				} catch { /* a line cut by a crash */ }
			}
			for (const list of this.#done.values()) list.sort((a, b) => a.at - b.at);
		}
		this.#prune();
	}

	#list(app: string): HistoryPoint[] {
		let l = this.#done.get(app);
		if (!l) this.#done.set(app, l = []);
		return l;
	}

	/** One poll of an app: its numbers go into the minute it falls in; a new minute closes the one before. */
	add(app: string, point: { at: number } & Record<string, number | null>): void {
		const minute = Math.floor(point.at / MINUTE) * MINUTE;
		let o = this.#open.get(app);
		if (o && o.minute !== minute) { this.#close(app, o); o = undefined; }
		if (!o) this.#open.set(app, o = { minute, sums: new Map(), counts: new Map() });
		for (const [k, v] of Object.entries(point)) {
			if (k === "at" || typeof v !== "number" || !Number.isFinite(v)) continue;
			o.sums.set(k, (o.sums.get(k) ?? 0) + v);
			o.counts.set(k, (o.counts.get(k) ?? 0) + 1);
		}
	}

	#close(app: string, o: Open): void {
		this.#open.delete(app);
		const p: HistoryPoint = { at: o.minute + MINUTE / 2 };
		for (const [k, s] of o.sums) p[k] = Math.round((s / o.counts.get(k)!) * 10) / 10;
		this.#list(app).push(p);
		if (this.#file) {
			try { appendFileSync(this.#file, `${JSON.stringify({ app, ...p })}\n`); }
			catch (e) { console.error(`[dashboard] history ${this.#file}: ${e instanceof Error ? e.message : String(e)}`); }
		}
		if (this.#now() - this.#rewritten > REWRITE_MS) this.#prune();
	}

	/** Drops what is older than the week and rewrites the file with what is left. */
	#prune(): void {
		const since = this.#now() - this.#keepMs;
		for (const [app, list] of this.#done) {
			const i = list.findIndex((p) => p.at >= since);
			if (i !== 0) list.splice(0, i < 0 ? list.length : i);
			if (!list.length) this.#done.delete(app);
		}
		this.#rewritten = this.#now();
		if (!this.#file) return;
		try {
			const tmp = `${this.#file}.tmp`;
			writeFileSync(tmp, [...this.#done].flatMap(([app, list]) => list.map((p) => `${JSON.stringify({ app, ...p })}\n`)).join(""));
			renameSync(tmp, this.#file);
		} catch (e) { console.error(`[dashboard] history ${this.#file}: ${e instanceof Error ? e.message : String(e)}`); }
	}

	/** The minutes of an app within `rangeMs` before now, oldest first. */
	minutes(app: string, rangeMs: number): HistoryPoint[] {
		const since = this.#now() - rangeMs;
		return (this.#done.get(app) ?? []).filter((p) => p.at >= since);
	}
}

/** At most `max` points: neighbours merged into their mean; a pause longer than three steps (the dashboard was down,
 *  the app offline) becomes a point without values, so the curve breaks there instead of bridging it. */
export function thin(points: readonly HistoryPoint[], max: number): HistoryPoint[] {
	const k = Math.max(1, Math.ceil(points.length / max));
	const merged: HistoryPoint[] = [];
	for (let i = 0; i < points.length; i += k) {
		const group = points.slice(i, i + k);
		const p: HistoryPoint = { at: Math.round(group.reduce((s, x) => s + x.at, 0) / group.length) };
		const keys = new Set(group.flatMap((x) => Object.keys(x)));
		for (const key of keys) {
			if (key === "at") continue;
			const vals = group.map((x) => x[key]).filter((v): v is number => typeof v === "number");
			p[key] = vals.length ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
		}
		merged.push(p);
	}
	const gap = Math.max(3 * k * MINUTE, 3 * MINUTE);
	const out: HistoryPoint[] = [];
	for (const p of merged) {
		const prev = out.at(-1);
		if (prev && p.at - prev.at > gap) out.push({ at: prev.at + 1 });
		out.push(p);
	}
	return out;
}
