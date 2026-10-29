// U3 (docs/umstellung-ohne-pi-durable.md): phi-spaces as a service of its own. The standalone service (src/standalone.ts)
// and the examples run as processes in which pi-durable, chord and pi-ai cannot be imported (test/support/no-durable.mjs):
// the sieve and the cache work through it over a unix socket and TCP, and a hard restart of the service keeps waiting
// calls, deadlines and decided results.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FOREVER, OutcomeUnknown, RemoteSpace, socketTransport, type Taken } from "../src/index.ts";
import { parseListen } from "../src/standalone.ts";
import { collectSieveResults, processSieveTask, seedSieveRemote } from "../examples/sieve.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOK = fileURLToPath(new URL("./support/no-durable.mjs", import.meta.url));
const NODE = ["--import", HOOK, "--experimental-strip-types", "--no-warnings"];
// unix socket paths are short (108 bytes): under /tmp, not the test's TMPDIR
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync("/tmp/phi-sa-"); dirs.push(d); return d; };
const children = new Set<ChildProcess>();
test.after(() => { for (const c of children) c.kill("SIGKILL"); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A process under the hook, run to its end. */
function run(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
	return new Promise((resolve) => {
		const c = spawn(process.execPath, [...NODE, ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
		let out = "", err = "";
		c.stdout.on("data", (d: Buffer) => { out += d; });
		c.stderr.on("data", (d: Buffer) => { err += d; });
		c.on("exit", (code) => resolve({ code, out, err }));
	});
}

/** Another implementation of the service (docs/rust-portierung.md, R0/R3): PHI_SPACES_SERVER_CMD is its command line (split
 *  at whitespace), started with the same --store and --listen and expected to print the same ready line. */
const SERVER_CMD = process.env.PHI_SPACES_SERVER_CMD?.trim() ? process.env.PHI_SPACES_SERVER_CMD.trim().split(/\s+/) : null;

/** The standalone service under the hook (or SERVER_CMD); resolves with its address once it serves. */
function server(store: string, listen: string): Promise<{ proc: ChildProcess; address: string }> {
	return new Promise((resolve, reject) => {
		const args = ["--store", store, "--listen", listen];
		const proc = SERVER_CMD ? spawn(SERVER_CMD[0]!, [...SERVER_CMD.slice(1), ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }) : spawn(process.execPath, [...NODE, "src/standalone.ts", ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
		children.add(proc);
		let out = "";
		proc.stdout!.on("data", (d: Buffer) => { out += d; const m = /\[phi-spaces\] ready on (\S+)/.exec(out); if (m) resolve({ proc, address: m[1]! }); });
		proc.stderr!.on("data", (d: Buffer) => { out += d; });
		proc.on("exit", (code) => { children.delete(proc); reject(new Error(`the service exited (${code}):\n${out}`)); });
	});
}
const kill = (p: ChildProcess, sig: NodeJS.Signals) => new Promise<void>((r) => { if (p.exitCode !== null || p.signalCode !== null) return r(); p.once("exit", () => r()); p.kill(sig); });
const remote = (address: string) => new RemoteSpace(socketTransport(parseListen(address), { requestTimeoutMs: 40_000 }));

/** A call's outcome across a restart (RemoteSpace's contract): when it gives up (OutcomeUnknown), the very same request is
 *  polled until the service answers again. */
async function outcome(p: Promise<Taken | null>, r: RemoteSpace, request: { generation: string; requestId: string }): Promise<Taken | null> {
	try { return await p; } catch (e) { if (!(e instanceof OutcomeUnknown)) throw e; }
	for (const end = Date.now() + 60_000; ;) {
		try { const v = await r.pollOperation(request, 20_000); if (v.state !== "pending") return (v.result ?? null) as Taken | null; }
		catch (e) { if (Date.now() > end) throw e; await sleep(200); }
	}
}

test("the hook refuses pi-durable, chord and pi-ai (else the tests below would prove nothing)", async () => {
	for (const pkg of ["@earendil-works/pi-durable", "@earendil-works/chord/context", "@earendil-works/pi-ai/models"]) {
		const r = await run(["--input-type=module", "-e", `await import(${JSON.stringify(pkg)}); console.log("loaded")`]);
		assert.notEqual(r.code, 0, `${pkg} was loaded`);
		assert.match(r.err, /blocked by no-durable\.mjs/);
	}
});

test("the sieve and the cache work through a standalone service over a unix socket and TCP, without pi-durable", async () => {
	const d = tmp();
	const unix = await server(join(d, "space.sqlite"), `unix:${join(d, "s.sock")}`);
	const tcp = await server("memory", "tcp:127.0.0.1:0");
	try {
		for (const address of [unix.address, tcp.address]) {
			const sieve = await run(["examples/sieve.ts", "2001", "4", "--remote", address]);
			assert.equal(sieve.code, 0, sieve.err);
			assert.equal(sieve.out.split("\n")[0], "303 primes in [1, 2001)", `${address}: ${sieve.err}`);
			const cache = await run(["examples/cache.ts", "--remote", address]);
			assert.equal(cache.code, 0, cache.err);
			const r = JSON.parse(cache.out) as { hit: { value: unknown; version: number }; afterDelete: unknown };
			assert.deepEqual([r.hit.value, r.hit.version, r.afterDelete], [{ name: "Bob" }, 2, null], address);
		}
	} finally { await kill(unix.proc, "SIGTERM"); await kill(tcp.proc, "SIGTERM"); }
});

test("a hard restart of the service keeps a waiting take, ends one whose deadline passed meanwhile, and replays a decided write", async () => {
	const d = tmp(), store = join(d, "space.sqlite"), listen = `unix:${join(d, "s.sock")}`;
	let s = await server(store, listen);
	const r = remote(s.address);
	const { generation } = await r.requestGeneration();
	const req = (requestId: string) => ({ generation, requestId, principal: { peerId: "local" } }); // the service takes the principal from the connection
	// decided before the crash
	const first = await r.write({ type: "Done", fields: { n: 1 } }, null, FOREVER, { request: req("w1") });
	// waiting when the service dies: one for an entry that comes after the restart, one whose deadline passes while it is down
	const waiting = r.take({ type: "Job" }, 120_000, { request: req("t1") });
	const lapsing = r.take({ type: "Never" }, 1_500, { request: req("t2") });
	waiting.catch(() => {}); lapsing.catch(() => {});
	await sleep(500);
	await kill(s.proc, "SIGKILL");
	await sleep(2_500);
	s = await server(store, listen);
	try {
		const writer = remote(s.address);
		await writer.write({ type: "Job", fields: { n: 7 } }, null, FOREVER);
		assert.deepEqual((await outcome(waiting, r, req("t1")))?.fields, { n: 7 }, "the waiting take got the entry written after the restart");
		assert.equal(await outcome(lapsing, r, req("t2")), null, "the deadline passed while the service was down: no entry, no hang");
		assert.equal(await writer.count({ type: "Job" }), 0, "taken once");
		// the same request again: its stored result, no second entry
		assert.deepEqual(await r.write({ type: "Done", fields: { n: 1 } }, null, FOREVER, { request: req("w1") }), first);
		assert.equal(await writer.count({ type: "Done" }), 1);
	} finally { await kill(s.proc, "SIGTERM"); }
});

test("a worker that dies holding a sieve task: its lease lapses on the standalone service and another worker finishes", async () => {
	const d = tmp();
	const s = await server(join(d, "space.sqlite"), `unix:${join(d, "s.sock")}`);
	try {
		const config = { runId: "lapse", start: 1, end: 301, blockSize: 100 };
		const [a, b] = [remote(s.address), remote(s.address)];
		await seedSieveRemote(a, config);
		await seedSieveRemote(a, config); // a repeated seeding writes nothing
		assert.equal(await processSieveTask(a, config.runId, { leaseMs: 1_000, crashAfterTake: true }), false); // takes one and goes
		while (await processSieveTask(b, config.runId)) { /* the two others */ }
		await assert.rejects(collectSieveResults(b, config), /Expected exactly one result/);
		await sleep(1_500); // the dead worker's transaction lapses; its task comes back
		while (await processSieveTask(b, config.runId)) { /* the one that came back */ }
		assert.equal((await collectSieveResults(b, config)).length, 62);
	} finally { await kill(s.proc, "SIGTERM"); }
});
