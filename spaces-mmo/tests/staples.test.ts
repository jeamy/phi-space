// What one builds with never runs out, and paths stay free (docs/siedeln.md "Bebauung", engine/fire.ts bringStaples):
// the tide fills every island's beaches with driftwood and kelp up to their number; a hut is refused on the cobbles.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { floodTick } from "../server/engine/fire.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { lightFire, Player, startServer, startStack } from "./stack.ts";

const w = await loadWorld();
const st = w.flood.staples!;

test("the tide: each island gets its driftwood and kelp up to the number, then writes no more; what is taken comes back", { timeout: 60_000 }, async () => {
	const stack = await startStack();
	process.env.SPACES_MMO_STAPLES = "";
	try {
		const s = stack.space;
		const rooms = (island: string) => w.flood.rooms.filter((f) => w.rooms.find((r) => r.roomId === f.room)?.island === island).map((f) => f.room);
		const islands = [...new Set(w.rooms.map((r) => r.island))].filter((i): i is string => !!i && rooms(i).length > 0);
		assert.equal(islands.length, new Set(w.rooms.map((r) => r.island)).size, "every island has a beach of the tide");
		const lying = async (island: string, proto: string) => { let n = 0; for (const room of rooms(island)) n += await s.count({ type: "Item", fields: { location: room, proto, flotsam: true } }); return n; };
		for (let i = 0; i < 8; i++) await floodTick(s, w, 60_000);
		for (const island of islands) for (const t of st.things) assert.ok((await lying(island, t.proto)) >= t.perIsland, `${island}: ${t.proto}`);
		const grey = islands[0]!, wood = await lying(grey, "treibholz");
		for (const room of rooms(grey)) for (const e of await s.readAll({ type: "Item", fields: { location: room, proto: "treibholz" } })) await s.takeIfExists({ id: e.id }, 0);
		assert.ok(wood > 0);
		for (let i = 0; i < 6; i++) await floodTick(s, w, 60_000);
		assert.ok((await lying(grey, "treibholz")) >= st.things[0]!.perIsland, "taken away, it comes back");
	} finally { process.env.SPACES_MMO_STAPLES = "0"; await stack.close(); }
});

test("a path stays free: no hut and no bed on the cobbles", { timeout: 90_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Ida", password: "geheim-123" })).status, 200);
		await p.play();
		const room = w.rooms.find((r) => r.roomId === "graue-bucht")!;
		await lightFire(s, 600_000, "feuer-bucht");
		const y = room.ground.findIndex((l) => l.includes(":"));
		const x = room.ground[y]!.indexOf(":");
		const from = p.frames.length;
		p.send(`bau hütte ${x} ${y}`);
		const f = await p.until((f) => f.t === "msg" && /Weg|passt keine/.test(f.m.text), 20_000, from);
		assert.match((f as Extract<ServerFrame, { t: "msg" }>).m.text, /Das ist ein Weg/);
	} finally { await srv.close(); }
});
