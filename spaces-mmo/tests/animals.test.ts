// Animals on the farm, step 3 part 3 (docs/siedeln.en.md "Tiere auf dem Hof", engine/commands/animals.ts): hens put into a
// coop give eggs only while fed; anyone feeds, only the owner puts in, takes out and collects; two fed ones get a young
// one; a pen keeps one kind; demolition gives the animals back.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { herdNow } from "../server/engine/commands/animals.ts";
import { guardedRooms, sheltered } from "../server/engine/commands/wild.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld, walkable } from "../server/engine/world.ts";
import { decayNowOf, worldNowOf } from "../server/engine/clock.ts";
import { sweepTick } from "../server/engine/sweep.ts";
import { packMax } from "../server/engine/pack.ts";
import type { BedFields, BuildingFields, HerdFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, Player, startServer } from "./stack.ts";

const w = await loadWorld();
const d = w.animals!;
const kind = (k: string) => d.kinds.find((x) => x.key === k)!;
const DAY = 24 * 3600_000;

test("a herd brought up to now: fed time gives the yield (up to the nest's limit), hungry time nothing; two fed ones get a young one", () => {
	const hen = kind("huhn"), h = (over: Partial<HerdFields> = {}): HerdFields => ({ kind: "huhn", fedUntilWorldMs: 10 * DAY, atWorldMs: 0, goods: 0, bred: 0, ...over });
	assert.equal(herdNow(hen, d, h(), 3, 6, DAY).goods, 3, "three hens, a fed day: three eggs");
	assert.equal(herdNow(hen, d, h(), 3, 6, 9 * DAY).goods, 3 * d.nestMax, "the nest holds a few per hen");
	assert.equal(herdNow(hen, d, h({ fedUntilWorldMs: 0 }), 3, 6, DAY).goods, 0, "hungry: nothing");
	assert.equal(herdNow(hen, d, h({ fedUntilWorldMs: DAY / 2 }), 2, 6, DAY).goods, 1, "fed half the day");
	assert.equal(herdNow(hen, d, h(), 2, 6, hen.breedWorldMs).born, 1, "two fed ones: a young one");
	assert.equal(herdNow(hen, d, h(), 1, 6, hen.breedWorldMs).born, 0, "one alone: none");
	assert.equal(herdNow(hen, d, h(), 6, 6, hen.breedWorldMs).born, 0, "a full house: none");
	assert.equal(herdNow(hen, d, h({ fedUntilWorldMs: 0 }), 3, 6, hen.breedWorldMs).born, 0, "hungry ones: none");
	assert.equal(herdNow(hen, d, h(), 5, 6, 3 * hen.breedWorldMs).born, 1, "never beyond the house");
});

test("fed geese keep the hares from every bed of their room; hungry ones or other animals do not", () => {
	const wd = w.wild!, house = (room: string, kind: string, fed: number) => ({ room, herd: { kind, fedUntilWorldMs: fed, atWorldMs: 0, goods: 0, bred: 0 } }) as BuildingFields;
	const g = guardedRooms(wd, [house("a", "gans", 10), house("b", "gans", 1), house("c", "huhn", 10)], 5);
	assert.deepEqual([...g], ["a"]);
	const bed = (room: string) => ({ room, x: 0, y: 0, w: 2, h: 2, fenced: false }) as BedFields;
	assert.equal(sheltered(wd, bed("a"), [], g), true);
	assert.equal(sheltered(wd, bed("b"), [], g), false);
});

