// Trees (docs/siedeln.en.md "Bäume", engine/commands/trees.ts): a tree's seed is planted with a spade in the light, the
// tree grows in stages on the second clock (slower in fog, held in winter) and stands until it is felled; felled with an
// axe it gives logs, which are driftwood to every recipe; a birch sprouts again from its stump, a fruit tree bears and is
// picked by its owner only, and the fruit is eaten.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { advanceTree, nextDate } from "../server/engine/commands/trees.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { ItemFields, TreeFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, lightFire, Player, startServer } from "./stack.ts";

const w = await loadWorld();
const d = w.trees!;
const H = 3600_000, D = 24 * H;

test("tree rules: stages on the world clock times the patience, slower in fog; grown it bears, ripe it waits to be picked; winter holds it", () => {
	const birke = d.sorts.find((s) => s.key === "birke")!, apfel = d.sorts.find((s) => s.key === "apfelbaum")!;
	const tree = (over: Partial<TreeFields>): TreeFields => ({ treeId: "t", sort: "apfelbaum", room: "r", x: 0, y: 0, w: 1, h: 1, owner: "o", ownerName: "O", accountId: "a", beaconId: "f", points: 1, stage: 0, dueWorldMs: 0, at: 0, ...over });
	// a seedling becomes a young tree after its first stage, 24 times longer at patience 24, half again as long in fog 1
	assert.equal(nextDate(birke, 0, 0, 0, 24), birke.grow[0] * 24);
	assert.equal(nextDate(birke, 1, 10, 1, 1), 10 + birke.grow[1] * 1.5);
	// grown: a birch bears nothing, an apple tree bears every day (times the patience)
	assert.equal(nextDate(birke, 2, 0, 0, 24), FOREVER);
	assert.equal(nextDate(apfel, 2, 5, 3, 24), 5 + D * 24, "fog slows the growing, not the bearing");
	const t = tree({ stage: 1, dueWorldMs: 100 });
	assert.equal(advanceTree(d, t, 99, 0, 1, null), false, "before its date nothing changes");
	assert.equal(advanceTree(d, t, 100, 0, 1, null), true);
	assert.deepEqual([t.stage, t.dueWorldMs, t.ripe], [2, 100 + apfel.crop!.everyWorldMs, undefined]);
	assert.equal(advanceTree(d, t, t.dueWorldMs, 0, 1, null), true);
	assert.deepEqual([t.ripe, t.dueWorldMs], [true, FOREVER], "ripe, it waits for its owner");
	// winter: its date moves to the spring, the stage stays
	const young = tree({ stage: 0, dueWorldMs: 50 });
	assert.equal(advanceTree(d, young, 60, 0, 1, 9_000), true);
	assert.deepEqual([young.stage, young.dueWorldMs], [0, 9_000]);
});

