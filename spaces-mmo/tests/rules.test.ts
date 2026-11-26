// The rule table (shared/rules.ts, docs/3d-welt-und-raster-plan-2026-11-21.en.md section 2.4): the Rust engine's copy
// (rust/mmo-engine/src/rules.rs) has the same rows with the same values and kinds, the constants are the table at the
// scale of the loaded world (useGridScale, live bindings an importer reads at each use), and at scale 1 every value is
// the literal it replaced (docs/raster-inventur-2026-11-24.en.md section 1), so taking the values from the table changed
// nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as rules from "../shared/rules.ts";
import { gridScale, RULE_TABLE, ruleAt, useGridScale, type RuleName, type RuleRow } from "../shared/rules.ts";
import { BESIDE, COMMAND_PATH } from "../shared/rules.ts";

/** The literals the code had before the table (inventory section 1, and the NPC wander found with it). */
const LEGACY: Record<RuleName, number> = {
	BESIDE: 1, REACH_POINT: 1, FEED_FIRE: 1, FIRE_CLEARANCE: 1, PASSAGE: 1, SITE_REACH: 2, EXIT_REACH: 2, SETTLER_CLEARANCE: 2,
	MOVE_BUILDING: 3, MOVE_WINDOW: 2, FLOWER_NEIGHBOUR: 1, FREE_CELL_RADIUS: 8, COMMAND_PATH: 40, SPAWN_SCATTER_X: 3,
	SPAWN_SCATTER_Y: 2, NPC_WANDER_X: 4, NPC_WANDER_Y: 3, ARENA_TRAIL_PATH: 400, ARENA_SUBGOAL_NEAR: 3, ARENA_MAX_TRAIL: 20_000,
	MENU_NEAR: 2, TARGET_RINGS: 6,
};

test("the rule table at scale 1 is the literals it replaced, and its constants are the table at the world's scale", () => {
	assert.deepEqual(Object.keys(RULE_TABLE).sort(), Object.keys(LEGACY).sort());
	assert.equal(gridScale(), 1, "scale 1 until a world sets another");
	for (const s of [2, 1]) {
		useGridScale(s);
		assert.equal(gridScale(), s);
		for (const name of Object.keys(RULE_TABLE) as RuleName[]) {
			assert.equal(ruleAt(name, 1), LEGACY[name], name);
			assert.equal((rules as unknown as Record<string, number>)[name], ruleAt(name, s), `${name} is exported at scale ${s}`);
			assert.ok(RULE_TABLE[name].places.length > 0, `${name} names its places`);
		}
	}
	// the bindings an importer holds are live: a named import reads the current value
	useGridScale(2);
	assert.deepEqual([BESIDE, COMMAND_PATH], [2, 80]);
	useGridScale(1);
	assert.deepEqual([BESIDE, COMMAND_PATH], [1, 40]);
	assert.throws(() => useGridScale(3), /gridScale 3/);
	assert.equal(gridScale(), 1, "a refused scale changes nothing");
});

test("a length doubles at scale 2, an area quadruples; the ring and the flower's neighbour keep scale 1's answers", () => {
	for (const name of Object.keys(RULE_TABLE) as RuleName[]) {
		const r: RuleRow = RULE_TABLE[name];
		assert.equal(ruleAt(name, 2), r.value * (r.kind === "area" ? 4 : 2), name);
	}
	for (const d of [0, 1, 2, 3]) {
		assert.equal(rules.onRing(d), d === 1, `ring at ${d}`);
		assert.equal(rules.flowerNeighbour(d), d === 1, `flower at ${d}`);
	}
});

test("the Rust engine's rules.rs has the same rows, values and kinds", () => {
	const text = readFileSync(join(import.meta.dirname, "../rust/mmo-engine/src/rules.rs"), "utf8");
	// one function per row, `pub fn beside() -> f64 { length(1.0) }`: the TypeScript name in snake case
	const rust = new Map([...text.matchAll(/^pub fn (\w+)\(\) -> f64 \{ (length|area)\(([\d_.]+)\) \}$/gm)].map((m) => [m[1]!.toUpperCase(), { kind: m[2]!, value: Number(m[3]!.replaceAll("_", "")) }]));
	assert.deepEqual([...rust.keys()].sort(), Object.keys(RULE_TABLE).sort());
	for (const [name, row] of Object.entries(RULE_TABLE)) assert.deepEqual(rust.get(name), { kind: row.kind, value: row.value }, name);
});
