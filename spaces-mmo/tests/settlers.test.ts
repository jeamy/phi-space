// The settlers (docs/siedeln.md "Wenige Spieler", server/npc/settlers.ts): with too few people, settlers play; one with
// the material stakes out a hut in its fire's light and builds it through the same commands as a person; when a person
// comes, the last settler of the order goes; who and the page mark them.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER } from "phi-spaces";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { BuildingFields, SiteFields } from "../server/model.ts";
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
