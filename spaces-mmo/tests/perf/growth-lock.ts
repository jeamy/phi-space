// How long one growth run holds the world lock (docs/3d-welt-und-raster-plan-2026-11-21.en.md section 3 "Performance
// strategy", acceptance case 6): the worst case of tests/growth-worst.ts (every room of the largest region full, every
// seam tried, none valid) in a space process, then GROWTH_RUNS growth runs of the TypeScript engine and, unless
// GROWTH_RUST=0, of the Rust engine (cargo test --release -p mmo-engine --test growth_cost, rust/mmo-engine/tests/growth_cost.rs)
// against the same space. Nothing grows, so every run finds the same store.
//
//   node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/growth-lock.ts
//   GROWTH_ROOMS=<n> rooms instead of the largest region's; SPACES_MMO_SPACE_SERVER=<binary> the Rust space server.
//
// Prints one JSON line: the fixture, per engine the wall time of each run (median, max) and, for TypeScript, the time the
// world lock was held per run (from its take to the commit or abort of that transaction, summed over the rooms) and the
// longest single hold; `readsOnlyMs` the median run with no room full enough (each room stops after its reads, so the
// difference to `runMs` is the seam search). The lock is taken once per room, so between two rooms other jobs and commands can take it.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { growthTick } from "../../server/engine/commands/growth.ts";
import { loadWorld } from "../../server/engine/world.ts";
import { initialClock } from "../../server/engine/worldtime.ts";
import { WORLD_LOCK } from "../../server/model.ts";
import { largestRegionRooms, writeWorstGrowth } from "../growth-worst.ts";
import { startStack } from "../stack.ts";

const RUNS = Number(process.env.GROWTH_RUNS ?? 5);
const w = await loadWorld();
const rooms = Number(process.env.GROWTH_ROOMS ?? largestRegionRooms(w));

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const round = (x: number) => Math.round(x * 10) / 10;

/** The space with every hold of the world lock timed: from the take inside a transaction to its commit or abort. */
function timedLock(space: SpaceLike, holds: number[]): SpaceLike {
	const since = new Map<string, number>();
	const end = (txn: string) => { const t = since.get(txn); if (t !== undefined) { holds.push(performance.now() - t); since.delete(txn); } };
	return new Proxy(space, {
		get(target, key, receiver) {
			const f = Reflect.get(target, key, receiver);
			if (typeof f !== "function") return f;
			if (key === "takeIfExists") return async (template: { type?: string }, ms: number, o?: { txn?: string }) => {
				const t = performance.now(), got = await f.call(target, template, ms, o);
				if (got && o?.txn && template.type === WORLD_LOCK.type) since.set(o.txn, t);
				return got;
			};
			if (key === "commit" || key === "abort") return async (txn: string, ...rest: unknown[]) => { try { return await f.call(target, txn, ...rest); } finally { end(txn); } };
			return f.bind(target);
		},
	});
}

const stack = await startStack({ worlds: 0 });
try {
	const s = stack.space;
	await s.write({ type: "WorldClock", fields: initialClock(w.id, 12, Date.now(), 1) as never }, null, FOREVER);
	const t0 = performance.now();
	const fixture = await writeWorstGrowth(s, w, rooms);
	const written = performance.now() - t0;

	const ts = { runs: [] as number[], held: [] as number[], longest: 0, grew: 0 };
	for (let i = 0; i < RUNS; i++) {
		const holds: number[] = [], t = performance.now();
		ts.grew += await growthTick(timedLock(s, holds), w, 60_000);
		ts.runs.push(performance.now() - t);
		ts.held.push(holds.reduce((a, b) => a + b, 0));
		ts.longest = Math.max(ts.longest, ...holds);
	}

	// the same with no room full enough: each room stops after its reads, so the rest of a run above is the search
	const readsOnly: number[] = [], notFull = { ...w, growth: { ...w.growth!, fullShare: 2 } };
	for (let i = 0; i < RUNS; i++) { const t = performance.now(); await growthTick(s, notFull, 60_000); readsOnly.push(performance.now() - t); }

	const cargo = (extra: Record<string, string>) => {
		const out = execFileSync("cargo", ["test", "--release", "-q", "-p", "mmo-engine", "--test", "growth_cost", "--", "--ignored", "--nocapture"], {
			cwd: join(import.meta.dirname, "../../rust"), env: { ...process.env, GROWTH_COST_SPACE: stack.world, GROWTH_COST_RUNS: String(RUNS), ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
		});
		const line = out.split("\n").find((l) => l.startsWith("growth_cost "));
		if (!line) throw new Error(`the Rust measurement printed no result:\n${out}`);
		return JSON.parse(line.slice("growth_cost ".length)) as { runs: number[]; grew: number };
	};
	const rust = process.env.GROWTH_RUST === "0" ? null : { ...cargo({}), readsOnly: cargo({ GROWTH_COST_READS_ONLY: "1" }).runs };

	console.log(JSON.stringify({
		space: process.env.SPACES_MMO_SPACE_SERVER ? "rust" : "ts",
		fixture: { rooms: fixture.rooms.length, size: `${fixture.width}x${fixture.height}`, plotsPerRoom: fixture.plots, freePerRoom: fixture.free, seamsPerRoom: fixture.candidates, writtenMs: Math.round(written) },
		ts: { runMs: { median: round(median(ts.runs)), max: round(Math.max(...ts.runs)) }, lockHeldMs: { median: round(median(ts.held)), max: round(Math.max(...ts.held)) }, longestHoldMs: round(ts.longest), readsOnlyMs: round(median(readsOnly)), grew: ts.grew },
		...(rust ? { rust: { runMs: { median: round(median(rust.runs)), max: round(Math.max(...rust.runs)) }, readsOnlyMs: round(median(rust.readsOnly)), grew: rust.grew } } : {}),
	}));
	if (ts.grew || rust?.grew) throw new Error("a room grew: the fixture is not the worst case");
} finally { await stack.close(); }
