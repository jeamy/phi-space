// The statistics (server/stats.ts, GET /api/stats): only for a signed-in page; players by the name the game shows (an
// alias, never the login), the settlers and the figures a model plays marked, no scripted NPCs; a real beam is counted, and every Travel entry of a figure adds up.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { fieldsBetween } from "../server/engine/commands/beam.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { WorldStats } from "../server/stats.ts";
import { eventually, lightFire, Player, startServer } from "./stack.ts";

const w = await loadWorld();

async function does(p: Player, line: string, text: string | RegExp, ms = 30_000): Promise<void> {
	const from = p.frames.length;
	p.send(line);
	await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
}
async function give(space: SpaceLike, charId: string, proto: string, count: number): Promise<void> {
	const p = (await eventually(() => resolvePrototype(space, proto), 10_000, `prototype ${proto}`))!;
	for (let i = 0; i < count; i++) await spawn(space, null, w, p, { location: charId, x: -1, y: -1 });
}
const stats = async (base: string, cookie: string) => {
	const r = await fetch(`${base}/api/stats`, { headers: cookie ? { cookie } : {} });
	return { status: r.status, body: (await r.json()) as WorldStats };
};

test("statistics: players by their shown name, a counted beam, positions and the world's counts", { timeout: 120_000 }, async () => {
	const srv = await startServer({ worldEnv: { SPACES_MMO_BEAM_EPOCH: "1" } });
	try {
		const s = srv.stack.space, p = new Player(srv.url), q = new Player(srv.url);
		assert.equal((await stats(srv.url, "")).status, 401, "not without a session");
		assert.equal((await p.post("/api/register", { name: "loginname", password: "geheim-123" })).status, 200);
		assert.equal((await p.post("/api/alias", { alias: "Wanderin" })).status, 200);
		assert.equal((await q.post("/api/guest", {})).status, 200);
		const me = (await p.play()).me.charId;
		const guest = (await q.play()).me.charId;

		// a real beam counts once
		await lightFire(s, 3_600_000, "feuer-anleger");
		await give(s, me, "muenze", fieldsBetween(w.rooms.find((r) => r.roomId === "graue-bucht"), w.rooms.find((r) => r.roomId === "anleger")));
		await does(p, "beam anleger", /Anleger/);
		await eventually(async () => (await s.readIfExists({ type: "Travel", fields: { charId: me } }, 1_000)) ?? null, 10_000, "the counted beam");
		// a second entry of the same figure (as another region would hold) adds to it
		await s.write({ type: "Travel", fields: { charId: me, train: 2, ship: 1 } as never }, null, FOREVER);
		// what the figure carries, by kind and count
		await give(s, me, "muschel", 3);
		await give(s, me, "treibholz", 1);

		const r = await eventually(async () => { const x = await stats(srv.url, p.cookie); return x.body.trips?.beam === 1 ? x : null; }, 40_000, "the statistics with the beam");
		const body = r.body;
		assert.equal(r.status, 200);
		assert.deepEqual(body.trips, { beam: 1, ship: 1, sail: 0, row: 0, train: 2 });
		assert.ok(!JSON.stringify(body).includes("loginname"), "the login name is never shown");
		assert.ok(!JSON.stringify(body).includes("accountId"), "no account ids");
		// the figures a model plays and the settlers are listed and marked, the scripted NPCs are not
		const ai = new Set(w.npcs.filter((n) => n.model).map((n) => `npc-${n.npcId}`));
		for (const x of body.list) assert.equal(x.kind, x.charId.startsWith("npc-siedler-") ? "settler" : ai.has(x.charId) ? "ai" : "player", x.charId);
		assert.ok(body.list.every((x) => !x.charId.startsWith("npc-") || x.kind !== "player"), "no scripted NPC");
		assert.ok(body.list.some((x) => x.kind === "ai"), "the model's figures are there");
		assert.equal(body.players.ai, body.list.filter((x) => x.kind === "ai").length);
		const mine = body.list.find((x) => x.charId === me)!;
		assert.equal(mine.name, "Wanderin");
		assert.equal(mine.guest, false);
		assert.ok(Math.abs(mine.since - Date.now()) < 5 * 60_000, "registered just now");
		assert.deepEqual(mine.trips, { beam: 1, ship: 1, sail: 0, row: 0, train: 2 });
		const shells = mine.owns.carries.find((i) => i.name === "Muschel"), wood = mine.owns.carries.find((i) => i.name === "Treibholz");
		assert.equal(shells?.count, 3, JSON.stringify(mine.owns.carries));
		assert.equal(wood?.count, 1);
		assert.ok(mine.owns.carries.indexOf(shells!) < mine.owns.carries.indexOf(wood!), "the most first");
		assert.deepEqual(body.list.find((x) => x.charId === guest)?.owns.carries.filter((i) => i.name === "Muschel"), [], "only its own pack");
		assert.ok(mine.at && "room" in mine.at && mine.at.room === "anleger", JSON.stringify(mine.at));
		assert.equal(body.list.find((x) => x.charId === guest)?.guest, true);
		assert.deepEqual([body.players.registered, body.players.guests], [1, 1]);
		assert.equal(body.players.online, 2);
		assert.deepEqual(body.missing, []);
		await Promise.all([p.leave(), q.leave()]);
	} finally { await srv.close(); }
});

test("a figure aboard the large ship shows only that it is aboard", { timeout: 120_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space, p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Seefahrer", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		await p.leave();
		const e = (await s.take({ type: "Character", fields: { charId: me } }, 5_000))!;
		await s.write({ type: "Character", fields: { ...e.fields, aboard: { to: "krabbenbucht", island: "Krabbeninsel", spot: { x: 1, y: 1 }, arriveWorldMs: 1e15 } } as never }, null, FOREVER);
		const body = (await eventually(async () => { const x = await stats(srv.url, p.cookie); return x.body.list?.find((c) => c.charId === me && c.at && "aboard" in c.at) ? x : null; }, 40_000, "aboard")).body;
		const mine = body.list.find((c) => c.charId === me)!;
		assert.deepEqual(mine.at, { aboard: true });
		assert.ok(!JSON.stringify(mine).includes("krabbenbucht"), "not where it goes");
	} finally { await srv.close(); }
});
