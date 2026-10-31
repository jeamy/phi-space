// The epochs, step 4 part 1 (docs/siedeln.md "Epochen", engine/commands/epoch.ts): an island reaches the village from
// beds alone; when enough decays it falls back, its buildings of the village go on working, and new village plans are
// refused again until the stock is enough.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { epochFor, epochOf, epochTick, islandPoints } from "../server/engine/commands/epoch.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import { worldNowOf } from "../server/engine/clock.ts";
import { initialClock } from "../server/engine/worldtime.ts";
import type { BedFields, BuildingFields, EpochFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, lightFire, Player, startServer, startStack } from "./stack.ts";

const w = await loadWorld();
const GRAU = "Graue Insel";
const grey = w.rooms.filter((r) => r.island === GRAU).map((r) => r.roomId);
const other = w.rooms.find((r) => r.island && r.island !== GRAU)!;

test("the epoch a stock reaches: none of the thresholds is the first, never beyond the last", () => {
	assert.equal(epochFor(0, [15, 40, 80]), 1);
	assert.equal(epochFor(14, [15, 40, 80]), 1);
	assert.equal(epochFor(15, [15, 40, 80]), 2);
	assert.equal(epochFor(80, [15, 40, 80]), 4);
	assert.equal(epochFor(5, [0, 0, 0], 4), 4, "thresholds of 0: every island at the last");
});

const bed = (i: number, room: string, over: Partial<BedFields> = {}): BedFields => ({ bedId: `bed-${room}-${i}`, room, x: i * 3, y: 1, w: 2, h: 2, owner: "o", ownerName: "O", accountId: `a${i}`, beaconId: "feuer-bucht", points: 1,
	sponsors: [], plants: [], wateredWorldMs: 0, weedy: false, dueWorldMs: FOREVER, untilWorldMs: FOREVER, at: 0, ...over });
const writeBeds = async (s: SpaceLike, n: number, room: string, over: Partial<BedFields> = {}) => { for (let i = 0; i < n; i++) await s.write({ type: "Bed", fields: bed(i, room, over) as never }, null, FOREVER); };

test("the count: an island becomes a village from beds alone; what decays makes it fall back; another island counts apart", { timeout: 60_000 }, async () => {
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space;
		await s.write({ type: "WorldClock", fields: initialClock(w.id, 12, Date.now(), 1) as never }, null, FOREVER);
		assert.deepEqual(await epochTick(s, w, 60_000), [], "nothing held, nothing written");
		assert.equal(await s.count({ type: "Epoch" }), 0);
		// fourteen beds on the grey island, a bed long overgrown, and beds on another island do not reach it
		await writeBeds(s, 7, grey[0]!);
		await writeBeds(s, 7, grey[1]!);
		await s.write({ type: "Bed", fields: bed(99, grey[0]!, { untilWorldMs: 1 }) as never }, null, FOREVER);
		await writeBeds(s, 20, other.roomId);
		const now = await worldNowOf(s);
		assert.equal((await islandPoints(s, w, now)).get(GRAU)!.points, 14);
		const first = await epochTick(s, w, 60_000);
		assert.ok(!first.some((x) => x.island === GRAU));
		assert.ok(first.some((x) => x.island === other.island && x.epoch === 2), "the other island counts apart");
		// the fifteenth: a village; every room of the island hears it, once
		await writeBeds(s, 1, grey[2]!);
		assert.deepEqual((await epochTick(s, w, 60_000)).filter((x) => x.island === GRAU), [{ island: GRAU, epoch: 2 }]);
		assert.equal(await epochOf(s, GRAU), 2);
		assert.deepEqual(await epochTick(s, w, 60_000), [], "unchanged: nothing written");
		// two workers counting at once: the change is written once
		await s.write({ type: "Bed", fields: bed(50, grey[2]!, { points: 30 }) as never }, null, FOREVER);
		const both = (await Promise.all([epochTick(s, w, 60_000), epochTick(s, w, 60_000)])).flat().filter((x) => x.island === GRAU);
		assert.deepEqual(both, [{ island: GRAU, epoch: 3 }]);
		assert.equal((await s.readAll({ type: "Epoch", fields: { island: GRAU } })).length, 1);
		await s.takeIfExists({ type: "Bed", fields: { bedId: `bed-${grey[2]}-50` } }, 0);
		assert.deepEqual((await epochTick(s, w, 60_000)).filter((x) => x.island === GRAU), [{ island: GRAU, epoch: 2 }]);
		assert.equal((await s.readAll({ type: "Epoch", fields: { island: GRAU } })).length, 1);
		// two beds decay: back to the fishing village
		for (const id of [`bed-${grey[0]}-0`, `bed-${grey[0]}-1`]) await s.takeIfExists({ type: "Bed", fields: { bedId: id } }, 0);
		assert.deepEqual(await epochTick(s, w, 60_000), [{ island: GRAU, epoch: 1 }]);
		assert.equal(await epochOf(s, GRAU), 1);
		const e = (await s.readAll({ type: "Epoch", fields: { island: GRAU } }))[0]!.fields as unknown as EpochFields;
		assert.equal(e.points, 13);
	} finally { await stack.close(); }
});

