// The rules closed after the check of 2026-11-19 (docs/de-docs/spielregeln-analyse-2026-11-19.md, priorities 1 and 2):
// a tree counts towards its island's stock and the limit of trees holds per island; a road that is over counts no more;
// a fire carries one lighthouse; a board asks only for what its island's epoch can make; a trader's coins come back like
// its stock; what a settlement laid into a warehouse lies in the open when the warehouse falls; the orders of a
// department store that stands no more are swept away. And what followed on 2026-11-20 (W4, W5, N3, N4): a food cupboard
// keeps the cooked dishes, no trader of an island sells below what another there pays, a settler asks a coin more than
// the island's best trader pays, and no NPC is given a recipe it would have to walk to a building for.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { decayNowOf } from "../server/engine/clock.ts";
import { buildSweep } from "../server/engine/commands/build.ts";
import { islandPoints } from "../server/engine/commands/epoch.ts";
import { roadCellsEntries, routePoints } from "../server/engine/commands/road.ts";
import { marketTick, ordersTick } from "../server/engine/commands/trade.ts";
import "../server/npc/scripts.ts"; // the entry of the NPC modules (they import each other in a ring)
import { askingPrice } from "../server/npc/settlers.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { BuildingFields, CharacterFields, RouteFields, TreeFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, lightFire, Player, startServer, arrived } from "./stack.ts";

const w = await loadWorld();
async function does(p: Player, line: string, text: string | RegExp, ms = 30_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
async function give(space: SpaceLike, location: string, proto: string, count: number): Promise<void> {
	const p = (await eventually(() => resolvePrototype(space, proto), 10_000, `prototype ${proto}`))!;
	for (let i = 0; i < count; i++) await spawn(space, null, w, p, { location, x: -1, y: -1 });
}
const tree = (id: string, room: string, accountId: string, x: number): TreeFields => ({ treeId: id, sort: "birke", room, x, y: 1, w: 1, h: 1, owner: "o", ownerName: "O", accountId, beaconId: "feuer-bucht", points: 1, stage: 0, dueWorldMs: FOREVER, at: 0 });
const building = (id: string, plan: string, room: string, over: Partial<BuildingFields> = {}): BuildingFields => ({ buildId: id, plan, name: plan, room, x: 1, y: 14, w: 1, h: 1, owner: "o", ownerName: "O", accountId: "o", beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0, ...over } as BuildingFields);

test("trees count towards the island's stock, eight an account in each place; a road that is over counts no more", { timeout: 240_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space, p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Försterin", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const c = (await arrived(s, me))!.fields as unknown as CharacterFields & { accountId: string };
		const here = w.rooms.find((r) => r.roomId === c.room)!, elsewhere = w.rooms.find((r) => r.island === here.island && r.roomId !== here.roomId)!;
		await lightFire(s, 600_000, "feuer-bucht");
		await give(s, me, "spaten", 1);
		await give(s, me, "samen-birke", 2);
		// eight trees in another place of the same island do not stand in the way here
		for (let i = 0; i < w.trees!.maxTrees; i++) await s.write({ type: "Tree", fields: tree(`far-${i}`, elsewhere.roomId, c.accountId, i) as never }, null, FOREVER);
		assert.match(await does(p, "pflanze birkensamen", /pflanzt|passt kein/), /pflanzt Birkensamen ein/);
		const now = await decayNowOf(s);
		const stock = (await islandPoints(s, w, now)).get(here.island!)!;
		assert.equal(stock.trees, w.trees!.maxTrees + 1, "the planted tree counts, with those in the other place");
		assert.ok(stock.points >= 1);
		assert.match(await does(p, "epoche", "Punkte"), new RegExp(`Bäume ${w.trees!.maxTrees + 1}\\)`));
		// eight here are the limit here
		for (let i = 0; i < w.trees!.maxTrees - 1; i++) await s.write({ type: "Tree", fields: tree(`near-${i}`, c.room, c.accountId, i) as never }, null, FOREVER);
		assert.match(await does(p, "pflanze birkensamen", "Mehr als"), /Mehr als 8 Bäume pflanzt niemand an einem Ort; fälle hier erst einen\./);

		// a finished road counts while it stands
		const road = (id: string, until: number): RouteFields => ({ routeId: id, pair: id, island: here.island!, rooms: [c.room, c.room], names: ["A", "B"], cells: [], state: "built", planner: "o", plannerName: "O", accountId: "o", voters: [], yes: [], no: [], voteUntil: 0, needs: [], work: 3, workNeed: 3, by: {}, untilWorldMs: until, at: 0, points: 2 });
		for (const r of [road("r-stands", now + 3600_000), road("r-over", now - 1)]) { await s.write({ type: "Route", fields: r as never }, null, FOREVER); for (const e of roadCellsEntries(r)) await s.write(e as never, null, FOREVER); }
		assert.equal((await routePoints(s, now)).get(here.island!), 2, "only the road that stands");
	} finally { await srv.close(); }
});

