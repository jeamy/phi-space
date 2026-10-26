// The people of the islands (server/npc/economy.ts, docs/welt.md): script NPCs that keep fires, trade by their price
// lists, gather and sell, talk, and a storm surge. No model calls. Game time runs fast; every fire burns for the whole
// test, so the fog keeps the ways open.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpaceLike } from "phi-spaces";
import { stormTick } from "../server/engine/fire.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, Player, startServer, startStack } from "./stack.ts";

const w = await loadWorld();
const allFires = async (s: SpaceLike, ms = 120_000) => { for (const b of w.beacons) await s.write({ type: "Flame", fields: { beaconId: b.beaconId, until: Date.now() + ms, litAt: Date.now() } as never }, null, ms); };
async function player(url: string, name: string) {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	return { p, me: (await p.play()).me.charId };
}
const give = async (s: SpaceLike, to: string, proto: string) => spawn(s, null, w, (await eventually(() => resolvePrototype(s, proto), 10_000, proto))!, { location: to, x: -1, y: -1 });
const pack = async (s: SpaceLike, charId: string, proto: string) => (await s.readAll({ type: "Item", fields: { location: charId, proto } })).length;
const msg = (p: Player, test: (text: string) => boolean, from = 0, ms = 15_000) => p.until((f) => f.t === "msg" && test(f.m.text), ms, from) as Promise<Extract<ServerFrame, { t: "msg" }>>;

