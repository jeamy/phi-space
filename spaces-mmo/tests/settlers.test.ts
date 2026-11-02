// The settlers (docs/siedeln.en.md "Wenige Spieler", server/npc/settlers.ts): with too few people, settlers play; one with
// the material stakes out a hut in its fire's light and builds it through the same commands as a person; when a person
// comes, the last settler of the order goes; who and the page mark them.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER } from "phi-spaces";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import { roadLinks } from "../server/engine/commands/cart.ts";
import type { BuildingFields, CartFields, SiteFields } from "../server/model.ts";
import { eventually, lightFire, Player, startServer } from "./stack.ts";

const w = await loadWorld();
const settlers = w.npcs.filter((n) => n.settler);
const [first, second] = settlers as [typeof settlers[0], typeof settlers[0]];

test("settlers: two play while nobody does, one builds its hut by the commands; a person comes and the second goes; marked as settlers", { timeout: 300_000 }, async () => {
	// 0.001: a world hour (the rest after a work point) is 3.6 s
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.001", SPACES_MMO_NPCS: `${first.npcId},${second.npcId}`, SPACES_MMO_SETTLERS_MIN: "2" } });
	try {
		const s = srv.stack.space;
		await srv.stack.npcProcess();
		const online = async (npcId: string) => (await s.count({ type: "Session", fields: { charId: `npc-${npcId}` } })) > 0;
		await eventually(async () => (await online(first.npcId)) && (await online(second.npcId)), 60_000, "both settlers play");
		const acc = (await s.readAll({ type: "Account", fields: { accountId: `npc-${first.npcId}` } }))[0]!.fields;
		assert.equal(acc.npc, true, "an NPC's account: no model calls");
		assert.equal(acc.settler, true);

		// the fire burns and the first carries what a hut needs: it stakes one out and builds it
		await lightFire(s, 3_600_000, first.beacon);
		for (const [proto, n] of [["treibholz", 7], ["tangseil", 2]] as const) {
			const p = (await resolvePrototype(s, proto))!;
			for (let i = 0; i < n; i++) await spawn(s, null, w, p, { location: `npc-${first.npcId}`, x: -1, y: -1 });
		}
		const site = await eventually(async () => (await s.readAll({ type: "Site", fields: { accountId: `npc-${first.npcId}` } }))[0]?.fields as SiteFields | undefined, 120_000, "a site of the settler");
		assert.equal(site.plan, "huette");
		const hut = await eventually(async () => (await s.readAll({ type: "Building", fields: { accountId: `npc-${first.npcId}` } }))[0]?.fields as BuildingFields | undefined, 200_000, "the hut built");
		assert.equal(hut.plan, "huette");
		assert.ok(Object.keys(hut.by).includes(first.name), "built by the settler itself");
		assert.ok(hut.untilWorldMs < FOREVER);

		// a person comes: one settler fewer is needed, the second of the order goes
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Ida", password: "geheim-123" })).status, 200);
		const hello = await p.play();
		await eventually(async () => !(await online(second.npcId)), 60_000, "the second settler leaves");
		assert.equal(await online(first.npcId), true, "the first stays");
		// marked: on the page and in who
		const shown = hello.chars.find((c) => c.charId === `npc-${first.npcId}`);
		if (shown) assert.equal(shown.settler, true);
		p.send("who");
		const who = await p.until((f) => f.t === "msg" && f.m.kind === "who", 10_000);
		assert.match((who as { m: { text: string } }).m.text, new RegExp(`${first.name}, Siedler`));
	} finally { await srv.close(); }
});

test("a settler of a village joins the rooms of its home by road, through the same commands; the stone it lacks it gathers", { timeout: 300_000 }, async () => {
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.001", SPACES_MMO_NPCS: first.npcId, SPACES_MMO_SETTLERS_MIN: "1", SPACES_MMO_EPOCH_FORCE: "2" } });
	try {
		const s = srv.stack.space, me = `npc-${first.npcId}`, homes = first.home ?? [first.room];
		assert.ok(w.exits.some((e) => homes.includes(e.room) && homes.includes(e.destination)), "two rooms of its home touch");
		await lightFire(s, 3_600_000, first.beacon);
		// what it builds first stands already
		for (const plan of ["huette", "regentonne", "huehnerstall"]) {
			const b: BuildingFields = { buildId: `own-${plan}`, plan, name: plan, room: first.room, x: 0, y: 0, w: 1, h: 1, owner: me, ownerName: first.name, accountId: me, beaconId: first.beacon!, points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 };
			await s.write({ type: "Building", fields: b as never }, null, FOREVER);
		}
		for (const [proto, n] of [["stein", 4], ["treibholz", 2]] as const) {
			const p = (await resolvePrototype(s, proto))!;
			for (let i = 0; i < n; i++) await spawn(s, null, w, p, { location: me, x: -1, y: -1 });
		}
		await srv.stack.npcProcess();
		const site = await eventually(async () => (await s.readAll({ type: "Site", fields: { accountId: me } }))[0]?.fields as SiteFields | undefined, 120_000, "a road staked out");
		assert.equal(site.plan, "strasse");
		const road = await eventually(async () => (await s.readAll({ type: "Building", fields: { accountId: me, plan: "strasse" } }))[0]?.fields as BuildingFields | undefined, 200_000, "the road built");
		assert.ok(homes.includes(road.room));
		assert.ok((await roadLinks(s, w)).get(road.room)?.size, "it links a room");
	} finally { await srv.close(); }
});

