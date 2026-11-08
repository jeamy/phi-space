// Acceptance of Phase 4 (docs/phasen.en.md): trade and economy. Every exchange moves its items in one transaction, so a
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
import "../server/npc/scripts.ts"; // first: it and the economy import each other, scripts.ts is the entry
import { answerWanted, type Look } from "../server/npc/economy.ts";
import { marketTick, RESTOCK_WORLD_MS } from "../server/engine/commands/trade.ts";
import { sweepTick } from "../server/engine/sweep.ts";
import type { Npc } from "../server/npc/scripts.ts";
import type { CharacterFields, ItemFields } from "../server/model.ts";

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
		await does(a.p, "offer treibholz an Nehmer für muschel", "Du bietest Nehmer Treibholz für Muschel an.");
		await b.p.until((f) => f.t === "msg" && f.m.text.startsWith("Anbieter bietet dir Treibholz für Muschel an."));
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
		assert.match(await does(b.p, "markt biete münze für 2", "nichts"), /Münzen gegen Münzen/);
		await does(a.p, "markt biete muschel für 2", "Du hängst Muschel für 2 Münzen ans Marktbrett.");
		assert.equal((await s.readIfExists({ type: "Item", fields: { itemId: shell } }, 2_000))!.fields.location, "market");
		assert.match(await does(b.p, "markt", "Marktbrett:"), /1\. Muschel für 2 Münzen \(von Haendlerin\)/);
		assert.match(await does(a.p, "markt kaufe 1", "eigenes"), /zurück/);
		await does(b.p, "markt kaufe 1", "Du kaufst Muschel vom Marktbrett.");
		assert.equal((await pack(s, b.me, "muschel")).length, 1);
		assert.equal((await pack(s, b.me, "muenze")).length, 1);
		assert.equal((await pack(s, a.me, "muenze")).length, 2);
		assert.equal(await s.count({ type: "Listing" }), 0);
		// a lot of one kind for one price together, said as one says it
		await give(s, a.me, "muschel", 10);
		await give(s, b.me, "muenze", 14);
		await does(a.p, "verkaufe 10 muscheln um 15 münzen", "Du hängst 10× Muschel für 15 Münzen ans Marktbrett.");
		assert.equal((await s.readAll({ type: "Item", fields: { location: "market", proto: "muschel" } })).length, 10);
		await b.p.until((f) => f.t === "trade" && f.trade.listings?.[0]?.count === 10);
		assert.match(await does(b.p, "markt", "Marktbrett:"), /1\. 10× Muschel für 15 Münzen \(von Haendlerin\)/);
		await does(b.p, "markt kaufe 1", "Du kaufst 10× Muschel vom Marktbrett.");
		assert.equal((await pack(s, b.me, "muschel")).length, 11);
		assert.equal((await pack(s, a.me, "muenze")).length, 17);
		assert.equal((await s.readAll({ type: "Item", fields: { location: "market" } })).length, 0);
		await does(b.p, "markt biete 3 muscheln für 4", "Du hängst 3× Muschel");
		await does(b.p, "markt zurück 1", "Du holst 3× Muschel vom Marktbrett zurück.");
		assert.equal((await pack(s, b.me, "muschel")).length, 11);
		for (const e of (await s.readAll({ type: "Item", fields: { location: b.me, proto: "muschel" } })).slice(1)) await s.take({ id: e.id }, 2_000);
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

