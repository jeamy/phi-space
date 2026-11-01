// Festivals and the park (docs/siedeln.en.md "Parks", engine/commands/festival.ts): a settler opens a show beside a park, the
// best flower or the biggest harvest wins a prize that waits as an estate, alone nobody wins, the settlement then rests; a
// flower a day in the park is reputation and rank.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { showTick } from "../server/engine/commands/festival.ts";
import { settlementIn, settlementRanks } from "../server/engine/commands/settlement.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { BuildingFields, CharacterFields, ShowFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, Player, startServer } from "./stack.ts";

const w = await loadWorld();
async function does(p: Player, line: string, text: string | RegExp, ms = 30_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
async function give(space: SpaceLike, charId: string, proto: string, count: number, own = {}): Promise<void> {
	const p = (await eventually(() => resolvePrototype(space, proto), 10_000, `prototype ${proto}`))!;
	for (let i = 0; i < count; i++) await spawn(space, null, w, p, { location: charId, x: -1, y: -1 }, own);
}
const end = async (s: SpaceLike) => { const e = (await s.readAll({ type: "Show" }))[0]!; await s.takeIfExists({ id: e.id }, 0); await s.write({ type: "Show", fields: { ...(e.fields as unknown as ShowFields), endsWorldMs: 1 } as never }, null, FOREVER, { unique: ["room"] }); };

test("a festival: only a settler beside a park opens it; the better flower wins a prize fetched as an estate; alone nobody wins; the settlement rests; a harvest counts by the piece", { timeout: 360_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const [a, b] = [new Player(srv.url), new Player(srv.url)];
		assert.equal((await a.post("/api/register", { name: "Quirina", password: "geheim-123" })).status, 200);
		assert.equal((await b.post("/api/register", { name: "Xaveria", password: "geheim-123" })).status, 200);
		const ids = [(await a.play()).me.charId, (await b.play()).me.charId];
		const [ca, cb] = (await Promise.all(ids.map((id) => eventually(async () => (await s.readAll({ type: "Character", fields: { charId: id } }))[0], 10_000, id)))).map((e) => e!.fields as unknown as CharacterFields & { accountId: string });
		const room = ca!.room;
		assert.equal(cb!.room, room);
		const building = (id: string, plan: string, name: string, x: number, y: number, ch: { accountId: string; name: string }, points = 1): BuildingFields => ({ buildId: id, plan, name, room, x, y, w: 1, h: 1, owner: ch.accountId, ownerName: ch.name, accountId: ch.accountId, beaconId: "feuer-bucht", points, by: {}, untilWorldMs: FOREVER, builtAt: 0 });
		assert.match(await does(a, "fest blumen", "neben"), /direkt neben einem Park/);
		await s.write({ type: "Building", fields: building("park", "park", "Park", ca!.x + 1, ca!.y, ca!, 9) as never }, null, FOREVER);
		if (Math.abs(cb!.x - ca!.x - 1) > 1 || Math.abs(cb!.y - ca!.y) > 1) await s.write({ type: "Building", fields: building("park2", "park", "Park", cb!.x + 1, cb!.y, cb!, 9) as never }, null, FOREVER);
		assert.match(await does(a, "fest blumen", "keine"), /hier ist keine/);
		for (const [i, ch] of [ca!, ca!, cb!].entries()) await s.write({ type: "Building", fields: building(`hut${i}`, "huette", "Hütte", 1 + i, 1, ch) as never }, null, FOREVER);
		await does(a, "siedlung gründen Neuhafen", "gründet die Siedlung");

		await does(a, "fest blumen", "eröffnet in Neuhafen eine Blumenschau");
		assert.match(await does(b, "fest ernte", "schon"), /schon ein Fest/);
		await give(s, ca!.charId, "strandnelke", 2);
		await give(s, cb!.charId, "strandnelke", 1, { variety: { id: "v1", name: "Abendrot", color: "#f00", breeder: "x", breederName: "X" } });
		await give(s, cb!.charId, "treibholz", 1);
		assert.match(await does(b, "zeige treibholz", "gehört nicht"), /gehört nicht zur Blumenschau/);
		await does(a, "zeige strandnelke", "auf der Blumenschau");
		assert.match(await does(a, "zeige strandnelke", "schon"), /Du zeigst schon Strandnelke/);
		await does(b, "zeige strandnelke", "Abendrot");
		assert.match(await does(a, "fest", "Blumenschau von"), /Xaveria mit Abendrot, Quirina mit Strandnelke/);
		assert.equal(await showTick(s, w, 60_000), 0, "its time is not over");

		let from = a.frames.length;
		await end(s);
		const both = await Promise.all([showTick(s, w, 60_000), showTick(s, w, 60_000)]);
		assert.equal(both[0]! + both[1]!, 1, "two workers end it once");
		await a.until((f) => f.t === "msg" && /Xaveria gewinnt mit Abendrot 10 Münzen/.test(f.m.text), 10_000, from);
		assert.equal((await s.readAll({ type: "ShowEntry" })).length, 0);
		assert.match(await does(b, "nachlass", "Nachlass"), /10 Dinge/);
		assert.equal((await s.count({ type: "Item", fields: { location: cb!.charId, proto: w.currency } })) >= 10, true);
		assert.match(await does(a, "fest ernte", "gefeiert"), /gerade erst gefeiert/);

		// the rest over: a harvest festival counts every piece; alone nobody wins
		const set = await settlementIn(s, room);
		await s.takeIfExists({ type: "Settlement", fields: { settlementId: set!.settlementId } }, 0);
		await s.write({ type: "Settlement", fields: { ...set!, showRestWorldMs: 0 } as never }, null, FOREVER);
		await does(a, "fest ernte", "Erntefest");
		await give(s, ca!.charId, "weizen", 2);
		await does(a, "zeige weizen", "(1)");
		await does(a, "zeige weizen", "(2)");
		from = a.frames.length;
		await end(s);
		assert.equal(await showTick(s, w, 60_000), 1);
		await a.until((f) => f.t === "msg" && /Erntefest von Neuhafen ist zu Ende: zu wenige/.test(f.m.text), 10_000, from);
		assert.equal((await s.readAll({ type: "Estate" })).length, 0, "no prize alone");

		// tending: once a day, costs a flower, shows in the reputation and the rank
		const before = (await settlementRanks(s, w))[0]!;
		await does(a, "pflege", "in den Park");
		assert.match(await does(a, "pflege", "morgen"), /für heute gepflegt/);
		assert.match(await does(a, "reputation", "Parks"), /Parks hast du 1 Mal gepflegt/);
		const after = (await settlementRanks(s, w))[0]!;
		assert.deepEqual([after.tenders, after.points - before.points], [1, 1]);
		assert.match(await does(a, "siedlung rang", "Neuhafen"), /gepflegt von 1/);
		assert.match(await does(a, "pflege", "morgen"), /heute/);
	} finally { await srv.close(); }
});
