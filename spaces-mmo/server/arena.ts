// The arena (docs/codemode-anwendungen.en.md, B): worlds of their own for bots that the codemode chat judges. Every
// `open` starts a fresh Leuchtfeuer world in memory (a space process and a world worker, no NPC and no model process),
// signs one guest in and stops the world clock; the bot then plays that guest through `look`, `act` and `wait`, and
// `score` says whether it reached its goal. The judge talks to it only over this socket (no TypeScript import across
// the two projects):
//
//   npm --prefix spaces-mmo run arena          SPACES_MMO_ARENA_LISTEN=unix:/tmp/spaces-mmo-arena.sock (default)
//                                              or tcp:127.0.0.1:3990; SPACES_MMO_ARENA_WORLDS=2 worlds at a time
//
// The protocol is JSON lines: a request `{ id, op, ... }`, an answer `{ id, ok: true, ... }` or `{ id, ok: false, error }`.
//   open { start?, setup?, seed? }  → { world, charId, name }      (waits for a free slot) start { room, x, y }: where
//                                                                    the guest stands (default: the spawn cell of its
//                                                                    room); setup { clear?: protos, items?: [{ proto,
//                                                                    room, x, y }] }: those things off the ground of
//                                                                    every room, these laid out; seed: the world
//                                                                    worker's chance (a planning task's episode,
//                                                                    docs/codemode-planung.en.md)
//   look { world }                  → what the figure sees: its room, place, exits, things, fires, pack, the time
//   act { world, line }             → { said: string[], at }        the line as a player types it, done when the
//                                                                    world worker has carried it out
//   wait { world, minutes }         → { time }                      the clock moves on (it stands still otherwise)
//   score { world, goal, hold? }    → { done, detail }              goal "beacon:<beaconId>": the figure lit it;
//                                                                    "feed:<beaconId>:<n>": it put n pieces into it;
//                                                                    hold: the world moves on that many minutes (not
//                                                                    counted against the bot's waits) and the goal
//                                                                    must still hold
//   path { world }                  → { path, cut }                 the way the figure went: [room, x, y] for its start
//                                                                    and every cell where it changed room or direction
//                                                                    (a `move` counted cell by cell, the shortest walk
//                                                                    around fires); at most PATH_STEPS, else every n-th
//                                                                    and the last, and `cut` says so
//   map { room }                    → { world, room, name, island, map, ground, decor, walk, exits, fires }   a room's
//                                                                    geometry for drawing paths (no world needed): the
//                                                                    ground and decor rows, which ground keys are walkable,
//                                                                    the exits with their destination, the fires, its
//                                                                    place on the atlas, and `rev` (changes with them)
//   close { world }                 → {}
// A world is closed when its connection ends or nobody asks it anything for SPACES_MMO_ARENA_IDLE_MS (default 5 min).
// A durable run (codemode-chat, docs/codemode-anwendungen.en.md D) opens with `keep: true`: its world outlives the
// connection, so a judge that takes over after a crash finds it again by its id. It names how long the world must
// wait for that judge (`idleMs`, its transaction lease and a margin; at most an hour), else the idle time applies. Such a judge replays the calls it
// has logged and sends the rest anew; a `key` on look/act/wait makes that safe: a key the world has seen gets the
// answer it got then, the command is not carried out twice (the call that was on its way when the judge died).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { Accounts } from "./accounts.ts";
import { ROOT } from "./env.ts";
import { actorToken, asFields, fieldsOf, type BeaconFields, type CharacterFields, type ExitFields, type IntentFields, type ItemFields, type MsgFields, type WorldClockFields } from "./model.ts";
import { connectSpace, peek } from "./space.ts";
import { spaceServer } from "./space-server.ts";
import { findPath, loadWorld, walkable, type WorldDef } from "./engine/world.ts";
import { blockedIn } from "./engine/occupancy.ts";
import { resolvePrototype, spawn as spawnItem } from "./engine/prototypes.ts";
import { flameOf, isLit } from "./engine/fire.ts";
import { render } from "./engine/funcparser.ts";
import { formatWorldTime, paused, worldNow, WORLD_MINUTE_MS } from "./engine/worldtime.ts";

