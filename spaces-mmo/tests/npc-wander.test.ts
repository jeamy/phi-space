// An idle NPC wanders within its room's inner edge, taken from the room's ground (shared/grid.ts wanderBounds, used by server/npc/economy.ts;
// npc/economy.rs wander_bounds): the same bounds as before at scale 1, the whole room at scale 2.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { wanderBounds } from "../shared/grid.ts";

const rooms = (file: string) => (JSON.parse(readFileSync(new URL(`../worlds/leuchtfeuer/${file}`, import.meta.url), "utf8")) as { rooms: Array<{ roomId: string; ground: string[] }> }).rooms;

test("an idle NPC's bounds are its room's inner edge, at both scales", () => {
	for (const r of rooms("world.json")) assert.deepEqual(wanderBounds(r.ground), { maxX: 22, maxY: 14 }, `${r.roomId} at scale 1: as the clamp was`);
	for (const r of rooms("world-scale2.json")) assert.deepEqual(wanderBounds(r.ground), { maxX: 46, maxY: 30 }, `${r.roomId} at scale 2`);
	assert.deepEqual(wanderBounds([]), { maxX: 22, maxY: 14 }, "a room without ground as before");
});
