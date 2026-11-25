// How long one growth run holds the world lock (docs/3d-welt-und-raster-plan-2026-11-21.en.md section 3 "Performance
// strategy", acceptance case 6): the worst case of tests/growth-worst.ts (every room of the largest region full, every
// seam tried, none valid) in a space process, then GROWTH_RUNS growth runs of the TypeScript engine and, unless
// GROWTH_RUST=0, of the Rust engine (cargo test --release -p mmo-engine --test growth_cost, rust/mmo-engine/tests/growth_cost.rs)
// against the same space. Nothing grows, so every run finds the same store. Since growth steps 2 and 3 (growth.ts: a room
// is decided on a view first, its decision kept by what it read) such a room takes no lock: a TypeScript run is measured
// with the kept decisions forgotten (`cold`, the decision on the view) and with them (`kept`), and with the revisions it
// sends to the change stream. GROWTH_GROWING samples (default 3) then add one room that grows each (its first row free):
// the hold of that room is what a run holds the lock for now.
//
//   node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/growth-lock.ts
//   GROWTH_ROOMS=<n> rooms instead of the largest region's; SPACES_MMO_SPACE_SERVER=<binary> the Rust space server;
//   GROWTH_RUST_BIN=<built growth_cost test binary> instead of cargo (where no cargo is, e.g. in a server's image).
//
// Prints one JSON line: the fixture, per engine the wall time of each run (median, max; Rust: the first run cold, the
// others kept, `coldMs` and `runMs`) and, for TypeScript, the time the
// world lock was held per run (from its take to the commit or abort of that transaction, summed over the rooms) and the
// longest single hold; `readsOnlyMs` the median run with no room full enough (each room stops after its reads, so the
// difference to `runMs` is the seam search). The lock is taken once per room, so between two rooms other jobs and commands can take it.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { forgetGrowth, growthTick } from "../../server/engine/commands/growth.ts";
import { loadWorld } from "../../server/engine/world.ts";
import { initialClock } from "../../server/engine/worldtime.ts";
import { largestRegionRooms, timedLock, worstOf, writeWorstGrowth } from "../growth-worst.ts";
import { startStack } from "../stack.ts";

const RUNS = Number(process.env.GROWTH_RUNS ?? 5), GROWING = Number(process.env.GROWTH_GROWING ?? 3);
const w = await loadWorld();
const rooms = Number(process.env.GROWTH_ROOMS ?? largestRegionRooms(w));

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const round = (x: number) => Math.round(x * 10) / 10;

const stack = await startStack({ worlds: 0 });
try {
	const s = stack.space;
	await s.write({ type: "WorldClock", fields: initialClock(w.id, 12, Date.now(), 1) as never }, null, FOREVER);
	const t0 = performance.now();
	const fixture = await writeWorstGrowth(s, w, rooms);
	const written = performance.now() - t0;

	const rev = async () => (await s.readPage({ type: "-" })).rev;
	const measure = async (forget: boolean) => {
		const out = { runs: [] as number[], held: [] as number[], revisions: [] as number[], longest: 0, grew: 0 };
		for (let i = 0; i < RUNS; i++) {
			const holds: number[] = [], timed = timedLock(s, holds), r0 = await rev();
			if (forget) forgetGrowth(timed);
			const t = performance.now();
			out.grew += await growthTick(timed, w, 60_000, s);
			out.runs.push(performance.now() - t);
			out.revisions.push((await rev()) - r0);
			out.held.push(holds.reduce((a, b) => a + b, 0));
			out.longest = Math.max(out.longest, ...holds);
		}
		return out;
	};
	const ts = await measure(true), kept = await measure(false);

	// the same with no room full enough: each room stops after its reads, so the rest of a run above is the search
	const readsOnly: number[] = [], notFull = { ...w, growth: { ...w.growth!, fullShare: 2 } };
	for (let i = 0; i < RUNS; i++) { const t = performance.now(); await growthTick(s, notFull, 60_000); readsOnly.push(performance.now() - t); }

	const cargo = (extra: Record<string, string>) => {
		const bin = process.env.GROWTH_RUST_BIN, args = ["--ignored", "--nocapture", "--exact", "growth_cost"];
		const out = execFileSync(bin ?? "cargo", bin ? args : ["test", "--release", "-q", "-p", "mmo-engine", "--test", "growth_cost", "--", ...args], {
			cwd: bin ? undefined : join(import.meta.dirname, "../../rust"), env: { ...process.env, GROWTH_COST_SPACE: stack.world, GROWTH_COST_RUNS: String(RUNS), GROWTH_COST_ROOT: join(import.meta.dirname, "../.."), ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
		});
		const line = out.split("\n").find((l) => l.startsWith("growth_cost "));
		if (!line) throw new Error(`the Rust measurement printed no result:\n${out}`);
		return JSON.parse(line.slice("growth_cost ".length)) as { runs: number[]; grew: number };
	};
	const rust = process.env.GROWTH_RUST === "0" ? null : { ...cargo({}), readsOnly: cargo({ GROWTH_COST_READS_ONLY: "1" }).runs };

	// rooms that grow: each sample one more room as full as the others with its first row free (its outermost seam
	// valid), so that run takes the locks for that room only and grows it
	const growing = { runs: [] as number[], held: [] as number[], longest: 0, revisions: [] as number[], grew: 0 };
	for (let i = 0; i < GROWING; i++) {
		const one = await writeWorstGrowth(s, w, 1, `grow-${i}`);
		for (let x = 0; x < one.width; x++) await s.takeIfExists({ type: "Footprint", fields: { room: one.rooms[0]!, of: worstOf(x, 0) } }, 0);
		const holds: number[] = [], timed = timedLock(s, holds), r0 = await rev(), t = performance.now();
		growing.grew += await growthTick(timed, w, 60_000, s);
		growing.runs.push(performance.now() - t);
		growing.revisions.push((await rev()) - r0);
		growing.held.push(holds.reduce((a, b) => a + b, 0));
		growing.longest = Math.max(growing.longest, ...holds);
	}

	console.log(JSON.stringify({
		space: process.env.SPACES_MMO_SPACE_SERVER ? "rust" : "ts",
		fixture: { rooms: fixture.rooms.length, size: `${fixture.width}x${fixture.height}`, plotsPerRoom: fixture.plots, freePerRoom: fixture.free, seamsPerRoom: fixture.candidates, writtenMs: Math.round(written) },
		ts: {
			cold: { runMs: { median: round(median(ts.runs)), max: round(Math.max(...ts.runs)) }, lockHeldMs: round(median(ts.held)), revisions: median(ts.revisions) },
			kept: { runMs: { median: round(median(kept.runs)), max: round(Math.max(...kept.runs)) }, lockHeldMs: round(median(kept.held)), revisions: median(kept.revisions) },
			readsOnlyMs: round(median(readsOnly)), grew: ts.grew + kept.grew,
		},
		...(rust ? { rust: { coldMs: round(rust.runs[0]!), runMs: { median: round(median(rust.runs.slice(1))), max: round(Math.max(...rust.runs.slice(1))) }, readsOnlyMs: round(median(rust.readsOnly)), grew: rust.grew } } : {}),
		growing: { runMs: round(median(growing.runs)), lockHeldMs: round(median(growing.held)), longestHoldMs: round(growing.longest), revisions: median(growing.revisions), grew: growing.grew },
	}));
	if (ts.grew || kept.grew || rust?.grew) throw new Error("a room grew: the fixture is not the worst case");
	if (growing.grew !== GROWING) throw new Error(`${growing.grew} of ${GROWING} growing rooms grew`);
} finally { await stack.close(); }
