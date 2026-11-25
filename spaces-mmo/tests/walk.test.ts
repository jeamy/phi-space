// The own character's walk on the page (client/walk.ts): ahead of the server, matched by step numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseTarget, MAX_AHEAD, nextStep, RESYNC_MS, screenToGrid, Walker } from "../client/walk.ts";

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

/** The target choice as App.tsx walkTo made it before chooseTarget: a search per candidate (kept to hold the new one). */
function legacyTarget(free: (x: number, y: number) => boolean, start: { x: number; y: number }, goal: { x: number; y: number }) {
	const cells: Array<{ x: number; y: number }> = [goal];
	for (let r = 1; r <= 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r) cells.push({ x: goal.x + dx, y: goal.y + dy });
	const here = (c: { x: number; y: number }) => c.x === start.x && c.y === start.y;
	return (free(goal.x, goal.y) ? goal : cells.find((c) => (free(c.x, c.y) || here(c)) && (here(c) || nextStep(free, start, c)))) ?? null;
}

test("a tap's target in one search: the same cell as a search per candidate, and at most the room plus the candidates looked at", () => {
	let seed = 7;
	const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
	for (let i = 0; i < 400; i++) {
		const w = 4 + Math.floor(rnd() * 33), h = 4 + Math.floor(rnd() * 21), density = rnd() * 0.6;
		const open = Array.from({ length: h }, () => Array.from({ length: w }, () => rnd() >= density));
		// now and then a wall of water across the room: the far side cannot be reached
		if (rnd() < 0.3) { const x = Math.floor(rnd() * w); for (let y = 0; y < h; y++) open[y]![x] = false; }
		let looks = 0;
		const free = (x: number, y: number) => { looks++; return !!open[y]?.[x]; };
		const start = { x: Math.floor(rnd() * w), y: Math.floor(rnd() * h) }, goal = { x: Math.floor(rnd() * w), y: Math.floor(rnd() * h) };
		const before = legacyTarget(free, start, goal);
		looks = 0;
		const after = chooseTarget(free, start, goal, w, h, 6);
		assert.deepEqual(after, before, `room ${w}x${h} #${i}, start ${start.x},${start.y}, goal ${goal.x},${goal.y}`);
		assert.ok(looks <= w * h + 169, `room ${w}x${h} #${i}: ${looks} cells looked at`);
	}
});

test("the occupied goal beyond the water: one search instead of one per candidate", () => {
	const w = 36, h = 24, mid = { x: 21, y: 12 };
	const free = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && x !== 5 && !(Math.abs(x - mid.x) <= 1 && Math.abs(y - mid.y) <= 1);
	let looks = 0;
	const counted = (x: number, y: number) => { looks++; return free(x, y); };
	assert.equal(chooseTarget(counted, { x: 1, y: 1 }, mid, w, h, 6), null);
	assert.ok(looks <= w * h + 169, `${looks} cells looked at (before: about 133,000)`);
});
