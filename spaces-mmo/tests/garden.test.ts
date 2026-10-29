// Gardens, step 2 part 1 (docs/siedeln.md "Gärten", engine/commands/garden.ts): a bed is dug only with a spade and in the
// light; seeds grow in stages when watered and wilt when dry; fog and weeds slow them; a rain barrel gives cans; a
// sponsor tends a bed without owning it; one harvest takes what is ripe exactly once; and a thousand plants growing
// for a world day write the space only at their stage changes and waterings.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { advance, barrelWater, gardenTick, growFactor } from "../server/engine/commands/garden.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import { readClock } from "../server/engine/clock.ts";
import { initialClock, worldNow } from "../server/engine/worldtime.ts";
import type { BedFields, BuildingFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, lightFire, Player, startServer, startStack } from "./stack.ts";

const w = await loadWorld();
const g = w.garden!;
const H = 3600_000;

test("garden rules: stages in their times, slower in fog and weeds, wilting when dry or past ripe; the barrel gains a can every few hours", () => {
	const bed = (over: Partial<BedFields> = {}): BedFields => ({ bedId: "b", room: "r", x: 0, y: 0, w: 2, h: 2, owner: "o", ownerName: "O", accountId: "a", beaconId: "f", points: 1, sponsors: [], plants: [], wateredWorldMs: 0, weedy: false, dueWorldMs: 0, untilWorldMs: FOREVER, at: 0, ...over });
	const nelke = g.sorts.find((s) => s.key === "strandnelke")!;
	// watered: seed → sprout, its next date the sprout time (no weeds with this roll)
	const b = bed({ plants: [{ x: 0, y: 0, sort: "strandnelke", stage: 0, dueWorldMs: 6 * H }] });
	assert.equal(advance(g, b, 6 * H, 0, () => 0.9), true);
	assert.deepEqual([b.plants[0]!.stage, b.plants[0]!.dueWorldMs, b.dueWorldMs, b.weedy], [1, 6 * H + nelke.grow[1], 6 * H + nelke.grow[1], false]);
	// before its date nothing changes
	assert.equal(advance(g, b, 7 * H, 0), false);
	// in thick fog (3) and with weeds it grows 2.5 × 1.5 times slower
	assert.equal(growFactor(3, true), 3.75);
	const foggy = bed({ weedy: true, plants: [{ x: 0, y: 0, sort: "strandnelke", stage: 0, dueWorldMs: 0 }] });
	advance(g, foggy, 0, 3, () => 0.9);
	assert.equal(foggy.plants[0]!.dueWorldMs, nelke.grow[1] * 3.75);
	// dry for longer than the thirst: the next stage finds it wilted
	const dry = bed({ wateredWorldMs: 0, plants: [{ x: 0, y: 0, sort: "strandnelke", stage: 1, dueWorldMs: 20 * H }] });
	advance(g, dry, 20 * H, 0);
	assert.equal(dry.plants[0]!.stage, 3);
	assert.equal(dry.dueWorldMs, FOREVER, "a wilted plant has no date");
	// ripe: wilts after its time
	const ripe = bed({ wateredWorldMs: 50 * H, plants: [{ x: 0, y: 0, sort: "strandnelke", stage: 2, dueWorldMs: 50 * H }] });
	advance(g, ripe, 50 * H, 0);
	assert.equal(ripe.plants[0]!.stage, 3);
	// the barrel: one can at first, one more every fill time, never more than it holds
	const barrel = { builtAt: 0 } as BuildingFields;
	assert.deepEqual(barrelWater(g, barrel, 0), { cans: 1, at: 0 });
	assert.deepEqual(barrelWater(g, barrel, g.barrelFillWorldMs * 2 + 5), { cans: 3, at: g.barrelFillWorldMs * 2 });
	assert.equal(barrelWater(g, barrel, g.barrelFillWorldMs * 100).cans, g.barrelCap);
	assert.equal(barrelWater(g, { ...barrel, water: 0, waterAtWorldMs: g.barrelFillWorldMs * 3 } as BuildingFields, g.barrelFillWorldMs * 3 + 1).cans, 0);
});