test("a fire carries one lighthouse", { timeout: 180_000 }, async () => {
	const srv = await startServer({ worldEnv: { SPACES_MMO_EPOCH_FORCE: "3" } });
	try {
		const s = srv.stack.space, p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Türmer", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const c = (await arrived(s, me))!.fields as unknown as CharacterFields;
		await lightFire(s, 600_000, "feuer-bucht");
		await s.write({ type: "Building", fields: building("turm", "leuchtturm", c.room, { points: 3 }) as never }, null, FOREVER);
		assert.match(await does(p, "bau leuchtturm", /Feuer trägt|steckt|passt/), /Ein Feuer trägt höchstens einen Bau „Leuchtturm“, und dieses hat ihn schon/);
	} finally { await srv.close(); }
});

test("a board asks for what its island's epoch can make; a trader's coins come back; a settlement's goods and a fallen store's orders", { timeout: 240_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		// every island is a fishing village: no board asks for bread, cloth or a feast
		const late = new Set(w.orders.kinds.filter((k) => (k.epoch ?? 1) > 1).map((k) => k.key));
		assert.ok(late.size >= 15 && late.has("brot") && late.has("festessen"));
		for (let i = 0; i < 12; i++) await ordersTick(s, w);
		const posted = (await s.readAll({ type: "Order" })).map((e) => String(e.fields.kind));
		assert.ok(posted.length >= w.orders.rooms.length, "the boards are filled");
		assert.deepEqual(posted.filter((k) => late.has(k)), [], "nothing of a later epoch");

		// a keeper that only buys gets its coins back, one a world day, up to what it started with
		const keeper = w.npcs.find((n) => n.script === "huter" && (n.carry ?? []).some((x) => x.proto === w.currency))!, id = `npc-${keeper.npcId}`;
		const start = keeper.carry!.find((x) => x.proto === w.currency)!.count;
		const coins = async () => (await s.readAll({ type: "Item", fields: { location: id, proto: w.currency } })).length;
		await eventually(async () => (await coins()) === start, 20_000, "the keeper's coins");
		for (const e of await s.readAll({ type: "Item", fields: { location: id, proto: w.currency } })) await s.take({ id: e.id }, 2_000); // spent
		await marketTick(s, w);
		const r = (await s.readAll({ type: "Restock", fields: { charId: id, proto: w.currency } }))[0]!;
		assert.ok(r, "the clock starts");
		await s.take({ id: r.id }, 2_000);
		await s.write({ type: "Restock", fields: { ...r.fields, nextWorldMs: 0 } }, null, FOREVER);
		await marketTick(s, w);
		assert.equal(await coins(), 1, "one coin back");

		// a warehouse of a settlement that falls: what lay in it lies in the open, not in its owner's estate
		const room = "graue-bucht";
		await s.write({ type: "Settlement", fields: { settlementId: "s-1", name: "Graubucht", nameKey: "graubucht", room, founder: "o", founderName: "O", members: [], closed: false, at: 0 } as never }, null, FOREVER);
		await s.write({ type: "Building", fields: building("lager", "lagerhaus", room, { x: 3, y: 14, untilWorldMs: 0 }) as never }, null, FOREVER);
		await s.write({ type: "Building", fields: building("schuppen", "huette", room, { x: 6, y: 14, untilWorldMs: 0 }) as never }, null, FOREVER);
		await give(s, "lager", "muschel", 2);
		await give(s, "schuppen", "muschel", 1);
		// a department store's orders: one of a store that stands, one of a store that is gone
		await s.write({ type: "Building", fields: building("kauf", "kaufhaus", room, { x: 9, y: 14 }) as never }, null, FOREVER);
		for (const [orderId, buildId] of [["so-1", "kauf"], ["so-2", "gone"]]) await s.write({ type: "ShopOrder", fields: { orderId, buildId, room, storeName: "Kaufhaus", ownerName: "O", proto: "muschel", protoName: "Muschel", count: 1, reward: 1 } as never }, null, FOREVER);
		await buildSweep(s, w);
		assert.equal((await s.readAll({ type: "Ruin", fields: { buildId: "lager" } })).length, 1, "the warehouse fell");
		assert.equal((await s.readAll({ type: "Estate", fields: { estateId: "est-lager" } })).length, 0, "no estate for its owner");
		assert.equal((await s.readAll({ type: "Item", fields: { location: room, proto: "muschel", x: 3, y: 14 } })).length, 2, "the goods lie at its place");
		assert.equal((await s.readAll({ type: "Item", fields: { location: "est-schuppen" } })).length, 1, "a hut's chest is still its owner's");
		assert.deepEqual((await s.readAll({ type: "ShopOrder" })).map((e) => e.fields.orderId), ["so-1"]);
	} finally { await srv.close(); }
});

