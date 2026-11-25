// The recovery authority of a restore (docs/zanzibar-agent-filesystem-plan.en.md, section 6.5, steps 2 to 5; phase 5
// exit evidence): the rehearsal where A was the administrator in the backup, B is today's administrator and absent
// from it, and a revoked user still holds an old session, a pending retry and a restored direct file grant. Only a
// rostered recoverer enters the recovery interface; a fresh login by A grants nothing; the recoverer provisions B and
// removes A; a repeated recovery step is answered by its `recoverer` receipt; B, approved by the operator, reconciles
// the grant; stale sessions and IDs stay refused and the path is hidden after normal readmission; a recovery ID of an
// earlier restore epoch is rejected.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newBackupKey, readBackupKey } from "../server/archive.ts";
import { backupData, restoreData } from "../server/backup.ts";
import { RECOVERY_COOKIE, SESSION_COOKIE } from "../server/http.ts";
import { FilesService } from "../server/service.ts";
import { webStack } from "./support/browser.ts";

const code = (c: string) => (e: Error & { code?: string }) => { assert.equal(e.code, c, e.message); return true; };
const A = { issuer: "i", subject: "anna" }, B = { issuer: "i", subject: "bert" }, LEA = { issuer: "i", subject: "lea" }, REV = { issuer: "i", subject: "rev" };
const OPS = { issuer: "i", subject: "ops" };

