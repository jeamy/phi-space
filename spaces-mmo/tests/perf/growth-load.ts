// The world lock of a growth run while players play (docs/3d-welt-und-raster-plan-2026-11-21.en.md acceptance case 6:
// "while players build"), and the commits of the server-driven movers beside them. A stack as on the servers, with the
// world loaded (one world worker, one npc process without model calls, the web process) and the worst case of
// tests/growth-worst.ts written beside the world's rooms. Four windows of GROWTH_LOAD_SECONDS (default 60) each:
//   idle          growth runs, no players;
//   load          LOAD_BOTS (default 50) guest figures of tests/perf/live-load.ts playing over the web process (they pick
//                 up, carry, sell and walk through exits; they do not build), no growth runs;
//   load+growth   the same figures and growth runs;
//   load again    the figures alone once more: how far their answers drift over the windows.
// A growth run of the TypeScript engine every GROWTH_GAP_MS (default 2000; the world worker runs one each world hour,
// at the clock rate 24 of the servers every 150 s per region, so this samples many runs, it is not the production cadence), timed as in growth-lock.ts. The Rust engine is measured on the
// fixture alone (growth-lock.ts): this script cannot see how far its runs get.
//
// Every command reads the world lock in its transaction (world-host.ts), and growth takes it without waiting: while a
// command is open a growth run stops ("a busy world defers growth"), and while growth holds a room the commands wait.
// So under load what counts is how far a run gets (rooms reached) and how long a single hold makes the commands wait:
// in the window with growth the answers are split into the commands sent while a run was open and the others.
// Since growth steps 2 and 3 a room without a step takes no lock (growth.ts decides on a view first), so the worst
// case alone reaches no room at all. In each window with growth one room with a step therefore waits beside it
// (GROWTH_GROWING, default 1, rooms one after the other per window; 0 leaves them out, as phase 0 measured): as full as
// the others, its first row free, the next written once the last one grew. More than a few make the store heavier
// window by window (each a full room with its footprints). `refused` counts the takes a run was refused, by type.
// Whether a busy region's rooms still grow in time is how many runs and how long such a room waits until it grew.
//
//   node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/growth-load.ts
//   SPACES_MMO_SPACE_SERVER, SPACES_MMO_WORLD_CMD, SPACES_MMO_NPC_CMD, SPACES_MMO_WEB_CMD: the Rust processes.
//
// Prints one JSON line per window: the growth runs (median and max of run time and lock time, rooms reached of all, the
// longest single hold), the players' answer times (p50, p95, p99 of the commands sent in the window; with growth also
// those sent during a run and outside one), the rooms with a step (how many grew, the runs and ms each waited, the lock
// held by the run that grew it, one waiting still at the window's end), the commits in the window and per second, and
// the commits that moved an NPC character.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteSpace } from "phi-spaces";
import { growthTick } from "../../server/engine/commands/growth.ts";
import { isInterior } from "../../server/engine/commands/interior.ts";
import { loadWorld } from "../../server/engine/world.ts";
import { largestRegionRooms, timedLock, worstOf, writeWorstGrowth } from "../growth-worst.ts";
import { startStack } from "../stack.ts";

const SECONDS = Number(process.env.GROWTH_LOAD_SECONDS ?? 60), GAP = Number(process.env.GROWTH_GAP_MS ?? 2000);
const BOTS = Number(process.env.LOAD_BOTS ?? 50), GROWING = Number(process.env.GROWTH_GROWING ?? 1);
const w = await loadWorld();
const rooms = Number(process.env.GROWTH_ROOMS ?? largestRegionRooms(w));
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))]! : 0; };
const median = (xs: number[]) => quantile(xs, 0.5);
const round = (x: number) => Math.round(x * 10) / 10;

const stack = await startStack();
const out = await mkdtemp(join(tmpdir(), "mmo-growth-load-"));
const s = stack.space as unknown as RemoteSpace;

/** Follows the change stream from revision `from` while the window runs (the log is bounded and drops old batches
 *  under load), counting the commits that put an NPC character (charId npc-…); null when it fell behind. */
function npcMoves(from: number): { stop(to: number): Promise<number | null> } {
	let after = from, n = 0, until = Infinity, lost = false;
	const run = (async () => {
		while (after < until) {
			let ch;
			try { ch = await s.changes(after, { maxBytes: 200 * 1024, waitMs: 500 }); } catch { lost = true; return; }
			for (const b of ch.batches) if (b.rev <= until && b.ops.some((o) => o.op === "put" && o.type === "Character" && String(o.fields.charId).startsWith("npc-"))) n++;
			if (ch.batches.length) after = ch.next;
		}
	})();
	return { async stop(to) { until = to; await run; return lost ? null : n; } };
}

