// Commit rates on one disposable disk, as root in the guest: a fresh ext4 for every run, a fixed time, the cells in a
// shuffled order per round so drift of the host's load does not fall on one cell. Every run counts, a run without a
// commit counts as 0. The rate is the commits acknowledged in the time, not a count over the commits that came.
// node power-loss-rate.mjs --disk /dev/vdX --out rates.jsonl [--rounds 5] [--seconds 20] [--seed 1] [--agent ~/phi-probe/agent]
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const disk = arg("--disk"), out = arg("--out"), rounds = Number(arg("--rounds", 5)), seconds = Number(arg("--seconds", 20));
const agent = resolve(arg("--agent", join(dirname(fileURLToPath(import.meta.url)), "..")));
assert.ok(disk && out);
assert.equal(process.getuid(), 0, "needs root for mkfs and mounts");
const MOUNT = "/mnt/phi-rate", run = (cmd, ...args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
let random = Number(arg("--seed", 1)) * 2654435761 % 4294967296;
const next = () => (random = (random * 1664525 + 1013904223) % 4294967296) / 4294967296;
const shuffled = list => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const cells = [];
for (const backend of ["sqlite", "jsonl", "own", "space"]) for (const profile of ["strong", "weak"]) for (const writers of [1, 8]) cells.push({ backend, profile, writers });

async function measure({ backend, profile, writers }, id) {
	run("mkfs.ext4", "-F", "-q", disk);
	mkdirSync(MOUNT, { recursive: true });
	run("mount", "-o", "data=ordered", disk, MOUNT);
	const script = ["own", "space"].includes(backend) ? "test/power-loss-own-probe.ts" : "test/power-loss-probe.ts";
	const writer = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script, "write", "--backend", backend, "--profile", profile, "--dir", join(MOUNT, "run"), "--run-id", id, "--commits", "1000000", "--writers", String(writers)], { cwd: agent, stdio: ["ignore", "pipe", "inherit"] });
	const closed = new Promise(done => writer.once("close", done));
	let commits = 0, first = null, end = Infinity;
	const lines = [];
	for await (const line of createInterface({ input: writer.stdout })) {
		if (!line.startsWith('{"kind":"ack"')) continue;
		const ack = JSON.parse(line);
		// the clock starts at the first commit: the time to load the program is not the store's
		if (first === null) { first = ack.t; end = first + seconds * 1000; setTimeout(() => writer.kill("SIGKILL"), seconds * 1000).unref(); }
		if (ack.t <= end) { commits++; lines.push(ack.ms); }
	}
	await closed;
	for (let i = 0; i < 20; i++) { try { run("umount", MOUNT); break; } catch { await new Promise(done => setTimeout(done, 500)); } }
	lines.sort((a, b) => a - b);
	return { commits, commitsPerSecond: Math.round(commits / seconds * 10) / 10, p50ms: lines[lines.length >> 1] ?? null };
}

for (let round = 1; round <= rounds; round++) for (const cell of shuffled(cells)) {
	const id = `rate-${cell.backend}-${cell.profile}-${cell.writers}-${round}`;
	const timer = setTimeout(() => { execFileSync("pkill", ["-KILL", "-f", `--run-id ${id}`]); }, (seconds + 120) * 1000);
	const load = readFileSync("/proc/loadavg", "utf8").split(" ")[0];
	const result = await measure(cell, id);
	clearTimeout(timer);
	const line = JSON.stringify({ ...cell, round, seconds, guestLoad: Number(load), ...result });
	appendFileSync(out, `${line}\n`);
	console.log(line);
}
