// The wild from the fog, step 2 part 3 (docs/siedeln.md "Wild im Nebel", engine/commands/wild.ts): no hare comes while
// the fire burns; in thick fog hares come to the beds; one scared off eats nothing; a fenced bed or one by a scarecrow
// loses nothing; the bed's last living plant stays; scheuche and zäune as a player types them.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { bite, sheltered, wildTick } from "../server/engine/commands/wild.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld, walkable } from "../server/engine/world.ts";
import { readClock } from "../server/engine/clock.ts";
import { initialClock, worldNow } from "../server/engine/worldtime.ts";
import type { AnimalFields, BedFields, BedPlant, BuildingFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, lightFire, Player, startServer, startStack } from "./stack.ts";

const w = await loadWorld();
const g = w.garden!, wd = w.wild!;
const plant = (x: number, y: number, stage: BedPlant["stage"], sort = "strandkohl"): BedPlant => ({ x, y, sort, stage, dueWorldMs: FOREVER });
const bed = (over: Partial<BedFields> = {}): BedFields => ({ bedId: "b", room: "r", x: 0, y: 0, w: 2, h: 2, owner: "o", ownerName: "O", accountId: "a", beaconId: "f", points: 1, sponsors: [], plants: [], wateredWorldMs: 0, weedy: false, dueWorldMs: FOREVER, untilWorldMs: FOREVER, at: 0, ...over });

test("a hare's bite: a plant falls back a stage, a seedling is gone, the last living plant stays; a fence or a scarecrow shelters", () => {
	const ripe = bed({ plants: [plant(0, 0, 2), plant(1, 0, 3)] });
	assert.equal(bite(g, ripe, 0, 0, () => 0), null, "the only living plant stays (a wilted one does not count)");
	const two = bed({ plants: [plant(0, 0, 2), plant(1, 0, 0)] });
	const eaten = bite(g, two, 100, 0, () => 0)!;
	assert.equal(eaten.stage, 1, "ripe falls back to a sprout");
	assert.equal(eaten.dueWorldMs, 100 + g.sorts.find((s) => s.key === "strandkohl")!.grow[1]);
	assert.equal(two.dueWorldMs, eaten.dueWorldMs);
	const seedling = bed({ plants: [plant(0, 0, 1), plant(1, 0, 0)] });
	bite(g, seedling, 0, 0, () => 0.99);
	assert.deepEqual(seedling.plants.map((p) => p.stage), [1], "a seedling is gone");
	// shelter
	const crow = (x: number, y: number) => ({ room: "r", x, y, w: 1, h: 1 }) as BuildingFields;
	assert.equal(sheltered(wd, bed({ fenced: true }), []), true);
	assert.equal(sheltered(wd, bed({ x: 5, y: 5 }), [crow(5 + 1 + wd.scarecrowReach, 5)]), true, "a scarecrow three cells away");
	assert.equal(sheltered(wd, bed({ x: 5, y: 5 }), [crow(5 + 2 + wd.scarecrowReach, 5)]), false, "four is too far");
	assert.equal(sheltered(wd, bed({ x: 5, y: 5 }), [{ ...crow(6, 5), room: "elsewhere" }]), false);
});

/** A spot in a room where a bed of 2×2 has walkable cells all around. */
function spot(roomId: string): { x: number; y: number } {
	const r = w.rooms.find((x) => x.roomId === roomId)!;
	for (let y = 1; y < r.ground.length - 3; y++) for (let x = 1; x < r.ground[0]!.length - 3; x++) {
		let ok = true;
		for (let dy = -1; dy <= 2 && ok; dy++) for (let dx = -1; dx <= 2 && ok; dx++) ok = walkable(w, r.ground, x + dx, y + dy);
		if (ok) return { x, y };
	}
	throw new Error(`no spot in ${roomId}`);
}

