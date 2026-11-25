// The greenhouse's inside (engine/commands/interior.ts, garden.ts, docs/innenraeume.en.md "Greenhouse"): three beds laid with
// the room, the owner's garden and flower bed and a community bed for its guests; planted, tended and harvested as any bed,
// never dug, never given up, no light, not among the owner's beds; they grow through the winter, do not decay, and go
// with the building. A task at one of them names the greenhouse and leads to it.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { ObjView, ServerFrame } from "../server/gateway.ts";
import { worldNowOf } from "../server/engine/clock.ts";
import { buildSweep } from "../server/engine/commands/build.ts";
import { gardenTick } from "../server/engine/commands/garden.ts";
import { writeRoomLock } from "../server/engine/room-lock.ts";
import { saveSettings } from "../server/settings.ts";
import { initialClock, WORLD_DAY_MS } from "../server/engine/worldtime.ts";
import { todosFor } from "../server/todos.ts";
import type { BedFields, WorldClockFields } from "../server/model.ts";
import { eventually, Player, startServer, startStack } from "./stack.ts";

const w = await loadWorld();
const g = w.garden!;
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
const bedsIn = async (space: SpaceLike, room: string) => (await space.readAll({ type: "Bed", fields: { room } })).map((e) => e.fields as unknown as BedFields);
async function walk(p: Player, space: SpaceLike, charId: string, x: number, y: number): Promise<void> {
	p.send(`move ${x} ${y}`);
	await eventually(async () => { const f = await charOf(space, charId); return f.x === x && f.y === y ? f : null; }, 10_000, `at ${x} ${y}`);
}

test("inside a greenhouse: its three beds, planted by the owner and its guest, harvested, never dug or given up, gone with it", { timeout: 240_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const host = new Player(srv.url), guest = new Player(srv.url);
		assert.equal((await host.post("/api/register", { name: "Gärtnerin", password: "geheim-123" })).status, 200);
		assert.equal((await guest.post("/api/register", { name: "Besucher", password: "geheim-123" })).status, 200);
		const me = (await host.play()).me.charId, other = (await guest.play()).me.charId;
		const c = await charOf(s, me);
		const now = await worldNowOf(s);
		await s.write({ type: "Building", fields: { buildId: "gh", plan: "gewaechshaus", name: "Gewächshaus", room: c.room, x: c.x + 1, y: c.y - 1, w: 3, h: 2, owner: me, ownerName: "Gärtnerin", accountId: c.accountId, beaconId: "feuer-bucht", points: 2, by: {}, untilWorldMs: now + 7 * 24 * 3600_000, builtAt: now } as never }, null, FOREVER);
		const inside = "in-gh";

		// in: the room with its potting bench and three beds, the owner's, on their plot cells, with no light taken
		await does(host, "betrete", "Du kommst herein");
		assert.equal((await charOf(s, me)).room, inside);
		const beds = await bedsIn(s, inside);
		assert.deepEqual(beds.map((b) => [b.bedId, b.kind ?? "", b.w * b.h]).sort(), [["bed-gh-0", "", 4], ["bed-gh-1", "zier", 4], ["bed-gh-2", "gemein", 9]]);
		for (const b of beds) assert.deepEqual([b.of, b.owner, b.beaconId, b.points, b.untilWorldMs], ["gh", me, "", 0, FOREVER]);
		assert.equal((await s.readAll({ type: "Plot", fields: { room: inside } })).length, 4 + 4 + 9 + 2);
		assert.equal((await s.readAll({ type: "BedCommons" })).length, 0, "the community bed inside takes no fire's place");
		assert.match(await does(host, "beet", "Gemeinschaftsbeet"), /Zierbeet von Gärtnerin/);

		// nothing is dug inside, and the beds are not given up
		assert.match(await does(host, "umgraben", "Drinnen gräbt man nicht um"), /Gewächshaus/);
		await walk(host, s, me, 3, 2);
		await does(host, "beet aufgeben ja", "gehören zum Bau");
		assert.equal((await bedsIn(s, inside)).length, 3);

		// carrots and cabbage in the owner's garden bed beside it
		await give(s, me, "samen-moehre", 1);
		await give(s, me, "samen-strandkohl", 1);
		await does(host, "pflanze möhrensamen", "ins Beet");
		await does(host, "pflanze strandkohlsamen", "ins Beet");
		const garden = (await bedsIn(s, inside)).find((b) => b.bedId === "bed-gh-0")!;
		assert.deepEqual(garden.plants.map((p) => p.sort).sort(), [g.sorts.find((x) => x.seed === "samen-moehre")!.key, g.sorts.find((x) => x.seed === "samen-strandkohl")!.key].sort());

		// the water butt: away from it one is sent there, beside it a can is filled from the greenhouse's own water
		assert.match(await does(host, "schöpfe", "Geh zum Wasserfass"), /Wasserfass/);
		await walk(host, s, me, 2, 3);
		await does(host, "schöpfe", "im Fass");
		assert.equal((await s.readAll({ type: "Item", fields: { location: me, proto: g.can } })).length, 1);
		assert.equal(((await s.readAll({ type: "Building", fields: { buildId: "gh" } }))[0]!.fields as { water?: number }).water, 0, "it held one can, now none");
		assert.match(await does(host, "schöpfe", "ist leer"), /Das Wasserfass/);
		await does(host, "gieße", "gießt");
		await walk(host, s, me, 3, 2);

		// ripe: harvested into the pack
		const t = (await s.takeIfExists({ type: "Bed", fields: { bedId: "bed-gh-0" } }, NO_WAIT, {}))!;
		const ripe = t.fields as unknown as BedFields;
		await s.write({ type: "Bed", fields: { ...ripe, plants: ripe.plants.map((p) => ({ ...p, stage: 2, dueWorldMs: FOREVER })), dueWorldMs: FOREVER } as never }, null, FOREVER);
		await does(host, "ernte", "erntet");
		assert.equal((await s.readAll({ type: "Item", fields: { location: me, proto: "moehre" } })).length >= 1, true);
		assert.equal((await s.readAll({ type: "Item", fields: { location: me, proto: "kohl" } })).length >= 1, true);

		// an invited guest plants flowers in the community bed, not in the owner's beds
		await does(host, "einladen Besucher", "Besucher darf jetzt in dein Gewächshaus.");
		await guest.until((f) => f.t === "msg" && f.m.text.includes("lädt dich ins Gewächshaus ein („betrete“ neben ihm)"), 10_000);
		guest.send(`move ${c.x} ${c.y}`);
		await eventually(async () => { const f = await charOf(s, other); return f.room === c.room && Math.abs(f.x - c.x) <= 1 && Math.abs(f.y - c.y) <= 1 ? f : null; }, 10_000, "the guest beside the greenhouse");
		await does(guest, "betrete", "Du kommst herein");
		await give(s, other, "samen-strandnelke", 1);
		await walk(guest, s, other, 5, 2);
		await does(guest, "pflanze strandnelkensamen", "ins Gemeinschaftsbeet");
		assert.equal((await bedsIn(s, inside)).find((b) => b.bedId === "bed-gh-2")!.plants.length, 1);

		// gone with its building: the beds and their cells go with the room
		await does(guest, "hinaus", /kommst an/);
		await s.takeIfExists({ type: "Building", fields: { buildId: "gh" } }, NO_WAIT, {});
		await buildSweep(s, w);
		assert.equal((await s.readAll({ type: "Room", fields: { roomId: inside } })).length, 0);
		assert.equal((await bedsIn(s, inside)).length, 0);
		assert.equal((await s.readAll({ type: "Plot", fields: { room: inside } })).length, 0);
		assert.equal((await charOf(s, me)).room, c.room);
		await host.leave(); await guest.leave();
	} finally { await srv.close(); }
});

