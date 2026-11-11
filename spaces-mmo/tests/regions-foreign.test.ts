// What one region's space holds of another region's rooms (2026-11-11, docs/rust-portierung.en.md R8.6): once a world worker
// that was told no region loaded the whole world into the west's space, and its rooms, fires and fog of the other regions
// stayed there; the web part showed whichever region's stream it read last. Now the web part takes a thing of the world's
// rooms only from the region its room lies in, and a world worker refuses a space that is not its own.
import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { FOREVER } from "phi-spaces";
import { loadWorld } from "../server/engine/world.ts";
import { regionOfRoom } from "../server/engine/regions.ts";
import { Player, startRegions, startWeb } from "./stack.ts";
import type { ServerFrame } from "../shared/frames.ts";

const w = await loadWorld("leuchtfeuer");

test("regions: the web part shows a room, its fog and its fire from the room's own region, not an old copy in another", async () => {
	const r = await startRegions();
	try {
		const west = r.space("west"), ost = r.space("ost");
		const ostRooms = w.rooms.filter((x) => regionOfRoom(w, x.roomId) === "ost").map((x) => x.roomId);
		const srv = await startWeb({ port: 0, space: "unix:/nowhere", accounts: r.accounts, regions: r.list });
		try {
			// old copies in the west, written while the web part follows the streams (so the west's come last): every east
			// room renamed, its fog thick
			const rooms = await ost.readAll({ type: "Room" });
			for (const e of rooms) await west.write({ type: "Room", fields: { ...e.fields, name: `Alt ${String(e.fields.name)}` } as never }, null, FOREVER);
			for (const room of ostRooms) await west.write({ type: "Fog", fields: { room, level: 3 } as never }, null, FOREVER);
			await new Promise((ok) => setTimeout(ok, 1_500));
			const own = Object.fromEntries((await ost.readAll({ type: "Fog" })).map((e) => [String(e.fields.room), Number(e.fields.level)]));
			// four guests, one per region's bay: the east one stands in rauchhafen
			for (let i = 0; i < 4; i++) {
				const p = new Player(srv.url);
				assert.equal((await p.post("/api/guest")).status, 200);
				const h = await p.play();
				if (regionOfRoom(w, h.room.roomId) !== "ost") { await p.leave(); continue; }
				assert.doesNotMatch(String(h.room.name), /^Alt /, "the room from the east's own space");
				assert.equal(h.fog, own[h.room.roomId] ?? 0, "the fog of the east's own space");
				const atlas = await p.until((f) => f.t === "atlasState", 10_000) as Extract<ServerFrame, { t: "atlasState" }>;
				for (const room of ostRooms) assert.equal(atlas.state.fog[room] ?? 0, own[room] ?? 0, `the fog of ${room} on the map`);
				await p.leave();
			}
		} finally { await srv.close(); }
	} finally { await r.close(); }
});

test("regions: a world worker refuses a space that is not its own", { timeout: 300_000 }, async () => {
	const r = await startRegions({ workers: false });
	try {
		// told no region while the regions are configured
		await assert.rejects(r.worldProcess("nord", { SPACES_MMO_REGION: "" }), /SPACES_MMO_REGION none/);
		// told no region, at a region's space (an NPC was born there)
		await r.space("nord").write({ type: "NpcBorn", fields: { charId: "npc-x" } as never }, null, FOREVER);
		await assert.rejects(r.worldProcess("nord", { SPACES_MMO_REGION: "", SPACES_MMO_REGIONS: "" }), /a region's/);
		// a region at a space that holds a room of another region
		const room = w.rooms.find((x) => regionOfRoom(w, x.roomId) === "ost")!;
		await r.space("west").write({ type: "Room", fields: { roomId: room.roomId, name: room.name } as never }, null, FOREVER);
		await assert.rejects(r.worldProcess("west"), new RegExp(`room ${room.roomId} of the region ost`));
		// its own space: it starts
		await r.worldProcess("sued");
	} finally { await r.close(); }
});