test("a keeper keeps the fire of the island burning with the wood it carries", async () => {
	const stack = await startStack({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.02", SPACES_MMO_NPCS: "mats" } });
	try {
		const s = stack.space;
		assert.equal(await pack(s, "npc-mats", "treibholz"), 2, "Mats starts with two pieces");
		await stack.npcProcess();
		await eventually(async () => !!(await s.readIfExists({ type: "Flame", fields: { beaconId: "feuer-anleger" } }, 0)), 20_000, "the fire at the pier burns");
		assert.ok((await pack(s, "npc-mats", "treibholz")) < 2, "with his wood");
	} finally { await stack.close(); }
});

test("a trader offers coins for what one carries, takes a fair offer, turns down a poor one and says what he buys", async () => {
	const stack = await startStack({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.1", SPACES_MMO_NPCS: "kalle" } });
	const srv = await startServer({ stack });
	try {
		const s = stack.space;
		await allFires(s);
		const a = await player(srv.url, "Fischerin");
		await give(s, a.me, "treibholz");
		await stack.npcProcess();
		// he sees the wood and offers for it
		// meant for her: the page sets it apart
		assert.equal((await msg(a.p, (t) => t.startsWith("Kalle bietet dir Münze, Münze für 1× treibholz"), 0, 20_000)).m.toMe, true, "an offer to her");
		a.p.send("accept Kalle");
		await eventually(async () => (await pack(s, a.me, "muenze")) === 2, 10_000, "two coins for the wood");
		assert.equal(await pack(s, "npc-kalle", "treibholz"), 1, "the wood is his");
		// a poor offer: five coins for a shell he pays one for
		await give(s, a.me, "muschel");
		let from = a.p.frames.length;
		a.p.send("offer muschel an Kalle für 5 münze");
		await msg(a.p, (t) => t.startsWith("Kalle: Fischerin, das ist mir zu wenig."), from);
		// a fair one: the shell for one coin
		from = a.p.frames.length;
		a.p.send("offer muschel an Kalle für 1 münze");
		await msg(a.p, (t) => t === "Kalle: Abgemacht, Fischerin.", from);
		assert.equal(await pack(s, a.me, "muenze"), 3);
		from = a.p.frames.length;
		a.p.send("say Kalle, was kaufst du?");
		const answer = (await msg(a.p, (t) => t.startsWith("Kalle: Fischerin, ich kaufe"), from)).m;
		assert.match(answer.text, /Treibholz \(bis 2\).*verkaufe/);
		assert.equal(answer.toMe, true, "words that name her");
		assert.equal((await msg(a.p, (t) => t === "Fischerin: Kalle, was kaufst du?", from)).m.toMe, undefined, "not her own words");
		await a.p.leave();
	} finally { await srv.close(); await stack.close(); }
});

test("a gatherer picks up what lies on her beaches, crosses to the market and puts it on the board", async () => {
	const stack = await startStack({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.02", SPACES_MMO_NPCS: "hanne" } });
	try {
		const s = stack.space;
		await allFires(s);
		await stack.npcProcess();
		await eventually(async () => (await s.readAll({ type: "Listing", fields: { room: "graue-bucht" } })).some((l) => l.fields.sellerName === "Hanne"), 60_000, "Hanne sells at the grey bay");
	} finally { await stack.close(); }
});

test("people talk: one walks to the fishing village and asks Tilde, who answers in her own words", async () => {
	const stack = await startStack({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.1", SPACES_MMO_NPCS: "tilde" } });
	const srv = await startServer({ stack });
	try {
		const s = stack.space;
		await allFires(s);
		const a = await player(srv.url, "Wandernde");
		await stack.npcProcess();
		const n = a.p.frames.length;
		a.p.send("gehe nach westen");
		await a.p.until((f) => f.t === "hello" && f.room.roomId === "fischerdorf", 10_000, n);
		// Tilde walks between the village and the bay: asked while she is here (again, if she just left)
		const here = async () => String((await s.readIfExists({ type: "Character", fields: { charId: "npc-tilde" } }, 1_000))?.fields.room) === "fischerdorf";
		let said = "";
		for (let tries = 0; !said && tries < 6; tries++) {
			await eventually(here, 30_000, "Tilde in the village");
			const from = a.p.frames.length;
			a.p.send("Tilde, was gibt es Neues?");
			said = await msg(a.p, (t) => t.startsWith("Tilde: Wandernde, "), from, 6_000).then((f) => f.m.text, () => "");
		}
		assert.ok(w.npcs.find((x) => x.npcId === "tilde")!.lines!.some((l) => said.endsWith(l)), said);
		await a.p.leave();
	} finally { await srv.close(); await stack.close(); }
});

test("a storm surge leaves things on a beach and the harbour channel says where", async () => {
	const stack = await startStack({ worlds: 1 });
	const srv = await startServer({ stack });
	try {
		const s = stack.space;
		const a = await player(srv.url, "Horcherin");
		const room = (await stormTick(s, w, 60_000))!;
		assert.ok(w.storm!.rooms.includes(room));
		assert.equal(await s.count({ type: "Item", fields: { location: room, flotsam: true } }) >= w.storm!.count, true, "the things lie there");
		await msg(a.p, (t) => t.startsWith("[hafen] Sturmflut in ") && t.includes(w.rooms.find((r) => r.roomId === room)!.name));
		await a.p.leave();
	} finally { await srv.close(); await stack.close(); }
});

test("the whole archipelago lives: every NPC plays at once, they trade, and no coin appears or vanishes", async () => {
	const stack = await startStack({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.02", SPACES_MMO_NPCS: w.npcs.map((n) => n.npcId).filter((id) => id !== "fremder").join(",") } });
	try {
		const s = stack.space;
		await allFires(s);
		const coins = async () => (await s.readAll({ type: "Item", fields: { proto: "muenze" } })).length;
		const before = await coins();
		await stack.npcProcess();
		await eventually(async () => (await s.count({ type: "Session" })) >= w.npcs.length - 1, 20_000, "everyone online");
		// a while of island life: people gather, keep fires, list and buy
		await eventually(async () => (await s.count({ type: "Listing" })) >= 1, 120_000, "something on a board"); // slow under the load of the whole suite
		await new Promise((r) => setTimeout(r, 5_000));
		assert.ok((await s.count({ type: "Intent" })) <= w.npcs.length, "no intents pile up");
		// coins only change hands here (no orders are delivered, nothing is crafted from coins); a coin a trade holds
		// right now is invisible to a read, so wait for a quiet moment
		await eventually(async () => (await coins()) === before, 20_000, `still ${before} coins`);
	} finally { await stack.close(); }
});

test("Tran burns an hour: put in the fire it keeps it six times as long as a piece of driftwood", async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const a = await player(srv.url, "Tranhändlerin");
		await give(s, a.me, "tran");
		a.p.send("move 9 9"); // next to the fire of the grey bay
		await eventually(async () => (await s.readIfExists({ type: "Character", fields: { charId: a.me } }, 2_000))?.fields.y === 9, 10_000, "next to the fire");
		const before = Date.now();
		a.p.send("lege tran ins feuer");
		await msg(a.p, (t) => t.startsWith("Du legst Tran ins Leuchtfeuer"));
		const flame = await s.readIfExists({ type: "Flame", fields: { beaconId: "feuer-bucht" } }, 2_000);
		assert.ok(Number(flame?.fields.until) - before >= w.fire.fuel.tran! - 5_000, "an hour of fire");
		assert.equal(await pack(s, a.me, "tran"), 0, "the cask is burnt");
		await a.p.leave();
	} finally { await srv.close(); }
});
