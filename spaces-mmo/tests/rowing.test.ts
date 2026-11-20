// The row in the 3D view (client/rowing3d.ts): where a boat lies at a jetty and where it rows out to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ease, rowPath } from "../client/rowing3d.ts";

const water = (k: string) => k === "~";

test("a boat lies past the jetty's tip, in the water, and rows straight out from it", () => {
	// land on the left, a jetty of three cells reaching right into the sea
	const ground = ["..~~~~~~", "..~~~~~~", "..~~~~~~"];
	const p = rowPath(ground, water, { x: 2, y: 1, w: 3, h: 1 })!;
	assert.ok(p.moor.x > 5 && p.moor.x < 6, `${p.moor.x}`);
	assert.equal(p.moor.y, 1.5);
	assert.ok(p.out.x > p.moor.x + 4 && p.out.y === p.moor.y, "out to the open water, the jetty's way");
	// a jetty reaching down: the boat lies below it
	const down = rowPath(["....", "..~~", "~~~~", "~~~~"], water, { x: 2, y: 1, w: 1, h: 2 })!;
	assert.ok(down.moor.y > 3 && down.out.y > down.moor.y && down.out.x === down.moor.x);
	assert.equal(rowPath(["...", "...", "..."], water, { x: 1, y: 1 }), null, "no water: no row");
});

test("the boat starts and stops gently", () => {
	assert.equal(ease(0), 0); assert.equal(ease(1), 1); assert.equal(ease(0.5), 0.5);
	assert.ok(ease(0.1) < 0.1 && ease(0.9) > 0.9);
});
