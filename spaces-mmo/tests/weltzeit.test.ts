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

test("with two world workers the evening is made once; Ines goes home at 22:00 and is back at 6:00", async () => {
	const stack = await startStack({ worlds: 2, worldEnv: { SPACES_MMO_TIME_SCALE: "0.0001" } });
	try {
		const s = stack.space;
		// set the clock to 19:00 of day 0 at an hour per real second: the evening (20:00) comes in one second, Ines leaves at 22:00
		// (three seconds on) and is back at 06:00 (eight more); the dates of the world are in absolute world time and wait for it
		await rewriteClock(s, (c, realNow) => ({ ...c, realAnchorMs: realNow, worldAnchorMs: 19 * WORLD_HOUR_MS, rate: 3600 }));
		await stack.npcProcess();
		const here = async () => (await s.count({ type: "Session", fields: { charId: "npc-ines" } })) > 0;
		await eventually(here, 15_000, "Ines is there in the evening (19:00)");
		await eventually(async () => (await s.count({ type: "WorldEvent" })) >= 1, 15_000, "the evening of day 0");
		await eventually(async () => !(await here()), 20_000, "Ines goes home at 22:00");
		await eventually(here, 30_000, "Ines is back at 06:00");
		const ids = (await s.readAll({ type: "WorldEvent" })).map((e) => String(e.fields.eventId));
		assert.deepEqual(ids, ["evening:e1:d0"], "one event for the day, two workers");
		// a date is taken and written back many times a second: one read may catch one of them twice or not at all (the read
		// is not one snapshot), a duplicate that is real shows in every read
		const reads: string[][] = [];
		for (let i = 0; i < 6; i++) { reads.push((await s.readAll({ type: "WorldSchedule" })).map((e) => String(e.fields.scheduleId))); await new Promise((r) => setTimeout(r, 70)); }
		assert.ok(reads.some((d) => new Set(d).size === d.length), `every date exists once, with two workers: ${reads.map((d) => d.join(",")).join(" | ")}`);
	} finally { await stack.close(); }
});

// ---- step 5: fire, fog, tide and flotsam in world time ----
import { isLit } from "../server/engine/fire.ts";
import { sweepTick } from "../server/engine/sweep.ts";
import { readClock, worldNowOf } from "../server/engine/clock.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import { lightFire } from "./stack.ts";

const rewriteClock = async (space: import("phi-spaces").SpaceLike, change: (c: WorldClockFields, realNow: number) => WorldClockFields) => {
	const e = (await space.readAll({ type: "WorldClock" }))[0]!;
	await space.take({ type: "WorldClock", id: e.id }, 2_000);
	await space.write({ type: "WorldClock", fields: change(e.fields as unknown as WorldClockFields, Date.now()) as never }, null, FOREVER);
};

