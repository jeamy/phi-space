// The world file of Leuchtfeuer on its own (no processes, but for the last test, which loads it into a space): big enough, every room reachable over its exits, every way
// inside a room walkable, every NPC, thing and fire on a cell of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER } from "phi-spaces";
import { loadIntoSpace } from "../server/engine/loader.ts";
import { findPath, loadWorld, walkable, wayTo, worldAsset } from "../server/engine/world.ts";
import { actorToken } from "../server/model.ts";
import { startStack } from "./stack.ts";

const w = await loadWorld();
const roomOf = (id: string) => w.rooms.find((r) => r.roomId === id)!;

test("the archipelago: at least ten times the first two rooms, eight islands, every room on the overview", () => {
	const cells = w.rooms.reduce((s, r) => s + r.ground.length * r.ground[0]!.length, 0);
	assert.ok(cells >= 10 * 2 * 24 * 16, `${cells} cells`);
	assert.equal(new Set(w.rooms.map((r) => r.island)).size, 8);
	for (const r of w.rooms) assert.ok(r.map && r.island, r.roomId);
	assert.ok(w.npcs.length >= 15, `${w.npcs.length} NPCs`);
	assert.equal(new Set(w.npcs.map((n) => n.npcId)).size, w.npcs.length, "every NPC has its own id");
	assert.equal(new Set(w.npcs.map((n) => n.name)).size, w.npcs.length, "and its own name");
	assert.equal(w.market.rooms.length, 6);
});

test("every room is reached from the start over exits, and every exit leads back", () => {
	const seen = new Set([w.start]), todo = [w.start];
	for (let at = todo.pop(); at; at = todo.pop()) for (const e of w.exits.filter((x) => x.room === at)) if (!seen.has(e.destination)) { seen.add(e.destination); todo.push(e.destination); }
	assert.deepEqual([...seen].sort(), w.rooms.map((r) => r.roomId).sort());
	for (const e of w.exits) assert.ok(w.exits.some((b) => b.room === e.destination && b.destination === e.room), `${e.exitId} has a way back`);
});

test("inside every room: from where one arrives to every exit and next to every fire, NPCs and things on free cells", () => {
	for (const r of w.rooms) {
		const exits = w.exits.filter((e) => e.room === r.roomId);
		const fires = w.beacons.filter((b) => b.room === r.roomId);
		const solid = new Set(fires.map((b) => `${b.x},${b.y}`));
		const starts = [r.spawn, ...w.exits.filter((e) => e.destination === r.roomId).map((e) => e.arrive)];
		for (const from of starts) {
			for (const e of exits) assert.ok(findPath(w, r.ground, from, e, 200, solid), `${r.roomId}: ${from.x},${from.y} to exit ${e.name}`);
			for (const b of fires) assert.ok([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => findPath(w, r.ground, from, { x: b.x + dx!, y: b.y + dy! }, 200, solid)), `${r.roomId}: next to ${b.beaconId}`);
		}
		const taken = new Map<string, string>();
		const place = (what: string, x: number, y: number) => {
			const k = `${x},${y}`;
			assert.ok(walkable(w, r.ground, x, y), `${what} in ${r.roomId} on a walkable cell`);
			assert.ok(!taken.has(k), `${what} and ${taken.get(k)} on one cell of ${r.roomId}`);
			taken.set(k, what);
		};
		for (const e of exits) place(`exit ${e.exitId}`, e.x, e.y);
		for (const b of fires) place(b.beaconId, b.x, b.y);
		for (const n of w.npcs.filter((n) => n.room === r.roomId)) place(`npc ${n.npcId}`, n.x, n.y);
		for (const o of w.objects.filter((o) => o.room === r.roomId)) place(o.itemId, o.x, o.y);
	}
});

test("no one is caught in the fog: every room has a fire that keeps it clear, and a way to it", () => {
	for (const r of w.rooms) {
		const fires = w.beacons.filter((b) => b.covers.includes(r.roomId));
		assert.ok(fires.length, `${r.roomId} has a fire`);
		assert.ok(fires.some((b) => b.room === r.roomId || wayTo(w, r.roomId, b.room)), `${r.roomId} reaches its fire`);
	}
});

