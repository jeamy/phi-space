// What a player command costs the space process: a stack as on the servers (the space on SQLite, a world worker, every
// NPC role, the web process), LOAD_BOTS figures of live-load.ts playing for LOAD_SECONDS, and the CPU time the space
// process spent meanwhile (/proc/<pid>/stat, Linux), divided by the commands. The latency on a fast machine says little
// while the space is not saturated; its CPU time per command says how many commands a core carries.
//
//   LOAD_BOTS=50 LOAD_SECONDS=60 node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/space-cost.ts
//
// Prints one JSON line: commands, commands per second, p50/p95 answer, space CPU ms per command, space CPU share.
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, startStack } from "../stack.ts";

const BOTS = process.env.LOAD_BOTS || "50", SECONDS = process.env.LOAD_SECONDS || "60";
const TICK = Number(execFileSync("getconf", ["CLK_TCK"]).toString().trim()) || 100;

/** CPU ms (user + system) of this process's child that runs `script`. */
function cpuOf(script: string): number {
	for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
		let cmd = "", stat = "";
		try { cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8"); stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { continue; }
		const f = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // state, ppid, …, utime (11), stime (12)
		if (!cmd.includes(script) || Number(f[1]) !== process.pid) continue;
		return ((Number(f[11]) + Number(f[12])) / TICK) * 1000;
	}
	throw new Error(`no process runs ${script}`);
}

const data = await mkdtemp(join(tmpdir(), "mmo-cost-")), out = await mkdtemp(join(tmpdir(), "mmo-cost-out-"));
const stack = await startStack({ dataDir: data });
await stack.npcProcess();
const srv = await startServer({ stack });
try {
	await new Promise((r) => setTimeout(r, 3000)); // the NPCs and the world settle in
	const cpu0 = cpuOf("server/space-host.ts"), t0 = Date.now();
	await new Promise<void>((ok, fail) => {
		const c = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", "tests/perf/live-load.ts"], { env: { ...process.env, LOAD_URL: srv.url, LOAD_BOTS: BOTS, LOAD_SECONDS: SECONDS, LOAD_OUT: out }, stdio: ["ignore", "inherit", "inherit"] });
		c.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`live-load exited ${code}`))));
	});
	const cpu = cpuOf("server/space-host.ts") - cpu0, wall = Date.now() - t0;
	const rows = (await readFile(join(out, "commands.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { ms: number; outcome: string });
	const ms = rows.filter((r) => r.outcome !== "timeout").map((r) => r.ms).sort((a, b) => a - b);
	const at = (p: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] ?? null;
	console.log(JSON.stringify({ bots: Number(BOTS), seconds: Number(SECONDS), commands: rows.length, perSecond: Math.round((rows.length / (wall / 1000)) * 10) / 10, p50: at(0.5), p95: at(0.95), timeouts: rows.filter((r) => r.outcome === "timeout").length, spaceCpuMsPerCommand: Math.round((cpu / rows.length) * 100) / 100, spaceCpuShare: Math.round((cpu / wall) * 100) / 100 }));
} finally {
	await srv.close();
	await stack.close();
	await rm(data, { recursive: true, force: true });
	await rm(out, { recursive: true, force: true });
}
