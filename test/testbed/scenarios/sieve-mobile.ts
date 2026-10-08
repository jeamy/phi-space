// Prime sieve driven by a simulated mobile client (docs/betrieb-und-mobile-steuerung.md section 6, docs/testumgebung-big.md).
//
// Three separate invocations over persistent storage, like a phone that starts a run, comes back later and looks at
// the outcome:
//   create    the phone starts a run: generation and run id are stored on the "phone" first, the host prepares the
//             tasks under durable request ids. Lost answers, a host fault half way, and a double tap must not
//             duplicate anything.
//   run       host workers (some of which die holding a task) sieve the blocks while the phone polls over a flaky
//             link, goes offline for a while (app in the background) and reconnects. Optionally the host restarts.
//   evaluate  checks the stored state against an independent reference and prints/stores a report; exit code 1 on
//             any failed check.
//   all       create, run, evaluate in one go.
//
//   node --experimental-strip-types test/testbed/scenarios/sieve-mobile.ts <create|run|evaluate|all> [options]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { createSpace, FOREVER, listSpaces, PiSpaces, snapshotSpace, type Principal, type RequestRef } from "../../../src/index.ts";
import { collectSieveResults, segmentedSieve, type SieveConfig, type SieveResult, type SieveTask } from "../../../examples/sieve.ts";

const USAGE = `Usage: sieve-mobile.ts <create|run|evaluate|all> [options]
  --dir D           state directory (default: /data/sieve-mobile in the container, else a temp directory)
  --start N --end N --block N   range [start, end) in blocks (default 1 1001 128)
  --workers N       host workers (default 2)
  --work-ms N       simulated work per block (default 400)
  --drop P          probability that a phone call is disturbed, half lost requests, half lost answers (default 0.3)
  --offline-ms N    the phone goes to the background this long after the start (default 1200)
  --crash-workers N workers that die holding a task (default 2); --lease-ms N its transaction lease (default 1500)
  --crash-create N  the host faults after N prepared tasks during create (default 3; 0 = never)
  --host-restart    run: the host process restarts once half of the blocks are done
  --seed N          random seed for the link (default 7)
  --fresh           create: discard an existing run in --dir`;

