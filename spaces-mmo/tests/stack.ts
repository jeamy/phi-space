// The processes a test needs, started as real OS processes: the space process (in memory, or on SQLite files to survive
// a restart) and world workers. The web part runs in the test process (startServer, startWeb) and reaches the spaces over
// the sockets like in production. Player is a small client: HTTP with a cookie jar and the game WebSocket.
//
// Another implementation of a process (docs/rust-portierung.en.md, R8.0 item 6): SPACES_MMO_WORLD_CMD, SPACES_MMO_NPC_CMD
// and SPACES_MMO_WEB_CMD name the program and its arguments (split at spaces; a first word with a slash is a path from
// spaces-mmo/), SPACES_MMO_SPACE_SERVER the space server (server/space-server.ts). With SPACES_MMO_WEB_CMD the web part
// is a process too: its options go to it as the environment variables they stand for. A program that is not there ends
// the test; it never falls back to the TypeScript process.
import { spaceServer } from "../server/space-server.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { ClientFrame, ServerFrame } from "../server/gateway.ts";
import { startServer as startInProcess } from "../server/index.ts";
import type { Accounts } from "../server/accounts.ts";
import { connectSpace } from "../server/space.ts";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { readClock } from "../server/engine/clock.ts";
import { loadWorld } from "../server/engine/world.ts";
import { worldNow } from "../server/engine/worldtime.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let seq = 0;

/** `npm run test:durable`: an agent store per model process (it holds the NPC dialogues), kept for the process that takes its place (the store has an
 *  owner lock); `key` names the stack or region. Removed when the test process ends. */
const npcStores = new Map<string, Array<ChildProcess | null>>();
let durableDir: string | null = null;
async function withAgentStore(key: string, start: (env: Record<string, string>) => Promise<ChildProcess>): Promise<ChildProcess> {
	if (process.env.SPACES_MMO_DURABLE_MATRIX !== "1") return start({});
	if (!durableDir) {
		const dir = durableDir = mkdtempSync(join(tmpdir(), "mmo-durable-"));
		process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
	}
	const slots = npcStores.get(key) ?? [], free = slots.findIndex((c) => !c || c.exitCode !== null || c.signalCode !== null);
	const slot = free < 0 ? slots.length : free;
	slots[slot] = null; npcStores.set(key, slots);
	return (slots[slot] = await start({ SPACES_MMO_DURABLE_STORE: join(durableDir, `${encodeURIComponent(key)}-${slot}.sqlite`) }));
}

/** Waits are for what must come, so they may be long: a machine shared with other work stalls for many seconds, and a wait
 *  that is too short only says so. Only a failing test waits them out. */
const PATIENCE = Number(process.env.STACK_PATIENCE ?? 3);

const COMMANDS: Record<string, string> = { "server/world-host.ts": "SPACES_MMO_WORLD_CMD", "server/npc-host.ts": "SPACES_MMO_NPC_CMD", "server/index.ts": "SPACES_MMO_WEB_CMD" };
/** Mixed operation (R8.3): with SPACES_MMO_WORLD_MIXED=1 every second world worker a test starts is the TypeScript one,
 *  the others SPACES_MMO_WORLD_CMD's program (in startRegions the regions alternate, so a ferry goes between the two). */
let worldsStarted = 0;
/** The same for npc processes (R8.4): with SPACES_MMO_NPC_MIXED=1 every second npc process is the TypeScript one, so the
 *  two share the roles of a world (claimed under the NPC lock, never one played twice). */
