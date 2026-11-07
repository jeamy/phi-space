// Scenery (worlds/leuchtfeuer/scenery.ts, engine/commands/scenery.ts): it stands where it can, keeps the ways open, and clearing
// it frees the land for good.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER } from "phi-spaces";
import { loadWorld, sceneryText, walkable } from "../server/engine/world.ts";
import { eventually, Player, startServer } from "./stack.ts";
import type { CharacterFields, ItemFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";

const w = await loadWorld();

test("every piece says what it is and how it can be cleared", () => {
	for (const s of w.scenery ?? []) assert.ok(w.sceneryAbout?.[s.name], `${s.name} has no text`);
	assert.match(sceneryText(w, { name: "Hoher Stein", fixed: true, yields: [], left: 0 }), /aufrechter Stein.*bleibt stehen/);
	assert.match(sceneryText(w, { name: "Felsbrocken", yields: [{ proto: "stein", count: 1 }], left: 3 }), /noch 3 Arbeit\), das bringt 1 Stein\.$/);
});
const cells = (s: { x: number; y: number; w: number; h: number }) => Array.from({ length: s.w * s.h }, (_, i) => ({ x: s.x + (i % s.w), y: s.y + Math.floor(i / s.w) }));

test("no piece stands on a way, a door, a fire, a thing or a person's place, and every exit of a room still reaches the others", () => {
	for (const s of w.scenery ?? []) {
		const room = w.rooms.find((r) => r.roomId === s.room)!;
		assert.ok(room, s.sceneryId);
		if (s.through) continue;
		for (const c of cells(s)) {
			assert.ok(walkable(w, room.ground, c.x, c.y), `${s.sceneryId}: land at ${c.x},${c.y}`);
			assert.notEqual(room.ground[c.y]![c.x], ":", `${s.sceneryId}: on the path`);
			for (const e of w.exits.filter((x) => x.room === s.room)) assert.ok(Math.max(Math.abs(e.x - c.x), Math.abs(e.y - c.y)) > 1, `${s.sceneryId}: at a door`);
			for (const b of w.beacons.filter((x) => x.room === s.room)) assert.ok(Math.max(Math.abs(b.x - c.x), Math.abs(b.y - c.y)) > 1, `${s.sceneryId}: at a fire`);
			assert.ok(!w.objects.some((o) => o.room === s.room && o.x === c.x && o.y === c.y), `${s.sceneryId}: on a thing`);
		}
	}
	for (const room of w.rooms) {
		const solid = new Set((w.scenery ?? []).filter((s) => s.room === room.roomId && !s.through).flatMap((s) => cells(s).map((c) => `${c.x},${c.y}`)));
		const exits = w.exits.filter((e) => e.room === room.roomId);
		if (exits.length < 2) continue;
		const seen = new Set([`${exits[0]!.x},${exits[0]!.y}`]), queue = [exits[0]!as { x: number; y: number }];
		while (queue.length) { const c = queue.pop()!; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) { const n = { x: c.x + dx, y: c.y + dy }, k = `${n.x},${n.y}`; if (!seen.has(k) && !solid.has(k) && walkable(w, room.ground, n.x, n.y)) { seen.add(k); queue.push(n); } } }
		for (const e of exits) assert.ok(seen.has(`${e.x},${e.y}`), `${room.roomId}: ${e.name} cut off`);
	}
});

