// Mill and bakery, step 3 part 2 (docs/siedeln.md "Warenketten", engine/commands/mill.ts): grain brought at once to a
// mill queues load after load, each figure gets exactly its own flour, none early and none twice; a storm surge grinds
// ahead; a mill that falls gives back the grain it had not ground; bread only beside a bakery; flax to linen with a
// spindle.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { stormTurnsMills } from "../server/engine/commands/mill.ts";
import { buildSweep } from "../server/engine/commands/build.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld, walkable } from "../server/engine/world.ts";
import { worldNowOf } from "../server/engine/clock.ts";
import type { BuildingFields, MillLoadFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, Player, startServer } from "./stack.ts";

const w = await loadWorld();
const m = w.mill!;
const HOUR = 3600_000;

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
const pack = async (space: SpaceLike, charId: string, proto: string) => (await space.readAll({ type: "Item", fields: { location: charId, proto } })).length;
const loads = async (space: SpaceLike, buildId?: string) => (await space.readAll({ type: "MillLoad", ...(buildId ? { fields: { buildId } } : {}) })).map((e) => e.fields as unknown as MillLoadFields);
async function building(space: SpaceLike, f: Partial<BuildingFields> & Pick<BuildingFields, "buildId" | "plan" | "name" | "x" | "y">): Promise<BuildingFields> {
	const b: BuildingFields = { room: "graue-bucht", w: 2, h: 2, owner: "o", ownerName: "O", accountId: "a", beaconId: "feuer-bucht", points: 2, by: {}, untilWorldMs: FOREVER, builtAt: 0, ...f };
	for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) await space.write({ type: "Plot", fields: { room: b.room, x, y, of: b.buildId } as never }, null, FOREVER);
	await space.write({ type: "Building", fields: b as never }, null, FOREVER);
	return b;
}
/** Walks to the first free cell of `cells` beside something (flotsam cleared first; a cell someone took is skipped). */
async function besideIt(a: P, space: SpaceLike, cells: Array<[number, number]>): Promise<void> {
	for (;;) {
		const [x, y] = cells.shift()!;
		for (const e of await space.readAll({ type: "Item", fields: { location: "graue-bucht" } })) if (e.fields.x === x && e.fields.y === y) await space.takeIfExists({ id: e.id }, 0);
		a.p.send(`move ${x} ${y}`);
		if (await eventually(async () => { const c = (await space.readAll({ type: "Character", fields: { charId: a.me } }))[0]?.fields; return c?.x === x && c?.y === y; }, 15_000, "").then(() => true, () => false)) return;
	}
}

