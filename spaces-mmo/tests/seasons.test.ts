// The seasons (docs/siedeln.en.md "Seasons"): four in a year whose length is a setting; winter stands still and loses nothing, a
// greenhouse grows on; festivals have their season; a new one is told once.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER } from "phi-spaces";
import { frozenUntil, seasonNow, seasonTick } from "../server/engine/clock.ts";
import { advance, gardenTick } from "../server/engine/commands/garden.ts";
import { saveSettings } from "../server/settings.ts";
import { loadWorld } from "../server/engine/world.ts";
import { initialClock, nextSpring, seasonIndex, WORLD_DAY_MS } from "../server/engine/worldtime.ts";
import type { BedFields, WorldClockFields } from "../server/model.ts";
import { startStack } from "./stack.ts";

const w = await loadWorld();
const DAY = WORLD_DAY_MS, g = w.garden!, sort = g.sorts[0]!;
const bed = (over: Partial<BedFields> = {}) => ({ bedId: "b", room: "r", x: 1, y: 1, w: 2, h: 2, owner: "o", ownerName: "O", accountId: "a", beaconId: "feuer-bucht", points: 1, sponsors: [], plants: [{ x: 0, y: 0, sort: sort.key, stage: 1 as const, dueWorldMs: 0 }], wateredWorldMs: 0, weedy: false, dueWorldMs: 0, untilWorldMs: FOREVER, at: 0, ...over }) as BedFields;

test("a year of 28 days has four weeks of season, none at length 0, and spring comes round", () => {
	assert.deepEqual([0, 6.9, 7, 14, 21, 27.9, 28].map((d) => seasonIndex(d * DAY, 28)), [0, 0, 1, 2, 3, 3, 0]);
	assert.equal(seasonIndex(5 * DAY, 0), null);
	assert.deepEqual([0, 1, 2, 3, 4].map((d) => seasonIndex(d * DAY, 4)), [0, 1, 2, 3, 0], "a day each");
	assert.equal(nextSpring(22 * DAY, 28), 28 * DAY);
	assert.equal(nextSpring(50 * DAY, 28), 56 * DAY);
});

test("winter: a due plant waits for spring, loses nothing, and goes on watered", () => {
	const b = bed(), spring = 28 * DAY;
	assert.equal(advance(g, b, 22 * DAY, 0, () => 1, 1, spring), true);
	assert.equal(b.plants[0]!.stage, 1, "it did not grow, and did not wilt");
	assert.equal(b.dueWorldMs, spring);
	assert.equal(advance(g, b, 23 * DAY, 0, () => 1, 1, spring), false, "nothing is written again before spring");
	advance(g, b, spring, 0, () => 1);
	assert.equal(b.plants[0]!.stage, 2, "from spring on it grows, not dry");
});

test("the setting sets the year; a bed near a greenhouse grows on in winter, one far off waits; a new season is told once", { timeout: 120_000 }, async () => {
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space;
		process.env.SPACES_MMO_SETTINGS_MS = "1";
		const clock = initialClock(w.id, 12, Date.now(), 1), winter: WorldClockFields = { ...clock, worldAnchorMs: 22 * DAY };
		await s.write({ type: "WorldClock", fields: winter as never }, null, FOREVER);
		assert.equal(await seasonNow(s, 22 * DAY), null, "the tests have no year");
		await saveSettings(s, { "year.days": 28 });
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(await seasonNow(s, 22 * DAY), 3);
		assert.equal(await frozenUntil(s, 22 * DAY), 28 * DAY);
		assert.equal(await frozenUntil(s, 8 * DAY), null);
		await s.write({ type: "Bed", fields: bed({ bedId: "near", wateredWorldMs: 22 * DAY }) as never }, null, FOREVER);
		await s.write({ type: "Bed", fields: bed({ bedId: "far", x: 12, wateredWorldMs: 22 * DAY }) as never }, null, FOREVER);
		await s.write({ type: "Building", fields: { buildId: "glas", plan: "gewaechshaus", room: "r", x: 4, y: 1, w: 2, h: 2 } as never }, null, FOREVER);
		await gardenTick(s, w);
		const stage = async (id: string) => ((await s.readAll({ type: "Bed", fields: { bedId: id } }))[0]!.fields as unknown as BedFields).plants[0]!.stage;
		assert.equal(await stage("near"), 2);
		assert.equal(await stage("far"), 1);
		const rooms = { rooms: [{ roomId: "r" }] };
		assert.equal(await seasonTick(s, rooms, 60_000), false, "the first count only notes it");
		assert.equal(await seasonTick(s, rooms, 60_000), false);
		await s.take({ type: "Season" }, 0);
		await s.write({ type: "Season", fields: { season: 2 } as never }, null, FOREVER);
		assert.equal(await seasonTick(s, rooms, 60_000), true);
		assert.ok((await s.readAll({ type: "Msg", fields: { room: "r" } })).some((e) => /Der Winter kommt/.test(String(e.fields.text))));
	} finally { delete process.env.SPACES_MMO_SETTINGS_MS; await stack.close(); }
});