type P = { p: Player; me: string; name: string };
async function player(url: string, name: string): Promise<P> {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	return { p, me: (await p.play()).me.charId, name };
}
async function does(p: Player, line: string, text: string | RegExp, ms = 40_000): Promise<string> {
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
async function building(space: SpaceLike, f: Partial<BuildingFields> & Pick<BuildingFields, "buildId" | "plan" | "name" | "x" | "y" | "w" | "h">): Promise<BuildingFields> {
	const b: BuildingFields = { room: "graue-bucht", owner: "o", ownerName: "O", accountId: "a", beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0, ...f };
	for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) await space.write({ type: "Plot", fields: { room: b.room, x, y, of: b.buildId } as never }, null, FOREVER);
	await space.write({ type: "Building", fields: b as never }, null, FOREVER);
	return b;
}
async function walkBeside(a: P, space: SpaceLike, b: BuildingFields, skip: Set<string>): Promise<void> {
	const room = w.rooms.find((r) => r.roomId === b.room)!, fire = w.beacons.find((x) => x.beaconId === b.beaconId)!;
	for (let y = b.y - 1; y <= b.y + b.h; y++) for (let x = b.x - 1; x <= b.x + b.w; x++) {
		if ((x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) || skip.has(`${x},${y}`) || !walkable(w, room.ground, x, y) || Math.max(Math.abs(x - fire.x), Math.abs(y - fire.y)) <= 1) continue;
		skip.add(`${x},${y}`);
		for (const e of await space.readAll({ type: "Item", fields: { location: b.room } })) if (e.fields.x === x && e.fields.y === y) await space.takeIfExists({ id: e.id }, 0);
		a.p.send(`move ${x} ${y}`);
		if (await eventually(async () => { const c = (await space.readAll({ type: "Character", fields: { charId: a.me } }))[0]?.fields; return c?.x === x && c?.y === y; }, 15_000, "").then(() => true, () => false)) return;
	}
	throw new Error(`${a.name}: no cell beside ${b.name}`);
}
/** Moves the herd's clock back by `ms` (as if that much fed time had passed) and feeds it well ahead. */
async function timePasses(space: SpaceLike, buildId: string, ms: number): Promise<void> {
	const e = (await space.take({ type: "Building", fields: { buildId } }, 5_000))!;
	const b = e.fields as unknown as BuildingFields, now = await worldNowOf(space);
	await space.write({ type: "Building", fields: { ...b, herd: { ...b.herd!, atWorldMs: now - ms, fedUntilWorldMs: now + DAY } } as never }, null, FOREVER);
}

test("a hive: bee colonies eat flowers, give honey every other day and wax with every three pots", { timeout: 300_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const ida = await player(srv.url, "Imkerin"), bo = await player(srv.url, "Blumenbo");
		const accountId = String((await s.readAll({ type: "Character", fields: { charId: ida.me } }))[0]!.fields.accountId);
		const hive = await building(s, { buildId: "stock-1", plan: "bienenstock", name: "Bienenstock", x: 16, y: 12, w: 1, h: 1, owner: ida.me, ownerName: ida.name, accountId });
		const taken = new Set<string>();
		await walkBeside(ida, s, hive, taken);
		await walkBeside(bo, s, hive, taken);
		await give(s, ida.me, "bienenvolk", 2);
		await give(s, ida.me, "huhn", 1);
		assert.match(await does(ida.p, "einstallen huhn", "wohnen"), /Hühner wohnen im Hühnerstall, nicht im Bienenstock/);
		await does(ida.p, "einstallen bienenvolk", "(1 Bienenvolk)");
		await does(ida.p, "einstallen bienen", "(2 Bienenvölker)");
		// they eat flowers, anyone feeds them
		await give(s, bo.me, "tang", 1);
		assert.match(await does(bo.p, "füttere tang", "mögen"), /Tang mögen Bienenvölker nicht; sie fressen Strandnelke, Dünenrose, Nebelblume, Hopfen/);
		await give(s, bo.me, "strandnelke", 2);
		assert.match(await does(bo.p, "füttere", "satt für"), /Blumenbo füttert die Bienenvölker von Imkerin mit 2 Strandnelke; satt für etwa 24 Stunden/);
		// six fed days: three pots per colony (the most that waits), and a lump of wax with every three
		await timePasses(s, hive.buildId, 6 * DAY);
		assert.match(await does(ida.p, "sammle honig", "sammelst"), /Du sammelst 6 Honig, 2 Wachs im Stall/);
		assert.equal(await pack(s, ida.me, "honig"), 6);
		assert.equal(await pack(s, ida.me, "wachs"), 2);
		// honey is food; wax and linen make candles at a hut
		assert.match(await does(ida.p, "iss honig", "Honig"), /Honig/);
		await ida.p.leave(); await bo.p.leave();
	} finally { await srv.close(); }
});

