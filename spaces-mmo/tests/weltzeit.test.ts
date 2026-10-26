// The world clock (docs/weltzeit.md): the calculation, the calendar, the plans in world hours, and the clock in the game
// (created with the world, shown to the browser, changed by the operator without a jump).
import { test } from "node:test";
import assert from "node:assert/strict";
import { calendar, CLOCK_VERSION, formatWorldTime, initialClock, MAX_RATE, MIN_RATE, paused, presentAt, resumed, shownWorldMs, viewOf, withRate, WORLD_DAY_MS, WORLD_HOUR_MS, worldNow } from "../server/engine/worldtime.ts";
import type { WorldClockFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, Player, startServer, startStack } from "./stack.ts";

const clock = (over: Partial<WorldClockFields> = {}): WorldClockFields => ({ worldId: "w", epoch: 1, realAnchorMs: 1_000_000, worldAnchorMs: 8 * WORLD_HOUR_MS, rate: 60, paused: false, version: CLOCK_VERSION, ...over });

test("the same clock and the same real time give the same world time, to the byte", () => {
	const c = clock();
	assert.equal(worldNow(c, 1_000_000), 8 * WORLD_HOUR_MS);
	assert.equal(worldNow(c, 1_000_000 + 1_000), 8 * WORLD_HOUR_MS + 60_000, "a real second at rate 60 is a world minute");
	assert.equal(JSON.stringify(calendar(worldNow(c, 5_000_000))), JSON.stringify(calendar(worldNow({ ...c }, 5_000_000))));
});

test("a restart is nothing but reading the clock: the time that passed meanwhile is in worldNow", () => {
	const stored = JSON.parse(JSON.stringify(clock({ rate: 1 })));
	assert.equal(worldNow(stored, 1_000_000 + 3 * WORLD_HOUR_MS), 11 * WORLD_HOUR_MS, "three hours of outage at rate 1");
});

test("pause holds the world time; resume goes on from there; neither jumps", () => {
	const c = clock();
	const p = paused(c, 1_000_000 + 10_000); // ten real seconds in: 10 world minutes
	assert.equal(p.paused, true);
	assert.equal(worldNow(p, 1_000_000 + 10_000), 8 * WORLD_HOUR_MS + 600_000);
	assert.equal(worldNow(p, 1_000_000 + 99_999_999), 8 * WORLD_HOUR_MS + 600_000, "stays while paused");
	const r = resumed(p, 5_000_000);
	assert.equal(worldNow(r, 5_000_000), 8 * WORLD_HOUR_MS + 600_000, "no jump at resume");
	assert.equal(worldNow(r, 5_001_000), 8 * WORLD_HOUR_MS + 660_000);
});

test("a rate change does not jump, and a bad rate is refused (a pause is `paused`, never rate 0)", () => {
	const c = clock();
	const faster = withRate(c, 600, 1_000_000 + 5_000);
	assert.equal(worldNow(faster, 1_000_000 + 5_000), worldNow(c, 1_000_000 + 5_000), "the same moment, the same time");
	assert.equal(worldNow(faster, 1_000_000 + 6_000) - worldNow(faster, 1_000_000 + 5_000), 600_000, "then ten world minutes per real second");
	for (const bad of [0, -1, NaN, Infinity, MIN_RATE / 2, MAX_RATE * 2]) assert.throws(() => withRate(c, bad, 1_000_000), RangeError, String(bad));
});

test("a new world's clock follows SPACES_MMO_TIME_SCALE: 0.002 lets an hour pass in 7.2 real seconds", () => {
	const c = initialClock("w", 8, 5_000, 0.002);
	assert.equal(c.rate, 500);
	assert.equal(worldNow(c, 5_000 + 7_200), 9 * WORLD_HOUR_MS);
	assert.equal(initialClock("w", 8, 0, 1).rate, 1);
	assert.equal(initialClock("w", 8, 0, 1).worldAnchorMs, 8 * WORLD_HOUR_MS);
});