const LISTEN = process.env.SPACES_MMO_ARENA_LISTEN || "unix:/tmp/spaces-mmo-arena.sock";
const MAX_WORLDS = Math.max(1, Number(process.env.SPACES_MMO_ARENA_WORLDS ?? 2));
const IDLE_MS = Number(process.env.SPACES_MMO_ARENA_IDLE_MS ?? 5 * 60_000);
/** The longest one command may take before `act` gives up on it. */
const ACT_MS = 15_000;
/** At most this many world minutes per `wait`, and in all per world (a day). */
export const MAX_WAIT_MINUTES = 120, MAX_WAITED_MINUTES = 24 * 60;
const MAX_LINE = 300, MAX_THINGS = 30;
/** The most cells a world remembers of the figure's way, and the most steps `path` gives. */
const MAX_TRAIL = 20_000;
export const PATH_STEPS = 200;
type Step = [room: string, x: number, y: number];

type World = {
	id: string; dir: string; procs: ChildProcess[]; conns: Array<{ close(): void }>;
	space: SpaceLike; charId: string; name: string; waited: number; touched: number; owner: Socket | null;
	/** A kept world's own idle time (`open { keep, idleMs }`). */
	idleMs?: number;
	/** Answers by key (look/act/wait with a `key`), so a repeated call is not carried out twice. */
	done: Map<string, Promise<Record<string, unknown>>>;
	/** The world's definition, and every cell the figure went over (its start first). */
	w: WorldDef; trail: Step[];
};
/** The most keyed answers a world keeps. */
const MAX_KEYS = 5000;