test("a pen of pigs: they eat potatoes, not kelp, and root up a truffle every third day while fed; two of them soon get a piglet", { timeout: 300_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const ole = await player(srv.url, "Schweineole"), bo = await player(srv.url, "Knollenbo");
		const accountId = String((await s.readAll({ type: "Character", fields: { charId: ole.me } }))[0]!.fields.accountId);
		const pen = await building(s, { buildId: "gehege-schwein", plan: "gehege", name: "Gehege", x: 4, y: 4, w: 3, h: 3, owner: ole.me, ownerName: ole.name, accountId, points: 2 });
		const taken = new Set<string>();
		await walkBeside(ole, s, pen, taken);
		await walkBeside(bo, s, pen, taken);
		await give(s, ole.me, "schwein", 2);
		await does(ole.p, "einstallen schwein", "(1 Schwein)");
		await does(ole.p, "einstallen schweine", "(2 Schweine)");
		await give(s, bo.me, "tang", 1);
		assert.match(await does(bo.p, "füttere tang", "mögen"), /Tang mögen Schweine nicht; sie fressen Kartoffel/);
		await give(s, bo.me, "kartoffel", 2);
		assert.match(await does(bo.p, "füttere", "satt für"), /Knollenbo füttert die Schweine von Schweineole mit 2 Kartoffel/);
		// six fed days: two truffles per pig, and a piglet (they breed every five days)
		await timePasses(s, pen.buildId, 6 * DAY);
		assert.match(await does(ole.p, "einsammeln", "sammelst"), /Du sammelst 4 Trüffel/);
		assert.equal(await pack(s, ole.me, "trueffel"), 4);
		assert.match(await does(ole.p, "stall", "Schwein"), /3 Schweine/);
		await ole.p.leave(); await bo.p.leave();
	} finally { await srv.close(); }
});

test("slaughtering: the owner with a knife takes one from the pen and gets what it gives; the last pair stays; bees, dogs and others' animals are not", { timeout: 300_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const ole = await player(srv.url, "Schlachterole"), bo = await player(srv.url, "Nachbarbo");
		const accountId = String((await s.readAll({ type: "Character", fields: { charId: ole.me } }))[0]!.fields.accountId);
		const pen = await building(s, { buildId: "gehege-schlacht", plan: "gehege", name: "Gehege", x: 4, y: 4, w: 3, h: 3, owner: ole.me, ownerName: ole.name, accountId, points: 2 });
		const taken = new Set<string>();
		await walkBeside(ole, s, pen, taken);
		await walkBeside(bo, s, pen, taken);
		await give(s, ole.me, "schwein", 3);
		for (let i = 1; i <= 3; i++) await does(ole.p, "einstallen schwein", `(${i} Schwein`);
		assert.match(await does(ole.p, "schlachte", "brauchst"), /Zum Schlachten brauchst du Schlachtmesser oder Muschelmesser/);
		await give(s, ole.me, "muschelmesser", 1);
		await give(s, bo.me, "muschelmesser", 1);
		assert.match(await does(bo.p, "schlachte schwein", "gehören"), /Die Tiere gehören Schlachterole; schlachten darf nur, wem der Stall gehört/);
		assert.match(await does(ole.p, "schlachte schaf", "leben"), /Im Stall leben Schweine/);
		assert.match(await does(ole.p, "schlachte hund", "wachen"), /Hund und Katze wachen über den Hof/);
		assert.match(await does(ole.p, "schlachte schwein", "bekommst"), /Du bekommst 3 Schweinefleisch, 2 Speckseiten, 1 Schmalz, 1 Borsten/);
		assert.equal(await pack(s, ole.me, "schweinefleisch"), 3);
		assert.equal(await pack(s, ole.me, "speckseite"), 2);
		assert.equal((await s.readAll({ type: "Item", fields: { location: pen.buildId, proto: "schwein" } })).length, 2);
		const knife = (await s.readAll({ type: "Item", fields: { location: ole.me, proto: "muschelmesser" } }))[0]!.fields as { wear?: number };
		assert.equal(knife.wear, (w.prototypes.find((p) => p.key === "muschelmesser")!.wear ?? 1) - 1, "the knife wears by one");
		assert.match(await does(ole.p, "schlachte", "Paar"), /Es leben nur 2 Schweine im Stall; das letzte Paar bleibt/);
		// a hive's colonies are not slaughtered
		const hive = await building(s, { buildId: "stock-schlacht", plan: "bienenstock", name: "Bienenstock", x: 16, y: 12, w: 1, h: 1, owner: ole.me, ownerName: ole.name, accountId });
		await walkBeside(ole, s, hive, taken);
		await give(s, ole.me, "bienenvolk", 3);
		for (let i = 1; i <= 3; i++) await does(ole.p, "einstallen bienenvolk", "Bienen");
		assert.match(await does(ole.p, "schlachte", "geschlachtet"), /Bienenvölker werden nicht geschlachtet/);
		await ole.p.leave(); await bo.p.leave();
	} finally { await srv.close(); }
});

