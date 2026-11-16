// `npm run testbed:federation -- restore`: a data Space restored from its backup onto another host, while the host it lived on is lost and fenced. The
// target checks the fence over ssh (`fence-ssh`, a real sshd in its own container) and gets the control host's receipt over its private recovery endpoint;
// a client is answered from the backup, without what was written after it.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash, X509Certificate } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { FOREVER, SqliteRecoveryRegister, core, createSpace, listSpaces, provisionFileSigner, snapshotSpace, spaceDoc } from "../../../src/index.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../../src/context.ts";
import { openSqliteHost } from "../../../src/store/sqlite.ts";
import { provision } from "./provision.ts";
import { DATA_B, FENCE_SSH, PORT, peer } from "./net.ts";
import { certify, harness } from "./replica.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const container = (service: string) => `phi-federation-${service}-1`;

/** ssh: the server's host key, the hosts' client key, each side knowing the other, and a passwd entry so that the client runs under FED_UID. */
export function provisionSsh(dir: string) {
	// ssh: the server's host key, the target's client key, each side knowing the other
	const ssh = join(dir, "ssh"), home = join(dir, "ssh-client"), keygen = (file: string) => execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file]);
	mkdirSync(ssh, { mode: 0o700 }); mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
	keygen(join(ssh, "host_ed25519")); keygen(join(home, ".ssh", "id_ed25519"));
	writeFileSync(join(ssh, "authorized_keys"), readFileSync(join(home, ".ssh", "id_ed25519.pub")), { mode: 0o600 });
	writeFileSync(join(home, ".ssh", "known_hosts"), `${FENCE_SSH} ${readFileSync(join(ssh, "host_ed25519.pub"), "utf8")}`, { mode: 0o600 });
	writeFileSync(join(ssh, "sshd_config"), ["Port 22", "HostKey /fed/ssh/host_ed25519", "AuthorizedKeysFile /fed/ssh/authorized_keys", "StrictModes no", "PasswordAuthentication no", "KbdInteractiveAuthentication no", "UsePAM no", "PermitRootLogin no", "AllowTcpForwarding no", "X11Forwarding no", "PermitTTY no", "PidFile /run/sshd.pid",
		"ForceCommand /usr/local/bin/node --experimental-strip-types --no-warnings /opt/phi-spaces/test/testbed/local-federation/fence-status.ts", ""].join("\n"), { mode: 0o600 });
	writeFileSync(join(dir, "passwd"), `root:x:0:0::/root:/bin/sh\nfed:x:${process.getuid!()}:${process.getgid!()}::/fed/ssh-client:/bin/sh\n`, { mode: 0o644 });
	mkdirSync(join(dir, "snapshots"), { mode: 0o700 });
}

async function provisionRestore(dir: string) {
	certify(dir, ["data-b", "fencing"]);
	const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
	const write = (name: string, v: unknown) => writeFileSync(join(dir, name), JSON.stringify(v), { mode: 0o600 });
	const print = (name: string) => createHash("sha256").update(new X509Certificate(readFileSync(join(dir, `${name}.crt`))).raw).digest("hex");
	write("register-peers.json", { ...read("register-peers.json"), [print("data-b")]: {} });
	write("peers.json", [...read("peers.json"), peer("data-b-peer", DATA_B, ["space-hosts"])]);
	const key = provisionFileSigner(join(dir, "data-b-key.json")), operator = provisionFileSigner(join(dir, "operator-key.json")), now = Date.now(), state = read("state.json"), member = read("member.config.json"), control = read("control.config.json");
	// the target knows the Space by the same identity: its key, its store, its permit and the independent records of the restore
	const store = await openSqliteHost(join(dir, "control.sqlite"));
	await store.commit(async (tx) => { const s = await spaceDoc(tx, control.controlSpaceId, now); core.write(s, now, { type: "PeerKey", fields: { peerId: "data-b-peer", keyId: key.keyId, principal: "data-b-peer", algorithm: key.algorithm, publicKey: key.publicKey, roles: ["host"], scope: ["*"], state: "active" } }, null, FOREVER); }, ctx);
	await store.close(ctx);
	const source = await openSqliteHost(join(dir, "member.sqlite")), notes = (await listSpaces(source, ctx)).find((i) => i.spaceId === state.notes)!;
	await source.close(ctx);
	const target = await openSqliteHost(join(dir, "data-b.sqlite"));
	await target.commit((tx) => createSpace(tx, "notes", now, { spaceId: notes.spaceId, incarnation: notes.incarnation }).then(() => {}), ctx);
	await target.commit((tx) => spaceDoc(tx, undefined, now).then(() => {}), ctx);
	const spaces = Object.fromEntries((await listSpaces(target, ctx)).map((i) => [i.spaceId, { state: "active", authorityId: "authority", dataIncarnation: i.incarnation, role: "local", transitionId: "t1" }]));
	await target.close(ctx);
	const external = new SqliteRecoveryRegister(join(dir, "external.sqlite"));
	await external.compareAndSet("boot:data-host-b", null, { hostId: "data-host-b", state: "active", spaces } as never);
	await external.compareAndSet(`placement:${notes.spaceId}`, null, { hostId: "data-host", authorityId: "authority", incarnation: notes.incarnation, primaryEpoch: 1 } as never);
	await external.compareAndSet("host-key:data-host-b", null, { peerId: "data-b-peer", keyId: key.keyId, algorithm: key.algorithm, publicKey: key.publicKey, state: "active", authorityId: "authority" } as never);
	external.close();
	const pinned = { algorithm: operator.algorithm, publicKey: operator.publicKey };
	write("control.config.json", { ...control, recovery: { path: "/fed/recovery-control.sock", operator: pinned } });
	write("data-b.config.json", { ...member, membership: undefined, capabilities: undefined, runGates: undefined, spaceLifecycle: undefined, hostId: "data-host-b", peerId: "data-b-peer", listen: { host: DATA_B, port: PORT.member }, keyFile: "/fed/data-b-key.json", installedRegisterFile: "/fed/installed-data-b.sqlite",
		registerTls: { ...member.registerTls, certFile: "/fed/data-b.crt", keyFile: "/fed/data-b.key" },
		recovery: { path: "/fed/recovery-data-b.sock", operator: pinned, writerTls: { ...member.registerTls, certFile: "/fed/operator.crt", keyFile: "/fed/operator.key" }, snapshotDirectory: "/fed/snapshots", fenceTargets: { "data-host": `data-host@${FENCE_SSH}` }, controlEndpoint: { path: "/fed/recovery-control.sock" } } });
	write("state.json", { ...state, notesIncarnation: notes.incarnation });
	provisionSsh(dir);
}