test("market: a wanted notice holds the buyer's coins; delivering moves thing and coins at once; withdrawn or lapsed, the coins go back", async () => {
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.002" } });
	try {
		const s = srv.stack.space;
		const a = await player(srv.url, "Ziegenhirtin"), b = await player(srv.url, "Ziegensucher");
		await give(s, b.me, "muenze", 5);
		assert.match(await does(b.p, "markt suche ziege für 9", "brauchst du"), /9 Münzen/);
		assert.match(await does(b.p, "markt suche münze für 2", "nichts"), /Münzen gegen Münzen/);
		assert.match(await does(b.p, "markt suche flugdrache für 2", "gibt es nicht"), /Flugdrache/i);
		const posted = b.p.frames.length;
		await does(b.p, "markt suche ziegen für 5", "Du suchst am Marktbrett Ziege und zahlst 5 Münzen.");
		// no trader at this board sells goats: the one who seeks hears at once who does, where and for how much
		await b.p.until((f) => f.t === "msg" && /^An diesem Brett verkauft kein Händler Ziege; Gesa \([^)]+\) verkauft es für 8 Münzen\./.test(f.m.text), 10_000, posted);
		assert.equal((await pack(s, b.me, "muenze")).length, 0);
		assert.equal((await s.readAll({ type: "Item", fields: { location: "market", proto: "muenze" } })).length, 5, "the coins wait at the board");
		assert.match(await does(a.p, "markt", "Gesuche"), /1\. Ziegensucher sucht Ziege, zahlt 5 Münzen/);
		await a.p.until((f) => f.t === "trade" && f.trade.wanted?.[0]?.protoName === "Ziege" && !f.trade.wanted[0].mine);
		assert.match(await does(b.p, "markt liefere 1", "eigenes"), /zurück/);
		assert.match(await does(a.p, "markt liefere 1", "nicht bei dir"), /Ziege/);
		await give(s, a.me, "ziege", 1);
		const from = b.p.frames.length;
		await does(a.p, "markt liefere 1", "Du lieferst Ziegensucher Ziege und bekommst 5 Münzen.");
		await b.p.until((f) => f.t === "msg" && f.m.text.includes("Ziegenhirtin liefert dir Ziege"), 10_000, from);
		assert.equal((await pack(s, b.me, "ziege")).length, 1);
		assert.equal((await pack(s, a.me, "muenze")).length, 5);
		assert.equal(await s.count({ type: "Wanted" }), 0);
		assert.equal((await s.readAll({ type: "Item", fields: { location: "market" } })).length, 0);
		// several of one kind, said with a count; delivered only whole
		await give(s, b.me, "muenze", 4);
		assert.match(await does(b.p, "markt suche 2 flugdrachen für 2", "gibt es nicht"), /Flugdrache/i);
		await does(b.p, "markt suche 1 bienenvolk für 1", "Du suchst am Marktbrett Bienenvolk und zahlst 1 Münze.");
		await does(b.p, "markt suche 2 ziegen für 3", "Du suchst am Marktbrett 2× Ziege und zahlst 3 Münzen.");
		await give(s, a.me, "ziege", 1);
		assert.match(await does(a.p, "markt liefere 2", "trägst nur"), /Gesucht sind 2× Ziege; du trägst nur 1/);
		await give(s, a.me, "ziege", 1);
		// the seeker is away: the word waits for it, and comes when it is back (once)
		await b.p.leave();
		await does(a.p, "markt liefere 2", "Du lieferst Ziegensucher 2× Ziege und bekommst 3 Münzen.");
		assert.equal((await s.readAll({ type: "Notice", fields: { charId: b.me } })).filter((e) => !e.fields.told).length, 1, "one untold (the first was told while it was there)");
		await b.p.play();
		await b.p.until((f) => f.t === "msg" && f.m.text.startsWith("Ziegenhirtin liefert dir 2× Ziege für dein Gesuch am Marktbrett") && f.m.mine === true, 10_000);
		// told once, then kept: marked told, and a new page has it in its log (not as new again)
		await eventually(async () => (await s.readAll({ type: "Notice", fields: { charId: b.me } })).every((e) => e.fields.told === true), 10_000, "the word marked told");
		await b.p.leave();
		const again = await b.p.play();
		assert.ok(again.log.some((m) => m.text.startsWith("Ziegenhirtin liefert dir 2× Ziege für dein Gesuch")), "kept in the log of a new page");
		assert.equal(await s.count({ type: "Notice", fields: { charId: b.me } }), 2, "both still kept");
		assert.equal((await pack(s, b.me, "ziege")).length, 3);
		await does(b.p, "markt suche zurück 1", "deine 1 Münze hast du wieder");
		for (const e of await s.readAll({ type: "Item", fields: { location: b.me, proto: "muenze" } })) await s.take({ id: e.id }, 2_000);
		// withdrawn: the coins come back
		await give(s, b.me, "muenze", 2);
		await does(b.p, "suche eine Muschel für 2 Münzen", "Du suchst am Marktbrett Muschel");
		assert.match(await does(a.p, "markt suche zurück 1", "nicht dein"), /Gesuch/);
		await does(b.p, "markt suche zurück 1", "deine 2 Münzen hast du wieder");
		assert.equal((await pack(s, b.me, "muenze")).length, 2);
		// lapsed: the market ticker gives the coins back
		await does(b.p, "markt suche muschel für 2", "Du suchst");
		const wn = (await s.readAll({ type: "Wanted" }))[0]!;
		await s.take({ type: "Wanted", id: wn.id }, 2_000);
		await s.write({ type: "Wanted", fields: { ...wn.fields, expiresWorldMs: 0 } }, null, Number.MAX_SAFE_INTEGER); // its time is up
		await b.p.play();
		const lapsedFrom = b.p.frames.length;
		await sweepTick(s, w);
		await b.p.until((f) => f.t === "msg" && f.m.text.startsWith("Dein Gesuch nach Muschel am Marktbrett") && f.m.text.includes("ist abgelaufen; niemand hat geliefert. Deine 2 Münzen bekommst du zurück.") && f.m.toMe === true, 10_000, lapsedFrom);
		await eventually(async () => (await pack(s, b.me, "muenze")).length === 2, 10_000, "the coins back with the buyer");
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});

