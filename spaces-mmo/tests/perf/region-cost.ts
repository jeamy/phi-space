// What 200 figures (LOAD_BOTS) cost the world split into its regions (tests/stack.ts startRegions, SQLite): a space
// process, a world worker and an npc process per region (LOAD_NPCS=0: none), the web part in this process, LOAD_SECONDS of tests/perf/live-load.ts. Prints
// one JSON line: commands, commands per second, p50/p95, and the CPU share of each process by role and region (the
// share of one core, in percent).
//
//   LOAD_BOTS=200 LOAD_SECONDS=60 node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/region-cost.ts
import { spawn, execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRegions } from "../stack.ts";
import { startServer as startWeb } from "../../server/index.ts";
const TICK = Number(execFileSync("getconf", ["CLK_TCK"]).toString().trim()) || 100;
const cpu = () => { const out: Record<string, number> = {}; for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) { let cmd = "", stat = "", env = ""; try { cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8"); stat = readFileSync(`/proc/${pid}/stat`, "utf8"); env = readFileSync(`/proc/${pid}/environ`, "utf8"); } catch { continue; } const f = stat.slice(stat.lastIndexOf(")") + 2).split(" "); if (Number(f[1]) !== process.pid) continue; const role = (cmd.match(/server\/([a-z-]+)\.ts/) ?? [])[1]; const region = (env.match(/SPACES_MMO_REGION=([a-z]+)/) ?? [])[1] ?? (env.includes("SPACES_MMO_SPACES=accounts") ? "accounts" : "-"); out[`${role}:${region}`] = (out[`${role}:${region}`] ?? 0) + ((Number(f[11]) + Number(f[12])) / TICK) * 1000; } return out; };
const dataDir = await mkdtemp(join(tmpdir(), "mmo-rc-data-"));
const r = await startRegions({ worldEnv: { SPACES_MMO_GUESTS_PER_HOUR: "1000" }, dataDir });
process.env.SPACES_MMO_GUESTS_PER_HOUR = "1000";
// every region's npc process, as on the servers (each plays every role, a role only where its NPC stands)
// (the roles of SPACES_MMO_NPCS, as tests/perf/space-cost.ts; LOAD_NPC_ROLES=all: every role of the world)
if (process.env.LOAD_NPCS !== "0") for (const id of r.ids) await r.npcProcess(id, process.env.LOAD_NPC_ROLES === "all" ? { SPACES_MMO_NPCS: "" } : {});
const srv = await startWeb({ port: 0, space: "unix:/nowhere", accounts: r.accounts, regions: r.list });
const out = await mkdtemp(join(tmpdir(), "mmo-rc-"));
await new Promise((ok) => setTimeout(ok, 3000));
const c0 = cpu(), w0 = process.cpuUsage(), t0 = Date.now();
await new Promise<void>((ok, fail) => { const c = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", "tests/perf/live-load.ts"], { env: { ...process.env, LOAD_URL: srv.url, LOAD_BOTS: process.env.LOAD_BOTS || "200", LOAD_SECONDS: process.env.LOAD_SECONDS || "60", LOAD_OUT: out }, stdio: ["ignore", "inherit", "inherit"] }); c.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`exit ${code}`)))); });
const c1 = cpu(), wall = Date.now() - t0, wu = process.cpuUsage(w0);
const rows = (await readFile(join(out, "commands.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
const ms = rows.filter((x: any) => x.outcome !== "timeout").map((x: any) => x.ms).sort((a: number, b: number) => a - b);
const share = Object.fromEntries(Object.keys(c1).sort().map((k) => [k, Math.round(((c1[k]! - (c0[k] ?? 0)) / wall) * 100)]));
console.log(JSON.stringify({ commands: rows.length, perSecond: Math.round((rows.length / (wall / 1000)) * 10) / 10, p50: ms[Math.floor(ms.length / 2)], p95: ms[Math.floor(ms.length * 0.95)], timeouts: rows.filter((x: any) => x.outcome === "timeout").length, outcomes: rows.reduce((m: any, x: any) => ((m[x.outcome] = (m[x.outcome] ?? 0) + 1), m), {}), webCpu: Math.round(((wu.user + wu.system) / 1000 / wall) * 100), cpuPercent: share }));
await srv.close(); await r.close(); process.exit(0);
