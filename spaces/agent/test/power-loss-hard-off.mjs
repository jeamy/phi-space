// Runs on the controlling host: a libvirt guest is switched off hard while the probe writes, acknowledgements are kept
// out here, and the store is verified after the restart. See docs/agenten-stromausfalltest.en.md.
// VM_PASSWORD=... SSH_ASKPASS=... node power-loss-hard-off.mjs --domain linux2020 --host gate@192.168.122.145 \
//   --image /path/test.raw --out results.jsonl [--runs 3] [--seed 1] [--agent /home/gate/phi-probe/agent] [--strace]
// --strace streams the probe's file syscalls out of the guest into <out>.<run>.trace: a file inside would die in the page cache.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, createWriteStream, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const domain = arg("--domain"), host = arg("--host"), image = arg("--image"), out = arg("--out"), password = process.env.VM_PASSWORD;
const traced = process.argv.includes("--strace"), TRACE = "strace -f -y -s 1 -ttt -T -e trace=write,pwrite64,fsync,fdatasync,ftruncate";
const runs = Number(arg("--runs", 3)), agent = arg("--agent", "/home/gate/phi-probe/agent");
assert.ok(domain && host && image && out && password);
const socket = `/run/user/${process.getuid()}/power-off.sock`;
const master = ["-o", `ControlPath=${socket}`, "-o", "ControlMaster=auto", "-o", "ControlPersist=120", "-o", "ConnectTimeout=5", "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no"];
const virsh = (...args) => execFileSync("sudo", ["-n", "virsh", "-c", "qemu:///system", ...args], { encoding: "utf8" });
const remote = (command, options = {}) => spawnSync("ssh", [...master, host, command], { encoding: "utf8", ...options });
const root = command => remote(`sudo -S -p '' sh -c ${JSON.stringify(command)}`, { input: `${password}\n` });
const node = script => `/home/gate/phi-probe/node/bin/node --experimental-strip-types --no-warnings test/${script}.ts`;
const MOUNT = "/mnt/phi-hard";
let random = Number(arg("--seed", 1)) * 2654435761 % 4294967296;
const next = () => (random = (random * 1664525 + 1013904223) % 4294967296) / 4294967296;

async function ready() {
	for (let i = 0; i < 90; i++) {
		if (remote("true").status === 0) return;
		await sleep(2000);
	}
	throw new Error("the guest did not come back");
}

async function boot() {
	spawnSync("ssh", ["-o", `ControlPath=${socket}`, "-O", "exit", host], { stdio: "ignore" });
	virsh("start", domain);
	await ready();
	virsh("attach-disk", domain, image, "vdb", "--live", "--driver", "qemu", "--subdriver", "raw", "--cache", "none", "--targetbus", "virtio");
	await sleep(1000);
	const errors = root("journalctl -k -b --no-pager | grep -E 'EXT4-fs (error|warning).*vda|I/O error.*vda' || true").stdout.trim();
	assert.equal(errors, "", `the guest's own disk reports errors, series stopped: ${errors}`);
}

await ready();
if (!virsh("domblklist", domain).includes(image)) virsh("attach-disk", domain, image, "vdb", "--live", "--driver", "qemu", "--subdriver", "raw", "--cache", "none", "--targetbus", "virtio");
const backends = arg("--backends", "sqlite,jsonl").split(","), profiles = arg("--profiles", "weak,strong").split(",");
for (let round = 1; round <= runs; round++) for (const backend of backends) for (const profile of profiles) {
	const script = ["own", "space"].includes(backend) ? "power-loss-own-probe" : "power-loss-probe", writers = arg("--writers", "1");
	const id = `hard-${backend}-${profile}-${round}`, acks = `${out}.${id}.acks`, flags = `--backend ${backend} --profile ${profile} --dir ${MOUNT}/run --run-id ${id}`;
	const prepared = root(`umount ${MOUNT} 2>/dev/null; mkfs.ext4 -F -q /dev/vdb && mkdir -p ${MOUNT} && mount -o data=ordered /dev/vdb ${MOUNT} && sync && blkid -o value -s TYPE /dev/vdb`);
	assert.equal(prepared.stdout.trim(), "ext4", prepared.stderr);
	const writer = spawn("ssh", [...master, host, `sudo -S -p '' sh -c 'cd ${agent} && exec ${traced ? `${TRACE} ` : ""}${node(script)} write ${flags} --commits 1000000 --writers ${writers}'`], { stdio: ["pipe", "pipe", traced ? "pipe" : "ignore"] });
	writer.stdin.write(`${password}\n`);
	const file = createWriteStream(acks);
	writer.stdout.pipe(file);
	if (traced) writer.stderr.pipe(createWriteStream(`${out}.${id}.trace`));
	const delay = 6000 + Math.floor(next() * 14000);
	await sleep(delay);
	// Not blocking: acknowledgements already on their way must still reach the file before it is read.
	const closed = once(writer, "close");
	spawn("sudo", ["-n", "virsh", "-c", "qemu:///system", "destroy", domain], { stdio: "ignore" });
	await Promise.race([closed, sleep(5000)]);
	await new Promise(done => file.end(done));
	const lines = readFileSync(acks, "utf8").split("\n").filter(line => line.endsWith("}"));
	const ack = lines.length ? JSON.parse(lines.at(-1)).n : 0;
	writer.kill();
	await boot();
	let result = { status: "no-ack" };
	if (ack > 0) {
		const mounted = root(`mkdir -p ${MOUNT} && mount /dev/vdb ${MOUNT}`);
		assert.equal(mounted.status, 0, mounted.stderr);
		const verified = root(`cd ${agent} && ${node(script)} verify ${flags} --ack ${ack} 2>&1`);
		const text = verified.stdout + verified.stderr, reason = /lost acknowledged commits[^\n']*|the acknowledged [a-z ]*lost/.exec(text)?.[0];
		result = verified.status === 0 ? { status: "pass", ...JSON.parse(text.trim().split("\n").at(-1)) } : { status: reason ? "lost" : "error", reason: reason ?? text.slice(-400) };
		root(`umount ${MOUNT}`);
	}
	const times = lines.map(text => JSON.parse(text).t).filter(Boolean);
	const rate = times.length > 1 ? Math.round((lines.length - 1) / ((times.at(-1) - times[0]) / 1000)) : null;
	const line = JSON.stringify({ backend, profile, writers: Number(writers), rate, round, delayMs: delay, ack, ...result });
	appendFileSync(out, `${line}\n`);
	console.log(line.slice(0, 220));
}
