// Building, step 1 (docs/siedeln.md, "Wie ein Bau entsteht", engine/commands/build.ts): a site is staked out only in
// the light and never on a way; twenty people delivering at once, up to two cells away, fill it exactly (what it does not need stays in their
// packs); shared work finishes it exactly once; nobody walks into it; a fire's light carries only so many buildings.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
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
async function does(p: Player, line: string, text: string | RegExp, ms = 40_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
async function give(space: SpaceLike, charId: string, proto: string, count: number): Promise<void> {
	const p = (await eventually(() => resolvePrototype(space, proto), 10_000, `prototype ${proto}`))!;
	for (let i = 0; i < count; i++) await spawn(space, null, w, p, { location: charId, x: -1, y: -1 });
}
async function walk(a: P, space: SpaceLike, x: number, y: number): Promise<void> {
	a.p.send(`move ${x} ${y}`);
	await eventually(async () => { const c = (await space.readAll({ type: "Character", fields: { charId: a.me } }))[0]?.fields; return c?.x === x && c?.y === y; }, 40_000, `${a.name} at ${x},${y}`);
}
const pack = async (space: SpaceLike, charId: string, proto: string) => (await space.readAll({ type: "Item", fields: { location: charId, proto } })).length;
/** Flotsam of the tide that lies where the site goes is taken away (the tide is fast here). */
async function clear(space: SpaceLike, cells: Array<[number, number]>): Promise<void> {
	for (const e of await space.readAll({ type: "Item", fields: { location: "graue-bucht" } })) if (cells.some(([x, y]) => e.fields.x === x && e.fields.y === y)) await space.takeIfExists({ id: e.id }, 0);
}

test("building: a hut is staked out only in the light and not on a way, filled exactly by twenty at once, finished once by shared work", { timeout: 240_000 }, async () => {
	// 0.001: a world hour (the rest after work) is 3.6 s
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.001" } });
	try {
		const s = srv.stack.space;
		const boss = await player(srv.url, "Baumeisterin");
		await walk(boss, s, 16, 11);
		// no fire, no building
		assert.match(await does(boss.p, "bau hütte 16 12", /Licht|Feuer/), /aus; gebaut wird nur im Licht|kein Feuer/);
		await lightFire(s, 600_000, "feuer-bucht");
		// a guest helps but owns nothing
		const guest = new Player(srv.url);
		assert.equal((await guest.post("/api/guest")).status, 200);
		await guest.play();
		assert.match(await does(guest, "bau hütte", "Gäste"), /registriere dich/);
		// never on a way out: the exit east is at 23,8
		assert.match(await does(boss.p, "bau hütte 22 7", "passt keine Hütte"), /Weg hinaus/);
		// nor at the fire (9,10)
		assert.match(await does(boss.p, "bau hütte 9 11", "passt keine Hütte"), /nah am Feuer/);
		// the hut at 16,12–17,13
		const foot: Array<[number, number]> = [[16, 12], [17, 12], [16, 13], [17, 13]];
		let staked = "";
		for (let i = 0; i < 5 && !staked.includes("steckt"); i++) { await clear(s, foot); staked = await does(boss.p, "baue eine hütte 16 12", /steckt eine Baustelle ab|passt keine/); }
		assert.match(staked, /Baumeisterin steckt eine Baustelle ab: Hütte\. Es fehlen 6 Treibholz, 2 Tangseil, 20 Arbeit/);
		assert.equal((await s.readAll({ type: "Plot", fields: { room: "graue-bucht" } })).length, 4);
		assert.match(await does(boss.p, "bau hütte", "offene Baustelle"), /bau sie erst fertig/);
		// nobody walks into it
		assert.match(await does(boss.p, "step 0 1", "Bau"), /Dort steht ein Bau/);

		// twenty people around it, beside it and two cells away (SITE_REACH: the 12 cells beside a 2×2 hut would not hold
		// them), each with one piece of driftwood; they deliver at once: exactly six are taken
		const ring: Array<[number, number]> = [[15, 11], [17, 11], [18, 11], [15, 12], [18, 12], [15, 13], [18, 13], [15, 14], [16, 14], [17, 14], [18, 14],
			[14, 10], [15, 10], [16, 10], [17, 10], [18, 10], [19, 11], [19, 12], [19, 13], [19, 14]];
		const crew: P[] = [];
		for (let i = 0; i < ring.length; i++) { const a = await player(srv.url, `Helfer${i}`); await walk(a, s, ring[i]![0], ring[i]![1]); await give(s, a.me, "treibholz", 1); crew.push(a); }
		await give(s, boss.me, "tangseil", 3);
		const answers = await Promise.all(crew.map((a) => does(a.p, "liefere treibholz", /Du lieferst|genug|keine Baustelle|greifbar/)));
		assert.equal(answers.filter((t) => t.startsWith("Du lieferst")).length, 6, answers.join("\n"));
		// and nobody is told there is no site while another's delivery holds it
		assert.equal(answers.filter((t) => /keine Baustelle|greifbar/.test(t)).length, 0, answers.join("\n"));
		let left = 0;
		for (const a of crew) left += await pack(s, a.me, "treibholz");
		assert.equal(left, 14, "what it did not need stayed in the packs");
		// three cells away is too far
		assert.match(await does(guest, "arbeite", "näher"), /höchstens zwei Schritte/);
		// more than it needs stays with the one who brings it
		assert.match(await does(boss.p, "liefere 3 tangseil", "Du lieferst"), /2 Stück Tangseil/);
		assert.equal(await pack(s, boss.me, "tangseil"), 1);

		// shared work: twenty-one hands finish it once (twenty points; whoever comes late finds it done)
		const hands = [boss, ...crew];
		const work = async (some = hands) => Promise.all(some.map((a) => does(a.p, "arbeite", /arbeitet an der Hütte|Arbeit getan|müde|keine Baustelle/)));
		// half of them first, so the rest after work shows before the hut stands
		await work(hands.slice(0, 10));
		assert.match(await does(boss.p, "arbeite", "müde"), /noch müde/);
		// rounds after a rest until it stands (under load a hand may still be tired: its point comes a round later)
		for (let i = 0; i < 6 && !(await s.readAll({ type: "Building" })).length; i++) { await new Promise((ok) => setTimeout(ok, 4_000)); await work(); }
		await eventually(async () => (await s.readAll({ type: "Building" })).length === 1, 30_000, "the hut stands");
		assert.equal((await s.readAll({ type: "Site" })).length, 0);
		const hut = (await s.readAll({ type: "Building" }))[0]!.fields as Record<string, any>;
		assert.equal(hut.ownerName, "Baumeisterin");
		assert.equal(Object.values(hut.by as Record<string, number>).reduce((a, b) => a + b, 0), 6 + 2 + 20, "every piece and point counted once");
		assert.deepEqual((await s.readAll({ type: "Plot", fields: { room: "graue-bucht" } })).map((e) => e.fields.of).filter((x) => x === hut.buildId).length, 4, "the cells are the hut's now");
		await boss.p.until((f) => f.t === "msg" && f.m.text.startsWith("Die Hütte von Baumeisterin steht!"), 10_000);
		// the page sees it as a building of 2×2 cells
		await boss.p.until((f) => f.t === "obj" && f.o.kind === "building" && f.o.w === 2 && f.o.h === 2, 10_000);

		// the light is full: the fire carries no further building
		await s.takeIfExists({ type: "LightUse", fields: { beaconId: "feuer-bucht" } }, 0);
		await s.write({ type: "LightUse", fields: { beaconId: "feuer-bucht", used: 20 } }, null, FOREVER);
		const other = crew[0]!;
		await walk(other, s, 20, 12);
		assert.match(await does(other.p, "bau hütte", /Licht|passt keine/), /Licht des Feuers reicht/);
		for (const a of [boss, ...crew]) await a.p.leave();
		await guest.leave();
	} finally { await srv.close(); }
});

test("building, part 2: the chest is the owner's; anyone repairs; a building not kept falls into ruin and its chest waits as an estate; demolition frees the land", { timeout: 240_000 }, async () => {
	const { worldNowOf } = await import("../server/engine/clock.ts");
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.001" } });
	try {
		const s = srv.stack.space;
		const boss = await player(srv.url, "Siedlerin"), other = await player(srv.url, "Nachbar");
		await lightFire(s, 600_000, "feuer-bucht");
		await walk(boss, s, 16, 11);
		await walk(other, s, 18, 12);
		const accountId = String((await s.readAll({ type: "Character", fields: { charId: boss.me } }))[0]!.fields.accountId);
		/** A hut of Siedlerin at 16,12 as a finished build leaves it. */
		const hut = async (buildId: string) => {
			const now = await worldNowOf(s);
			for (const [x, y] of [[16, 12], [17, 12], [16, 13], [17, 13]]) await s.write({ type: "Plot", fields: { room: "graue-bucht", x, y, of: buildId } }, null, FOREVER);
			await s.takeIfExists({ type: "LightUse", fields: { beaconId: "feuer-bucht" } }, 0);
			await s.write({ type: "LightUse", fields: { beaconId: "feuer-bucht", used: 1 } }, null, FOREVER);
			await s.write({ type: "Building", fields: { buildId, plan: "huette", name: "Hütte", room: "graue-bucht", x: 16, y: 12, w: 2, h: 2, owner: boss.me, ownerName: "Siedlerin", accountId, beaconId: "feuer-bucht", points: 1, by: { Siedlerin: 28 }, untilWorldMs: now + 7 * 24 * 3600_000, builtAt: now } as never }, null, FOREVER);
		};
		const light = async () => Number((await s.readAll({ type: "LightUse", fields: { beaconId: "feuer-bucht" } }))[0]?.fields.used ?? 0);
		const plots = async () => (await s.readAll({ type: "Plot", fields: { room: "graue-bucht" } })).length;
		await hut("b1");
		await give(s, boss.me, "muschel", 3);
		// the chest: the owner's alone
		assert.match(await does(boss.p, "leg 2 muscheln in die truhe", "Truhe"), /Du legst 2 Muschel in die Truhe/);
		assert.match(await does(boss.p, "truhe", "Truhe"), /In der Truhe \(2\/12\): 2 Muschel/);
		assert.match(await does(other.p, "truhe", /nicht dein Bau|neben deinen Bau/), /nicht dein Bau/);
		assert.match(await does(boss.p, "nimm 1 muschel aus der truhe", "aus der Truhe"), /Du nimmst 1 Muschel/);
		assert.equal(await pack(s, boss.me, "muschel"), 2);
		// anyone repairs, with material
		assert.match(await does(other.p, "repariere", "brauchst du"), /brauchst du 1 Treibholz/);
		await give(s, other.me, "treibholz", 1);
		assert.match(await does(other.p, "repariere", "bessert"), /Nachbar bessert die Hütte von Siedlerin aus; sie hält wieder etwa 7 Tage/);

		// not kept: its time runs out, it becomes a ruin; the light goes back, the chest waits as an estate
		const b = (await s.readAll({ type: "Building" }))[0]!;
		await s.takeIfExists({ id: b.id }, 0);
		await s.write({ type: "Building", fields: { ...b.fields, untilWorldMs: (await worldNowOf(s)) - 1 } }, null, FOREVER);
		await eventually(async () => (await s.readAll({ type: "Ruin" })).length === 1, 20_000, "a ruin");
		assert.equal((await s.readAll({ type: "Building" })).length, 0);
		assert.equal(await light(), 0, "the light went back");
		assert.equal(await plots(), 4, "the ruin still covers its cells");
		assert.match(await does(other.p, "nachlass", "Nachlass"), /kein Nachlass von dir/);
		assert.match(await does(boss.p, "nachlass", "Nachlass"), /Du holst deinen Nachlass ab: 1 Dinge/);
		assert.equal(await pack(s, boss.me, "muschel"), 3);
		// the ruin's time runs out: the land is free
		const r = (await s.readAll({ type: "Ruin" }))[0]!;
		await s.takeIfExists({ id: r.id }, 0);
		await s.write({ type: "Ruin", fields: { ...r.fields, untilWorldMs: (await worldNowOf(s)) - 1 } }, null, FOREVER);
		await eventually(async () => (await plots()) === 0 && !(await s.readAll({ type: "Ruin" })).length, 20_000, "the ruin is gone");

		// demolition: half the material back, the chest into the pack, the land and the light free
		await hut("b2");
		await does(boss.p, "verstaue muschel", "Truhe");
		assert.match(await does(boss.p, "reiße die hütte ab", "reißt die Hütte ab"), /Siedlerin reißt die Hütte ab; die Fläche ist frei\. Zurück: 3 Treibholz, 1 Tangseil\. Aus der Truhe: 1 Dinge/);
		assert.equal(await plots(), 0);
		assert.equal(await light(), 0);
		assert.equal(await pack(s, boss.me, "treibholz"), 3);
		assert.equal(await pack(s, boss.me, "muschel"), 3);
		// a site given up gives back all that was delivered
		await clear(s, [[16, 12], [17, 12], [16, 13], [17, 13]]);
		await does(boss.p, "bau hütte 16 12", "steckt eine Baustelle ab");
		await does(boss.p, "liefere 2 treibholz", "Du lieferst");
		assert.match(await does(boss.p, "abriss baustelle", "gibt die Baustelle"), /Zurück an Siedlerin: 2 Treibholz/);
		assert.equal(await pack(s, boss.me, "treibholz"), 3);
		assert.equal(await plots(), 0);
		await boss.p.leave(); await other.p.leave();
	} finally { await srv.close(); }
});
