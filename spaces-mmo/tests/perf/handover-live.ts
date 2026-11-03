// The space process changes hands under running work (docs/rust-portierung.en.md, R4: switching back in operation). World
// and web run as usual (TypeScript, no model calls), guest figures play through `live-load.ts`, and the space process is
// killed hard and started again on the same files by the other server, in turn: Rust, TypeScript, Rust. Afterwards
// what the figures were answered around each switch, what the processes logged, and both servers read the stopped files
// to the same counts.
//
//   node --experimental-strip-types tests/perf/handover-live.ts
//   HANDOVER_SERVER=../rust/target/release/phi-space-server   the Rust binary (default)
//   HANDOVER_BOTS=6 HANDOVER_SECONDS=150 HANDOVER_PORT=3930    figures, playing time, web port
//   HANDOVER_SWITCH_S=30                                       seconds between two switches
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ROOT } from "../../server/env.ts";
import { RemoteSpace, socketTransport } from "phi-spaces";

const env = (k: string, d: string) => process.env[k] || d;
const BINARY = resolve(ROOT, env("HANDOVER_SERVER", "../rust/target/release/phi-space-server"));
const BOTS = env("HANDOVER_BOTS", "6"), SECONDS = Number(env("HANDOVER_SECONDS", "150")), PORT = env("HANDOVER_PORT", "3930"), SWITCH_S = Number(env("HANDOVER_SWITCH_S", "30"));
if (!existsSync(BINARY)) throw new Error(`no Rust space server at ${BINARY}`);
const dir = mkdtempSync(join(tmpdir(), "mmo-handover-"));
const world = `unix:${join(dir, "world.sock")}`, accounts = `unix:${join(dir, "accounts.sock")}`;
const base = { ...process.env, SPACES_MMO_LLM: "0", SPACES_MMO_DATA: dir, SPACES_MMO_LISTEN: world, SPACES_MMO_ACCOUNTS_LISTEN: accounts, SPACES_MMO_SPACE: world, SPACES_MMO_ACCOUNTS: accounts, PORT };
const logs: string[] = [];
const run = (name: string, command: string, args: string[], extra: Record<string, string> = {}) => {
	const child = spawn(command, args, { cwd: ROOT, env: { ...base, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
	const keep = (d: Buffer) => { for (const l of d.toString("utf8").split("\n").filter(Boolean)) logs.push(`${name} | ${l}`); };
	child.stdout!.on("data", keep); child.stderr!.on("data", keep);
	return child;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => Promise<boolean>, ms: number, what: string) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f().catch(() => false)) return; await sleep(250); } throw new Error(`no ${what}`); };
/** The space process of one server, ready once it answers on its world socket. */
async function space(server: "rust" | "ts"): Promise<ChildProcess> {
	const child = server === "rust" ? run("space-rust", BINARY, ["--profile", "mmo"]) : run("space-ts", process.execPath, ["--no-warnings", "--experimental-strip-types", "server/space-host.ts"]);
	await until(async () => { const t = socketTransport({ path: join(dir, "world.sock") }); try { await new RemoteSpace(t, { attempts: 1, callTimeoutMs: 1000 }).info(); return true; } finally { t.close(); } }, 30_000, `${server} space process`);
	return child;
}
/** A hard kill for the space process; the launcher stops its children itself on SIGTERM. */
const kill = (c: ChildProcess, signal: NodeJS.Signals = "SIGKILL") => new Promise<void>((r) => { if (c.exitCode !== null || c.signalCode !== null) return r(); c.once("exit", () => r()); c.kill(signal); });
const counts = async () => {
	const out: Record<string, unknown> = {};
	for (const [name, path] of [["world", "world.sock"], ["accounts", "accounts.sock"]] as const) {
		const t = socketTransport({ path: join(dir, path) });
		try { out[name] = (await new RemoteSpace(t, { attempts: 1, callTimeoutMs: 5000 }).stats()).byType; } finally { t.close(); }
	}
	return out;
};

const switches: Array<{ at: number; to: string }> = [];
let failed = false;
let current = await space("rust");
const rest = run("world+web", process.execPath, ["--no-warnings", "--experimental-strip-types", "server/launch.ts"], { SPACES_MMO_ROLES: "world,web" });
try {
	await until(async () => (await fetch(`http://127.0.0.1:${PORT}/`)).ok, 120_000, "web");
	const load = run("load", process.execPath, ["--no-warnings", "--experimental-strip-types", "tests/perf/live-load.ts"], { LOAD_URL: `http://127.0.0.1:${PORT}`, LOAD_BOTS: BOTS, LOAD_SECONDS: String(SECONDS), LOAD_OUT: join(dir, "load") });
	const loaded = new Promise<number>((r) => load.once("exit", (code) => r(code ?? 1)));
	await sleep(SWITCH_S * 1000);
	for (const to of ["ts", "rust"] as const) {
		await kill(current);
		switches.push({ at: Date.now(), to });
		current = await space(to);
		console.log(`switched to ${to} after ${Date.now() - switches.at(-1)!.at} ms`);
		await sleep(SWITCH_S * 1000);
	}
	if ((await loaded) !== 0) { failed = true; console.error("the load ended with an error"); }
	// what the figures were answered, before the first switch, in the 15 s after each and the rest
	const commands = readFileSync(join(dir, "load", "commands.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { at: number; kind: string; ms: number; outcome: string });
	const window = (c: { at: number }) => { const s = switches.findLast((x) => x.at <= c.at); return !s ? "before" : c.at - s.at < 15_000 ? `after ${s.to}` : `on ${s.to}`; };
	const summary: Record<string, Record<string, number>> = {};
	for (const c of commands) { const w = (summary[window(c)] ??= {}); w[c.outcome] = (w[c.outcome] ?? 0) + 1; }
	console.log("answers:", JSON.stringify(summary));
	// a walk to the field the figure stands on gets no answer at all (live-load waits for a move that does not come); any
	// other command away from a switch must be answered
	const late = commands.filter((c) => c.outcome === "timeout" && c.kind !== "walk" && !window(c).startsWith("after"));
	if (late.length) { failed = true; console.error(`${late.length} commands timed out away from a switch: ${JSON.stringify(late.slice(0, 5))}`); }
	if (!commands.some((c) => c.at > switches.at(-1)!.at + 15_000 && c.outcome === "ok")) { failed = true; console.error("no command answered after the last switch"); }
	// the processes: a crash, a stack or a refused file is an error
	const bad = logs.filter((l) => !l.startsWith("load") && /Error|panicked|BootBlocked|corrupt|not a protocol/i.test(l));
	if (bad.length) { failed = true; console.error(`process log:\n${bad.slice(0, 20).join("\n")}`); }
	// at rest: the same counts read through both servers
	await kill(rest, "SIGTERM"); await sleep(500);
	const rust = await counts();
	await kill(current);
	current = await space("ts");
	const ts = await counts();
	// every space process leaves a Process entry of its own when it starts, and messages run out between the two reads
	const kept = (c: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Object.fromEntries(Object.entries(v as Record<string, number>).filter(([t]) => t !== "Process" && t !== "Msg").sort())])));
	console.log("counts:", kept(rust));
	if (kept(rust) !== kept(ts)) { failed = true; console.error(`the servers read different counts:\n rust ${JSON.stringify(rust)}\n ts   ${JSON.stringify(ts)}`); }
} finally {
	await kill(rest, "SIGTERM").catch(() => {});
	await kill(current).catch(() => {});
	if (failed) console.error(`kept ${dir}; process log in its output above`); else rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? "handover under load FAILED" : "handover under load passed");
process.exit(failed ? 1 : 0);