// ---- starting and stopping a world ----------------------------------------------------------------------------
function run(file: string, env: Record<string, string>, ready: string): Promise<ChildProcess> {
	return new Promise((ok, fail) => {
		const server = file === "server/space-host.ts" ? spaceServer() : null;
		const child = spawn(server?.command ?? process.execPath, server?.args ?? ["--no-warnings", "--experimental-strip-types", file], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "", done = false;
		const timer = setTimeout(() => { if (!done) { done = true; child.kill("SIGKILL"); fail(new Error(`${file} did not start:\n${out.slice(-2000)}`)); } }, 60_000);
		const seen = (d: Buffer) => { out += d.toString(); if (!done && out.includes(ready)) { done = true; clearTimeout(timer); ok(child); } };
		child.stdout?.on("data", seen);
		child.stderr?.on("data", (d: Buffer) => { out += d.toString(); if (process.env.SPACES_MMO_ARENA_LOG) process.stderr.write(d); });
		child.on("exit", (code) => { if (!done) { done = true; clearTimeout(timer); fail(new Error(`${file} exited (${code}):\n${out.slice(-2000)}`)); } });
	});
}
const stop = (c: ChildProcess) => new Promise<void>((r) => { if (c.exitCode !== null || c.signalCode !== null) return r(); c.once("exit", () => r()); c.kill("SIGTERM"); setTimeout(() => c.kill("SIGKILL"), 5_000).unref(); });

/** What `open` may set up: where the guest starts, what lies where, the world worker's seed. */
export type OpenSpec = { start?: { room: string; x: number; y: number }; setup?: { clear?: string[]; items?: Array<{ proto: string; room: string; x: number; y: number }> }; seed?: number };
const MAX_SETUP_ITEMS = 50;

/** Checks an `open` request's start, setup and seed against the world before a world is started for it. */
export function openSpec(w: WorldDef, r: Record<string, unknown>): OpenSpec {
	const rooms = new Map((w.allRooms ?? w.rooms).map((room) => [room.roomId, room]));
	const cell = (c: unknown, what: string) => {
		const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>, room = rooms.get(String(o.room)), x = Number(o.x), y = Number(o.y);
		if (!room) throw new Error(`${what}: no room ${String(o.room)}`);
		if (!Number.isInteger(x) || !Number.isInteger(y) || !walkable(w, room.ground, x, y)) throw new Error(`${what}: ${room.roomId} ${o.x},${o.y} is no walkable cell`);
		return { room: room.roomId, x, y };
	};
	const out: OpenSpec = {};
	if (r.start !== undefined) out.start = cell(r.start, "start");
	if (r.setup !== undefined) {
		const s = (r.setup && typeof r.setup === "object" ? r.setup : {}) as Record<string, unknown>;
		const clear = Array.isArray(s.clear) ? s.clear.map(String) : [], items = Array.isArray(s.items) ? s.items : [];
		if (clear.length > 20 || items.length > MAX_SETUP_ITEMS) throw new Error(`setup: at most 20 protos to clear and ${MAX_SETUP_ITEMS} items`);
		out.setup = { clear, items: items.map((i, n) => ({ proto: String((i as Record<string, unknown>)?.proto ?? ""), ...cell(i, `setup item ${n + 1}`) })) };
	}
	if (r.seed !== undefined) {
		const s = Number(r.seed);
		if (!Number.isInteger(s) || s < 0 || s > 0xffffffff) throw new Error("seed: an integer from 0 to 2^32 - 1");
		out.seed = s;
	}
	return out;
}

async function openWorld(w: WorldDef, owner: Socket | null, spec: OpenSpec = {}): Promise<World> {
	const dir = mkdtempSync(join(tmpdir(), "mmo-arena-")), world = `unix:${join(dir, "world.sock")}`, accounts = `unix:${join(dir, "accounts.sock")}`;
	const procs: ChildProcess[] = [], conns: Array<{ close(): void }> = [];
	const quiet = { SPACES_MMO_LLM: "", SPACES_MMO_NPCS: "", SPACES_MMO_REGION: "", SPACES_MMO_REGIONS: "", SPACES_MMO_SPACES: "" };
	try {
		procs.push(await run("server/space-host.ts", { ...quiet, SPACES_MMO_LISTEN: world, SPACES_MMO_ACCOUNTS_LISTEN: accounts, SPACES_MMO_MEM: "1", SPACES_MMO_DATA: "" }, "[space] ready"));
		procs.push(await run("server/world-host.ts", { ...quiet, SPACES_MMO_SPACE: world, SPACES_MMO_SEED: spec.seed === undefined ? "" : String(spec.seed) }, "[world] ready"));
		const ws = connectSpace(world), as = connectSpace(accounts);
		conns.push(ws, as);
		const me = await new Accounts(ws.space, as.space, w).createGuest();
		await pauseClock(ws.space);
		if (spec.setup) await setUp(w, ws.space, spec.setup);
		await toSpawn(w, ws.space, me.charId, spec.start);
		const ch = await character(ws.space, me.charId);
		return { id: randomBytes(6).toString("hex"), dir, procs, conns, space: ws.space, charId: me.charId, name: ch.name, waited: 0, touched: Date.now(), owner, done: new Map(), w, trail: [[ch.room, ch.x, ch.y]] };
	} catch (e) {
		for (const c of conns) c.close();
		await Promise.all(procs.map(stop));
		rmSync(dir, { recursive: true, force: true });
		throw e;
	}
}
async function closeWorld(x: World): Promise<void> {
	for (const c of x.conns) c.close();
	await Promise.all(x.procs.map(stop));
	rmSync(x.dir, { recursive: true, force: true });
}

// ---- the clock: stopped at the start, moved on only by `wait` ---------------------------------------------------
async function moveClock(space: SpaceLike, f: (c: WorldClockFields) => WorldClockFields): Promise<WorldClockFields> {
	const txn = (await space.createTransaction(10_000)).id;
	try {
		const t = await space.take({ type: "WorldClock" }, 5_000, { txn });
		if (!t) throw new Error("the world has no clock");
		const next = f(fieldsOf<WorldClockFields>(t));
		await space.write({ type: "WorldClock", fields: next as never }, txn, FOREVER);
		await space.commit(txn);
		return next;
	} catch (e) { await space.abort(txn).catch(() => {}); throw e; }
}
const pauseClock = (space: SpaceLike) => moveClock(space, (c) => (c.paused ? c : paused(c, Date.now())));

/** The guest onto its room's spawn cell, or onto `start`: a new figure is scattered around the spawn at random, and a
 *  bot should start where every other bot of its episode starts (the spawn is kept free in the world's definition). */
async function toSpawn(w: WorldDef, space: SpaceLike, charId: string, start?: OpenSpec["start"]): Promise<void> {
	const txn = (await space.createTransaction(10_000)).id;
	try {
		const t = await space.take({ type: "Character", fields: { charId } }, 5_000, { txn });
		if (!t) throw new Error("the figure is gone");
		const ch = fieldsOf<CharacterFields>(t), room = (w.allRooms ?? w.rooms).find((r) => r.roomId === ch.room);
		const at = start ?? (room ? { room: room.roomId, x: room.spawn.x, y: room.spawn.y } : null);
		await space.write({ type: "Character", fields: asFields({ ...ch, ...(at ?? {}) }) }, txn, FOREVER);
		await space.commit(txn);
	} catch (e) { await space.abort(txn).catch(() => {}); throw e; }
}

/** An episode's layout: the things of the protos in `clear` taken off the ground of every room (not out of anyone's
 *  pack), then `items` laid out, in one transaction. */
async function setUp(w: WorldDef, space: SpaceLike, s: NonNullable<OpenSpec["setup"]>): Promise<void> {
	const rooms = new Set((w.allRooms ?? w.rooms).map((r) => r.roomId));
	const protos = await Promise.all((s.items ?? []).map(async (i) => { const p = await resolvePrototype(space, i.proto); if (!p) throw new Error(`setup: no prototype ${i.proto}`); return p; }));
	const txn = (await space.createTransaction(15_000)).id;
	try {
		for (const proto of s.clear ?? []) {
			for (const e of await space.readAll({ type: "Item", fields: { proto } as never }, { limit: 500 })) {
				if (!rooms.has(String((e.fields as Record<string, unknown>).location))) continue;
				await space.take({ id: e.id }, NO_WAIT, { txn });
			}
		}
		for (const [n, i] of (s.items ?? []).entries()) await spawnItem(space, txn, w, protos[n]!, { location: i.room, x: i.x, y: i.y });
		await space.commit(txn);
	} catch (e) { await space.abort(txn).catch(() => {}); throw e; }
}

// ---- what the figure sees ---------------------------------------------------------------------------------------
async function character(space: SpaceLike, charId: string): Promise<CharacterFields> {
	const e = await peek(space, { type: "Character", fields: { charId } });
	if (!e) throw new Error("the figure is gone");
	return fieldsOf<CharacterFields>(e);
}
const all = async <T>(space: SpaceLike, type: string, fields: Record<string, unknown>) => (await space.readAll({ type, fields: fields as never }, { limit: 500 })).map((e) => fieldsOf<T>(e));

export async function look(w: WorldDef, x: World) {
	const me = await character(x.space, x.charId), clock = await readClockOf(x.space), now = worldNow(clock);
	const room = (w.allRooms ?? w.rooms).find((r) => r.roomId === me.room);
	const dist = (o: { x: number; y: number }) => Math.abs(o.x - me.x) + Math.abs(o.y - me.y);
	const things = (await all<ItemFields>(x.space, "Item", { location: me.room }))
		.map((i) => ({ name: i.name, x: i.x, y: i.y }))
		.sort((a, b) => dist(a) - dist(b) || a.name.localeCompare(b.name) || a.x - b.x || a.y - b.y).slice(0, MAX_THINGS);
	const exits = (await all<ExitFields>(x.space, "Exit", { location: me.room })).map((e) => ({ name: e.name, x: e.x, y: e.y })).sort((a, b) => a.name.localeCompare(b.name));
	const fires = await Promise.all((await all<BeaconFields>(x.space, "Beacon", { room: me.room })).map(async (b) => ({ name: b.name, x: b.x, y: b.y, lit: isLit(await flameOf(x.space, b.beaconId), now) })));
	const pack = new Map<string, number>();
	for (const i of await all<ItemFields>(x.space, "Item", { location: x.charId })) pack.set(i.name, (pack.get(i.name) ?? 0) + 1);
	return {
		room: { id: me.room, name: room?.name ?? me.room }, at: { x: me.x, y: me.y },
		exits, things, fires: fires.sort((a, b) => a.name.localeCompare(b.name)),
		pack: [...pack].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)),
		time: formatWorldTime(now),
	};
}
async function readClockOf(space: SpaceLike): Promise<WorldClockFields> {
	const e = await peek(space, { type: "WorldClock" });
	if (!e) throw new Error("the world has no clock");
	return fieldsOf<WorldClockFields>(e);
}

