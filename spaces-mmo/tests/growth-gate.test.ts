// Growth decided before a lock (server/engine/commands/growth.ts, plan section 3, growth steps 2 and 3): a room with no step
// takes nothing and sends nothing to the change stream; its decision is kept by everything it read, so a fire that goes
// out lets the room grow on the next run; a room whose lock's version changed between the decision and the take waits for
// the next run; over random changes written by hand, runs that keep their decisions grow what runs without them grow;
// and a command in the middle of its search (its transaction has read WORLD_LOCK, pinTerrain, and holds no room lock
// yet) keeps the room from growing until it commits, and what it wrote at the old place is there once, shifted by the
// strip where the strip lies before it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, NO_WAIT, PhiSpaces, openOwnMemoryHost, type SpaceLike } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { forgetGrowth, growthTick } from "../server/engine/commands/growth.ts";
import { holdRoom, holdRoomVersion, lockReport, lockVersion, roomLock } from "../server/engine/room-lock.ts";
import { pinTerrain } from "../server/engine/room-growth.ts";
import { loadWorld } from "../server/engine/world.ts";
import { initialClock } from "../server/engine/worldtime.ts";
import { WORLD_LOCK, type RoomFields, type RoomGrowthFields } from "../shared/model.ts";
import { worstOf, writeWorstGrowth } from "./growth-worst.ts";
import { startStack } from "./stack.ts";

const w = await loadWorld();

async function withSpace(f: (space: PhiSpaces) => Promise<void>): Promise<void> {
	const host = openOwnMemoryHost(), space = new PhiSpaces(host, ctx);
	try {
		await space.write({ type: WORLD_LOCK.type, fields: { ...WORLD_LOCK.fields } }, null, FOREVER);
		await space.write({ type: "WorldClock", fields: initialClock(w.id, 12, Date.now(), 1) as never }, null, FOREVER);
		await f(space);
	} finally { await host.close(ctx); }
}
const revision = async (s: SpaceLike) => (await s.readPage({ type: "-" })).rev;
const fire = (room: string, x: number, y: number) => ({ type: "Beacon", fields: { beaconId: `f-${room}-${x}-${y}`, name: "Feuer", aliases: [], room, x, y, covers: [], lit: true } });
const ground = async (s: SpaceLike, room: string) => ((await s.readAll({ type: "Room", fields: { roomId: room } }))[0]!.fields as unknown as RoomFields).ground;

test("a room with no step takes nothing; a fire that blocked the only way goes out and the room grows on the next run", { timeout: 120_000 }, async () => {
	await withSpace(async (s) => {
		const worst = await writeWorstGrowth(s, w, 2);
		const before = await revision(s);
		assert.equal(await growthTick(s, w, 60_000), 0);
		assert.equal(await growthTick(s, w, 60_000), 0, "kept: the same again");
		assert.equal(await revision(s), before, "runs that grow nothing send nothing to the change stream");

		// the first row free: the outermost seams reach the free part, but a fire on the row cuts them all off
		const room = worst.rooms[0]!, cut = Math.ceil(worst.width / 2) - 1;
		for (let x = 0; x < worst.width; x++) await s.takeIfExists({ type: "Footprint", fields: { room, of: worstOf(x, 0) } }, NO_WAIT);
		await s.write(fire(room, cut, 0), null, FOREVER);
		assert.equal(await growthTick(s, w, 60_000), 0, "the fire blocks the way to every seam");
		assert.equal(await growthTick(s, w, 60_000), 0);
		await s.takeIfExists({ type: "Beacon", fields: { room } }, NO_WAIT);
		assert.equal(await growthTick(s, w, 60_000), 1, "out: the room grows on the next run");
		assert.equal((await ground(s, room))[0]!.length, worst.width + w.growth!.strip);
	});
});

test("a room whose lock was held and committed between the decision and the take is left to the next run", { timeout: 120_000 }, async () => {
	await withSpace(async (s) => {
		const worst = await writeWorstGrowth(s, w, 1);
		const room = worst.rooms[0]!;
		for (let x = 0; x < worst.width; x++) await s.takeIfExists({ type: "Footprint", fields: { room, of: worstOf(x, 0) } }, NO_WAIT);
		// a view that shows the lock as it was, while a holder has since committed (the version counted up)
		const stale = (await s.readAll(roomLock(room)))[0]!;
		const txn = (await s.createTransaction(10_000)).id;
		assert.ok(await holdRoom(s, txn, room, NO_WAIT));
		await s.commit(txn);
		assert.equal(lockVersion((await s.readAll(roomLock(room)))[0]!.fields), lockVersion(stale.fields) + 1);
		const view = { readAll: async (t: Parameters<PhiSpaces["readAll"]>[0]) => (t?.type === "RoomLock" ? [stale] : s.readAll(t)) };
		const at = await revision(s);
		assert.equal(await growthTick(s, w, 60_000, view), 0, "changed since: not grown");
		assert.equal((await ground(s, room))[0]!.length, worst.width);
		assert.ok((await revision(s)) > at, "it took the locks to find that out");
		assert.equal(await growthTick(s, w, 60_000), 1, "the next run grows it");
	});
});