let npcsStarted = 0;
/** The program of a process: the one its variable names, else `file` on this node. */
export function programOf(file: string, env: Readonly<Record<string, string | undefined>> = process.env): { command: string; args: string[] } {
	if (file === "server/space-host.ts") return spaceServer(env) ?? { command: process.execPath, args: ["--no-warnings", "--experimental-strip-types", file] };
	if (file === "server/world-host.ts" && env.SPACES_MMO_WORLD_MIXED === "1" && worldsStarted++ % 2 === 1) return { command: process.execPath, args: ["--no-warnings", "--experimental-strip-types", file] };
	if (file === "server/npc-host.ts" && env.SPACES_MMO_NPC_MIXED === "1" && npcsStarted++ % 2 === 1) return { command: process.execPath, args: ["--no-warnings", "--experimental-strip-types", file] };
	const name = COMMANDS[file], words = name ? (env[name]?.trim().split(/\s+/).filter(Boolean) ?? []) : [];
	if (!words.length) return { command: process.execPath, args: ["--no-warnings", "--experimental-strip-types", file] };
	const [first, ...args] = words as [string, ...string[]];
	const command = first.includes("/") ? resolve(ROOT, first) : first;
	if (first.includes("/") && !existsSync(command)) throw new Error(`${name}: no such program: ${command}`);
	return { command, args };
}
/** The web part runs as a process of its own (SPACES_MMO_WEB_CMD). */
export const WEB_PROCESS = !!process.env.SPACES_MMO_WEB_CMD?.trim();

function run(file: string, env: Record<string, string>, ready: (line: string) => boolean): Promise<ChildProcess> {
	return new Promise((ok, fail) => {
		const program = programOf(file);
		const child = spawn(program.command, program.args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "", done = false;
		const timer = setTimeout(() => { if (!done) { done = true; child.kill("SIGKILL"); fail(new Error(`${file} did not start:\n${out}`)); } }, 120_000);
		const seen = (d: Buffer) => { out += d.toString(); if (!done && out.split("\n").some(ready)) { done = true; clearTimeout(timer); ok(child); } };
		child.stdout?.on("data", seen);
		child.stderr?.on("data", (d: Buffer) => { out += d.toString(); if (process.env.STACK_LOG) process.stderr.write(d); });
		child.on("exit", (code) => { if (!done) { done = true; clearTimeout(timer); fail(new Error(`${file} exited (${code}):\n${out}`)); } });
	});
}
const freePort = () => new Promise<number>((ok, fail) => {
	const s = createServer();
	s.once("error", fail);
	s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); });
});
const stop = (c: ChildProcess, sig: NodeJS.Signals = "SIGTERM") => new Promise<void>((r) => { if (c.exitCode !== null || c.signalCode !== null) return r(); c.once("exit", () => r()); c.kill(sig); });

export type Stack = {
	world: string; accounts: string; space: SpaceLike;
	/** The world workers started so far (the first one by startStack). */
	worlds: ChildProcess[];
	/** Kills the space process and starts it again on the same sockets (and the same files, with `dataDir`). */
	restartSpace(): Promise<void>;
	/** Starts one more world worker (`env`: e.g. a short cleanup interval). */
	worldProcess(env?: Record<string, string>): Promise<ChildProcess>;
	/** Starts the npc process (the world's scripted characters); with model calls on, the first one brings a model process. */
	npcProcess(env?: Record<string, string>): Promise<ChildProcess>;
	/** Starts the model process (translations and what model NPCs say; model calls follow SPACES_MMO_LLM in `env` or the stack's worldEnv). */
	modelProcess(env?: Record<string, string>): Promise<ChildProcess>;
	/** Starts a web process without Next (to kill it in the middle of play); its URL comes with it. */
	webProcess(env?: Record<string, string>, port?: number): Promise<{ child: ChildProcess; url: string; port: number }>;
	kill(c: ChildProcess, sig?: NodeJS.Signals): Promise<void>;
	close(): Promise<void>;
};