test("the sweep takes flotsam whose world time is up and leaves the rest; a thing picked up keeps no date", async () => {
	const stack = await startStack({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.002" } });
	const srv = await startServer({ stack });
	try {
		const s = stack.space, w = await loadWorld();
		const now = await worldNowOf(s);
		const proto = (await resolvePrototype(s, "treibholz"))!;
		const at = (itemId: string, x: number, expiresWorldMs?: number) => spawn(s, null, w, proto, { itemId, location: "graue-bucht", x, y: 3, flotsam: true, ...(expiresWorldMs !== undefined ? { expiresWorldMs } : {}) });
		await at("t-past", 1, now - 1); await at("t-soon", 2, now + 10 * WORLD_HOUR_MS); await at("t-kept", 3);
		await sweepTick(s);
		const left = (await s.readAll({ type: "Item", fields: { flotsam: true } })).map((e) => String(e.fields.itemId)).filter((id) => id.startsWith("t-")).sort();
		assert.deepEqual(left, ["t-kept", "t-soon"], "what lapsed is gone; what is still ahead and what never had a date stay");
		// picked up, the date is gone: a thing in a pack is no flotsam of the tide
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Sammler", password: "geheim-123" })).status, 200);
		const hello = await p.play();
		await s.takeIfExists({ type: "Item", fields: { itemId: "t-soon" } }, 2_000);
		const me = (await s.readIfExists({ type: "Character", fields: { charId: hello.me.charId } }, 5_000))!.fields as { x: number; y: number };
		await spawn(s, null, w, proto, { itemId: "t-mine", location: "graue-bucht", x: me.x, y: me.y, flotsam: true, expiresWorldMs: (await worldNowOf(s)) + 10 * WORLD_HOUR_MS });
		const from = p.frames.length;
		p.send("get treibholz");
		await p.until((f) => f.t === "msg" && /hebst Treibholz auf|hebt Treibholz auf|Du hebst/.test(f.m.text), 10_000, from);
		const mine = (await s.readIfExists({ type: "Item", fields: { itemId: "t-mine" } }, 5_000))!.fields as Record<string, unknown>;
		assert.equal(mine.location, hello.me.charId);
		assert.equal(mine.expiresWorldMs, undefined, "picked up: no date any more");
		await p.leave();
	} finally { await srv.close(); await stack.close(); }
});

test("a paused world keeps its fire, takes no fog step and brings no tide; resumed, it goes on", async () => {
	// 0.005: a log burns 10 world minutes = 3 real seconds, a fog step 0.6 s, the tide every 0.3 s
	const stack = await startStack({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.005" } });
	try {
		const s = stack.space;
		await lightFire(s, 4_000); // burns for four real seconds
		await eventually(async () => (await s.count({ type: "Item", fields: { flotsam: true } })) >= 1, 10_000, "the tide has brought something");
		await rewriteClock(s, (c, realNow) => paused(c, realNow));
		await new Promise((r) => setTimeout(r, 1_000)); // a tick that was already running ends
		const flotsam = () => s.count({ type: "Item", fields: { flotsam: true } });
		const fog = async () => Number((await s.readIfExists({ type: "Fog", fields: { room: "graue-bucht" } }, 1_000))?.fields.level);
		const before = { flotsam: await flotsam(), fog: await fog() };
		await new Promise((r) => setTimeout(r, 6_000)); // longer than the fire would burn, many fog steps, many tides
		const clock = await readClock(s);
		assert.equal(clock.paused, true);
		assert.deepEqual({ flotsam: await flotsam(), fog: await fog() }, before, "nothing moved in a world that stands still");
		const flame = (await s.readIfExists({ type: "Flame", fields: { beaconId: "feuer-bucht" } }, 1_000))!.fields as unknown as { until: number };
		assert.equal(isLit(flame as never, worldNow(clock)), true, "the fire still burns: its world time has not come");
		assert.equal(((await s.readIfExists({ type: "Beacon", fields: { beaconId: "feuer-bucht" } }, 1_000))!.fields as { lit: boolean }).lit, true);
		// resumed, the clock runs and the dates come due again
		await rewriteClock(s, (c, realNow) => resumed(c, realNow));
		await eventually(async () => (await flotsam()) !== before.flotsam || (await fog()) !== before.fog, 15_000, "the weather goes on");
		await eventually(async () => !isLit((await s.readIfExists({ type: "Flame", fields: { beaconId: "feuer-bucht" } }, 1_000))?.fields as never ?? null, worldNow(await readClock(s))), 15_000, "and the fire burns down");
	} finally { await stack.close(); }
});

test("the order board and the market keep their times in world time: what lapsed is swept, a listing's item goes back", async () => {
	const stack = await startStack({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.002" } });
	try {
		const s = stack.space, now = await worldNowOf(s);
		const order = (orderId: string, expiresWorldMs: number) => s.write({ type: "Order", fields: { orderId, kind: "t", text: "t", needs: [], reward: { proto: "muenze", count: 1 }, takenBy: "", room: "graue-bucht", expiresWorldMs } as never }, null, FOREVER);
		const listing = (listingId: string, expiresWorldMs: number) => s.write({ type: "Listing", fields: { listingId, seller: "c-x", sellerName: "x", itemId: `i-${listingId}`, itemName: "Muschel", price: 1, room: "graue-bucht", at: Date.now(), expiresWorldMs } as never }, null, FOREVER);
		await order("o-old", now - 1); await order("o-new", now + 10 * WORLD_HOUR_MS);
		await listing("l-old", now - 1); await listing("l-new", now + 10 * WORLD_HOUR_MS);
		await sweepTick(s);
		assert.deepEqual((await s.readAll({ type: "Order" })).map((e) => e.fields.orderId).filter((id) => String(id).startsWith("o-")).sort(), ["o-new"]);
		assert.deepEqual((await s.readAll({ type: "Listing" })).map((e) => e.fields.listingId).sort(), ["l-new"]);
		// the world's own board hangs jobs with a world-time date (the tick that brings them is `tick.orders`)
		await eventually(async () => (await s.readAll({ type: "Order" })).some((e) => typeof e.fields.expiresWorldMs === "number" && !String(e.fields.orderId).startsWith("o-")), 20_000, "a job of the world with its date");
	} finally { await stack.close(); }
});

test("a fire dated in real milliseconds (from before the clock) goes out when the world loads; a fire of the right kind stays", async () => {
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space, w = await loadWorld();
		const { loadIntoSpace } = await import("../server/engine/loader.ts");
		await loadIntoSpace(s, w); // the clock and the beacons
		const old = w.beacons[0]!.beaconId, fresh = w.beacons[1]!.beaconId;
		await s.write({ type: "Flame", fields: { beaconId: old, until: Date.now() + 600_000, litAt: Date.now() } as never }, null, 600_000);
		await lightFire(s, 5_000, fresh);
		await loadIntoSpace(s, w);
		assert.equal(await s.count({ type: "Flame", fields: { beaconId: old } }), 0, "the old-style fire is out");
		assert.equal(await s.count({ type: "Flame", fields: { beaconId: fresh } }), 1, "a fire of the world's time stays");
	} finally { await stack.close(); }
});

// ---- step 6: the roles' own timers in world time ----
test("a model role is awake until a world time: the room for others counts the awake ones, the time passes with the clock and the sweep clears it", async () => {
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space, { tryWake, isAwake } = await import("../server/npc/minds.ts");
		// an hour of world time a real second: five world minutes are 83 ms
		await s.write({ type: "WorldClock", fields: { worldId: "t", epoch: 1, realAnchorMs: Date.now(), worldAnchorMs: 8 * WORLD_HOUR_MS, rate: 3600, paused: false, version: 1 } as never }, null, FOREVER);
		assert.equal(await tryWake(s, "ines", 1, 20 * 60_000), true);
		const e = (await s.readIfExists({ type: "NpcAwake", fields: { npcId: "ines" } }, 1_000))!.fields as { since: number; untilWorldMs: number };
		assert.ok(Math.abs(e.untilWorldMs - e.since - 20 * 60_000) < 1_000, "awake for twenty world minutes");
		assert.equal(await isAwake(s, "ines"), true);
		assert.equal(await tryWake(s, "kalle", 1, 20 * 60_000), false, "one may be awake: the other waits");
		await new Promise((r) => setTimeout(r, 600)); // 36 world minutes
		assert.equal(await isAwake(s, "ines"), false, "the time has passed with the clock, though the entry is still there");
		assert.equal(await tryWake(s, "kalle", 1, 20 * 60_000), true, "a lapsed role no longer fills the house");
		await sweepTick(s);
		assert.equal(await s.count({ type: "NpcAwake", fields: { npcId: "ines" } }), 0, "the sweep clears what lapsed");
		assert.equal(await s.count({ type: "NpcAwake", fields: { npcId: "kalle" } }), 1);
	} finally { await stack.close(); }
});

test("the rhythm of a role follows the clock's rate, and no duration is scaled by SPACES_MMO_TIME_SCALE any more", async () => {
	const { paceMs, clockOf } = await import("../server/engine/clockcache.ts");
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space;
		await s.write({ type: "WorldClock", fields: { worldId: "t", epoch: 1, realAnchorMs: Date.now(), worldAnchorMs: 0, rate: 30, paused: false, version: 1 } as never }, null, FOREVER);
		await clockOf(s).clock(); // read once: the rate is known
		assert.equal(paceMs(s, 3_000, 50), 100, "three world seconds at rate 30: a tenth of a real second");
		assert.equal(paceMs(s, 3_000, 200), 200, "at least the minimum");
		const { readFileSync } = await import("node:fs");
		assert.equal(/export const gameMs|export function gameMs/.test(readFileSync(new URL("../server/engine/time.ts", import.meta.url), "utf8")), false, "gameMs is gone");
	} finally { await stack.close(); }
});