test("the butcher's trade (docs/schlachten.en.md): a butcher's knife first, a butcher's shop gives more; young ones grow up in the pen, fresh meat spoils; salt from the salt garden; a leather bag carries more", { timeout: 300_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const ole = await player(srv.url, "Metzgerole");
		const accountId = String((await s.readAll({ type: "Character", fields: { charId: ole.me } }))[0]!.fields.accountId);
		const pen = await building(s, { buildId: "gehege-metzger", plan: "gehege", name: "Gehege", x: 4, y: 4, w: 3, h: 3, owner: ole.me, ownerName: ole.name, accountId, points: 2 });
		await building(s, { buildId: "metzgerei-1", plan: "metzgerei", name: "Metzgerei", x: 18, y: 4, w: 2, h: 2 });
		const taken = new Set<string>();
		await walkBeside(ole, s, pen, taken);
		// a piglet goes in like a pig and grows up there; it takes a place
		await give(s, ole.me, "schwein", 3);
		await give(s, ole.me, "ferkel", 2);
		for (let i = 1; i <= 3; i++) await does(ole.p, "einstallen schwein", `(${i} Schwein`);
		assert.match(await does(ole.p, "einstallen ferkel", "heran"), /bringt Ferkel in den Stall \(3 Schweine, 1 Jungtier\); es wächst dort heran/);
		assert.match(await does(ole.p, "einstallen ferkel", "voll"), /Der Stall ist voll \(4\)/);
		assert.match(await does(ole.p, "stall", "Platz"), /3 Schweine und 1 Jungtier \(Platz für 4\)/);
		// both knives: the butcher's knife is taken, and the shop in the room gives one more piece of the first yield
		await give(s, ole.me, "muschelmesser", 1);
		await give(s, ole.me, "schlachtmesser", 1);
		assert.match(await does(ole.p, "schlachte", "bekommst"), /Du bekommst 4 Schweinefleisch, 2 Speckseiten, 1 Schmalz, 1 Borsten, 1 Knochen\. Die Metzgerei im Ort zerlegt es gut/);
		const wearOf = async (proto: string) => ((await s.readAll({ type: "Item", fields: { location: ole.me, proto } }))[0]!.fields as { wear?: number }).wear;
		assert.equal(await wearOf("schlachtmesser"), w.prototypes.find((p) => p.key === "schlachtmesser")!.wear! - 1);
		assert.equal(await wearOf("muschelmesser"), w.prototypes.find((p) => p.key === "muschelmesser")!.wear, "the shell knife is spared");
		// fresh meat carries when it spoils; the piglet when it grows up. Their time come, the sweep turns them
		const meat = (await s.readAll({ type: "Item", fields: { location: ole.me, proto: "schweinefleisch" } }))[0]!.fields as { itemId: string; turns?: boolean; turnsAtMs?: number };
		const kept = await decayNowOf(s);
		assert.equal(meat.turns, true);
		assert.ok(Math.abs(meat.turnsAtMs! - kept - 3 * DAY) < 60_000, "raw meat keeps three days");
		assert.equal((await s.readAll({ type: "Item", fields: { location: ole.me, proto: "speck" } })).length, 0);
		await give(s, ole.me, "speck", 1);
		assert.equal(((await s.readAll({ type: "Item", fields: { location: ole.me, proto: "speck" } }))[0]!.fields as { turns?: boolean }).turns, undefined, "bacon keeps");
		const due = async (filter: Record<string, string>) => { for (const e of await s.readAll({ type: "Item", fields: filter })) { await s.takeIfExists({ id: e.id }, 0); await s.write({ type: "Item", fields: { ...e.fields, turnsAtMs: kept - 1 } as never }, null, FOREVER); } };
		await due({ location: ole.me, proto: "schweinefleisch" });
		await due({ location: pen.buildId, proto: "ferkel" });
		const from = ole.p.frames.length;
		await sweepTick(s, w);
		assert.equal(await pack(s, ole.me, "schweinefleisch"), 0, "the meat spoiled");
		assert.equal(await pack(s, ole.me, "speckseite"), 2, "what is not yet due stays");
		assert.equal((await s.readAll({ type: "Item", fields: { location: pen.buildId, proto: "ferkel" } })).length, 0);
		assert.equal((await s.readAll({ type: "Item", fields: { location: pen.buildId, proto: "schwein" } })).length, 3, "the piglet is a pig now");
		await ole.p.until((f) => f.t === "msg" && /Schweinefleisch ist verdorben; du wirfst es weg/.test(f.m.text), 10_000, from);
		// beside the butcher's shop: an animal one carries, no pair kept; nothing carried, it says where one comes from
		const shop = (await s.readAll({ type: "Building", fields: { buildId: "metzgerei-1" } }))[0]!.fields as never;
		await walkBeside(ole, s, shop, taken);
		assert.match(await does(ole.p, "schlachte", "trägst kein Tier"), /ausstallen/);
		await give(s, ole.me, "huhn", 1);
		assert.match(await does(ole.p, "schlachte huhn", "bekommst"), /Du bekommst 2 Hähnchen, 2 Federn\. Die Metzgerei im Ort zerlegt es gut/);
		assert.equal(await pack(s, ole.me, "huhn"), 0);
		// salt: beside a salt garden, without a tool
		const salt = await building(s, { buildId: "salzgarten-1", plan: "salzgarten", name: "Salzgarten", x: 16, y: 12, w: 2, h: 2 });
		await walkBeside(ole, s, salt, taken);
		assert.match(await does(ole.p, "harke", "Salz"), /harkst 3 Salz aus dem Salzgarten/);
		assert.equal(await pack(s, ole.me, "salz"), 3);
		// a leather bag adds to what one carries, once however many
		const base = await packMax(s, w, ole.me);
		await give(s, ole.me, "ledertasche", 2);
		assert.equal(await packMax(s, w, ole.me), base + w.pack!.bags!.ledertasche!);
		await ole.p.leave();
	} finally { await srv.close(); }
});

