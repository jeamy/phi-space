// What a call costs the space process (docs/rust-portierung.md, R0 baseline and decision R-D2): the standalone service as
// a process of its own, CLIENTS clients in this process over a unix socket, each OPS rounds of write, read and take
// one after another, RATE calls per second together (the service allows one peer 1024 per second); then the CPU time the service spent meanwhile (/proc/<pid>/stat, Linux) per call, its peak RSS and
// the answer times. The same probe measures another implementation with --cmd (as PHI_SPACES_SERVER_CMD in the tests).
//
//   node --experimental-strip-types --no-warnings scripts/server-probe.ts [--store memory|sqlite] [--clients 8] [--ops 2000] [--rate 900] [--cmd "..."]
//
// Prints one JSON line.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { RemoteSpace, socketTransport } from "../src/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const arg = (name: string, dflt: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : dflt; };
const STORE = arg("store", "memory"), CLIENTS = Number(arg("clients", "8")), OPS = Number(arg("ops", "2000")), RATE = Number(arg("rate", "900"));
const CMD = arg("cmd", `${process.execPath} --experimental-strip-types --no-warnings src/standalone.ts`).trim().split(/\s+/);
const TICK = Number(execFileSync("getconf", ["CLK_TCK"]).toString().trim()) || 100;

const cpuMs = (pid: number) => { const s = readFileSync(`/proc/${pid}/stat`, "utf8"), f = s.slice(s.lastIndexOf(")") + 2).split(" "); return ((Number(f[11]) + Number(f[12])) / TICK) * 1000; };
const rssBytes = (pid: number) => Number(/VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))![1]) * 1024;

const dir = mkdtempSync("/tmp/phi-probe-");
let proc: ChildProcess | undefined;
try {
	const listen = `unix:${join(dir, "s.sock")}`;
	proc = spawn(CMD[0]!, [...CMD.slice(1), "--store", STORE === "sqlite" ? join(dir, "space.sqlite") : "memory", "--listen", listen], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
	await new Promise<void>((resolve, reject) => {
		let out = "";
		proc!.stdout!.on("data", (d: Buffer) => { out += d; if (/ready on/.test(out)) resolve(); });
		proc!.stderr!.on("data", (d: Buffer) => { out += d; });
		proc!.on("exit", (code) => reject(new Error(`the service exited (${code}):\n${out}`)));
	});
	const pid = proc.pid!;
	const clients = Array.from({ length: CLIENTS }, () => new RemoteSpace(socketTransport({ path: join(dir, "s.sock") })));
	for (const c of clients) await c.info(); // connected and hello'd before the clock starts
	const idleRss = rssBytes(pid);
	let peakRss = idleRss;
	const sampler = setInterval(() => { try { peakRss = Math.max(peakRss, rssBytes(pid)); } catch { /* exited */ } }, 100);
	const times: number[] = [];
	const cpu0 = cpuMs(pid), t0 = performance.now();
	// the calls of all clients start on a common schedule: the n-th not before t0 + n / RATE
	let slot = 0;
	const timed = async <T,>(p: () => Promise<T>): Promise<T> => {
		const due = t0 + (slot++ * 1000) / RATE, wait = due - performance.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		const t = performance.now(); const r = await p(); times.push(performance.now() - t); return r;
	};
	await Promise.all(clients.map(async (c, k) => {
		for (let i = 0; i < OPS; i++) {
			const fields = { client: k, i, payload: "x".repeat(64) };
			await timed(() => c.write({ type: "Probe", fields }, null, 60_000));
			await timed(() => c.read({ type: "Probe", fields: { client: k, i } }, 0));
			if (!(await timed(() => c.take({ type: "Probe", fields: { client: k, i } }, 0)))) throw new Error("the probe entry was gone");
		}
	}));
	const wallMs = performance.now() - t0, spent = cpuMs(pid) - cpu0;
	clearInterval(sampler);
	times.sort((a, b) => a - b);
	const q = (p: number) => Math.round(times[Math.min(times.length - 1, Math.floor(p * times.length))]! * 100) / 100;
	console.log(JSON.stringify({
		cmd: CMD.slice(-1)[0], store: STORE, clients: CLIENTS, rate: RATE, calls: times.length, wallMs: Math.round(wallMs), callsPerSecond: Math.round(times.length / (wallMs / 1000)),
		serverCpuMsPerCall: Math.round((spent / times.length) * 1000) / 1000, serverCpuShare: Math.round((spent / wallMs) * 100) / 100,
		p50Ms: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), idleRssMb: Math.round(idleRss / 1048576), peakRssMb: Math.round(peakRss / 1048576),
	}));
	process.exit(0);
} finally {
	proc?.kill("SIGKILL");
	rmSync(dir, { recursive: true, force: true });
}
