// Phase 5 exit evidence (docs/zanzibar-agent-filesystem-plan.en.md, section 7), the way the operator guide
// (docs/operator-guide.en.md) runs it: the launched service with a limits file, its operator CLI and the browser.
// Health and counters; the state backup and an online data backup while the service runs; a backup copy that names
// no content; the service stopped, a clean (offline) backup, the restore; the service started closed; a rostered
// recoverer signs in on the recovery path and provisions today's administrator, absent from the backup; the operator
// approves that administrator as the reconciler, who reconciles a grant by metadata alone; the operator marks the
// tenant reconciled and opens normal admission; stale sessions are refused and every file reads.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startDevIdp } from "../server/dev-idp.ts";
import { Browser, freePort, testCert } from "./support/browser.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const node = (file: string) => [process.execPath, "--no-warnings", "--experimental-strip-types", join(ROOT, "server", file)] as const;

test("phase 5 exit: health, backups, restore, recovery authority and reconciliation through the operator CLI", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spaces-files-p5-"));
	const port = await freePort();
	const origin = `https://localhost:${port}`;
	const idp = await startDevIdp({ clients: [{ clientId: "files-p5", redirectUris: [`${origin}/auth/callback`] }] });
	const tls = testCert();
	writeFileSync(join(dir, "cert.pem"), tls.cert);
	writeFileSync(join(dir, "key.pem"), tls.key, { mode: 0o600 });
	writeFileSync(join(dir, "limits.json"), JSON.stringify({ maxFileBytes: 1024 * 1024 }));
	const env = {
		...process.env, NODE_TEST_CONTEXT: "", FILES_MEM: "",
		FILES_DATA_DIR: join(dir, "data"), FILES_STATE_DIR: join(dir, "state"), FILES_BLOB_DIR: join(dir, "blobs"),
		FILES_PUBLIC_ORIGIN: origin, FILES_TLS_CERT: join(dir, "cert.pem"), FILES_TLS_KEY: join(dir, "key.pem"),
		FILES_OIDC_ISSUER: idp.issuer, FILES_OIDC_CLIENT_ID: "files-p5", FILES_LIMITS: join(dir, "limits.json"),
		FILES_BACKUP_KEY: join(dir, "data.key"), FILES_STATE_BACKUP_KEY: join(dir, "state.key"),
	};
	const [ocmd, ...oargs] = node("operator.ts");
	const op = async (...a: string[]) => {
		// a refused command exits 1 with the public error on stdout
		const out = await promisify(execFile)(ocmd, [...oargs, ...a], { env }).then((r) => r.stdout, (e: { stdout?: string }) => e.stdout ?? "");
		return out.startsWith("[operator]") ? out : JSON.parse(out);
	};
	let child: ChildProcess | null = null;
	const start = async () => {
		const [cmd, ...args] = node("launch.ts");
		const c = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		await new Promise<void>((resolve, reject) => {
			c.stdout!.on("data", (b) => { out += b; if (out.includes("[files] ready")) resolve(); });
			c.stderr!.on("data", (b) => { out += b; });
			c.once("exit", (code) => reject(new Error(`exited ${code}: ${out}`)));
		});
		child = c;
	};
	const stop = async () => { const c = child; child = null; if (!c) return; c.kill("SIGTERM"); await new Promise((r) => c.once("exit", r)); };
	try {
		await start();
		await op("new-backup-key", join(dir, "data.key"));
		await op("new-backup-key", join(dir, "state.key"));
		await op("create-tenant", "acme", "anna", "anna", idp.issuer, "anna");
		const anna = new Browser(origin);
		await anna.signIn(idp, "anna");
		await anna.must("registerActor", { kind: "user", actorId: "rev", homeName: "rev", identity: { issuer: idp.issuer, subject: "rev" }, operationId: await anna.opId() });
		await anna.must("write", { workspace: "anna", path: "brief.md", contents: Buffer.from("the quarterly plan").toString("base64"), expectedVersion: 0, operationId: await anna.opId() });
		await anna.must("grant", { workspace: "anna", path: ".", relation: "viewer", subject: { kind: "user", id: "rev" }, operationId: await anna.opId() });
		// the limits file holds: a file above its bound is refused
		const big = await anna.call("write", { workspace: "anna", path: "big.bin", contents: Buffer.alloc(1024 * 1024 + 1).toString("base64"), expectedVersion: 0, operationId: await anna.opId() });
		assert.equal(big.json?.error?.code, "capacityExceeded");

		let h = await op("health");
		assert.equal(h.status, "ok");
		assert.equal(h.state.stateBackupDue, true);
		assert.ok((await op("metrics")).ops.write.latency.count >= 2);
		await op("backup-state", join(dir, "state.bk"));
		assert.equal((await op("health")).state.stateBackupDue, false);
		const online = await op("backup", join(dir, "online.bk"));
		assert.ok(online.blobs >= 1);
		// the encrypted copy alone yields nothing readable: neither the content, nor a name, nor an identity
		const bytes = readFileSync(join(dir, "online.bk"));
		for (const s of ["the quarterly plan", "brief.md", "anna", idp.issuer]) assert.equal(bytes.includes(Buffer.from(s)), false, s);

		await stop();
		const clean = await op("backup-offline", join(dir, "clean.bk"));
		assert.equal(clean.blobs, online.blobs);
		const restored = await op("restore", join(dir, "clean.bk"));
		assert.deepEqual(restored.tenants.map((t: { tenantId: string; missing: number }) => [t.tenantId, t.missing]), [["acme", 0]]);
		await start();
		h = await op("health");
		assert.equal(h.status, "maintenance");
		assert.equal(h.restore.step, "checked");
		assert.equal(h.mode, "maintenance", JSON.stringify(h));
		assert.equal((await anna.session()).status, 401, "the session from before the restore is refused");
		await anna.signIn(idp, "anna");
		assert.equal((await anna.session()).json?.error?.code, "unavailable", "a backed-up admin proves nothing, not even a session view");

		// the roster, outside the restored data; the recoverer provisions today's administrator
		await op("roster-add", "acme", idp.issuer, "ops");
		await op("roster-add", "acme", idp.issuer, "bert");
		const ops = new Browser(origin);
		assert.equal((await ops.recoverySignIn(idp, "ops", "acme")).status, 200);
		const rid = (await ops.recover("issueOperationIds", { count: 1 })).json?.value[0];
		const provision = { actorId: "bert", homeName: "bert", identity: { issuer: idp.issuer, subject: "bert" }, operationId: rid };
		assert.equal((await ops.recover("provisionAdmin", provision)).json?.value.status, "provisioned");
		assert.equal((await ops.recover("provisionAdmin", provision)).json?.value.status, "provisioned", "the repeated step: its receipt");
		assert.equal((await ops.recover("revokeAdmin", { user: "anna", operationId: (await ops.recover("issueOperationIds", { count: 1 })).json?.value[0] })).json?.value.status, "revoked");

		// the operator approves bert; bert reconciles rev's restored grant by metadata alone
		await op("approve-reconciler", "acme", idp.issuer, "bert");
		const bert = new Browser(origin);
		await bert.signIn(idp, "bert");
		assert.equal((await bert.call("read", { workspace: "anna", path: "brief.md" })).json?.error?.code, "unavailable", "no file access in maintenance");
		assert.equal((await bert.must("maintenancePutGrant", { workspace: "anna", path: ".", action: "revoke", relation: "viewer", subject: { kind: "user", id: "rev" }, operationId: await bert.opId() })).status, "revoked");
		assert.match(JSON.stringify(await op("mode", "normal")), /waits for the reconciliation of acme/);
		await op("mark-reconciled", "acme");
		assert.equal((await op("mode", "normal")).mode, "normal");
		assert.equal((await op("health")).status, "ok");
		assert.deepEqual((await op("maintain")).map((m: { tenantId: string }) => m.tenantId), ["acme"]);
		assert.equal(typeof (await op("compact")).freedPages, "number");
		assert.equal((await ops.recover("inspect")).status, 401, "the recovery session ended with the restore");

		const rev = new Browser(origin);
		await rev.signIn(idp, "rev");
		assert.equal((await rev.call("read", { workspace: "anna", path: "brief.md" })).json?.error?.code, "notFound", "the reconciled grant: hidden");
		await anna.signIn(idp, "anna");
		assert.equal(Buffer.from((await anna.must("read", { workspace: "anna", path: "brief.md" })).contents, "base64").toString(), "the quarterly plan");
		const audit = await op("restore-status");
		assert.equal(audit.journal, null);
	} finally {
		await stop();
		await idp.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
