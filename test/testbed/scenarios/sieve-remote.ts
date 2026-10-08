// Prime sieve over the network protocol: the space service in one process (the host), a phone and workers as clients of
// that service through sockets (docs/testumgebung-big.md). Unlike sieve-mobile, nothing here touches the host's storage
// directly: every effect goes through RemoteSpace -> socket -> SpaceService, with request identities, claims, polls and
// retries. The host process is killed with SIGKILL in the middle of the run and started again; the clients keep retrying.
//
//   serve   the host: a harness on JSONL storage, the service on <dir>/phone.sock (principal "phone", role admin) and
//           <dir>/worker.sock (principal "worker", role member). With --listen HOST:PORT it serves a TCP port as well
//           (the overlay address of the host) for the principal named by --tcp-peer (default worker).
//   client  creates the tasks as the phone, runs workers (some die holding a transaction), evaluates against trial division
//   all     serve as a child process (killed and restarted once) + client
//
//   node scenarios/sieve-remote.mjs <serve|client|all> [options]
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { FOREVER, PiSpaces, RemoteSpace, SpaceService, StaticIdentity, serveSpace, socketTransport, type ListenTarget, type SpaceServer } from "../../../src/index.ts";
import { segmentedSieve } from "../../../examples/sieve.ts";

const USAGE = `Usage: sieve-remote.ts <serve|client|all> [options]
  --dir D            state and sockets (default: /data/sieve-remote in the container, else a temp directory)
  --end N --block N  primes in [1, N) in blocks (default 4001 250)
  --workers N        worker clients (default 3)
  --work-ms N        simulated work per block (default 150)
  --crash-workers N  workers that die holding a task (default 2); --lease-ms N its transaction lease (default 1200)
  --kill-host        all: SIGKILL the host at 40% of the results, start it again after --down-ms (default 700)
  --listen HOST:PORT serve: also listen on a TCP port (HOST "overlay": the address of the interface wt0); --tcp-peer NAME its principal
                     (default worker, a member: tasks, results and reads, nothing administrative)
  --connect HOST:PORT client: reach the host over TCP instead of the sockets (workers and phone alike)
  --timeout-s N      give up after this long (default 90)
  --fresh            discard the state in --dir first`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (who: string, msg: string) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s [${who}] ${msg}`);
const isPrime = (n: number) => { if (n < 2) return false; for (let d = 2; d * d <= n; d++) if (n % d === 0) return false; return true; };

type Opts = { dir: string; end: number; block: number; workers: number; workMs: number; crashWorkers: number; leaseMs: number; killHost: boolean; downMs: number; listen?: string; tcpPeer: string; connect?: string; timeoutS: number; fresh: boolean };
function parse(argv: string[]): { mode: string; o: Opts } {
	const [mode = "help", ...rest] = argv;
	const o: Opts = { dir: existsSync("/data") ? "/data/sieve-remote" : join(tmpdir(), "pi-spaces-sieve-remote"), end: 4001, block: 250, workers: 3, workMs: 150, crashWorkers: 2, leaseMs: 1200, killHost: false, downMs: 700, tcpPeer: "worker", timeoutS: 90, fresh: false };
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i]!;
		const val = () => { const v = rest[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
		const num = () => { const n = Number(val()); if (!Number.isFinite(n) || n < 0) throw new Error(`${a} needs a number`); return n; };
		switch (a) {
			case "--dir": o.dir = val(); break;
			case "--end": o.end = num(); break;
			case "--block": o.block = num(); break;
			case "--workers": o.workers = num(); break;
			case "--work-ms": o.workMs = num(); break;
			case "--crash-workers": o.crashWorkers = num(); break;
			case "--lease-ms": o.leaseMs = num(); break;
			case "--down-ms": o.downMs = num(); break;
			case "--kill-host": o.killHost = true; break;
			case "--listen": o.listen = val(); break;
			case "--tcp-peer": o.tcpPeer = val(); break;
			case "--connect": o.connect = val(); break;
			case "--timeout-s": o.timeoutS = num(); break;
			case "--fresh": o.fresh = true; break;
			default: throw new Error(`unknown option ${a}`);
		}
	}
	return { mode, o };
}
/** The IPv4 address of the NetBird interface of this container (shared with its overlay agent), once it is up. */
async function overlayAddress(): Promise<string> {
	for (let i = 0; i < 120; i++) {
		const a = networkInterfaces().wt0?.find((x) => x.family === "IPv4");
		if (a) return a.address;
		await sleep(500);
	}
	throw new Error("no overlay interface wt0 in this container: run it in a federation host (up federation)");
}
const hostPort = (s: string): { host: string; port: number } => { const m = /^(.+):(\d+)$/.exec(s); if (!m) throw new Error(`HOST:PORT expected, got ${s}`); return { host: m[1]!, port: Number(m[2]) }; };

// ------------------------------------------------------------------------------------------------------------ host
const IDS = new StaticIdentity({
	phone: { principal: { peerId: "phone" }, roles: ["admin"] },
	worker: { principal: { peerId: "worker", agentId: "pool" }, roles: ["member"] },
});

async function serve(o: Opts): Promise<void> {
	mkdirSync(o.dir, { recursive: true });
	const storage = await openNodeJsonlStorage(join(o.dir, "data"), ctx);
	const h = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, ctx);
	await new PiSpaces(h, ctx).count(); // registers the default space
	const service = new SpaceService({ host: h, ctx, identity: IDS, hostId: "host", maxPollMs: 5_000 });
	const servers: SpaceServer[] = [];
	servers.push(await serveSpace(service, { listen: { path: join(o.dir, "phone.sock") }, connection: () => ({ peerId: "phone" }) }));
	servers.push(await serveSpace(service, { listen: { path: join(o.dir, "worker.sock") }, connection: () => ({ peerId: "worker" }) }));
	let tcp = "";
	if (o.listen) {
		const hp = hostPort(o.listen);
		if (hp.host === "overlay") hp.host = await overlayAddress(); // only on the overlay address: peers on the testnet cannot reach it
		servers.push(await serveSpace(service, { listen: hp, connection: () => ({ peerId: o.tcpPeer }) }));
		tcp = `, tcp ${hp.host}:${hp.port} as ${o.tcpPeer}`;
	}
	say("host", `serving ${servers.length} listeners in ${o.dir}${tcp}`);
	console.log("READY");
	const stop = async () => { for (const s of servers) await s.close(); await h.close(ctx); process.exit(0); };
	process.on("SIGTERM", () => void stop());
	process.on("SIGINT", () => void stop());
}

// ---------------------------------------------------------------------------------------------------------- client
function clients(o: Opts): { phone: () => RemoteSpace; worker: () => RemoteSpace; close: () => void } {
	const open: { close(): void }[] = [];
	const make = (path: string, peer: string): RemoteSpace => {
		const target: ListenTarget = o.connect ? hostPort(o.connect) : { path: join(o.dir, path) };
		const t = socketTransport(target);
		open.push(t);
		// attempts and backoff are meant to span a host restart of a second or two
		return new RemoteSpace(t, { attempts: 60, backoffMs: 100, maxBackoffMs: 500, callTimeoutMs: 8_000, maxClientWaitMs: undefined });
	};
	void make;
	return { phone: () => make("phone.sock", "phone"), worker: () => make("worker.sock", "worker"), close: () => open.forEach((t) => t.close()) };
}

async function client(o: Opts, hostChild?: { kill(): Promise<void>; restart(): Promise<void> }): Promise<boolean> {
	const c = clients(o);
	const phone = c.phone();
	const hello = await phone.info();
	say("phone", `connected as ${hello.principal} (${hello.roles.join(",")}) to space ${hello.spaceId}, host ${hello.hostId ?? "?"}`);
	const blocks: Array<[number, number]> = [];
	for (let s = 1; s < o.end; s += o.block) blocks.push([s, Math.min(s + o.block, o.end)]);
	const total = blocks.length;
	const marker = (await phone.readAll({ type: "SieveRun" }))[0];
	if (marker) {
		if (marker.fields.end !== o.end || marker.fields.block !== o.block) throw new Error(`the host holds an earlier run (end ${marker.fields.end}, block ${marker.fields.block}); start the host with --fresh or use the same --end and --block`);
		say("phone", "a run exists already: resuming it");
	} else {
		await phone.write({ type: "SieveRun", fields: { end: o.end, block: o.block } }, null, FOREVER);
		for (const [i, [a, b]] of blocks.entries()) await phone.write({ type: "SieveTask", fields: { block: i, rangeStart: a, rangeEnd: b } }, null, FOREVER);
		say("phone", `created ${total} tasks`);
	}

	let stopping = false;
	let died = 0;
	const stats = { done: 0, retried: 0, lateCommits: 0, crashed: 0 };
	const links: RemoteSpace[] = [phone];
	const worker = async (n: number, dies: boolean) => {
		const w = c.worker();
		links.push(w);
		let doomed = dies;
		while (!stopping) {
			try {
				const t = await w.createTransaction(doomed ? o.leaseMs : 30_000);
				const task = await w.take({ type: "SieveTask" }, 0, { txn: t.id });
				if (!task) { await w.abort(t.id).catch(() => {}); await sleep(100); continue; }
				if (doomed) { doomed = false; died++; stats.crashed++; say(`worker ${n}`, `dies holding block ${task.fields.block}; its lease ends in ${o.leaseMs} ms`); await sleep(o.leaseMs + 300); continue; }
				await sleep(o.workMs);
				const primes = segmentedSieve(task.fields.rangeStart as number, task.fields.rangeEnd as number);
				await w.write({ type: "SieveResult", fields: { block: task.fields.block, rangeStart: task.fields.rangeStart, rangeEnd: task.fields.rangeEnd, primes } }, t.id, FOREVER);
				await w.commit(t.id);
				stats.done++;
			} catch (e) {
				stats.retried++;
				if (!stopping) say(`worker ${n}`, `${(e as Error).name}: ${(e as Error).message.slice(0, 90)}`);
				await sleep(150);
			}
		}
	};
	const pool = Array.from({ length: o.workers }, (_, i) => worker(i + 1, i < o.crashWorkers));
	let killed = false;
	const deadline = Date.now() + o.timeoutS * 1000;
	let results = 0;
	while (Date.now() < deadline) {
		try { results = await phone.count({ type: "SieveResult" }); } catch { /* the host may be down: retry */ }
		if (results >= total) break;
		if (hostChild && o.killHost && !killed && results >= Math.ceil(total * 0.4)) {
			killed = true;
			say("host", `SIGKILL at ${results}/${total} results`);
			await hostChild.kill();
			await sleep(o.downMs);
			await hostChild.restart();
			say("host", "started again on the same storage");
		}
		await sleep(150);
	}
	stopping = true;
	await Promise.all(pool);

	// ---- evaluation, from the stored state
	const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
	const check = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); say("check", `${ok ? "ok  " : "FAIL"} ${name}: ${detail}`); };
	const stored = await phone.readAll({ type: "SieveResult" }, { limit: 1000 });
	const byBlock = new Map<number, number>();
	for (const e of stored) byBlock.set(e.fields.block as number, (byBlock.get(e.fields.block as number) ?? 0) + 1);
	check("every block has exactly one result", byBlock.size === total && [...byBlock.values()].every((n) => n === 1), `${byBlock.size}/${total} blocks, duplicates ${[...byBlock.values()].filter((n) => n > 1).length}`);
	const found = stored.flatMap((e) => e.fields.primes as number[]).sort((a, b) => a - b);
	const expected: number[] = [];
	for (let n = 1; n < o.end; n++) if (isPrime(n)) expected.push(n);
	check("the primes equal trial division", found.length === expected.length && found.every((p, i) => p === expected[i]), `${found.length} primes, expected ${expected.length}`);
	check("no task is left", (await phone.count({ type: "SieveTask" })) === 0, `${await phone.count({ type: "SieveTask" })} tasks`);
	const st = await phone.stats();
	check("no transaction is left open", st.txns === 0 && st.locked === 0 && st.uncommitted === 0, `txns ${st.txns}, locked ${st.locked}, uncommitted ${st.uncommitted}`);
	const ch = await phone.changes(0).catch(() => undefined);
	say("phone", ch ? `revision ${ch.rev} of stream ${ch.streamId}` : "the change log has been trimmed");
	if (o.killHost) check("the host was killed and came back", killed, killed ? "yes" : "never reached 40% of the results");
	if (o.crashWorkers > 0) check("dying workers held tasks that others finished", stats.crashed > 0, `${stats.crashed} died holding a task`);
	const ok = checks.every((x) => x.ok);
	const retries = links.reduce((n, l) => n + l.counters.retries, 0);
	say("result", `${ok ? "PASSED" : "FAILED"}: ${stats.done} blocks committed by workers, ${stats.retried} errors seen by workers, ${retries} transport attempts repeated under the same identity`);
	mkdirSync(o.dir, { recursive: true });
	writeFileSync(join(o.dir, "report-remote.json"), JSON.stringify({ ok, checks, stats, total, primes: found.length }, null, 2));
	c.close();
	return ok;
}

// ------------------------------------------------------------------------------------------------------------- all
function hostProcess(o: Opts) {
	let child: ChildProcess | undefined;
	const start = () => new Promise<void>((resolve, reject) => {
		const args = [...process.execArgv, process.argv[1]!, "serve", "--dir", o.dir, ...(o.listen ? ["--listen", o.listen, "--tcp-peer", o.tcpPeer] : [])];
		const c = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
		child = c;
		let seen = "";
		c.stdout!.on("data", (d: Buffer) => { seen += d.toString(); if (seen.includes("READY")) resolve(); process.stdout.write(d); });
		c.on("exit", (code) => { if (!seen.includes("READY")) reject(new Error(`the host exited with ${code} before it was ready`)); });
	});
	return {
		start,
		restart: start,
		kill: async () => { const c = child; if (!c) return; const gone = new Promise<void>((r) => c.once("exit", () => r())); c.kill("SIGKILL"); await gone; },
		stop: async () => { const c = child; if (!c || c.exitCode !== null) return; const gone = new Promise<void>((r) => c.once("exit", () => r())); c.kill("SIGTERM"); await gone; },
	};
}

async function main(): Promise<void> {
	let parsed: { mode: string; o: Opts };
	try { parsed = parse(process.argv.slice(2)); } catch (e) { console.error((e as Error).message + "\n" + USAGE); process.exit(2); }
	const { mode, o } = parsed;
	if (!["serve", "client", "all"].includes(mode)) { console.log(USAGE); process.exit(mode === "help" ? 0 : 2); }
	if (o.fresh) rmSync(o.dir, { recursive: true, force: true });
	if (mode === "serve") return serve(o);
	if (mode === "client") process.exit((await client(o)) ? 0 : 1);
	mkdirSync(o.dir, { recursive: true });
	const host = hostProcess(o);
	await host.start();
	let ok = false;
	try { ok = await client(o, host); } finally { await host.stop(); }
	process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