test("over random changes written by hand, runs that keep their decisions grow what runs without them grow", { timeout: 300_000 }, async () => {
	let seed = 7;
	const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; };
	await withSpace(async (a) => await withSpace(async (b) => {
		const worst = await writeWorstGrowth(a, w, 3);
		await writeWorstGrowth(b, w, 3);
		// the first rows free, so the changes on them open and close the ways to the seams
		for (const s of [a, b]) for (const room of worst.rooms) for (let x = 0; x < worst.width; x++) await s.takeIfExists({ type: "Footprint", fields: { room, of: worstOf(x, 0) } }, NO_WAIT);
		for (const s of [a, b]) for (const room of worst.rooms) await s.write(fire(room, Math.ceil(worst.width / 2) - 1, 0), null, FOREVER);
		let grew = 0;
		for (let round = 0; round < 80; round++) {
			// the same change in both: a footprint taken or put back, a fire lit or out, a zone laid or taken; most on the
			// first row
			const room = worst.rooms[rnd(worst.rooms.length)]!, x = rnd(worst.width), y = rnd(3) ? 0 : rnd(worst.height);
			const change = rnd(6);
			for (const s of [a, b]) {
				if (change === 0) await s.takeIfExists({ type: "Footprint", fields: { room, of: worstOf(x, y) } }, NO_WAIT);
				else if (change === 1 && !(await s.readAll({ type: "Footprint", fields: { room, of: worstOf(x, y) } })).length) await s.write({ type: "Footprint", fields: { room, of: worstOf(x, y), x, y, w: 1, h: 1 } }, null, FOREVER);
				else if (change === 2) await s.write(fire(room, x, y), null, FOREVER);
				else if (change === 3) for (const e of await s.readAll({ type: "Beacon", fields: { room } })) await s.takeIfExists({ id: e.id }, NO_WAIT);
				else if (change === 4) await s.write({ type: "Zone", fields: { zoneId: `z-${round}`, room, settlementId: "s", kind: "gruen", x, y, w: 2, h: 2 } }, null, FOREVER);
				else for (const e of await s.readAll({ type: "Zone", fields: { room } })) await s.takeIfExists({ id: e.id }, NO_WAIT);
			}
			const kept = await growthTick(a, w, 60_000);
			forgetGrowth(b);
			assert.equal(kept, await growthTick(b, w, 60_000), `round ${round}`);
			grew += kept;
			for (const r of worst.rooms) assert.deepEqual(await ground(a, r), await ground(b, r), `round ${round}, ${r}`);
		}
		assert.ok(grew > 0, "the changes let rooms grow");
	}));
});

test("a command in its search keeps the room from growing; committed, what it wrote is there once, where the strip puts it", { timeout: 120_000 }, async () => {
	// in a space process of its own (SPACES_MMO_SPACE_SERVER: the Rust one), which writes WORLD_LOCK itself: the rule that
	// a read under a transaction keeps others from taking the entry is the space core's
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space;
		if (!(await s.readAll({ type: "WorldClock" })).length) await s.write({ type: "WorldClock", fields: initialClock(w.id, 12, Date.now(), 1) as never }, null, FOREVER);
		const worst = await writeWorstGrowth(s, w, 1);
		const room = worst.rooms[0]!;
		for (let x = 0; x < worst.width; x++) await s.takeIfExists({ type: "Footprint", fields: { room, of: worstOf(x, 0) } }, NO_WAIT);
		// a command's transaction as the world worker begins it: WORLD_LOCK read under it (the terrain pinned), no room lock
		const txn = (await s.createTransaction(30_000)).id;
		await pinTerrain(s, txn);
		const prints = JSON.stringify((await s.readAll({ type: "Footprint", fields: { room } })).map((e) => e.fields));
		assert.equal(await growthTick(s, w, 60_000), 0, "growth cannot take WORLD_LOCK while a command has it read");
		assert.equal((await ground(s, room))[0]!.length, worst.width);
		assert.equal(JSON.stringify((await s.readAll({ type: "Footprint", fields: { room } })).map((e) => e.fields)), prints, "nothing moved");
		// the command goes on: the room's lock, then its write at the old coordinates (the east column)
		assert.notEqual(await holdRoomVersion(s, txn, room), null);
		const of = worstOf(worst.width - 1, 1);
		const old = await s.takeIfExists({ type: "Footprint", fields: { room, of } }, NO_WAIT, { txn });
		assert.ok(old);
		await s.write({ type: "Footprint", fields: old.fields as never }, txn, FOREVER);
		await s.commit(txn);
		assert.equal(await growthTick(s, w, 60_000), 1, "free again, the room grows");
		assert.equal((await ground(s, room))[0]!.length, worst.width + w.growth!.strip);
		const moved = (await s.readAll({ type: "Footprint", fields: { room, of } }))[0]!.fields;
		const after = (await s.readAll({ type: "Footprint", fields: { room, of } })).map((e) => e.fields);
		const strip = (await s.readAll({ type: "RoomGrowth", fields: { roomId: room } }))[0]!.fields as unknown as RoomGrowthFields;
		const at = strip.steps![0]!.at;
		assert.deepEqual(after, [{ ...old.fields, x: Number(old.fields.x) + (Number(old.fields.x) >= at ? w.growth!.strip : 0) }], "the command's footprint is there once, where the strip put it");
		assert.deepEqual(lockReport((await s.readAll({})) as never), []);
	} finally { await stack.close(); }
});

