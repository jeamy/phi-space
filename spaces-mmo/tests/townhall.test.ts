// The town hall, step 6 part 5 (docs/siedeln.en.md, engine/commands/townhall.ts): beside it settlers put a motion, each votes
// once, the last vote counting; a world day later the count decides, and a carried motion closes the settlement.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER } from "phi-spaces";
import { planOf } from "../server/engine/commands/build.ts";
import { motionTick } from "../server/engine/commands/townhall.ts";
import { settlementIn } from "../server/engine/commands/settlement.ts";
import { loadWorld } from "../server/engine/world.ts";
import { zoneRefusal } from "../server/engine/commands/townhall.ts";
import { settlementTick } from "../server/engine/commands/settlement.ts";
import type { BuildingFields, CharacterFields, MotionFields, ZoneFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, lightFire, Player, startServer } from "./stack.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";

const w = await loadWorld();
async function does(p: Player, line: string, text: string | RegExp, ms = 30_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}

test("a town hall: a motion, one vote each with the last counting, and after a day more yes than no closes the settlement; a tie carries nothing", { timeout: 360_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const [a, b, c] = [new Player(srv.url), new Player(srv.url), new Player(srv.url)];
		assert.equal((await a.post("/api/register", { name: "Quirina", password: "geheim-123" })).status, 200);
		assert.equal((await b.post("/api/register", { name: "Xaveria", password: "geheim-123" })).status, 200);
		assert.equal((await c.post("/api/register", { name: "Zenzi", password: "geheim-123" })).status, 200);
		const ids = [(await a.play()).me.charId, (await b.play()).me.charId, (await c.play()).me.charId];
		const chars = await Promise.all(ids.map((id) => eventually(async () => (await s.readAll({ type: "Character", fields: { charId: id } }))[0], 10_000, id)));
		const [ca, cb] = chars.map((e) => e!.fields as unknown as CharacterFields & { accountId: string });
		const room = ca!.room;
		const building = (id: string, plan: string, name: string, x: number, y: number, ch: { accountId: string; name: string }): BuildingFields => ({ buildId: id, plan, name, room, x, y, w: 1, h: 1, owner: ch.accountId, ownerName: ch.name, accountId: ch.accountId, beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 });
		for (const [i, ch] of [ca!, ca!, cb!].entries()) await s.write({ type: "Building", fields: building(`hut${i}`, "huette", "Hütte", 1 + i, 1, ch) as never }, null, FOREVER);
		await does(a, "siedlung gründen Neuhafen", "gründet die Siedlung");
		assert.match(await does(a, "antrag zu", "direkt neben"), /direkt neben einem Rathaus/);

		await s.write({ type: "Building", fields: building("hall", "rathaus", "Rathaus", ca!.x + 1, ca!.y, ca!) as never }, null, FOREVER);
		assert.match(await does(a, "siedlung zu", "entscheidet das Rathaus"), /„antrag zu“/);
		assert.match(await does(a, "antrag offen", "schon"), /schon offen/);
		await does(a, "antrag zu", "beantragt im Rathaus");
		assert.match(await does(a, "antrag ein Brunnen", "schon ein Antrag"), /schon ein Antrag/);
		assert.match(await does(c, "stimme ja", "dürfen die Siedler"), /Abstimmen dürfen die Siedler von Neuhafen/);
		assert.match(await does(b, "stimme ja", "Deine Stimme"), /2 dafür, 0 dagegen/);
		assert.match(await does(b, "stimme nein", "Deine Stimme"), /1 dafür, 1 dagegen/);
		assert.equal((await s.readAll({ type: "Motion" })).length, 1);
		assert.equal((await s.readAll({ type: "Vote" })).length, 2, "one vote each");
		await assert.rejects(s.write({ type: "Motion", fields: { room } as never }, null, FOREVER, { unique: ["room"] }), /unique entry already exists/, "after the votes the motion still holds the room");
		assert.equal(await motionTick(s, w, 60_000), 0, "the day is not over");

		const end = async () => { const e = (await s.readAll({ type: "Motion" }))[0]!; await s.takeIfExists({ id: e.id }, 0); await s.write({ type: "Motion", fields: { ...(e.fields as unknown as MotionFields), endsWorldMs: 1 } as never }, null, FOREVER, { unique: ["room"] }); };
		let from = a.frames.length;
		await end();
		assert.equal(await motionTick(s, w, 60_000), 1);
		await a.until((f) => f.t === "msg" && /die Siedlung schließen ist abgelehnt, 1 dafür, 1 dagegen/.test(f.m.text), 10_000, from);
		assert.equal((await settlementIn(s, room))!.closed, false, "a tie carries nothing");

		await does(a, "antrag zu", "beantragt im Rathaus");
		await does(b, "stimme ja", "Deine Stimme");
		from = a.frames.length;
		await end();
		assert.equal(await motionTick(s, w, 60_000), 1);
		await a.until((f) => f.t === "msg" && /ist angenommen, 2 dafür, 0 dagegen/.test(f.m.text), 10_000, from);
		assert.equal((await settlementIn(s, room))!.closed, true);
		assert.equal((await s.readAll({ type: "Motion" })).length, 0);
		assert.equal((await s.readAll({ type: "Vote" })).length, 0, "the votes go with it");

		// the settlers take a building down, whoever owns it; what is left is its owner's, and the area is free at once
		// (only the shed beside whoever puts it: they may stand beside the hall, which is moved off)
		const hall = (await s.takeIfExists({ type: "Building", fields: { buildId: "hall" } }, 5_000))!;
		await s.write({ type: "Building", fields: { ...hall.fields, x: cb!.x + 5, y: cb!.y } as never }, null, FOREVER);
		const hutAt = { x: cb!.x + 1, y: cb!.y };
		await s.write({ type: "Building", fields: building("shed", "huette", "Hütte", hutAt.x, hutAt.y, ca!) as never }, null, FOREVER);
		await s.write({ type: "Plot", fields: { room, x: hutAt.x, y: hutAt.y, of: "shed" } as never }, null, FOREVER);
		const inChest = (await resolvePrototype(s, "muschel"))!;
		await spawn(s, null, w, inChest, { location: "shed", x: -1, y: -1 });
		await does(b, "antrag abriss", "den Abriss der Hütte von Quirina");
		await does(a, "stimme nein", "Deine Stimme");
		await does(c, "antrag", "beantragt");
		await end();
		assert.equal(await motionTick(s, w, 60_000), 1);
		assert.equal((await s.readAll({ type: "Building", fields: { buildId: "shed" } })).length, 1, "a tie keeps it");
		await does(b, "antrag abriss", "den Abriss");
		from = a.frames.length;
		await end();
		assert.equal(await motionTick(s, w, 60_000), 1);
		await a.until((f) => f.t === "msg" && /ist angenommen.*Die Fläche ist frei; was blieb, holt Quirina hier mit „nachlass“ ab/.test(f.m.text), 10_000, from);
		assert.equal((await s.readAll({ type: "Building", fields: { buildId: "shed" } })).length, 0);
		assert.equal((await s.readAll({ type: "Plot", fields: { room } })).filter((e) => e.fields.of === "shed").length, 0, "the area is free");
		const estate = (await s.readAll({ type: "Estate", fields: { estateId: "est-shed" } }))[0]!;
		const left = (await s.readAll({ type: "Item", fields: { location: "est-shed" } })).map((e) => String(e.fields.proto));
		const half = planOf(w, "huette")!.needs.reduce((n, x) => n + Math.floor(x.count / 2), 0);
		assert.equal(estate.fields.accountId, ca!.accountId);
		assert.equal(left.length, half + 1, "half the material and the chest");
		assert.ok(left.includes("muschel"));
		await s.takeIfExists({ type: "Building", fields: { buildId: "hall" } }, 5_000);
		await s.write({ type: "Building", fields: hall.fields as never }, null, FOREVER);

		// a zone: anywhere in the settlement, for the ground around whoever puts it; green admits beds and parks, a way nothing
		await does(b, "antrag grünzone", "eine Grünzone (7×7");
		await does(a, "stimme ja", "Deine Stimme");
		await end();
		assert.equal(await motionTick(s, w, 60_000), 1);
		const z = (await s.readAll({ type: "Zone" }))[0]!.fields as unknown as ZoneFields;
		await a.until((f) => f.t === "obj" && f.o.kind === "zone" && f.o.name === "Grünzone" && f.o.w === z.w, 10_000, 0); // the map shows it
		assert.equal(z.kind, "gruen");
		assert.ok(z.x <= cb!.x && cb!.x < z.x + z.w && z.y <= cb!.y && cb!.y < z.y + z.h);
		const cell = [{ x: z.x, y: z.y }], ctx = { space: s, world: w, txn: null } as never;
		assert.match((await zoneRefusal(ctx, room, cell, false))!, /Grünzone/);
		assert.equal(await zoneRefusal(ctx, room, cell, true), null);
		await lightFire(s, 600_000, "feuer-bucht");
		assert.match(await does(b, "bau hütte", "Grünzone"), /Hier passt keine Hütte hin: Das ist Grünzone/, "really refused by the command");
		await does(b, "antrag wegerecht", "ein Wegerecht");
		await does(a, "stimme ja", "Deine Stimme");
		await end();
		await motionTick(s, w, 60_000);
		assert.equal((await s.readAll({ type: "Zone" })).length, 2);
		assert.match((await zoneRefusal(ctx, room, cell, true))!, /Wegerecht/);
		assert.match(await does(a, "siedlung", "Neuhafen ("), /Zonen: .*Wegerecht/);
		await does(b, "antrag zone frei", "die Zonen aufheben");
		await does(a, "stimme ja", "Deine Stimme");
		await end();
		await motionTick(s, w, 60_000);
		assert.equal((await s.readAll({ type: "Zone" })).length, 0, "lifted where it was put");

		await does(b, "antrag wegerecht", "ein Wegerecht");
		await does(a, "stimme ja", "Deine Stimme");
		await end();
		await motionTick(s, w, 60_000);
		// a tax: coins for each thing, kept in the store, and no more is taken than they pay for; coins themselves go free
		assert.match(await does(a, "antrag steuer 9", "Mehr als"), /Mehr als 5 Münzen/);
		await does(a, "antrag steuer 2", "die Steuer auf 2 Münzen");
		await does(b, "stimme ja", "Deine Stimme");
		await end();
		await motionTick(s, w, 60_000);
		assert.equal((await settlementIn(s, room))!.tax, 2);
		const give = async (proto: string, n: number, location: string) => { const p = (await eventually(() => resolvePrototype(s, proto), 10_000, proto))!; for (let i = 0; i < n; i++) await spawn(s, null, w, p, { location, x: -1, y: -1 }); };
		const store = building("store", "lagerhaus", "Lagerhaus", ca!.x - 1, ca!.y, ca!);
		await s.write({ type: "Building", fields: store as never }, null, FOREVER);
		await give("treibholz", 3, "store");
		assert.match(await does(a, "entnimm 1 treibholz", "Steuer je Stück"), /2 Münzen Steuer je Stück; so viele hast du nicht/);
		await give(w.currency!, 5, ids[0]!);
		assert.match(await does(a, "entnimm 3 treibholz", "aus dem Lager"), /Du nimmst 2 Treibholz.*4 Münzen Steuer bleiben im Lager\. Für mehr reichen/);
		const inStore = (await s.readAll({ type: "Item", fields: { location: "store" } })).map((e) => e.fields.proto);
		assert.deepEqual(inStore.filter((p) => p === w.currency).length, 4);
		assert.match(await does(a, "entnimm 4 münze", "aus dem Lager"), /Du nimmst 4 Münze[^.]*\.$|Du nimmst 4 Münzen?[^.]*aus dem Lager\./);

		for (const e of await s.readAll({ type: "Building" })) await s.takeIfExists({ id: e.id }, 0);
		await settlementTick(s, w, 60_000);
		assert.equal((await s.readAll({ type: "Zone" })).length, 0, "zones end with the settlement");
	} finally { await srv.close(); }
});