test("market: a notice is answered with a price, delivered for less with the rest back; a trader delivers for its price or answers once", async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const a = await player(srv.url, "Imkerin"), b = await player(srv.url, "Honigsucher");
		await give(s, b.me, "muenze", 10);
		await does(b.p, "markt suche bienenvolk für 3", "Du suchst am Marktbrett Bienenvolk");
		// an answer: the one who seeks hears it, the page shows it under the notice
		assert.match(await does(a.p, "markt antworte 1 ab 2", "gleich liefern"), /markt liefere 1/);
		const from = b.p.frames.length;
		await does(a.p, "markt antworte 1 ab 8", "Du antwortest Honigsucher: Bienenvolk ab 8 Münzen.");
		await b.p.until((f) => f.t === "msg" && f.m.text.includes("Imkerin antwortet auf dein Gesuch nach Bienenvolk") && f.m.text.includes("ab 8 Münzen liefert Imkerin"), 10_000, from);
		const t = await b.p.until((f) => f.t === "trade" && !!f.trade.wanted?.[0]?.replies.length, 10_000);
		const wv = (t as Extract<ServerFrame, { t: "trade" }>).trade.wanted![0]!;
		assert.deepEqual(wv.replies, [{ name: "Imkerin", ask: 8 }]);
		assert.equal(wv.traded, true, "Gesa deals in bee colonies");
		assert.ok(wv.until === null || wv.until > Date.now(), "it still hangs");
		assert.match(await does(a.p, "markt", "Gesuche"), /zahlt 3 Münzen \(Imkerin: ab 8\)/);
		// delivered for less: the rest goes back
		await give(s, a.me, "bienenvolk", 1);
		const before = b.p.frames.length;
		await does(a.p, "markt liefere 1 für 2", "Du lieferst Honigsucher Bienenvolk und bekommst 2 Münzen.");
		await b.p.until((f) => f.t === "msg" && f.m.text.includes("1 Münze bekommst du zurück"), 10_000, before);
		assert.equal((await pack(s, a.me, "muenze")).length, 2);
		assert.equal((await pack(s, b.me, "muenze")).length, 8);
		assert.equal((await pack(s, b.me, "bienenvolk")).length, 1);

		// a trader at the board: the notices it deals in, by its price list
		const acts: string[] = [];
		const me = { charId: "npc-test-gesa", room: "graue-bucht" } as CharacterFields;
		const n = { def: { npcId: "test-gesa", name: "Gesa", prices: { bienenvolk: [4, 8], honig: [2, 4] } }, charId: me.charId, space: s, world: w, act: async (l: string) => { acts.push(l); } } as unknown as Npc;
		await give(s, b.me, "muenze", 10);
		const look = (pack: string[]): Look => ({ me, pack: pack.map((proto, i) => ({ itemId: `x${i}`, proto, name: proto } as ItemFields)), ground: [] });
		await does(b.p, "markt suche bienenvolk für 3", "Du suchst");
		await does(b.p, "markt suche tang für 1", "Du suchst");
		assert.equal(await answerWanted(n, look([])), true);
		assert.deepEqual(acts, ["market antworte 1 ab 8"], "too little: its price");
		// answered once: not again (the answer stands on the notice)
		acts.length = 0;
		const wn = (await s.readAll({ type: "Wanted", fields: { proto: "bienenvolk" } }))[0]!;
		await s.take({ id: wn.id }, 2_000);
		await s.write({ type: "Wanted", fields: { ...wn.fields, replies: [{ charId: me.charId, name: "Gesa", ask: 8 }] } }, null, Number.MAX_SAFE_INTEGER);
		assert.equal(await answerWanted(n, look(["bienenvolk"])), false, "tang it does not deal in, bienenvolk it answered");
		// enough offered and in stock: it delivers for its price
		await does(b.p, "markt suche 2 honig für 9", "Du suchst");
		assert.equal(await answerWanted(n, look(["honig"])), true, "only one in stock: it says so");
		assert.deepEqual(acts, ["market antworte 3 keins"]);
		acts.length = 0;
		// the answer as a player gives it: the one who seeks hears it, the board shows it, and the trader says it once
		const told = b.p.frames.length;
		await does(a.p, "markt antworte 3 keins", "Du antwortest Honigsucher: 2× Honig hast du gerade nicht.");
		await b.p.until((f) => f.t === "msg" && f.m.text.includes("Imkerin antwortet auf dein Gesuch nach 2× Honig") && f.m.text.includes("Honig hat Imkerin gerade nicht"), 10_000, told);
		assert.match(await does(a.p, "markt", "Gesuche"), /2× Honig, zahlt 9 Münzen \(Imkerin: gerade keins\)/);
		const wh = (await s.readAll({ type: "Wanted", fields: { proto: "honig" } }))[0]!;
		await s.take({ id: wh.id }, 2_000);
		await s.write({ type: "Wanted", fields: { ...wh.fields, replies: [{ charId: me.charId, name: "Gesa", ask: 0 }] } }, null, Number.MAX_SAFE_INTEGER);
		assert.equal(await answerWanted(n, look(["honig"])), false, "said once: not again");
		// its stock back: it delivers for its price
		assert.equal(await answerWanted(n, look(["honig", "honig"])), true);
		assert.deepEqual(acts, ["market liefere 3 für 8"]);
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});