type P = { p: Player; me: string; name: string };
async function player(url: string, name: string): Promise<P> {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	return { p, me: (await p.play()).me.charId, name };
}
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
async function walk(a: P, space: SpaceLike, x: number, y: number): Promise<void> {
	a.p.send(`move ${x} ${y}`);
	await eventually(async () => { const c = (await space.readAll({ type: "Character", fields: { charId: a.me } }))[0]?.fields; return c?.x === x && c?.y === y; }, 40_000, `${a.name} at ${x},${y}`);
}
const pack = async (space: SpaceLike, charId: string, proto: string) => (await space.readAll({ type: "Item", fields: { location: charId, proto } })).length;
/** The owner's bed; one the garden tick is writing right now is not read for that moment, so it is waited for. */
const bedOf = (space: SpaceLike, owner: string) => eventually(async () => (await space.readAll({ type: "Bed" })).map((e) => e.fields as unknown as BedFields).find((b) => b.owner === owner), 5_000, "the bed");
async function clear(space: SpaceLike, cells: Array<[number, number]>): Promise<void> {
	for (const e of await space.readAll({ type: "Item", fields: { location: "graue-bucht" } })) if (cells.some(([x, y]) => e.fields.x === x && e.fields.y === y)) await space.takeIfExists({ id: e.id }, 0);
}

