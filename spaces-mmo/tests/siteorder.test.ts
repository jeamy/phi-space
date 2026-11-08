// Orders of a site, step 5 part 3 (docs/siedeln.en.md, engine/commands/siteorder.ts): the wage lies in the order, whoever
// delivers or works is paid in that command, what is left goes back, and the day labourer works for it.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { type SpaceLike } from "phi-spaces";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { CharacterFields, SiteFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, lightFire, Player, startServer } from "./stack.ts";

const w = await loadWorld();
async function does(p: Player, line: string, text: string | RegExp, ms = 30_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
const give = async (s: SpaceLike, charId: string, proto: string, count: number) => { const p = (await eventually(() => resolvePrototype(s, proto), 10_000, proto))!; for (let i = 0; i < count; i++) await spawn(s, null, w, p, { location: charId, x: -1, y: -1 }); };
const coins = (s: SpaceLike, at: string) => s.count({ type: "Item", fields: { location: at, proto: "muenze" } });
const join = async (srv: Awaited<ReturnType<typeof startServer>>, name: string) => {
	const p = new Player(srv.url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	return { p, me: (await p.play()).me.charId };
};

/** A hut where a figure may build: it spawned somewhere in the bay, perhaps too near the fire, so it walks off when refused. */
async function stake(s: SpaceLike, f: { p: Player; me: string }): Promise<void> {
	const fire = (await s.readAll({ type: "Beacon", fields: { beaconId: "feuer-bucht" } }))[0]!.fields as unknown as { x: number; y: number };
	for (const [dx, dy] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]] as const) {
		if (dx || dy) {
			const x = fire.x + dx, y = fire.y + dy;
			await does(f.p, `move ${x} ${y}`, /./, 5_000).catch(() => "");
			await eventually(async () => { const c = (await s.readAll({ type: "Character", fields: { charId: f.me } }))[0]?.fields as unknown as CharacterFields | undefined; return !!c && c.x === x && c.y === y ? c : undefined; }, 5_000, "walked").catch(() => undefined);
		}
		if (/steckt eine Baustelle ab/.test(await does(f.p, "bau hütte", /steckt eine Baustelle ab|Hier passt keine/))) return;
	}
	throw new Error("no place for a hut");
}

test("a wage: held by the order, paid in the command, the rest goes back", { timeout: 120_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		await lightFire(s, 600_000, "feuer-bucht");
		const a = await join(srv, "Bauherrin"), b = await join(srv, "Zutraeger");
		await give(s, a.me, "muenze", 12);
		await give(s, b.me, "treibholz", 3);
		await stake(s, a);
		const site = (await eventually(async () => (await s.readAll({ type: "Site" }))[0], 10_000, "site"))!.fields as unknown as SiteFields;
		await does(b.p, "move " + (site.x - 1) + " " + site.y, /./).catch(() => "");
		await eventually(async () => { const c = (await s.readAll({ type: "Character", fields: { charId: b.me } }))[0]?.fields as unknown as CharacterFields | undefined; return !!c && Math.max(c.x - site.x - site.w + 1, site.x - c.x, c.y - site.y - site.h + 1, site.y - c.y) <= 2; }, 15_000, "walked"); // the cell may be taken: two away is near enough to deliver

		assert.match(await does(b.p, "aushang 2 treibholz je 1", "gehört"), /nur, wem die Baustelle gehört/);
		assert.match(await does(a.p, "aushang 3 treibholz je 9", "kostet"), /kostet 27 Münzen, du hast 12/);
		assert.match(await does(a.p, "aushang 2 gold je 1", "braucht"), /braucht die Hütte nicht/);
		assert.match(await does(a.p, "aushang 2 treibholz je 3", "hängt"), /hängt an der Hütte aus: 2 Treibholz, je 3 Münzen/);
		assert.equal(await coins(s, a.me), 6);
		assert.match(await does(a.p, "aushang 1 treibholz je 1", "schon"), /schon ein Aushang/);
		assert.match(await does(b.p, "baustelle", "Lohn:"), /Lohn: 2 Treibholz, je 3 Münzen/);

		assert.match(await does(b.p, "liefere 1 treibholz", "Lohn"), /Lohn: 3 Münzen/);
		assert.equal(await coins(s, b.me), 3);
		assert.match(await does(a.p, "aushang", "Ausgehängt"), /1 Treibholz, je 3 Münzen/);
		assert.match(await does(a.p, "aushang ab", "zurück"), /bekommst 3 Münzen zurück/);
		assert.equal(await coins(s, a.me), 9);
		assert.equal(await s.count({ type: "SiteOrder" }), 0);
		assert.doesNotMatch(await does(b.p, "liefere 1 treibholz", "lieferst"), /Lohn/);

		await does(a.p, "aushang 2 arbeit je 2", "hängt");
		assert.equal(await coins(s, a.me), 5);
		// the owner may work on its own site, but its order is for the others: it stays, and nothing is paid
		assert.doesNotMatch(await does(a.p, "arbeite", "arbeitet"), /Lohn/);
		assert.equal(await coins(s, a.me), 5);
		assert.match(await does(a.p, "aushang", "Ausgehängt"), /2 Arbeit, je 2 Münzen/);
		await does(a.p, "abriss baustelle", "gibt die Baustelle");
		await eventually(async () => (await coins(s, a.me)) === 9, 10_000, "the wage is back");
		assert.equal(await s.count({ type: "SiteOrder" }), 0);
	} finally { await srv.close(); }
});

