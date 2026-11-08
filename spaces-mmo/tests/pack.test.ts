// What a figure carries (engine/pack.ts, docs/siedeln.en.md "Load"): 40 load, a thing by its kind; what would take the
// pack over it is refused, what others bring arrives anyway, an overloaded figure still lays things down; one's chests
// take things from anywhere (one beside, the only one, or by number), a chest in another region by courier (courier.ts).
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { worldNowOf } from "../server/engine/clock.ts";
import { eventually, Player, startRegions, startServer, startWeb } from "./stack.ts";

// the web part runs in this process and reads the setting too (the other suites carry far more: tests/test-env.ts)
process.env.SPACES_MMO_PACK_MAX = "40";
const w = await loadWorld();
async function does(p: Player, line: string, text: string | RegExp, ms = 40_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
async function give(space: SpaceLike, location: string, proto: string, count: number, at = { x: -1, y: -1 }): Promise<void> {
	const p = (await eventually(() => resolvePrototype(space, proto), 10_000, `prototype ${proto}`))!;
	for (let i = 0; i < count; i++) await spawn(space, null, w, p, { location, ...at });
}
const pack = async (space: SpaceLike, charId: string, proto: string) => (await space.readAll({ type: "Item", fields: { location: charId, proto } })).length;
const charOf = async (space: SpaceLike, charId: string) => (await space.readAll({ type: "Character", fields: { charId } }))[0]!.fields as { accountId: string; room: string; x: number; y: number };
async function hut(space: SpaceLike, buildId: string, owner: string, accountId: string, room: string, x: number, y: number): Promise<void> {
	const now = await worldNowOf(space);
	await space.write({ type: "Building", fields: { buildId, plan: "huette", name: "Hütte", room, x, y, w: 2, h: 2, owner, ownerName: "Trägerin", accountId, beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: now + 7 * 24 * 3600_000, builtAt: now } as never }, null, FOREVER);
}

test("load: 40 at most, what would go over is refused, what others bring arrives, an overloaded figure lays down; a chest by number", { timeout: 180_000 }, async () => {
	const srv = await startServer({ worldEnv: { SPACES_MMO_PACK_MAX: "40" } });
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Trägerin", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const c = await charOf(s, me);
		// 19 driftwood: 38; coins weigh nothing
		await give(s, me, "treibholz", 19);
		await give(s, me, "muenze", 30);
		await give(s, c.room, "muschel", 3, { x: c.x, y: c.y });
		await give(s, c.room, "treibholz", 1, { x: c.x, y: c.y });
		// two shells (½ each) fit, the third too: 39½; a driftwood (2) does not
		for (let i = 0; i < 3; i++) await does(p, "get muschel", "hebst");
		assert.match(await does(p, "get treibholz", "trägst du nicht mehr"), /wöge 41½ von 40/);
		assert.equal(await pack(s, me, "treibholz"), 19, "refused: still on the ground");
		// what another brings arrives anyway (here: written into the pack, as a delivery is): over the limit now
		await give(s, me, "stein", 2);
		assert.match(await does(p, "get treibholz", "trägst du nicht mehr"), /von 40/);
		// over the limit it still lays down, and then picks up again what fits
		await does(p, "drop stein", "legst");
		await does(p, "drop stein", "legst");
		assert.match(await does(p, "get treibholz", /trägst du nicht mehr|hebst/), /trägst du nicht mehr/, "39½ + 2 is still over");

		// chests: none yet; two huts, neither beside: it asks which; by number from afar
		assert.match(await does(p, "verstaue 1 muschel", "Truhe"), /keine Truhe/);
		await hut(s, "h-a", me, c.accountId, c.room, c.x + 6, c.y);
		await hut(s, "h-b", me, c.accountId, "anleger", 4, 4);
		const which = await does(p, "verstaue 1 muschel", "welche Truhe");
		assert.match(which, new RegExp(`1 Hütte \\(Anleger\\), 2 Hütte \\(${w.rooms.find((x) => x.roomId === c.room)!.name}\\)`));
		assert.match(await does(p, "leg 5 treibholz in die truhe 2", "Du legst"), new RegExp(`Du legst 5 Treibholz in die Truhe deiner Hütte \\(${w.rooms.find((x) => x.roomId === c.room)!.name}\\)`));
		assert.equal((await s.readAll({ type: "Item", fields: { location: "h-a", proto: "treibholz" } })).length, 5);
		assert.match(await does(p, "verstaue alle muscheln in anleger", "Du legst"), /Du legst 3 Muschel in die Truhe deiner Hütte \(Anleger\)/);
		// a chest takes everything: all 34 driftwood go in, and the light pack picks up again
		await give(s, me, "treibholz", 20);
		assert.match(await does(p, "verstaue alle treibholz in 2", "Du legst"), /^Du legst 34 Treibholz in die Truhe deiner Hütte \([^)]+\)\.$/);
		assert.equal((await s.readAll({ type: "Item", fields: { location: "h-a", proto: "treibholz" } })).length, 39);
		assert.match(await does(p, "get treibholz", "hebst"), /hebst/);
		// the page shows the load
		const st = await p.until((f) => f.t === "atlasState" && f.state.packMax === 40, 20_000, 0);
		assert.ok(st);
	} finally { await srv.close(); }
});

test("load: a chest in another region is filled by a courier", { timeout: 240_000 }, async () => {
	const r = await startRegions({ worldEnv: { SPACES_MMO_PACK_MAX: "40" } });
	const srv = await startWeb({ port: 0, space: "unix:/nowhere", accounts: r.accounts, regions: r.list });
	try {
		// a player in some region, a hut of its own in another
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Trägerin", password: "geheim-123" })).status, 200);
		const h = await p.play();
		const me = h.me.charId, here = r.ids.find((id) => (w.regions ?? []).find((g) => g.regionId === id)!.islands.includes(w.rooms.find((x) => x.roomId === h.room.roomId)!.island ?? ""))!;
		const there = r.ids.find((id) => id !== here)!, far = w.rooms.find((x) => (w.regions ?? []).find((g) => g.regionId === there)!.islands.includes(x.island ?? ""))!;
		const s = r.space(here), t = r.space(there);
		const c = await charOf(s, me);
		await hut(t, "h-far", me, c.accountId, far.roomId, 1, 1);
		await give(s, me, "muschel", 4);
		assert.match(await does(p, "verstaue 3 muscheln", "Bote"), new RegExp(`Ein Bote bringt 3 Muschel in die Truhe deiner Hütte \\(${far.name}\\)`));
		await eventually(async () => (await t.readAll({ type: "Item", fields: { location: "h-far" } })).length === 3, 30_000, "the shells in the far chest");
		assert.equal(await pack(s, me, "muschel"), 1);
		await eventually(async () => !(await s.readAll({ type: "Courier" })).length && !(await s.readAll({ type: "Item", fields: { proto: "muschel" } })).some((e) => String(e.fields.location).startsWith("cou-")), 30_000, "the courier done");
	} finally { await srv.close(); await r.close(); }
});
