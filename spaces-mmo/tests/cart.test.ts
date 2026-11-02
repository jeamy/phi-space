// Roads and carts, step 8 (docs/siedeln.en.md, engine/commands/cart.ts): a road beside an exit links its two rooms, a cart goes
// only by road, a room at a time on the clock, with its cargo, and a road goes only beside an exit.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { cartTick, roadLinks, roadPath } from "../server/engine/commands/cart.ts";
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

test("the island railway: from station to station of an island, for its fare", { timeout: 180_000 }, async () => {
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
		// two stations in a room are one stop
		assert.match(await does(p, "zug", "fährt nach"), new RegExp(`fährt nach: ${there.name}, für`));
		assert.match(await does(p, `zug ${there.name}`, "kostet"), /kostet 1 Münze/);
		await give(s, me, w.currency);
		await does(p, `zug ${there.name}`, "aus dem Zug");
		assert.equal(((await s.readAll({ type: "Character", fields: { charId: me } }))[0]!.fields as unknown as CharacterFields).room, there.roomId);
		assert.equal(await s.count({ type: "Item", fields: { location: me, proto: w.currency } }), 0);
	} finally { await srv.close(); }
});
