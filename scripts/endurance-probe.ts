// Endurance probe of the own store (docs/umstellung-ohne-pi-durable.md, U7): producers and takers on several named
// spaces for a time, the store closed and reopened now and then, and at the end every produced item taken exactly once.
// Reports throughput, latency, RSS and file growth per interval, so a leak or a growing WAL shows.
//   node --experimental-strip-types --no-warnings scripts/endurance-probe.ts [seconds=600] [spaces=5] [reopenEverySeconds=60]
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT as ctx } from "../src/context.ts";
import { FOREVER, PhiSpaces, createSpace, openSqliteHost } from "../src/index.ts";
import type { OwnStoreHost } from "../src/store/host.ts";

const [seconds, spaces, reopenEvery] = [Number(process.argv[2] ?? 600), Number(process.argv[3] ?? 5), Number(process.argv[4] ?? 60)];
const dir = mkdtempSync(join(tmpdir(), "endurance-probe-")), path = join(dir, "store.sqlite");
const mb = (n: number) => Math.round(n / 1048576);
const size = (f: string) => (existsSync(f) ? statSync(f).size : 0);
const budget = process.env.PHI_BUDGET ? { memoryBudget: Number(process.env.PHI_BUDGET) } : {};
let h: OwnStoreHost = await openSqliteHost(path, budget);
for (let i = 0; i < spaces; i++) await h.commit((tx) => createSpace(tx, `s${i}`, Date.now()), ctx);
const sp = (i: number) => new PhiSpaces(h, ctx, Date.now, undefined, undefined, { space: `s${i}` });

const produced = new Set<string>(), taken = new Map<string, number>(), lat: number[] = [];
let seq = 0, stop = false, paused: Promise<void> | null = null, errors = 0;
const gate = async () => { while (paused) await paused; };
const producer = async (i: number) => {
	while (!stop) {
		await gate();
		const id = `s${i}:${seq++}`, t = performance.now();
		try { await sp(i).write({ type: "Job", fields: { id, pad: "x".repeat(200) } }, null, FOREVER); produced.add(id); lat.push(performance.now() - t); }
		catch (e) { if (!paused) { errors++; console.error("write failed:", (e as Error).message); } }
		if (produced.size - [...taken.values()].length > 2000) await new Promise((r) => setTimeout(r, 20)); // keep the backlog bounded
	}
};
const taker = async (i: number) => {
	while (!stop) {
		await gate();
		try {
			const e = await sp(i).take({ type: "Job" }, 200);
			if (e) { const id = (e.fields as { id: string }).id; taken.set(id, (taken.get(id) ?? 0) + 1); }
		} catch (e) { if (!paused) { errors++; console.error("take failed:", (e as Error).message); } }
	}
};
const workers = Array.from({ length: spaces }, (_, i) => [producer(i), producer(i), taker(i), taker(i)]).flat();

const start = performance.now();
let lastWritten = 0, lastReopen = performance.now();
const report = () => {
	const w = lat.splice(0).sort((a, b) => a - b), n = produced.size;
	console.log(JSON.stringify({ t: Math.round((performance.now() - start) / 1000), writtenPerS: Math.round((n - lastWritten) / 10), p50: Math.round(w[w.length >> 1] ?? 0), p95: Math.round(w[Math.floor(w.length * 0.95)] ?? 0), taken: taken.size, rssMb: mb(process.memoryUsage().rss), heapMb: mb(process.memoryUsage().heapUsed), fileMb: mb(size(path)), walMb: mb(size(`${path}-wal`)), cached: h.cached.weight }));
	lastWritten = n;
};
while (performance.now() - start < seconds * 1000) {
	await new Promise((r) => setTimeout(r, 10_000));
	report();
	if (performance.now() - lastReopen > reopenEvery * 1000) {
		let release!: () => void;
		paused = new Promise<void>((r) => (release = r));
		await new Promise((r) => setTimeout(r, 300)); // calls in flight finish
		await h.close(ctx); h = await openSqliteHost(path, budget);
		paused = null; release(); lastReopen = performance.now();
		console.log("reopened");
	}
}
stop = true;
await Promise.all(workers);
let left = 0;
for (let i = 0; i < spaces; i++) for (;;) { const e = await sp(i).take({ type: "Job" }, 0); if (!e) break; left++; const id = (e.fields as { id: string }).id; taken.set(id, (taken.get(id) ?? 0) + 1); }
const dup = [...taken.values()].filter((c) => c > 1).length, lost = [...produced].filter((id) => !taken.has(id)).length, phantom = [...taken.keys()].filter((id) => !produced.has(id)).length;
console.log(JSON.stringify({ produced: produced.size, taken: taken.size, drainedAtEnd: left, duplicates: dup, lost, unknownIds: phantom, errors, verdict: dup === 0 && lost === 0 && errors === 0 ? "PASSED" : "FAILED" }));
await h.close(ctx);
rmSync(dir, { recursive: true, force: true });
