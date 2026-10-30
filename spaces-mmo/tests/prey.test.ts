// The other wild from the fog, step 3 part 4 (docs/siedeln.md "Wild im Nebel", engine/commands/wild.ts): deer graze a
// growing field (its yield falls, never below its floor), a fox takes a hen at night (never the last), mice eat from a
// chest (never the last); a fence, a mousetrap and the fed guards (dog, cat, geese) keep them away; the dog and the
// cat as a player leaves, feeds and takes them again; scheuche and zäune for the new kinds.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { graze, guardsIn, maxGrazes, wildKinds, wildTick } from "../server/engine/commands/wild.ts";
import { harvestOf } from "../server/engine/commands/field.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld, walkable } from "../server/engine/world.ts";
import { readClock, worldNowOf } from "../server/engine/clock.ts";
import { initialClock, worldNow } from "../server/engine/worldtime.ts";
import type { AnimalFields, BuildingFields, FieldFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, Player, startServer, startStack } from "./stack.ts";

const w = await loadWorld();
const wd = w.wild!, fd = w.fields!;
const kind = (k: string) => wildKinds(wd).find((x) => x.key === k)!;
const deer = kind("reh"), fox = kind("fuchs"), mouse = kind("maus");
const DAY = 24 * 3600_000;
const barley = fd.crops.find((c) => c.key === "gerste")!;

const field = (over: Partial<FieldFields> = {}): FieldFields => ({ fieldId: "f", room: "r", x: 0, y: 0, w: 4, h: 4, owner: "o", ownerName: "O", accountId: "a", beaconId: "b", points: 2,
	stage: "waechst", crop: "gerste", seeds: 4, seedNeed: 4, work: 0, workNeed: 8, yields: harvestOf(barley, 16, 1), soil: 1, by: {}, human: 0, other: 0, lastGroup: null, tired: 0,
	lastHarvestWorldMs: 0, dueWorldMs: FOREVER, untilWorldMs: FOREVER, at: 0, ...over });
const house = (over: Partial<BuildingFields>): BuildingFields => ({ buildId: "h", plan: "huette", name: "Hütte", room: "r", x: 0, y: 0, w: 2, h: 2, owner: "o", ownerName: "O", accountId: "a", beaconId: "b", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0, ...over });

test("a deer's bite: the yield falls by a share of the whole, never below its floor, and only while the crop grows; the guards by room", () => {
	const f = field(), full = f.yields[0]!.count;
	assert.equal(maxGrazes(deer), 3);
	for (let i = 1; i <= maxGrazes(deer); i++) assert.equal(graze(fd, deer, f), true);
	assert.equal(f.grazed, 3);
	assert.equal(f.yields[0]!.count, Math.floor(full * (1 - 3 * deer.bite!)));
	assert.ok(f.yields[0]!.count >= Math.floor(full * deer.keep!), "never below the floor");
	assert.equal(graze(fd, deer, f), false, "grazed out");
	assert.equal(graze(fd, deer, field({ stage: "reif" })), false, "a ripe field is being harvested: its shares stay");
	const tired = field({ soil: 0.5, yields: harvestOf(barley, 16, 0.5) });
	graze(fd, deer, tired);
	assert.equal(tired.yields[0]!.count, Math.floor(16 * 0.5 * (1 - deer.bite!)), "computed afresh from crop and soil");

	const g = guardsIn(wd, [
		house({ room: "a", keeper: { kind: "hund", fedUntilWorldMs: 10 } }), house({ room: "b", keeper: { kind: "katze", fedUntilWorldMs: 10 } }),
		house({ room: "c", keeper: { kind: "hund", fedUntilWorldMs: 1 } }), house({ room: "d", plan: "gehege", herd: { kind: "gans", fedUntilWorldMs: 10, atWorldMs: 0, goods: 0, bred: 0 } }),
	], 5);
	assert.deepEqual([...g.get("a")!.keys()].sort(), ["fuchs", "hase", "reh"]);
	assert.deepEqual([...g.get("b")!.keys()], ["maus"]);
	assert.equal(g.has("c"), false, "a hungry dog keeps nothing away");
	assert.deepEqual([...g.get("d")!.keys()].sort(), ["fuchs", "hase"]);
});

