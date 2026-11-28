// The start check of the grid format (server/grid-format.ts): a process of codemode-chat refuses a Space of another
// grid scale, begins an empty Space at its own, and never writes the entry at scale 1.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { FOREVER } from "phi-spaces";
import { checkGridFormat, GridFormatRefused, gridRefusal } from "../server/grid-format.ts";
import { migrateGrid } from "../server/migrate-grid.ts";
import { startStack } from "./stack.ts";

const TTL = 3600_000;

test("the refusals by scale, entry and the types a Space holds", () => {
	assert.deepEqual(gridRefusal(1, [], []), { begin: false });
	assert.deepEqual(gridRefusal(1, [], ["BotEpisode", "CodeScore"]), { begin: false }, "today's Space at today's scale");
	assert.deepEqual(gridRefusal(2, [], ["CodeScore", "ChatMessage"]), { begin: true }, "no cells: a Space begun at 2");
	assert.deepEqual(gridRefusal(2, [{ gridScale: 2, state: "complete" }], ["BotEpisode"]), { begin: false });
	assert.deepEqual(gridRefusal(2, [{ gridScale: 2, state: "complete" }, { gridScale: 2, state: "complete" }], []), { begin: false });
	const why = (r: ReturnType<typeof gridRefusal>) => ("why" in r ? r.why : "");
	assert.match(why(gridRefusal(2, [], ["BotRoom"])), /holds BotRoom.*migrate:grid/);
	assert.match(why(gridRefusal(2, [], ["PlanMemory"])), /at gridScale 1 .*migrate:grid/);
	assert.match(why(gridRefusal(1, [{ gridScale: 2, state: "complete" }], [])), /CODEMODE_GRID_SCALE=2/);
	assert.match(why(gridRefusal(2, [{ gridScale: 2, derivedFrom: 1, state: "running" }], [])), /running or was cut off/);
	assert.match(why(gridRefusal(1, [{ gridScale: 2, derivedFrom: 1, state: "running" }], [])), /running or was cut off/);
	assert.match(why(gridRefusal(2, [{ gridScale: 2, state: "complete" }, { gridScale: 2, derivedFrom: 1, state: "running" }], [])), /disagree/);
});

test("an empty Space is begun at 2 once, a Space of scale 1 with cells refuses, scale 1 writes nothing", async () => {
	const stack = await startStack({ judges: [], agents: false, model: false });
	try {
		const sp = stack.space;
		await checkGridFormat(sp, 1);
		assert.equal((await sp.readAll({ type: "GridFormat" })).length, 0, "a process at scale 1 writes no entry");
		await sp.write({ type: "CodeScore", fields: { session: "s", candidateId: "c" } as never }, null, TTL);
		await Promise.all([checkGridFormat(sp, 2), checkGridFormat(sp, 2), checkGridFormat(sp, 2)]);
		assert.deepEqual((await sp.readAll({ type: "GridFormat" })).map((e) => e.fields), [{ gridScale: 2, state: "complete" }], "three at once write one");
		await assert.rejects(checkGridFormat(sp, 1), (e: Error) => e instanceof GridFormatRefused && /CODEMODE_GRID_SCALE=2/.test(e.message));
		assert.equal((await migrateGrid(sp, { ttl: TTL })).outcome, "already", "a Space begun at 2 needs no migration");
	} finally { await stack.close(); }

	const old = await startStack({ judges: [], agents: false, model: false });
	try {
		await old.space.write({ type: "BotEpisode", fields: { session: "s", candidateId: "c", episode: "e", path: [["r", 1, 1]] } as never }, null, TTL);
		await assert.rejects(checkGridFormat(old.space, 2), /migrate:grid/);
		assert.equal((await old.space.readAll({ type: "GridFormat" })).length, 0);
		assert.equal((await migrateGrid(old.space, { ttl: TTL })).outcome, "migrated");
		await checkGridFormat(old.space, 2);
		await assert.rejects(checkGridFormat(old.space, 1), /CODEMODE_GRID_SCALE=2/);
	} finally { await old.close(); }
});

test("a judge process at scale 1 does not start on a migrated Space", async () => {
	const stack = await startStack({ judges: [], agents: false, model: false });
	try {
		await stack.space.write({ type: "GridFormat", fields: { gridScale: 2, derivedFrom: 1, state: "complete" } as never }, null, FOREVER);
		const child = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", "server/judge-host.ts"], { cwd: new URL("..", import.meta.url), env: { ...process.env, CODEMODE_SPACE: stack.spec, CODEMODE_GRID_SCALE: "1", CODEMODE_HOST_NAME: "grid" }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
		const code = await new Promise<number | null>((r) => child.on("exit", r));
		assert.notEqual(code, 0);
		assert.match(out, /grid format: the Space is at gridScale 2, this process at 1/);
		assert.doesNotMatch(out, /\[judge\]/);
		assert.equal((await stack.space.readAll({ type: "Process" })).filter((e) => (e.fields as { role?: string }).role === "judge").length, 0, "it announced nothing");
	} finally { await stack.close(); }
});