const DAY = WORLD_DAY_MS, sort = g.sorts[0]!;
const bed = (over: Partial<BedFields> = {}) => ({ bedId: "b", room: "r", x: 1, y: 1, w: 2, h: 2, owner: "o", ownerName: "O", accountId: "a", beaconId: "feuer-bucht", points: 1, sponsors: [], plants: [{ x: 1, y: 1, sort: sort.key, stage: 1 as const, dueWorldMs: 0 }], wateredWorldMs: 0, weedy: false, dueWorldMs: 0, untilWorldMs: FOREVER, at: 0, ...over }) as BedFields;

test("a greenhouse's bed grows through the winter and does not decay; one outside stands still, one left goes back to grass", { timeout: 120_000 }, async () => {
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space;
		process.env.SPACES_MMO_SETTINGS_MS = "1";
		const clock = initialClock(w.id, 12, Date.now(), 1), winter: WorldClockFields = { ...clock, worldAnchorMs: 22 * DAY };
		await s.write({ type: "WorldClock", fields: winter as never }, null, FOREVER);
		await saveSettings(s, { "year.days": 28 });
		await new Promise((r) => setTimeout(r, 50));
		await s.write({ type: "Bed", fields: bed({ bedId: "inside", room: "in-gh", of: "gh", beaconId: "", points: 0, wateredWorldMs: 22 * DAY, untilWorldMs: 0 }) as never }, null, FOREVER);
		await s.write({ type: "Bed", fields: bed({ bedId: "outside", wateredWorldMs: 22 * DAY }) as never }, null, FOREVER);
		await s.write({ type: "Bed", fields: bed({ bedId: "left", x: 20, untilWorldMs: 0, plants: [], dueWorldMs: FOREVER }) as never }, null, FOREVER);
		// the room's lock, as the loader writes it with a room: a bed lapses only under it (room-lock.ts)
		await writeRoomLock(s, null, "r");
		await gardenTick(s, w);
		const of = async (id: string) => (await s.readAll({ type: "Bed", fields: { bedId: id } }))[0]?.fields as unknown as BedFields | undefined;
		assert.equal((await of("inside"))!.plants[0]!.stage, 2, "under glass it ripens in winter");
		assert.equal((await of("outside"))!.plants[0]!.stage, 1, "outside it waits for spring");
		assert.equal(await of("left"), undefined, "a bed outside past its time goes");
		// nothing due inside: the next tick writes nothing, though its date of decay has long passed
		assert.equal(await gardenTick(s, w), 0);
		assert.ok(await of("inside"));
	} finally { delete process.env.SPACES_MMO_SETTINGS_MS; await stack.close(); }
});

test("a task at a bed inside names the greenhouse and leads to it", () => {
	const house = { id: "gh", kind: "building", name: "Gewächshaus", owner: "Mira", ownerId: "c1", location: "bucht", x: 4, y: 3, plan: "gewaechshaus" } as unknown as ObjView;
	const inner = { id: "bed-gh-0", kind: "bed", name: "Beet", owner: "Mira", ownerId: "c1", location: "in-gh", x: 1, y: 1, plants: [] } as unknown as ObjView;
	const [todo] = todosFor("c1", [house, inner], new Map(), [], w, null);
	assert.equal(todo!.text, "Dein Beet in Gewächshaus von Mira (1 1) ist leer: pflanzen („pflanze“).");
	assert.deepEqual([todo!.room, todo!.x, todo!.y], ["bucht", 4, 3]);
});
