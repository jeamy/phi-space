// The replica handover of spaces-files with a real fencing adapter (docs/zanzibar-agent-filesystem-plan.en.md, section
// 6.7): two sites in containers of their own (compose project `phi-files-replica`, compose.yml), each with its own
// directories, its primary/sync journal over phi-spaces' signed replica transport and the standby of the deployment
// state and the blobs over mutual TLS (tests/support/replica-site.ts, driven with `docker exec`). Boot permits live in
// a recovery register both reach. phi-spaces' container fencing adapter runs here, on this machine, at the network's
// gateway behind its mutual-TLS service: only site b's operator certificate may call it, and it fences site a by its
// pinned container alone.
//
// A revocation commits, a save commits and its reply is lost, site a's container is killed (SIGKILL: the machine is
// gone). Site b fences it through the service (restart policy `no`, the unit's drop-in), checks the proof, is promoted
// by `promote` and runs alone after `degradeToSingle`. There the revocation holds and the save's retry answers from its
// receipt. Site a cannot come back through its unit; released into quarantine, its store commits nothing.
//
//   npm --prefix spaces-files run testbed:replica [-- --keep]
//
// Changes containers on this machine only: it builds `phi-files-replica:local`, starts and removes the project's two
// containers and its network (`--keep` leaves them running). TB_DIR (default spaces-files/.local/testbed-replica) is
// provisioned anew on every run.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ContainerFencing, execRunner, provisionFileSigner, releaseHostToQuarantine, serveFencing, SqliteRecoveryRegister,
	type CommandRunner, type PrimarySyncConfig,
} from "phi-spaces";

const HERE = dirname(fileURLToPath(import.meta.url)), FILES = join(HERE, "..", ".."), REPO = join(FILES, "..");
const TB = process.env.TB_DIR || join(FILES, ".local", "testbed-replica");
const keep = process.argv.includes("--keep");
const PROJECT = "phi-files-replica", IMAGE = "phi-files-replica:local";
const IP = { gateway: "172.30.9.1", a: "172.30.9.2", b: "172.30.9.3" }, PORT = { journal: 7501, standby: 7502, fencing: 7503 };
const container = (site: "a" | "b") => `${PROJECT}-site-${site}-1`;
const unit = (site: "a" | "b") => `${PROJECT}-site-${site}.service`;
const GENESIS: PrimarySyncConfig = { spaceId: "files-store", authorityId: "files", primaryEpoch: 1, replicaConfigVersion: 1, primaryReplica: "a", standbyReplica: "b" };
const permit = (role: "primary" | "standby") => ({ state: "active", authorityId: "files", dataIncarnation: "inc", role, primaryEpoch: 1, replicaConfigVersion: 1, durability: "sync", transitionId: "genesis" });
const step = (s: string) => console.log(`[testbed:replica] ${s}`);
const sh = (cmd: string, args: string[], o: { env?: NodeJS.ProcessEnv; quiet?: boolean } = {}) =>
	execFileSync(cmd, args, { stdio: o.quiet ? ["ignore", "pipe", "pipe"] : "inherit", env: { ...process.env, ...o.env } })?.toString() ?? "";
const compose = (args: string[]) => sh("docker", ["compose", "-f", join(HERE, "compose.yml"), ...args], { env: { TB_DIR: TB, TB_UID: String(process.getuid!()), TB_GID: String(process.getgid!()) } });

/** The context of the image: the sources the sites run, nothing else (no node_modules, no stores, no keys). */
function buildImage() {
	const ctx = join(TB, "context");
	rmSync(ctx, { recursive: true, force: true });
	for (const p of ["package.json", "src"]) cpSync(join(REPO, "spaces", p), join(ctx, "spaces", p), { recursive: true });
	for (const p of ["package.json", "server", "client", "tests/support"]) cpSync(join(FILES, p), join(ctx, "spaces-files", p), { recursive: true });
	sh("docker", ["build", "-q", "-t", IMAGE, "-f", join(HERE, "Dockerfile"), ctx], { quiet: true });
	rmSync(ctx, { recursive: true, force: true });
}

