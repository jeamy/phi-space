// Step 7 so far (docs/siedeln.en.md): food shortens the rest, a jetty needs water and a net, a lighthouse widens its fire.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { CharacterFields, FireChainFields, SatedFields, WorkRestFields } from "../server/model.ts";
import { workRestMs } from "../server/settings.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, lightFire, Player, startServer } from "./stack.ts";
import { worldNowOf } from "../server/engine/clock.ts";
import { loanTick, shopPrice } from "../server/engine/commands/shop.ts";
import { chainsOf, chainTick, coversOf, flameOf, fogTick, isLit, roomsAround } from "../server/engine/fire.ts";
import { showTick } from "../server/engine/commands/festival.ts";
import { baysOf, berth, linerOf, SHIP_LENGTH, lane, shipComes, shipPlace, shipState, timetable } from "../server/engine/liner.ts";

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

test("a jetty goes only to the water; a lighthouse adds its light and covers the rooms around it", { timeout: 180_000 }, async () => {
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
		// it also covers the rooms one way from its own, on its island: the fire there and its fog
		const around = roomsAround(w, "klippenpfad", 1);
		assert.ok(around.includes("klippenkopf") && around.every((r) => w.rooms.find((x) => x.roomId === r)?.island === w.rooms.find((x) => x.roomId === "klippenpfad")!.island), around.join());
		assert.ok(!(await coversOf(s, w)).get("feuer-bucht")!.includes("klippenkopf"), "the tower in the bay reaches the path, which the fire already covers");
		await s.write({ type: "Building", fields: { buildId: "turm2", plan: "leuchtturm", name: "Leuchtturm", room: "klippenpfad", x: 1, y: 1, w: 1, h: 1, owner: "o", ownerName: "O", accountId: "o", beaconId: "feuer-bucht", points: 3, by: {}, untilWorldMs: FOREVER, builtAt: 0 } as never }, null, FOREVER);
		const cover = await coversOf(s, w);
		assert.ok(cover.get("feuer-bucht")!.includes("klippenkopf"), "a tower on the path reaches the head");
		assert.ok(cover.get("feuer-anleger")!.includes("klippenkopf") && !cover.get("feuer-anleger")!.includes("graue-bucht"), "the other fire keeps its rooms");
		const fog = async (room: string) => Number((await s.readAll({ type: "Fog", fields: { room } }))[0]!.fields.level);
		for (const e of await s.readAll({ type: "Fog", fields: { room: "klippenkopf" } })) await s.takeIfExists({ id: e.id }, 0);
		await s.write({ type: "Fog", fields: { room: "klippenkopf", level: 3 } as never }, null, FOREVER);
		assert.ok(!isLit(await flameOf(s, "feuer-anleger"), await worldNowOf(s)), "the head's own fire is out");
		await fogTick(s, w, 60_000);
		assert.equal(await fog("klippenkopf"), 2, "the bay's fire clears the head through the tower");
	} finally { await srv.close(); }
});

