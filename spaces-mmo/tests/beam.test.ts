// Beaming (engine/commands/beam.ts): from wherever one stands to a burning fire, for coins by the distance on the world map,
// with a pause after it; a dark fire cannot be reached, and nothing happens without the coins or while the pause lasts.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpaceLike } from "phi-spaces";
import { fieldsBetween } from "../server/engine/commands/beam.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { regionOfRoom } from "../server/engine/regions.ts";
import { eventually, lightFire, Player, startRegions, startServer, startWeb } from "./stack.ts";

const w = await loadWorld();

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

test("the distance between two rooms is the fields between them on the world map, at least one", () => {
	const room = (id: string) => w.rooms.find((r) => r.roomId === id);
	assert.equal(fieldsBetween(room("graue-bucht"), room("graue-bucht")), 1);
	assert.equal(fieldsBetween(room("graue-bucht"), room("anleger")), Math.abs(room("graue-bucht")!.map!.x - room("anleger")!.map!.x) + Math.abs(room("graue-bucht")!.map!.y - room("anleger")!.map!.y));
	assert.equal(fieldsBetween(undefined, room("anleger")), 1);
});

test("beam: to a burning fire from anywhere, for coins, with a pause", { timeout: 120_000 }, async () => {
	const srv = await startServer({ worldEnv: { SPACES_MMO_BEAM_EPOCH: "1" } });
	try {
		const s = srv.stack.space, p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Beamerin", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const cost = fieldsBetween(w.rooms.find((r) => r.roomId === "graue-bucht"), w.rooms.find((r) => r.roomId === "anleger"));
		const coins = async () => (await s.readAll({ type: "Item", fields: { location: me, proto: "muenze" } })).length;
		const roomNow = async () => (await s.readIfExists({ type: "Character", fields: { charId: me } }, 2_000))?.fields.room;
		assert.match(await does(p, "beam", "Hierhin kannst du"), /Anleger/);
		// the map's state carries the price per field
		await eventually(async () => p.frames.some((f) => f.t === "atlasState" && typeof f.state.beamCost === "number") || null, 10_000, "the atlas state with the beam cost");
		// and the epochs of the islands, for the header (an island that never left the first has no entry)
		assert.ok(p.frames.some((f) => f.t === "atlasState" && f.state.epochs !== null && typeof f.state.epochs === "object"), "the atlas state names the epochs");
		assert.match(await does(p, "beam anleger", "ist aus"), /Das Feuer in Anleger ist aus/);
		await lightFire(s, 3_600_000, "feuer-anleger");
		assert.match(await does(p, "beam anleger", "kostet"), new RegExp(`kostet ${cost} Münze`));
		assert.equal(await roomNow(), "graue-bucht", "nothing happened without the coins");
		await give(s, me, "muenze", cost + 1);
		await does(p, "beam anleger", /Anleger/);
		await eventually(async () => (await roomNow()) === "anleger", 10_000, "in the Anleger");
		assert.equal(await coins(), 1, "the coins are spent");
		assert.match(await does(p, "beam graue-bucht", "eben erst gebeamt"), /Minuten wieder/);
		assert.equal(await roomNow(), "anleger", "the pause holds");
		await p.leave();
	} finally { await srv.close(); }
});

test("beam to a fire in another region: the character goes over like on a ferry, with its coins spent", { timeout: 180_000 }, async () => {
	const r = await startRegions({ worldEnv: { SPACES_MMO_BEAM_EPOCH: "1" } });
	const srv = await startWeb({ port: 0, space: "unix:/nowhere", accounts: r.accounts, regions: r.list });
	try {
		const target = w.beacons.find((b) => regionOfRoom(w, b.room) !== "west")!, there = regionOfRoom(w, target.room)!;
		const from = w.rooms.find((x) => x.roomId === "graue-bucht"), to = w.rooms.find((x) => x.roomId === target.room);
		const cost = fieldsBetween(from, to);
		let me = "", p = new Player(srv.url);
		// guests start in the four bays in turn: the one that starts in the west plays
		for (let i = 0; i < 4 && !me; i++) {
			p = new Player(srv.url);
			assert.equal((await p.post("/api/guest")).status, 200);
			const h = await p.play();
			if (h.room.roomId === "graue-bucht") me = h.me.charId;
		}
		assert.ok(me, "a guest started in the west");
		await give(r.space("west"), me, "muenze", cost);
		assert.match(await does(p, `beam ${to!.name}`, /./), /./);
		await eventually(async () => (await r.space(there).readAll({ type: "Character", fields: { charId: me } })).length === 1, 30_000, `in the ${there} region`);
		assert.equal((await r.space(there).readAll({ type: "Character", fields: { charId: me } }))[0]!.fields.room, target.room);
		assert.equal((await r.space("west").readAll({ type: "Character", fields: { charId: me } })).length, 0, "gone from the west");
		assert.equal((await r.space(there).readAll({ type: "Item", fields: { location: me, proto: "muenze" } })).length, 0, "the coins are spent");
	} finally { await srv.close(); await r.close(); }
});
