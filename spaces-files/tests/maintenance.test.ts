// Maintenance mode and upkeep (docs/zanzibar-agent-filesystem-plan.en.md, sections 3, 5 and 6.1; phase 3 exit
// evidence): the admission mode in the order of checks, the maintenance metadata operations without visibility or
// contents, a barriered transition that refuses queued work and drains started work, the mode across a restart and an
// interrupted transition, audit pruning by age alone with the seq continuing, and compaction.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { FilesService, tenantAlias, type FilesServiceOptions } from "../server/service.ts";
import { T } from "../server/schema.ts";

const code = (c: string) => (e: Error & { code?: string }) => { assert.equal(e.code, c, e.message); return true; };
const bytes = (s: string) => Buffer.from(s);
const raw = (s: FilesService) => s.store.space(tenantAlias("acme"));
const LEA = { kind: "user", id: "lea" };
const ADM = { kind: "user", id: "adm" };

async function tenant(o: Partial<FilesServiceOptions> = {}, root?: string, fresh = true) {
	const dirs = root ? { dataDir: join(root, "data"), stateDir: join(root, "state"), blobDir: join(root, "blobs") } : { dataDir: null, stateDir: null, blobDir: null };
	const s = await FilesService.open({ ...dirs, ...o });
	if (fresh) {
		await s.createTenant("acme", { actorId: "adm", homeName: "adm", issuer: "i", subject: "adm" });
		await s.provisionActor("acme", { actorKind: "user", actorId: "adm" }, "user", "lea", "lea", { issuer: "i", subject: "lea" });
	}
	return s;
}
async function logins(s: FilesService) {
	const adm = (await s.login("acme", "user", { issuer: "i", subject: "adm" })).handle;
	const lea = (await s.login("acme", "user", { issuer: "i", subject: "lea" })).handle;
	return { adm, lea, id: async (h: string) => (await s.issueOperationIds(h, 1))[0] };
}

test("the admission mode: maintenance metadata operations only in maintenance, file operations only in normal mode", async () => {
	const s = await tenant();
	try {
		const { adm, lea, id } = await logins(s);
		await s.mkdir(lea, "lea", "plans", await id(lea));
		await s.write(lea, "lea", "plans/brief.md", bytes("secret"), 0, await id(lea));
		await assert.rejects(s.maintenanceList(adm, "lea", "."), code("unavailable"), "normal mode offers no maintenance operation");
		const leaOp = await id(lea);
		await s.setMode("maintenance");
		assert.equal(s.mode(), "maintenance");
		await assert.rejects(s.read(lea, "lea", "plans/brief.md"), code("unavailable"));
		await assert.rejects(s.read(adm, "adm", "."), code("unavailable"), "file operations stop for administrators too");
		await assert.rejects(s.issueOperationIds(lea, 1), code("unavailable"), "only administrators get IDs");
		await assert.rejects(s.write(lea, "lea", "x", bytes("x"), 0, leaOp), code("unavailable"));
		await assert.rejects(s.maintenanceList(lea, "lea", "."), code("unavailable"), "a non-administrator is refused by the mode");

		// metadata without visibility, never contents or versions
		assert.deepEqual(await s.maintenanceList(adm, "lea", "."), [{ name: "plans", kind: "dir" }]);
		assert.deepEqual(await s.maintenanceList(adm, "lea", "plans"), [{ name: "brief.md", kind: "file" }]);
		assert.deepEqual(await s.maintenanceListGrants(adm, "lea", "."), [{ relation: "owner", subject: { kind: "user", id: "lea" } }]);
		await assert.rejects(s.maintenanceList(adm, "lea", "absent"), code("notFound"));
		await assert.rejects(s.maintenanceList(adm, "lea", "plans/brief.md"), code("invalidInput"));
		// grants by administrator authority: validated, idempotent, the final owner kept
		const op = await id(adm);
		assert.deepEqual(await s.maintenancePutGrant(adm, "lea", ".", "grant", "owner", ADM, op), { status: "granted" });
		assert.deepEqual(await s.maintenancePutGrant(adm, "lea", ".", "grant", "owner", ADM, op), { status: "granted" }, "replayed");
		assert.deepEqual(await s.maintenancePutGrant(adm, "lea", ".", "grant", "owner", ADM, await id(adm)), { status: "unchanged" });
		await assert.rejects(s.maintenancePutGrant(adm, "lea", "plans", "grant", "viewer", ADM, await id(adm)), code("invalidInput"));
		assert.deepEqual(await s.maintenancePutGrant(adm, "lea", ".", "revoke", "owner", LEA, await id(adm)), { status: "revoked" });
		await assert.rejects(s.maintenancePutGrant(adm, "lea", ".", "revoke", "owner", ADM, await id(adm)), code("lastOwner"));
		assert.deepEqual(await s.maintenancePutGrant(adm, "lea", ".", "revoke", "editor", LEA, await id(adm)), { status: "unchanged" });
		await assert.rejects(s.maintenancePutGrant(adm, "lea", ".", "move", "owner", LEA, await id(adm)), code("invalidInput"));
		// admin operations go on
		assert.deepEqual(await s.addMember(adm, "north", LEA, await id(adm)), { status: "added" });

		await s.setMode("normal");
		await assert.rejects(s.maintenanceListGrants(adm, "lea", "."), code("unavailable"));
		assert.deepEqual(await s.workspaces(lea), [], "her home has a new owner now");
		assert.deepEqual(await s.workspaces(adm), ["adm", "lea"]);
	} finally { await s.close(); }
});

