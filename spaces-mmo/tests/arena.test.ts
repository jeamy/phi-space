// The arena (server/arena.ts): a world of its own per bot, played over JSON lines. A scripted bot lights the fire of
// the Graue Bucht from the spawn; the clock stands still until `wait`; `look` stays bounded and ordered.
import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startArena } from "../server/arena.ts";
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
