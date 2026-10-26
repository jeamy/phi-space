// The processes a test needs, started as real OS processes: the space process (in memory, or on SQLite files to survive
// a restart) and world workers. The web part runs in the test process (startServer) and reaches the spaces over the
// sockets like in production. Player is a small client: HTTP with a cookie jar and the game WebSocket.
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { ClientFrame, ServerFrame } from "../server/gateway.ts";
import { startServer as startWeb } from "../server/index.ts";
import { connectSpace } from "../server/space.ts";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { readClock } from "../server/engine/clock.ts";
import { worldNow } from "../server/engine/worldtime.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let seq = 0;

function run(file: string, env: Record<string, string>, ready: (line: string) => boolean): Promise<ChildProcess> {
	return new Promise((ok, fail) => {
		const child = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", file], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "", done = false;
		const timer = setTimeout(() => { if (!done) { done = true; child.kill("SIGKILL"); fail(new Error(`${file} did not start:\n${out}`)); } }, 20_000);
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
	/** Starts the npc process (the world's scripted characters). */
	npcProcess(env?: Record<string, string>): Promise<ChildProcess>;
	/** Starts the model process (translations; model calls follow SPACES_MMO_LLM in `env` or the stack's worldEnv). */
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
	const procs: ChildProcess[] = [];
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
			const c = await run("server/npc-host.ts", { SPACES_MMO_SPACE: world, ...o.worldEnv, ...env }, (l) => l.startsWith("[npc] ready"));
			procs.push(c);
			return c;
		},
		async modelProcess(env = {}) {
			const c = await run("server/model-host.ts", { SPACES_MMO_SPACE: world, ...o.worldEnv, ...env }, (l) => l.startsWith("[model] ready"));
			procs.push(c);
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
	for (let i = 0; i < (o.worlds ?? 1); i++) await stack.worldProcess();
	return stack;
}

/** The web part on a stack: a stack of its own (closed with it) unless `stack` is given. */
export async function startServer(o: Parameters<typeof startWeb>[0] & { stack?: Stack; dataDir?: string; worldEnv?: Record<string, string> } = {}) {
	const { stack: given, dataDir, worldEnv, ...web } = o;
	const stack = given ?? (await startStack({ ...(dataDir ? { dataDir } : {}), ...(worldEnv ? { worldEnv } : {}) }));
	const srv = await startWeb({ port: 0, ...web, space: stack.world, accounts: stack.accounts });
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
	send(line: string): void { this.ws!.send(JSON.stringify({ t: "cmd", line } satisfies ClientFrame)); }
	async leave(): Promise<void> {
		const ws = this.ws; this.ws = null;
		if (!ws || ws.readyState === WebSocket.CLOSED) return;
		await new Promise<void>((r) => { ws.onclose = () => r(); ws.close(); });
	}

	/** The first frame (from `from` on) that satisfies `pred`, waiting up to `ms`. */
	async until(pred: (f: ServerFrame) => boolean, ms = 10_000, from = 0): Promise<ServerFrame> {
		const end = Date.now() + ms;
		for (;;) {
			const f = this.frames.slice(from).find(pred);
			if (f) return f;
			if (Date.now() > end) throw new Error(`no matching frame within ${ms} ms; got ${JSON.stringify(this.frames.slice(-8))}`);
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
	const end = Date.now() + ms;
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