async function window(name: string, growth: boolean, bots: number): Promise<void> {
	const all = (await s.readAll({ type: "Room" })).filter((r) => !isInterior(String(r.fields.roomId))).length;
	const from = (await s.statsWithRevision()).rev, t0 = performance.now(), wall0 = Date.now(), moves = npcMoves(from);
	const runs: number[] = [], held: number[] = [], reached: number[] = [], open: Array<[number, number]> = [];
	let longest = 0, grew = 0, pending: { at: number; runs: number } | null = null, n = 0;
	const refused: Record<string, number> = {};
	const grown = { latencyMs: [] as number[], runs: [] as number[], held: [] as number[], longest: 0 };
	while (performance.now() - t0 < SECONDS * 1000) {
		if (growth) {
			if (n < GROWING && !pending) { // a room with a step, waiting to grow
				const one = await writeWorstGrowth(s, w, 1, `grow-${name.replace(/\W/g, "")}-${n++}`);
				for (let x = 0; x < one.width; x++) await s.takeIfExists({ type: "Footprint", fields: { room: one.rooms[0]!, of: worstOf(x, 0) } }, 0);
				pending = { at: performance.now(), runs: 0 };
			}
			const holds: number[] = [], t = performance.now(), wall = Date.now();
			const g = await growthTick(timedLock(s, holds, refused), w, 60_000);
			grew += g;
			runs.push(performance.now() - t);
			open.push([wall, Date.now()]);
			held.push(holds.reduce((a, b) => a + b, 0));
			reached.push(holds.length);
			longest = Math.max(longest, ...holds);
			if (pending) {
				pending.runs++;
				if (g) { grown.latencyMs.push(performance.now() - pending.at); grown.runs.push(pending.runs); grown.held.push(holds.reduce((a, b) => a + b, 0)); grown.longest = Math.max(grown.longest, ...holds); pending = null; }
			}
		}
		await sleep(GAP);
	}
	const to = (await s.statsWithRevision()).rev, seconds = (performance.now() - t0) / 1000, wall1 = Date.now();
	const sent = bots ? (await readFile(join(out, "commands.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { at: number; ms: number }).filter((c) => c.at >= wall0 && c.at < wall1) : [];
	const during = (at: number) => open.some(([a, b]) => at >= a && at < b);
	const stats = (ms: number[]) => ({ commands: ms.length, p50: quantile(ms, 0.5), p95: quantile(ms, 0.95), p99: quantile(ms, 0.99) });
	const answers = sent.map((c) => c.ms);
	console.log(JSON.stringify({
		window: name, bots, seconds: Math.round(seconds),
		...(growth ? { ts: { runs: runs.length, runMs: { median: round(median(runs)), max: round(Math.max(...runs)) }, lockHeldMs: { median: round(median(held)), max: round(Math.max(...held)) }, roomsReached: { median: median(reached), min: Math.min(...reached), of: all }, completeRuns: reached.filter((n) => n >= all).length, longestHoldMs: round(longest), grew, refused }, ...(GROWING ? { growing: { grown: grown.runs.length, waiting: pending ? { runs: pending.runs, ms: Math.round(performance.now() - pending.at) } : null, runsUntilGrown: { median: median(grown.runs), max: Math.max(0, ...grown.runs) }, msUntilGrown: { median: Math.round(median(grown.latencyMs)), max: Math.round(Math.max(0, ...grown.latencyMs)) }, lockHeldMs: round(median(grown.held)), longestHoldMs: round(grown.longest) } } : {}) } : {}),
		...(bots ? { answers: { all: stats(answers), ...(growth ? { duringRun: stats(sent.filter((c) => during(c.at)).map((c) => c.ms)), outsideRun: stats(sent.filter((c) => !during(c.at)).map((c) => c.ms)) } : {}) } } : {}),
		commits: to - from, perSecond: round((to - from) / seconds), npcMoves: await moves.stop(to),
	}));
	if (grew !== (GROWING ? grown.runs.length : 0)) throw new Error(`${grew} rooms grew, ${grown.runs.length} of them the waiting room: the fixture is not the worst case`);
}

try {
	await stack.npcProcess({ SPACES_MMO_LLM: "" });
	const web = await stack.webProcess();
	await writeWorstGrowth(s, w, rooms);
	await window("idle", true, 0);
	const load = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", join(import.meta.dirname, "live-load.ts")], {
		env: { ...process.env, LOAD_URL: web.url, LOAD_BOTS: String(BOTS), LOAD_SECONDS: String(3 * SECONDS + 60), LOAD_OUT: out }, stdio: ["ignore", "pipe", "inherit"],
	});
	const ended = new Promise<void>((ok) => load.on("exit", () => ok()));
	await new Promise<void>((ok, fail) => {
		load.stdout!.on("data", (d: Buffer) => { if (/figures joined/.test(String(d))) ok(); });
		load.on("exit", (code) => fail(new Error(`live-load ended before its figures joined (${code})`)));
	});
	await sleep(10_000); // the figures are under way
	await window("load", false, BOTS);
	await window("load+growth", true, BOTS);
	await window("load again", false, BOTS); // how far the answers drift without growth
	load.kill("SIGINT");
	await ended;
} finally { await stack.close(); await rm(out, { recursive: true, force: true }); }