test("the calendar has days of 24 hours from day 0, and no time zone", () => {
	assert.deepEqual(calendar(0), { day: 0, hour: 0, minute: 0, millisOfDay: 0 });
	assert.deepEqual(calendar(WORLD_DAY_MS - 1), { day: 0, hour: 23, minute: 59, millisOfDay: WORLD_DAY_MS - 1 });
	assert.deepEqual(calendar(WORLD_DAY_MS), { day: 1, hour: 0, minute: 0, millisOfDay: 0 });
	assert.deepEqual(calendar(183 * WORLD_DAY_MS + 6 * WORLD_HOUR_MS + 30 * 60_000), { day: 183, hour: 6, minute: 30, millisOfDay: 6.5 * WORLD_HOUR_MS });
	assert.equal(formatWorldTime(3 * WORLD_DAY_MS + 8 * WORLD_HOUR_MS + 12 * 60_000), "Tag 4, 08:12");
});

test("a plan 6–22 and a plan 20–2 hold at all four edges", () => {
	const at = (h: number) => 5 * WORLD_DAY_MS + h * WORLD_HOUR_MS;
	const day = { presentFromHour: 6, presentUntilHour: 22 }, night = { presentFromHour: 20, presentUntilHour: 2 };
	assert.deepEqual([5.99, 6, 21.99, 22].map((h) => presentAt(day, at(h))), [false, true, true, false]);
	assert.deepEqual([19.99, 20, 1.99, 2].map((h) => presentAt(night, at(h))), [false, true, true, false]);
	assert.equal(presentAt(night, at(0)), true, "over midnight");
	assert.equal(presentAt(night, at(12)), false);
	assert.equal(presentAt({ presentFromHour: 0, presentUntilHour: 0 }, at(13)), true, "from = until: all day");
});

test("the browser interpolates between two frames, and a paused world stands still for it", () => {
	const v = viewOf(clock({ rate: 60 }), 1_000_000 + 10_000);
	assert.equal(v.worldMs, 8 * WORLD_HOUR_MS + 600_000);
	assert.equal(shownWorldMs(v, 50_000, 52_000), v.worldMs + 120_000, "two seconds later at rate 60");
	assert.equal(shownWorldMs(v, 50_000, 40_000), v.worldMs, "its own clock never runs backwards on the display");
	assert.equal(shownWorldMs({ ...v, paused: true }, 50_000, 90_000), v.worldMs);
});

