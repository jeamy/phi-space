// What the workshop makes of planks (docs/siedeln.en.md "Trees", help "Planks from logs"): a log is driftwood and a log
// (ItemFields.of), so one log makes a whole plank while a driftwood recipe takes real driftwood first; a barrel or a crate
// in a building's chest keeps things fresh twice as long, once (sweep.ts); a table in a house's chest makes a meal inside
// sate longer (food.ts); shutters in a chest hold a building whose term ran out half as long again (build.ts buildSweep).
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { decayNowOf, worldNowOf } from "../server/engine/clock.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { sweepTick } from "../server/engine/sweep.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { ItemFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, Player, startServer } from "./stack.ts";

const w = await loadWorld();
const H = 3600_000, D = 24 * H;

async function does(p: Player, line: string, text: string | RegExp, ms = 30_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
async function give(space: SpaceLike, location: string, proto: string, count = 1): Promise<ItemFields[]> {
	const p = (await eventually(() => resolvePrototype(space, proto), 10_000, `prototype ${proto}`))!;
	const out: ItemFields[] = [];
	for (let i = 0; i < count; i++) out.push(await spawn(space, null, w, p, { location, x: -1, y: -1 }));
	return out;
}
const items = async (space: SpaceLike, location: string) => (await space.readAll({ type: "Item", fields: { location } })).map((e) => e.fields as unknown as ItemFields);
/** Lets a thing's time to turn have come. */
async function due(space: SpaceLike, itemId: string, at: number): Promise<void> {
	const e = (await space.takeIfExists({ type: "Item", fields: { itemId } }, 5_000))!;
	await space.write({ type: e.type, types: e.types.slice(1), fields: { ...e.fields, turnsAtMs: at } as never }, null, FOREVER);
}
const building = (buildId: string, plan: string, name: string, room: string, x: number, y: number, ww: number, hh: number, owner: string, accountId: string, until: number) =>
	({ type: "Building", fields: { buildId, plan, name, room, x, y, w: ww, h: hh, owner, ownerName: "Tischler", accountId, beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: until, builtAt: 0 } as never });

test("planks: a log makes a whole plank, driftwood goes first; a barrel and a crate keep things fresh once; a table sates longer inside; shutters hold a building", { timeout: 240_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Tischler", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const c = (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0]?.fields, 10_000, "the character")) as { room: string; x: number; y: number; accountId: string };
		const kept = await decayNowOf(s);

		// a log is driftwood and a log
		const [log] = await give(s, me, "scheit", 2);
		assert.deepEqual([log!.proto, log!.of, log!.name], ["treibholz", "scheit", "Scheit"]);
		await give(s, me, "treibholz", 2);
		await give(s, me, "muschelmesser", 1);
		await s.write(building("w-1", "werkstatt", "Werkstatt", c.room, c.x + 1, c.y - 1, 3, 2, "c-x", "a-x", kept + 30 * D));
		assert.match(await does(p, "craft bohle", "Bohle"), /Bohle/);
		assert.deepEqual((await items(s, me)).filter((i) => i.proto === "treibholz").map((i) => i.name), ["Scheit", "Scheit"], "driftwood went first, the logs are left");
		assert.match(await does(p, "craft 2 scheitbohle", "Bohle"), /Bohle/);
		assert.equal((await items(s, me)).filter((i) => i.proto === "bohle").length, 3, "one plank of two driftwood, two of two logs");
		assert.equal((await items(s, me)).filter((i) => i.proto === "treibholz").length, 0);
		assert.match(await does(p, "craft scheitbohle", "fehlt"), /Dir fehlt: 1× scheit/);

		// a barrel keeps juice once; without one it spoils
		await s.write(building("h-tisch", "huette", "Hütte", c.room, c.x - 3, c.y - 1, 2, 2, me, c.accountId, kept + 30 * D));
		await s.write(building("h-leer", "huette", "Hütte", c.room, c.x - 3, c.y + 2, 2, 2, "c-x", "a-x", kept + 30 * D));
		await give(s, "h-tisch", "fass");
		const [keptJuice] = await give(s, "h-tisch", "apfelsaft");
		const [lostJuice] = await give(s, "h-leer", "apfelsaft");
		const [carried] = await give(s, me, "apfelsaft");
		const now = await decayNowOf(s), after = w.prototypes.find((x) => x.key === "apfelsaft")!.turns!.afterMs;
		for (const it of [keptJuice!, lostJuice!, carried!]) await due(s, it.itemId, now - 1);
		await sweepTick(s, w);
		const juice = await eventually(async () => (await items(s, "h-tisch")).find((i) => i.itemId === keptJuice!.itemId && i.kept), 10_000, "the juice kept");
		assert.equal(juice!.turnsAtMs, now - 1 + after, "it turns once its time again later");
		assert.equal((await items(s, "h-leer")).length, 0, "without a barrel it spoils");
		assert.equal((await items(s, me)).filter((i) => i.proto === "apfelsaft").length, 0, "carried, a barrel elsewhere does not keep it");
		await due(s, keptJuice!.itemId, now - 1);
		await sweepTick(s, w);
		await eventually(async () => !(await items(s, "h-tisch")).some((i) => i.itemId === keptJuice!.itemId), 10_000, "kept only once");
		// a crate keeps apples, not juice
		await give(s, "h-leer", "obstkiste");
		const [apple] = await give(s, "h-leer", "apfel");
		const [juice2] = await give(s, "h-leer", "apfelsaft");
		for (const it of [apple!, juice2!]) await due(s, it.itemId, now - 1);
		await sweepTick(s, w);
		const left = await items(s, "h-leer");
		assert.ok(left.some((i) => i.itemId === apple!.itemId && i.kept), "the crate keeps the apple");
		assert.ok(!left.some((i) => i.itemId === juice2!.itemId), "but not the juice");

		// a table in the house's chest: a meal inside sates a quarter longer
		await give(s, "h-tisch", "tisch");
		await give(s, me, "apfel", 2);
		await does(p, "iss apfel", "isst");
		const sated = async () => Number((await s.readAll({ type: "Sated", fields: { charId: me } }))[0]!.fields.untilWorldMs);
		const outside = (await sated()) - (await worldNowOf(s));
		assert.ok(outside <= w.food!.foods.apfel! && outside > w.food!.foods.apfel! - H, `outside: an apple's time (${outside})`);
		await s.take({ type: "Sated", fields: { charId: me } }, 5_000);
		p.send(`move ${c.x - 2} ${c.y + 1}`);
		await does(p, "betrete", "Du kommst herein");
		assert.match(await does(p, "iss apfel", "isst"), /am Tisch/);
		const inside = (await sated()) - (await worldNowOf(s));
		assert.ok(inside > w.food!.foods.apfel! * 1.2 && inside <= w.food!.foods.apfel! * 1.25, `inside at the table: a quarter longer (${inside})`);

		// shutters hold a building whose term ran out half as long again, once
		const keep = (w.building!.plans.find((x) => x.key === "huette")!.keepWorldMs);
		await s.write(building("h-laden", "huette", "Hütte", c.room, c.x + 4, c.y + 3, 2, 2, "c-x", "a-x", now - 1));
		await give(s, "h-laden", "fensterlaeden");
		await sweepTick(s, w);
		const held = await eventually(async () => (await s.readAll({ type: "Building", fields: { buildId: "h-laden" } }))[0]?.fields as { untilWorldMs: number } | undefined, 10_000, "the building held");
		assert.ok(held!.untilWorldMs > now + keep * 0.4, "it stands half its term again");
		assert.equal((await items(s, "h-laden")).length, 0, "the shutters are used up");
	} finally { await srv.close(); }
});
