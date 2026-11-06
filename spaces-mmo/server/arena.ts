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
//   open {}                         → { world, charId, name }      (waits for a free slot)
//   look { world }                  → what the figure sees: its room, place, exits, things, fires, pack, the time
//   act { world, line }             → { said: string[], at }        the line as a player types it, done when the
//                                                                    world worker has carried it out
//   wait { world, minutes }         → { time }                      the clock moves on (it stands still otherwise)
//   score { world, goal }           → { done, detail }              goal "beacon:<beaconId>": the figure lit it
//   close { world }                 → {}
// A world is closed when its connection ends or nobody asks it anything for SPACES_MMO_ARENA_IDLE_MS (default 5 min).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { Accounts } from "./accounts.ts";
import { ROOT } from "./env.ts";
import { actorToken, asFields, fieldsOf, type BeaconFields, type CharacterFields, type ExitFields, type IntentFields, type ItemFields, type MsgFields, type WorldClockFields } from "./model.ts";
import { connectSpace, peek } from "./space.ts";
import { spaceServer } from "./space-server.ts";
import { loadWorld, type WorldDef } from "./engine/world.ts";
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

type World = {
	id: string; dir: string; procs: ChildProcess[]; conns: Array<{ close(): void }>;
	space: SpaceLike; charId: string; name: string; waited: number; touched: number; owner: Socket | null;
};

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

async function openWorld(w: WorldDef, owner: Socket | null): Promise<World> {
	const dir = mkdtempSync(join(tmpdir(), "mmo-arena-")), world = `unix:${join(dir, "world.sock")}`, accounts = `unix:${join(dir, "accounts.sock")}`;
	const procs: ChildProcess[] = [], conns: Array<{ close(): void }> = [];
	const quiet = { SPACES_MMO_LLM: "", SPACES_MMO_NPCS: "", SPACES_MMO_REGION: "", SPACES_MMO_REGIONS: "", SPACES_MMO_SPACES: "" };
	try {
		procs.push(await run("server/space-host.ts", { ...quiet, SPACES_MMO_LISTEN: world, SPACES_MMO_ACCOUNTS_LISTEN: accounts, SPACES_MMO_MEM: "1", SPACES_MMO_DATA: "" }, "[space] ready"));
		procs.push(await run("server/world-host.ts", { ...quiet, SPACES_MMO_SPACE: world }, "[world] ready"));
		const ws = connectSpace(world), as = connectSpace(accounts);
		conns.push(ws, as);
		const me = await new Accounts(ws.space, as.space, w).createGuest();
		await pauseClock(ws.space);
		await toSpawn(w, ws.space, me.charId);
		const ch = await character(ws.space, me.charId);
		return { id: randomBytes(6).toString("hex"), dir, procs, conns, space: ws.space, charId: me.charId, name: ch.name, waited: 0, touched: Date.now(), owner };
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

/** The guest onto its room's spawn cell: a new figure is scattered around it at random, and a bot should start where
 *  every other bot starts (the spawn is kept free in the world's definition). */
async function toSpawn(w: WorldDef, space: SpaceLike, charId: string): Promise<void> {
	const txn = (await space.createTransaction(10_000)).id;
	try {
		const t = await space.take({ type: "Character", fields: { charId } }, 5_000, { txn });
		if (!t) throw new Error("the figure is gone");
		const ch = fieldsOf<CharacterFields>(t), room = (w.allRooms ?? w.rooms).find((r) => r.roomId === ch.room);
		await space.write({ type: "Character", fields: asFields({ ...ch, ...(room ? { x: room.spawn.x, y: room.spawn.y } : {}) }) }, txn, FOREVER);
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
	const rooms = new Set([before.room, after.room]);
	const msgs = [
		...(await all<MsgFields>(x.space, "Msg", { to: x.charId })),
		...(await Promise.all([...rooms].map((room) => all<MsgFields>(x.space, "Msg", { to: "*", room })))).flat(),
	].filter((m) => m.at >= t0).sort((a, b) => a.at - b.at);
	const text = (m: MsgFields) => (m.actor ? render(m.text, { viewer: x.charId, actor: m.actor, actorName: m.from }) : m.text);
	return { said: [...new Set(msgs.map(text))].slice(0, 20), at: { room: after.room, x: after.x, y: after.y } };
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

/** Whether the figure reached `goal`. "beacon:<beaconId>": the fire burns now and the figure fed it. */
export async function score(x: World, goal: string): Promise<{ done: boolean; detail: string }> {
	const m = /^beacon:([\w-]+)$/.exec(String(goal));
	if (!m) throw new Error(`unknown goal ${goal}`);
	const clock = await readClockOf(x.space), lit = isLit(await flameOf(x.space, m[1]!), worldNow(clock));
	const fed = !!(await x.space.readIfExists({ type: "Contribution", fields: { beaconId: m[1]!, charId: x.charId } as never }, NO_WAIT));
	return { done: lit && fed, detail: `${m[1]} ${lit ? "burns" : "is out"}, ${fed ? "fed by the bot" : "not fed by the bot"}, ${x.waited} world minutes waited` };
}

// ---- the server -------------------------------------------------------------------------------------------------
export async function startArena(o: { listen?: string; worlds?: number } = {}) {
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
	const sweep = setInterval(() => { for (const [id, x] of worlds) if (Date.now() - x.touched > IDLE_MS) void close(id); }, 10_000);
	sweep.unref();

	const handle = async (sock: Socket, r: Record<string, unknown>): Promise<Record<string, unknown>> => {
		if (r.op === "open") {
			await slot();
			try {
				const x = await openWorld(w, sock);
				worlds.set(x.id, x);
				return { world: x.id, charId: x.charId, name: x.name };
			} finally { starting--; if (worlds.size + starting < max) free(); }
		}
		const x = worlds.get(String(r.world));
		if (!x) throw new Error("no such world");
		x.touched = Date.now();
		switch (r.op) {
			case "look": return await look(w, x);
			case "act": return await act(x, String(r.line ?? ""));
			case "wait": return await wait(x, Number(r.minutes));
			case "score": return await score(x, String(r.goal ?? ""));
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
