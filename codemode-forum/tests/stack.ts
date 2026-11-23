// The processes a test needs, started as real OS processes: the space (in memory, or on a SQLite file to survive a
// restart) on a socket of its own, an agents process and a model process with the fake models of tests/fakes.ts and a checker
// process (a sources process when a test starts one). The
// web part runs in the test process (startServer); it reaches the space over the socket like in production. close()
// stops them all. Taken over from codemode-chat/tests/stack.ts.
import { spaceServer } from "../server/space-server.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startServer as startWeb } from "../server/index.ts";
import { connectSpace } from "../server/space.ts";
import type { SpaceLike } from "phi-spaces";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let seq = 0;

function run(file: string, env: Record<string, string>, ready: (line: string) => boolean): Promise<ChildProcess> {
	return new Promise((ok, fail) => {
		const server = file === "server/space-host.ts" ? spaceServer() : null;
		const child = spawn(server?.command ?? process.execPath, server?.args ?? ["--no-warnings", "--experimental-strip-types", file], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "", done = false;
		const timer = setTimeout(() => { if (!done) { done = true; child.kill("SIGKILL"); fail(new Error(`${file} did not start:\n${out}`)); } }, 20_000);
		const seen = (d: Buffer) => { out += d.toString(); if (!done && out.split("\n").some(ready)) { done = true; clearTimeout(timer); ok(child); } };
		child.stdout?.on("data", seen);
		child.stderr?.on("data", (d: Buffer) => { out += d.toString(); if (process.env.STACK_LOG) process.stderr.write(d); });
		child.on("exit", (code) => { if (!done) { done = true; clearTimeout(timer); fail(new Error(`${file} exited (${code}):\n${out}`)); } });
	});
}
const stop = (c: ChildProcess, sig: NodeJS.Signals = "SIGTERM") => new Promise<void>((r) => { if (c.exitCode !== null || c.signalCode !== null) return r(); c.once("exit", () => r()); c.kill(sig); });

export type Stack = {
	spec: string; space: SpaceLike;
	/** Starts one more model process (`fakes`: the fake models of tests/fakes.ts, or the names of some of them). */
	model(o?: { fakes?: boolean | string[] }): Promise<ChildProcess>;
	/** Starts one more agents process. */
	agents(o?: { leaseMs?: number; replyWaitS?: number; turnWaitS?: number; personWaitS?: number }): Promise<ChildProcess>;
	/** Starts one more sources process (`repos`: FORUM_REPOS; `pause`: a marker file, see holdBeforeAnswer). */
	sources(o?: { repos?: string; leaseMs?: number; pause?: string }): Promise<ChildProcess>;
	/** Starts one more checker process. */
	checker(): Promise<ChildProcess>;
	/** Stops the space process and starts it again on the same socket (and the same file, if it has one). */
	restartSpace(): Promise<void>;
	/** Stops a process: SIGTERM, or SIGKILL to make it die in the middle of its work. */
	kill(c: ChildProcess, sig?: NodeJS.Signals): Promise<void>;
	close(): Promise<void>;
};

/** A space process (SQLite at `dbPath`, else in memory), an agents process and a model process (the fake models unless
 *  `fakes` is false: then the real ones, which are off in the tests). */
export async function startStack(o: { dbPath?: string; agents?: boolean; model?: boolean; checker?: boolean; fakes?: boolean | string[] } = {}): Promise<Stack> {
	const sock = `/tmp/forum-test-${process.pid}-${seq++}.sock`, spec = `unix:${sock}`;
	const startSpace = () => run("server/space-host.ts", { FORUM_LISTEN: spec, ...(o.dbPath ? { FORUM_SQLITE: o.dbPath, FORUM_MEM: "" } : { FORUM_MEM: "1" }) }, (l) => l.startsWith("[space] ready"));
	let space = await startSpace();
	const conn = connectSpace(spec);
	const others: ChildProcess[] = [];
	const stack: Stack = {
		spec, space: conn.space,
		async model(m = {}) {
			const c = await run("server/model-host.ts", { FORUM_SPACE: spec, FORUM_HOST_NAME: "", ...(m.fakes ? { FORUM_TEST: "1", FORUM_LLM_MODULE: "tests/fakes.ts", FORUM_FAKE_MODELS: Array.isArray(m.fakes) ? m.fakes.join(",") : "" } : {}) }, (l) => l.startsWith("[model]"));
			others.push(c);
			return c;
		},
		async agents(a = {}) {
			const c = await run("server/agent-host.ts", { FORUM_SPACE: spec, FORUM_HOST_NAME: "", ...(a.leaseMs ? { FORUM_AGENT_LEASE_MS: String(a.leaseMs) } : {}), ...(a.replyWaitS !== undefined ? { FORUM_REPLY_WAIT_S: String(a.replyWaitS) } : {}), ...(a.turnWaitS !== undefined ? { FORUM_TURN_WAIT_S: String(a.turnWaitS) } : {}), FORUM_PERSON_WAIT_S: String(a.personWaitS ?? 0) }, (l) => l.startsWith("[agents]"));
			others.push(c);
			return c;
		},
		async sources(x = {}) {
			const c = await run("server/source-host.ts", { FORUM_SPACE: spec, FORUM_HOST_NAME: "", FORUM_REPOS: x.repos ?? "", ...(x.leaseMs ? { FORUM_SOURCE_LEASE_MS: String(x.leaseMs) } : {}), ...(x.pause ? { FORUM_TEST: "1", FORUM_TEST_SOURCE_PAUSE: x.pause } : {}) }, (l) => l.startsWith("[sources]"));
			others.push(c);
			return c;
		},
		async checker() {
			const c = await run("server/check-host.ts", { FORUM_SPACE: spec, FORUM_HOST_NAME: "" }, (l) => l.startsWith("[checker]"));
			others.push(c);
			return c;
		},
		async restartSpace() { await stop(space); space = await startSpace(); },
		kill: (c, sig) => stop(c, sig),
		async close() { await Promise.all(others.map((c) => stop(c))); conn.close(); await stop(space); await rm(sock, { force: true }); },
	};
	if (o.checker !== false && o.model !== false) await stack.checker();
	if (o.agents !== false) await stack.agents();
	if (o.model !== false) await stack.model({ fakes: o.fakes ?? true });
	return stack;
}

/** The web part on a stack: a stack of its own (closed with it) unless `stack` is given. */
export async function startServer(o: Parameters<typeof startWeb>[0] & { stack?: Stack; dbPath?: string; fakes?: boolean | string[] } = {}) {
	const { stack: given, dbPath, fakes, ...web } = o;
	const stack = given ?? (await startStack({ ...(dbPath ? { dbPath } : {}), ...(fakes !== undefined ? { fakes } : {}) }));
	const srv = await startWeb({ port: 0, ...web, space: stack.spec });
	return { ...srv, stack, async close() { await srv.close(); if (!given) await stack.close(); } };
}