test("the restore rehearsal: A in the backup, B missing, a revoked user's session, retry and grant", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spaces-files-rc-"));
	const o = { dataDir: join(dir, "data"), stateDir: join(dir, "state"), blobDir: join(dir, "blobs") };
	newBackupKey(join(dir, "data.key"));
	const key = readBackupKey(join(dir, "data.key"));
	let svc = await FilesService.open(o);
	try {
		await svc.createTenant("acme", { actorId: "anna", homeName: "anna", ...A });
		const anna0 = (await svc.login("acme", "user", A)).handle;
		const ids = async (h: string, n = 1) => svc.issueOperationIds(h, n);
		await svc.registerActor(anna0, "user", "lea", "lea", LEA, (await ids(anna0))[0]);
		await svc.registerActor(anna0, "user", "rev", "rev", REV, (await ids(anna0))[0]);
		const lea = (await svc.login("acme", "user", LEA)).handle;
		await svc.write(lea, "lea", "brief.md", Buffer.from("secret"), 0, (await ids(lea))[0]);
		await svc.grant(lea, "lea", ".", "viewer", { kind: "user", id: "rev" }, (await ids(lea))[0]);
		const rev = (await svc.login("acme", "user", REV)).handle;
		assert.equal((await svc.read(rev, "lea", "brief.md")).bytes.toString(), "secret");
		const [revPending] = await ids(rev);
		await backupData(svc, join(dir, "data.bk"), key);
		// after the backup, the world moved on: B became the administrator, A left, rev's grant was revoked; the
		// restore brings back the backup's view of all three
		await svc.close();

		await restoreData(join(dir, "data.bk"), key, o);
		svc = await FilesService.open(o);
		assert.equal(svc.state.lookupSession(rev), null, "rev's old session is gone");
		await assert.rejects(svc.login("acme", "user", B), code("unauthenticated"), "B is not in the backup");

		// A's fresh login grants neither maintenance nor recovery
		const anna = (await svc.login("acme", "user", A)).handle;
		await assert.rejects(svc.listActors(anna), code("unavailable"));
		await assert.rejects(svc.recoveryLogin("acme", A), code("unauthenticated"), "A is not on the roster");
		await assert.rejects(svc.recoveryIssueOperationIds(anna, 1), code("unauthenticated"), "an ordinary session is no recoverer's");

		// the operator rosters the recoverer and B (outside the restorable data); the recoverer enters
		svc.state.rosterAdd("acme", OPS.issuer, OPS.subject);
		svc.state.rosterAdd("acme", B.issuer, B.subject);
		await assert.rejects(svc.recoveryLogin("globex", OPS), code("unauthenticated"), "rostered for acme only");
		const ops = (await svc.recoveryLogin("acme", OPS)).handle;
		await assert.rejects(svc.listActors(ops), code("unauthenticated"), "no ordinary or admin access");
		await assert.rejects(svc.read(ops, "lea", "brief.md"), code("unauthenticated"), "no file access");
		await assert.rejects(svc.issueOperationIds(ops, 1), code("unauthenticated"));
		const view = await svc.recoveryInspect(ops);
		assert.deepEqual(view.admins, ["anna"]);
		assert.deepEqual(view.actors.map((a) => a.id), ["anna", "lea", "rev"]);

		const rid = async () => (await svc.recoveryIssueOperationIds(ops, 1))[0];
		// removing A first would leave no administrator
		await assert.rejects(svc.recoveryRevokeAdmin(ops, "anna", await rid()), code("lastAdmin"));
		await assert.rejects(svc.issueOperationIds(anna, 1), code("unavailable"), "A obtains no tenant IDs during the restore");
		const step = await rid();
		assert.deepEqual(await svc.recoveryProvisionAdmin(ops, "bert", "bert", B, step), { status: "provisioned", actorId: "bert" });
		// the repeated step is answered by its receipt, not applied twice; another request under the same ID is refused
		assert.deepEqual(await svc.recoveryProvisionAdmin(ops, "bert", "bert", B, step), { status: "provisioned", actorId: "bert" });
		await assert.rejects(svc.recoveryProvisionAdmin(ops, "bert", "other", B, step), code("requestMismatch"));
		assert.deepEqual(await svc.recoveryProvisionAdmin(ops, "bert", "bert", B, await rid()), { status: "unchanged", actorId: "bert" });
		await assert.rejects(svc.recoveryProvisionAdmin(ops, "lea2", "x", LEA, await rid()), code("alreadyExists"), "an identity bound to another actor");
		assert.deepEqual(await svc.recoveryRevokeAdmin(ops, "anna", await rid()), { status: "revoked" });
		assert.deepEqual((await svc.recoveryInspect(ops)).admins, ["bert"]);
		const audit = svc.state.operatorAuditRows(100).filter((r) => r.operation.startsWith("recovery.")).sort((x, y) => x.seq - y.seq);
		assert.deepEqual(audit.map((r) => [r.operation, r.detail.subject, r.detail.replayed]), [
			["recovery.recoveryProvisionAdmin", "ops", false],
			["recovery.recoveryProvisionAdmin", "ops", true],
			["recovery.recoveryProvisionAdmin", "ops", false],
			["recovery.recoveryRevokeAdmin", "ops", false],
		]);

		// B is an administrator now, but only the operator's approval admits B during the restore
		const bert = (await svc.login("acme", "user", B)).handle;
		await assert.rejects(svc.listActors(bert), code("unavailable"));
		svc.state.approveReconciler("acme", B.issuer, B.subject);
		// an ordinary ID, even the approved reconciler's, is not a recovery ID
		await assert.rejects(svc.recoveryRevokeAdmin(ops, "lea", (await ids(bert))[0]), code("operationIdRejected"));
		assert.deepEqual((await svc.maintenanceListGrants(bert, "lea", ".")).map((g) => [g.relation, g.subject.id]).filter(([, id]) => id === "rev"), [["viewer", "rev"]]);
		assert.deepEqual(await svc.maintenancePutGrant(bert, "lea", ".", "revoke", "viewer", { kind: "user", id: "rev" }, (await ids(bert))[0]), { status: "revoked" });
		await assert.rejects(svc.listActors(anna), code("unavailable"), "A stays out");
		svc.state.markReconciled("acme");
		await svc.setMode("normal");

		// normal admission: the recoverer's session is over, rev's old ID is refused after reauthentication, the path hidden
		await assert.rejects(svc.recoveryInspect(ops), code("unauthenticated"));
		const rev2 = (await svc.login("acme", "user", REV)).handle;
		await assert.rejects(svc.write(rev2, "rev", "x.md", Buffer.from("x"), 0, revPending), code("operationIdRejected"));
		await assert.rejects(svc.read(rev2, "lea", "brief.md"), code("notFound"));
		await assert.rejects(svc.listActors((await svc.login("acme", "user", A)).handle), code("permissionDenied"), "A is no administrator");
		assert.equal((await svc.listActors(bert)).length, 4);

		// a recovery ID of this restore is rejected in the next one
		await backupData(svc, join(dir, "data2.bk"), key);
		await svc.close();
		await restoreData(join(dir, "data2.bk"), key, o);
		svc = await FilesService.open(o);
		const ops2 = (await svc.recoveryLogin("acme", OPS)).handle;
		await assert.rejects(svc.recoveryRevokeAdmin(ops2, "lea", step), code("operationIdRejected"));
	} finally { await svc.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});

