// Acceptance of Phase 4 (docs/phasen.md): trade and economy. Every exchange moves its items in one transaction, so a
// fuzz of many trades, purchases and withdrawals racing each other across two world workers ends with every item
// existing exactly once: with a player, or in the market's escrow behind a live listing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import type { SpaceLike } from "phi-spaces";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, lightFire, Player, startServer } from "./stack.ts";

const w = await loadWorld();
type P = { p: Player; me: string; name: string };

async function player(url: string, name: string): Promise<P> {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	return { p, me: (await p.play()).me.charId, name };
}
async function does(p: Player, line: string, text: string | RegExp, ms = 15_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
/** Puts `count` items of a prototype into a character's pack (test setup) and returns their ids. */
async function give(space: SpaceLike, charId: string, proto: string, count: number): Promise<string[]> {
	const p = (await eventually(() => resolvePrototype(space, proto), 10_000, `prototype ${proto}`))!;
	const ids: string[] = [];
	for (let i = 0; i < count; i++) ids.push((await spawn(space, null, w, p, { location: charId, x: -1, y: -1 })).itemId);
	return ids;
}
const pack = async (space: SpaceLike, charId: string, proto?: string) => (await space.readAll({ type: "Item", fields: { location: charId, ...(proto ? { proto } : {}) } })).map((e) => e.fields as Record<string, any>);

test("trade: an offer moves both sides at once on accept; a stale one moves nothing; guests cannot trade", async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const a = await player(srv.url, "Anbieter"), b = await player(srv.url, "Nehmer");
		const [wood] = await give(s, a.me, "treibholz", 1);
		const [shell] = await give(s, b.me, "muschel", 1);
		await does(a.p, "offer treibholz an Nehmer für muschel", "Du bietest Nehmer Treibholz für 1× muschel an.");
		await b.p.until((f) => f.t === "msg" && f.m.text.startsWith("Anbieter bietet dir Treibholz für 1× muschel an."));
		await does(b.p, "accept", "Tausch mit Anbieter");
		assert.equal((await pack(s, b.me)).map((i) => i.itemId).join(), wood);
		assert.equal((await pack(s, a.me)).map((i) => i.itemId).join(), shell);
		assert.equal(await s.count({ type: "Offer" }), 0);
		// a stale offer: the wood is no longer where it was offered from
		await does(b.p, "biete treibholz an Anbieter für muschel", "Du bietest");
		await does(b.p, "drop treibholz", "Du legst");
		assert.match(await does(a.p, "annehmen Nehmer", "gilt nicht mehr"), /hat nicht mehr alles/);
		assert.deepEqual((await pack(s, a.me)).map((i) => i.itemId), [shell], "nothing moved");
		// decline, and guests
		await does(a.p, "offer muschel an Nehmer", "Du bietest Nehmer Muschel als Geschenk an.");
		await does(b.p, "decline", "Du lehnst das Angebot von Anbieter ab.");
		const g = new Player(srv.url); await g.post("/api/guest"); await g.play();
		await give(s, (await g.until((f) => f.t === "hello") as Extract<ServerFrame, { t: "hello" }>).me.charId, "muschel", 1);
		assert.match(await does(g, "offer muschel an Anbieter", "Gäste"), /registriere dich/);
		await Promise.all([a.p, b.p, g].map((p) => p.leave()));
	} finally { await srv.close(); }
});