test("signal fires in the light of two fires are a chain: while both burn they share their light, and the island's run counts", { timeout: 180_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		await lightFire(s, 600_000, "feuer-bucht");
		await lightFire(s, 600_000, "feuer-anleger");
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Ole", password: "geheim-123" })).status, 200);
		await p.play();
		const island = w.rooms.find((r) => r.roomId === "graue-bucht")!.island!;
		const signal = (id: string, room: string, beaconId: string) => s.write({ type: "Building", fields: { ...house(id, "signalfeuer", "Signalfeuer", room, 1, 1, "o"), beaconId } as never }, null, FOREVER);
		// two in the light of one fire are no chain
		await signal("sig1", "graue-bucht", "feuer-bucht");
		await signal("sig2", "klippenpfad", "feuer-bucht");
		assert.deepEqual(await chainsOf(s, w), []);
		assert.match(await does(p, "signalfeuer", "Signalfeuer"), /keine Signalfeuer eine Kette/);
		// one beside them in the light of the other fire links both
		await signal("sig3", "klippenkopf", "feuer-anleger");
		const [chain] = await chainsOf(s, w);
		assert.deepEqual([chain!.fires, chain!.rooms, chain!.lit], [["feuer-anleger", "feuer-bucht"], ["graue-bucht", "klippenkopf", "klippenpfad"], true]);
		const anleger = w.beacons.find((b) => b.beaconId === "feuer-anleger")!.covers;
		let cover = await coversOf(s, w);
		assert.ok(anleger.every((r) => cover.get("feuer-bucht")!.includes(r)) && cover.get("feuer-anleger")!.includes("graue-bucht"), "each fire has the rooms of both");
		await chainTick(s, w, 60_000);
		const run = async () => (await s.readAll({ type: "FireChain", fields: { island } }))[0]!.fields as unknown as FireChainFields;
		assert.ok((await run()).since > 0);
		await chainTick(s, w, 60_000);
		assert.equal(await s.count({ type: "FireChain" }), 1, "a tick that finds nothing new writes nothing new");
		assert.match(await does(p, "signalfeuer", "Kette"), /die Kette brennt/);
		// the run began two world hours ago; the anleger fire went out one hour ago: it ran one hour
		const now = await worldNowOf(s);
		const e = (await s.readAll({ type: "FireChain", fields: { island } }))[0]!;
		await s.takeIfExists({ id: e.id }, 0);
		await s.write({ type: "FireChain", fields: { ...e.fields, since: now - 2 * 3600_000 } as never }, null, FOREVER);
		for (const f of await s.readAll({ type: "Flame", fields: { beaconId: "feuer-anleger" } })) await s.takeIfExists({ id: f.id }, 0);
		await s.write({ type: "Flame", fields: { beaconId: "feuer-anleger", until: now - 3600_000, litAt: now - 3 * 3600_000 } as never }, null, FOREVER);
		assert.equal((await chainsOf(s, w))[0]!.lit, false);
		cover = await coversOf(s, w);
		assert.ok(!cover.get("feuer-bucht")!.includes("klippenkopf") && !cover.get("feuer-anleger")!.includes("graue-bucht"), "a broken chain shares nothing");
		await chainTick(s, w, 60_000);
		const after = await run();
		assert.equal(after.since, 0);
		assert.equal(Math.round(after.best / 60_000), 60, `${after.best}`);
		assert.match(await does(p, "signalfeuer", "Kette"), /unterbrochen; aus: Feuerkorb am Anleger\./);
		assert.match(await does(p, "signalfeuer", "Am längsten"), /1\. Graue Insel \(1 Weltstunde\)/);
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
		// a settlement's tax: on top of the price, into its warehouse
		await s.write({ type: "Settlement", fields: { settlementId: "st", name: "Ort", nameKey: "ort", room: c.room, founder: "o", founderName: "O", members: [], closed: false, at: 0, tax: 2 } as never }, null, FOREVER);
		await s.write({ type: "Building", fields: house("lager", "lagerhaus", "Lagerhaus", c.room, c.x + 3, c.y, "o") as never }, null, FOREVER);
		await give(s, "shop", "fisch", 1); await give(s, me, w.currency, 10);
		const purse = await coins(me);
		assert.match(await does(p, "laden kaufe fisch", "Steuer"), /^2 Münzen Steuer gehen ins Lager der Siedlung\.$/);
		assert.equal(await coins("lager"), 2, "the tax lies in the warehouse");
		assert.equal(purse - (await coins(me)), shopPrice(w.shop!.prices.fisch!, 1, w.shop!.full) + 2, "price and tax");
		for (const e of [...await s.readAll({ type: "Settlement", fields: { settlementId: "st" } }), ...await s.readAll({ type: "Building", fields: { buildId: "lager" } })]) await s.takeIfExists({ id: e.id }, 0);
		// a delivery order: the owner posts it, the board shows it, anyone delivers and is paid from the till; promised coins
		// are spoken for
		const q = new Player(srv.url);
		assert.equal((await q.post("/api/register", { name: "Wirtin", password: "geheim-123" })).status, 200);
		const owner = (await q.play()).me.charId;
		const oc = (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: owner } }))[0], 10_000, owner))!.fields as unknown as CharacterFields;
		const acc = String((await s.readAll({ type: "Character", fields: { charId: owner } }))[0]!.fields.accountId);
		for (const e of await s.readAll({ type: "Building", fields: { buildId: "shop" } })) await s.takeIfExists({ id: e.id }, 0);
		await s.write({ type: "Building", fields: house("shop", "kaufhaus", "Kaufhaus", c.room, c.x + 1, c.y, acc) as never }, null, FOREVER);
		assert.equal(oc.room, c.room);
		await s.write({ type: "Character", fields: { ...(await s.take({ type: "Character", fields: { charId: owner } }, 5_000))!.fields, x: c.x + 1, y: c.y + 1 } }, null, FOREVER);
		const till0 = await coins("shop");
		assert.match(await does(q, `laden bestelle 3 fisch für ${till0 + 1}`, "frei"), /müssen \d+ Münzen frei/);
		assert.match(await does(q, "laden bestelle 3 fisch für 1", "bestellt"), /bestellt 3× Fisch zu 1 Münze/);
		assert.match(await does(p, "laden", "Bestellt"), /Bestellt .*: 3× Fisch zu 1 Münze/);
		assert.ok(w.orders.rooms.includes(c.room), "a board hangs at the start");
		assert.match(await does(p, "order", "Kaufhäuser"), /Kaufhaus von O \(.+\): 3× Fisch zu 1 Münze/);
		if (till0 > 3) assert.match(await does(q, `laden entnehme ${till0}`, "versprochen"), /3 Münzen für Bestellungen versprochen/);
		assert.match(await does(q, "laden liefere fisch", "eigene"), /Die eigene Bestellung beliefert man nicht/);
		await give(s, me, "fisch", 4);
		const had = await coins(me);
		assert.match(await does(p, "laden liefere fisch", "lieferst"), /lieferst 3× Fisch ans Kaufhaus und bekommst 3 Münzen/);
		assert.equal((await coins(me)) - had, 3);
		assert.equal(await s.count({ type: "ShopOrder" }), 0, "the order is filled");
		assert.match(await does(p, "laden liefere fisch", "bestellt"), /hat Kaufhaus nicht bestellt/);
		assert.match(await does(p, "laden einlegen 1", "gehört"), /gehört dem Besitzer/);
		// an order of a store that fell is not shown on the board
		assert.match(await does(q, "laden bestelle 2 tang für 1", "bestellt"), /bestellt 2× Tang/);
		for (const e of await s.readAll({ type: "Building", fields: { buildId: "shop" } })) await s.takeIfExists({ id: e.id }, 0);
		assert.doesNotMatch(await does(p, "order", "Auftrag"), /Kaufhäuser/);
		await q.leave();
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
		// a bill of exchange: its coins lie at it, the house keeps the fee, any counting house pays it out
		const bills = () => s.readAll({ type: "Item", fields: { location: me, proto: "wechsel" } });
		await give(s, me, w.currency, 12);
		const purse0 = await coins(me), till1 = await coins("bank");
		assert.match(await does(p, `wechsel ${w.bank!.note!.max + 1}`, "hält"), /hält 1 bis/);
		assert.match(await does(p, "wechsel 10", "schreibt"), /Wechsel über 10 Münzen; 1 Münze behält es/);
		const [bill] = await bills();
		assert.equal(bill!.fields.name, "Wechsel über 10 Münzen");
		assert.equal(await coins(String(bill!.fields.itemId)), 10, "the coins lie at the bill");
		assert.equal(purse0 - (await coins(me)), 11);
		assert.equal((await coins("bank")) - till1, 1, "the fee");
		assert.match(await does(p, "wechsel", "trägst"), /1 Wechsel über zusammen 10 Münzen/);
		assert.match(await does(p, "wechsel einlösen", "zahlt"), /zahlt dir den Wechsel aus: 10 Münzen/);
		assert.equal((await bills()).length, 0);
		assert.equal(await coins(String(bill!.fields.itemId)), 0);
		assert.equal(purse0 - (await coins(me)), 1, "only the fee is gone, to the house");

		const other = w.rooms.find((r) => r.island === w.rooms.find((x) => x.roomId === c.room)!.island && r.roomId !== c.room)!;
		await s.write({ type: "Building", fields: house("j1", "steg", "Steg", c.room, c.x, c.y + 1, "o") as never }, null, FOREVER);
		await s.write({ type: "Building", fields: house("j2", "steg", "Steg", other.roomId, other.spawn.x, other.spawn.y, "o") as never }, null, FOREVER);
		assert.match(await does(p, `rudere ${other.name}`, "Ruderboot"), /brauchst du ein Ruderboot/);
		await give(s, me, "ruderboot");
		// the hatch: beside the jetty, up to 8 things in a rowing boat; they go with it
		const boat = String((await s.readAll({ type: "Item", fields: { location: me, proto: "ruderboot" } }))[0]!.fields.itemId);
		await give(s, me, "tang", 10);
		assert.match(await does(p, "luke lade 9 tang", "Luke"), /^Du lädst 8× Tang in die Luke von Ruderboot\. Mehr passt nicht hinein\.$/);
		assert.match(await does(p, "luke", "(8/8)"), /8× Tang/);
		assert.match(await does(p, "luke entlade 3 tang", "aus der Luke"), /Du holst 3× Tang/);
		assert.equal(await s.count({ type: "Item", fields: { location: boat } }), 5);
		await does(p, `rudere ${other.name}`, "am Steg an");
		await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0]?.fields.room === other.roomId, 10_000, "rowed over");
		assert.equal(await s.count({ type: "Item", fields: { location: boat } }), 5, "the cargo came along");
		assert.match(await does(p, "luke entlade alle", "aus der Luke"), /Du holst 5× Tang/);
	} finally { await srv.close(); }
});