test("a coop: hens put in by the owner lay while fed, anyone feeds, the owner collects; a young one comes; a pen keeps one kind; demolition gives them back", { timeout: 300_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const anna = await player(srv.url, "Bäuerin"), bert = await player(srv.url, "Nachbar");
		const accountId = String((await s.readAll({ type: "Character", fields: { charId: anna.me } }))[0]!.fields.accountId);
		const coop = await building(s, { buildId: "stall-1", plan: "huehnerstall", name: "Hühnerstall", x: 16, y: 12, w: 2, h: 1, owner: anna.me, ownerName: anna.name, accountId });
		assert.match(await does(anna.p, "stall", "Stall"), /Geh direkt neben einen Stall \(Hühnerstall oder Gehege oder Bienenstock\)/);
		const taken = new Set<string>();
		await walkBeside(anna, s, coop, taken);
		await walkBeside(bert, s, coop, taken);
		assert.match(await does(anna.p, "einstallen", "Tier"), /Du trägst kein Tier/);
		await give(s, anna.me, "huhn", 3);
		await give(s, anna.me, "schaf", 1);
		assert.match(await does(anna.p, "einstallen schaf", "wohnen"), /Schafe wohnen im Gehege, nicht im Hühnerstall/);
		await give(s, bert.me, "huhn", 1);
		assert.match(await does(bert.p, "einstallen huhn", "Besitzer"), /einstallen darf nur der Besitzer/);
		for (let i = 1; i <= 3; i++) await does(anna.p, "einstallen huhn", `(${i} ${i === 1 ? "Huhn" : "Hühner"})`);
		assert.equal(await s.count({ type: "Item", fields: { location: coop.buildId, proto: "huhn" } }), 3, "the hens lie in the coop");
		assert.match(await does(anna.p, "stall", "Hühnerstall von"), /3 Hühner \(Platz für 6\), hungrig/);
		assert.match(await does(anna.p, "einsammeln", "Noch kein"), /Noch kein Ei bereit; sie sind hungrig/);

		// anyone feeds: what the hens eat, up to three days ahead
		await give(s, bert.me, "ruebe", 1);
		assert.match(await does(bert.p, "füttere rübe", "mögen"), /Rübe mögen Hühner nicht; sie fressen Tang/);
		await give(s, bert.me, "tang", 12);
		assert.match(await does(bert.p, "füttere", "satt für"), /Nachbar füttert die Hühner von Bäuerin mit 9 Tang; satt für etwa 72 Stunden/);
		assert.equal(await pack(s, bert.me, "tang"), 3, "only what fits");
		assert.match(await does(bert.p, "füttere tang", "satt"), /Die Hühner sind satt/);
		assert.match(await does(bert.p, "einsammeln", "sammelt"), /Was die Tiere von Bäuerin geben, sammelt Bäuerin/);

		// a fed day: an egg per hen, collected once
		await timePasses(s, coop.buildId, DAY);
		assert.match(await does(anna.p, "sammle eier", "sammelst"), /Du sammelst 3 Ei im Stall/);
		assert.equal(await pack(s, anna.me, "ei"), 3);
		assert.match(await does(anna.p, "einsammeln", "Noch kein"), /Noch kein Ei bereit; das nächste in etwa/);

		// fed long enough, two get a young one
		await timePasses(s, coop.buildId, kind("huhn").breedWorldMs);
		assert.match(await does(anna.p, "stall", "Hühnerstall von"), /4 Hühner/);
		assert.equal(await s.count({ type: "Item", fields: { location: coop.buildId, proto: "huhn" } }), 4);
		assert.match(await does(anna.p, "einsammeln", "sammelst"), /Du sammelst 9 Ei/, "the nest held three per hen");
		assert.match(await does(anna.p, "ausstallen", "nimmt"), /Bäuerin nimmt ein Huhn aus dem Stall/);
		assert.equal(await pack(s, anna.me, "huhn"), 1);

		// demolished: the hens come back into the pack
		assert.match(await does(anna.p, "abriss hühnerstall", "reißt"), /Aus der Truhe: 3 Dinge/);
		assert.equal(await pack(s, anna.me, "huhn"), 4);

		// a pen: sheep or goats, not both
		const pen = await building(s, { buildId: "gehege-1", plan: "gehege", name: "Gehege", x: 4, y: 4, w: 3, h: 3, owner: anna.me, ownerName: anna.name, accountId, points: 2 });
		await walkBeside(anna, s, pen, taken);
		await give(s, anna.me, "ziege", 1);
		await does(anna.p, "einstallen schaf", "(1 Schaf)");
		assert.match(await does(anna.p, "einstallen ziege", "schon"), /Hier stehen schon Schafe; eine Art je Stall/);
		// the last sheep out, the pen is empty again: geese come in, and the page sees them
		await does(anna.p, "ausstallen", "nimmt ein Schaf");
		assert.equal((await s.readAll({ type: "Building", fields: { buildId: pen.buildId } }))[0]!.fields.herd, undefined);
		await give(s, anna.me, "gans", 2);
		for (let i = 0; i < 2; i++) await does(anna.p, "einstallen gans", "in den Stall");
		await anna.p.until((f) => f.t === "obj" && f.o.kind === "building" && f.o.plan === "gehege" && f.o.herd === "gans", 10_000);
		await give(s, anna.me, "gerste", 2);
		assert.match(await does(anna.p, "füttere", "satt für"), /füttert die Gänse von Bäuerin mit 2 Gerste/);

		// what the farm gives, made on: cloth and a blanket at a loom, cheese at a hut's hearth
		const me = (await s.readAll({ type: "Character", fields: { charId: anna.me } }))[0]!.fields as unknown as { x: number; y: number };
		await give(s, anna.me, "wolle", 3);
		await give(s, anna.me, "spindel", 1);
		assert.match(await does(anna.p, "craft tuch", "nur direkt"), /Tuch macht man nur direkt neben einem Webstuhl/);
		await building(s, { buildId: "webstuhl-1", plan: "webstuhl", name: "Webstuhl", x: me.x + 1, y: me.y, w: 2, h: 1 });
		await does(anna.p, "craft tuch", "Tuch her");
		await give(s, anna.me, "tuch", 1);
		await give(s, anna.me, "daunen", 3);
		await does(anna.p, "craft decke", "Daunendecke her");
		assert.equal(await pack(s, anna.me, "decke"), 1);
		assert.equal(await pack(s, anna.me, "tuch"), 0);
		await give(s, anna.me, "milch", 3);
		await give(s, anna.me, "treibholz", 1);
		assert.match(await does(anna.p, "craft käse", "nur direkt"), /Käse macht man nur direkt neben einer Hütte/);
		await building(s, { buildId: "huette-1", plan: "huette", name: "Hütte", x: me.x - 2, y: me.y - 1, w: 2, h: 2 });
		await does(anna.p, "craft käse", "Käse her");
		assert.equal(await pack(s, anna.me, "kaese"), 1);
	} finally { await srv.close(); }
});
