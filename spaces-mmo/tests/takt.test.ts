// The two rates (docs/weltzeit.en.md "Two rates"): the life of the world can run fast while what waits for people does not.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER } from "phi-spaces";
import { byPeoplesPace, decayNowOf, patienceOf, syncRates, worldNowOf } from "../server/engine/clock.ts";
import { advance } from "../server/engine/commands/garden.ts";
import { buildSweep } from "../server/engine/commands/build.ts";
import { saveSettings } from "../server/settings.ts";
import { loadWorld } from "../server/engine/world.ts";
import { decayNow, initialClock, patience, paused, resumed, withDecayRate, withRate, worldNow, WORLD_DAY_MS } from "../server/engine/worldtime.ts";
import type { BedFields, BuildingFields, WorldClockFields } from "../server/model.ts";
import { startStack } from "./stack.ts";

const w = await loadWorld();
const HOUR = 3600_000;

test("one clock until the two are told apart; then a new life rate leaves the second time alone, and a pause stops both", () => {
	const old: WorldClockFields = { worldId: "x", epoch: 1, realAnchorMs: 0, worldAnchorMs: 1000, rate: 1, paused: false, version: 1 }; // as stored before
	assert.equal(decayNow(old, 5000), worldNow(old, 5000), "what a world stored stays valid");
	assert.equal(patience(old), 1);
	const fast = withRate(old, 24, HOUR);
	assert.equal(decayNow(fast, HOUR), worldNow(fast, HOUR), "no jump at the change");
	assert.equal(worldNow(fast, 2 * HOUR) - worldNow(fast, HOUR), 24 * HOUR);
	assert.equal(decayNow(fast, 2 * HOUR) - decayNow(fast, HOUR), HOUR, "the second clock stayed real");
	assert.equal(patience(fast), 24);
	const held = paused(fast, 2 * HOUR), back = resumed(held, 3 * HOUR);
	assert.equal(decayNow(held, 3 * HOUR), decayNow(fast, 2 * HOUR));
	assert.equal(decayNow(back, 4 * HOUR) - decayNow(back, 3 * HOUR), HOUR);
	const slow = withDecayRate(fast, 2, 5 * HOUR);
	assert.equal(decayNow(slow, 6 * HOUR) - decayNow(slow, 5 * HOUR), 2 * HOUR);
	assert.equal(patience(slow), 12);
	assert.throws(() => withDecayRate(fast, 0, 0), RangeError);
	assert.equal(patience(initialClock("x", 8, 0, 0.5)), 1, "a new world starts with both alike");
});

test("the tide serves people: at 24 it comes about once in 24 of its dates, at 1 always", { timeout: 120_000 }, async () => {
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space;
		await s.write({ type: "WorldClock", fields: initialClock(w.id, 12, Date.now(), 1) as never }, null, FOREVER);
		assert.ok(await byPeoplesPace(s));
		const e = (await s.readAll({ type: "WorldClock" }))[0]!;
		await s.takeIfExists({ id: e.id }, 0);
		await s.write({ type: "WorldClock", fields: withRate(e.fields as unknown as WorldClockFields, 24, Date.now()) as never }, null, FOREVER);
		const random = Math.random;
		try {
			Math.random = () => 0.03; assert.ok(await byPeoplesPace(s));
			Math.random = () => 0.5; assert.ok(!(await byPeoplesPace(s)));
		} finally { Math.random = random; }
	} finally { await stack.close(); }
});

test("at 24 a plant ripens within the hour but waits a whole day dry; the keeping of the settings is real", () => {
	const g = w.garden!, sort = g.sorts[0]!;
	const bed = { plants: [{ x: 0, y: 0, sort: sort.key, stage: 0, dueWorldMs: 0 }], wateredWorldMs: 0, weedy: false, dueWorldMs: 0 } as unknown as BedFields;
	advance(g, bed, HOUR, 0, () => 1, 24);
	assert.equal(bed.plants[0]!.stage, 1);
	bed.plants[0]!.dueWorldMs = 0;
	advance(g, bed, g.thirstWorldMs * 23, 0, () => 1, 24);
	assert.equal(bed.plants[0]!.stage, 2, "23 of its 24 thirsts have passed in world time: still not dry");
	assert.equal(bed.dueWorldMs, g.thirstWorldMs * 23 + sort.ripeWorldMs * 24, "it stays ripe as long as ever in real time");
	bed.plants[0]!.dueWorldMs = 0;
	const dry = { plants: [{ x: 0, y: 0, sort: sort.key, stage: 0, dueWorldMs: 0 }], wateredWorldMs: 0, weedy: false, dueWorldMs: 0 } as unknown as BedFields;
	advance(g, dry, g.thirstWorldMs * 25, 0, () => 1, 24);
	assert.equal(dry.plants[0]!.stage, 3);
});

test("the admin's rates reach the clock; a building stands by the second clock whatever the life rate does", { timeout: 120_000 }, async () => {
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space;
		await s.write({ type: "WorldClock", fields: initialClock(w.id, 12, Date.now(), 1) as never }, null, FOREVER);
		await syncRates(s);
		assert.equal(await patienceOf(s), 1, "-1: nothing changes");
		const kept = await decayNowOf(s);
		const hut: BuildingFields = { buildId: "h", plan: "huette", name: "Hütte", room: "graue-bucht", x: 1, y: 1, w: 1, h: 1, owner: "o", ownerName: "O", accountId: "a", beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: kept + WORLD_DAY_MS, builtAt: 0 };
		await s.write({ type: "Building", fields: hut as never }, null, FOREVER);
		await saveSettings(s, { "clock.life": 100_000, "clock.decay": 1 });
		await new Promise((r) => setTimeout(r, Number(process.env.SPACES_MMO_SETTINGS_MS) || 5_100));
		await syncRates(s);
		await syncRates(s); // and once more changes nothing
		assert.equal(await s.count({ type: "WorldClock" }), 1);
		assert.equal(await patienceOf(s), 100_000);
		const from = await worldNowOf(s);
		await new Promise((r) => setTimeout(r, 2_000));
		assert.ok((await worldNowOf(s)) - from > WORLD_DAY_MS, "more than a world day went by");
		await buildSweep(s, w);
		assert.equal(await s.count({ type: "Building", fields: { buildId: "h" } }), 1, "the hut stands: it lapses in the second clock");
		assert.ok((await decayNowOf(s)) - kept < 60_000);
	} finally { await stack.close(); }
});
