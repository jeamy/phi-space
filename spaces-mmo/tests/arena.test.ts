// The arena (server/arena.ts): a world of its own per bot, played over JSON lines. A scripted bot lights the fire of
// the Graue Bucht from the spawn; the clock stands still until `wait`; `look` stays bounded and ordered.
import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathOf, startArena } from "../server/arena.ts";
import { loadWorld } from "../server/engine/world.ts";

/** A client of the arena: one request at a time, answers by id. */
async function client(path: string) {
	const sock: Socket = connect(path);
	await new Promise<void>((ok, fail) => { sock.once("connect", () => ok()); sock.once("error", fail); });
	let buf = "", n = 0;
	const pending = new Map<number, (v: any) => void>();
	sock.setEncoding("utf8");
	sock.on("data", (d: string) => {
		buf += d;
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) { const r = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending.get(r.id)?.(r); pending.delete(r.id); }
	});
	return {
		ask: (op: string, args: Record<string, unknown> = {}) => new Promise<any>((ok) => { const id = ++n; pending.set(id, ok); sock.write(`${JSON.stringify({ id, op, ...args })}\n`); }),
		end: () => new Promise<void>((r) => { sock.once("close", () => r()); sock.end(); }),
	};
}

test("a bot lights the fire of the Graue Bucht in a world of its own; the clock moves only by wait", async () => {
	const dir = mkdtempSync(join(tmpdir(), "arena-test-")), path = join(dir, "a.sock");
	const arena = await startArena({ listen: `unix:${path}`, worlds: 1 });
	try {
		const c = await client(path);
		const o = await c.ask("open");
		assert.equal(o.ok, true, o.error);
		const world = o.world;
		const seen = await c.ask("look", { world });
		assert.equal(seen.ok, true, seen.error);
		assert.equal(seen.room.id, "graue-bucht");
		const spawn = (await loadWorld()).rooms.find((r) => r.roomId === "graue-bucht")!.spawn;
		assert.deepEqual(seen.at, spawn, "every bot starts on the spawn cell");
		assert.ok(seen.things.length <= 30 && seen.things.some((t: any) => t.name === "Treibholz" && t.x === 5 && t.y === 7), JSON.stringify(seen.things));
		assert.deepEqual(seen.fires.map((f: any) => [f.name, f.lit]), [["Leuchtfeuer", false]]);
		const t0 = seen.time;
		assert.equal((await c.ask("score", { world, goal: "beacon:feuer-bucht" })).done, false);
		// walk, pick up, walk beside the fire, feed it
		const go = await c.ask("act", { world, line: "move 5 7" });
		assert.equal(go.ok, true, go.error);
		assert.deepEqual(go.at, { room: "graue-bucht", x: 5, y: 7 });
		const took = await c.ask("act", { world, line: "nimm treibholz" });
		assert.ok(took.said.some((s: string) => s.includes("Treibholz")), JSON.stringify(took.said));
		await c.ask("act", { world, line: "move 9 9" });
		const fed = await c.ask("act", { world, line: "lege holz ins feuer" });
		assert.ok(fed.said.some((s: string) => /legst Treibholz ins Leuchtfeuer/.test(s)), JSON.stringify(fed.said));
		const s = await c.ask("score", { world, goal: "beacon:feuer-bucht" });
		assert.equal(s.done, true, s.detail);
		// walking and commands took no world time; wait moves the clock
		assert.equal((await c.ask("look", { world })).time, t0);
		const w = await c.ask("wait", { world, minutes: 30 });
		assert.notEqual(w.time, t0);
		assert.equal((await c.ask("wait", { world, minutes: 500 })).ok, false, "a wait beyond the limit is refused");
		const bad = await c.ask("act", { world: "nope", line: "schau" });
		assert.deepEqual([bad.ok, bad.error], [false, "no such world"]);
		// a second world starts as the first did (the first is closed: one world at a time here)
		await c.ask("close", { world });
		const o2 = await c.ask("open");
		const again = await c.ask("look", { world: o2.world });
		assert.deepEqual([again.at, again.things, again.fires, again.time], [seen.at, seen.things, seen.fires, t0], "the same world for every bot");
		// the connection ends: its world goes with it
		await c.end();
		for (let i = 0; i < 100 && arena.worlds() > 0; i++) await new Promise((r) => setTimeout(r, 100));
		assert.equal(arena.worlds(), 0);
	} finally {
		await arena.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a durable run's world outlives its connection, and a keyed call is carried out once", async () => {
	const dir = mkdtempSync(join(tmpdir(), "arena-test-")), path = join(dir, "a.sock");
	const arena = await startArena({ listen: `unix:${path}`, worlds: 1 });
	try {
		const c = await client(path);
		const { world } = await c.ask("open", { keep: true });
		await c.ask("act", { world, line: "move 5 7", key: "k1" });
		const took = await c.ask("act", { world, line: "nimm treibholz", key: "k2" });
		assert.ok(took.said.some((s: string) => s.includes("Treibholz")), JSON.stringify(took.said));
		// the judge dies: the world stays
		await c.end();
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(arena.worlds(), 1);
		const d = await client(path);
		// the call on its way when the judge died comes again with its key: the same answer, nothing picked up twice
		const again = await d.ask("act", { world, line: "nimm treibholz", key: "k2" });
		assert.deepEqual(again.said, took.said);
		assert.deepEqual((await d.ask("look", { world })).pack, [{ name: "Treibholz", count: 1 }]);
		assert.deepEqual((await d.ask("score", { world, goal: "feed:feuer-bucht:1" })).done, false);
		await d.ask("act", { world, line: "move 9 9", key: "k3" });
		await d.ask("act", { world, line: "lege holz ins feuer", key: "k4" });
		const s = await d.ask("score", { world, goal: "feed:feuer-bucht:1" });
		assert.equal(s.done, true, s.detail);
		assert.match(s.detail, /^1 of 1 pieces/);
		await d.ask("close", { world });
		assert.equal(arena.worlds(), 0);
		await d.end();
	} finally {
		await arena.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a kept world waits as long as its judge asked, a plain one only the idle time", async () => {
	const dir = mkdtempSync(join(tmpdir(), "arena-test-")), path = join(dir, "a.sock");
	const arena = await startArena({ listen: `unix:${path}`, worlds: 2, idleMs: 1000 });
	try {
		const c = await client(path);
		// both at once: opening a world takes seconds, and each one's idle time starts when it is open
		const [k, p] = await Promise.all([c.ask("open", { keep: true, idleMs: 4000 }), c.ask("open", { keep: true })]);
		assert.equal(k.ok && p.ok, true);
		const kept = k.world;
		await new Promise((r) => setTimeout(r, 2000));
		assert.equal(arena.worlds(), 1, "the one without its own idle time is gone, the other waits");
		assert.equal((await c.ask("look", { world: kept })).ok, true);
		for (let i = 0; i < 80 && arena.worlds() > 0; i++) await new Promise((r) => setTimeout(r, 100));
		assert.equal(arena.worlds(), 0, "and then it goes too");
		await c.end();
	} finally {
		await arena.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an episode: the guest starts where it says, the setup lays out the driftwood, and a goal must hold", async () => {
	const dir = mkdtempSync(join(tmpdir(), "arena-test-")), path = join(dir, "a.sock");
	const arena = await startArena({ listen: `unix:${path}`, worlds: 1 });
	try {
		const c = await client(path);
		// refused before a world is started
		for (const bad of [{ start: { room: "nowhere", x: 1, y: 1 } }, { start: { room: "graue-bucht", x: 0, y: 0 } }, { setup: { items: [{ proto: "treibholz", room: "graue-bucht", x: 99, y: 1 }] } }, { seed: -1 }]) {
			const r = await c.ask("open", bad);
			assert.equal(r.ok, false, JSON.stringify(bad));
		}
		assert.equal(arena.worlds(), 0);
		const o = await c.ask("open", { start: { room: "graue-bucht", x: 14, y: 9 }, setup: { clear: ["treibholz"], items: [{ proto: "treibholz", room: "graue-bucht", x: 12, y: 9 }] }, seed: 7 });
		assert.equal(o.ok, true, o.error);
		const world = o.world, seen = await c.ask("look", { world });
		assert.deepEqual(seen.at, { x: 14, y: 9 });
		assert.deepEqual(seen.things.filter((t: any) => t.name === "Treibholz").map((t: any) => [t.x, t.y]), [[12, 9]], "only the episode's driftwood lies there");
		await c.ask("act", { world, line: "move 12 9" });
		await c.ask("act", { world, line: "nimm treibholz" });
		await c.ask("act", { world, line: "move 9 9" });
		await c.ask("act", { world, line: "lege holz ins feuer" });
		// one piece burns 10 world minutes: it holds 5, not another 15
		const held = await c.ask("score", { world, goal: "beacon:feuer-bucht", hold: 5 });
		assert.equal(held.done, true, held.detail);
		assert.match(held.detail, /held 5 world minutes/);
		const gone = await c.ask("score", { world, goal: "beacon:feuer-bucht", hold: 15 });
		assert.equal(gone.done, false, gone.detail);
		assert.match(gone.detail, /not held 15 world minutes/);
		assert.equal((await c.ask("score", { world, goal: "beacon:feuer-bucht", hold: 500 })).ok, false);
		// the way it went: the start, the turns, the room it crossed into (a straight walk west is one step)
		assert.deepEqual((await c.ask("path", { world })).path, [["graue-bucht", 14, 9], ["graue-bucht", 9, 9]]);
		await c.ask("act", { world, line: "move 23 8" });
		const p = await c.ask("path", { world });
		assert.equal(p.cut, false);
		assert.deepEqual(p.path.slice(0, 2), [["graue-bucht", 14, 9], ["graue-bucht", 9, 9]]);
		assert.deepEqual(p.path.slice(-2), [["graue-bucht", 23, 8], ["klippenpfad", 1, 8]], "to the exit's cell, then where it arrives");
		for (const [a, b] of p.path.slice(1, -1).map((s: any, i: number) => [p.path[i], s])) assert.ok(a[1] === b[1] || a[2] === b[2], `${a} → ${b} is a straight run`);
		// a room's geometry needs no world
		const m = await c.ask("map", { room: "graue-bucht" });
		assert.equal(m.ok, true, m.error);
		assert.equal(m.world, "leuchtfeuer");
		assert.equal(m.ground.length, 16);
		assert.equal(m.walk["~"], false);
		assert.deepEqual(m.fires, [{ beaconId: "feuer-bucht", x: 9, y: 10 }]);
		assert.deepEqual(m.exits.find((e: any) => e.to === "klippenpfad"), { name: "ost", x: 23, y: 8, to: "klippenpfad" });
		assert.deepEqual(m.map, { x: 1, y: 1 });
		assert.match(m.rev, /^[0-9a-f]{16}$/);
		assert.equal((await c.ask("map", { room: "nowhere" })).ok, false);
		await c.ask("close", { world });
		await c.end();
	} finally {
		await arena.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a long way is cut to PATH_STEPS: every n-th turn and the last", () => {
	const trail: Array<[string, number, number]> = [];
	for (let i = 0; i < 500; i++) trail.push(["r", i, i % 2]); // a zigzag: every cell a turn
	const p = pathOf(trail, 200);
	assert.equal(p.cut, true);
	assert.ok(p.path.length <= 200, String(p.path.length));
	assert.deepEqual(p.path[0], ["r", 0, 0]);
	assert.deepEqual(p.path.at(-1), ["r", 499, 1]);
	assert.deepEqual(pathOf([["r", 1, 1], ["r", 2, 1], ["r", 3, 1], ["s", 1, 1]]), { path: [["r", 1, 1], ["r", 3, 1], ["s", 1, 1]], cut: false });
});
