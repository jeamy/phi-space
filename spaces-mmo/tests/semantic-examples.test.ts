// The semantic examples of the distance rules (tests/semantic-examples.ts, tests/reference/semantic-scale1.json): the
// recorded answers at scale 1 stay those of the engine's helpers, and the conversion of plan section 2.2 keeps every
// answer at scale 2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { distTo } from "../server/engine/commands/build.ts";
import { reach } from "../server/engine/context.ts";
import { RULE_TABLE } from "../shared/rules.ts";
import { answer, distance, examples, FILE, ROW, RULES, targetAt, type Examples } from "./semantic-examples.ts";

const kept = JSON.parse(readFileSync(FILE, "utf8")) as Examples;

test("the recorded examples are those the rules give (node tests/semantic-examples.ts --write)", () => {
	assert.deepEqual(kept, examples());
});

test("each rule's bound at scale 1 is its row of the rule table (shared/rules.ts)", () => {
	for (const r of RULES) {
		const row = ROW[r.name], t = r.test;
		if (!row) { assert.ok(t.op === "zero" || r.places.includes("wild.") || r.places.includes("garden.greenhouse"), `${r.name} has a row or is a value of the world definition`); continue; }
		assert.equal(RULE_TABLE[row].value, t.op === "le" || t.op === "gt" ? t.value : 1, r.name);
	}
});

test("every rule has examples on both sides of its edge", () => {
	for (const r of kept.rules) {
		assert.ok(r.examples.some((e) => e.answer) && r.examples.some((e) => !e.answer), r.name);
	}
});

test("at scale 1 the distances are those of the engine's helpers (build.ts distTo, context.ts reach)", () => {
	for (const r of kept.rules) for (const e of r.examples) {
		if (r.metric === "point-rect") assert.equal(distTo(e.actor, r.target1), e.distance, `${r.name} ${JSON.stringify(e.actor)}`);
		if (r.metric === "point-point") assert.equal(reach(e.actor, r.target1), e.distance, `${r.name} ${JSON.stringify(e.actor)}`);
	}
});

test("at scale 2 every converted example keeps its answer", () => {
	const wrong: string[] = [];
	for (const r of kept.rules) {
		const target2 = targetAt(r, 2);
		for (const e of r.examples) {
			const actor2 = { x: e.actor.x * 2, y: e.actor.y * 2 }, d2 = distance(r, actor2, target2, 2);
			if (answer(r, d2, 2) !== e.answer) wrong.push(`${r.name}: actor ${e.actor.x},${e.actor.y} → ${actor2.x},${actor2.y}, distance ${e.distance} → ${d2}, ${e.answer} → ${!e.answer}`);
		}
	}
	assert.deepEqual(wrong, []);
});
