import { test } from "node:test";
import assert from "node:assert/strict";
import { Meter, formatStatus, formatWidget } from "../src/meter.ts";
import * as c from "../src/core.ts";

test("rate is events per second over the completed seconds of the window; old seconds fall out", () => {
	let t = 1_000_000; const m = new Meter(() => t);
	for (let i = 0; i < 12; i++) { // 4 events in each of 12 seconds
		m.inc("writes", 4);
		if (i >= 9) { assert.equal(m.rate("writes", 10), 4); assert.equal(m.rate("writes", 5), 4); } // window full of traffic
		t += 1000;
	}
	assert.equal(m.total("writes"), 48);
	t += 4000; // traffic ended 5 s ago: of the 10 completed window seconds, 6 hold 4 events
	assert.equal(m.rate("writes", 10), 2.4);
	t += 20_000;
	assert.equal(m.rate("writes", 10), 0);
	assert.equal(m.total("writes"), 48); // totals never decay
});
test("steady traffic reads the same at any point within a second, also for a 1 s window", () => {
	for (const at of [0, 50, 500, 950]) {
		let t = 1_000_000_000; const m = new Meter(() => t);
		while (t <= 1_000_030_000 + at) { m.inc("writes"); t += 100; } // 10/s, evenly spread, still running
		t = 1_000_030_000 + at; // `at` ms into the running second, which holds only part of its events
		assert.equal(m.rate("writes", 10), 10, `10 s window at +${at}ms`);
		assert.equal(m.rate("writes", 1), 10, `1 s window at +${at}ms`);
	}
});
test("a fresh meter does not under-report", () => {
	let t = 5500; const m = new Meter(() => t); // started half-way through a second
	m.inc("reads", 10); t = 7200; // completed seconds since the start: 5.5..6 and 6..7, i.e. 1.5 s
	assert.equal(m.rate("reads", 10), 10 / 1.5);
	t = 5900; assert.equal(m.rate("reads", 10), 0); // no completed second yet
});
test("bad windows fall back to the default instead of NaN", () => {
	let t = 0; const m = new Meter(() => t);
	m.inc("reads", 10); t = 10_000;
	assert.equal(m.rate("reads", NaN), 1); assert.equal(m.rate("reads", Infinity), 1);
});
test("ring slots are reused after SLOTS seconds without leaking old counts", () => {
	let t = 0; const m = new Meter(() => t);
	m.inc("takes", 100); t += 300_000; m.inc("takes", 1); // same slot index, 300 s later
	t += 1000;
	assert.equal(m.rate("takes", 10), 0.1);
});
test("formatStatus and formatWidget", () => {
	let t = 0; const m = new Meter(() => t);
	t = 10_000; // the meter is older than the window, so no start-up correction applies
	for (let i = 0; i < 5; i++) { m.inc("writes", 4); m.inc("reads", 9); t += 1000; }
	const s = c.initialState();
	c.write(s, 0, { type: "Job", fields: {} }, null, c.FOREVER);
	const live = { gauges: c.stats(s, 1), meter: m.snapshot(5) };
	assert.equal(formatStatus(live), "space 1 entries · w4.0/s r9.0/s t0.0/s");
	assert.match(formatWidget(live).join("\n"), /1 entries \(Job 1\)[\s\S]*0 returned[\s\S]*write 4\.0\/s {2}read 9\.0\/s/);
});