/** The backup: the Space as the source's store holds it now, read from a copy while the host runs. */
export async function backup(dir: string, spaceId: string, store = "member", file = "notes.json", take: (host: Awaited<ReturnType<typeof openSqliteHost>>, spaceId: string, c: typeof ctx) => Promise<unknown> = snapshotSpace) {
	const copy = mkdtempSync(join(tmpdir(), "phi-fed-copy-"));
	for (const f of readdirSync(dir).filter((n) => n.startsWith(`${store}.sqlite`))) copyFileSync(join(dir, f), join(copy, f));
	const host = await openSqliteHost(join(copy, `${store}.sqlite`));
	writeFileSync(join(dir, "snapshots", file), JSON.stringify(await take(host, spaceId, ctx)), { mode: 0o600 });
	await host.close(ctx);
	rmSync(copy, { recursive: true, force: true });
}

export async function restoreScenario() {
	const { dir, env, compose, drive, started, docker, runs } = harness("restore", "restore-driver.ts");
	let fencing: ChildProcess | undefined;
	try {
		await provision(dir);
		await provisionRestore(dir);
		compose("up", "-d", "--no-build", "register", "management", "control", "member", "client", "fence-ssh", "data-b");
		fencing = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, "test/testbed/local-federation/fencing-service.ts"), dir], { stdio: ["ignore", "pipe", "inherit"] });
		await new Promise((resolve, reject) => { fencing!.stdout!.once("data", resolve); fencing!.once("exit", reject); });
		started("member", "member ready"); started("data-b", "data-b ready");
		runs(container("control"), env.CONTROL_IMPL); runs(container("member"), env.MEMBER_IMPL); runs(container("data-b"), env.DATA_B_IMPL);
		assert.equal(drive("note", "data-host", "n1").write, "answered");
		assert.deepEqual(drive("note", "data-host", "n2").notes, ["n1", "n2"]);
		await backup(dir, JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).notes);
		assert.deepEqual(drive("note", "data-host", "n3").notes, ["n1", "n2", "n3"], "a write after the backup");
		// the host is lost: killed is not fenced, and the target refuses to restore over it
		docker("kill", "-s", "KILL", container("member"));
		const early = drive("restore", "data-host-b", "data-b");
		assert.ok(early.submit, "a killed host that may come back is no source to restore over");
		assert.match(early.submit.message, /not independently stopped and restart-locked/);
		assert.equal(drive("fence", "data-host").fenced, true);
		const restored = drive("restore", "data-host-b", "data-b");
		assert.deepEqual(restored.states, ["blocked", "waiting", "completed"]); assert.equal(restored.placement, "data-host-b"); assert.equal(restored.source, "fenced");
		// the client is answered from the backup: what was written after it is gone, what came back waits for the operator's release
		assert.deepEqual(drive("notes", "data-host-b").notes, ["n1", "n2"]);
		assert.equal(drive("take", "data-host-b", "n1").take, "none", "a restored entry is not taken before it is released");
		assert.equal(drive("note", "data-host-b", "n4").write, "answered");
		assert.equal(drive("release", "data-host-b", "data-b").release.count, 2);
		assert.equal(drive("take", "data-host-b", "n1").take, "taken");
		assert.deepEqual(drive("notes", "data-host-b").notes, ["n2", "n4"]);
		// the old host started by hand is refused
		docker("start", container("member"));
		assert.notEqual(execFileSync("timeout", ["60", "docker", "wait", container("member")], { encoding: "utf8" }).trim(), "0", "the fenced host does not boot");
		assert.ok(execFileSync("sh", ["-c", `docker logs ${container("member")} 2>&1`], { encoding: "utf8" }).split("\n").some((l) => l.startsWith("BootBlocked")), "it is refused by a boot check");
		console.log("restore scenario passed");
	} catch (e) {
		console.error((e as { stderr?: string }).stderr ?? e);
		for (const s of ["data-b", "control", "fence-ssh"]) console.error(compose("logs", "--tail", "15", s));
		process.exitCode = 1;
	} finally {
		fencing?.kill();
		compose("down", "-v", "--remove-orphans");
		if (process.env.FED_KEEP) console.log(`kept ${dir}`); else rmSync(dir, { recursive: true, force: true });
	}
}