test("market: a listing waits in escrow; a purchase moves listing, coins and item at once; a lapsed listing goes back", async () => {
	// 0.002: a listing of a game day lasts about three minutes, the market ticker looks every 0.12 s
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.002" } });
	try {
		const s = srv.stack.space;
		const a = await player(srv.url, "Haendlerin"), b = await player(srv.url, "Kaeufer");
		const [shell] = await give(s, a.me, "muschel", 1);
		await give(s, b.me, "muenze", 3);
		await does(a.p, "markt biete muschel für 2", "Du hängst Muschel für 2 Münzen ans Marktbrett.");
		assert.equal((await s.readIfExists({ type: "Item", fields: { itemId: shell } }, 2_000))!.fields.location, "market");
		assert.match(await does(b.p, "markt", "Marktbrett:"), /1\. Muschel für 2 Münzen \(von Haendlerin\)/);
		assert.match(await does(a.p, "markt kaufe 1", "eigenes"), /zurück/);
		await does(b.p, "markt kaufe 1", "Du kaufst Muschel vom Marktbrett.");
		assert.equal((await pack(s, b.me, "muschel")).length, 1);
		assert.equal((await pack(s, b.me, "muenze")).length, 1);
		assert.equal((await pack(s, a.me, "muenze")).length, 2);
		assert.equal(await s.count({ type: "Listing" }), 0);
		// withdraw
		await does(b.p, "markt biete muschel für 5", "ans Marktbrett");
		await does(b.p, "markt zurück 1", "Du holst Muschel vom Marktbrett zurück.");
		assert.equal((await pack(s, b.me, "muschel")).length, 1);
		// a listing whose lease lapses: the market ticker gives the item back
		await does(b.p, "markt biete muschel für 5", "ans Marktbrett");
		const l = (await s.readAll({ type: "Listing" }))[0]!;
		await s.take({ type: "Listing", id: l.id }, 2_000); // as if its lease had ended
		await eventually(async () => (await pack(s, b.me, "muschel")).length === 1, 10_000, "back with the seller");
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});

test("craft: inputs are used up, the output appears, a tool wears with every use and breaks at the end", async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const a = await player(srv.url, "Schnitzer");
		await give(s, a.me, "muschel", 2);
		await give(s, a.me, "treibholz", 16);
		assert.match(await does(a.p, "craft holzbuendel", "Werkzeug"), /muschelmesser/);
		await does(a.p, "craft muschelmesser", "Du stellst Muschelmesser her.");
		assert.equal((await pack(s, a.me, "muschel")).length, 0);
		assert.equal((await pack(s, a.me, "muschelmesser"))[0]!.wear, 5);
		for (let i = 0; i < 4; i++) await does(a.p, "baue holzbündel", "Du stellst Holzbündel her.");
		assert.equal((await pack(s, a.me, "muschelmesser"))[0]!.wear, 1);
		assert.match(await does(a.p, "craft holzbuendel", "Du stellst Holzbündel her."), /Muschelmesser zerbricht/);
		assert.equal((await pack(s, a.me, "muschelmesser")).length, 0, "the tool is used up");
		assert.equal((await pack(s, a.me, "holzbuendel")).length, 5);
		assert.equal((await pack(s, a.me, "treibholz")).length, 0, "16 - 1 - 5 × 3");
		await a.p.leave();
	} finally { await srv.close(); }
});

