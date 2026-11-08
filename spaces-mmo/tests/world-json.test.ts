// The world definition is data (docs/rust-portierung.en.md, R8.0 item 1): the engine reads worlds/<id>/world.json, which
// npm run world:json writes from the world's world.ts. The checked-in file must be what world.ts makes now, and it must
// say all of it: JSON loses nothing of the definition (no function, no undefined, no Map, no NaN).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { worldJson, worldJsonPath } from "../scripts/world-json.ts";
import { loadWorld } from "../server/engine/world.ts";

test("worlds/leuchtfeuer/world.json is what world.ts generates (else: npm run world:json)", async () => {
	assert.ok(readFileSync(worldJsonPath("leuchtfeuer"), "utf8") === await worldJson("leuchtfeuer"), "world.json is not current: run npm --prefix spaces-mmo run world:json");
});

test("the JSON keeps the whole definition, and loadWorld reads it", async () => {
	const { world } = await import("../worlds/leuchtfeuer/world.ts");
	assert.deepStrictEqual(JSON.parse(JSON.stringify(world)), world);
	const w = await loadWorld("leuchtfeuer");
	assert.deepStrictEqual(w, JSON.parse(JSON.stringify(world)));
	assert.equal(w.version, world.version);
});