/** A space process (SQLite files in `dataDir`, else in memory) and `worlds` world workers (default one). */
export async function startStack(o: { dataDir?: string; worldEnv?: Record<string, string>; worlds?: number } = {}): Promise<Stack> {
	const base = `/tmp/mmo-test-${process.pid}-${seq++}`, world = `unix:${base}-world.sock`, accounts = `unix:${base}-accounts.sock`;
	const startSpace = () => run("server/space-host.ts", { SPACES_MMO_LISTEN: world, SPACES_MMO_ACCOUNTS_LISTEN: accounts, ...(o.dataDir ? { SPACES_MMO_DATA: o.dataDir, SPACES_MMO_MEM: "" } : { SPACES_MMO_MEM: "1" }) }, (l) => l.startsWith("[space] ready"));
	let spaceProc = await startSpace();
	const conn = connectSpace(world);
	const procs: ChildProcess[] = [], models: ChildProcess[] = [];
	const stack: Stack = {
		world, accounts, space: conn.space, worlds: [],
		async restartSpace() {
			await stop(spaceProc, "SIGKILL");
			await rm(`${base}-world.sock`, { force: true }); await rm(`${base}-accounts.sock`, { force: true });
			spaceProc = await startSpace();
		},
		async worldProcess(env = {}) {
			const c = await run("server/world-host.ts", { SPACES_MMO_SPACE: world, ...o.worldEnv, ...env }, (l) => l.startsWith("[world] ready"));
			procs.push(c); stack.worlds.push(c);
			return c;
		},
		async npcProcess(env = {}) {
			// a model NPC asks the model process (server/model-npc.ts): the first npc process with model calls on brings one
			const all: Record<string, string> = { SPACES_MMO_SPACE: world, ...o.worldEnv, ...env };
			if (all.SPACES_MMO_LLM === "1" && !models.some((m) => m.exitCode === null && m.signalCode === null)) await stack.modelProcess(env);
			const c = await run("server/npc-host.ts", all, (l) => l.startsWith("[npc] ready"));
			procs.push(c);
			return c;
		},
		async modelProcess(env = {}) {
			const c = await withAgentStore(`${base}-model`, (store) => run("server/model-host.ts", { SPACES_MMO_SPACE: world, ...store, ...o.worldEnv, ...env }, (l) => l.startsWith("[model] ready")));
			procs.push(c); models.push(c);
			return c;
		},
		async webProcess(env = {}, port) {
			port ??= await freePort();
			const c = await run("server/index.ts", { SPACES_MMO_SPACE: world, SPACES_MMO_ACCOUNTS: accounts, SPACES_MMO_NO_NEXT: "1", PORT: String(port), ...env }, (l) => l.startsWith("[web]"));
			procs.push(c);
			return { child: c, url: `http://127.0.0.1:${port}`, port };
		},
		kill: (c, sig) => stop(c, sig),
		async close() { await Promise.all(procs.map((c) => stop(c))); conn.close(); await stop(spaceProc); await rm(`${base}-world.sock`, { force: true }); await rm(`${base}-accounts.sock`, { force: true }); },
	};
	// a world that does not start must not leave the space behind: its child would keep this test file alive for good
	try { for (let i = 0; i < (o.worlds ?? 1); i++) await stack.worldProcess(); } catch (e) { await stack.close(); throw e; }
	return stack;
}

/** The world split into its regions (engine/regions.ts): per region a space process and a world worker, an accounts
 *  space, and the address list (SPACES_MMO_REGIONS) every process gets. */
export async function startRegions(o: { worldEnv?: Record<string, string>; workers?: boolean; dataDir?: string } = {}) {
	const base = `/tmp/mmo-test-${process.pid}-${seq++}`, accounts = `unix:${base}-accounts.sock`;
	const w = await loadWorld("leuchtfeuer");
	const ids = (w.regions ?? []).map((g) => g.regionId);
	const addr = (id: string) => `unix:${base}-${id}.sock`;
	const list = ids.map((id) => `${id}=${addr(id)}`).join(",");
	const procs: ChildProcess[] = [], models = new Map<string, ChildProcess>();
	const env = (id: string) => ({ SPACES_MMO_SPACE: addr(id), SPACES_MMO_REGION: id, SPACES_MMO_REGIONS: list, ...o.worldEnv });
	const workers = async () => { for (const id of ids) procs.push(await run("server/world-host.ts", env(id), (l) => l.startsWith("[world] ready"))); };
	try {
		procs.push(await run("server/space-host.ts", { SPACES_MMO_SPACES: "accounts", SPACES_MMO_ACCOUNTS_LISTEN: accounts, SPACES_MMO_MEM: "1" }, (l) => l.startsWith("[space] ready")));
		const store: Record<string, string> = o.dataDir ? { SPACES_MMO_DATA: o.dataDir, SPACES_MMO_MEM: "" } : { SPACES_MMO_MEM: "1" };
		for (const id of ids) procs.push(await run("server/space-host.ts", { SPACES_MMO_SPACES: "world", SPACES_MMO_LISTEN: addr(id), SPACES_MMO_REGION: id, ...store }, (l) => l.startsWith("[space] ready")));
		if (o.workers !== false) await workers();
	} catch (e) { await Promise.all(procs.map((c) => stop(c))); throw e; }
	const conns = new Map(ids.map((id) => [id, connectSpace(addr(id))]));
	return {
		ids, accounts, list, space: (id: string) => conns.get(id)!.space,
		/** The world workers, one per region (started already unless `workers: false`). */
		workers,
		/** One world worker of the region `id` with `extra` over its environment (rejects when it ends before ready). */
		async worldProcess(id: string, extra: Record<string, string> = {}) { const c = await run("server/world-host.ts", { ...env(id), ...extra }, (l) => l.startsWith("[world] ready")); procs.push(c); return c; },
		async npcProcess(id: string, extra: Record<string, string> = {}) {
			// as in startStack: model NPCs ask the region's model process, started with the first of its npc processes
			const all: Record<string, string> = { ...env(id), ...extra };
			if (all.SPACES_MMO_LLM === "1" && !models.has(id)) models.set(id, await withAgentStore(`${base}-${id}-model`, (store) => run("server/model-host.ts", { ...store, ...all }, (l) => l.startsWith("[model] ready"))).then((c) => (procs.push(c), c)));
			const c = await run("server/npc-host.ts", all, (l) => l.startsWith("[npc] ready")); procs.push(c); return c;
		},
		async close() { for (const c of conns.values()) c.close(); await Promise.all(procs.reverse().map((c) => stop(c))); for (const id of [...ids, "accounts"]) await rm(`${base}-${id}.sock`, { force: true }); },
	};
}

