// Roads and carts, step 8 (docs/siedeln.en.md, engine/commands/cart.ts): a road beside an exit links its two rooms, a cart goes
// only by road, a room at a time on the clock, with its cargo, and a road goes only beside an exit.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { cartTick, roadLinks, roadPath } from "../server/engine/commands/cart.ts";
import { buildSweep } from "../server/engine/commands/build.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { CartFields, CharacterFields, ExitFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, lightFire, Player, startServer } from "./stack.ts";

const w = await loadWorld();
async function does(p: Player, line: string, text: string | RegExp, ms = 30_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
const give = async (s: SpaceLike, charId: string, proto: string) => { const p = (await eventually(() => resolvePrototype(s, proto), 10_000, proto))!; await spawn(s, null, w, p, { location: charId, x: -1, y: -1 }); };

test("a way through the roads, or none", () => {
	const links = new Map([["a", new Set(["b"])], ["b", new Set(["a", "c"])], ["c", new Set(["b"])], ["z", new Set<string>()]]);
	assert.deepEqual(roadPath(links, "a", "c"), ["b", "c"]);
	assert.deepEqual(roadPath(links, "a", "b"), ["b"]);
	assert.equal(roadPath(links, "a", "z"), null);
});

test("a road as a player types it: two cells from an exit, not beside it, not far from it", { timeout: 120_000 }, async () => {
	const srv = await startServer({ worldEnv: { SPACES_MMO_EPOCH_FORCE: "2" } });
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Ole", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		await lightFire(s, 600_000, "feuer-bucht");
		const c = (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0], 10_000, me))!.fields as unknown as CharacterFields;
		const x = (await s.readAll({ type: "Exit", fields: { location: c.room } })).map((e) => e.fields as unknown as ExitFields).find((e) => w.rooms.some((r) => r.roomId === e.destination))!;
		const ground = w.rooms.find((r) => r.roomId === c.room)!.ground;
		const cells: Array<{ x: number; y: number }> = [];
		for (let y = 0; y < ground.length; y++) for (let cx = 0; cx < ground[0]!.length; cx++) if (",.".includes(ground[y]![cx]!)) cells.push({ x: cx, y });
		const off = (a: { x: number; y: number }) => Math.max(Math.abs(a.x - x.x), Math.abs(a.y - x.y));
		const far = cells.find((a) => off(a) > 6 && !w.exits.some((e) => e.room === c.room && Math.max(Math.abs(e.x - a.x), Math.abs(e.y - a.y)) <= 3) && !w.beacons.some((b) => b.room === c.room && Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) <= 1))!;
		assert.match(await does(p, `bau straße ${far.x} ${far.y}`, "passt keine"), /beginnt neben einem Ausgang/);
		const near = cells.filter((a) => off(a) === 2);
		assert.ok(near.length);
		assert.match(await does(p, `bau straße ${near[0]!.x} ${near[0]!.y}`, /Baustelle ab|passt keine/), /Baustelle ab/);
		const site = (await s.readAll({ type: "Site" }))[0]!.fields as unknown as { plan: string; x: number; y: number };
		assert.equal(site.plan, "strasse");
		await s.write({ type: "Building", fields: { buildId: "road", plan: "strasse", name: "Straße", room: c.room, x: site.x, y: site.y, w: 1, h: 1, owner: "o", ownerName: "O", accountId: "o", beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 } as never }, null, FOREVER);
		assert.ok((await roadLinks(s, w)).get(c.room)?.has(x.destination), "from there it links the rooms of the exit");
	} finally { await srv.close(); }
});

test("a room holds one station: a second is refused, built or staked", { timeout: 120_000 }, async () => {
	const srv = await startServer({ worldEnv: { SPACES_MMO_EPOCH_FORCE: "4" } });
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Ole", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		await lightFire(s, 600_000, "feuer-bucht");
		const c = (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0], 10_000, me))!.fields as unknown as CharacterFields;
		await s.write({ type: "Building", fields: { buildId: "st", plan: "bahnhof", name: "Bahnhof", room: c.room, x: 0, y: 0, w: 3, h: 2, owner: "o", ownerName: "O", accountId: "o", beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 } as never }, null, FOREVER);
		assert.match(await does(p, "bau bahnhof", /höchstens einen|Baustelle ab|passt keine/), /höchstens einen Bau „Bahnhof“/);
		await s.take({ type: "Building", fields: { buildId: "st" } }, 5_000);
		assert.doesNotMatch(await does(p, "bau bahnhof", /höchstens einen|Baustelle ab|passt keine/), /höchstens einen/, "the room is free again");
	} finally { await srv.close(); }
});