test("plants grow on grass only, off paths, doors, people, fires and things, and their cuts lie inside their sheet", () => {
	for (const [k, d] of Object.entries(w.decor ?? {})) {
		const png = worldAsset(w.id, d.sheet)!.body;
		assert.ok(d.x + d.w <= png.readUInt32BE(16) && d.y + d.h <= png.readUInt32BE(20), `decor ${k} inside ${d.sheet}`);
	}
	let grown = 0;
	for (const r of w.rooms) {
		const near = (c: { x: number; y: number }, x: number, y: number) => Math.abs(c.x - x) <= 1 && Math.abs(c.y - y) <= 1;
		const keep = [r.spawn, ...w.exits.filter((e) => e.room === r.roomId), ...w.exits.filter((e) => e.destination === r.roomId).map((e) => e.arrive),
			...w.beacons.filter((b) => b.room === r.roomId), ...w.npcs.filter((n) => n.room === r.roomId), ...w.objects.filter((o) => o.room === r.roomId)];
		r.decor!.forEach((row, y) => [...row].forEach((k, x) => {
			if (k === " ") return;
			grown++;
			assert.equal(r.ground[y]![x], ",", `${r.roomId} ${x},${y}: ${k} on grass`);
			assert.ok(!keep.some((c) => near(c, x, y)), `${r.roomId} ${x},${y}: ${k} keeps clear`);
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) assert.notEqual(r.ground[y + dy]?.[x + dx], ":", `${r.roomId} ${x},${y}: ${k} beside a path`);
		}));
	}
	assert.ok(grown > 200, `${grown} plants`);
	// the start rooms keep their ground: the plants only lie over it
	assert.equal(roomOf("graue-bucht").ground[10], ",,,.....:..:....,,,,,,,,");
});

test("every thing but the plain one has a picture, a 32x32 PNG in the world's assets", () => {
	for (const p of w.prototypes.filter((p) => p.key !== "ding")) {
		assert.ok(p.icon, `${p.key} has an icon`);
		const png = worldAsset(w.id, p.icon!)!.body;
		assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [32, 32], `${p.icon} is 32x32`);
	}
});

test("the first two rooms stay as they were (the tests of earlier phases stand on their cells)", () => {
	assert.equal(roomOf("graue-bucht").ground[10], ",,,.....:..:....,,,,,,,,");
	assert.deepEqual(roomOf("graue-bucht").spawn, { x: 10, y: 8 });
	assert.deepEqual(w.beacons.find((b) => b.beaconId === "feuer-bucht")!.covers, ["graue-bucht", "klippenpfad"]);
	const e = w.exits.find((x) => x.exitId === "bucht-ost")!;
	assert.deepEqual([e.x, e.y, e.arrive.x, e.arrive.y], [23, 8, 1, 8]);
});

test("loading a newer version takes out an NPC the world no longer has; what it carried lies where it stood", async () => {
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space;
		await loadIntoSpace(s, w);
		const charId = "npc-gone", now = Date.now();
		await s.write({ type: "Account", fields: { accountId: charId, name: "Gone", guest: false, admin: false, npc: true, createdAt: now, touchedAt: now } }, null, FOREVER);
		await s.write({ type: "Character", fields: { charId, accountId: charId, name: "Gone", room: "duenen", x: 5, y: 5, skin: 0, guest: false } }, null, FOREVER);
		await s.write(actorToken(charId), null, FOREVER);
		await s.write({ type: "Item", fields: { itemId: "gone-coin", name: "Münze", aliases: [], desc: "", location: charId, x: -1, y: -1, glyph: { shape: "circle", color: "#fff" }, locks: "", proto: "muenze" } }, null, FOREVER);
		await loadIntoSpace(s, w, { replace: true });
		assert.equal(await s.count({ type: "Character", fields: { charId } }), 0);
		assert.equal(await s.count({ type: "Account", fields: { accountId: charId } }), 0);
		assert.equal(await s.count({ type: "ActorToken", fields: { charId } }), 0);
		assert.deepEqual((await s.readIfExists({ type: "Item", fields: { itemId: "gone-coin" } }, 1_000))?.fields.location, "duenen");
		assert.equal(await s.count({ type: "Character", fields: { charId: "npc-ines" } }), 1, "the world's NPCs stay");
	} finally { await stack.close(); }
});