test("a regatta starts at a jetty, a boat stays with its owner and the sailing boat beats the rowing boat; a sailing boat crosses to another island", { timeout: 240_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const [a, b] = [new Player(srv.url), new Player(srv.url)];
		assert.equal((await a.post("/api/register", { name: "Ole", password: "geheim-123" })).status, 200);
		assert.equal((await b.post("/api/register", { name: "Ute", password: "geheim-123" })).status, 200);
		const [ma, mb] = [(await a.play()).me.charId, (await b.play()).me.charId];
		const char = async (id: string) => (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: id } }))[0], 10_000, id))!.fields as unknown as CharacterFields & { accountId: string };
		const [ca, cb] = [await char(ma), await char(mb)];
		const accounts = (await s.readAll({ type: "Account" })).map((e) => e.fields as { accountId: string; name: string });
		const id = (n: string) => accounts.find((x) => x.name === n)!.accountId;
		const put = (bid: string, plan: string, x: number, y: number, acc: string) => s.write({ type: "Building", fields: house(bid, plan, plan, ca.room, x, y, acc) as never }, null, FOREVER);
		for (const [i, acc] of [id("Ole"), id("Ole"), id("Ute")].entries()) await put(`hut${i}`, "huette", 1 + i, 15, acc);
		await does(a, "siedlung gründen Neuhafen", "gründet die Siedlung");
		await put("ja", "steg", ca.x + 1, ca.y, "o");
		await put("jb", "steg", cb.x + 1, cb.y, "o");
		await does(a, "fest regatta", "eine Regatta");
		await give(s, ma, "segelboot");
		await give(s, mb, "ruderboot");
		await does(a, "zeige segelboot", "zur Regatta");
		await does(b, "zeige ruderboot", "zur Regatta");
		assert.equal(await s.count({ type: "Item", fields: { location: ma, proto: "segelboot" } }), 1, "the boat stays");
		const e = (await s.readAll({ type: "Show" }))[0]!;
		await s.takeIfExists({ id: e.id }, 0);
		await s.write({ type: "Show", fields: { ...e.fields, endsWorldMs: 1 } as never }, null, FOREVER, { unique: ["room"] });
		const from = a.frames.length;
		assert.equal(await showTick(s, w, 60_000), 1);
		await a.until((f) => f.t === "msg" && /Regatta von Neuhafen ist zu Ende: Ole gewinnt mit Segelboot/.test(f.m.text), 10_000, from);
		assert.match(await does(a, "segle", "segeln"), /segeln nach/);
		const island = w.rooms.find((r) => r.island && r.island !== w.rooms.find((x) => x.roomId === ca.room)!.island)!.island!;
		await does(a, `segle ${island}`, /legst in .* an/);
		await eventually(async () => (await char(ma)).room !== ca.room, 10_000, "sailed");
	} finally { await srv.close(); }
});

