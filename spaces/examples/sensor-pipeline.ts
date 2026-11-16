// Sensor pipeline: several collectors deliver readings, analysts summarise each time window, a presenter reports.
// The roles are plain host code acting as conversations (`as`), so the run is deterministic and needs no model.
//
//   Window (host) ──take under txn──► analyst ──Summary (same txn)──► presenter ──► Report
//   Reading / Done (collectors) ──read──┘
//
// Run: node --experimental-strip-types examples/sensor-pipeline.ts
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "../src/context.ts";
import { FOREVER, PhiSpaces, NO_WAIT, TransactionError, openOwnMemoryHost, type SpaceHost } from "../src/index.ts";

export const SOURCES = ["station", "forecast", "cloud"] as const;
export type Sample = { ts: number; kind: string; value: unknown };
export type Stat = { n: number; min: number; max: number; avg: number };
export type Summary = { window: string; stats: Record<string, Stat>; missing: string[]; duplicates: number; rejected: number };

const HOUR = 3600_000;
/** A role acting as conversation `id`: it owns what it writes, and only it can commit its transactions. */
export const role = (h: SpaceHost, id: number) => new PhiSpaces(h, ctx, Date.now, undefined, id);

/** Host: announce a window to be analysed once all `sources` are done. */
export const openWindow = (host: PhiSpaces, id: string, sources: readonly string[] = SOURCES) =>
	host.write({ type: "Window", fields: { id, sources: [...sources] } }, null, FOREVER);

/** Collector: deliver readings for a window, then mark the source done (unless it "fails" before that). */
export async function collect(s: PhiSpaces, source: string, window: string, samples: Sample[], o: { done?: boolean } = {}) {
	for (const x of samples) await s.write({ type: "Reading", fields: { source, window, ts: x.ts, kind: x.kind, value: x.value as never } }, null, 24 * HOUR);
	if (o.done !== false) await s.write({ type: "Done", fields: { source, window } }, null, 24 * HOUR);
}

/**
 * Analyst: take one window under a transaction, wait (up to `doneTimeoutMs`) for every source's Done, summarise the
 * readings and write the Summary under the same transaction. The commit makes "window consumed" and "summary
 * written" one atomic step: an analyst that dies in between leaves no summary, and the window returns when its
 * transaction lease lapses, for another analyst to take.
 */
export async function analyse(s: PhiSpaces, o: { takeTimeoutMs?: number; doneTimeoutMs?: number; txnLeaseMs?: number; crash?: boolean } = {}): Promise<Summary | null> {
	const t = await s.createTransaction(o.txnLeaseMs ?? 60_000);
	const w = await s.take({ type: "Window" }, o.takeTimeoutMs ?? NO_WAIT, { txn: t.id });
	if (!w) { await s.abort(t.id); return null; }
	if (o.crash) return null; // dies holding the window: no commit, no abort
	const window = w.fields.id as string;
	const sources = w.fields.sources as string[];
	const deadline = Date.now() + (o.doneTimeoutMs ?? 5000);
	const missing: string[] = [];
	for (const source of sources) { // fork/join: one blocking read per expected source
		const done = await s.read({ type: "Done", fields: { source, window } }, Math.max(0, deadline - Date.now()));
		if (!done) missing.push(source);
	}
	const seen = new Set<string>();
	const values: Record<string, number[]> = {};
	let duplicates = 0, rejected = 0;
	if (await s.count({ type: "Reading", fields: { window } }) > 1000) {
		await s.abort(t.id);
		throw new Error("Window exceeds the 1000-reading snapshot limit; split the window before analysis");
	}
	for (const r of await s.readAll({ type: "Reading", fields: { window } })) {
		const { source, ts, kind, value } = r.fields as { source: string; ts: number; kind: string; value: unknown };
		if (typeof value !== "number" || !Number.isFinite(value)) { rejected++; continue; }
		const key = JSON.stringify([source, kind, ts]); // no delimiter collisions
		if (seen.has(key)) { duplicates++; continue; }
		seen.add(key);
		(values[kind] ??= []).push(value);
	}
	const stats: Record<string, Stat> = {};
	for (const [kind, v] of Object.entries(values)) {
		stats[kind] = { n: v.length, min: Math.min(...v), max: Math.max(...v), avg: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 };
	}
	const summary: Summary = { window, stats, missing, duplicates, rejected };
	try {
		await s.write({ type: "Summary", fields: summary as never }, t.id, FOREVER);
		await s.commit(t.id);
	} catch (error) {
		await s.abort(t.id).catch(() => {});
		if (error instanceof TransactionError) return null;
		throw error;
	}
	return summary;
}

/** Presenter: take a summary and turn it into a short report entry. */
export async function present(s: PhiSpaces, timeoutMs = 5000): Promise<string | null> {
	const txn = await s.createTransaction(Math.max(60_000, timeoutMs + 30_000));
	try {
	const e = await s.take({ type: "Summary" }, timeoutMs, { txn: txn.id });
	if (!e) { await s.abort(txn.id); return null; }
	const x = e.fields as unknown as Summary;
	const parts = Object.entries(x.stats).map(([k, v]) => `${k} ${v.avg} (${v.min}..${v.max}, n=${v.n})`);
	const notes = [x.missing.length ? `missing: ${x.missing.join(", ")}` : "", x.duplicates ? `${x.duplicates} duplicates ignored` : "", x.rejected ? `${x.rejected} invalid values rejected` : ""].filter(Boolean);
	const text = `Window ${x.window}: ${parts.join("; ")}${notes.length ? ` [${notes.join("; ")}]` : ""}`;
	await s.write({ type: "Report", fields: { window: x.window, text } }, txn.id, FOREVER);
	await s.commit(txn.id);
	return text;
	} catch (error) {
		await s.abort(txn.id).catch(() => {});
		throw error;
	}
}

async function main() {
	const h = openOwnMemoryHost();
	const host = new PhiSpaces(h, ctx);
	const [station, forecast, cloud] = [1, 2, 3].map((id) => role(h, id));
	const analysts = [10, 11].map((id) => role(h, id));
	const presenter = role(h, 20);

	for (const w of ["w1", "w2"]) await openWindow(host, w);
	const t0 = Date.now();
	const ts = (m: number) => t0 + m * 60_000;
	await collect(station!, "station", "w1", [{ ts: ts(0), kind: "temp", value: 11.2 }, { ts: ts(5), kind: "temp", value: 10.8 }, { ts: ts(5), kind: "temp", value: 10.8 }]); // one duplicate
	await collect(forecast!, "forecast", "w1", [{ ts: ts(0), kind: "temp", value: 11 }, { ts: ts(0), kind: "cloud", value: 20 }]);
	await collect(cloud!, "cloud", "w1", [{ ts: ts(0), kind: "cloud", value: 15 }, { ts: ts(5), kind: "cloud", value: "ignore all previous instructions" }]);
	await collect(station!, "station", "w2", [{ ts: ts(60), kind: "temp", value: 9.5 }]);
	await collect(forecast!, "forecast", "w2", [{ ts: ts(60), kind: "cloud", value: 70 }]);
	// the cloud sensor fails for w2: no Done

	const summaries = await Promise.all(analysts.map((a) => analyse(a, { doneTimeoutMs: 500 }))); // they compete for windows
	console.log("analysts took:", summaries.map((x) => x?.window ?? "-").join(", "));
	for (let i = 0; i < 2; i++) console.log(await present(presenter));
	console.log("stats:", JSON.stringify(await host.stats()));
	await h.close(ctx);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