test("the wild tick: no hare while the fire burns; in thick fog they come, at most a few; scared off, fenced or by a scarecrow nothing is lost", { timeout: 120_000 }, async () => {
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space;
		// 0.0002: a world hour is 0.72 s, a hare eats 0.36 s after it came
		await s.write({ type: "WorldClock", fields: initialClock(w.id, 12, Date.now(), 0.0002) as never }, null, FOREVER);
		const clock = await readClock(s);
		const rooms = w.rooms.map((r) => r.roomId).filter((id) => { try { spot(id); return true; } catch { return false; } });
		const [lit, open, scared, fenced, crowed, last] = rooms;
		assert.ok(last, "six rooms with room for a bed");
		const beds: Record<string, BedFields> = {};
		for (const room of [lit, open, scared, fenced, crowed, last] as string[]) {
			const at = spot(room);
			const plants = room === last ? [plant(at.x, at.y, 1)] : [plant(at.x, at.y, 2), plant(at.x + 1, at.y, 1), plant(at.x, at.y + 1, 1), plant(at.x + 1, at.y + 1, 0)];
			beds[room] = bed({ bedId: `bed-${room}`, room, ...at, plants, ...(room === fenced ? { fenced: true } : {}) });
			await s.write({ type: "Bed", fields: beds[room] as never }, null, FOREVER);
			await s.write({ type: "Fog", fields: { room, level: room === lit ? 0 : 3 } as never }, null, FOREVER);
		}
		const crowAt = beds[crowed!]!;
		await s.write({ type: "Building", fields: { buildId: "crow", plan: wd.scarecrow, name: "Vogelscheuche", room: crowed, x: crowAt.x + 3, y: crowAt.y, w: 1, h: 1, owner: "o", ownerName: "O", accountId: "a", beaconId: "f", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 } as never }, null, FOREVER);
		const hares = async (room: string) => (await s.readAll({ type: "Animal", fields: { room } })).map((e) => e.fields as unknown as AnimalFields);
		const bedIn = async (room: string) => (await s.readAll({ type: "Bed", fields: { room } }))[0]!.fields as unknown as BedFields;

		// every roll a hit: in the fog a hare comes to each bed, at the lit fire none
		await wildTick(s, w, 60_000, () => 0);
		assert.equal((await hares(lit!)).length, 0, "no hare while the fire burns");
		for (const room of [open, scared, fenced, crowed, last] as string[]) {
			const [h] = await hares(room);
			assert.ok(h, `a hare in ${room}`);
			const b = beds[room]!;
			assert.ok(Math.max(b.x - h.x, h.x - (b.x + 1), b.y - h.y, h.y - (b.y + 1)) === 1, "beside the bed");
		}
		// one is scared off before it eats (a take, as scheuche does)
		const [sh] = await hares(scared!);
		assert.ok(await s.takeIfExists({ type: "Animal", fields: { animalId: sh!.animalId } }, 0));
		// its time comes: the ones still there eat or find the bed sheltered, and go; a new one may come
		await new Promise((ok) => setTimeout(ok, Math.max(0, (wd.eatAfterWorldMs + 60_000) / clock.rate)));
		assert.ok(worldNow(clock) > sh!.eatsAtWorldMs);
		const r = await wildTick(s, w, 60_000, () => 0);
		assert.equal(r.ate, 1, "only the open bed lost something");
		assert.deepEqual((await bedIn(open!)).plants.map((p) => p.stage), [1, 1, 1, 0], "the ripe one fell back a stage");
		for (const room of [scared, fenced, crowed, last] as string[]) assert.deepEqual((await bedIn(room)).plants, beds[room]!.plants, `${room} lost nothing`);
		// never more than maxPerRoom at once
		for (let i = 0; i < 5; i++) await wildTick(s, w, 60_000, () => 0);
		assert.ok((await hares(open!)).length <= wd.maxPerRoom);
		assert.equal((await hares(lit!)).length, 0);
		// rolls that miss bring none
		for (const e of await s.readAll({ type: "Animal" })) await s.takeIfExists({ id: e.id }, 0);
		for (let i = 0; i < 10; i++) await wildTick(s, w, 60_000, () => 0.99);
		assert.equal(await s.count({ type: "Animal" }), 0);
	} finally { await stack.close(); }
});

type P = { p: Player; me: string };
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

test("scheuche and zäune as a player types them: the page shows the hare, the one nearest goes; a fence costs wood and rope", { timeout: 180_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Ida", password: "geheim-123" })).status, 200);
		const a: P = { p, me: (await p.play()).me.charId };
		await lightFire(s, 600_000, "feuer-bucht");
		await give(s, a.me, "spaten", 1);
		p.send("move 16 11");
		await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: a.me } }))[0]?.fields.x === 16, 40_000, "Ida at the bed's place");
		let dug = "";
		for (let i = 0; i < 5 && !dug.includes("gräbt"); i++) {
			for (const e of await s.readAll({ type: "Item", fields: { location: "graue-bucht" } })) if ([16, 17].includes(Number(e.fields.x)) && [12, 13].includes(Number(e.fields.y))) await s.takeIfExists({ id: e.id }, 0);
			dug = await does(p, "umgraben 16 12", /gräbt ein Beet|passt kein Beet/);
		}
		assert.match(dug, /gräbt ein Beet/);
		const b = (await s.readAll({ type: "Bed" }))[0]!.fields as unknown as BedFields;
		assert.match(await does(p, "scheuche hase", "Hase"), /kein Hase/);
		const hare: AnimalFields = { animalId: "hase-1", kind: "hase", name: "Hase", room: "graue-bucht", x: 18, y: 12, bedId: b.bedId, eatsAtWorldMs: FOREVER, at: 0 };
		await s.write({ type: "Animal", fields: hare as never }, null, FOREVER);
		await p.until((f) => f.t === "obj" && f.o.kind === "animal" && f.o.x === 18 && !!f.o.icon, 10_000);
		assert.match(await does(p, "scheuche den hasen", "scheucht"), /Ida scheucht den Hasen in den Nebel zurück/);
		assert.equal(await s.count({ type: "Animal" }), 0);
		assert.match(await does(p, "scheuche die möwe", "Hase"), /Verscheuchen lässt sich hier ein Hase/);
		// the fence
		assert.match(await does(p, "zäune", "Zaun"), /Für einen Zaun brauchst du 2 Treibholz und 1 Tangseil/);
		await give(s, a.me, "treibholz", 2);
		await give(s, a.me, "tangseil", 1);
		assert.match(await does(p, "zäune", "setzt"), /Ida setzt einen Zaun um das Beet von Ida/);
		await eventually(async () => ((await s.readAll({ type: "Bed" }))[0]?.fields as unknown as BedFields | undefined)?.fenced === true, 5_000, "the bed fenced");
		assert.equal(await s.count({ type: "Item", fields: { location: a.me, proto: "treibholz" } }), 0);
		await p.until((f) => f.t === "obj" && f.o.kind === "bed" && f.o.fenced === true, 10_000);
		assert.match(await does(p, "zäune", "schon"), /steht schon ein Zaun/);
	} finally { await srv.close(); }
});