test("market: a trader's stock comes back, one a world day, up to what it started with", async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space, gesa = "npc-gesa";
		const start = w.npcs.find((n) => n.npcId === "gesa")!.carry!.find((c) => c.proto === "bienenvolk")!.count;
		await eventually(async () => (await pack(s, gesa, "bienenvolk")).length === start, 20_000, "Gesa's bee colonies");
		for (const e of await s.readAll({ type: "Item", fields: { location: gesa, proto: "bienenvolk" } })) await s.take({ id: e.id }, 2_000); // sold
		await marketTick(s, w);
		const due = async () => { const e = (await s.readAll({ type: "Restock", fields: { charId: gesa, proto: "bienenvolk" } }))[0]; return e; };
		const first = (await due())!;
		assert.equal((await pack(s, gesa, "bienenvolk")).length, 0, "the clock starts; nothing yet");
		assert.ok(Number(first.fields.nextWorldMs) > 0 && RESTOCK_WORLD_MS === 24 * 3600_000);
		await marketTick(s, w);
		assert.equal((await pack(s, gesa, "bienenvolk")).length, 0, "not before its time");
		for (let i = 1; i <= start; i++) {
			const r = (await due())!;
			await s.take({ id: r.id }, 2_000);
			await s.write({ type: "Restock", fields: { ...r.fields, nextWorldMs: 0 } }, null, Number.MAX_SAFE_INTEGER); // its time is up
			await marketTick(s, w);
			assert.equal((await pack(s, gesa, "bienenvolk")).length, i);
		}
		assert.equal(await due(), undefined, "full again: no clock");
		await marketTick(s, w);
		assert.equal((await pack(s, gesa, "bienenvolk")).length, start, "never more than it started with");
	} finally { await srv.close(); }
});