test("a figure two rooms from home takes the island railway when stations stand at both ends and it has the fare", { timeout: 240_000 }, async () => {
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.001", SPACES_MMO_NPCS: first.npcId, SPACES_MMO_SETTLERS_MIN: "1" } });
	try {
		const s = srv.stack.space, me = `npc-${first.npcId}`, island = (r: string) => w.rooms.find((x) => x.roomId === r)?.island;
		// a room of its island at least two rooms away on foot (most islands are no wider)
		const far = new Map([[first.room, 0]]);
		for (let frontier = [first.room]; frontier.length;) frontier = frontier.flatMap((r) => w.exits.filter((e) => e.room === r && island(e.destination) === island(r) && !far.has(e.destination)).map((e) => (far.set(e.destination, far.get(r)! + 1), e.destination)));
		const start = [...far].find(([, k]) => k >= 2)?.[0];
		assert.ok(start, "a room two away on its island");
		// a station on open ground with a free ring around it, in both rooms
		const station = async (roomId: string) => {
			const g = w.rooms.find((r) => r.roomId === roomId)!.ground;
			for (let y = 1; y < g.length - 3; y++) for (let x = 1; x < (g[0]?.length ?? 0) - 4; x++) {
				let ok = true;
				for (let yy = y - 1; yy <= y + 2 && ok; yy++) for (let xx = x - 1; xx <= x + 3 && ok; xx++) ok = ",.".includes(g[yy]?.[xx] ?? "~");
				if (!ok) continue;
				const b: BuildingFields = { buildId: `bahnhof-${roomId}`, plan: "bahnhof", name: "Bahnhof", room: roomId, x, y, w: 3, h: 2, owner: "o", ownerName: "O", accountId: "o", beaconId: first.beacon!, points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 };
				await s.write({ type: "Building", fields: b as never }, null, FOREVER);
				return;
			}
			assert.fail(`no place for a station in ${roomId}`);
		};
		await station(start!);
		await station(first.room);
		// the settler stands in that room with a coin
		const c = (await s.take({ type: "Character", fields: { charId: me } }, 5_000))!;
		const spawnAt = w.rooms.find((r) => r.roomId === start)!.spawn!;
		await s.write({ type: "Character", fields: { ...c.fields, room: start, x: spawnAt.x, y: spawnAt.y } }, null, FOREVER);
		await spawn(s, null, w, (await resolvePrototype(s, w.currency))!, { location: me, x: -1, y: -1 });
		const coins = () => s.count({ type: "Item", fields: { location: me, proto: w.currency } });
		const before = await coins();
		await srv.stack.npcProcess();
		await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0]?.fields.room === first.room, 120_000, "home");
		assert.equal(await coins(), before - w.rail!.fare, "it paid the fare: it rode");
	} finally { await srv.close(); }
});