test("freight by rail: sent while the train stands, for one fare; it waits at the station for its sender, and when the station falls it becomes the sender's estate", { timeout: 180_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Ole", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const c = (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0], 10_000, me))!.fields as unknown as CharacterFields;
		const here = w.rooms.find((r) => r.roomId === c.room)!, there = w.rooms.find((r) => r.island === here.island && r.roomId !== c.room)!;
		const station = (id: string, room: string, x: number, y: number) => s.write({ type: "Building", fields: { buildId: id, plan: "bahnhof", name: "Bahnhof", room, x, y, w: 1, h: 1, owner: "o", ownerName: "O", accountId: "o", beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 } as never }, null, FOREVER);
		await station("a", c.room, c.x + 1, c.y);
		await station("b", there.roomId, there.spawn.x, there.spawn.y);
		const every = w.rail!.everyWorldMs!, at = async (m: number) => { const e = (await s.readAll({ type: "WorldClock" }))[0]!; await s.takeIfExists({ id: e.id }, 0); await s.write({ type: "WorldClock", fields: { ...e.fields, worldAnchorMs: m, realAnchorMs: Date.now(), rate: 0.001 } as never }, null, FOREVER); };
		await at(every * 10);
		for (let i = 0; i < 5; i++) await give(s, me, "treibholz");
		const wood = () => s.count({ type: "Item", fields: { proto: "treibholz" } });
		const all = await wood();
		assert.match(await does(p, `zug sende 3 treibholz nach ${there.name}`, "kostet"), /Eine Fracht kostet 1 Münze/);
		await give(s, me, w.currency);
		assert.match(await does(p, `zug sende 3 treibholz nach ${there.name}`, "als Fracht"), /3× Treibholz als Fracht nach/);
		assert.equal(await s.count({ type: "Item", fields: { location: me, proto: "treibholz" } }), 2);
		assert.equal(await s.count({ type: "Item", fields: { location: me, proto: w.currency } }), 0, "the fare is paid");
		const f = (await s.readAll({ type: "Freight" }))[0]!.fields;
		assert.equal(f.room, there.roomId);
		assert.equal(await s.count({ type: "Item", fields: { location: String(f.freightId) } }), 3);
		// at the other station: fetched into the pack
		const moveTo = async (room: string, x: number, y: number) => { const e = (await s.take({ type: "Character", fields: { charId: me } }, 5_000))!; await s.write({ type: "Character", fields: { ...e.fields, room, x, y } }, null, FOREVER); };
		await moveTo(there.roomId, there.spawn.x + 1, there.spawn.y);
		assert.match(await does(p, "zug", "Fracht für dich"), /3 Stück/);
		assert.match(await does(p, "zug abholen", "Fracht vom Bahnsteig"), /3 Stück/);
		assert.equal(await s.count({ type: "Item", fields: { location: me, proto: "treibholz" } }), 5);
		assert.equal(await s.count({ type: "Freight" }), 0);
		// sent again, and the station falls: the sender's estate on the spot
		await give(s, me, w.currency);
		await moveTo(c.room, c.x, c.y);
		await does(p, `zug sende alle treibholz nach ${there.name}`, "als Fracht");
		const g = (await s.readAll({ type: "Freight" }))[0]!.fields;
		await s.take({ type: "Building", fields: { buildId: "b" } }, 5_000);
		await buildSweep(s, w);
		assert.equal(await s.count({ type: "Freight" }), 0);
		assert.equal(await s.count({ type: "Item", fields: { location: `est-${g.freightId}`, proto: "treibholz" } }), 5, "all of it waits as an estate");
		assert.equal(await wood(), all, "nothing lost or doubled");
	} finally { await srv.close(); }
});

