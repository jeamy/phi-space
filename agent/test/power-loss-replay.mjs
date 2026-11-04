// Device-cache loss in a disposable guest, as root: dm-log-writes records every flushed write in order, a mark goes in
// after each acknowledgement, and the disk is rebuilt at chosen marks holding only what was flushed by then. Unflushed
// writes are gone, and mounting replays the ext4 journal as a real restart would. See docs/agenten-stromausfalltest.en.md.
// node power-loss-replay.mjs --backend sqlite|jsonl|own|space --profile strong|weak --data /dev/vdX --log /dev/vdY
//   [--seconds 15] [--cuts 12] [--seed 1] [--writers 1] [--agent ~/phi-probe/agent]
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, mkdirSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const backend = arg("--backend"), profile = arg("--profile"), data = arg("--data"), log = arg("--log");
const seconds = Number(arg("--seconds", 15)), cuts = Number(arg("--cuts", 12)), seed = Number(arg("--seed", 1));
const writers = arg("--writers", "1"), script = ["own", "space"].includes(backend) ? "test/power-loss-own-probe.ts" : "test/power-loss-probe.ts";
const agent = resolve(arg("--agent", join(dirname(fileURLToPath(import.meta.url)), "..")));
assert.ok(["sqlite", "jsonl", "own", "space"].includes(backend) && ["strong", "weak"].includes(profile) && data && log);
assert.equal(process.getuid(), 0, "needs root for device mapper and mounts");

const SUPER_MAGIC = 0x6a736677736872n, MARK = 8n, DISCARD = 4n;
const MAPPED = "phi-power-log", DEVICE = `/dev/mapper/${MAPPED}`, LIVE = "/mnt/phi-power-live", CUT = "/mnt/phi-power-cut";
const BASE = "/dev/shm/phi-power-base.img", IMAGE = "/dev/shm/phi-power-cut.img";
const id = `replay-${backend}-${profile}-${seed}`, run = (cmd, ...args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const probe = (mode, dir, ...rest) => [process.execPath, ["--experimental-strip-types", "--no-warnings", script, mode, "--backend", backend, "--profile", profile, "--dir", dir, "--run-id", id, ...rest], { cwd: agent }];
let random = seed * 2654435761 % 4294967296;
const next = () => (random = (random * 1664525 + 1013904223) % 4294967296) / 4294967296;

async function write() {
	const sectors = run("blockdev", "--getsz", data).trim();
	run("dd", "if=/dev/zero", `of=${log}`, "bs=1M", "count=1", "oflag=direct");
	run("dmsetup", "create", MAPPED, "--table", `0 ${sectors} log-writes ${data} ${log}`);
	run("mkfs.ext4", "-F", "-q", "-E", "nodiscard,lazy_itable_init=0,lazy_journal_init=0", DEVICE);
	mkdirSync(LIVE, { recursive: true });
	run("mount", "-o", "data=ordered", DEVICE, LIVE);
	const [node, args, options] = probe("write", join(LIVE, "run"), "--commits", "1000000", "--writers", writers);
	const writer = spawn(node, args, { ...options, stdio: ["ignore", "pipe", "inherit"] });
	const timer = setTimeout(() => writer.kill("SIGKILL"), seconds * 1000);
	let acks = 0, last = 0;
	for await (const line of createInterface({ input: writer.stdout })) {
		if (!line.startsWith('{"kind":"ack"')) continue;
		acks = JSON.parse(line).n;
		if (performance.now() - last < 20) continue;
		// The mark is logged after the acknowledgement, and after no write that was not flushed yet.
		run("dmsetup", "message", MAPPED, "0", "mark", `ack-${acks}`);
		last = performance.now();
	}
	clearTimeout(timer);
	run("umount", LIVE);
	run("dmsetup", "remove", MAPPED);
	return acks;
}

function* entries(fd, sectorSize) {
	const head = Buffer.alloc(sectorSize);
	readSync(fd, head, 0, sectorSize, 0);
	assert.equal(head.readBigUInt64LE(0), SUPER_MAGIC, "no dm-log-writes super block");
	const total = head.readBigUInt64LE(16);
	let position = 1n;
	for (let n = 0n; n < total; n++) {
		const entry = Buffer.alloc(sectorSize);
		readSync(fd, entry, 0, sectorSize, position * BigInt(sectorSize));
		const sector = entry.readBigUInt64LE(0), count = entry.readBigUInt64LE(8), flags = entry.readBigUInt64LE(16), length = Number(entry.readBigUInt64LE(24));
		const mark = flags & MARK ? entry.subarray(32, 32 + length).toString().replace(/\0.*$/, "") : null;
		const offset = (position + 1n) * BigInt(sectorSize), carries = !(flags & DISCARD) && !(flags & MARK) && count > 0n;
		yield { sector, count, mark, offset: carries ? offset : null };
		position += 1n + (carries ? count : 0n);
	}
}

function verify(ack) {
	copyFileSync(BASE, IMAGE);
	mkdirSync(CUT, { recursive: true });
	run("mount", "-o", "loop", IMAGE, CUT);
	try {
		const [node, args, options] = probe("verify", join(CUT, "run"), "--ack", String(ack));
		const result = spawnSync(node, args, { ...options, encoding: "utf8" });
		if (result.status === 0) return { ack, status: "pass", ...JSON.parse(result.stdout.trim().split("\n").at(-1)) };
		const reason = /lost acknowledged commits[^\n']*|the acknowledged [a-z ]*lost|[^\n]*Error[^\n]*/.exec(result.stderr)?.[0] ?? result.stderr.slice(-300);
		return { ack, status: /lost/.test(reason) ? "lost" : "error", reason };
	} finally { run("umount", CUT); }
}

const acks = await write();
const fd = openSync(log, "r"), head = Buffer.alloc(512);
readSync(fd, head, 0, 512, 0);
const sectorSize = head.readUInt32LE(24);
const marks = [];
let index = 0, largest = 0;
for (const e of entries(fd, sectorSize)) {
	index++;
	if (e.count > 0n) largest = Math.max(largest, Number(e.count) * sectorSize);
	if (e.mark?.startsWith("ack-")) marks.push({ index, ack: Number(e.mark.slice(4)) });
}
assert.ok(marks.length > 0, "the log carries no marks");
const chosen = new Set();
while (chosen.size < Math.min(cuts, marks.length)) chosen.add(marks[Math.floor(next() * marks.length)].index);
chosen.add(marks.at(-1).index);

rmSync(BASE, { force: true });
closeSync(openSync(BASE, "w"));
run("truncate", "-s", run("blockdev", "--getsize64", data).trim(), BASE);
const base = openSync(BASE, "r+"), results = [];
const buffer = Buffer.alloc(Math.max(largest, sectorSize));
let at = 0;
for (const e of entries(fd, sectorSize)) {
	at++;
	if (e.offset !== null) {
		const bytes = Number(e.count) * sectorSize;
		readSync(fd, buffer, 0, bytes, e.offset);
		writeSync(base, buffer, 0, bytes, Number(e.sector) * 512);
	}
	if (chosen.has(at)) results.push(verify(Number(e.mark.slice(4))));
}
closeSync(base); closeSync(fd);
rmSync(BASE); rmSync(IMAGE, { force: true });
const count = status => results.filter(r => r.status === status).length;
console.log(JSON.stringify({ kind: "cell", backend, profile, writers: Number(writers), seed, seconds, acks, marks: marks.length, entries: index, pass: count("pass"), lost: count("lost"), error: count("error"), results }));
