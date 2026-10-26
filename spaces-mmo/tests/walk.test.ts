// The own character's walk on the page (client/walk.ts): ahead of the server, matched by step numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_AHEAD, RESYNC_MS, screenToGrid, Walker } from "../client/walk.ts";

const walker = (x = 5, y = 5) => { const w = new Walker(); w.reset({ x, y }); return w; };

test("the figure walks ahead at once; answers that come late never pull it back", () => {
	const w = walker();
	const a = w.step(1, 0, 0)!, b = w.step(1, 0, 150)!, c = w.step(1, 0, 300)!;
	assert.deepEqual(w.shown, { x: 8, y: 5 }, "three cells ahead before any answer");
	assert.deepEqual(w.report({ x: 6, y: 5 }, a.seq, 400), { x: 8, y: 5 }, "the first answer: still drawn three ahead");
	assert.deepEqual(w.report({ x: 7, y: 5 }, b.seq, 500), { x: 8, y: 5 });
	assert.deepEqual(w.report({ x: 8, y: 5 }, c.seq, 600), { x: 8, y: 5 });
	assert.equal(w.ahead, 0);
});

test("a place without a newer answer (arriving, a session, an older frame) is ignored while steps are on their way", () => {
	const w = walker();
	const a = w.step(0, 1, 0)!;
	w.step(0, 1, 150);
	assert.equal(w.report({ x: 5, y: 5 }, undefined, 200), null, "the old place again: the figure stays ahead");
	w.report({ x: 5, y: 6 }, a.seq, 300);
	assert.equal(w.report({ x: 5, y: 5 }, a.seq - 1, 350), null, "an answer to an older step changes nothing");
	assert.deepEqual(w.shown, { x: 5, y: 7 });
});

test("a step the server could not take: the figure goes on from where it really is", () => {
	const w = walker();
	const a = w.step(1, 0, 0)!;
	w.step(1, 0, 150);
	// someone stood on 6,5: the server answers the first step without moving
	assert.deepEqual(w.report({ x: 5, y: 5 }, a.seq, 200), { x: 6, y: 5 }, "the second step from 5,5");
});

test("letting go stops the figure; with nothing on its way any place from the server counts", () => {
	const w = walker();
	const a = w.step(-1, 0, 0)!;
	w.report({ x: 4, y: 5 }, a.seq, 100);
	assert.deepEqual(w.report({ x: 9, y: 9 }, undefined, 200), { x: 9, y: 9 }, "moved by the world (a walk, arriving)");
});

test("at most MAX_AHEAD steps ahead; without any answer for RESYNC_MS the server's place is taken again", () => {
	const w = walker();
	for (let i = 0; i < MAX_AHEAD; i++) assert.ok(w.step(1, 0, i * 150));
	assert.equal(w.step(1, 0, 2000), null, "too far ahead of the answers");
	assert.equal(w.tick(RESYNC_MS - 1), null, "still waiting");
	assert.deepEqual(w.tick(RESYNC_MS + 1), { x: 5, y: 5 }, "given up: back to the server's place");
	assert.equal(w.ahead, 0);
	assert.ok(w.step(1, 0, RESYNC_MS + 2), "and it walks again");
});

test("a new room drops what is on its way, and an answer to an old step cannot match a new one", () => {
	const w = walker();
	const a = w.step(1, 0, 0)!;
	w.reset({ x: 1, y: 8 });
	const b = w.step(0, 1, 100)!;
	assert.ok(b.seq > a.seq, "the numbers go on");
	assert.equal(w.report({ x: 6, y: 5 }, a.seq, 150), null, "the old answer does not count for the new step");
	assert.deepEqual(w.shown, { x: 1, y: 9 });
});

test("in the 3D view the arrows follow the view: turned half around, up walks down the grid", () => {
	const up: [number, number] = [0, -1], right: [number, number] = [1, 0], down: [number, number] = [0, 1], left: [number, number] = [-1, 0];
	const start = Math.PI / 4; // the view a page starts with
	assert.deepEqual([up, right, down, left].map((d) => screenToGrid(d, start)), [up, right, down, left], "the start view: as on the screen");
	const half = start + Math.PI;
	assert.deepEqual([up, right, down, left].map((d) => screenToGrid(d, half)), [down, left, up, right], "half around: everything the other way");
	const quarter = Math.PI / 2 + Math.PI / 2; // turned a quarter
	const q = [up, right, down, left].map((d) => screenToGrid(d, quarter));
	assert.equal(new Set(q.map(String)).size, 4, "a quarter turn: four different steps");
	assert.ok(q.every(([x, y]) => Math.abs(x) + Math.abs(y) === 1), "each one cell along the grid");
	assert.deepEqual(screenToGrid(up, start + 2 * Math.PI), up, "a full turn is no turn");
});