test("the large ship has a berth in every bay: open water clear of the shore, near where newcomers start", () => {
	const bays = [...baysOf(w.rooms).values()];
	assert.equal(bays.length, new Set(w.rooms.map((r) => r.island)).size, "a bay on every island");
	for (const bay of bays) {
		const b = berth(bay.ground, bay.spawn!);
		if (!b) assert.fail(`a berth in ${bay.roomId}`);
		for (let i = 0; i < SHIP_LENGTH; i++) { const x: number = b.x + (b.along === "x" ? i : 0), y: number = b.y + (b.along === "y" ? i : 0); assert.equal(bay.ground[y]![x], "~", `${bay.roomId} ${x},${y} is water`); }
	}
});

test("one large ship sails a loop over the bays: each lies a while, the legs take their time, and the order is round the map", () => {
	const t = linerOf(w)!;
	assert.equal(t.stops.length, new Set(w.rooms.map((r) => r.island)).size, "a stop on every island");
	assert.equal(t.cycleMs, t.legMs.reduce((a, l) => a + t.stayMs + l, 0));
	// at every moment it lies at one stop or sails between two, and only one bay has it
	for (let m = 0; m < t.cycleMs; m += 7 * 60_000) {
		const st = shipState(t, m);
		assert.equal(t.stops.filter((_, i) => shipComes(t, m, i) === 0).length, st.lies === null ? 0 : 1);
		assert.ok(st.f >= 0 && st.f < 1 && st.leftMs > 0);
	}
	// the wait for a bay ends exactly when it lies there
	for (let i = 0; i < t.stops.length; i++) { const wait = shipComes(t, 3 * t.cycleMs + 1234, i); assert.equal(shipComes(t, 3 * t.cycleMs + 1234 + wait, i), 0); if (wait) assert.ok(shipComes(t, 3 * t.cycleMs + 1234 + wait - 1, i) > 0); }
	// the same order wherever the rooms are listed from
	const byIsland = new Map<string, typeof w.rooms>();
	for (const r of w.rooms) byIsland.set(r.island ?? "", [...(byIsland.get(r.island ?? "") ?? []), r]);
	assert.deepEqual(timetable([...byIsland.values()].reverse().flat(), w.liner!)!.stops.map((x) => x.island), t.stops.map((x) => x.island), "the islands may be listed in any order");
});