/** One line as a player types it: written as an Intent like the gateway does. It is done when the world worker took
 *  the intent and committed: the command holds the figure's actor token for its whole transaction and writes it back
 *  last, so the token visible again with the intent gone means the command is over. The messages the figure got
 *  meanwhile come back, in order, as the figure reads them. */
export async function act(x: World, line: string): Promise<{ said: string[]; at: { room: string; x: number; y: number } }> {
	line = String(line ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, MAX_LINE);
	if (!line) throw new Error("act needs a line");
	const before = await character(x.space, x.charId), t0 = Date.now();
	const intent: IntentFields = { intentId: randomBytes(8).toString("hex"), charId: x.charId, line, at: t0 };
	await x.space.write({ type: "Intent", fields: asFields(intent) }, null, ACT_MS * 2);
	const end = Date.now() + ACT_MS, late = () => new Error(`the world did not carry out "${line}" within ${ACT_MS / 1000} s`);
	for (;;) {
		if (Date.now() > end) throw late();
		if (await peek(x.space, { type: "Intent", fields: { intentId: intent.intentId } })) { await new Promise((r) => setTimeout(r, 15)); continue; }
		// taken: wait until the command's transaction gives the token back (an aborted one gives the intent back too)
		if (!(await x.space.readIfExists(actorToken(x.charId), Math.max(1, end - Date.now())))) throw late();
		if (!(await peek(x.space, { type: "Intent", fields: { intentId: intent.intentId } }))) break;
	}
	const after = await character(x.space, x.charId);
	await walked(x, before, after);
	const rooms = new Set([before.room, after.room]);
	const msgs = [
		...(await all<MsgFields>(x.space, "Msg", { to: x.charId })),
		...(await Promise.all([...rooms].map((room) => all<MsgFields>(x.space, "Msg", { to: "*", room })))).flat(),
	].filter((m) => m.at >= t0).sort((a, b) => a.at - b.at);
	const text = (m: MsgFields) => (m.actor ? render(m.text, { viewer: x.charId, actor: m.actor, actorName: m.from }) : m.text);
	return { said: [...new Set(msgs.map(text))].slice(0, 20), at: { room: after.room, x: after.x, y: after.y } };
}