async function does(p: Player, line: string, text: string | RegExp, ms = 30_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
async function give(space: SpaceLike, charId: string, proto: string, count: number): Promise<void> {
	const p = (await eventually(() => resolvePrototype(space, proto), 10_000, `prototype ${proto}`))!;
	for (let i = 0; i < count; i++) await spawn(space, null, w, p, { location: charId, x: -1, y: -1 });
}
type P = { p: Player; me: string; name: string };
async function player(url: string, name: string): Promise<P> {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	return { p, me: (await p.play()).me.charId, name };
}
async function walk(a: P, space: SpaceLike, x: number, y: number): Promise<void> {
	a.p.send(`move ${x} ${y}`);
	await eventually(async () => { const c = (await space.readAll({ type: "Character", fields: { charId: a.me } }))[0]?.fields; return c?.x === x && c?.y === y; }, 40_000, `${a.name} at ${x},${y}`);
}
const carried = async (space: SpaceLike, charId: string) => (await space.readAll({ type: "Item", fields: { location: charId } })).map((e) => e.fields as unknown as ItemFields);
const treeAt = (space: SpaceLike, x: number, y: number) => eventually(async () => (await space.readAll({ type: "Tree", fields: { x, y } })).map((e) => e.fields as unknown as TreeFields)[0], 15_000, `the tree at ${x},${y}`);
/** Moves a tree on as the days would: its entry rewritten with a stage and a date (the tree tick then takes it from there). */
async function set(space: SpaceLike, t: TreeFields, over: Partial<TreeFields>): Promise<void> {
	const e = await eventually(() => space.take({ type: "Tree", fields: { treeId: t.treeId } }, 5_000), 15_000, "the tree");
	const { ripe: _, ...rest } = e!.fields as unknown as TreeFields;
	await space.write({ type: "Tree", fields: { ...rest, ...over } as never }, null, FOREVER);
}
async function clear(space: SpaceLike, room: string, cells: Array<[number, number]>): Promise<void> {
	for (const e of await space.readAll({ type: "Item", fields: { location: room } })) if (cells.some(([x, y]) => e.fields.x === x && e.fields.y === y)) await space.takeIfExists({ id: e.id }, 0);
}

test("a birch and an apple tree: planted with a spade in the light, felled with an axe for logs that are driftwood, picked by their owner, eaten", { timeout: 240_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const anna = await player(srv.url, "Försterin"), bert = await player(srv.url, "Bert");
		await walk(anna, s, 16, 11);
		await give(s, anna.me, "samen-birke", 1);
		await give(s, anna.me, "apfelkern", 1);
		assert.match(await does(anna.p, "pflanze birkensamen 16 12", "Spaten"), /brauchst du einen Spaten/);
		await give(s, anna.me, "spaten", 1);
		assert.match(await does(anna.p, "pflanze birkensamen 16 12", /Licht|Feuer/), /gepflanzt wird nur im Licht|kein Feuer|ist aus/);
		await lightFire(s, 600_000, "feuer-bucht");
		await clear(s, "graue-bucht", [[16, 12], [17, 12]]);
		assert.match(await does(anna.p, "pflanze birkensamen 16 12", "pflanzt"), /Försterin pflanzt Birkensamen ein: Hier wächst bald eine Birke/);
		const birch = await treeAt(s, 16, 12);
		assert.deepEqual([birch.sort, birch.stage, birch.owner], ["birke", 0, anna.me]);
		assert.ok(birch.dueWorldMs < FOREVER, "it has a date to grow on");
		assert.equal((await s.readAll({ type: "Plot", fields: { room: "graue-bucht", of: birch.treeId } })).length, 1, "it takes its cell");
		await anna.p.until((f) => f.t === "obj" && f.o.kind === "tree" && f.o.treeStage === 0 && f.o.name === "Birke", 10_000);
		assert.match(await does(anna.p, "baum", "Birke von"), /Birke von Försterin \(16 12\): Setzling, ein junger Baum in etwa/);

		// felled only grown, with an axe, by its owner
		assert.match(await does(anna.p, "fälle", "Axt"), /brauchst du eine Axt/);
		await give(s, anna.me, "axt", 1);
		assert.match(await does(anna.p, "fälle", "jung"), /Birke: noch zu jung zum Fällen/);
		await set(s, birch, { stage: 2, dueWorldMs: FOREVER });
		await walk(bert, s, 15, 12);
		await give(s, bert.me, "axt", 1);
		assert.match(await does(bert.p, "fälle 16 12", "gehört"), /Dieser Baum \(Birke\) gehört Försterin/);
		assert.match(await does(anna.p, "fälle", "fällt"), /Försterin fällt die Birke: 4 Scheit\. Aus dem Stumpf treibt ein neuer Baum aus\./);
		const logs = (await carried(s, anna.me)).filter((i) => i.name === "Scheit");
		assert.equal(logs.length, 4);
		assert.ok(logs.every((i) => i.proto === "treibholz" && i.icon === "items/scheit.png"), "a log is driftwood under its own name and icon");
		const stump = await treeAt(s, 16, 12);
		assert.deepEqual([stump.stage, stump.dueWorldMs < FOREVER], [1, true], "the stump sprouts: a young tree again");
		assert.equal((await carried(s, anna.me)).find((i) => i.proto === "axt")?.wear, 5, "the axe wears");

		// a log is driftwood to a recipe: the axe takes two of them
		await give(s, anna.me, "stein", 1);
		await give(s, anna.me, "tangseil", 1);
		assert.match(await does(anna.p, "craft axt", "Axt"), /Axt/);
		assert.equal((await carried(s, anna.me)).filter((i) => i.name === "Scheit").length, 2);

		// an apple tree grows on by the tree tick, bears, and only its owner picks it
		await walk(anna, s, 17, 11);
		assert.match(await does(anna.p, "pflanze apfelkerne 18 12", "pflanzt"), /Hier wächst bald ein Apfelbaum/);
		const apple = await treeAt(s, 18, 12);
		await set(s, apple, { stage: 1, dueWorldMs: 0 });
		await eventually(async () => (await treeAt(s, 18, 12)).stage === 2, 30_000, "the apple tree grown");
		assert.match(await does(anna.p, "ernte baum", "reif"), /Apfelbaum: noch nichts reif; in etwa/);
		await set(s, await treeAt(s, 18, 12), { stage: 2, dueWorldMs: 0 });
		await eventually(async () => (await treeAt(s, 18, 12)).ripe === true, 30_000, "apples ripe");
		await anna.p.until((f) => f.t === "obj" && f.o.kind === "tree" && f.o.ripe === true, 10_000);
		await walk(bert, s, 19, 11);
		assert.match(await does(bert.p, "ernte baum", "gehört"), /Dieser Baum \(Apfelbaum\) gehört Försterin; ernten darf nur, wer ihn gepflanzt hat/);
		assert.match(await does(anna.p, "ernte", "erntet"), /Försterin erntet den Apfelbaum: 4 Apfel/, "with no bed near, „ernte“ means the tree");
		const picked = await treeAt(s, 18, 12);
		assert.deepEqual([picked.ripe, picked.dueWorldMs < FOREVER], [undefined, true], "it bears again");
		assert.match(await does(anna.p, "iss apfel", /satt|isst/), /isst|satt/);
		assert.equal((await carried(s, anna.me)).filter((i) => i.proto === "apfel").length, 3);
	} finally { await srv.close(); }
});