// ---------------------------------------------------------------------------------------------------------- helpers
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (who: string, msg: string) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s [${who}] ${msg}`);
function mulberry32(a: number): () => number {
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
// Independent reference: trial division, not a second copy of the sieve.
const isPrime = (n: number) => { if (n < 2) return false; for (let d = 2; d * d <= n; d++) if (n % d === 0) return false; return true; };
const referencePrimes = (a: number, b: number) => { const out: number[] = []; for (let n = a; n < b; n++) if (isPrime(n)) out.push(n); return out; };

type Opts = {
	dir: string; start: number; end: number; block: number; workers: number; workMs: number; drop: number; offlineMs: number;
	crashWorkers: number; leaseMs: number; crashCreate: number; hostRestart: boolean; seed: number; fresh: boolean;
};
function parse(argv: string[]): { phase: string; o: Opts } {
	const [phase = "help", ...rest] = argv;
	const raw: Record<string, string | true> = {};
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i]!;
		if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
		const next = rest[i + 1];
		if (next === undefined || next.startsWith("--")) raw[a.slice(2)] = true;
		else { raw[a.slice(2)] = next; i++; }
	}
	const num = (k: string, d: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
		const v = raw[k] === undefined ? d : Number(raw[k]);
		if (typeof raw[k] === "boolean" || !Number.isFinite(v) || v < min || v > max) throw new Error(`--${k}: a number between ${min} and ${max} expected`);
		return v;
	};
	const dir = typeof raw.dir === "string" ? raw.dir : join(existsSync("/data") ? "/data" : tmpdir(), "sieve-mobile");
	const known = new Set(["dir", "start", "end", "block", "workers", "work-ms", "drop", "offline-ms", "crash-workers", "lease-ms", "crash-create", "host-restart", "seed", "fresh"]);
	for (const k of Object.keys(raw)) if (!known.has(k)) throw new Error(`unknown option --${k}`);
	const o: Opts = {
		dir, start: num("start", 1), end: num("end", 1001, 1, 10_000_000), block: num("block", 128, 1, 4096), workers: num("workers", 2, 1, 32),
		workMs: num("work-ms", 400, 0, 60_000), drop: num("drop", 0.3, 0, 0.9), offlineMs: num("offline-ms", 1200, 0, 600_000),
		crashWorkers: num("crash-workers", 2, 0, 32), leaseMs: num("lease-ms", 1500, 100, 600_000), crashCreate: num("crash-create", 3, 0, 1000),
		hostRestart: raw["host-restart"] === true, seed: num("seed", 7), fresh: raw.fresh === true,
	};
	if (o.end <= o.start) throw new Error("--end must be greater than --start");
	if (Math.ceil((o.end - o.start) / o.block) > 1000) throw new Error("at most 1000 blocks (raise --block)");
	return { phase, o };
}
const blocksOf = (c: SieveConfig) => Math.ceil((c.end - c.start) / c.blockSize);

// ---------------------------------------------------------------------------------------------------------- host side
const ALIAS = "sieve-a";
class Host {
	h: Harness;
	constructor(h: Harness) { this.h = h; }
	static async open(dir: string): Promise<Host> {
		mkdirSync(join(dir, "storage"), { recursive: true });
		const h = await Harness.open(await openNodeJsonlStorage(join(dir, "storage"), ctx), { models: createModels(), registry: createRegistry() }, ctx);
		await h.commit((tx) => createSpace(tx, ALIAS, Date.now()), ctx); // idempotent per alias
		return new Host(h);
	}
	space(as?: number): PiSpaces { return new PiSpaces(this.h, ctx, Date.now, undefined, as, { space: ALIAS }); }
	async close(): Promise<void> { await this.h.close(ctx); }
}

type PhoneState = { principal: Principal; generation: string; config: SieveConfig; createdAt: number };
const phoneFile = (dir: string) => join(dir, "phone.json");
const loadPhone = (dir: string): PhoneState => {
	if (!existsSync(phoneFile(dir))) throw new Error(`no run in ${dir}: run "create" first`);
	return JSON.parse(readFileSync(phoneFile(dir), "utf8")) as PhoneState;
};

/** A fault of the host while it handles a call; the phone sees a failed call and retries. */
class HostFault extends Error {}

/**
 * The host's handler for "start run". Every write carries a request id derived from the phone's run id, so running it
 * again (a retry after a lost answer, a double tap, a retry after a host fault half way) replays what already
 * happened and only does what is missing.
 */
async function hostStartRun(host: Host, phone: PhoneState, fault: { after: number; fired: boolean }): Promise<number> {
	const space = host.space();
	const ref = (id: string): RequestRef => ({ principal: phone.principal, generation: phone.generation, requestId: `${phone.config.runId}/${id}` });
	const cfg = phone.config;
	await space.write({ type: "SieveRun", fields: { ...cfg } }, null, FOREVER, { request: ref("run") });
	let i = 0;
	for (let s = cfg.start; s < cfg.end; s += cfg.blockSize, i++) {
		const task: SieveTask = { ...cfg, taskId: `${cfg.runId}:${i}`, rangeStart: s, rangeEnd: Math.min(s + cfg.blockSize, cfg.end) };
		await space.write({ type: "SieveTask", fields: task }, null, FOREVER, { request: ref(`task:${i}`) });
		if (fault.after > 0 && !fault.fired && i + 1 === fault.after) { fault.fired = true; throw new HostFault(`host died after preparing ${i + 1} tasks`); }
	}
	return i;
}

// ---------------------------------------------------------------------------------------------------------- phone side
type LinkStats = { calls: number; lostRequests: number; lostAnswers: number; offlineWaits: number; hostFaults: number };
/**
 * The mobile link. A call may be lost before it reaches the host (nothing happened) or after (the host did it, the
 * answer is lost). While the app is in the background (`offlineUntil`) nothing is sent. The phone repeats a call with
 * the same request identity until it gets an answer.
 */
class Link {
	stats: LinkStats = { calls: 0, lostRequests: 0, lostAnswers: 0, offlineWaits: 0, hostFaults: 0 };
	offlineUntil = 0;
	private rand: () => number;
	private drop: number;
	constructor(seed: number, drop: number) { this.rand = mulberry32(seed); this.drop = drop; }
	async call<T>(label: string, fn: () => Promise<T>): Promise<T> {
		for (let attempt = 1; ; attempt++) {
			const wait = this.offlineUntil - Date.now();
			if (wait > 0) { this.stats.offlineWaits++; await sleep(wait); }
			this.stats.calls++;
			const r = this.rand();
			const pause = Math.min(400, 80 * attempt);
			if (r < this.drop / 2) { this.stats.lostRequests++; say("phone", `${label}: request lost, retrying (attempt ${attempt})`); await sleep(pause); continue; }
			let v: T;
			try { v = await fn(); }
			catch (e) {
				if (!(e instanceof HostFault)) throw e;
				this.stats.hostFaults++; say("phone", `${label}: ${e.message}; no answer, retrying with the same request id`); await sleep(pause); continue;
			}
			if (r < this.drop) { this.stats.lostAnswers++; say("phone", `${label}: answer lost, retrying with the same request id`); await sleep(pause); continue; }
			return v;
		}
	}
}

// ---------------------------------------------------------------------------------------------------------- phases
async function create(o: Opts): Promise<void> {
	if (existsSync(phoneFile(o.dir))) {
		if (!o.fresh) throw new Error(`${o.dir} already holds a run; use --fresh to discard it, or run/evaluate`);
		rmSync(o.dir, { recursive: true, force: true });
	}
	mkdirSync(o.dir, { recursive: true });
	const host = await Host.open(o.dir);
	try {
		const principal: Principal = { peerId: "phone-1" };
		const link = new Link(o.seed, o.drop);
		// The phone persists its identity BEFORE it sends anything: after a crash of the app it retries the same run.
		const config: SieveConfig = { runId: `run-${randomUUID().slice(0, 8)}`, start: o.start, end: o.end, blockSize: o.block };
		const { generation } = await host.space().issueGeneration(principal);
		const phone: PhoneState = { principal, generation, config, createdAt: Date.now() };
		writeFileSync(phoneFile(o.dir), JSON.stringify(phone, null, 2));
		const blocks = blocksOf(config);
		say("phone", `start run ${config.runId}: [${config.start}, ${config.end}) in ${blocks} blocks of ${config.blockSize}`);
		const fault = { after: Math.min(o.crashCreate, blocks - 1), fired: false };
		const prepared = await link.call("startRun", () => hostStartRun(host, phone, fault));
		say("phone", `host prepared ${prepared} tasks`);
		await link.call("startRun (double tap)", () => hostStartRun(host, phone, { after: 0, fired: true }));
		const space = host.space();
		const tasks = await space.count({ type: "SieveTask", fields: { runId: config.runId } });
		const runs = await space.count({ type: "SieveRun", fields: { runId: config.runId } });
		say("host", `tasks in the space: ${tasks} (expected ${blocks}), run records: ${runs}`);
		writeFileSync(join(o.dir, "create-stats.json"), JSON.stringify({ link: link.stats, blocks, tasks, runs }, null, 2));
		if (tasks !== blocks || runs !== 1) throw new Error("create left a wrong number of tasks or run records");
		say("phone", "run created");
	} finally { await host.close(); }
}

async function run(o: Opts): Promise<void> {
	const phone = loadPhone(o.dir);
	const cfg = phone.config;
	const expected = blocksOf(cfg);
	const state = { host: await Host.open(o.dir), ready: Promise.resolve(), stop: false, crashBudget: o.crashWorkers, abandoned: 0, done: 0, restarts: 0, hostGen: 1 };
	const retired: Host[] = [];
	const progress = async (host: Host) => host.space().count({ type: "SieveResult", fields: { runId: cfg.runId } });
	let workers: Promise<void>[] = [];

	const workOne = async (w: PiSpaces, crash: boolean): Promise<"done" | "empty" | "abandoned"> => {
		const txn = await w.createTransaction(crash ? o.leaseMs : 30_000);
		try {
			const entry = await w.take({ type: "SieveTask", fields: { runId: cfg.runId } }, 0, { txn: txn.id });
			if (!entry) { await w.abort(txn.id); return "empty"; }
			if (crash) return "abandoned"; // the worker dies here; its transaction stays reserved until the lease lapses
			const task = entry.fields as unknown as SieveTask;
			await sleep(o.workMs);
			const result: SieveResult = { runId: cfg.runId, taskId: task.taskId, rangeStart: task.rangeStart, rangeEnd: task.rangeEnd, primes: segmentedSieve(task.rangeStart, task.rangeEnd) };
			await w.write({ type: "SieveResult", fields: result }, txn.id, FOREVER);
			await w.commit(txn.id);
			return "done";
		} catch (e) { await w.abort(txn.id).catch(() => {}); throw e; }
	};
	const startWorkers = () => {
		state.stop = false;
		workers = Array.from({ length: o.workers }, (_, i) => (async () => {
			const w = state.host.space(i + 1);
			while (!state.stop) {
				if (await progress(state.host) >= expected) return;
				const crash = state.crashBudget > 0 && (state.crashBudget--, true);
				const r = await workOne(w, crash);
				if (r === "abandoned") { state.abandoned++; say(`worker ${i + 1}`, `died holding a task (lease ${o.leaseMs} ms)`); }
				else if (r === "done") state.done++;
				else await sleep(60);
			}
		})());
	};
	const restartHost = async () => {
		say("host", "restart: workers stop, the process dies, the storage is reopened");
		state.stop = true;
		let release!: () => void;
		state.ready = new Promise<void>((r) => { release = r; });
		await Promise.all(workers);
		retired.push(state.host); // abandoned like a killed process, closed at the very end
		state.host = await Host.open(o.dir);
		state.restarts++;
		state.hostGen++;
		startWorkers();
		release();
		say("host", `back up, ${await progress(state.host)}/${expected} blocks done`);
	};

	const link = new Link(o.seed + 1, o.drop);
	startWorkers();
	say("host", `${o.workers} workers started on run ${cfg.runId} (${expected} blocks, ${o.workMs} ms each)`);

	const restartWatcher = (async () => {
		if (!o.hostRestart) return;
		while (state.restarts === 0) {
			if (await progress(state.host) >= Math.ceil(expected / 2)) { await restartHost(); return; }
			await sleep(40);
		}
	})();

	// The phone: opens the app, sends it to the background, comes back and watches until the run is complete.
	const phoneTask = (async () => {
		const seen = async () => link.call("progress", async () => { await state.ready; return progress(state.host); });
		let last = await seen();
		say("phone", `app opened: ${last}/${expected} blocks done`);
		if (o.offlineMs > 0) {
			link.offlineUntil = Date.now() + o.offlineMs;
			say("phone", `app in the background for ${o.offlineMs} ms (the host keeps working)`);
		}
		const before = last;
		for (;;) {
			const n = await seen();
			if (n !== last) { say("phone", `progress ${n}/${expected} (${Math.round((100 * n) / expected)} %)`); if (before === last && n > before) say("phone", "reconnected: blocks were finished while the app was away"); last = n; }
			if (n >= expected) break;
			await sleep(150);
		}
		const primes = await link.call("fetch result", async () => { await state.ready; return collectSieveResults(state.host.space(), cfg); });
		say("phone", `result: ${primes.length} primes in [${cfg.start}, ${cfg.end})`);
	})();

	await Promise.all([phoneTask, restartWatcher]);
	state.stop = true;
	await Promise.all(workers);
	const stats = { link: link.stats, workersDone: state.done, workersAbandoned: state.abandoned, hostRestarts: state.restarts, workers: o.workers };
	writeFileSync(join(o.dir, "run-stats.json"), JSON.stringify(stats, null, 2));
	await state.host.close();
	for (const h of retired) await h.close().catch(() => {});
	say("host", `run complete: ${JSON.stringify(stats)}`);
}

type Check = { name: string; ok: boolean; detail: string };
async function evaluate(o: Opts): Promise<boolean> {
	const phone = loadPhone(o.dir);
	const cfg = phone.config;
	const blocks = blocksOf(cfg);
	const host = await Host.open(o.dir);
	const checks: Check[] = [];
	const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
	try {
		const space = host.space();
		const st = await space.stats();
		add("one run record", (await space.count({ type: "SieveRun", fields: { runId: cfg.runId } })) === 1, "the double tap and every retry created no second run");
		add("no task left", (await space.count({ type: "SieveTask", fields: { runId: cfg.runId } })) === 0, `${await space.count({ type: "SieveTask", fields: { runId: cfg.runId } })} tasks remain`);
		add("no open work", st.txns === 0 && st.locked === 0 && st.uncommitted === 0, `txns ${st.txns}, locked ${st.locked}, uncommitted ${st.uncommitted}`);

		let all: number[] = [];
		try {
			all = await collectSieveResults(space, cfg); // exactly one result per expected task, ranges and order checked
			add("one result per block", true, `${blocks} blocks, each with exactly one result`);
		} catch (e) { add("one result per block", false, (e as Error).message); }

		const results = (await space.readAll({ type: "SieveResult", fields: { runId: cfg.runId } }, { limit: 1000 })).map((e) => e.fields as unknown as SieveResult);
		const wrong = results.filter((r) => JSON.stringify(r.primes) !== JSON.stringify(referencePrimes(r.rangeStart, r.rangeEnd)));
		add("every block equals trial division", results.length === blocks && wrong.length === 0, wrong.length ? `wrong blocks: ${wrong.map((r) => r.taskId).join(", ")}` : `${results.length} blocks checked`);
		const ref = referencePrimes(cfg.start, cfg.end);
		const same = all.length === ref.length && all.every((p, i) => p === ref[i]);
		add("total result equals the reference", same, `${all.length} primes, reference ${ref.length}`);

		// Exactly-once evidence: the host stored one claim per request the phone sent (run + one per task), all decided.
		const info = (await listSpaces(host.h, ctx)).find((i) => i.alias === ALIAS);
		const doc = info ? await snapshotSpace(host.h, info.spaceId, ctx) : undefined;
		const claims = Object.values(doc?.rpc?.claims ?? {});
		add("one decided claim per request", claims.length === blocks + 1 && claims.every((c) => c.state === "done"), `${claims.length} claims (${blocks + 1} expected), ${claims.filter((c) => c.state !== "done").length} undecided`);

		const stats = (f: string): unknown => { try { return JSON.parse(readFileSync(join(o.dir, f), "utf8")); } catch { return null; } };
		const report = { runId: cfg.runId, range: [cfg.start, cfg.end], blocks, primes: all.length, passed: checks.every((c) => c.ok), checks, create: stats("create-stats.json"), run: stats("run-stats.json") };
		writeFileSync(join(o.dir, "report.json"), JSON.stringify(report, null, 2));
		const w = Math.max(...checks.map((c) => c.name.length));
		console.log(`\nEvaluation of ${cfg.runId}: [${cfg.start}, ${cfg.end}) in ${blocks} blocks`);
		for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(w)}  ${c.detail}`);
		const cs = report.create as { link?: LinkStats } | null, rs = report.run as { link?: LinkStats; workersAbandoned?: number; hostRestarts?: number } | null;
		const lost = (l?: LinkStats) => (l ? l.lostRequests + l.lostAnswers + l.hostFaults : 0);
		console.log(`  faults survived: create ${lost(cs?.link)} disturbed calls, run ${lost(rs?.link)} disturbed calls, ${rs?.workersAbandoned ?? "?"} workers died holding a task, ${rs?.hostRestarts ?? "?"} host restarts`);
		console.log(`  report: ${join(o.dir, "report.json")}`);
		console.log(report.passed ? "RESULT: PASSED" : "RESULT: FAILED");
		return report.passed;
	} finally { await host.close(); }
}

// ---------------------------------------------------------------------------------------------------------- main
async function main(): Promise<number> {
	let parsed;
	try { parsed = parse(process.argv.slice(2)); } catch (e) { console.error(`sieve-mobile: ${(e as Error).message}\n\n${USAGE}`); return 2; }
	const { phase, o } = parsed;
	try {
		switch (phase) {
			case "create": await create(o); return 0;
			case "run": await run(o); return 0;
			case "evaluate": return (await evaluate(o)) ? 0 : 1;
			case "all": await create({ ...o, fresh: true }); await run(o); return (await evaluate(o)) ? 0 : 1;
			default: console.log(USAGE); return phase === "help" || phase === "--help" ? 0 : 2;
		}
	} catch (e) { console.error(`sieve-mobile: ${(e as Error).stack ?? e}`); return 1; }
}
process.exit(await main());