test("a bed with a spade in the light; seeds grow when watered; a sponsor waters without owning; the barrel fills cans; one harvest takes the ripe once", { timeout: 300_000 }, async () => {
	// 0.0002: a world hour is 0.72 s, the thirst (16 h) 11.5 s, a strandnelke ripe after 24 h, 17 s
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.0002" } });
	try {
		const s = srv.stack.space;
		const anna = await player(srv.url, "Gärtnerin"), bert = await player(srv.url, "Bert");
		await walk(anna, s, 16, 11);
		assert.match(await does(anna.p, "umgraben 16 12", "Spaten"), /brauchst du einen Spaten/);
		await give(s, anna.me, "spaten", 1);
		assert.match(await does(anna.p, "umgraben 16 12", /Licht|Feuer/), /gegärtnert wird nur im Licht|kein Feuer|ist aus/);
		await lightFire(s, 600_000, "feuer-bucht");
		// a guest tends as a sponsor, but digs no bed of their own
		const guest = new Player(srv.url);
		assert.equal((await guest.post("/api/guest")).status, 200);
		await guest.play();
		assert.match(await does(guest, "umgraben", "Gäste"), /kein eigenes Beet/);
		let dug = "";
		for (let i = 0; i < 5 && !dug.includes("gräbt"); i++) { await clear(s, [[16, 12], [17, 12], [16, 13], [17, 13]]); dug = await does(anna.p, "umgraben 16 12", /gräbt ein Beet|passt kein Beet/); }
		assert.match(dug, /Gärtnerin gräbt ein Beet um \(2×2\)/);
		assert.equal((await s.readAll({ type: "Plot", fields: { room: "graue-bucht" } })).filter((e) => String(e.fields.of).startsWith("bed-")).length, 4);
		// the page sees it
		await anna.p.until((f) => f.t === "obj" && f.o.kind === "bed" && f.o.w === 2, 10_000);

		// planting: seeds from the pack, one plant a cell, a full bed takes no more
		assert.match(await does(anna.p, "pflanze strandnelke", "Samen"), /keine Samen/);
		await give(s, anna.me, "samen-strandnelke", 3);
		await give(s, anna.me, "samen-strandkohl", 2);
		for (const seed of ["strandnelke", "strandnelke", "strandnelke", "kohl"]) await does(anna.p, `pflanze ${seed}`, "setzt");
		assert.match(await does(anna.p, "pflanze kohl", "voll"), /Beet ist voll/);
		assert.equal((await bedOf(s, anna.me)).plants.length, 4);
		assert.equal(await pack(s, anna.me, "samen-strandkohl"), 1);

		// the rain barrel beside the bed: one can at first, then empty
		const barrel: BuildingFields = { buildId: "tonne-1", plan: "regentonne", name: "Regentonne", room: "graue-bucht", x: 15, y: 11, w: 1, h: 1, owner: anna.me, ownerName: anna.name, accountId: "x", beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: worldNow(await readClock(s)) };
		await s.write({ type: "Plot", fields: { room: "graue-bucht", x: 15, y: 11, of: "tonne-1" } as never }, null, FOREVER);
		await s.write({ type: "Building", fields: barrel as never }, null, FOREVER);
		assert.match(await does(anna.p, "schöpfe", "Kanne"), /Du füllst eine Kanne Wasser \(noch 0 in der Tonne\)/);
		assert.match(await does(anna.p, "schöpfe", "leer"), /Regentonne ist leer/);

		// someone else may not water it; as a sponsor they may, and own nothing
		await walk(bert, s, 18, 12);
		await give(s, bert.me, "wasserkanne", 2);
		assert.match(await does(bert.p, "gieße", "Beet von"), /gießen dürfen der Besitzer und seine Paten/);
		assert.match(await does(anna.p, "pate Bert", "Paten"), /macht Bert zum Paten/);
		assert.match(await does(bert.p, "gieße", "gießt"), /Bert gießt das Beet von Gärtnerin/);
		const tended = (await bedOf(s, anna.me))!;
		assert.equal(tended.owner, anna.me, "the bed is still Anna's");
		assert.equal(await pack(s, bert.me, "wasserkanne"), 1);

		// it grows: sprouts, then ripe (water it once more on the way, before the thirst runs out)
		await eventually(async () => (await bedOf(s, anna.me)).plants.every((p) => p.stage >= 1), 30_000, "the seeds sprout");
		assert.match(await does(anna.p, "gieße", "gießt"), /Gärtnerin gießt das Beet/);
		// keep it watered until something is ripe (weeds slow it, and a dry plant would wilt)
		await give(s, anna.me, "wasserkanne", 8);
		for (let i = 0; i < 20 && !(await bedOf(s, anna.me)).plants.some((p) => p.stage === 2); i++) {
			await new Promise((ok) => setTimeout(ok, 4_000));
			if (!(await bedOf(s, anna.me)).plants.some((p) => p.stage === 2)) await does(anna.p, "gieße", "gießt");
		}
		await eventually(async () => (await bedOf(s, anna.me)).plants.some((p) => p.stage === 2), 10_000, "something ripe");
		// two harvest at once: what is ripe goes once (whoever comes second finds nothing ripe, or what ripened since)
		const [a, b] = await Promise.all([does(anna.p, "ernte", /erntet|nichts reif/), does(bert.p, "ernte", /erntet|nichts reif/)]);
		assert.ok([a, b].some((t) => /erntet/.test(t)), `${a}\n${b}`);
		const left = (await bedOf(s, anna.me)).plants.length;
		const flowers = (await pack(s, anna.me, "strandnelke")) + (await pack(s, bert.me, "strandnelke")), cabbages = (await pack(s, anna.me, "kohl")) + (await pack(s, bert.me, "kohl"));
		assert.equal(flowers + cabbages / 2, 4 - left, "every harvested plant gave its yield once");
		assert.ok((await pack(s, anna.me, "samen-strandnelke")) + (await pack(s, bert.me, "samen-strandnelke")) >= 1, "and seeds with it");

		// the sponsor's end; afterwards they may not tend it
		assert.match(await does(anna.p, "pate weg Bert", "beendet"), /beendet die Patenschaft von Bert/);
		assert.match(await does(bert.p, "gieße", "Beet von"), /gießen dürfen der Besitzer/);

		// left dry, what still grows wilts; weeding pulls it
		await eventually(async () => (await bedOf(s, anna.me)).plants.some((p) => p.stage === 3), 90_000, "something wilts");
		assert.match(await does(anna.p, "jäte", "jätet"), /welke Pflanze/);
		assert.ok((await bedOf(s, anna.me)).plants.every((p) => p.stage !== 3));
		// giving it up frees the land
		assert.match(await does(anna.p, "beet aufgeben", "Gras"), /gibt das Beet auf/);
		assert.equal((await s.readAll({ type: "Plot", fields: { room: "graue-bucht" } })).filter((e) => String(e.fields.of).startsWith("bed-")).length, 0);
	} finally { await srv.close(); }
});

