// Contention at the room lock (server/engine/room-lock.ts; docs/3d-welt-und-raster-plan-2026-11-21.en.md section 3,
// "Locks", and phase 1): two world workers that serve one character at a time each, so two characters' commands sent
// at once run in two processes (SPACES_MMO_WORLD_CMD with SPACES_MMO_WORLD_MIXED=1 makes one of them the Rust one).
// - Two attempts on the same cells sent at once yield exactly one object there, round after round: the admin moving
//   its hut onto a rectangle (versetze takes no fire's light, so only the room lock and the check under it stand
//   between the two) while a player stakes out a hut on it; and two players staking out a hut there (they meet at the
//   room lock, and the fire's LightUse entry is taken after it, build.ts useLight).
// - A holder killed while it holds the lock (tests/lock-holder.ts): the lock stays away until its transaction's lease
//   runs out, a command meanwhile is refused and changes nothing, then the lock is back with the version it had (the
//   write-back of the killed transaction is gone) and the same command goes through.
// - A world worker killed in the middle of such a round: the intent it held comes back with its transaction's lease and
//   the other worker runs it; one object on the cells, and the stack's check at close finds every lock.
// The texts of the losing side are counted (refused for the lock, for the fire's light, for the cells), not asserted:
// which one a round gives depends on timing.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { once } from "node:events";
import type { SpaceLike } from "phi-spaces";
import type { ServerFrame } from "../server/gateway.ts";
import { worldNowOf } from "../server/engine/clock.ts";
import { loadWorld } from "../server/engine/world.ts";
import { LOCK_HELD, lockReport, lockVersion, roomLock } from "../server/engine/room-lock.ts";
import { storeOccupancyReport, type OccupancyEntry } from "../shared/footprints.ts";
import type { FootprintFields } from "../shared/model.ts";
import { eventually, heldCells, lightFire, placeFootprint, Player, startServer, startStack } from "./stack.ts";

const w = await loadWorld();
const ROUNDS = Number(process.env.CONTENTION_ROUNDS ?? 12);
const DELAY_STEP = Number(process.env.CONTENTION_DELAY_STEP ?? 7), DELAY_SPAN = Number(process.env.CONTENTION_DELAY_SPAN ?? 84);
const TXN_MS = 4_000; // a killed worker's command transaction comes back after this
type P = { p: Player; me: string; name: string };
async function player(url: string, name: string, token?: string): Promise<P> {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123", ...(token ? { setupToken: token } : {}) })).status, 200);
	return { p, me: (await p.play()).me.charId, name };
}
/** Sends `line` and waits for the first message after it that matches `text`. */
function says(a: P, line: string, text: RegExp, ms = 60_000): Promise<string> {
	const from = a.p.frames.length;
	a.p.send(line);
	return a.p.until((f) => f.t === "msg" && text.test(f.m.text), ms, from).then((f) => (f as Extract<ServerFrame, { t: "msg" }>).m.text);
}
async function walk(a: P, space: SpaceLike, x: number, y: number): Promise<void> {
	a.p.send(`move ${x} ${y}`);
	await eventually(async () => { const c = (await space.readAll({ type: "Character", fields: { charId: a.me } }))[0]?.fields; return c?.x === x && c?.y === y; }, 60_000, `${a.name} at ${x},${y}`);
}
type Rect = { x: number; y: number; w: number; h: number };
const meets = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** The objects whose Footprint entries lie on `r`. */
const on = async (space: SpaceLike, room: string, r: Rect) => (await space.readAll({ type: "Footprint", fields: { room } })).map((e) => e.fields as unknown as FootprintFields).filter((f) => meets(f, r)).map((f) => f.of);
async function invariants(space: SpaceLike, what: string): Promise<void> {
	const entries = (await space.readAll({})) as unknown as OccupancyEntry[];
	assert.deepEqual(storeOccupancyReport(entries, { skip: () => false }), [], `${what}: objects and Footprint entries`);
	assert.deepEqual(lockReport(entries), [], `${what}: one lock per room and island`);
}

/** A free stretch of the bay's grass (nothing held on it or beside it, away from the fire) for a hut at `hut`, its
 *  target `r` and the people below it. */
async function stretch(space: SpaceLike, room: string) {
	const ground = w.rooms.find((x) => x.roomId === room)!.ground as string[];
	const fire = w.beacons.find((b) => b.room === room)!;
	const held = await heldCells(space, room);
	const grass = (x: number, y: number) => ground[y]?.[x] === "," && !held.has(`${x},${y}`) && Math.max(Math.abs(x - fire.x), Math.abs(y - fire.y)) > 4;
	const free = (x: number, y: number, wd: number, h: number, not?: Rect) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + wd; i++) if (!grass(i, j) || (not && meets({ x: i, y: j, w: 1, h: 1 }, not))) return false; return true; };
	// the target with a cell round it (the people stand below it and beside it), and the hut's place elsewhere
	for (let y = 1; y < ground.length - 4; y++) for (let x = 1; x < ground[0]!.length - 4; x++) {
		if (!free(x - 1, y - 1, 5, 5)) continue;
		const block = { x: x - 2, y: y - 2, w: 7, h: 7 };
		for (let j = 1; j < ground.length - 3; j++) for (let i = 1; i < ground[0]!.length - 3; i++) if (free(i - 1, j - 1, 4, 4, block)) return { r: { x, y, w: 2, h: 2 }, hut: { x: i, y: j, w: 2, h: 2 }, below: { x, y: y + 2 }, beside: { x: x + 2, y: y + 1 } };
	}
	throw new Error(`no free stretch in ${room}`);
}