/** The cells from `before` to `after` onto the world's trail: a step in the room the shortest walk around its fires
 *  (as `move` checks it), a change of room the walk to the exit that leads there and the cell it arrives on. */
async function walked(x: World, before: { room: string; x: number; y: number }, after: { room: string; x: number; y: number }): Promise<void> {
	if (before.room === after.room && before.x === after.x && before.y === after.y) return;
	const rooms = x.w.allRooms ?? x.w.rooms, roomOf = (id: string) => rooms.find((r) => r.roomId === id);
	const walk = async (room: string, from: { x: number; y: number }, to: { x: number; y: number }) => {
		const r = roomOf(room), there: Step = [room, to.x, to.y];
		if (!r) return [there];
		const cells = findPath(x.w, r.ground, from, to, 400, await blockedIn(x.space, x.w, room)) ?? findPath(x.w, r.ground, from, to, 400);
		return cells ? cells.map((c): Step => [room, c.x, c.y]) : [there];
	};
	const add = (steps: Step[]) => {
		for (const s of steps) {
			const last = x.trail.at(-1);
			if (last && last[0] === s[0] && last[1] === s[1] && last[2] === s[2]) continue;
			if (x.trail.length >= MAX_TRAIL) return;
			x.trail.push(s);
		}
	};
	if (before.room === after.room) return add(await walk(before.room, before, after));
	const exit = x.w.exits.find((e) => e.room === before.room && e.destination === after.room);
	if (exit) add(await walk(before.room, before, exit));
	add([[after.room, after.x, after.y]]);
}