test("a settler with things to sell and a road to its market sends them by cart, unloads it there and takes the cart along", { timeout: 300_000 }, async () => {
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.001", SPACES_MMO_NPCS: first.npcId, SPACES_MMO_SETTLERS_MIN: "1" } });
	try {
		const s = srv.stack.space, me = `npc-${first.npcId}`, homes = first.home ?? [first.room];
		const market = homes.find((r) => w.market.rooms.includes(r))!, exit = w.exits.find((e) => homes.includes(e.room) && e.room !== market && e.destination === market)!;
		assert.ok(market && exit, "a room of its home beside its market");
		await lightFire(s, 3_600_000, first.beacon);
		for (const plan of ["huette", "regentonne", "huehnerstall"]) {
			const b: BuildingFields = { buildId: `own-${plan}`, plan, name: plan, room: first.room, x: 0, y: 0, w: 1, h: 1, owner: me, ownerName: first.name, accountId: me, beaconId: first.beacon!, points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 };
			await s.write({ type: "Building", fields: b as never }, null, FOREVER);
		}
		// a road beside the exit to the market, two cells in
		const road: BuildingFields = { buildId: "strasse-1", plan: "strasse", name: "Straße", room: exit.room, x: exit.x + (exit.x === 0 ? 2 : -2), y: exit.y, w: 1, h: 1, owner: "o", ownerName: "O", accountId: "o", beaconId: first.beacon!, points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 };
		await s.write({ type: "Building", fields: road as never }, null, FOREVER);
		const c = (await s.take({ type: "Character", fields: { charId: me } }, 5_000))!;
		const spawnAt = w.rooms.find((r) => r.roomId === exit.room)!.spawn!;
		await s.write({ type: "Character", fields: { ...c.fields, room: exit.room, x: spawnAt.x, y: spawnAt.y } }, null, FOREVER);
		const pearl = (await resolvePrototype(s, "perle"))!;
		for (let i = 0; i < 6; i++) await spawn(s, null, w, pearl, { location: me, x: -1, y: -1 });
		if (!(await s.count({ type: "Item", fields: { location: me, proto: "karren" } }))) await spawn(s, null, w, (await resolvePrototype(s, "karren"))!, { location: me, x: -1, y: -1 });
		await srv.stack.npcProcess();
		const sent = await eventually(async () => (await s.readAll({ type: "Cart", fields: { accountId: me } })).map((e) => e.fields as unknown as CartFields).find((x) => x.path.length), 150_000, "the cart sent");
		assert.deepEqual(sent.path, [market]);
		assert.equal(await s.count({ type: "Item", fields: { location: sent.cartId } }), 6, "the pearls on it");
		await eventually(async () => !(await s.count({ type: "Cart", fields: { accountId: me } })) && (await s.count({ type: "Item", fields: { location: me, proto: "karren" } })) > 0, 150_000, "unloaded at the market and taken along");
		const pearls = (await s.count({ type: "Item", fields: { location: me, proto: "perle" } })) + (await s.readAll({ type: "Listing", fields: { seller: me } })).length;
		assert.equal(pearls, 6, "nothing lost: in its pack or on the board");
	} finally { await srv.close(); }
});

test("a trader bound for another island boards the large ship in the bay while it lies there, instead of the ferries", { timeout: 240_000 }, async () => {
	const kalle = w.npcs.find((n) => n.npcId === "kalle")!, to = kalle.route![1]!, island = (r: string) => w.rooms.find((x) => x.roomId === r)?.island;
	assert.notEqual(island(kalle.room), island(to), "its route crosses the water");
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.001", SPACES_MMO_NPCS: kalle.npcId } });
	try {
		const s = srv.stack.space, me = `npc-${kalle.npcId}`;
		await eventually(() => s.readIfExists({ type: "Character", fields: { charId: me } }, 1_000), 10_000, me);
		await srv.stack.npcProcess();
		// the rooms it stands in, in order, until it is on the other island
		const seen: string[] = [];
		await eventually(async () => {
			const room = String((await s.readAll({ type: "Character", fields: { charId: me } }))[0]?.fields.room);
			if (seen.at(-1) !== room) seen.push(room);
			return island(room) === island(to);
		}, 200_000, "on the other island");
		assert.deepEqual(seen.filter((r) => island(r) === island(kalle.room)), [kalle.room], `no ferry walk: ${seen.join(" > ")}`);
	} finally { await srv.close(); }
});

test("villagers: one comes when a settlement has five buildings, keeps the fire and leaves when the settlement goes", { timeout: 240_000 }, async () => {
	const v = w.npcs.find((n) => n.villager === 1)!, fire = w.beacons.find((b) => b.beaconId === v.beacon)!;
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.001", SPACES_MMO_NPCS: v.npcId } });
	try {
		const s = srv.stack.space;
		await srv.stack.npcProcess();
		const online = () => s.count({ type: "Session", fields: { charId: `npc-${v.npcId}` } });
		assert.equal(await online(), 0, "no settlement, no villager");
		const hut = (i: number) => ({ buildId: `b${i}`, plan: "huette", name: "Hütte", room: fire.room, x: 1 + i * 3, y: 1, w: 2, h: 2, owner: `x${i}`, ownerName: "X", accountId: `x${i}`, beaconId: fire.beaconId, points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 });
		for (let i = 0; i < 5; i++) await s.write({ type: "Building", fields: hut(i) as never }, null, FOREVER);
		await s.write({ type: "Settlement", fields: { settlementId: "st", name: "Dorf", nameKey: "dorf", room: fire.room, founder: "x", founderName: "X", members: [], closed: false, at: 0 } as never }, null, FOREVER);
		await eventually(async () => (await online()) > 0, 90_000, "the villager comes");
		await s.takeIfExists({ type: "Settlement", fields: { settlementId: "st" } }, 0);
		await eventually(async () => (await online()) === 0, 90_000, "the villager leaves");
	} finally { await srv.close(); }
});