const LOST = { lock: new RegExp(LOCK_HELD.replace(/[.;]/g, "\\$&")), light: /Gerade baut jemand anderes im Licht/, cells: /steht schon etwas|wird gebaut|Dort steht jemand|Weg zugebaut|in Benutzung/ };
/** The last messages `a` was told (a failure's context). */
const tail = (a: P) => a.p.frames.filter((f) => f.t === "msg").slice(-6).map((f) => (f as Extract<ServerFrame, { t: "msg" }>).m.text.slice(0, 70)).join(" | ");
/** A player's own answer to `bau` (another's staking is told to everyone in the room). */
const staking = (x: P) => new RegExp(`${x.name} steckt eine Baustelle ab|passt keine?|Hier wird gerade|Gerade baut`);
const lostFor = (text: string) => (LOST.lock.test(text) ? "lock" : LOST.light.test(text) ? "light" : LOST.cells.test(text) ? "cells" : `other: ${text}`);

test("two attempts on the same cells at once, on two workers: exactly one object there, round after round", { timeout: 600_000 }, async () => {
	const stack = await startStack({ worlds: 2, worldEnv: { SPACES_MMO_WORLD_LANES: "1", SPACES_MMO_TXN_MS: String(TXN_MS) } });
	const srv = await startServer({ stack, accountOptions: { setupToken: "t" } });
	try {
		const s = stack.space;
		const admin = await player(srv.url, "Betreiberin", "t"), a = await player(srv.url, "Ada"), b = await player(srv.url, "Bea");
		const me = (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: admin.me } }))[0], 10_000, "admin"))!.fields;
		const room = String(me.room);
		const fire = w.beacons.find((x) => x.room === room)!;
		await lightFire(s, 3_600_000, fire.beaconId);
		const { r, hut, below, beside } = await stretch(s, room);
		const now = await worldNowOf(s);
		await s.write({ type: "Building", fields: { buildId: "h-c", plan: "huette", name: "Hütte", room, ...hut, owner: admin.me, ownerName: admin.name, accountId: me.accountId, beaconId: fire.beaconId, points: 1, by: {}, untilWorldMs: now + 7 * 24 * 3600_000, builtAt: now } as never }, null, 3_600_000_000);
		await placeFootprint(s, room, "h-c", hut);
		await walk(a, s, below.x, below.y);
		await walk(b, s, beside.x, beside.y);
		const target = `${r.x} ${r.y}`;
		const counts: Record<string, number> = {}, times = { bau: [] as number[] };
		const count = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
		/** Puts the cells back as they were: the hut to its place, a site given up by whoever staked it. */
		const clear = async (winner: string) => {
			if (winner === "h-c") assert.match(await says(admin, `versetze h-c ${hut.x} ${hut.y}`, /steht jetzt|nicht versetzen/), /steht jetzt/);
			else {
				const site = (await s.readAll({ type: "Site", fields: { buildId: winner } }))[0]!.fields;
				const owner = site.owner === a.me ? a : b;
				assert.match(await says(owner, "abriss baustelle", /gibt die Baustelle|nicht greifbar|Hier wird gerade/), new RegExp(`${owner.name} gibt die Baustelle`));
			}
			assert.deepEqual(await on(s, room, r), []);
		};

		for (let round = 0; round < ROUNDS; round++) {
			// the admin's hut and Ada's site at once; bau searches and takes the light before it takes the lock, so the move
			// is sent a little later each round, across the time bau takes
			const t0 = Date.now();
			const [staked, moved] = await Promise.all([
				says(a, `bau hütte ${target}`, staking(a)).then((t) => { times.bau.push(Date.now() - t0); return t; }),
				new Promise((ok) => setTimeout(ok, (round * DELAY_STEP) % DELAY_SPAN)).then(() => says(admin, `versetze h-c ${target}`, /steht jetzt|nicht versetzen|Hier wird gerade|in Benutzung/)),
			]);
			const there = await on(s, room, r);
			assert.equal(there.length, 1, `round ${round}: one object on the cells, not ${there.join(", ")} (${moved} / ${staked})`);
			assert.equal(/steht jetzt/.test(moved) ? 1 : 0, there[0] === "h-c" ? 1 : 0, `round ${round}: the admin's answer says what stands there`);
			count(`versetze-bau won by ${there[0] === "h-c" ? "versetze" : "bau"}`);
			count(`versetze-bau lost to ${lostFor(there[0] === "h-c" ? staked : moved)}`);
			await invariants(s, `round ${round}`);
			await clear(there[0]!);

			// Ada and Bea staking out a hut there at once
			const both = await Promise.all([a, b].map((x) => says(x, `bau hütte ${target}`, staking(x))));
			const sites = await on(s, room, r);
			assert.equal(sites.length, 1, `round ${round}: one site, not ${sites.join(", ")} (${both.join(" / ")}); last told: ${[admin, a, b].map((x) => `${x.name}: ${tail(x)}`).join("; ")}`);
			assert.equal(both.filter((t) => /steckt eine Baustelle ab/.test(t)).length, 1, `round ${round}: one of them staked it (${both.join(" / ")})`);
			count(`bau-bau lost to ${lostFor(both.find((t) => !/steckt eine Baustelle ab/.test(t))!)}`);
			await invariants(s, `round ${round}, two sites`);
			await clear(sites[0]!);
		}
		console.error(`[contention] ${ROUNDS} rounds: ${JSON.stringify(counts)}; bau answered in ${JSON.stringify(times.bau)} ms`);
		assert.equal(Object.keys(counts).filter((k) => k.includes("other")).length, 0, JSON.stringify(counts));

		// a world worker killed while it serves one of the two: its intent comes back with the transaction's lease and the
		// other worker runs it; one object on the cells either way
		const answers = Promise.all([
			says(admin, `versetze h-c ${target}`, /steht jetzt|nicht versetzen|Hier wird gerade|in Benutzung/, 120_000),
			says(a, `bau hütte ${target}`, staking(a), 120_000),
		]);
		stack.worlds[0]!.kill("SIGKILL");
		const [moved, staked] = await answers;
		await eventually(async () => lockReport((await s.readAll({})) as unknown as OccupancyEntry[]).length === 0, TXN_MS * 4, "every lock back after the kill");
		const there = await on(s, room, r);
		assert.equal(there.length, 1, `after the kill: one object on the cells, not ${there.join(", ")} (${moved} / ${staked})`);
		await invariants(s, "after the kill");
	} finally {
		await srv.close();
		await stack.close();
	}
});