test("craft with a count: forms of the name and of the number, as many as the pack gives, a second tool takes over", async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const a = await player(srv.url, "Seiler");
		await give(s, a.me, "tang", 15);
		await does(a.p, "craft 2 tangseile", "Du stellst 2 Tangseil her.");
		// what the figure itself did is for it (the events' „An dich“), though the room is told too
		assert.equal((a.p.frames.findLast((f) => f.t === "msg" && f.m.text === "Du stellst 2 Tangseil her.") as Extract<ServerFrame, { t: "msg" }>).m.mine, true);
		await does(a.p, "craft zwei seile", "Du stellst 2 Tangseil her.");
		assert.equal((await pack(s, a.me, "tangseil")).length, 4);
		const from = a.p.frames.length;
		await does(a.p, "craft 3x tangseil", "Du stellst Tangseil her.");
		await a.p.until((f) => f.t === "msg" && f.m.text === "Für 3 reicht es nicht, es wurden 1. Dir fehlt: 3× tang.", 10_000, from);
		assert.equal((await pack(s, a.me, "tang")).length, 0);
		assert.match(await does(a.p, "craft 2 tangseile", "Dir fehlt"), /3× tang/);
		assert.match(await does(a.p, "craft 21 tangseile", "Höchstens"), /Höchstens 20/);
		assert.match(await does(a.p, "craft 3 kiesel", "Ein Rezept"), /„3 kiesel“/);
		// two knives of 5 uses: seven bundles, the first breaks in between, the second keeps its wear
		await give(s, a.me, "muschel", 4);
		await give(s, a.me, "treibholz", 23);
		await does(a.p, "craft 2 muschelmesser", "Du stellst 2 Muschelmesser her.");
		assert.match(await does(a.p, "craft 7 holzbündel", "Du stellst 7 Holzbündel her."), /Muschelmesser zerbricht/);
		assert.deepEqual((await pack(s, a.me, "muschelmesser")).map((k) => k.wear), [3]);
		assert.equal((await pack(s, a.me, "treibholz")).length, 0, "23 - 2 - 7 × 3");
		await a.p.leave();
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

test("conservation: a fuzz of trades, purchases, withdrawals and gifts across two world workers loses or doubles nothing", { timeout: 360_000 }, async () => {
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
		// at least 15 s, longer while a loaded machine has got little done (what counts is what happened)
		const start = Date.now(), succeeded = () => ps.flatMap((x) => x.p.frames.flatMap((f) => (f.t === "msg" && /^(Tausch mit |Du kaufst |Du holst |Du gibst )/.test(f.m.text) ? [1] : []))).length;
		await Promise.all(ps.map(async (x, i) => {
			while (Date.now() - start < 15_000 || (succeeded() < 20 && Date.now() - start < 240_000)) { x.p.send(ops[randomInt(0, ops.length)]!(i)); await new Promise((r) => setTimeout(r, randomInt(20, 120))); }
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
		assert.ok(done.trades + done.bought + done.withdrawn + done.gifts >= 10, `enough really happened: ${JSON.stringify(done)}`);
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

test("an offer ends when one side leaves the room: withdrawn, the other side told, gone from the lists", async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		await s.write({ type: "Flame", fields: { beaconId: "feuer-bucht", until: Date.now() + 120_000, litAt: Date.now() } as never }, null, 120_000); // the ways open
		const a = await player(srv.url, "Bleibende"), b = await player(srv.url, "Gehende");
		await give(s, b.me, "muschel", 1);
		await does(b.p, "offer muschel an Bleibende", "Du bietest Bleibende");
		await a.p.until((f) => f.t === "trade" && f.trade.offersIn.length === 1);
		const from = a.p.frames.length;
		b.p.send("go ost");
		await a.p.until((f) => f.t === "msg" && f.m.text === "Gehende ist gegangen; das Angebot gilt nicht mehr.", 15_000, from);
		await a.p.until((f) => f.t === "trade" && f.trade.offersIn.length === 0, 15_000, from);
		assert.equal(await s.count({ type: "Offer" }), 0, "withdrawn");
		assert.equal((await pack(s, b.me, "muschel")).length, 1, "the shell stays with her");
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});