type WebOptions = Parameters<typeof startInProcess>[0];
/** A web part: `server/index.ts`'s startServer in this process, or with SPACES_MMO_WEB_CMD that program as a process
 *  (only the API, the assets and the game socket, like SPACES_MMO_NO_NEXT=1). `accounts` is there only in this process. */
export async function startWeb(o: WebOptions = {}): Promise<{ url: string; port: number; accounts?: Accounts; close(): Promise<void> }> {
	if (!WEB_PROCESS) return startInProcess(o);
	if (o.useNext || o.dev) throw new Error("SPACES_MMO_WEB_CMD: a web process of a test serves no pages");
	const a = o.accountOptions ?? {}, port = o.port || await freePort();
	// the exported page (server/pages.ts) as the web process serves it in production; else no page at all
	const env: Record<string, string> = { ...(o.pages ? { SPACES_MMO_PAGES: o.pages } : { SPACES_MMO_NO_NEXT: "1" }), PORT: String(port), ...(o.bind ? { SPACES_MMO_BIND: o.bind } : {}),
		...(o.space ? { SPACES_MMO_SPACE: o.space } : {}), ...(o.accounts ? { SPACES_MMO_ACCOUNTS: o.accounts } : {}), ...(o.regions ? { SPACES_MMO_REGIONS: o.regions } : {}),
		...(o.build !== undefined ? { SPACES_MMO_BUILD_ID: o.build ?? "" } : {}), ...(a.setupToken ? { SPACES_MMO_SETUP_TOKEN: a.setupToken } : {}),
		...(a.guestTtlMs ? { SPACES_MMO_GUEST_TTL_MS: String(a.guestTtlMs) } : {}), ...(a.pendingMs ? { SPACES_MMO_PENDING_MS: String(a.pendingMs) } : {}),
		...(a.webSessionMs ? { SPACES_MMO_WEB_SESSION_MS: String(a.webSessionMs) } : {}) };
	const child = await run("server/index.ts", env, (l) => l.startsWith("[web]"));
	return { url: `http://127.0.0.1:${port}`, port, close: () => stop(child) };
}

/** The web part on a stack: a stack of its own (closed with it) unless `stack` is given. */
export async function startServer(o: WebOptions & { stack?: Stack; dataDir?: string; worldEnv?: Record<string, string> } = {}) {
	const { stack: given, dataDir, worldEnv, ...web } = o;
	const stack = given ?? (await startStack({ ...(dataDir ? { dataDir } : {}), ...(worldEnv ? { worldEnv } : {}) }));
	const srv = await startWeb({ port: 0, ...web, space: stack.world, accounts: stack.accounts }).catch(async (e) => { if (!given) await stack.close(); throw e; });
	return { ...srv, stack, async close() { await srv.close(); if (!given) await stack.close(); } };
}