test("a cart goes only by road, alone, with its cargo; its owner unloads it there", { timeout: 180_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Ole", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const c = (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0], 10_000, me))!.fields as unknown as CharacterFields;
		const x = (await s.readAll({ type: "Exit", fields: { location: c.room } })).map((e) => e.fields as unknown as ExitFields).find((e) => w.rooms.some((r) => r.roomId === e.destination))!;
		const to = w.rooms.find((r) => r.roomId === x.destination)!;
		await give(s, me, "karren");
		await give(s, me, "treibholz");
		await does(p, "karren stelle", "Karren ab");
		await does(p, "karren lade treibholz", "auf dem Karren");
		assert.match(await does(p, `karren fahre ${to.name}`, "Straße"), /keine Straße/);
		await s.write({ type: "Building", fields: { buildId: "road", plan: "strasse", name: "Straße", room: c.room, x: x.x, y: x.y - 1, w: 1, h: 1, owner: "o", ownerName: "O", accountId: "o", beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 } as never }, null, FOREVER);
		assert.deepEqual([...(await roadLinks(s, w)).get(c.room) ?? []].includes(to.roomId), true);
		await does(p, `karren fahre ${to.name}`, "schickst");
		assert.match(await does(p, "karren lade treibholz", /unterwegs|kein Karren|nichts/), /./);
		const e = (await s.readAll({ type: "Cart" }))[0]!, cart = e.fields as unknown as CartFields;
		await s.takeIfExists({ id: e.id }, 0);
		await s.write({ type: "Cart", fields: { ...cart, dueWorldMs: 1 } as never }, null, FOREVER);
		const from = p.frames.length;
		assert.equal(await cartTick(s, w, 60_000), 1);
		const there = (await s.readAll({ type: "Cart" }))[0]!.fields as unknown as CartFields;
		assert.deepEqual([there.room, there.path.length, there.dueWorldMs], [to.roomId, 0, FOREVER]);
		assert.equal(await s.count({ type: "Item", fields: { location: there.cartId } }), 1, "the cargo went with it");
		await cartTick(s, w, 60_000);
		await p.until((f) => f.t === "obj" && f.o.kind === "cart" && f.o.location === c.room, 10_000, 0); // a page saw it in its room
	} finally { await srv.close(); }
});

test("a cart on a standing route loads from its owner's chest at one end, unloads into the chest at the other, comes back and never goes empty", { timeout: 180_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Ole", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const c = (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0], 10_000, me))!.fields as unknown as CharacterFields;
		const x = (await s.readAll({ type: "Exit", fields: { location: c.room } })).map((e) => e.fields as unknown as ExitFields).find((e) => w.rooms.some((r) => r.roomId === e.destination))!;
		const to = w.rooms.find((r) => r.roomId === x.destination)!;
		const hut = (id: string, room: string, at: { x: number; y: number }) => s.write({ type: "Building", fields: { buildId: id, plan: "huette", name: "Hütte", room, x: at.x, y: at.y, w: 2, h: 2, owner: me, ownerName: "Ole", accountId: c.accountId, beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 } as never }, null, FOREVER);
		await give(s, me, "karren");
		await does(p, "karren stelle", "Karren ab");
		await s.write({ type: "Building", fields: { buildId: "road", plan: "strasse", name: "Straße", room: c.room, x: x.x, y: x.y - 1, w: 1, h: 1, owner: "o", ownerName: "O", accountId: "o", beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 } as never }, null, FOREVER);
		assert.match(await does(p, `karren pendel ${to.name}`, "Truhe"), /an beiden Enden einen Bau mit Truhe/);
		await hut("hut-a", c.room, { x: 0, y: 0 });
		await hut("hut-b", to.roomId, { x: 0, y: 0 });
		for (const proto of ["treibholz", "treibholz", "treibholz", "stein", w.currency]) await give(s, "hut-a", proto);
		assert.match(await does(p, `karren pendel ${to.name} mit treibholz`, "pendelt"), /pendelt jetzt zwischen .+ und /);
		const cart = async () => (await s.readAll({ type: "Cart" }))[0]!.fields as unknown as CartFields;
		const tick = async () => { const e = (await s.readAll({ type: "Cart" }))[0]!; await s.takeIfExists({ id: e.id }, 0); await s.write({ type: "Cart", fields: { ...e.fields, dueWorldMs: 1 } as never }, null, FOREVER); await cartTick(s, w, 60_000); return cart(); };
		const at = (where: string, proto: string) => s.count({ type: "Item", fields: { location: where, proto } });
		let f = await tick();
		assert.deepEqual([f.room, f.path], [c.room, [to.roomId]], "loaded, off it goes");
		assert.equal(await at(f.cartId, "treibholz"), 3);
		assert.equal((await at("hut-a", "stein")) + (await at("hut-a", w.currency)), 2, "only what the route names; never coins");
		f = await tick();
		assert.deepEqual([f.room, f.path.length], [to.roomId, 0]);
		assert.ok(f.dueWorldMs < FOREVER, "on a route it works where it arrives");
		f = await tick();
		assert.equal(await at("hut-b", "treibholz"), 3, "unloaded into the chest there");
		assert.deepEqual(f.path, [c.room], "and back");
		f = await tick();
		f = await tick();
		assert.deepEqual([f.room, f.path], [c.room, []], "nothing to carry: it waits");
		await give(s, "hut-a", "treibholz");
		f = await tick();
		assert.deepEqual(f.path, [to.roomId], "something again: it goes");
		assert.match(await does(p, "karren", "pendelt"), /pendelt zwischen/);
		assert.match(await does(p, "karren halt", "nicht mehr"), /pendelt nicht mehr/);
		assert.equal((await cart()).route, undefined);
	} finally { await srv.close(); }
});