test("a passenger of the large ship sails with it to the island and lands there: fare, hidden aboard, no walking, the landing", { timeout: 180_000 }, async () => {
	const t = linerOf(w)!, srv = await startServer();
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Ole", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const read = async () => (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0], 10_000, me))!.fields as unknown as CharacterFields;
		const c = await read(), here = t.stops.findIndex((x) => x.room === c.room);
		assert.ok(here >= 0, "newcomers start in a bay");
		const target = t.stops[(here + 2) % t.stops.length]!, startOf = (i: number) => { let m = 0; for (let k = 0; k < i; k++) m += t.stayMs + t.legMs[k]!; return m; };
		const at = async (m: number) => { const e = (await s.readAll({ type: "WorldClock" }))[0]!; await s.takeIfExists({ id: e.id }, 0); await s.write({ type: "WorldClock", fields: { ...e.fields, worldAnchorMs: m, realAnchorMs: Date.now() } as never }, null, FOREVER); };
		const base = t.cycleMs * 10;
		await at(base + startOf(here) + t.stayMs + 60_000); // it has left
		assert.match(await does(p, "fahrplan", "Schiff"), /Hier liegt es in etwa/);
		assert.match(await does(p, `einschiffen ${target.island}`, "Schiff"), /liegt nicht hier/);
		await at(base + startOf(here) + 60_000); // it lies here
		assert.match(await does(p, `einschiffen ${target.island}`, "kostet"), /kostet 3 Münzen/);
		await give(s, me, w.currency, w.liner!.fare);
		await does(p, `einschiffen ${target.island}`, /Das Schiff legt ab/);
		const aboard = (await read()).aboard!;
		assert.equal(aboard.to, target.room);
		assert.equal(aboard.arriveWorldMs, base + startOf((here + 2) % t.stops.length), "it lands when the ship lies at the island");
		assert.equal(await s.count({ type: "Passage", fields: { charId: me } }), 1);
		assert.equal(await s.count({ type: "Item", fields: { location: me, proto: w.currency } }), 0, "the fare is paid");
		assert.match(await does(p, "step 1 0", /Du bist an Bord/), /fährst nach/);
		assert.match(await does(p, "ausschiffen", /Du bist an Bord/), /Ankunft in etwa/, "not before the ship is there");
		await at(aboard.arriveWorldMs + 1000);
		await does(p, "ausschiffen", /kommst in .* an/);
		const landed = await eventually(async () => { const x = await read(); return x.aboard ? undefined : x; }, 10_000, "landed");
		assert.equal(landed!.room, target.room);
		assert.equal(await s.count({ type: "Passage", fields: { charId: me } }), 0);
	} finally { await srv.close(); }
});