test("a piece is cleared work by work; its cells are free, its wood in the pack, and a new world version does not bring it back", { timeout: 120_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const piece = await eventually(async () => (await s.readAll({ type: "Scenery", fields: { sceneryId: "bucht-boot" } }))[0], 10_000, "scenery");
		assert.ok((await s.readAll({ type: "Plot", fields: { room: "graue-bucht", of: "bucht-boot" } })).length === 3);
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Raeumer", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const c = (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0], 10_000, "char"))!;
		await s.takeIfExists({ id: c.id }, 2_000);
		await s.write({ type: "Character", fields: { ...(c.fields as unknown as CharacterFields), room: "graue-bucht", x: 14, y: 7 } as never }, null, FOREVER);
		assert.ok(piece);
		for (let i = 0; i < 40 && (await s.readAll({ type: "Scenery", fields: { sceneryId: "bucht-boot" } })).length; i++) {
			for (const r of await s.readAll({ type: "WorkRest", fields: { charId: me } })) await s.takeIfExists({ id: r.id }, 1_000);
			const from = p.frames.length;
			p.send("räume");
			await p.until((f: ServerFrame) => f.t === "msg", 5_000, from).catch(() => {});
			await new Promise((r) => setTimeout(r, 200));
		}
		// the page saw each stage of it: the piece stays on the map until the last work
		assert.ok(p.frames.some((f: ServerFrame) => f.t === "obj" && f.o.id === "bucht-boot" && f.o.left === 3), "the piece comes back with the work left");
		assert.equal(p.frames.findLastIndex((f: ServerFrame) => f.t === "objgone" && f.id === "bucht-boot") > p.frames.findLastIndex((f: ServerFrame) => f.t === "obj" && f.o.id === "bucht-boot"), true, "gone only at the end");
		assert.equal((await s.readAll({ type: "Scenery", fields: { sceneryId: "bucht-boot" } })).length, 0);
		assert.equal((await s.readAll({ type: "Plot", fields: { room: "graue-bucht", of: "bucht-boot" } })).length, 0);
		assert.equal((await s.readAll({ type: "SceneryGone", fields: { sceneryId: "bucht-boot" } })).length, 1);
		assert.equal((await s.readAll({ type: "Item", fields: { location: me } })).map((e) => e.fields as unknown as ItemFields).filter((i) => i.proto === "treibholz").length, 2);
		await p.leave();
	} finally { await srv.close(); }
});

test("the world map shows a player what is theirs, wherever it stands, and nobody else's", { timeout: 60_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const a = new Player(srv.url), b = new Player(srv.url);
		assert.equal((await a.post("/api/register", { name: "Eignerin", password: "geheim-123" })).status, 200);
		assert.equal((await b.post("/api/register", { name: "Nachbar", password: "geheim-123" })).status, 200);
		const me = (await a.play()).me.charId;
		await b.play();
		await s.write({ type: "Building", fields: { buildId: "b-karte", plan: "huette", name: "Hütte", room: "duenen", x: 3, y: 3, w: 2, h: 2, owner: me, ownerName: "Eignerin", accountId: "x" } as never }, null, FOREVER);
		const f = await a.until((x: ServerFrame) => x.t === "atlasState" && x.state.mine.length > 0, 10_000) as Extract<ServerFrame, { t: "atlasState" }>;
		assert.deepEqual(f.state.mine, [{ id: "b-karte", kind: "building", name: "Hütte", room: "duenen", x: 3, y: 3 }]);
		const other = await b.until((x: ServerFrame) => x.t === "atlasState", 10_000) as Extract<ServerFrame, { t: "atlasState" }>;
		assert.deepEqual(other.state.mine, []);
		// its tasks come the same way: grain ground at a mill waits for it, and only for it
		await s.write({ type: "MillLoad", fields: { loadId: "l-karte", buildId: "m-x", room: "duenen", x: 6, y: 6, w: 2, h: 2, charId: me, name: "Eignerin", from: "weizen", to: "mehl", count: 4, readyWorldMs: 0, untilWorldMs: Number.MAX_SAFE_INTEGER } as never }, null, FOREVER);
		const t = await a.until((x: ServerFrame) => x.t === "atlasState" && x.state.todos.length > 0, 10_000) as Extract<ServerFrame, { t: "atlasState" }>;
		assert.match(t.state.todos[0]!.text, /^4 Mehl wartet an der Windmühle in .+ \(6 6\): abholen/);
		assert.deepEqual((await b.until((x: ServerFrame) => x.t === "atlasState", 10_000) as Extract<ServerFrame, { t: "atlasState" }>).state.todos, []);
		await a.leave(); await b.leave();
	} finally { await srv.close(); }
});