test("the game: the clock is made with the world, shown in the hello and by `time`; only an admin changes it, without a jump", async () => {
	const stack = await startStack({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.002" } });
	const srv = await startServer({ stack, accountOptions: { setupToken: "t" } });
	try {
		assert.equal(await stack.space.count({ type: "WorldClock" }), 1, "one clock for the world");
		const entry = (await stack.space.readAll({ type: "WorldClock" }))[0]!.fields as unknown as WorldClockFields;
		assert.equal(entry.rate, 500);
		const admin = new Player(srv.url);
		assert.equal((await admin.post("/api/register", { name: "Uhrmacher", password: "geheim-123", setupToken: "t" })).status, 200);
		const hello = await admin.play();
		assert.ok(hello.worldTime && hello.worldTime.rate === 500 && !hello.worldTime.paused, "the hello carries the clock");
		const bert = new Player(srv.url);
		assert.equal((await bert.post("/api/register", { name: "Bert", password: "geheim-123" })).status, 200);
		await bert.play();
		const says = async (p: Player, line: string, text: RegExp) => { const from = p.frames.length; p.send(line); return ((await p.until((f: ServerFrame) => f.t === "msg" && text.test(f.m.text), 10_000, from)) as Extract<ServerFrame, { t: "msg" }>).m.text; };
		assert.match(await says(bert, "time", /^Es ist Tag \d+, \d\d:\d\d Uhr/), /Uhr/);
		assert.match(await says(bert, "clock pause", /Unbekannter Befehl/), /clock/, "players do not have the operator's command");
		assert.match(await says(admin, "clock", /Tag \d+, \d\d:\d\d Uhr.*beschleunigt/), /500/);
		const before = Date.now();
		assert.match(await says(admin, "clock pause", /angehalten/), /angehalten/);
		await admin.until((f) => f.t === "time" && f.time.paused);
		const stopped = (await stack.space.readAll({ type: "WorldClock" }))[0]!.fields as unknown as WorldClockFields;
		assert.equal(stopped.paused, true);
		assert.ok(Math.abs(stopped.worldAnchorMs - worldNow(entry, before)) < 60_000 * 500 * 0.01 + 5_000 * 500, "paused where the world time was, no jump");
		assert.match(await says(admin, "clock pause", /schon still/), /still/);
		assert.match(await says(admin, "clock rate 1", /angehalten/), /angehalten/); // while paused a rate may be set too
		assert.match(await says(admin, "clock rate 0", /So geht es: clock rate/), /rate/);
		assert.match(await says(admin, "clock weiter", /läuft/), /läuft/);
		await admin.until((f) => f.t === "time" && !f.time.paused);
		await admin.leave(); await bert.leave();
	} finally { await srv.close(); await stack.close(); }
});

// ---- step 3: the dates of the world (engine/schedule.ts), the evening, and the NPC plans ----
import { runSchedules, ClockGuard, ensureSchedule } from "../server/engine/schedule.ts";
import { SCHEDULE_HANDLERS } from "../server/engine/worldevents.ts";
import { msUntilWorld, nextAtHour } from "../server/engine/worldtime.ts";

import type { WorldEventFields, WorldScheduleFields } from "../server/model.ts";
import { FOREVER } from "phi-spaces";

test("the next date at an hour of the day is strictly after the moment, and a wait is real time at the clock's rate", () => {
	const day = (d: number, h: number) => d * WORLD_DAY_MS + h * WORLD_HOUR_MS;
	assert.equal(nextAtHour(day(3, 8), 20), day(3, 20));
	assert.equal(nextAtHour(day(3, 20), 20), day(4, 20), "at the hour itself: the next day");
	assert.equal(nextAtHour(day(3, 23.99), 20), day(4, 20));
	assert.equal(nextAtHour(day(3, 0), 0), day(4, 0));
	const c = clock({ rate: 60, realAnchorMs: 0, worldAnchorMs: 0 });
	assert.equal(msUntilWorld(c, 600_000, 0), 10_000, "ten world minutes at rate 60: ten real seconds");
	assert.equal(msUntilWorld(c, 600_000, 20_000), 0, "already due");
	assert.equal(msUntilWorld({ ...c, paused: true }, 600_000, 0), Infinity, "a paused clock never gets there");
});

test("a host clock that jumps back or far ahead stops new events for a while and says so; events served stay served", () => {
	const g = new ClockGuard({ toleranceMs: 60_000, holdMs: 5_000 });
	const err = console.error; const said: string[] = []; console.error = (...a: unknown[]) => { said.push(a.join(" ")); };
	try {
		assert.equal(g.ok(1_000_000), true);
		assert.equal(g.ok(1_001_000), true, "a normal second");
		assert.equal(g.ok(900_000), false, "back by 100 s: stop");
		assert.equal(g.ok(902_000), false, "still held");
		assert.equal(g.ok(906_000), true, "trusted again from the new reading");
		assert.equal(g.ok(1_000_000), false, "ahead by 94 s (tolerance 60 s): stop");
		assert.equal(g.alarms.length, 2);
		assert.ok(said.every((l) => /clock alarm/.test(l)) && said.length === 2, "an alarm each time");
	} finally { console.error = err; }
});

test("a late date: `once` goes on from the date it missed, `coalesce` makes one event and goes on from now; a paused clock serves nothing", async () => {
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space, day = (d: number, h: number) => d * WORLD_DAY_MS + h * WORLD_HOUR_MS;
		const real0 = 1_000_000_000_000;
		// the world is at day 5, 10:00 (the clock was made at real0, 8:00 of day 0, rate 1: 5 days + 2 hours later)
		const at = real0 + 5 * WORLD_DAY_MS + 2 * WORLD_HOUR_MS;
		await s.write({ type: "WorldClock", fields: { worldId: "t", epoch: 1, realAnchorMs: real0, worldAnchorMs: day(0, 8), rate: 1, paused: false, version: 1 } as never }, null, FOREVER);
		const sched = (scheduleId: string, missed: WorldScheduleFields["missed"]) => ({ scheduleId, clockEpoch: 1, dueWorldMs: day(3, 20), kind: "evening", payload: { hour: 20 }, missed });
		const events = async () => (await s.readAll({ type: "WorldEvent" })).map((e) => (e.fields as unknown as WorldEventFields).eventId).sort();
		const due = async (id: string) => ((await s.readIfExists({ type: "WorldSchedule", fields: { scheduleId: id } }, 1_000))!.fields as unknown as WorldScheduleFields).dueWorldMs;
		const run = () => runSchedules(s, SCHEDULE_HANDLERS, { txnMs: 5_000, maxWaitMs: 1000, now: () => at });
		assert.equal(await ensureSchedule(s, null, sched("coalesce", "coalesce")), true);
		assert.equal(await ensureSchedule(s, null, sched("coalesce", "coalesce")), false, "one entry per id");
		await run();
		assert.deepEqual(await events(), ["evening:e1:d3"], "one event for the day that was due");
		assert.equal(await due("coalesce"), day(5, 20), "and the next date is the one still ahead (today's evening), not the days between");
		await run();
		assert.deepEqual(await events(), ["evening:e1:d3"], "nothing more: the next is not due yet");
		// `once`: from the missed date on, one day at a time
		await s.takeIfExists({ type: "WorldSchedule", fields: { scheduleId: "coalesce" } }, 1_000);
		await ensureSchedule(s, null, sched("once", "once"));
		await run();
		assert.equal(await due("once"), day(4, 20), "the next date after the one it missed");
		await run();
		assert.equal(await due("once"), day(5, 20));
		assert.deepEqual(await events(), ["evening:e1:d3", "evening:e1:d4"], "a deterministic key: day 3 is not made twice");
		// a paused clock: its time stands, so nothing in the future comes due
		const clockEntry = (await s.readAll({ type: "WorldClock" }))[0]!;
		await s.take({ type: "WorldClock", id: clockEntry.id }, 1_000);
		await s.write({ type: "WorldClock", fields: { worldId: "t", epoch: 1, realAnchorMs: real0, worldAnchorMs: day(5, 10), rate: 1, paused: true, version: 1 } as never }, null, FOREVER);
		await run();
		assert.equal(await due("once"), day(5, 20), "paused at 10:00 of day 5: the evening stays ahead");
		assert.equal((await events()).length, 2);
	} finally { await stack.close(); }
});

test("with two world workers the evening is made once a day; Ines goes home at 22:00 and is back at 6:00", async () => {
	// 0.0001: ten thousand world seconds per real second, a world day in 8.6 real seconds
	const stack = await startStack({ worlds: 2, worldEnv: { SPACES_MMO_TIME_SCALE: "0.0001" } });
	try {
		const s = stack.space;
		await stack.npcProcess();
		const here = async () => (await s.count({ type: "Session", fields: { charId: "npc-ines" } })) > 0;
		await eventually(here, 10_000, "Ines is there in the morning (08:00)");
		await eventually(async () => !(await here()), 20_000, "Ines goes home at 22:00");
		await eventually(here, 20_000, "Ines is back at 06:00");
		await eventually(async () => (await s.count({ type: "WorldEvent" })) >= 2, 25_000, "the evening of two days");
		const ids = (await s.readAll({ type: "WorldEvent" })).map((e) => String(e.fields.eventId));
		assert.equal(new Set(ids).size, ids.length, `one event per day and epoch, two workers: ${ids.join(", ")}`);
		assert.ok(ids.every((id) => /^evening:e1:d\d+$/.test(id)));
		assert.equal(await s.count({ type: "WorldSchedule" }) <= 1, true, "one date for the evening");
	} finally { await stack.close(); }
});
