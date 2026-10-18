import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRecoveryRegister, RecoveryCoordinator, installAuthorityTransition, RegisterConflict, RecoveryBlocked, generateKey, installBootGuard, BootBlocked, PhiSpaces, createSpace, spaceDoc, listSpaces, core, type HostBootState, type SpaceBootPermit, type AuthorityRecord } from "../src/index.ts";
import { forEachBackend, ctx } from "./support/persistent.ts";

test("independent authority CAS admits one successor, persists retries, refuses wrong fence and rollback", async () => {
	const dir = mkdtempSync(join(tmpdir(), "phi-spaces-recovery-")); const key = generateKey("ed25519", "recovery-admin");
	let external = new SqliteRecoveryRegister(`${dir}/external.sqlite`), local = new SqliteRecoveryRegister(`${dir}/installed.sqlite`);
	try {
		await external.compareAndSet("authority:control", null, { authorityId: "old", hostId: "old-host", supervisorKey: "old-supervisor", state: "active", lineage: {} });
		await local.compareAndSet("installed-authority:control", null, { authorityId: "old" });
		const coordinator = new RecoveryCoordinator(external, key.signer), args = { recoveryId: "restore-1", expectedAuthorityId: "old", controlSpaceId: "control", targetHostId: "new-host", supervisorKey: "new-supervisor" };
		await assert.rejects(coordinator.reserve(args, async () => ({ restartLocked: true, hostId: "unrelated-host" })), RecoveryBlocked);
		await assert.rejects(coordinator.reserve(args, async () => ({ restartLocked: false, hostId: "old-host" })), RecoveryBlocked);
		const results = await Promise.allSettled([coordinator.reserve(args, async hostId => ({ restartLocked: true, hostId })), coordinator.reserve({ ...args, recoveryId: "competitor" }, async hostId => ({ restartLocked: true, hostId }))]);
		assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
		assert.ok(results.some(r => r.status === "rejected" && r.reason instanceof RegisterConflict));
		const chosen = (results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<any>).value;
		await installAuthorityTransition(local, external, chosen, { algorithm: key.signer.algorithm, publicKey: key.publicKey });
		await installAuthorityTransition(local, external, chosen, { algorithm: key.signer.algorithm, publicKey: key.publicKey });
		await assert.rejects(installAuthorityTransition(local, external, { ...chosen, transition: { ...chosen.transition, newAuthorityId: "forged" } }, { algorithm: key.signer.algorithm, publicKey: key.publicKey }), RecoveryBlocked);
		external.close(); local.close(); external = new SqliteRecoveryRegister(`${dir}/external.sqlite`); local = new SqliteRecoveryRegister(`${dir}/installed.sqlite`);
		assert.equal((await local.get<any>("installed-authority:control"))!.value.authorityId, chosen.transition.newAuthorityId);
		const retry = await new RecoveryCoordinator(external, key.signer).reserve(chosen.transition, async () => { throw new Error("a known decision must be reused"); });
		assert.deepEqual(retry, chosen);
	} finally { external.close(); local.close(); rmSync(dir, { force: true, recursive: true }); }
});

test("boot checks are per space, fail closed after stale restore, and roll back when permit changes in a commit", async () => {
	await forEachBackend(async home => {
		const h = await home.open(), dir = mkdtempSync(join(tmpdir(), "phi-spaces-boot-"));
		const external = new SqliteRecoveryRegister(`${dir}/external.sqlite`), installed = new SqliteRecoveryRegister(`${dir}/installed.sqlite`); let stop: (() => void) | undefined;
		try {
			const one = await h.commit(tx => createSpace(tx, "one", 1), ctx), two = await h.commit(tx => createSpace(tx, "two", 1), ctx);
			const permit = (inc: string): SpaceBootPermit => ({ state: "active", authorityId: "a", dataIncarnation: inc, role: "local", transitionId: "bootstrap" });
			const state: HostBootState = { hostId: "host", state: "active", spaces: { [one.spaceId]: permit(one.incarnation), [two.spaceId]: permit(two.incarnation) } };
			await external.compareAndSet("boot:host", null, state as any);
			for (const info of [one, two]) await installed.compareAndSet(`installed:host:${info.spaceId}`, null, state.spaces[info.spaceId] as any);
			stop = installBootGuard(h, ctx, { hostId: "host", authorityId: "a", external, installed });
			const a = new PhiSpaces(h, ctx, () => 1, undefined, undefined, { space: "one" }), b = new PhiSpaces(h, ctx, () => 1, undefined, undefined, { space: "two" });
			await a.write({ type: "Ok", fields: {} }); await b.write({ type: "Ok", fields: {} });
			let boot = (await external.get<any>("boot:host"))!; boot.value.spaces[one.spaceId].state = "revoked"; await external.compareAndSet("boot:host", boot.version, boot.value);
			await assert.rejects(a.write({ type: "No", fields: {} }), BootBlocked); await b.write({ type: "StillOk", fields: {} });
			await assert.rejects(a.read({ type: "Ok" }, 0), BootBlocked);
			await assert.rejects(h.commit(async tx => { core.write(await spaceDoc(tx, "two", 1), 1, { type: "Race", fields: {} }, null, core.FOREVER); const r = (await external.get<any>("boot:host"))!; r.value.state = "fenced"; await external.compareAndSet("boot:host", r.version, r.value); }, ctx), BootBlocked);
			await assert.rejects(b.count({ type: "Race" }), BootBlocked);
			boot = (await external.get<any>("boot:host"))!; boot.value.state = "active"; await external.compareAndSet("boot:host", boot.version, boot.value);
			assert.equal(await b.count({ type: "Race" }), 0, "a concurrent external fence rolls back the whole mutation");
		} finally { stop?.(); external.close(); installed.close(); rmSync(dir, { recursive: true, force: true }); }
	});
});