test("the ship runs into its bay and out again instead of appearing and vanishing", () => {
	const t = linerOf(w)!, here = 2, start = (() => { let m = 0; for (let k = 0; k < here; k++) m += t.stayMs + t.legMs[k]!; return m; })(), glide = Math.min(10 * 60_000, t.legMs[here]! / 3);
	assert.deepEqual(shipPlace(t, start + 1000, here), { phase: "lies", away: 0 });
	const leaving = shipPlace(t, start + t.stayMs + glide / 2, here);
	assert.ok(leaving.phase === "leaving" && leaving.away > 0 && leaving.away < 1);
	assert.equal(shipPlace(t, start + t.stayMs + glide + 60_000, here).phase, "away");
	assert.equal(shipPlace(t, start - glide / 4, here).phase, "arriving");
	assert.ok(shipPlace(t, start - glide / 4, here).away < 0.5, "close to the berth just before it lies");
	// it never jumps: the distance changes a little each minute, in and out
	let last = 0;
	for (let m = 0; m <= glide; m += 60_000) { const a = shipPlace(t, start + t.stayMs + m, here).away; assert.ok(a >= last && a - last < 0.35); last = a; }
	// the way out: towards the open edge; water that reaches the edge wins over a longer pond
	const sea = ["~~~~~~~~~~", "~~~~~~~~~~", "~~~~~~~~~~"];
	assert.deepEqual(lane(sea, { x: 3, y: 1, along: "x" }), { sx: 1, sy: 0, dist: 3 + 4 });
	const bay = ["..~~~~~~~~", "..~~~~~~~~", ".......~~~"];
	assert.equal(lane(bay, { x: 3, y: 0, along: "x" }).sx, 1, "the open end, not the shore");
});