test("a mode transition refuses queued operations, drains started ones, and survives a restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "spaces-files-mode-"));
	let release = () => {};
	let paused = false;
	let entered = () => {};
	const inside = new Promise<void>((r) => { entered = r; });
	try {
		const s = await tenant({ faultHook: async (p) => { if (p === "afterBlob" && paused) { entered(); await new Promise<void>((r) => { release = r; }); } } }, root);
		const { lea, id } = await logins(s);
		const op = await id(lea);
		paused = true;
		const write = s.write(lea, "lea", "f", bytes("in flight"), 0, op);
		await inside;
		const queued = s.read(lea, "lea", "f");
		let switched = false;
		const sw = s.setMode("maintenance").then(() => { switched = true; });
		await assert.rejects(queued, code("unavailable"), "a queued operation is refused, not started");
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(switched, false, "the started write is drained first");
		paused = false;
		release();
		assert.deepEqual(await write, { version: 1 });
		await sw;
		assert.equal(s.mode(), "maintenance");
		await s.close();

		let again = await tenant({}, root, false);
		assert.equal(again.mode(), "maintenance", "the mode is durable");
		// an interrupted transition: the intent is persisted, the process dies before the destination is
		again.state.beginModeTransition("normal");
		await again.close();
		again = await tenant({}, root, false);
		assert.equal(again.mode(), "normal", "a restart completes the pending transition before serving");
		const l = await logins(again);
		assert.equal((await again.read(l.lea, "lea", "f")).version, 1);
		await again.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("audit pruning: by age alone, oldest first, the newest row kept, the seq continuing after a reopen", async () => {
	const root = mkdtempSync(join(tmpdir(), "spaces-files-audit-"));
	const c = { t: 50_000_000 };
	const DAY = 24 * 3600_000;
	const o = { now: () => c.t, limits: { maxAuditAgeMs: 10 * DAY, retryWindowMs: 3600_000 }, state: { maxClockJumpMs: 365 * DAY } };
	try {
		let s = await tenant(o, root);
		let l = await logins(s);
		for (let i = 0; i < 3; i++) await s.mkdir(l.lea, "lea", `d${i}`, await l.id(l.lea));
		const all = await raw(s).count({ type: T.audit });                    // createTenant, provision, three mkdirs
		assert.equal(all, 5);
		c.t += 5 * DAY;
		l = await logins(s);                                                   // sessions expire meanwhile
		await s.mkdir(l.lea, "lea", "young", await l.id(l.lea));
		assert.equal(await s.pruneAudit("acme"), 0, "nothing is older than the retention age");
		c.t += 6 * DAY;                                                        // the first five are 11 days old now
		const floor = s.state.timeFloor();
		assert.equal(await s.pruneAudit("acme", 2), 2, "a bounded batch");
		assert.ok(s.state.timeFloor() > floor, "the floor is persisted before the removal");
		assert.equal(await s.pruneAudit("acme"), 3);
		const left = (await raw(s).readAll({ type: T.audit })).map((e) => e.fields.seq);
		assert.deepEqual(left, [6], "only the young row stays");
		c.t += 20 * DAY;
		assert.equal(await s.pruneAudit("acme"), 0, "the newest row always stays");
		const r = await s.maintainTenant("acme");
		assert.deepEqual(r, { receipts: 4, audit: 0, blobs: 0 }, "expired receipts go with the upkeep");
		await s.close();
		s = await tenant(o, root, false);
		l = await logins(s);
		await s.mkdir(l.lea, "lea", "after", await l.id(l.lea));
		assert.deepEqual((await raw(s).readAll({ type: T.audit })).map((e) => e.fields.seq).sort(), [6, 7], "the seq continues");
		const compacted = await s.compact();
		assert.ok(compacted !== null && typeof compacted.freedPages === "number");
		assert.equal(s.admission.open, true);
		await s.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});