/** A browser: a cookie jar for the API and the game WebSocket with the frames it received. */
export class Player {
	cookie = "";
	frames: ServerFrame[] = [];
	ws: WebSocket | null = null;
	readonly base: string;
	constructor(base: string) { this.base = base; }

	async post(path: string, body: unknown = {}): Promise<{ status: number; body: any }> {
		const r = await fetch(this.base + path, { method: "POST", headers: { "content-type": "application/json", "x-mmo": "1", ...(this.cookie ? { cookie: this.cookie } : {}) }, body: JSON.stringify(body) });
		const set = r.headers.get("set-cookie");
		if (set) { const v = /mmo_sid=([^;]*)/.exec(set)?.[1] ?? ""; this.cookie = v ? `mmo_sid=${v}` : ""; }
		return { status: r.status, body: await r.json() };
	}
	async me(): Promise<any> {
		return (await fetch(this.base + "/api/me", { headers: this.cookie ? { cookie: this.cookie } : {} })).json();
	}

	/** Opens the game socket (the frames of an earlier one are dropped); resolves with the hello frame. */
	async play(): Promise<Extract<ServerFrame, { t: "hello" }>> {
		this.frames = [];
		const ws = new WebSocket(this.base.replace(/^http/, "ws") + "/ws", { headers: { cookie: this.cookie } } as never);
		this.ws = ws;
		ws.onmessage = (e) => this.frames.push(JSON.parse(String(e.data)));
		await new Promise<void>((ok, fail) => { ws.onopen = () => ok(); ws.onerror = () => fail(new Error("websocket did not open")); });
		return (await this.until((f) => f.t === "hello")) as Extract<ServerFrame, { t: "hello" }>;
	}
	send(line: string, lang?: "en"): void { this.ws!.send(JSON.stringify({ t: "cmd", line, ...(lang ? { lang } : {}) } satisfies ClientFrame)); }
	async leave(): Promise<void> {
		const ws = this.ws; this.ws = null;
		if (!ws || ws.readyState === WebSocket.CLOSED) return;
		await new Promise<void>((r) => { ws.onclose = () => r(); ws.close(); });
	}

	/** The first frame (from `from` on) that satisfies `pred`, waiting up to `ms`. */
	async until(pred: (f: ServerFrame) => boolean, ms = 10_000, from = 0): Promise<ServerFrame> {
		const end = Date.now() + ms * PATIENCE;
		for (;;) {
			const f = this.frames.slice(from).find(pred);
			if (f) return f;
			if (Date.now() > end) throw new Error(`no matching frame within ${ms} ms; said since: ${JSON.stringify(this.frames.slice(from).flatMap((x) => (x.t === "msg" && !/^(?:\[hafen\] Sturmflut|Die Flut spült)/.test(x.m.text) ? [x.m.text] : [])).slice(-30))}; last: ${JSON.stringify(this.frames.slice(-3)).slice(0, 400)}`);
			await new Promise((r) => setTimeout(r, 25));
		}
	}
	/** The last message text containing `text`. */
	async heard(text: string, ms = 10_000): Promise<string> {
		const f = await this.until((f) => f.t === "msg" && f.m.text.includes(text), ms);
		return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
	}
}

/** Waits until `check` returns something truthy (polling), or fails after `ms`. */
export async function eventually<T>(check: () => Promise<T | null | undefined | false>, ms = 10_000, what = "condition"): Promise<T> {
	const end = Date.now() + ms * PATIENCE;
	for (;;) {
		const v = await check();
		if (v) return v;
		if (Date.now() > end) throw new Error(`${what} not reached within ${ms} ms`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

/** A fire that burns for `realMs` of real time (the world's rate turns that into the world time it burns until). */
export async function lightFire(space: SpaceLike, realMs: number, beaconId = "feuer-bucht"): Promise<void> {
	const clock = await readClock(space), now = worldNow(clock);
	await space.write({ type: "Flame", fields: { beaconId, until: now + realMs * clock.rate, litAt: now } as never }, null, FOREVER);
}
