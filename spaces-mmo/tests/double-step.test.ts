// The double step at scale 2 (docs/3d-welt-und-raster-plan-2026-11-21.en.md section 3, "Movement" and "Execution"):
// `step 2 0` covers two cells on one axis, leg by leg, each checked as a step of its own; a refused second leg keeps the
// figure on the first leg's cell, a refused first leg at the start, and an exit on the first leg ends the step there.
// At scale 1 a step is one cell (tests/collision.test.ts). The stack runs worlds/leuchtfeuer/world-scale2.json, whose
// cells are the scale-1 world's × 2: the way east of the Graue Bucht is the exit area 46..47 × 16..17.
import "./scale2-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventually, Player, startServer } from "./stack.ts";
import type { ServerFrame } from "../server/gateway.ts";
import type { SpaceLike } from "phi-spaces";

const charAt = async (space: SpaceLike, charId: string) => (await space.readIfExists({ type: "Character", fields: { charId } }, 5_000))!.fields as Record<string, any>;
async function player(url: string, name: string): Promise<{ p: Player; me: string }> {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	return { p, me: (await p.play()).me.charId };
}
async function walk(p: Player, space: SpaceLike, me: string, x: number, y: number) {
	p.send(`move ${x} ${y}`);
	await eventually(async () => { const c = await charAt(space, me); return c.x === x && c.y === y; }, 10_000, `at ${x},${y}`);
}
async function does(p: Player, line: string, text: string, ms = 10_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && f.m.text.includes(text), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
const settle = () => new Promise((r) => setTimeout(r, 1_500));

test("a double step: two cells when both are free, one when the second is taken, none when the first is; an exit on the first leg ends it", { timeout: 180_000 }, async () => {
	const srv = await startServer();
	try {
		const space = srv.stack.space;
		assert.equal((await space.readAll({ type: "GridFormat" }))[0]!.fields.gridScale, 2);
		const a = await player(srv.url, "Anna"), b = await player(srv.url, "Bert");
		await walk(a.p, space, a.me, 36, 16);
		a.p.send("step 2 0");
		await eventually(async () => (await charAt(space, a.me)).x === 38, 10_000, "two cells on");
		a.p.send("step -2 0");
		await eventually(async () => (await charAt(space, a.me)).x === 36, 10_000, "and two back");

		// the second leg is taken: the figure ends on the first leg's cell, told why
		await walk(b.p, space, b.me, 38, 16);
		assert.equal(await does(a.p, "step 2 0", "steht schon"), "Dort steht schon Bert.");
		await settle();
		assert.deepEqual([(await charAt(space, a.me)).x, (await charAt(space, a.me)).y], [37, 16]);
		assert.equal((await space.readAll({ type: "Spot", fields: { charId: a.me } }))[0]?.fields.x, 37, "its Spot is on the cell it reached");
		// the first leg is taken: it stays
		assert.equal(await does(a.p, "step 2 0", "steht schon"), "Dort steht schon Bert.");
		await settle();
		assert.equal((await charAt(space, a.me)).x, 37);
		// not two axes at once, not three cells
		assert.match(await does(a.p, "step 1 1", "So geht es"), /einem bis 2 Schritten in einer Richtung/);
		assert.match(await does(a.p, "step 0 3", "So geht es"), /einem bis 2 Schritten/);

		// an exit on the first leg: through it, the second leg is not taken in the other room
		await walk(a.p, space, a.me, 45, 16);
		const n = a.p.frames.length;
		a.p.send("step 2 0");
		const hello = await a.p.until((f) => f.t === "hello" && f.room.roomId === "klippenpfad", 10_000, n) as Extract<ServerFrame, { t: "hello" }>;
		await settle();
		const there = await charAt(space, a.me), exit = (await space.readAll({ type: "Exit", fields: { location: "graue-bucht", destination: "klippenpfad" } }))[0]!.fields as Record<string, any>;
		assert.equal(there.room, "klippenpfad");
		assert.deepEqual([there.x, there.y], [exit.arrive.x, exit.arrive.y], `on the arrival cell (${hello.room.roomId})`);
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});