/** The trail as `path` gives it: the start, every cell where the room or the direction changes, the last one; at most
 *  PATH_STEPS (every n-th and the last when there are more). */
export function pathOf(trail: Step[], max = PATH_STEPS): { path: Step[]; cut: boolean } {
	const turns: Step[] = [];
	for (let i = 0; i < trail.length; i++) {
		const s = trail[i]!, prev = trail[i - 1], next = trail[i + 1];
		if (!prev || !next || prev[0] !== s[0] || next[0] !== s[0] || next[1] - s[1] !== s[1] - prev[1] || next[2] - s[2] !== s[2] - prev[2]) turns.push(s);
	}
	if (turns.length <= max) return { path: turns, cut: false };
	const n = Math.ceil((turns.length - 1) / (max - 1)), out: Step[] = [];
	for (let i = 0; i < turns.length - 1; i += n) out.push(turns[i]!);
	out.push(turns.at(-1)!);
	return { path: out, cut: true };
}

/** One room's geometry for the page that draws the paths (codemode-chat imports nothing from here). */
export function roomMap(w: WorldDef, id: string) {
	const r = (w.allRooms ?? w.rooms).find((x) => x.roomId === id);
	if (!r) throw new Error(`no room ${id}`);
	const keys = new Set(r.ground.join(""));
	const out = {
		world: w.id, room: r.roomId, name: r.name, ...(r.island ? { island: r.island } : {}), ...(r.map ? { map: r.map } : {}),
		ground: r.ground, ...(r.decor ? { decor: r.decor } : {}),
		walk: Object.fromEntries([...keys].sort().map((k) => [k, !!w.tiles[k]?.walk])),
		exits: w.exits.filter((e) => e.room === r.roomId).map((e) => ({ name: e.name, x: e.x, y: e.y, to: e.destination })),
		fires: w.beacons.filter((b) => b.room === r.roomId).map((b) => ({ beaconId: b.beaconId, x: b.x, y: b.y })),
	};
	return { ...out, rev: createHash("sha256").update(JSON.stringify(out)).digest("hex").slice(0, 16) };
}

export async function wait(x: World, minutes: number): Promise<{ time: string }> {
	const m = Math.floor(Number(minutes));
	if (!Number.isFinite(m) || m < 1 || m > MAX_WAIT_MINUTES) throw new Error(`wait takes 1 to ${MAX_WAIT_MINUTES} minutes`);
	if (x.waited + m > MAX_WAITED_MINUTES) throw new Error(`a bot may wait at most ${MAX_WAITED_MINUTES} world minutes in all`);
	x.waited += m;
	const c = await moveClock(x.space, (c) => ({ ...c, worldAnchorMs: c.worldAnchorMs + m * WORLD_MINUTE_MS }));
	await new Promise((r) => setTimeout(r, 300)); // the world's ticks see the new time
	return { time: formatWorldTime(worldNow(c)) };
}