function provision() {
	const k = join(TB, "keys");
	mkdirSync(k, { recursive: true, mode: 0o700 });
	const openssl = (args: string[]) => execFileSync("openssl", args, { cwd: k, stdio: "ignore" });
	const priv = (f: string) => chmodSync(join(k, f), 0o600);
	// the fencing service's CA, its server certificate at the gateway, and site b's operator certificate
	openssl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=files-testbed-ca", "-days", "2"]);
	for (const [name, ext] of [["fencing", `subjectAltName=IP:${IP.gateway}\nextendedKeyUsage=serverAuth\n`], ["operator-b", "extendedKeyUsage=clientAuth\n"]] as const) {
		openssl(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`]);
		writeFileSync(join(k, `${name}.ext`), ext);
		openssl(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "2", "-extfile", `${name}.ext`]);
		priv(`${name}.key`); priv(`${name}.crt`);
	}
	priv("ca.crt");
	// the standby's TLS: each site's self-signed certificate, pinned by the other
	const tls: Record<string, { cert: string; key: string }> = {};
	for (const s of ["a", "b"]) {
		openssl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", `tls-${s}.key`, "-out", `tls-${s}.pem`, "-days", "2", "-subj", `/CN=files-${s}`, "-addext", "subjectAltName=DNS:localhost"]);
		tls[s] = { cert: readFileSync(join(k, `tls-${s}.pem`), "utf8"), key: readFileSync(join(k, `tls-${s}.key`), "utf8") };
	}
	const signers = { a: provisionFileSigner(join(k, "a.json")), b: provisionFileSigner(join(k, "b.json")) };
	const pin = (h: "a" | "b") => ({ hostId: h, algorithm: "ed25519" as const, publicKey: signers[h].publicKey });
	const config = (self: "a" | "b", other: "a" | "b") => writeFileSync(join(TB, `${self}.json`), JSON.stringify({
		self, root: `/tb/${self}`, signerFile: `/tb/keys/${self}.json`, register: "/tb/register/register.sqlite", genesis: GENESIS, dataIncarnation: "inc", remote: pin(other),
		bind: IP[self], remoteHost: IP[other], saveTxnLeaseMs: 5000, journalPort: PORT.journal, standbyPort: PORT.standby,
		standbyTls: { ...tls[self], ca: tls[other].cert }, clientTls: { ...tls[self], ca: tls[other].cert },
		fencing: self === "b" ? { tls: { host: IP.gateway, port: PORT.fencing, serverName: IP.gateway, caFile: "/tb/keys/ca.crt", certFile: "/tb/keys/operator-b.crt", keyFile: "/tb/keys/operator-b.key" } } : null,
	}), { mode: 0o600 });
	config("a", "b"); config("b", "a");
	return { operator: createHash("sha256").update(new X509Certificate(readFileSync(join(k, "operator-b.crt"))).raw).digest("hex") };
}

/**
 * docker stays real; systemctl is answered over the container, and `start` obeys the drop-in as ConditionPathExists
 * would, so no unit of this machine's user is touched (as in spaces/test/testbed/local-federation/fencing-service.ts).
 */
const fenceRunner = (unitDir: string): CommandRunner => async (command, args) => {
	if (command !== "systemctl") return execRunner(command, args);
	const [, action, name] = args, c = name?.replace(/\.service$/, "") + "-1";
	if (action === "daemon-reload") return { code: 0, stdout: "", stderr: "" };
	if (action === "is-active") { const r = await execRunner("docker", ["inspect", "--format", "{{.State.Running}}", c]); return { code: 0, stdout: r.stdout.trim() === "true" ? "active\n" : "inactive\n", stderr: "" }; }
	if (action === "stop") return execRunner("docker", ["stop", "--time", "30", c]);
	if (action === "start") return existsSync(join(unitDir, `${name}.d`, "zz-phi-spaces-fenced.conf")) ? { code: 1, stdout: "", stderr: "unit is fenced" } : execRunner("docker", ["start", c]);
	return { code: 1, stdout: "", stderr: `unexpected systemctl ${action}` };
};

type Site = { call(op: string, args?: Record<string, unknown>): Promise<any>; end(): Promise<void> };
class Refused extends Error { readonly code: string | null; constructor(code: string | null, m: string) { super(m); this.code = code; } }
async function site(s: "a" | "b"): Promise<Site> {
	const child: ChildProcess = spawn("docker", ["exec", "-i", container(s), "node", "--no-warnings", "--experimental-strip-types", "tests/support/replica-site.ts", `/tb/${s}.json`], { stdio: ["pipe", "pipe", "inherit"] });
	const waiting = new Map<number, (m: any) => void>();
	let ready!: () => void;
	const up = new Promise<void>((r) => { ready = r; });
	createInterface({ input: child.stdout! }).on("line", (line) => {
		let m: any;
		try { m = JSON.parse(line); } catch { return; }
		if (m.ready) return ready();
		if (!m.ok) step(`site ${s} refused: ${m.error}`);
		waiting.get(m.id)?.(m);
		waiting.delete(m.id);
	});
	const exited = new Promise<void>((r) => child.once("exit", () => { for (const w of waiting.values()) w({ ok: false, error: `site ${s} ended` }); waiting.clear(); r(); }));
	await Promise.race([up, exited.then(() => { throw new Error(`site ${s} ended before it was ready`); })]);
	let next = 1;
	return {
		call: (op, args = {}) => new Promise((resolve, reject) => {
			const id = next++;
			waiting.set(id, (m) => m.ok ? resolve(m.result) : reject(new Refused(m.code ?? null, m.error)));
			child.stdin!.write(JSON.stringify({ id, op, ...args }) + "\n");
		}),
		end: async () => { child.stdin!.end(); if (child.exitCode === null) await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); child.kill(); },
	};
}
const code = (c: string) => (e: Error & { code?: string | null }) => { assert.equal(e.code, c, e.message); return true; };
const inspect = (s: "a" | "b") => JSON.parse(sh("docker", ["inspect", "--format", "{{json .State.Running}} {{json .HostConfig.RestartPolicy.Name}}", container(s)], { quiet: true }).trim().split(" ").join(",").replace(/^/, "[").replace(/$/, "]")) as [boolean, string];

async function main() {
	sh("docker", ["version", "--format", "{{.Server.Version}}"], { quiet: true });
	compose(["down", "--remove-orphans", "--volumes"]);
	rmSync(TB, { recursive: true, force: true });
	mkdirSync(TB, { recursive: true, mode: 0o700 });
	step("building the image");
	buildImage();
	const { operator } = provision();
	const register = new SqliteRecoveryRegister(join(TB, "register", "register.sqlite"));
	await register.compareAndSet("boot:a", null, { hostId: "a", state: "active", spaces: { [GENESIS.spaceId]: permit("primary") } });
	await register.compareAndSet("boot:b", null, { hostId: "b", state: "active", spaces: { [GENESIS.spaceId]: permit("standby") } });
	step("starting the two sites");
	compose(["up", "-d"]);
	const unitDir = join(TB, "units");
	mkdirSync(unitDir);
	const adapter = new ContainerFencing({ pins: { a: { container: container("a"), unit: unit("a") } }, unitDir, stateFile: join(TB, "fence-state.json"), run: fenceRunner(unitDir) });
	const fencing = await serveFencing(adapter, { caFile: join(TB, "keys", "ca.crt"), certFile: join(TB, "keys", "fencing.crt"), keyFile: join(TB, "keys", "fencing.key"), host: IP.gateway, port: PORT.fencing, peers: { [operator]: { operator: true } }, allowAddresses: [IP.b] });
	let a: Site | null = null, b: Site | null = null;
	try {
		b = await site("b");
		const ports = await b.call("listen");
		a = await site("a");
		await a.call("open", ports);
		step(`site a is the primary, site b its standby (journal :${ports.journal}, state and blobs :${ports.standby})`);
		const admin = { actorId: "lea", homeName: "lea", issuer: "i", subject: "lea" };
		await a.call("createTenant", { tenant: "acme", admin });
		await a.call("provisionActor", { tenant: "acme", by: { actorKind: "user", actorId: "lea" }, actorId: "bob", home: "bob", login: { issuer: "i", subject: "bob" } });
		const lea = await a.call("login", { tenant: "acme", login: { issuer: "i", subject: "lea" } });
		const bob = await a.call("login", { tenant: "acme", login: { issuer: "i", subject: "bob" } });
		const ids: string[] = await a.call("ids", { handle: lea, n: 5 });
		const team = { handle: lea, workspace: "team" }, bobView = { role: "viewer", who: { kind: "user", id: "bob" }, path: "." };
		await a.call("createWorkspace", { handle: lea, name: "team", owner: { kind: "user", id: "lea" }, opId: ids[4] });
		await a.call("write", { ...team, path: "plan.md", text: "v1", base: 0, opId: ids[0] });
		await a.call("grant", { ...team, ...bobView, opId: ids[1] });
		assert.equal((await a.call("read", { handle: bob, workspace: "team", path: "plan.md" })).text, "v1");
		assert.deepEqual(await a.call("revoke", { ...team, ...bobView, opId: ids[2] }), { status: "revoked" });
		await a.call("failNext", { at: "commit:after" });
		await assert.rejects(a.call("write", { ...team, path: "plan.md", text: "v2", base: 1, opId: ids[3] }), code("unavailable"));
		step("revocation committed; a save committed and its reply was lost");

		sh("docker", ["kill", container("a")], { quiet: true });
		await a.end(); a = null;
		step("site a's container killed");
		const promoted = await b.call("promote");
		assert.equal(promoted.proof.kind, "container");
		assert.deepEqual(promoted.proof.evidence.container, container("a"));
		assert.deepEqual([promoted.config.primaryReplica, promoted.config.durability, promoted.config.primaryEpoch], ["b", "single", 3]);
		assert.equal(promoted.boot.state, "fenced");
		assert.deepEqual(inspect("a"), [false, "no"], "site a is stopped and restart-locked");
		step("site b fenced site a through the container adapter (stopped, restart policy no, unit locked), promoted (epoch 2), alone (epoch 3)");

		const retry = async <R>(f: () => Promise<R>): Promise<R> => {
			for (let i = 0; ; i++) {
				try { return await f(); } catch (e) { if ((e as Refused).code !== "unavailable" || i > 1200) throw e; await new Promise((r) => setTimeout(r, 25)); }
			}
		};
		await assert.rejects(retry(() => b!.call("read", { handle: bob, workspace: "team", path: "plan.md" })), code("notFound"), "the revocation holds");
		assert.deepEqual(await retry(() => b!.call("read", { handle: lea, workspace: "team", path: "plan.md" })), { version: 2, text: "v2" });
		assert.deepEqual(await b.call("write", { ...team, path: "plan.md", text: "v2", base: 1, opId: ids[3] }), { version: 2 });
		assert.deepEqual(await b.call("revoke", { ...team, ...bobView, opId: ids[2] }), { status: "revoked" });
		assert.deepEqual(await b.call("read", { handle: lea, workspace: "team", path: "plan.md" }), { version: 2, text: "v2" });
		step("on site b: the revocation holds, the lost save is there, its retry answers from its receipt, nothing applied twice");

		const start = await fenceRunner(unitDir)("systemctl", ["--user", "start", unit("a")]);
		assert.notEqual(start.code, 0, "the fenced unit does not start");
		assert.equal(inspect("a")[0], false);
		await releaseHostToQuarantine(register, "a", "rejoin-a", adapter);
		assert.equal((await register.get<{ state: string }>("boot:a"))!.value.state, "quarantine");
		a = await site("a");
		await assert.rejects(a.call("probeStore", ports), /boot permit does not match/, "the old primary's store commits nothing in quarantine");
		step("site a: its unit refuses to start while fenced; released into quarantine, its store commits nothing");
		step("passed");
	} finally {
		await a?.end().catch(() => {});
		await b?.end().catch(() => {});
		await fencing.close();
		if (!keep) { compose(["down", "--remove-orphans", "--volumes"]); step("containers removed"); }
		else step(`kept: ${container("a")}, ${container("b")} (docker compose -p ${PROJECT} down to remove)`);
	}
}

main().catch((e) => { console.error(`[testbed:replica] FAILED: ${(e as Error).stack ?? e}`); process.exitCode = 1; });
