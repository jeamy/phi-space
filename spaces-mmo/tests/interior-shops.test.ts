// The bakehouse and the butcher's shop from inside (docs/innenraeume.en.md step 3): the bakehouse's recipes at its oven,
// not away from it; at the butcher's block an animal one carries is slaughtered; its pickling barrel is its chest.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { worldNowOf } from "../server/engine/clock.ts";
import { eventually, Player, startServer } from "./stack.ts";

const w = await loadWorld();
async function does(p: Player, line: string, text: string | RegExp, ms = 20_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
async function give(space: SpaceLike, location: string, proto: string, count: number): Promise<void> {
	const p = (await eventually(() => resolvePrototype(space, proto), 10_000, `prototype ${proto}`))!;
	for (let i = 0; i < count; i++) await spawn(space, null, w, p, { location, x: -1, y: -1 });
}
const charOf = async (space: SpaceLike, charId: string) => (await eventually(async () => (await space.readAll({ type: "Character", fields: { charId } }))[0] ?? null, 10_000, `character ${charId}`))!.fields as { accountId: string; room: string; x: number; y: number };
async function walk(p: Player, space: SpaceLike, charId: string, x: number, y: number): Promise<void> {
	p.send(`move ${x} ${y}`);
	await eventually(async () => { const f = await charOf(space, charId); return f.x === x && f.y === y ? f : null; }, 10_000, `${charId} at ${x} ${y}`);
}
const carried = async (space: SpaceLike, charId: string, proto: string) => (await space.readAll({ type: "Item", fields: { location: charId, proto } })).length;

test("inside the bakehouse and the butcher's shop: bake at the oven, slaughter at the block, the pickling barrel is the chest", { timeout: 180_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Baeckerin", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		// after the page's „arrive“ (a settler on its cell moves it): where it really stands
		await does(p, "look", /./);
		const c = await charOf(s, me);
		const now = await worldNowOf(s);
		const build = (buildId: string, plan: string, name: string, x: number) => s.write({ type: "Building", fields: { buildId, plan, name, room: c.room, x, y: c.y - 1, w: 2, h: 2, owner: me, ownerName: "Baeckerin", accountId: c.accountId, beaconId: "feuer-bucht", points: 2, by: {}, untilWorldMs: now + 7 * 24 * 3600_000, builtAt: now } as never }, null, FOREVER);
		await build("b-back", "backhaus", "Backhaus", c.x + 1);
		await build("b-metz", "metzgerei", "Metzgerei", c.x - 2);

		// the bakehouse: its inside, the cake away from the oven refused, beside it made
		assert.match(await does(p, "betrete backhaus", "Du kommst herein"), /./);
		assert.equal((await charOf(s, me)).room, "in-b-back");
		assert.deepEqual((await s.readAll({ type: "Scenery", fields: { room: "in-b-back" } })).map((e) => String(e.fields.model)).sort(), ["backtrog", "ofen"]);
		assert.match(String((await s.readAll({ type: "Room", fields: { roomId: "in-b-back" } }))[0]!.fields.desc), /^Drinnen im Backhaus/);
		await give(s, me, "ei", 3); await give(s, me, "mehl", 2); await give(s, me, "milch", 1); await give(s, me, "honig", 1);
		assert.match(await does(p, "craft kuchen", "Ofen"), /geh zu ihm/);
		await walk(p, s, me, 2, 2);
		await does(p, "craft kuchen", "Kuchen");
		assert.equal(await carried(s, me, "kuchen"), 1);
		await does(p, "hinaus", /kommst an/);

		// the butcher's shop: a carried hen at the block, the barrel as its chest
		await walk(p, s, me, c.x, c.y);
		await does(p, "betrete metzgerei", "Du kommst herein");
		assert.equal((await charOf(s, me)).room, "in-b-metz");
		assert.deepEqual((await s.readAll({ type: "Scenery", fields: { room: "in-b-metz" } })).map((e) => String(e.fields.model)).sort(), ["hackklotz", "haken", "poekelfass"]);
		await give(s, me, "schlachtmesser", 1); await give(s, me, "huhn", 1);
		await walk(p, s, me, 3, 3);
		await does(p, "schlachte huhn", "Huhn");
		await eventually(async () => ((await carried(s, me, "huhn")) === 0 ? true : null), 10_000, "the hen slaughtered");
		assert.ok((await carried(s, me, "huehnchen")) >= 1, "its meat in the pack");
		await give(s, me, "muschel", 1);
		await does(p, "verstaue 1 muschel", "Metzgerei");
		assert.equal((await s.readAll({ type: "Item", fields: { location: "b-metz", proto: "muschel" } })).length, 1);
		await walk(p, s, me, 4, 3);
		await does(p, "truhe", "Muschel");
		await p.leave();
	} finally { await srv.close(); }
});