/** Whether the figure reached `goal` and, with `hold`, still has it after that many world minutes: the judge's own
 *  wait, not counted against the bot's (a goal reached at the last moment must hold, docs/codemode-planung.en.md). */
export async function score(x: World, goal: string, hold = 0): Promise<{ done: boolean; detail: string }> {
	const h = Number(hold);
	if (!h) return scoreNow(x, goal);
	if (!Number.isInteger(h) || h < 1 || h > MAX_WAIT_MINUTES) throw new Error(`hold takes 1 to ${MAX_WAIT_MINUTES} minutes`);
	const first = await scoreNow(x, goal);
	if (!first.done) return first;
	await moveClock(x.space, (c) => ({ ...c, worldAnchorMs: c.worldAnchorMs + h * WORLD_MINUTE_MS }));
	await new Promise((r) => setTimeout(r, 300)); // the world's ticks see the new time
	const later = await scoreNow(x, goal);
	return later.done ? { done: true, detail: `${later.detail}; held ${h} world minutes` } : { done: false, detail: `reached, but not held ${h} world minutes: ${later.detail}` };
}
async function scoreNow(x: World, goal: string): Promise<{ done: boolean; detail: string }> {
	const f = /^feed:([\w-]+):(\d+)$/.exec(String(goal));
	if (f) {
		const c = await x.space.readIfExists({ type: "Contribution", fields: { beaconId: f[1]!, charId: x.charId } as never }, NO_WAIT);
		const pieces = c ? Number((c.fields as Record<string, unknown>).pieces ?? 0) : 0, want = Number(f[2]);
		return { done: pieces >= want, detail: `${pieces} of ${want} pieces put into ${f[1]}, ${x.waited} world minutes waited` };
	}
	const m = /^beacon:([\w-]+)$/.exec(String(goal));
	if (!m) throw new Error(`unknown goal ${goal}`);
	const clock = await readClockOf(x.space), lit = isLit(await flameOf(x.space, m[1]!), worldNow(clock));
	const fed = !!(await x.space.readIfExists({ type: "Contribution", fields: { beaconId: m[1]!, charId: x.charId } as never }, NO_WAIT));
	return { done: lit && fed, detail: `${m[1]} ${lit ? "burns" : "is out"}, ${fed ? "fed by the bot" : "not fed by the bot"}, ${x.waited} world minutes waited` };
}

// ---- the server -------------------------------------------------------------------------------------------------
/** The longest a kept world waits for its judge. */
const MAX_KEEP_MS = 3600_000;

