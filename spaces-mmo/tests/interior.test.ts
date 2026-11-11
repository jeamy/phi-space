// A building's inside (engine/commands/interior.ts, docs/innenraeume.en.md): the owner goes into its hut, cooks at the
// hearth and uses the chest beside it inside; a stranger finds the door shut until invited, and is put out when the
// invitation is taken back; the inside is made once, by the sweep for a hut that stood before, and goes with its
// building, its people outside and what lay on its floor in the owner's estate.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { worldNowOf } from "../server/engine/clock.ts";
import { buildSweep } from "../server/engine/commands/build.ts";
import { eventually, Player, startServer } from "./stack.ts";

const w = await loadWorld();
async function does(p: Player, line: string, text: string | RegExp, ms = 40_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
async function give(space: SpaceLike, location: string, proto: string, count: number): Promise<void> {
	const p = (await eventually(() => resolvePrototype(space, proto), 10_000, `prototype ${proto}`))!;
	for (let i = 0; i < count; i++) await spawn(space, null, w, p, { location, x: -1, y: -1 });
}
const charOf = async (space: SpaceLike, charId: string) => (await eventually(async () => (await space.readAll({ type: "Character", fields: { charId } }))[0] ?? null, 10_000, `character ${charId}`))!.fields as { accountId: string; room: string; x: number; y: number; name: string };
async function hut(space: SpaceLike, buildId: string, owner: string, accountId: string, room: string, x: number, y: number): Promise<void> {
	const now = await worldNowOf(space);
	await space.write({ type: "Building", fields: { buildId, plan: "huette", name: "Hütte", room, x, y, w: 2, h: 2, owner, ownerName: "Wirtin", accountId, beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: now + 7 * 24 * 3600_000, builtAt: now } as never }, null, FOREVER);
}

test("inside a hut: in, cook at the hearth, the chest beside it, guests by invitation, out; made by the sweep, gone with the building", { timeout: 240_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const host = new Player(srv.url), guest = new Player(srv.url);
		assert.equal((await host.post("/api/register", { name: "Wirtin", password: "geheim-123" })).status, 200);
		assert.equal((await guest.post("/api/register", { name: "Besucher", password: "geheim-123" })).status, 200);
		const me = (await host.play()).me.charId, other = (await guest.play()).me.charId;
		const c = await charOf(s, me);
		await hut(s, "h-in", me, c.accountId, c.room, c.x + 1, c.y - 1);
		const inside = "in-h-in";

		// in: the room with its exit out and its four furnishings
		await does(host, "betrete", "Du kommst herein");
		assert.equal((await charOf(s, me)).room, inside);
		const room = (await s.readAll({ type: "Room", fields: { roomId: inside } }))[0]!.fields as { spawn: { x: number; y: number } };
		assert.deepEqual(room.spawn, w.building!.plans.find((p) => p.key === "huette")!.interior!.spawn);
		const exit = (await s.readAll({ type: "Exit", fields: { location: inside } })).map((e) => e.fields as { name: string; destination: string });
		assert.deepEqual(exit.map((x) => [x.name, x.destination]), [["hinaus", c.room]]);
		assert.deepEqual((await s.readAll({ type: "Scenery", fields: { room: inside } })).map((e) => String(e.fields.model)).sort(), ["bett", "herd", "tisch", "truhe"]);
		assert.match(await does(host, "betrete", "schon drinnen"), /hinaus/);

		// the hearth: away from it the recipe of the hut is refused with where to go, beside it it is made
		await give(s, me, "ei", 2);
		await give(s, me, "treibholz", 1);
		assert.match(await does(host, "craft ruehrei", "Herd"), /geh zu ihm/);
		host.send("move 2 2");
		await eventually(async () => { const f = await charOf(s, me); return f.x === 2 && f.y === 2 ? f : null; }, 10_000, "beside the hearth");
		await does(host, "craft ruehrei", "Rührei");
		assert.equal((await s.readAll({ type: "Item", fields: { location: me, proto: "ruehrei" } })).length, 1);
		// honey on bread at the same hearth: two honey breads
		await give(s, me, "honig", 1);
		await give(s, me, "brot", 1);
		await does(host, "craft honigbrot", "Honigbrot");
		assert.equal((await s.readAll({ type: "Item", fields: { location: me, proto: "honigbrot" } })).length, 2);

		// the chest: stored from anywhere (one's only chest), looked into beside it only
		await give(s, me, "muschel", 2);
		await does(host, "verstaue 1 muschel", "Truhe");
		assert.equal((await s.readAll({ type: "Item", fields: { location: "h-in", proto: "muschel" } })).length, 1);
		assert.match(await does(host, "truhe", "Geh zur Truhe"), /Truhe/);
		host.send("move 4 3");
		await eventually(async () => { const f = await charOf(s, me); return f.x === 4 && f.y === 3 ? f : null; }, 10_000, "beside the chest");
		await does(host, "truhe", "Muschel");
		await does(host, "entnimm muschel", "Muschel");
		assert.equal((await s.readAll({ type: "Item", fields: { location: "h-in", proto: "muschel" } })).length, 0);

		// a stranger beside the hut: the door is shut; invited it goes in; uninvited it is put out
		guest.send(`move ${c.x} ${c.y}`);
		await eventually(async () => { const f = await charOf(s, other); return Math.max(Math.abs(f.x - (c.x + 1)), Math.abs(f.y - c.y)) <= 1 && f.room === c.room ? f : null; }, 10_000, "the guest beside the hut");
		assert.match(await does(guest, "betrete", "Die Tür ist zu"), /Wirtin/);
		await does(host, "einladen Besucher", "darf jetzt");
		assert.match(await does(host, "einladen", "dürfen"), /Besucher/);
		await does(guest, "betrete", "Du kommst herein");
		assert.equal((await charOf(s, other)).room, inside);
		await does(host, "ausladen Besucher", "darf nicht mehr");
		await eventually(async () => ((await charOf(s, other)).room === c.room ? true : null), 10_000, "the guest outside");
		assert.match(await does(guest, "betrete", "Die Tür ist zu"), /eingeladen/);

		// out by the door, in front of the hut
		await does(host, "hinaus", /kommst an/);
		const out = await charOf(s, me);
		assert.equal(out.room, c.room);
		assert.ok(out.x < c.x + 1 || out.x > c.x + 2 || out.y < c.y - 1 || out.y > c.y, "not on the hut");

		// gone with its building: whoever is inside stands outside, the floor's things are in the estate, the room is gone
		await does(host, "betrete", "Du kommst herein");
		await give(s, me, "muschel", 1);
		await does(host, "drop muschel", "legst");
		const b = await s.takeIfExists({ type: "Building", fields: { buildId: "h-in" } }, NO_WAIT, {});
		assert.ok(b);
		await buildSweep(s, w);
		assert.equal((await s.readAll({ type: "Room", fields: { roomId: inside } })).length, 0);
		assert.equal((await s.readAll({ type: "Exit", fields: { location: inside } })).length, 0);
		assert.equal((await s.readAll({ type: "Scenery", fields: { room: inside } })).length, 0);
		assert.equal((await charOf(s, me)).room, c.room);
		assert.equal((await s.readAll({ type: "Item", fields: { location: "est-in-h-in", proto: "muschel" } })).length, 1);

		// a hut that stood before: the sweep gives it its inside, once
		await hut(s, "h-alt", me, c.accountId, c.room, c.x + 1, c.y - 1);
		await buildSweep(s, w);
		await buildSweep(s, w);
		assert.equal((await s.readAll({ type: "Room", fields: { roomId: "in-h-alt" } })).length, 1);
		assert.equal((await s.readAll({ type: "Scenery", fields: { room: "in-h-alt" } })).length, 4);
		await host.leave(); await guest.leave();
	} finally { await srv.close(); }
});