test("the island railway: from station to station of an island, for its fare, while the timetable has the train there", { timeout: 180_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Ole", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const c = (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0], 10_000, me))!.fields as unknown as CharacterFields;
		const here = w.rooms.find((r) => r.roomId === c.room)!, there = w.rooms.find((r) => r.island === here.island && r.roomId !== c.room)!;
		const station = (id: string, room: string, x: number, y: number) => s.write({ type: "Building", fields: { buildId: id, plan: "bahnhof", name: "Bahnhof", room, x, y, w: 1, h: 1, owner: "o", ownerName: "O", accountId: "o", beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 } as never }, null, FOREVER);
		assert.match(await does(p, "zug", "Bahnh"), /nur an Bahnhöfen/);
		await station("a", c.room, c.x + 1, c.y);
		await station("b", there.roomId, there.spawn.x, there.spawn.y);
		await station("b2", there.roomId, there.spawn.x + 2, there.spawn.y);
		// the timetable: the train stands at the stations the first half of each period
		const every = w.rail!.everyWorldMs!, at = async (m: number) => { const e = (await s.readAll({ type: "WorldClock" }))[0]!; await s.takeIfExists({ id: e.id }, 0); await s.write({ type: "WorldClock", fields: { ...e.fields, worldAnchorMs: m, realAnchorMs: Date.now(), rate: 0.001 } as never }, null, FOREVER); };
		await at(every * 10 + every * 0.75);
		assert.match(await does(p, "zug", "fährt nach"), /Der Zug kommt in etwa \d+ Weltminuten/);
		assert.match(await does(p, `zug ${there.name}`, "kommt erst"), /kommt erst in etwa/);
		await at(every * 10);
		// two stations in a room are one stop
		assert.match(await does(p, "zug", "fährt nach"), new RegExp(`fährt nach: ${there.name}, für .*steht am Bahnsteig`));
		assert.match(await does(p, `zug ${there.name}`, "kostet"), /kostet 1 Münze/);
		await give(s, me, w.currency);
		await does(p, `zug ${there.name}`, "aus dem Zug");
		assert.equal(((await s.readAll({ type: "Character", fields: { charId: me } }))[0]!.fields as unknown as CharacterFields).room, there.roomId);
		assert.equal(await s.count({ type: "Item", fields: { location: me, proto: w.currency } }), 0);
	} finally { await srv.close(); }
});
