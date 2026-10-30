// Animals on the farm, step 3 part 3 (docs/siedeln.md "Tiere auf dem Hof", engine/commands/animals.ts): hens put into a
// coop give eggs only while fed; anyone feeds, only the owner puts in, takes out and collects; two fed ones get a young
// one; a pen keeps one kind; demolition gives the animals back.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { herdNow } from "../server/engine/commands/animals.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld, walkable } from "../server/engine/world.ts";
import { worldNowOf } from "../server/engine/clock.ts";
import type { BuildingFields, HerdFields } from "../server/model.ts";
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

test("a coop: hens put in by the owner lay while fed, anyone feeds, the owner collects; a young one comes; a pen keeps one kind; demolition gives them back", { timeout: 300_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const anna = await player(srv.url, "Bäuerin"), bert = await player(srv.url, "Nachbar");
		const accountId = String((await s.readAll({ type: "Character", fields: { charId: anna.me } }))[0]!.fields.accountId);
		const coop = await building(s, { buildId: "stall-1", plan: "huehnerstall", name: "Hühnerstall", x: 16, y: 12, w: 2, h: 1, owner: anna.me, ownerName: anna.name, accountId });
		assert.match(await does(anna.p, "stall", "Stall"), /Geh direkt neben einen Stall \(Hühnerstall oder Gehege\)/);
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
	} finally { await srv.close(); }
});