/** Rooms with a free 4×4 place and walkable cells round it. */
function spots(): Array<{ room: string; x: number; y: number }> {
	const out: Array<{ room: string; x: number; y: number }> = [];
	for (const r of w.rooms) {
		search: for (let y = 1; y < r.ground.length - 5; y++) for (let x = 1; x < r.ground[0]!.length - 5; x++) {
			let ok = true;
			for (let dy = -1; dy <= 4 && ok; dy++) for (let dx = -1; dx <= 4 && ok; dx++) ok = walkable(w, r.ground, x + dx, y + dy);
			if (ok) { out.push({ room: r.roomId, x, y }); break search; }
		}
	}
	return out;
}

test("the wild tick at night: deer, foxes and mice come and take a little; fenced, trapped or guarded loses nothing; never the last; none while the fire burns", { timeout: 120_000 }, async () => {
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space;
		// 0.0002: a world hour is 0.72 s; at 22 o'clock it is night, when the fox comes
		await s.write({ type: "WorldClock", fields: initialClock(w.id, 22, Date.now(), 0.0002) as never }, null, FOREVER);
		const clock = await readClock(s), now = worldNow(clock);
		const names = ["lit", "grazed", "fencedField", "dogField", "coop", "fencedCoop", "lastHen", "chest", "trapped", "catChest", "lastGrain"] as const;
		const at = spots();
		assert.ok(at.length >= names.length, "a room for each case");
		const room = Object.fromEntries(names.map((n, i) => [n, at[i]!])) as Record<(typeof names)[number], { room: string; x: number; y: number }>;
		for (const n of names) await s.write({ type: "Fog", fields: { room: room[n].room, level: n === "lit" ? 0 : 3 } as never }, null, FOREVER);
		const item = (location: string, proto: string, i: number) => s.write({ type: "Item", fields: { itemId: `${location}-${proto}-${i}`, name: proto, aliases: [], desc: "", location, x: -1, y: -1, glyph: { shape: "circle", color: "#fff" }, locks: "", proto } as never }, null, FOREVER);
		// fields
		for (const n of ["lit", "grazed", "fencedField", "dogField"] as const) await s.write({ type: "Field", fields: field({ fieldId: `field-${n}`, ...room[n], fenced: n === "fencedField" }) as never }, null, FOREVER);
		await s.write({ type: "Building", fields: house({ buildId: "kennel", ...room.dogField, x: room.dogField.x + 5, keeper: { kind: "hund", fedUntilWorldMs: now + DAY } }) as never }, null, FOREVER);
		// coops: three hens, three behind a fence, one alone
		const herd = { kind: "huhn", fedUntilWorldMs: now + DAY, atWorldMs: now, goods: 0, bred: 0 };
		for (const [n, hens] of [["coop", 3], ["fencedCoop", 3], ["lastHen", 1]] as const) {
			await s.write({ type: "Building", fields: house({ buildId: `coop-${n}`, plan: "huehnerstall", name: "Hühnerstall", ...room[n], w: 2, h: 1, herd, fenced: n === "fencedCoop" }) as never }, null, FOREVER);
			for (let i = 0; i < hens; i++) await item(`coop-${n}`, "huhn", i);
		}
		// huts with grain in the chest: one with a trap, one with a cat, one with a single grain
		for (const n of ["chest", "trapped", "catChest", "lastGrain"] as const) {
			await s.write({ type: "Building", fields: house({ buildId: `hut-${n}`, ...room[n], ...(n === "catChest" ? { keeper: { kind: "katze", fedUntilWorldMs: now + DAY } } : {}) }) as never }, null, FOREVER);
			for (let i = 0; i < (n === "lastGrain" ? 1 : 4); i++) await item(`hut-${n}`, "weizen", i);
			if (n === "trapped") await item(`hut-${n}`, "mausefalle", 0);
		}
		const animals = async (n: (typeof names)[number]) => (await s.readAll({ type: "Animal", fields: { room: room[n].room } })).map((e) => e.fields as unknown as AnimalFields);
		const fieldOf = async (n: string) => (await s.readAll({ type: "Field", fields: { fieldId: `field-${n}` } }))[0]!.fields as unknown as FieldFields;
		const inside = (id: string, proto: string) => s.count({ type: "Item", fields: { location: id, proto } });

		// every roll a hit: one of each kind comes to what it can take from, nothing to the lit room or to the last hen and grain
		await wildTick(s, w, 60_000, () => 0);
		assert.equal((await animals("lit")).length, 0, "no wild while the fire burns");
		for (const n of ["grazed", "fencedField", "dogField"] as const) assert.deepEqual((await animals(n)).map((a) => [a.kind, a.target]), [["reh", `field-${n}`]]);
		for (const n of ["coop", "fencedCoop"] as const) assert.deepEqual((await animals(n)).map((a) => [a.kind, a.target]), [["fuchs", `coop-${n}`]]);
		for (const n of ["chest", "trapped", "catChest"] as const) assert.deepEqual((await animals(n)).map((a) => [a.kind, a.target]), [["maus", `hut-${n}`]]);
		assert.equal((await animals("lastHen")).length, 0, "a coop's last hen draws no fox");
		assert.equal((await animals("lastGrain")).length, 0, "a chest's last grain draws no mouse");

		// their time comes: they eat or find it sheltered, and go
		const due = Math.max(deer.eatAfterWorldMs, fox.eatAfterWorldMs, mouse.eatAfterWorldMs);
		await new Promise((ok) => setTimeout(ok, (due + 60_000) / clock.rate));
		const r = await wildTick(s, w, 60_000, () => 0);
		assert.equal(r.ate, 3, "the open field, the open coop, the open chest");
		const grazed = await fieldOf("grazed");
		assert.equal(grazed.grazed, 1);
		assert.equal(grazed.yields[0]!.count, Math.floor(16 * (1 - deer.bite!)));
		for (const n of ["fencedField", "dogField"]) assert.equal((await fieldOf(n)).grazed ?? 0, 0, `${n} lost nothing`);
		assert.equal(await inside("coop-coop", "huhn"), 2, "the fox took one");
		const coop = (await s.readAll({ type: "Building", fields: { buildId: "coop-coop" } }))[0]!.fields as unknown as BuildingFields;
		assert.ok(coop.herd!.atWorldMs > now, "the herd was settled before");
		assert.equal(await inside("coop-fencedCoop", "huhn"), 3);
		assert.equal(await inside("hut-chest", "weizen"), 2, "the mouse ate two");
		assert.equal(await inside("hut-trapped", "weizen"), 4);
		assert.equal(await inside("hut-catChest", "weizen"), 4);
		assert.equal(await inside("hut-lastGrain", "weizen"), 1);
		assert.equal(await inside("coop-lastHen", "huhn"), 1);
		// never more than maxPerRoom of a kind
		for (let i = 0; i < 5; i++) await wildTick(s, w, 60_000, () => 0);
		for (const n of names) for (const k of ["reh", "fuchs", "maus"]) assert.ok((await animals(n)).filter((a) => a.kind === k).length <= wd.maxPerRoom);
		assert.equal((await animals("lit")).length, 0);
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
const pack = async (space: SpaceLike, charId: string, proto: string) => (await space.readAll({ type: "Item", fields: { location: charId, proto } })).length;

test("a dog and a cat as a player keeps them; scheuche reh; a fence round the own field", { timeout: 180_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Ida", password: "geheim-123" })).status, 200);
		const a: P = { p, me: (await p.play()).me.charId };
		const accountId = String((await s.readAll({ type: "Character", fields: { charId: a.me } }))[0]!.fields.accountId);
		// a hut of 2×2 and a field of 4×4 with one cell between them, away from the fire
		const r = w.rooms.find((x) => x.roomId === "graue-bucht")!, fire = w.beacons.find((b) => b.beaconId === "feuer-bucht")!;
		let spot: { x: number; y: number } | undefined;
		for (let y = 1; y < r.ground.length - 5 && !spot; y++) for (let x = 1; x < r.ground[0]!.length - 8 && !spot; x++) {
			let ok = Math.max(Math.abs(x + 2 - fire.x), Math.abs(y - fire.y)) > 2;
			for (let dy = 0; dy < 4 && ok; dy++) for (let dx = 0; dx < 7 && ok; dx++) ok = walkable(w, r.ground, x + dx, y + dy);
			if (ok) spot = { x, y };
		}
		assert.ok(spot);
		const hut: BuildingFields = house({ buildId: "huette-ida", room: "graue-bucht", ...spot, owner: a.me, ownerName: "Ida", accountId, beaconId: "feuer-bucht" });
		for (let y = hut.y; y < hut.y + 2; y++) for (let x = hut.x; x < hut.x + 2; x++) await s.write({ type: "Plot", fields: { room: hut.room, x, y, of: hut.buildId } as never }, null, FOREVER);
		await s.write({ type: "Building", fields: hut as never }, null, FOREVER);
		const f = field({ fieldId: "flur-ida", room: "graue-bucht", x: spot.x + 3, y: spot.y, owner: a.me, ownerName: "Ida", accountId, beaconId: "feuer-bucht" });
		await s.write({ type: "Field", fields: f as never }, null, FOREVER);
		for (const e of await s.readAll({ type: "Item", fields: { location: "graue-bucht" } })) if (e.fields.x === spot.x + 2 && e.fields.y === spot.y) await s.takeIfExists({ id: e.id }, 0);
		p.send(`move ${spot.x + 2} ${spot.y}`);
		await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: a.me } }))[0]?.fields.x === spot!.x + 2, 40_000, "Ida between hut and field");

		// the dog: left at the hut, not part of the chest, fed by its food, and taken along again
		assert.match(await does(p, "wache", "wacht niemand"), /Hier wacht niemand/);
		await give(s, a.me, "hund", 1);
		await give(s, a.me, "weizen", 2);
		assert.match(await does(p, "einstallen hund", "wachen"), /Ida lässt den Hund am Bau \(Hütte\) wachen/);
		const kept = async () => ((await s.readAll({ type: "Building", fields: { buildId: hut.buildId } }))[0]!.fields as unknown as BuildingFields).keeper;
		assert.equal((await kept())?.kind, "hund");
		await does(p, "verstaue 2 weizen", "Truhe");
		assert.match(await does(p, "truhe", "Truhe"), /In der Truhe \(2\/12\): 2 Weizen\./, "the dog is not in the chest");
		assert.match(await does(p, "entnimm hund", "nichts"), /In der Truhe ist nichts, was „hund“ heißt/);
		assert.match(await does(p, "füttere hund", "Futter"), /Du hast kein Futter für den Hund: Ei, Brot, Käse, Milch/);
		await give(s, a.me, "ei", 4);
		await give(s, a.me, "tang", 1);
		assert.match(await does(p, "füttere hund mit tang", "mag"), /Der Hund mag Tang nicht; er frisst Ei, Brot, Käse, Milch/);
		assert.match(await does(p, "füttere hund", "satt für"), /Ida füttert den Hund von Ida mit 3 Ei; satt für etwa 72 Stunden/);
		assert.equal(await pack(s, a.me, "ei"), 1, "only what fits");
		assert.ok((await kept())!.fedUntilWorldMs > (await worldNowOf(s)) + 2 * DAY);
		assert.match(await does(p, "wache", "Hier wachen"), /Hier wachen: der Hund von Ida am Bau \(Hütte\), satt noch 72 Stunden/);
		await give(s, a.me, "katze", 1);
		assert.match(await does(p, "einstallen katze", "niemand wacht"), /Geh direkt neben einen Bau von dir, an dem noch niemand wacht/);
		assert.match(await does(p, "ausstallen hund", "mit"), /Ida nimmt den Hund wieder mit/);
		assert.equal(await kept(), undefined);
		assert.equal(await pack(s, a.me, "hund"), 1);

		// a deer at the field: scared off; the field fenced
		const doe: AnimalFields = { animalId: "reh-1", kind: "reh", name: "Reh", room: "graue-bucht", x: f.x + 1, y: f.y - 1, target: f.fieldId, eatsAtWorldMs: FOREVER, at: 0 };
		await s.write({ type: "Animal", fields: doe as never }, null, FOREVER);
		await p.until((fr) => fr.t === "obj" && fr.o.kind === "animal" && fr.o.animal === "reh" && !!fr.o.icon?.endsWith("reh.png"), 10_000);
		assert.match(await does(p, "scheuche fuchs", "kein Fuchs"), /Hier ist kein Fuchs/);
		assert.match(await does(p, "scheuche reh", "scheucht"), /Ida scheucht das Reh in den Nebel zurück/);
		assert.equal(await s.count({ type: "Animal" }), 0);
		assert.match(await does(p, "zäune", "brauchst"), /Für diesen Zaun brauchst du 6 Treibholz und 2 Tangseil/);
		await give(s, a.me, "treibholz", 6);
		await give(s, a.me, "tangseil", 2);
		assert.match(await does(p, "zäune", "Zaun um die"), /Ida zieht einen Zaun um die Flur von Ida; kein Reh kommt mehr hinein/);
		assert.equal(((await s.readAll({ type: "Field", fields: { fieldId: f.fieldId } }))[0]!.fields as unknown as FieldFields).fenced, true);
		await p.until((fr) => fr.t === "obj" && fr.o.kind === "field" && fr.o.fenced === true, 10_000);
		assert.equal(await pack(s, a.me, "treibholz"), 0);
	} finally { await srv.close(); }
});
