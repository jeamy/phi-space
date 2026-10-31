// Stone and the workshop, step 5 part 2 (docs/siedeln.md, engine/commands/quarry.ts): a quarry gives stone for a pickaxe's
// wear and a rest; a workshop has recipes of its own, and a tool wears half as fast beside it.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import { worldNowOf } from "../server/engine/clock.ts";
import type { BuildingFields, CharacterFields, ItemFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, Player, startServer } from "./stack.ts";

const w = await loadWorld();
async function does(p: Player, line: string, text: string | RegExp, ms = 30_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
const give = async (s: SpaceLike, charId: string, proto: string, count: number) => { const p = (await eventually(() => resolvePrototype(s, proto), 10_000, proto))!; for (let i = 0; i < count; i++) await spawn(s, null, w, p, { location: charId, x: -1, y: -1 }); };
const pack = async (s: SpaceLike, charId: string, proto: string) => (await s.readAll({ type: "Item", fields: { location: charId, proto } })).map((e) => e.fields as unknown as ItemFields);
const building = (buildId: string, plan: string, name: string, x: number, y: number): BuildingFields => ({ buildId, plan, name, room: "graue-bucht", x, y, w: 2, h: 2, owner: "x", ownerName: "X", accountId: "x", beaconId: "feuer-bucht", points: 3, by: {}, untilWorldMs: FOREVER, builtAt: 0 });

test("stone: a pickaxe of rubble; a quarry gives three for its wear and a rest; a workshop has its recipes and spares the tool", { timeout: 120_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Hauer", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const c = (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0], 10_000, "Hauer"))!.fields as unknown as CharacterFields;
		await give(s, me, "treibholz", 10);
		await give(s, me, "stein", 2);
		await give(s, me, "tangseil", 4);
		await give(s, me, "muschel", 2);

		assert.match(await does(p, "breche", "direkt neben"), /Stein bricht man direkt neben einem Steinbruch/);
		await s.write({ type: "Building", fields: building("quarry", "steinbruch", "Steinbruch", c.x + 1, c.y) as never }, null, FOREVER);
		assert.match(await does(p, "breche", "Werkzeug"), /Werkzeug: spitzhacke/);
		await does(p, "craft spitzhacke", "Spitzhacke her");
		assert.equal((await pack(s, me, "spitzhacke"))[0]!.wear, 6);
		assert.match(await does(p, "breche", "aus dem Fels"), /Du brichst 3 Stein aus dem Fels/);
		assert.equal((await pack(s, me, "stein")).length, 3);
		assert.equal((await pack(s, me, "spitzhacke"))[0]!.wear, 5);
		assert.match(await does(p, "breche", "müde"), /noch müde von der letzten Arbeit/);
		assert.equal((await pack(s, me, "stein")).length, 3, "a tired figure breaks nothing");

		// the workshop: a recipe of its own; a knife wears by a half beside it
		assert.match(await does(p, "craft 2 bohlen", "nur direkt"), /Bohle macht man nur direkt neben einer Werkstatt/);
		await s.write({ type: "Building", fields: building("shop", "werkstatt", "Werkstatt", c.x - 2, c.y) as never }, null, FOREVER);
		await does(p, "craft muschelmesser", "Muschelmesser her");
		assert.equal((await pack(s, me, "muschelmesser"))[0]!.wear, 5);
		await does(p, "craft 2 bohlen", "2 Bohle her");
		assert.equal((await pack(s, me, "muschelmesser"))[0]!.wear, 4, "two uses, one wear");
		await does(p, "craft tauwerk", "Tauwerk her");
		assert.equal((await pack(s, me, "tauwerk")).length, 1);
	} finally { await srv.close(); }
});

test("clay and bricks: a spade cuts clay and stays whole; a brickworks burns it", { timeout: 120_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Lehmer", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const c = (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0], 10_000, "Lehmer"))!.fields as unknown as CharacterFields;
		await give(s, me, "treibholz", 2);
		assert.match(await does(p, "steche", "direkt neben"), /Lehm sticht man direkt neben einer Lehmgrube/);
		await s.write({ type: "Building", fields: building("pit", "lehmgrube", "Lehmgrube", c.x + 1, c.y) as never }, null, FOREVER);
		assert.match(await does(p, "steche", "Werkzeug"), /Werkzeug: spaten/);
		await give(s, me, "spaten", 1);
		assert.match(await does(p, "steche", "aus der Grube"), /Du stichst 3 Lehm aus der Grube/);
		assert.equal((await pack(s, me, "spaten")).length, 1, "the spade stays");
		assert.match(await does(p, "craft ziegel", "nur direkt"), /Ziegel macht man nur direkt neben einer Ziegelei/);
		await s.write({ type: "Building", fields: building("kiln", "ziegelei", "Ziegelei", c.x - 2, c.y) as never }, null, FOREVER);
		await does(p, "brenne ziegel", /Ziegel/);
		await eventually(async () => (await pack(s, me, "ziegel")).length === 3, 10_000, "three bricks");
		assert.equal((await pack(s, me, "lehm")).length, 0);
	} finally { await srv.close(); }
});

test("a chapel: an offering of worth gives a blessing, and the rest after work is half as long", { timeout: 120_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Opfernde", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const c = (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0], 10_000, "Opfernde"))!.fields as unknown as CharacterFields;
		await give(s, me, "perle", 1);
		await give(s, me, "treibholz", 1);
		await give(s, me, "spaten", 1);
		assert.match(await does(p, "opfere perle", "direkt neben"), /nur direkt neben einer Kapelle/);
		await s.write({ type: "Building", fields: building("chapel", "kapelle", "Kapelle", c.x + 1, c.y) as never }, null, FOREVER);
		await s.write({ type: "Building", fields: building("pit", "lehmgrube", "Lehmgrube", c.x - 2, c.y) as never }, null, FOREVER);
		assert.match(await does(p, "opfere treibholz", "kein Opfer"), /Treibholz ist kein Opfer/);
		await does(p, "opfere perle", "Segen");
		assert.equal((await pack(s, me, "perle")).length, 0);
		await does(p, "steche", "aus der Grube");
		const clock = (await s.readAll({ type: "WorkRest", fields: { charId: me } }))[0]!.fields as unknown as { untilWorldMs: number };
		const until = clock.untilWorldMs - (await worldNowOf(s)), rest = w.building!.restWorldMs;
		assert.ok(until <= rest / 2 && until > rest / 4, `${until} of ${rest}`);
	} finally { await srv.close(); }
});