test("the recovery path of the browser adapter: the roster admits, its cookie reaches the recovery calls alone", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spaces-files-rh-"));
	const o = { dataDir: join(dir, "data"), stateDir: join(dir, "state"), blobDir: join(dir, "blobs") };
	newBackupKey(join(dir, "data.key"));
	const key = readBackupKey(join(dir, "data.key"));
	let svc = await FilesService.open(o);
	let web: Awaited<ReturnType<typeof webStack>> | null = null;
	try {
		await svc.createTenant("acme", { actorId: "anna", homeName: "anna", ...A });
		await backupData(svc, join(dir, "data.bk"), key);
		await svc.close();
		await restoreData(join(dir, "data.bk"), key, o);
		svc = await FilesService.open(o);
		web = await webStack(svc);
		const now = web.idp.issuer;

		// a restore is open, but this identity is not on the roster
		const ops = web.browser();
		assert.equal((await ops.recoverySignIn(web.idp, "ops", "acme")).status, 403);
		assert.equal(ops.jar.has(RECOVERY_COOKIE), false);
		svc.state.rosterAdd("acme", now, "ops");
		assert.equal((await ops.recoverySignIn(web.idp, "ops", "acme")).status, 200);
		assert.ok(ops.jar.has(RECOVERY_COOKIE) && !ops.jar.has(SESSION_COOKIE), "a cookie of its own, no ordinary session");
		assert.deepEqual((await ops.recover("inspect")).json?.value.admins, ["anna"]);
		// the recovery cookie opens no ordinary route, and the ordinary operations are not offered on the recovery route
		assert.equal((await ops.request("GET", "/api/session")).status, 401);
		assert.equal((await ops.request("POST", "/api/call", { body: JSON.stringify({ op: "listActors" }), headers: { "content-type": "application/json", "x-files-csrf": ops.csrf } })).status, 401);
		assert.equal((await ops.recover("listActors")).json?.error?.code, "invalidInput");
		// CSRF and origin hold as on the ordinary route
		assert.equal((await ops.request("POST", "/api/recovery", { body: JSON.stringify({ op: "inspect" }), headers: { "content-type": "application/json", "x-files-csrf": "x" } })).status, 403);
		assert.equal((await ops.request("POST", "/api/recovery", { body: JSON.stringify({ op: "inspect" }), headers: { "content-type": "application/json", "x-files-csrf": ops.csrf }, origin: "https://evil.example" })).status, 403);

		const id = (await ops.recover("issueOperationIds", { count: 1 })).json?.value[0];
		const args = { actorId: "bert", homeName: "bert", identity: { issuer: now, subject: "bert" }, operationId: id };
		assert.deepEqual((await ops.recover("provisionAdmin", args)).json?.value, { status: "provisioned", actorId: "bert" });
		assert.deepEqual((await ops.recover("provisionAdmin", args)).json?.value, { status: "provisioned", actorId: "bert" }, "the receipt answers");
		assert.equal((await ops.request("GET", "/recovery")).status, 200);
		const script = await ops.request("GET", "/app/recovery.ts");
		assert.equal(script.status, 200);
		assert.match(String(script.headers["content-type"]), /^text\/javascript/);
		assert.ok(!script.body.includes(": Promise<"), "served with its types stripped");

		// the recovery session ends with the restore
		svc.state.markReconciled("acme");
		await svc.setMode("normal");
		assert.equal((await ops.recover("inspect")).status, 401);
		const bert = web.browser();
		await bert.signIn(web.idp, "bert", "acme");
		assert.equal((await bert.must<unknown[]>("listActors")).length, 2);
	} finally { await web?.close(); await svc.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});
