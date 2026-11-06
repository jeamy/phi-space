// Two fingers on the map (client/pinch.ts): up or down together tilt, anything else zooms and turns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pinch } from "../client/pinch.ts";

test("two fingers moving up together are a tilt; spreading them is a pinch; the first px decide nothing", () => {
	const p = pinch();
	p.down(1, 100, 300); assert.equal(p.down(2, 200, 300), true);
	p.move(1, 100, 295); p.move(2, 200, 295);
	assert.equal(p.gesture, null, "5 px: not clear yet");
	p.move(1, 101, 270); p.move(2, 199, 270);
	assert.equal(p.gesture, "tilt");
	assert.equal(p.lift, -30, "the point between them went 30 px up");
	p.rebase(); assert.equal(p.lift, 0);
	p.up(2); assert.equal(p.gesture, null);

	const q = pinch();
	q.down(1, 100, 300); q.down(2, 200, 300);
	q.move(1, 80, 300); q.move(2, 220, 300);
	assert.equal(q.gesture, "pinch", "spreading sideways zooms");

	const r = pinch();
	r.down(1, 100, 300); r.down(2, 200, 300);
	r.move(1, 100, 280); r.move(2, 200, 320);
	assert.equal(r.gesture, "pinch", "one up, one down turns");
});
