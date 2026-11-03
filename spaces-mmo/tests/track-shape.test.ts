// The track's shape (client/trackShape.ts): a turn is a quarter circle whose rails meet the straight pieces on both sides
// exactly, so the rails run on in a curve and never overlap or leave a gap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { railPoints, sleeperSpots, stepsAt, type Dir } from "../client/trackShape.ts";

const near = (a: { x: number; y: number }, b: { x: number; y: number }) => assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-9, `${JSON.stringify(a)} is not ${JSON.stringify(b)}`);
const DIRS: Dir[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

test("the ends of the run go straight on, a turn is found from the cells before and after", () => {
	const run = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
	assert.deepEqual(stepsAt(run, 0), { d1: [1, 0], d2: [1, 0] });
	assert.deepEqual(stepsAt(run, 1), { d1: [1, 0], d2: [0, 1] });
	assert.deepEqual(stepsAt(run, 2), { d1: [0, 1], d2: [0, 1] });
});

test("every piece's rails start where the cell before left them and end where the cell after takes them up", () => {
	for (const d1 of DIRS) for (const d2 of DIRS) {
		if (d1[0] === -d2[0] && d1[1] === -d2[1]) continue; // no turning back
		for (const off of [0.12, -0.12]) {
			const pts = railPoints(d1, d2, off);
			// the cell before (d1 straight) ends at the edge where this one begins, shifted by one step
			const before = railPoints(d1, d1, off), after = railPoints(d2, d2, off);
			near(pts[0]!, { x: before.at(-1)!.x - d1[0], y: before.at(-1)!.y - d1[1] });
			near(pts.at(-1)!, { x: after[0]!.x + d2[0], y: after[0]!.y + d2[1] });
		}
	}
});

test("on a turn the rails keep their gauge and stay on the cell", () => {
	const inner = railPoints([1, 0], [0, 1], -0.12), outer = railPoints([1, 0], [0, 1], 0.12);
	// a right turn (east then south): the left rail is the outer one, 0.5 + 0.12 from the circle's centre (-0.5, 0.5)
	for (const [i, o] of inner.map((p, k) => [p, outer[k]!] as const)) {
		assert.ok(Math.abs(Math.hypot(i.x + 0.5, i.y - 0.5) - 0.38) < 1e-9 || Math.abs(Math.hypot(i.x + 0.5, i.y - 0.5) - 0.62) < 1e-9);
		assert.ok(Math.abs(Math.hypot(o.x + 0.5, o.y - 0.5) - 0.38) < 1e-9 || Math.abs(Math.hypot(o.x + 0.5, o.y - 0.5) - 0.62) < 1e-9);
		assert.ok(Math.abs(i.x) <= 0.5 + 1e-9 && Math.abs(i.y) <= 0.5 + 1e-9 && Math.abs(o.x) <= 0.5 + 1e-9 && Math.abs(o.y) <= 0.5 + 1e-9);
	}
	assert.equal(sleeperSpots([1, 0], [0, 1]).length, 3);
	assert.equal(sleeperSpots([1, 0], [1, 0]).length, 2);
});