test("a mill: five bring grain at once, each gets exactly their own flour; a storm grinds ahead; a fallen mill gives the grain back; bread at the bakery, linen with a spindle", { timeout: 300_000 }, async () => {
	// 0.001: a world hour (one handful at the mill) is 3.6 s
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.001" } });
	try {
		const s = srv.stack.space;
		const miller = await player(srv.url, "Müllerin");
		const accountId = String((await s.readAll({ type: "Character", fields: { charId: miller.me } }))[0]!.fields.accountId);
		const mill = await building(s, { buildId: "muehle-1", plan: "windmuehle", name: "Windmühle", x: 16, y: 12, owner: miller.me, ownerName: miller.name, accountId });
		const room = w.rooms.find((r) => r.roomId === "graue-bucht")!;
		const fire = w.beacons.find((b) => b.beaconId === "feuer-bucht")!;
		const ring: Array<[number, number]> = [];
		for (let y = mill.y - 1; y <= mill.y + mill.h; y++) for (let x = mill.x - 1; x <= mill.x + mill.w; x++)
			if ((x < mill.x || x >= mill.x + mill.w || y < mill.y || y >= mill.y + mill.h) && walkable(w, room.ground, x, y) && Math.max(Math.abs(x - fire.x), Math.abs(y - fire.y)) > 1) ring.push([x, y]);

		assert.match(await does(miller.p, "mahle weizen", /trägst nichts|Geh direkt/), /Du trägst nichts/);
		await give(s, miller.me, "weizen", 2);
		assert.match(await does(miller.p, "mahle weizen", "Geh direkt"), /Geh direkt neben eine Windmühle/, "far from the mill");
		const crew: P[] = [miller];
		for (let i = 0; crew.length < 5; i++) crew.push(await player(srv.url, `Bauer${i}`));
		for (const a of crew) await besideIt(a, s, ring);
		for (const a of crew.slice(1)) await give(s, a.me, "weizen", 2);
		await give(s, crew[1]!.me, "kohl", 1);
		assert.match(await does(crew[1]!.p, "mahle kohl", "mahlt nur"), /mahlt nur Korn: Weizen, Gerste, Hafer/);

		// five at once: the loads queue, two hours each, none overlapping
		const before = await worldNowOf(s);
		await Promise.all(crew.map((a) => does(a.p, "mahle alle weizen", "Dein Mehl ist in etwa")));
		const ls = (await loads(s)).sort((a, b) => a.readyWorldMs - b.readyWorldMs);
		assert.equal(ls.length, 5);
		assert.deepEqual(new Set(ls.map((l) => l.charId)), new Set(crew.map((a) => a.me)), "one load each");
		assert.ok(ls.every((l) => l.count === 2 && l.from === "weizen" && l.to === "mehl"));
		assert.ok(ls[0]!.readyWorldMs >= before + 2 * m.unitWorldMs);
		for (let i = 1; i < ls.length; i++) assert.ok(ls[i]!.readyWorldMs - ls[i - 1]!.readyWorldMs >= 2 * m.unitWorldMs, "a load starts when the one before is ground");
		const millNow = () => s.readAll({ type: "Building", fields: { buildId: mill.buildId } }).then((e) => e[0]!.fields as unknown as BuildingFields);
		assert.equal((await millNow()).busyUntilWorldMs, ls.at(-1)!.readyWorldMs);
		for (const a of crew) assert.equal(await pack(s, a.me, "weizen"), 0);
		const last = crew.find((a) => a.me === ls.at(-1)!.charId)!;
		assert.match(await does(last.p, "abholen", "noch nicht"), /noch nicht gemahlen/, "none early");
		assert.match(await does(last.p, "mahle", "zu mahlen"), /hat noch \d+ Stunden zu mahlen/);

		// a storm surge on the island: everything waiting moves six hours forward
		await stormTurnsMills(s, w, "graue-bucht");
		const after = (await loads(s)).sort((a, b) => a.readyWorldMs - b.readyWorldMs);
		assert.equal(after.at(-1)!.readyWorldMs, ls.at(-1)!.readyWorldMs - m.stormWorldMs);
		assert.equal((await millNow()).busyUntilWorldMs, ls.at(-1)!.readyWorldMs - m.stormWorldMs);
		await stormTurnsMills(s, w, "kupferhafen-markt");
		assert.equal((await loads(s)).sort((a, b) => a.readyWorldMs - b.readyWorldMs).at(-1)!.readyWorldMs, after.at(-1)!.readyWorldMs, "a storm elsewhere does not turn it");

		// all ground: everyone fetches at once, exactly their own two
		await eventually(async () => (await worldNowOf(s)) >= after.at(-1)!.readyWorldMs, 60_000, "all ground");
		await Promise.all(crew.map((a) => does(a.p, "abholen", "Du holst 2 Mehl ab")));
		for (const a of crew) assert.equal(await pack(s, a.me, "mehl"), 2, `${a.name}: two flour`);
		assert.equal((await loads(s)).length, 0);
		assert.match(await does(miller.p, "abholen", "kein Mehl"), /Hier wartet kein Mehl auf dich/, "none twice");

		// at most three loads waiting per figure
		await give(s, miller.me, "gerste", 4);
		for (let i = 0; i < 3; i++) await does(miller.p, "mahle 1 gerste", "Dein Mehl ist");
		assert.match(await does(miller.p, "mahle 1 gerste", "Säcke"), /schon 3 Säcke von dir/);
		// the mill is torn down: what it had not ground comes back as grain
		assert.match(await does(miller.p, "abriss windmühle", "reißt"), /holen die, die es brachten, hier ab/);
		assert.ok((await loads(s)).every((l) => l.to === "gerste"));
		assert.match(await does(miller.p, "abholen", "Du holst"), /Du holst 3 Gerste ab/);
		assert.equal(await pack(s, miller.me, "gerste"), 4);

		// a mill nobody kept becomes a ruin: its loads stop the same way
		const old = await building(s, { buildId: "muehle-2", plan: "windmuehle", name: "Windmühle", x: 4, y: 4, untilWorldMs: (await worldNowOf(s)) - 1 });
		const pending: MillLoadFields = { loadId: "l-ruin", buildId: old.buildId, room: old.room, x: old.x, y: old.y, w: 2, h: 2, charId: miller.me, name: miller.name, from: "hafer", to: "mehl", count: 4, readyWorldMs: FOREVER - 1, untilWorldMs: FOREVER };
		await s.write({ type: "MillLoad", fields: pending as never }, null, FOREVER);
		await buildSweep(s, w);
		assert.equal(await s.count({ type: "Ruin", fields: { buildId: old.buildId } }), 1);
		const back = (await loads(s, old.buildId))[0]!;
		assert.equal(back.to, "hafer");
		assert.ok(back.readyWorldMs <= (await worldNowOf(s)));

		// bread: only beside a bakery; anyone bakes there
		const baker = crew[2]!;
		await give(s, baker.me, "wasserkanne", 1);
		await give(s, baker.me, "treibholz", 1);
		assert.match(await does(baker.p, "backe brot", "nur direkt"), /Brot macht man nur direkt neben einem Backhaus/);
		await building(s, { buildId: "backhaus-1", plan: "backhaus", name: "Backhaus", x: 16, y: 12 });
		assert.match(await does(baker.p, "backe", "3 Brot"), /stellt 3 Brot her|stellst 3 Brot her/);
		assert.equal(await pack(s, baker.me, "brot"), 3);
		assert.equal(await pack(s, baker.me, "mehl"), 0);
		assert.equal(await pack(s, baker.me, "wasserkanne"), 0);

		// linen: flax with a spindle
		await give(s, baker.me, "flachs", 3);
		assert.match(await does(baker.p, "craft leinen", "Werkzeug"), /Werkzeug: spindel/);
		await give(s, baker.me, "muschel", 1);
		await give(s, baker.me, "treibholz", 1);
		await does(baker.p, "craft spindel", "Spindel her");
		await does(baker.p, "craft leinen", "Leinen her");
		assert.equal(await pack(s, baker.me, "leinen"), 1);
		assert.equal(await pack(s, baker.me, "spindel"), 1, "the spindle wears, it is not used up");
	} finally { await srv.close(); }
});
