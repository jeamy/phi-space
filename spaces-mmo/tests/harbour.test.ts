// Step 7 so far (docs/siedeln.en.md): food shortens the rest, a jetty needs water and a net, a lighthouse widens its fire.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { CharacterFields, SatedFields, WorkRestFields } from "../server/model.ts";
import { workRestMs } from "../server/settings.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, lightFire, Player, startServer } from "./stack.ts";
import { worldNowOf } from "../server/engine/clock.ts";
import { loanTick, shopPrice } from "../server/engine/commands/shop.ts";

const w = await loadWorld();
async function does(p: Player, line: string, text: string | RegExp, ms = 30_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
const give = async (s: SpaceLike, charId: string, proto: string, n = 1) => { const p = (await eventually(() => resolvePrototype(s, proto), 10_000, proto))!; for (let i = 0; i < n; i++) await spawn(s, null, w, p, { location: charId, x: -1, y: -1 }); };
const restLeft = async (s: SpaceLike, charId: string) => (((await s.readAll({ type: "WorkRest", fields: { charId } }))[0]?.fields as unknown as WorkRestFields).untilWorldMs) - (await worldNowOf(s));

test("eating lasts by the food and shortens the rest; a net at a jetty catches; only with net, jetty and water", { timeout: 180_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		await lightFire(s, 600_000, "feuer-bucht");
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Ole", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const c = (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0], 10_000, me))!.fields as unknown as CharacterFields;
		assert.match(await does(p, "wirf netz", "neben"), /direkt neben einem Steg/);
		await s.write({ type: "Building", fields: { buildId: "st", plan: "steg", name: "Steg", room: c.room, x: c.x + 1, y: c.y, w: 1, h: 1, owner: "o", ownerName: "O", accountId: "o", beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 } as never }, null, FOREVER);
		assert.match(await does(p, "wirf netz", "Netz"), /brauchst du ein Netz/);
		await give(s, me, "netz");
		await does(p, "wirf netz", "aus dem Wasser");
		const plain = await restLeft(s, me);
		assert.ok(plain > 0.9 * (await workRestMs(s)));
		assert.match(await does(p, "wirf netz", "müde"), /müde/);
		assert.equal(await s.count({ type: "Item", fields: { location: me, proto: "netz" } }), 1, "the net holds");

		await give(s, me, "treibholz");
		assert.match(await does(p, "iss treibholz", "satt"), /macht nicht satt/);
		await give(s, me, "brot", 3);
		await does(p, "iss brot", "isst Brot");
		const one = (await s.readAll({ type: "Sated", fields: { charId: me } }))[0]!.fields as unknown as SatedFields;
		await does(p, "iss brot", "isst Brot");
		await does(p, "iss brot", "isst Brot");
		const full = (await s.readAll({ type: "Sated", fields: { charId: me } }))[0]!.fields as unknown as SatedFields;
		assert.equal((await s.readAll({ type: "Sated" })).length, 1);
		assert.ok(full.untilWorldMs - (await worldNowOf(s)) <= w.food!.maxWorldMs, "only a day ahead");
		assert.ok(full.untilWorldMs > one.untilWorldMs);
		await s.takeIfExists({ type: "WorkRest", fields: { charId: me } }, 0);
		await does(p, "wirf netz", "aus dem Wasser");
		const fed = await restLeft(s, me);
		assert.ok(fed <= (await workRestMs(s)) / w.food!.restFactor, `${fed}`);
	} finally { await srv.close(); }
});

test("a jetty goes only to the water; a lighthouse adds its light", { timeout: 180_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		await lightFire(s, 600_000, "feuer-bucht");
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Ole", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const c = (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0], 10_000, me))!.fields as unknown as CharacterFields;
		assert.match(await does(p, "bau steg 2 12", /Wasser|passt keine|steckt/), /Wasser/);
		await s.write({ type: "LightUse", fields: { beaconId: "feuer-bucht", used: 20 } as never }, null, FOREVER, { unique: ["beaconId"] });
		assert.match(await does(p, "bau regentonne", "Licht"), /Licht des Feuers reicht/);
		await s.write({ type: "Building", fields: { buildId: "turm", plan: "leuchtturm", name: "Leuchtturm", room: c.room, x: 1, y: 14, w: 1, h: 1, owner: "o", ownerName: "O", accountId: "o", beaconId: "feuer-bucht", points: 3, by: {}, untilWorldMs: FOREVER, builtAt: 0 } as never }, null, FOREVER);
		assert.doesNotMatch(await does(p, "bau regentonne", /steckt eine Baustelle ab|passt keine/), /Licht/);
	} finally { await srv.close(); }
});

