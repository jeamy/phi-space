// The grid migration of the codemode-chat Space (server/migrate-grid.ts): the cells of scale 1 become what a judge at
// scale 2 would have written, the memory's ids and freezes follow, and what it cannot convert refuses it before a write.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { FOREVER, NO_WAIT } from "phi-spaces";
import { frozenMemory, memoryIdOf, observationIdOf, remember } from "../server/memory.ts";
import { migrateGrid } from "../server/migrate-grid.ts";
import type { ChanceSeen, TideSeen } from "../server/toyisland.ts";
import type { PathStep } from "../server/bottask.ts";
import { startStack } from "./stack.ts";

const TTL = 3600_000, S = "s1", B = "b1";
const path: PathStep[] = [["graue-bucht", 3, 4], ["graue-bucht", 9, 4], ["graue-bucht", 9, 10]];
const path2: PathStep[] = [["graue-bucht", 12, 2], ["graue-bucht", 12, 9]];
const fields = (f: object) => f as never;

/** A landing and a day of the chance tide as a judge logs them, at `scale` (a process of its own: the scale is read once). */
function observations(scale: number): { tide: TideSeen; day: ChanceSeen; tideId: string; dayId: string } {
	const code = `
		import { chanceDay, genIsland, tideLanding, fromFire } from "./server/toyisland.ts";
		import { observationIdOf } from "./server/memory.ts";
		const w = genIsland(3);
		let l = null, seed = 0, j = 0;
		for (seed = 1; !l; seed++) for (j = 0; j < 8 && !l; j++) l = tideLanding(w, seed, j);
		const tide = { island: w.id, seed: seed - 1, piece: j - 1, minute: l.minute, room: l.room, x: l.x, y: l.y, exits: Object.keys(w.rooms[l.room].exits).sort(), fromFire: fromFire(w, l.room) };
		const day = chanceDay(w, 5);
		console.log(JSON.stringify({ tide, day, tideId: observationIdOf(tide), dayId: observationIdOf(day) }));`;
	return JSON.parse(execFileSync(process.execPath, ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", code], { cwd: new URL("..", import.meta.url), env: { ...process.env, CODEMODE_GRID_SCALE: String(scale) } }).toString());
}

test("the migration doubles the stored cells, computes the memory's ids anew and keeps its freezes", async () => {
	const one = observations(1), two = observations(2);
	assert.equal(two.tide.x, one.tide.x * 2, "a landing at scale 2 is the cell point of its cell at scale 1");
	const stack = await startStack({ judges: [], agents: false, model: false });
	try {
		const sp = stack.space;
		const mem = (memoryId: string, p: PathStep[], ts: number, more: object = {}) => sp.write({ type: "PlanMemory", fields: fields({ session: S, blockId: B, candidateId: `c${ts}`, author: "a", gen: 1, episode: "e1", goal: "beacon:feuer-bucht", memoryId, path: p, ts, ...more }) }, null, TTL);
		const ids = [memoryIdOf("beacon:feuer-bucht", path), memoryIdOf("beacon:feuer-bucht", path2), one.tideId, one.dayId];
		await mem(ids[0]!, path, 1);
		await mem(ids[1]!, path2, 2);
		await mem(ids[2]!, [[one.tide.room, one.tide.x, one.tide.y]], 3, { goal: "tide", obs: one.tide });
		await mem(ids[3]!, [[one.day.rooms[0]!.room, 0, 0]], 4, { goal: "tide", obs: one.day });
		await sp.write({ type: "MemoryFreeze", fields: fields({ session: S, blockId: B, freezeId: "r-g1", memoryIds: [...ids, "gone-before"], ts: 5 }) }, null, TTL);
		await sp.write({ type: "BotEpisode", fields: fields({ session: S, blockId: B, candidateId: "c1", episode: "e1", kind: "sample", reached: [true], cost: 7, path, jumps: [[path[1], path2[0]]], subgoals: 1, subgoalAt: [path[2]], ts: 1 }) }, null, TTL);
		await sp.write({ type: "Subgoals", fields: fields({ session: S, blockId: B, runId: "r", proposalId: "p", author: "a", via: "x", subgoals: [{ room: "graue-bucht", near: { x: 9, y: 10 } }, { holds: "pack:treibholz" }], ts: 1 }) }, null, TTL);
		await sp.write({ type: "Subgoals", fields: fields({ session: S, blockId: B, runId: "r", proposalId: "q", author: "a", via: "x", subgoals: [{ room: "graue-bucht" }], ts: 1 }) }, null, TTL);
		await sp.write({ type: "BotRoom", fields: fields({ world: "w", room: "graue-bucht", rev: "r1", geo: {}, ts: 1 }) }, null, FOREVER);
		await sp.write({ type: "CodeScore", fields: fields({ session: S, blockId: B, candidateId: "c1", ok: true, episodes: [{ id: "e1", kind: "sample", reached: [true], cost: 7 }] }) }, null, TTL);

		const checked = await migrateGrid(sp, { check: true, ttl: TTL });
		assert.deepEqual([checked.outcome, checked.report, checked.changed, checked.dropped], ["checked", [], 7, 1]);
		assert.equal(checked.notes.length, 1, "the freeze names one path the block dropped");
		assert.equal((await sp.readAll({ type: "GridFormat" })).length, 0, "a check writes nothing");

		const r = await migrateGrid(sp, { ttl: TTL });
		assert.equal(r.outcome, "migrated", r.report.join("\n"));
		assert.deepEqual((await sp.readAll({ type: "GridFormat" })).map((e) => e.fields), [{ gridScale: 2, derivedFrom: 1, state: "complete" }]);

		// the memory is what a judge at scale 2 writes: the same ids, the same observations
		const dbl = (p: PathStep[]): PathStep[] => p.map(([r, x, y]) => [r, x * 2, y * 2]);
		const frozen = await frozenMemory(sp, S, B, "r-g1");
		assert.deepEqual(frozen.map((m) => m.memoryId), [memoryIdOf("beacon:feuer-bucht", dbl(path)), memoryIdOf("beacon:feuer-bucht", dbl(path2)), two.tideId, two.dayId], "the freeze names the new ids, in its order");
		assert.deepEqual(frozen[0]!.path, dbl(path));
		assert.deepEqual(frozen[2]!.obs, two.tide);
		assert.deepEqual(frozen[3]!.obs, two.day);
		assert.deepEqual(frozen[3]!.path, [[one.day.rooms[0]!.room, 0, 0]]);
		assert.equal(observationIdOf(two.day), one.dayId, "a day of the chance tide keeps its id");
		assert.deepEqual((await sp.readAll({ type: "MemoryFreeze" }))[0]!.fields.memoryIds, [...frozen.map((m) => m.memoryId), "gone-before"]);
		assert.deepEqual((await sp.readAll({ type: "PlanMemory" })).map((e) => e.fields.ts).sort(), [1, 2, 3, 4], "the memory's age stays");
		// a judge at scale 2 that walks the same way adds nothing
		const txn = (await sp.createTransaction(30_000)).id;
		const added = await remember(sp, txn, TTL, { session: S, blockId: B, candidateId: "c9", author: "b", gen: 2 }, [
			{ memoryId: memoryIdOf("beacon:feuer-bucht", dbl(path)), episode: "e1", goal: "beacon:feuer-bucht", path: dbl(path) },
			{ memoryId: two.tideId, episode: "e1", goal: "tide", path: [[two.tide.room, two.tide.x, two.tide.y]], obs: two.tide },
		]);
		await sp.abort(txn);
		assert.equal(added, 0);

		const ep = (await sp.readAll({ type: "BotEpisode" }))[0]!.fields;
		assert.deepEqual([ep.path, ep.jumps, ep.subgoalAt, ep.cost, ep.ts], [dbl(path), [[dbl(path)[1], dbl(path2)[0]]], [dbl(path)[2]], 7, 1]);
		const goals = (await sp.readAll({ type: "Subgoals" })).map((e) => e.fields).sort((a, b) => String(a.proposalId).localeCompare(String(b.proposalId)));
		assert.deepEqual(goals.map((g) => g.subgoals), [[{ room: "graue-bucht", near: { x: 18, y: 20 } }, { holds: "pack:treibholz" }], [{ room: "graue-bucht" }]]);
		assert.equal((await sp.readAll({ type: "BotRoom" })).length, 0, "the rooms' geometry of scale 1 goes");
		assert.equal((await sp.readAll({ type: "CodeScore" })).length, 1);

		const again = await migrateGrid(sp, { ttl: TTL });
		assert.equal(again.outcome, "already");
		assert.equal((await sp.readAll({ type: "PlanMemory" }))[0]!.fields.path !== undefined, true);
		assert.deepEqual((await frozenMemory(sp, S, B, "r-g1"))[0]!.path, dbl(path), "a second run doubles nothing");
	} finally { await stack.close(); }
});

test("a run in flight, a running process and a cut-off migration refuse it before a write", async () => {
	const stack = await startStack({ judges: [], agents: false, model: false });
	try {
		const sp = stack.space;
		await sp.write({ type: "BotEpisode", fields: fields({ session: S, candidateId: "c1", episode: "e1", path, ts: 1 }) }, null, TTL);
		const run = await sp.write({ type: "BotRun", fields: fields({ session: S, candidateId: "c1", world: "w1" }) }, null, TTL);
		const proc = await sp.write({ type: "Process", fields: fields({ role: "judge", name: "test", pid: 1 }) }, null, TTL);
		const r = await migrateGrid(sp, { ttl: TTL });
		assert.equal(r.outcome, "refused");
		assert.equal(r.report.length, 2);
		assert.match(r.report.join("\n"), /BotRun .* in flight[\s\S]*judge process/);
		assert.equal((await sp.readAll({ type: "GridFormat" })).length, 0);
		assert.deepEqual((await sp.readAll({ type: "BotEpisode" }))[0]!.fields.path, path, "nothing was written");
		await sp.takeIfExists({ id: run.id }, NO_WAIT); await sp.takeIfExists({ id: proc.id }, NO_WAIT);

		await sp.write({ type: "GridFormat", fields: fields({ gridScale: 2, derivedFrom: 1, state: "running" }) }, null, FOREVER);
		const cut = await migrateGrid(sp, { ttl: TTL });
		assert.equal(cut.outcome, "refused");
		assert.match(cut.report[0]!, /cut off/);
		assert.deepEqual((await sp.readAll({ type: "BotEpisode" }))[0]!.fields.path, path);
	} finally { await stack.close(); }
});
