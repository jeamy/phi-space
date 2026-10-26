// The pace of the own character's steps (client/stepping.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPIRE_MS, MAX_IN_FLIGHT, StepPacer, STEP_MS } from "../client/stepping.ts";

test("a step may follow after STEP_MS, with at most MAX_IN_FLIGHT unanswered", () => {
	const p = new StepPacer();
	assert.equal(p.canSend(1000), true);
	p.sent(1000, { x: 1, y: 0 });
	assert.equal(p.canSend(1000 + STEP_MS - 1), false, "too soon");
	assert.equal(p.canSend(1000 + STEP_MS), true);
	p.sent(1000 + STEP_MS, { x: 2, y: 0 });
	assert.equal(MAX_IN_FLIGHT, 2);
	assert.equal(p.canSend(1000 + 2 * STEP_MS), false, "two steps are still on their way");
	p.answer({ x: 1, y: 0 });
	assert.equal(p.canSend(1000 + 2 * STEP_MS), true, "an answer frees one place");
});

test("an answer that confirms an earlier step does not pull the figure back while later steps are on their way", () => {
	const p = new StepPacer();
	p.sent(0, { x: 1, y: 0 }); p.sent(STEP_MS, { x: 2, y: 0 });
	assert.equal(p.answer({ x: 1, y: 0 }), "ahead");
	assert.equal(p.answer({ x: 2, y: 0 }), "apply", "the last prediction is confirmed: nothing is ahead any more");
});

test("an answer from elsewhere drops the predictions: the server decides", () => {
	const p = new StepPacer();
	p.sent(0, { x: 1, y: 0 }); p.sent(STEP_MS, { x: 2, y: 0 });
	assert.equal(p.answer({ x: 5, y: 5 }), "apply");
	assert.equal(p.answer({ x: 2, y: 0 }), "apply", "and the old predictions are gone");
});

test("steps the server never answered (refused) make the figure go back", () => {
	const p = new StepPacer();
	p.sent(0, { x: 1, y: 0 });
	assert.equal(p.settle(EXPIRE_MS - 1), false, "still waiting");
	assert.equal(p.settle(EXPIRE_MS + 1), true, "no answer came: back to where the server put it");
	assert.equal(p.settle(EXPIRE_MS + 2), false, "once");
	const q = new StepPacer(); q.sent(0, { x: 1, y: 0 }); q.answer({ x: 1, y: 0 });
	assert.equal(q.settle(EXPIRE_MS + 1), false, "an answered step needs no correction");
});
