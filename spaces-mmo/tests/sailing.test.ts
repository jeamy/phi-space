// The sail in the 3D view (client/sailing3d.ts): where a boat lands on a shore without a jetty, how it gathers and loses
// way, and how it sets and lowers its sails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lookShare, SAIL_IN_MS, SAIL_LOOK_MS, SAIL_OUT_MS, sailPlan, sailShare, sailState, shorePath } from "../client/sailing3d.ts";

const water = (k: string) => k === "~";

test("at work a sail only casts off and comes in, five seconds each; at leisure each has five more for a look at the island", () => {
	assert.deepEqual([SAIL_OUT_MS, SAIL_LOOK_MS, SAIL_IN_MS], [5_000, 5_000, 5_000]);
	assert.equal(sailPlan("arbeit", "out").ms, 5_000); assert.equal(sailPlan("arbeit", "in").ms, 5_000);
	assert.equal(sailPlan("freizeit", "out").ms, 10_000); assert.equal(sailPlan("freizeit", "in").ms, 10_000);
	assert.ok(sailPlan("freizeit", "out").far > sailPlan("arbeit", "out").far, "at leisure it goes further out to sea");
});

test("at leisure the camera looks back at the island once the boat has cast off, and at the new island before it comes in; at work never", () => {
	for (const p of [0, 0.3, 0.6, 1]) { assert.equal(lookShare("arbeit", "out", p), 0); assert.equal(lookShare("arbeit", "in", p), 0); }
	assert.equal(lookShare("freizeit", "out", 0.3), 0, "casting off in the player's own view");
	assert.equal(lookShare("freizeit", "out", 0.7), 1, "then the look back");
	assert.equal(lookShare("freizeit", "out", 1), 1, "to the end of the old place");
	assert.equal(lookShare("freizeit", "in", 0), 1, "the new place begins with the look at the island");
	assert.equal(lookShare("freizeit", "in", 0.7), 0, "and comes in in the player's own view");
});

test("on a shore without a jetty the boat lands at the nearest open water before the figure and sails out from there", () => {
	// a beach with the sea below it; the figure stands on the sand two rows above the water
	const ground = ["......", "......", "......", "~~~~~~", "~~~~~~", "~~~~~~", "~~~~~~", "~~~~~~"];
	const p = shorePath(ground, water, { x: 2, y: 1 })!;
	assert.deepEqual(p.moor, { x: 2.5, y: 3.5 });
	assert.ok(p.out.y > p.moor.y + 4 && p.out.x === p.moor.x, "out to the open sea");
	// a pond is no open water: the way goes to the sea, though it is further
	const pond = ["........", "...~....", "........", "~~~~~~~~", "~~~~~~~~", "~~~~~~~~", "~~~~~~~~", "~~~~~~~~"];
	assert.deepEqual(shorePath(pond, water, { x: 1, y: 1 })!.moor, { x: 1.5, y: 3.5 });
	assert.equal(shorePath(["....", "....", "...."], water, { x: 1, y: 1 }), null, "no water: no landing");
});

test("going out the boat gathers way and is far out at sea at the end; coming in it slows and stops alongside", () => {
	assert.equal(sailShare("out", 0), 0); assert.equal(sailShare("out", 1), 1);
	assert.ok(sailShare("out", 0.5) < 0.5, "at the end of the sail out it has gone the shorter part of the way");
	assert.equal(sailShare("in", 0), 0); assert.equal(sailShare("in", 1), 1);
	assert.ok(sailShare("in", 0.5) > 0.5, "it comes in fast and slows down");
	assert.ok(sailShare("in", 0.95) - sailShare("in", 0.9) < sailShare("in", 0.1) - sailShare("in", 0.05));
});

test("the sails go up at the jetty and come down before it lies alongside; at sea it heels and pitches most", () => {
	assert.equal(sailState("out", 0).set, 0);
	assert.equal(sailState("out", 0.2).set, 1);
	assert.ok(sailState("out", 0.9).heel > sailState("out", 0.2).heel && sailState("out", 0.9).swell > sailState("out", 0.2).swell);
	assert.equal(sailState("in", 0.5).set, 1);
	assert.equal(sailState("in", 1).set, 0);
	assert.equal(sailState("in", 1).heel, 0);
	assert.equal(sailState("in", 1).wake, 0);
});