export async function startArena(o: { listen?: string; worlds?: number; /** tests: the idle time */ idleMs?: number } = {}) {
	const idle = o.idleMs ?? IDLE_MS;
	const w = await loadWorld();
	const worlds = new Map<string, World>(), max = o.worlds ?? MAX_WORLDS;
	let starting = 0;
	const waiting: Array<() => void> = [];
	const free = () => { const next = waiting.shift(); if (next) next(); };
	const slot = () => new Promise<void>((ok, fail) => {
		if (worlds.size + starting < max) { starting++; return ok(); }
		const t = setTimeout(() => { const i = waiting.indexOf(go); if (i >= 0) waiting.splice(i, 1); fail(new Error("the arena is busy")); }, 120_000);
		const go = () => { clearTimeout(t); starting++; ok(); };
		waiting.push(go);
	});
	const close = async (id: string) => { const x = worlds.get(id); if (!x) return; worlds.delete(id); await closeWorld(x).catch(() => {}); free(); };
	const sweep = setInterval(() => { for (const [id, x] of worlds) if (Date.now() - x.touched > (x.idleMs ?? idle)) void close(id); }, Math.min(10_000, Math.max(100, idle / 2)));
	sweep.unref();

	const handle = async (sock: Socket, r: Record<string, unknown>): Promise<Record<string, unknown>> => {
		if (r.op === "open") {
			await slot();
			try {
				const x = await openWorld(w, r.keep === true ? null : sock, openSpec(w, r));
				if (r.keep === true && typeof r.idleMs === "number" && Number.isFinite(r.idleMs)) x.idleMs = Math.min(MAX_KEEP_MS, Math.max(idle, r.idleMs));
				worlds.set(x.id, x);
				return { world: x.id, charId: x.charId, name: x.name };
			} finally { starting--; if (worlds.size + starting < max) free(); }
		}
		if (r.op === "map") return roomMap(w, String(r.room ?? ""));
		const x = worlds.get(String(r.world));
		if (!x) throw new Error("no such world");
		x.touched = Date.now();
		const once = (run: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> => {
			if (typeof r.key !== "string" || !r.key) return run();
			const had = x.done.get(r.key);
			if (had) return had;
			if (x.done.size >= MAX_KEYS) x.done.delete(x.done.keys().next().value!);
			const p = run();
			x.done.set(r.key, p);
			return p;
		};
		switch (r.op) {
			case "look": return await once(() => look(w, x));
			case "act": return await once(() => act(x, String(r.line ?? "")));
			case "wait": return await once(() => wait(x, Number(r.minutes)));
			case "score": return await score(x, String(r.goal ?? ""), Number(r.hold ?? 0));
			case "path": return pathOf(x.trail);
			case "close": await close(x.id); return {};
			default: throw new Error(`unknown op ${String(r.op)}`);
		}
	};

	const socks = new Set<Socket>();
	const server = createServer((sock) => {
		socks.add(sock);
		let buf = "";
		sock.setEncoding("utf8");
		sock.on("data", (d: string) => {
			buf += d;
			if (buf.length > 1 << 20) { sock.destroy(); return; }
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const text = buf.slice(0, i); buf = buf.slice(i + 1);
				let r: Record<string, unknown>;
				try { r = JSON.parse(text); } catch { sock.write(`${JSON.stringify({ id: null, ok: false, error: "not JSON" })}\n`); continue; }
				handle(sock, r).then(
					(v) => { if (!sock.destroyed) sock.write(`${JSON.stringify({ id: r.id, ok: true, ...v })}\n`); },
					(e) => { if (!sock.destroyed) sock.write(`${JSON.stringify({ id: r.id, ok: false, error: (e as Error).message.slice(0, 500) })}\n`); },
				);
			}
		});
		// a judge that goes away takes its worlds along
		sock.on("close", () => { socks.delete(sock); for (const [id, x] of worlds) if (x.owner === sock) void close(id); });
		sock.on("error", () => {});
	});
	const listen = o.listen ?? LISTEN;
	await new Promise<void>((ok, fail) => {
		server.once("error", fail);
		if (listen.startsWith("unix:")) { rmSync(listen.slice(5), { force: true }); server.listen(listen.slice(5), () => ok()); }
		else { const m = /^tcp:(.+):(\d+)$/.exec(listen); if (!m) return fail(new Error(`SPACES_MMO_ARENA_LISTEN: unix:/path or tcp:host:port, not ${listen}`)); server.listen(Number(m[2]), m[1], () => ok()); }
	});
	return {
		listen, worlds: () => worlds.size,
		async close() { clearInterval(sweep); const shut = new Promise<void>((r) => server.close(() => r())); for (const s of socks) s.destroy(); await shut; await Promise.all([...worlds.keys()].map(close)); },
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const a = await startArena();
	console.log(`[arena] ready on ${a.listen}, ${MAX_WORLDS} worlds at a time`);
	const bye = async () => { await a.close(); process.exit(0); };
	process.on("SIGTERM", () => void bye());
	process.on("SIGINT", () => void bye());
}