const house = (id: string, plan: string, name: string, room: string, x: number, y: number, accountId: string) => ({ buildId: id, plan, name, room, x, y, w: 1, h: 1, owner: "o", ownerName: "O", accountId, beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 });

test("a shop prices by its shelf, pays from its till and mints nothing; a loan frees its pledge when repaid and loses it when not; a boat rows between jetties", { timeout: 240_000 }, async () => {
	assert.equal(shopPrice(4, 0, 10), 8);
	assert.equal(shopPrice(4, 10, 10), 2);
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Ole", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const c = (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0], 10_000, me))!.fields as unknown as CharacterFields;
		const coins = (at: string) => s.count({ type: "Item", fields: { location: at, proto: w.currency } });
		await s.write({ type: "Building", fields: house("shop", "kaufhaus", "Kaufhaus", c.room, c.x + 1, c.y, "o") as never }, null, FOREVER);
		await give(s, me, "fisch", 2);
		assert.match(await does(p, "laden verkaufe fisch", "Kasse"), /zu leer/);
		await give(s, "shop", w.currency, 4);
		const before = await coins(me);
		await does(p, "laden verkaufe fisch", "verkaufst");
		const paid = (await coins(me)) - before;
		assert.ok(paid > 0);
		assert.equal((await coins("shop")) + paid, 4, "coins only moved");
		assert.match(await does(p, "laden", "Regal"), /Fisch \(1\)/);
		await give(s, me, w.currency, 6);
		await does(p, "laden kaufe fisch", "kaufst");
		assert.equal(await s.count({ type: "Item", fields: { location: "shop", proto: "fisch" } }), 0);
		assert.ok(Number((await s.readAll({ type: "Building", fields: { buildId: "shop" } }))[0]!.fields.turnover) > 0);
		assert.match(await does(p, "laden einlegen 1", "gehört"), /gehört dem Besitzer/);
		for (const e of await s.readAll({ type: "Building", fields: { buildId: "shop" } })) await s.takeIfExists({ id: e.id }, 0);

		await s.write({ type: "Building", fields: house("bank", "kontor", "Kontor", c.room, c.x + 1, c.y, "o") as never }, null, FOREVER);
		await give(s, "bank", w.currency, 10);
		await give(s, me, "perle", 1);
		assert.match(await does(p, "kredit 99 gegen perle", "höchstens"), /höchstens 14 Münzen/);
		const held = await coins(me);
		await does(p, "kredit 10 gegen perle", "Du leihst");
		assert.equal((await coins(me)) - held, 10);
		assert.equal(await s.count({ type: "Item", fields: { location: me, proto: "perle" } }), 0);
		assert.match(await does(p, "kredit 1 gegen fisch", "schon"), /schon einen Kredit/);
		await does(p, "tilge", "Pfand wieder");
		assert.equal(await s.count({ type: "Item", fields: { location: me, proto: "perle" } }), 1);
		assert.equal(await coins("bank"), 11, "ten back and a tenth");
		await does(p, "kredit 2 gegen perle", "Du leihst");
		const e = (await s.readAll({ type: "Loan" }))[0]!;
		await s.takeIfExists({ id: e.id }, 0);
		await s.write({ type: "Loan", fields: { ...e.fields, untilWorldMs: 1 } as never }, null, FOREVER);
		assert.equal(await loanTick(s, w, 60_000), 1);
		assert.equal(await s.count({ type: "Item", fields: { location: "bank", proto: "perle" } }), 1, "the pledge went to the house");
		assert.equal(await s.count({ type: "Loan" }), 0);

		const other = w.rooms.find((r) => r.island === w.rooms.find((x) => x.roomId === c.room)!.island && r.roomId !== c.room)!;
		await s.write({ type: "Building", fields: house("j1", "steg", "Steg", c.room, c.x, c.y + 1, "o") as never }, null, FOREVER);
		await s.write({ type: "Building", fields: house("j2", "steg", "Steg", other.roomId, other.spawn.x, other.spawn.y, "o") as never }, null, FOREVER);
		assert.match(await does(p, `rudere ${other.name}`, "Ruderboot"), /brauchst du ein Ruderboot/);
		await give(s, me, "ruderboot");
		await does(p, `rudere ${other.name}`, "am Steg an");
		await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0]?.fields.room === other.roomId, 10_000, "rowed over");
	} finally { await srv.close(); }
});
