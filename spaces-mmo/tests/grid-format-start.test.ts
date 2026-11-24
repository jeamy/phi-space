// The start check in the processes (server/engine/grid-format.ts; with SPACES_MMO_WORLD_CMD, SPACES_MMO_NPC_CMD and
// SPACES_MMO_WEB_CMD the Rust ones): on a store whose GridFormat entry names another format the world worker, the npc
// process and the web process stop before they write, and say why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER } from "phi-spaces";
import { startStack } from "./stack.ts";

test("world, npc and web processes refuse a store of another grid format", { timeout: 240_000 }, async () => {
	const stack = await startStack(); // a legacy store: the first world worker starts
	try {
		await stack.space.write({ type: "GridFormat", fields: { worldId: "leuchtfeuer", gridScale: 2, derivedFrom: 1, occupancy: "footprints", state: "complete" } }, null, FOREVER);
		await assert.rejects(stack.worldProcess(), /grid format: the store is in the grid format gridScale 2/);
		await assert.rejects(stack.npcProcess(), /grid format: the store is in the grid format gridScale 2/);
		await assert.rejects(stack.webProcess(), /grid format: the store is in the grid format gridScale 2/);
	} finally { await stack.close(); }
});