async function does(p: Player, line: string, text: string | RegExp, ms = 30_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
async function give(space: SpaceLike, charId: string, proto: string, count: number): Promise<void> {
	const p = (await eventually(() => resolvePrototype(space, proto), 10_000, `prototype ${proto}`))!;
	for (let i = 0; i < count; i++) await spawn(space, null, w, p, { location: charId, x: -1, y: -1 });
}

test("as a player: a village plan is refused in the fishing village, allowed in the village; after the fall a bakery that stands still bakes, a new one is refused", { timeout: 180_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Ole", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		await lightFire(s, 600_000, "feuer-bucht");
		assert.match(await does(p, "epoche", "Punkte"), /Graue Insel ist ein Fischerdorf \(Epoche 1\): 0 Punkte gehaltener Bestand \(Bauten 0, Beete 0, Fluren 0\)\. Ein Dorf braucht 15 Punkte; dann gibt es Windmühle, Backhaus, Gehege, Webstuhl, Lagerhaus, Steinbruch, Lehmgrube, Ziegelei, Werkstatt, Fluren\./);
		assert.match(await does(p, "bau", "Baupläne"), /Windmühle \(erst ab Dorf\)/);
		assert.match(await does(p, "bau windmühle", "braucht"), /Der Bauplan „Windmühle“ braucht ein Dorf \(Epoche 2\); Graue Insel hat noch nicht genug Bestand \(ab 15 Punkten/);
		await give(s, me, "spaten", 1);
		assert.match(await does(p, "flur anlegen", "braucht"), /Eine neue Flur braucht ein Dorf/);

		// fifteen beds on the island: the count makes it a village, and the plan may be staked out
		await writeBeds(s, 15, grey[1]!);
		const from = p.frames.length;
		await epochTick(s, w, 60_000);
		await p.until((f) => f.t === "msg" && /Graue Insel ist jetzt ein Dorf \(Epoche 2\): Windmühle, Backhaus, Gehege, Webstuhl, Lagerhaus, Steinbruch, Lehmgrube, Ziegelei, Werkstatt, Fluren lassen sich jetzt bauen/.test(f.m.text), 10_000, from);
		assert.match(await does(p, "epoche", "Punkte"), /Graue Insel ist ein Dorf \(Epoche 2\): 15 Punkte/);
		const staked = await does(p, "bau backhaus", /steckt eine Baustelle ab|passt keine|braucht/);
		assert.doesNotMatch(staked, /braucht ein Dorf/);

		// beds decay, the island falls back: a bakery that stands bakes on, a new plan of the village is refused
		for (const e of await s.readAll({ type: "Bed" })) await s.takeIfExists({ id: e.id }, 0);
		const fall = p.frames.length;
		await epochTick(s, w, 60_000);
		await p.until((f) => f.t === "msg" && /Graue Insel ist wieder ein Fischerdorf/.test(f.m.text), 10_000, fall);
		assert.match(await does(p, "bau windmühle", "braucht"), /braucht ein Dorf/);
		const c = (await s.readAll({ type: "Character", fields: { charId: me } }))[0]!.fields as { x: number; y: number; room: string };
		const ovenAt = { x: c.x + 1, y: c.y };
		for (const e of await s.readAll({ type: "Site" })) await s.takeIfExists({ id: e.id }, 0);
		const oven: BuildingFields = { buildId: "oven", plan: "backhaus", name: "Backhaus", room: c.room, ...ovenAt, w: 1, h: 1, owner: "x", ownerName: "X", accountId: "x", beaconId: "feuer-bucht", points: 2, by: {}, untilWorldMs: FOREVER, builtAt: 0 };
		await s.write({ type: "Building", fields: oven as never }, null, FOREVER);
		await give(s, me, "mehl", 2);
		await give(s, me, "wasserkanne", 1);
		await give(s, me, "treibholz", 1);
		assert.match(await does(p, "backe brot", "Brot"), /3 Brot/);
	} finally { await srv.close(); }
});
