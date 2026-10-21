// The processes a test needs, started as real OS processes: the space (in memory, or on a SQLite file to survive a
// restart) on a socket of its own, and judge processes. The web part runs in the test process (startServer), so a test
// can hand it a fake model team; it reaches the space over the socket like in production. close() stops them all.
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startServer as startWeb } from "../server/index.ts";
import { connectSpace } from "../server/space.ts";
import type { SpaceLike } from "../../src/index.ts";

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
const stop = (c: ChildProcess, sig: NodeJS.Signals = "SIGTERM") => new Promise<void>((r) => { if (c.exitCode !== null || c.signalCode !== null) return r(); c.once("exit", () => r()); c.kill(sig); });

export type Stack = {
	spec: string; space: SpaceLike;
	/** Starts one more judge process (its host name shows on the tiles and in the system bar). */
	judge(o?: { host?: string; workers?: number; leaseMs?: number }): Promise<ChildProcess>;
	/** Starts one more model process (`fakes`: the fake model teams of tests/fakes.ts, picked by room). */
	model(o?: { fakes?: boolean | string[] }): Promise<ChildProcess>;
	/** Starts one more agents process. */
	agents(o?: { leaseMs?: number }): Promise<ChildProcess>;
	/** Stops a judge process: SIGTERM, or SIGKILL to make it die in the middle of its work. */
	kill(c: ChildProcess, sig?: NodeJS.Signals): Promise<void>;
	close(): Promise<void>;
};

/** A space process (SQLite at `dbPath`, else in memory), `judges` judge processes, an agents process and a model
 *  process (real models, off in the tests, or with `fakes` the fake teams of tests/fakes.ts). */
export async function startStack(o: { dbPath?: string; judges?: Array<{ host?: string; workers?: number; leaseMs?: number }>; agents?: boolean; model?: boolean; fakes?: boolean | string[] } = {}): Promise<Stack> {
	const sock = `/tmp/cm-test-${process.pid}-${seq++}.sock`, spec = `unix:${sock}`;
	const space = await run("server/space-host.ts", { CODEMODE_LISTEN: spec, ...(o.dbPath ? { CODEMODE_SQLITE: o.dbPath, CODEMODE_MEM: "" } : { CODEMODE_MEM: "1" }) }, (l) => l.startsWith("[space] ready"));
	const conn = connectSpace(spec);
	const judges: ChildProcess[] = [], others: ChildProcess[] = [];
	const stack: Stack = {
		spec, space: conn.space,
		async judge(j = {}) {
			const c = await run("server/judge-host.ts", { CODEMODE_SPACE: spec, CODEMODE_HOST_NAME: j.host ?? "test", CODEMODE_JUDGES: String(j.workers ?? 2), ...(j.leaseMs ? { CODEMODE_JUDGE_LEASE_MS: String(j.leaseMs) } : {}) }, (l) => l.startsWith("[judge]"));
			judges.push(c);
			return c;
		},
		async model(m = {}) {
			const c = await run("server/model-host.ts", { CODEMODE_SPACE: spec, CODEMODE_HOST_NAME: "", ...(m.fakes ? { CODEMODE_TEST: "1", CODEMODE_LLM_MODULE: "tests/fakes.ts", CODEMODE_FAKE_MODELS: Array.isArray(m.fakes) ? m.fakes.join(",") : "" } : {}) }, (l) => l.startsWith("[model]"));
			others.push(c);
			return c;
		},
		async agents(a = {}) {
			const c = await run("server/agent-host.ts", { CODEMODE_SPACE: spec, CODEMODE_HOST_NAME: "", ...(a.leaseMs ? { CODEMODE_AGENT_LEASE_MS: String(a.leaseMs) } : {}) }, (l) => l.startsWith("[agents]"));
			others.push(c);
			return c;
		},
		kill: (c, sig) => stop(c, sig),
		async close() { await Promise.all([...judges, ...others].map((c) => stop(c))); conn.close(); await stop(space); await rm(sock, { force: true }); },
	};
	for (const j of o.judges ?? [{}]) await stack.judge(j);
	if (o.agents !== false) await stack.agents();
	if (o.model !== false) await stack.model({ fakes: o.fakes ?? false });
	return stack;
}

/** The web part on a stack: a stack of its own (closed with it) unless `stack` is given. */
export async function startServer(o: Parameters<typeof startWeb>[0] & { stack?: Stack; dbPath?: string; judges?: Array<{ host?: string; workers?: number; leaseMs?: number }>; fakes?: boolean | string[] } = {}) {
	const { stack: given, dbPath, judges, fakes, ...web } = o;
	const stack = given ?? (await startStack({ ...(dbPath ? { dbPath } : {}), ...(judges ? { judges } : {}), ...(fakes ? { fakes } : {}) }));
	const srv = await startWeb({ ...web, space: stack.spec });
	return { ...srv, stack, async close() { await srv.close(); if (!given) await stack.close(); } };
}