test("a thousand plants grow a world day and are watered twice: the space writes the beds only at their stage changes and waterings", { timeout: 240_000 }, async () => {
	// the space alone and the garden tick here, so its writes are counted where they happen; a clock of its own at 0.0002
	// (a world day is 17 s)
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space;
		await s.write({ type: "WorldClock", fields: initialClock(w.id, 8, Date.now(), 0.0002) as never }, null, FOREVER);
		const clock = await readClock(s), start = worldNow(clock);
		const sorts = ["strandnelke", "strandkohl", "moehre", "duenenrose"];
		// 250 beds of four plants, planted at once (written directly: the light of a fire carries 20, and digging is tested above)
		for (let i = 0; i < 250; i++) {
			const sort = g.sorts.find((x) => x.key === sorts[i % 4])!;
			const plants = [0, 1, 2, 3].map((k) => ({ x: k % 2, y: Math.floor(k / 2), sort: sort.key, stage: 0 as const, dueWorldMs: start + sort.grow[0] }));
			const b: BedFields = { bedId: `bed-scale-${i}`, room: "salzwiesen", x: 0, y: 0, w: 2, h: 2, owner: "o", ownerName: "O", accountId: "a", beaconId: "f", points: 1, sponsors: [], plants, wateredWorldMs: start, weedy: false, dueWorldMs: start + sort.grow[0], untilWorldMs: FOREVER, at: start };
			await s.write({ type: "Bed", fields: b as never }, null, FOREVER);
		}
		// the tick as the world runs it: every 60 world seconds, at least every 100 ms
		let ticks = 0, tickWrites = 0, running = true;
		const ticking = (async () => { while (running) { tickWrites += await gardenTick(s, w); ticks++; await new Promise((ok) => setTimeout(ok, 100)); } })();
		let waterings = 0;
		const water = async () => {
			for (let i = 0; i < 250; i++) {
				const txn = (await s.createTransaction(10_000)).id;
				// by its bedId: every write of a bed is a new entry, and the tick may be writing it right now
				const t = await s.takeIfExists({ type: "Bed", fields: { bedId: `bed-scale-${i}` } }, 5_000, { txn });
				if (!t) { await s.abort(txn); continue; }
				await s.write({ type: "Bed", fields: { ...t.fields, wateredWorldMs: worldNow(clock) } as never }, txn, FOREVER);
				await s.commit(txn);
				waterings++;
			}
		};
		// water at world hour 7 and 15, then let the day run out
		const at = (h: number) => new Promise((ok) => setTimeout(ok, Math.max(0, start + h * H - worldNow(clock)) / clock.rate));
		await at(7); await water();
		await at(15); await water();
		await at(24);
		running = false; await ticking;
		const beds = (await s.readAll({ type: "Bed" })).map((e) => e.fields as unknown as BedFields);
		let stageChanges = 0;
		for (const b of beds) for (const p of b.plants) stageChanges += p.stage;
		// a bed's plants were planted together, so they change together: one write per bed and stage change
		const bedChanges = beds.reduce((n, b) => n + Math.max(...b.plants.map((p) => p.stage)), 0);
		console.log(`[garden] 1000 plants, a world day, ${ticks} ticks: ${tickWrites + waterings} writes of beds (${waterings} waterings, ${tickWrites} by the tick for ${stageChanges} stage changes of plants, ${bedChanges} of beds)`);
		assert.equal(waterings, 500);
		assert.ok(stageChanges >= 1000, "every plant moved on at least once");
		assert.equal(tickWrites, bedChanges, "the tick wrote each bed once per stage change, and at no other time");
		// and nothing when no date has come: right after a round that wrote what was due, the next writes nothing
		await gardenTick(s, w);
		const quiet = await gardenTick(s, w);
		assert.equal(quiet, 0);
	} finally { await stack.close(); }
});
