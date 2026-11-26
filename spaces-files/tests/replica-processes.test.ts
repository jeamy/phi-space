// The replica handover across processes (docs/zanzibar-agent-filesystem-plan.en.md, section 6.7): two sites, each a
// process with directories of its own (tests/support/replica-site.ts). The store of the tenant Spaces replicates over
// phi-spaces' signed replica transport, the deployment state and the blobs over mutual TLS; boot permits live in the
// recovery register. A revocation commits, a save commits and its reply is lost, the primary's process is killed, and the
// standby is promoted by phi-spaces' `promote` with a fencing proof (the simulator adapter: a real one needs a machine
// of its own) and then `degradeToSingle`. On it the revocation holds and the save's retry answers from its receipt; the
// old primary, started again, is refused by its fenced boot permit.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { provisionFileSigner, SqliteRecoveryRegister, type PrimarySyncConfig } from "phi-spaces";

const SITE = fileURLToPath(new URL("./support/replica-site.ts", import.meta.url));
const GENESIS: PrimarySyncConfig = { spaceId: "files-store", authorityId: "files", primaryEpoch: 1, replicaConfigVersion: 1, primaryReplica: "a", standbyReplica: "b" };
const permit = (role: "primary" | "standby") => ({ state: "active", authorityId: "files", dataIncarnation: "inc", role, primaryEpoch: 1, replicaConfigVersion: 1, durability: "sync", transitionId: "genesis" });

type Site = { child: ChildProcess; call(op: string, args?: Record<string, unknown>): Promise<any>; kill(): Promise<void> };
class Refused extends Error { readonly code: string | null; constructor(code: string | null, message: string) { super(message); this.code = code; } }

async function site(configFile: string): Promise<Site> {
	const child = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", SITE, configFile], { stdio: ["pipe", "pipe", "inherit"] });
	const waiting = new Map<number, (m: any) => void>();
	let ready!: () => void;
	const up = new Promise<void>((r) => { ready = r; });
	createInterface({ input: child.stdout! }).on("line", (line) => {
		let m: any;
		try { m = JSON.parse(line); } catch { return; }
		if (m.ready) return ready();
		waiting.get(m.id)?.(m);
		waiting.delete(m.id);
	});
	const exited = new Promise<void>((r) => child.once("exit", () => { for (const w of waiting.values()) w({ ok: false, error: "the site ended" }); waiting.clear(); r(); }));
	await Promise.race([up, exited.then(() => { throw new Error("the site ended before it was ready"); })]);
	let next = 1;
	return {
		child,
		call: (op, args = {}) => new Promise((resolve, reject) => {
			const id = next++;
			waiting.set(id, (m) => m.ok ? resolve(m.result) : reject(new Refused(m.code, m.error)));
			child.stdin!.write(JSON.stringify({ id, op, ...args }) + "\n");
		}),
		kill: async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } },
	};
}

function cert(dir: string, name: string, cn: string) {
	execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.pem`,
		"-days", "2", "-subj", `/CN=${cn}`, "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { cwd: dir, stdio: "ignore" });
	return { cert: readFileSync(join(dir, `${name}.pem`), "utf8"), key: readFileSync(join(dir, `${name}.key`), "utf8") };
}
const code = (c: string) => (e: Error & { code?: string | null }) => { assert.equal(e.code, c, e.message); return true; };

test("across processes: a killed primary, a promotion with a fencing proof, the revocation holds and the retry answers from its receipt", { timeout: 120_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "spaces-files-replicas-"));
	const keys = join(root, "keys");
	mkdirSync(keys, { mode: 0o700 });
	const signers = { a: provisionFileSigner(join(keys, "a.json")), b: provisionFileSigner(join(keys, "b.json")) };
	const pin = (h: "a" | "b") => ({ hostId: h, algorithm: "ed25519" as const, publicKey: signers[h].publicKey });
	const registerFile = join(root, "register", "register.sqlite");
	const register = new SqliteRecoveryRegister(registerFile);
	await register.compareAndSet("boot:a", null, { hostId: "a", state: "active", spaces: { [GENESIS.spaceId]: permit("primary") } });
	await register.compareAndSet("boot:b", null, { hostId: "b", state: "active", spaces: { [GENESIS.spaceId]: permit("standby") } });
	const tA = cert(keys, "a", "files-a"), tB = cert(keys, "b", "localhost");
	const config = (self: "a" | "b", other: "a" | "b") => {
		const file = join(root, `${self}.json`);
		writeFileSync(file, JSON.stringify({
			self, root: join(root, self), signerFile: join(keys, `${self}.json`), register: registerFile, genesis: GENESIS, dataIncarnation: "inc", remote: pin(other),
			standbyTls: { ...(self === "b" ? tB : tA), ca: (self === "b" ? tA : tB).cert }, clientTls: { ...(self === "a" ? tA : tB), ca: (self === "a" ? tB : tA).cert },
		}), { mode: 0o600 });
		return file;
	};
	const aFile = config("a", "b"), bFile = config("b", "a");
	const b = await site(bFile);
	let a = await site(aFile);
	try {
		const ports = await b.call("listen");
		await a.call("open", ports);
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
		// the revocation commits: on the standby before it is answered
		assert.deepEqual(await a.call("revoke", { ...team, ...bobView, opId: ids[2] }), { status: "revoked" });
		// a save commits and its reply is lost
		await a.call("failNext", { at: "commit:after" });
		await assert.rejects(a.call("write", { ...team, path: "plan.md", text: "v2", base: 1, opId: ids[3] }), code("unavailable"));

		// the primary's process dies
		await a.kill();
		const promoted = await b.call("promote");
		assert.equal(promoted.config.primaryReplica, "b");
		assert.equal(promoted.config.durability, "single");
		assert.equal(promoted.config.primaryEpoch, 3, "promote (2), then alone (3)");
		assert.equal(promoted.boot.state, "fenced", "the old primary's boot state is fenced");

		const retry = async <R>(f: () => Promise<R>): Promise<R> => {
			for (let i = 0; ; i++) {
				try { return await f(); } catch (e) { if ((e as Refused).code !== "unavailable" || i > 200) throw e; await new Promise((r) => setTimeout(r, 25)); }
			}
		};
		await assert.rejects(retry(() => b.call("read", { handle: bob, workspace: "team", path: "plan.md" })), code("notFound"), "the revocation holds");
		assert.deepEqual(await retry(() => b.call("read", { handle: lea, workspace: "team", path: "plan.md" })), { version: 2, text: "v2" }, "the lost save is there before its retry");
		assert.deepEqual(await b.call("write", { ...team, path: "plan.md", text: "v2", base: 1, opId: ids[3] }), { version: 2 }, "the retry answers from its receipt");
		assert.deepEqual(await b.call("revoke", { ...team, ...bobView, opId: ids[2] }), { status: "revoked" });
		assert.deepEqual(await b.call("read", { handle: lea, workspace: "team", path: "plan.md" }), { version: 2, text: "v2" }, "nothing applied twice");

		// the old primary comes back: its boot permit is fenced, it opens nothing
		a = await site(aFile);
		await assert.rejects(a.call("open", ports), /standby refused seed/, "the service does not open: the promoted standby no longer serves it");
		await assert.rejects(a.call("probeStore", ports), /boot permit does not match/, "its store commits nothing: the fenced boot permit refuses it");
	} finally {
		await a.kill();
		await b.kill();
		rmSync(root, { recursive: true, force: true });
	}
});