test("the world: every cooked dish has a container, no island has a trader selling below another's buying price, no NPC crafts at a building; a settler's asking price", () => {
	const kept = new Set((w.keeps ?? []).flatMap((k) => k.keeps)), young = new Set((w.animals?.kinds ?? []).flatMap((k) => (k.young ? [k.young] : [])));
	const open = w.prototypes.filter((p) => p.turns && !kept.has(p.key) && !young.has(p.key)).map((p) => p.key);
	assert.deepEqual(open, [], "what spoils and has no container (but for young animals, which grow up)");
	assert.ok(w.keeps!.find((k) => k.proto === "speiseschrank")!.keeps.includes("festessen"));

	const island = (r?: string) => (r ? w.rooms.find((x) => x.roomId === r)?.island : undefined);
	const at = (n: (typeof w.npcs)[number]) => new Set([n.room, n.market, ...(n.home ?? [])].map(island).filter(Boolean));
	const traders = w.npcs.filter((n) => n.prices), cheap: string[] = [];
	for (const a of traders) for (const b of traders) {
		if (a === b || ![...at(a)].some((i) => at(b).has(i))) continue;
		for (const [proto, [, sells]] of Object.entries(a.prices!)) { const buys = b.prices![proto]?.[0] ?? 0; if (sells > 0 && buys > sells) cheap.push(`${a.name} sells ${proto} for ${sells}, ${b.name} buys it for ${buys}`); }
	}
	assert.deepEqual(cheap, [], "coins for carrying a thing across one island");

	// a craftsman's script crafts where it stands (npc/economy.ts handwerker): a recipe of its list must need no building
	for (const n of w.npcs) for (const key of n.crafts ?? []) assert.equal(w.recipes.find((r) => r.key === key)?.at, undefined, `${n.name} crafts ${key}, which needs a building`);

	const hinnerk = w.npcs.find((n) => n.npcId === "hinnerk")!;
	assert.equal(askingPrice(w, "graue-bucht", "treibholz"), Math.max(...w.npcs.filter((n) => n.prices && island(n.room) === island(hinnerk.room)).map((n) => n.prices!.treibholz?.[0] ?? 0)) + 1);
	assert.equal(askingPrice(w, "graue-bucht", "gibtsnicht"), 2, "what no trader buys");
});