test("restore imports in bounded crash-resumable batches, keeps history read-only and quarantines tasks", async () => {
	const { beginRestore, restoreBatch, snapshotHash, completeRestore, releaseRestored, claims, Registry, NamedSpace } = await import("../src/index.ts");
	await forEachBackend(async home => {
		let h = await home.open(), local = new PhiSpaces(h, ctx, () => 1);
		for (let i = 0; i < 12; i++) await local.write({ type: "Task", fields: { i, pad: "x".repeat(600) } }, null, core.FOREVER);
		const request = { principal: { peerId: "worker" }, ...(await local.issueGeneration({ peerId: "worker" })), requestId: "old-pending" };
		await local.beginOperation({ type: "Future" }, core.FOREVER, { request }, true, false);
		const tx = await local.createTransaction(60000); await local.take({ type: "Task" }, 0, { txn: tx.id }); await local.write({ type: "Uncommitted", fields: {} }, tx.id, core.FOREVER);
		const { Space } = await import("../src/index.ts"), snapshot = core.plain((await h.snapshot(Space, ctx))!);
		await local.setLimits({ maxCommitBytes: 3000 });
		const args = { recoveryId: "restore-data", expectedDataIncarnation: snapshot.incarnation!, expectedPrimaryEpoch: 1, snapshotHash: snapshotHash(snapshot), kind: "data" as const };
		const restoration = await h.commit(async t => { const s = await spaceDoc(t, undefined, 1), r = beginRestore(s, 1, args); const registry = await t.doc(Registry); registry.spaces[s.spaceId!]!.incarnation = r.incarnation; return r; }, ctx);
		await h.commit(async t => restoreBatch(await spaceDoc(t, undefined, 1), 1, snapshot), ctx);
		assert.ok((await h.snapshot(Space, ctx))!.restore!.cursor < snapshot.entries.length, "the restore uses more than one bounded batch");
		home.crash(h); h = await home.open(); local = new PhiSpaces(h, ctx, () => 1);
		for (let i = 0; i < 30; i++) { const s = (await h.snapshot(Space, ctx))!; if (s.restore!.stage === "waiting") break; await h.commit(async t => restoreBatch(await spaceDoc(t, undefined, 1), 1, snapshot), ctx); }
		assert.equal(await local.count({ type: "Task" }), 12); assert.equal(await local.count({ type: "Uncommitted" }), 0);
		assert.ok((await local.read({ type: "Task" }, 0))!.restoredUnverified); assert.equal(await local.take({ type: "Task" }, 0), null);
		const historical = await local.pollOperation(request); assert.ok(historical.restoredHistory && historical.unknownOutcome);
		await assert.rejects(local.take({ type: "Future" }, 0, { request }), claims.IncarnationChanged);
		await assert.rejects(h.commit(async t => completeRestore(await spaceDoc(t, undefined, 1), 1, args.recoveryId), ctx), core.PermissionError);
		await h.commit(async t => completeRestore(await spaceDoc(t, undefined, 62001), 62001, args.recoveryId), ctx);
		await h.commit(async t => releaseRestored(await spaceDoc(t, undefined, 62001), 62001, args.recoveryId, { entryIds: [snapshot.entries[0]!.id] }), ctx);
		assert.equal((await local.take({ id: snapshot.entries[0]!.id }, 0))?.fields.i, 0); assert.equal(await local.take({ type: "Task" }, 0), null, "unreleased tasks remain quarantined");
	});
});