test("a holder killed while it holds a room's lock: refused meanwhile, the lock back with its version after the lease, then the command goes through", { timeout: 240_000 }, async () => {
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.001" } });
	try {
		const s = srv.stack.space;
		const a = await player(srv.url, "Ada");
		const room = String((await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: a.me } }))[0], 10_000, "Ada"))!.fields.room);
		const fire = w.beacons.find((x) => x.room === room)!;
		await lightFire(s, 3_600_000, fire.beaconId);
		const { r, below } = await stretch(s, room);
		await walk(a, s, below.x, below.y);
		const before = lockVersion((await s.readAll(roomLock(room)))[0]!.fields);
		const light = async () => (await s.readAll({ type: "LightUse", fields: { beaconId: fire.beaconId } }))[0]?.fields.used ?? 0;
		const used = await light();

		const LEASE = 6_000;
		const holder = spawnProcess(process.execPath, ["--no-warnings", "--experimental-strip-types", "tests/lock-holder.ts", srv.stack.world, room, String(LEASE)], { stdio: ["ignore", "pipe", "inherit"] });
		const [line] = (await once(holder.stdout!, "data")) as [Buffer];
		assert.equal(line.toString().trim(), `held ${before}`);
		holder.kill("SIGKILL");
		await once(holder, "exit");
		const killedAt = Date.now();
		assert.equal((await s.readAll(roomLock(room))).length, 0, "the killed holder's transaction still has the lock");

		const target = `${r.x} ${r.y}`;
		const refused = await says(a, `bau hütte ${target}`, /steckt eine Baustelle ab|passt keine?|Hier wird gerade/);
		if (Date.now() - killedAt < LEASE) {
			assert.match(refused, LOST.lock);
			assert.deepEqual(await on(s, room, r), [], "a refused command leaves no footprint");
			assert.equal(await light(), used, "nor does it use the fire's light");
		}
		await eventually(async () => (await s.readAll(roomLock(room))).length === 1, LEASE * 3, "the lock back after the lease");
		assert.equal(lockVersion((await s.readAll(roomLock(room)))[0]!.fields), before, "the killed holder's write-back is gone with its transaction");
		let staked = "";
		for (let i = 0; i < 3 && !/steckt/.test(staked); i++) staked = await says(a, `bau hütte ${target}`, /steckt eine Baustelle ab|passt keine?|Hier wird gerade/);
		assert.match(staked, /steckt eine Baustelle ab: Hütte/);
		assert.equal((await on(s, room, r)).length, 1);
		assert.ok(lockVersion((await s.readAll(roomLock(room)))[0]!.fields) > before, "the command's commit counted the version up");
		await invariants(s, "after the holder");
	} finally {
		await srv.close();
	}
});
