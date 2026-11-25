// The room lock (server/engine/room-lock.ts; docs/3d-welt-und-raster-plan-2026-11-21.en.md section 3, "Locks"): while
// another transaction holds a room's lock, a command that changes the room's occupancy is refused with LOCK_HELD and
// changes nothing; a step is not held up by it; once the lock is free the same command goes through, and the room has
// its one lock again after the commit (the stack's lock check at close, tests/stack.ts).
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import type { ServerFrame } from "../server/gateway.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import { LOCK_HELD, roomLock } from "../server/engine/room-lock.ts";
import { loadIntoSpace } from "../server/engine/loader.ts";
import { eventually, lightFire, Player, startServer, startStack } from "./stack.ts";

const ROOM = "graue-bucht";
const w = await loadWorld();
type P = { p: Player; me: string };
async function player(url: string, name: string): Promise<P> {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	return { p, me: (await p.play()).me.charId };
}
async function does(p: Player, line: string, text: RegExp, ms = 40_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && text.test(f.m.text), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
async function walk(a: P, space: SpaceLike, x: number, y: number): Promise<void> {
	a.p.send(`move ${x} ${y}`);
	await eventually(async () => { const c = (await space.readAll({ type: "Character", fields: { charId: a.me } }))[0]?.fields; return c?.x === x && c?.y === y; }, 40_000, `at ${x},${y}`);
}
/** The room's lock taken by a transaction of the test, as an engine transaction holds it. */
async function hold(space: SpaceLike): Promise<string> {
	const txn = (await space.createTransaction(60_000)).id;
	const e = await space.takeIfExists(roomLock(ROOM), 5_000, { txn });
	assert.ok(e, "the room's lock is there");
	await space.write({ type: e.type, fields: e.fields as never }, txn, FOREVER);
	return txn;
}
const held = new RegExp(LOCK_HELD.replace(/[.;]/g, "\\$&"));
const foot: Array<[number, number]> = [[16, 12], [17, 12], [16, 13], [17, 13]];
async function clear(space: SpaceLike): Promise<void> {
	for (const e of await space.readAll({ type: "Item", fields: { location: ROOM } })) if (foot.some(([x, y]) => e.fields.x === x && e.fields.y === y)) await space.takeIfExists({ id: e.id }, 0);
}

test("a held room lock refuses building and digging, not a step; free again, the same command goes through", { timeout: 240_000 }, async () => {
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.001" } });
	try {
		const s = srv.stack.space;
		const a = await player(srv.url, "Baumeisterin");
		await walk(a, s, 16, 11);
		await lightFire(s, 600_000, "feuer-bucht");
		const spade = (await eventually(() => resolvePrototype(s, "spaten"), 10_000, "prototype spaten"))!;
		await spawn(s, null, w, spade, { location: a.me, x: -1, y: -1 });
		assert.equal((await s.readAll(roomLock(ROOM))).length, 1);

		let txn = await hold(s);
		await clear(s);
		assert.match(await does(a.p, "bau hütte 16 12", /steckt eine Baustelle ab|passt keine?|gerade gebaut/), held);
		assert.match(await does(a.p, "umgraben 16 12", /gräbt ein Beet|passt kein Beet|gerade gebaut/), held);
		assert.equal((await s.readAll({ type: "Site", fields: { room: ROOM } })).length, 0);
		assert.equal((await s.readAll({ type: "Bed", fields: { room: ROOM } })).length, 0);
		// a step is not held up
		await walk(a, s, 15, 11);
		await walk(a, s, 16, 11);
		await s.abort(txn);

		// free again: the same command goes through
		let staked = "";
		for (let i = 0; i < 5 && !staked.includes("steckt"); i++) { await clear(s); staked = await does(a.p, "bau hütte 16 12", /steckt eine Baustelle ab|passt keine?/); }
		assert.match(staked, /steckt eine Baustelle ab: Hütte/);
		assert.equal((await s.readAll({ type: "Site", fields: { room: ROOM } })).length, 1);

		// held again, its abriss is refused and the site stays; committed by the holder, the lock is still one
		txn = await hold(s);
		assert.match(await does(a.p, "abriss baustelle", /gerade gebaut|gibt die Baustelle/), held);
		assert.equal((await s.readAll({ type: "Site", fields: { room: ROOM } })).length, 1);
		await s.commit(txn);
		assert.equal((await s.readAll(roomLock(ROOM))).length, 1);
	} finally {
		await srv.close();
	}
});

test("a store from before the locks: the loader gives every room its one lock, a world room's and one the game made", { timeout: 120_000 }, async () => {
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space;
		await loadIntoSpace(s, w);
		// as a store before step 5 left them: an inside without its lock, a world room whose lock is not there
		await s.write({ type: "Room", fields: { roomId: "in-alt", name: "Innen", desc: "", ground: ["...."], spawn: { x: 0, y: 0 } } as never }, null, FOREVER);
		assert.ok(await s.takeIfExists(roomLock(ROOM), 0));
		await loadIntoSpace(s, w);
		assert.equal((await s.readAll(roomLock("in-alt"))).length, 1);
		assert.equal((await s.readAll(roomLock(ROOM))).length, 1);
		// a second load writes nothing more
		await loadIntoSpace(s, w);
		assert.equal((await s.readAll(roomLock("in-alt"))).length, 1);
		assert.equal((await s.readAll({ type: "RoomLock" })).length, (await s.readAll({ type: "Room" })).length);
	} finally {
		await stack.close();
	}
});