test("the day labourer works for a wage and for nothing else", { timeout: 200_000 }, async () => {
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.001", SPACES_MMO_NPCS: "wolter" } });
	try {
		const s = srv.stack.space;
		await srv.stack.npcProcess();
		await lightFire(s, 3_600_000, "feuer-bucht");
		const a = await join(srv, "Meisterin");
		await give(s, a.me, "muenze", 4);
		await stake(s, a);
		await does(a.p, "aushang 2 arbeit je 2", "hängt");
		// the site is held while someone works on it: a look may miss it
		const site = (await eventually(async () => { const f = (await s.readAll({ type: "Site" }))[0]?.fields as unknown as SiteFields | undefined; return f && f.work >= 1 ? f : undefined; }, 120_000, "Wolter works"))!;
		assert.ok(site.by.Wolter! >= 1);
		await eventually(async () => (await coins(s, "npc-wolter")) >= 2, 10_000, "paid");
	} finally { await srv.close(); }
});

test("a delivery that finishes the site gives the order's unpaid wages back (the order rewritten in the same transaction)", async () => {
	const { PhiSpaces, openOwnMemoryHost, FOREVER } = await import("phi-spaces");
	const { BACKGROUND_CONTEXT } = await import("phi-spaces/context");
	const { closeOrders } = await import("../server/engine/commands/siteorder.ts");
	const host = openOwnMemoryHost(), s = new PhiSpaces(host, BACKGROUND_CONTEXT);
	try {
		const order = { orderId: "ord-1", buildId: "b-1", siteName: "Hütte", room: "graue-bucht", x: 1, y: 1, w: 2, h: 2, ownerName: "Bauherrin", proto: "treibholz", name: "Treibholz", left: 5, pay: 1, at: 0 };
		await s.write({ type: "Character", fields: { charId: "c-owner", name: "Bauherrin", room: "graue-bucht", x: 0, y: 0 } }, null, FOREVER);
		await s.write({ type: "SiteOrder", fields: order }, null, FOREVER);
		for (let i = 0; i < 5; i++) await s.write({ type: "Item", types: ["Coin"], fields: { itemId: `m-${i}`, proto: "muenze", name: "Münze", location: "ord-1", x: -1, y: -1 } }, null, FOREVER);
		const txn = (await s.createTransaction(10_000)).id;
		// what payFor does for a helper's 2 pieces: 2 coins to the helper, the order written back with 3 left
		for (const i of [0, 1]) { await s.takeIfExists({ type: "Item", fields: { itemId: `m-${i}` } }, 0, { txn }); await s.write({ type: "Item", fields: { itemId: `m-${i}`, proto: "muenze", name: "Münze", location: "c-helper", x: -1, y: -1 } }, txn, FOREVER); }
		await s.takeIfExists({ type: "SiteOrder", fields: { orderId: "ord-1" } }, 0, { txn });
		await s.write({ type: "SiteOrder", fields: { ...order, left: 3 } }, txn, FOREVER);
		// the site is complete: settle closes its orders in the same transaction
		const back = await closeOrders(s, txn, { buildId: "b-1", owner: "c-owner", ownerName: "Bauherrin", accountId: "a-owner", room: "graue-bucht", name: "Hütte" }, 0);
		await s.commit(txn);
		assert.equal(back, 3);
		assert.equal(await coins(s, "c-owner"), 3, "the unpaid wages are the owner's again");
		assert.equal(await coins(s, "c-helper"), 2);
		assert.equal(await coins(s, "ord-1"), 0);
		assert.equal(await s.count({ type: "SiteOrder" }), 0, "no order stays behind for a building that is no site");
	} finally { await host.close(BACKGROUND_CONTEXT); }
});
