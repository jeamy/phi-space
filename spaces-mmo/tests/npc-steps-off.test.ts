// An NPC that stands still (Marta at her stall) holds its cell: when a process takes up its role it arrives (npc-host.ts),
// which claims its Spot, so nobody builds where it stands; and where something was built on its cell while no process
// played it, it steps off onto the nearest free cell. Run with SPACES_MMO_NPC_CMD for the Rust npc process.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER } from "phi-spaces";
import { eventually, placeFootprint, startServer } from "./stack.ts";

test("a standing NPC takes its Spot when its role is taken up, and steps off a building put on its cell", { timeout: 120_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const before = (await s.readAll({ type: "Character", fields: { charId: "npc-marta" } }))[0]!.fields;
		// a rain barrel built on her cell while no process played her
		await placeFootprint(s, String(before.room), "tonne-x", { x: Number(before.x), y: Number(before.y) });
		await srv.stack.npcProcess({ SPACES_MMO_NPCS: "marta" });
		const spot = await eventually(async () => (await s.readAll({ type: "Spot", fields: { charId: "npc-marta" } }))[0]?.fields, 20_000, "Marta's Spot");
		const now = (await s.readAll({ type: "Character", fields: { charId: "npc-marta" } }))[0]!.fields;
		assert.ok(!(now.x === before.x && now.y === before.y), "off the barrel");
		assert.ok(Math.max(Math.abs(Number(now.x) - Number(before.x)), Math.abs(Number(now.y) - Number(before.y))) <= 2, "beside it");
		assert.deepEqual([spot!.x, spot!.y], [now.x, now.y], "her Spot is where she stands: nobody builds there");
	} finally { await srv.close(); }
});