test("order board: the world posts jobs, one player takes one, delivering uses up the goods and pays coins", async () => {
	// 0.002: a new job every 0.6 s up to three
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.002" } });
	try {
		const s = srv.stack.space;
		const a = await player(srv.url, "Arbeiterin"), b = await player(srv.url, "Zweite");
		// every board gets its own jobs, up to three each
		const here = { type: "Order", fields: { room: "graue-bucht" } };
		await eventually(async () => (await s.count(here)) === 3, 15_000, "three jobs posted");
		await new Promise((r) => setTimeout(r, 1_500));
		assert.ok((await s.count(here)) <= 3, "never more than three (one may just have lapsed)");
		assert.ok((await s.count({ type: "Order" })) <= 3 * w.orders.rooms.length, "at most three at every board");
		const board = await does(a.p, "auftrag", "Auftragstafel:");
		assert.match(board, /1\. .+ Lohn: \d Münze/);
		await does(a.p, "auftrag nimm 1", "Du übernimmst");
		const mine = (await s.readAll({ type: "Order", fields: { takenBy: a.me } }))[0]!.fields as Record<string, any>;
		assert.match(await does(b.p, "auftrag", "Auftragstafel"), /^(?!.*Dein Auftrag)/s);
		assert.match(await does(a.p, "auftrag liefere", "fehlt"), /Dir fehlt noch/);
		for (const n of mine.needs) await give(s, a.me, n.proto, n.count);
		await does(a.p, "auftrag liefere", "Du lieferst einen Auftrag ab");
		assert.equal((await pack(s, a.me, mine.reward.proto)).length, mine.reward.count, "paid");
		for (const n of mine.needs) assert.equal((await pack(s, a.me, n.proto)).length, 0, "goods used up");
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});

test("conservation: a fuzz of trades, purchases, withdrawals and gifts across two world workers loses or doubles nothing", async () => {
	const srv = await startServer();
	try {
		await srv.stack.worldProcess();
		const s = srv.stack.space;
		const ps: P[] = [];
		for (let i = 0; i < 6; i++) ps.push(await player(srv.url, `Fuzz${i}x`));
		const seeded: string[] = [];
		for (const x of ps) { seeded.push(...(await give(s, x.me, "muenze", 4)), ...(await give(s, x.me, "muschel", 3))); }
		const other = (i: number) => ps[(i + 1 + randomInt(0, ps.length - 1)) % ps.length]!;
		const ops = [
			(i: number) => `offer ${randomInt(1, 3)} muschel an ${other(i).name} für ${randomInt(1, 3)} münze`,
			(i: number) => `offer münze an ${other(i).name} für muschel`,
			() => "accept",
			() => "decline",
			() => `markt biete muschel für ${randomInt(1, 3)}`,
			() => `markt kaufe ${randomInt(1, 4)}`,
			() => `markt zurück ${randomInt(1, 4)}`,
			(i: number) => `give münze an ${other(i).name}`,
			() => "offer zurück",
		];
		const end = Date.now() + 15_000;
		await Promise.all(ps.map(async (x, i) => {
			while (Date.now() < end) { x.p.send(ops[randomInt(0, ops.length)]!(i)); await new Promise((r) => setTimeout(r, randomInt(20, 120))); }
		}));
		await eventually(async () => !(await s.count({ type: "Intent" })), 60_000, "every command taken");
		await new Promise((r) => setTimeout(r, 2_000)); // the last ones commit
		const chars = new Set(ps.map((x) => x.me));
		const live = new Set((await s.readAll({ type: "Listing" })).map((e) => String(e.fields.listingId)));
		let atPlayers = 0, inEscrow = 0;
		for (const id of seeded) {
			const copies = (await s.readAll({ type: "Item", fields: { itemId: id } })).map((e) => e.fields as Record<string, any>);
			assert.equal(copies.length, 1, `item ${id} exists exactly once (found ${copies.length})`);
			const at = copies[0]!;
			if (chars.has(at.location)) atPlayers++;
			else { assert.equal(at.location, "market", `item ${id} is with a player or on the market (at ${at.location})`); assert.ok(live.has(at.listing), `item ${id} in escrow behind a live listing`); inEscrow++; }
		}
		// it really moved things: count what succeeded (each player hears its own successes)
		const said = ps.flatMap((x) => x.p.frames.flatMap((f) => (f.t === "msg" ? [f.m.text] : [])));
		const done = { trades: said.filter((t) => t.startsWith("Tausch mit ")).length, bought: said.filter((t) => t.startsWith("Du kaufst ")).length, withdrawn: said.filter((t) => t.startsWith("Du holst ")).length, gifts: said.filter((t) => /^Du gibst .+ Münze\.$/.test(t)).length };
		console.log(`conservation: ${seeded.length} items, ${atPlayers} with players, ${inEscrow} in escrow, ${live.size} listings; ${JSON.stringify(done)}`);
		assert.ok(done.trades + done.bought + done.withdrawn + done.gifts >= 20, `enough really happened: ${JSON.stringify(done)}`);
		await Promise.all(ps.map((x) => x.p.leave()));
	} finally { await srv.close(); }
});

test("the page's trade view: offers to and from a player, the boards only where they stand, numbered like the commands", async () => {
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.002" } });
	try {
		const s = srv.stack.space;
		// a fire for the whole test keeps the fog down and the way east open (game time runs fast here)
		await lightFire(s, 120_000);
		await eventually(async () => Number((await s.readIfExists({ type: "Fog", fields: { room: "graue-bucht" } }, 2_000))?.fields.level) === 0, 15_000, "fog cleared");
		const a = await player(srv.url, "Sicht"), b = await player(srv.url, "Gegenueber");
		await give(s, a.me, "muschel", 1);
		const tv = (p: Player) => [...p.frames].reverse().find((f) => f.t === "trade") as Extract<ServerFrame, { t: "trade" }> | undefined;
		await does(a.p, "offer muschel an Gegenueber für münze", "Du bietest");
		await b.p.until((f) => f.t === "trade" && f.trade.offersIn.length === 1);
		assert.deepEqual(tv(b.p)!.trade.offersIn[0]!.giveNames, ["Muschel"]);
		assert.equal(tv(a.p)!.trade.offersOut[0]!.toName, "Gegenueber");
		await eventually(async () => (tv(a.p)?.trade.orders?.length ?? 0) > 0, 15_000, "the order board shows in the bay");
		await does(a.p, "markt biete muschel für 3", "ans Marktbrett");
		await b.p.until((f) => f.t === "trade" && f.trade.listings?.[0]?.price === 3 && !f.trade.listings[0].mine);
		await a.p.until((f) => f.t === "trade" && f.trade.listings?.[0]?.mine === true);
		const n = b.p.frames.length;
		b.p.send("go ost");
		await b.p.until((f) => f.t === "trade" && f.trade.listings === null && f.trade.orders === null, 10_000, n);
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});
