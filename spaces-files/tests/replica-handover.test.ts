// The acceptance gate of replicas (docs/zanzibar-agent-filesystem-plan.en.md, section 8, multiple authorities or
// replicas; specified in section 6.7): the tenant Spaces' store as the primary of phi-spaces' primary/sync journal, its
// standby journal on another file. A revocation commits, a save commits but its reply is lost, the primary is killed
// and fenced, the standby materializes the accepted history and is promoted under a new epoch, and the service runs on
// it: the fenced primary commits nothing, the revocation holds, and the retry of the save answers from its receipt without applying twice. The deployment
// state and the blobs are carried over by copying them here: their replication is specified, not built (section 6.7).
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { FOREVER } from "phi-spaces/core";
import {
	applyConfigTransition, materializeSyncHistory, OwnSyncStore, PrimarySyncBlocked, PrimarySyncJournal, primarySyncStorage, recoverPrimarySync,
	type PrimarySyncConfig, type PrimarySyncPeer,
} from "phi-spaces";
import { FilesService, STATE_MARKER, tenantAlias } from "../server/service.ts";
import { T } from "../server/schema.ts";
import { storeOnHost } from "../server/store.ts";

const code = (c: string) => (e: Error & { code?: string }) => { assert.equal(e.code, c, e.message); return true; };
const CONFIG: PrimarySyncConfig = { spaceId: "files-store", authorityId: "files", primaryEpoch: 1, replicaConfigVersion: 1, primaryReplica: "a", standbyReplica: "b" };

test("a handover in one process: the revocation holds and a lost reply's retry answers from its receipt", async () => {
	const root = mkdtempSync(join(tmpdir(), "spaces-files-replica-"));
	const site = (n: string) => { const d = { dataDir: join(root, n, "data"), stateDir: join(root, n, "state"), blobDir: join(root, n, "blobs"), store: join(root, n, "store") }; mkdirSync(d.store, { recursive: true, mode: 0o700 }); return d; };
	const a = site("a"), b = site("b");
	const aJournal = new PrimarySyncJournal(join(a.store, "journal.sqlite"), CONFIG);
	const bJournal = new PrimarySyncJournal(join(b.store, "journal.sqlite"), CONFIG);
	// the fencing of the old primary: once it is cut off, it seals nothing more
	let aFenced = false;
	const assertA = async () => { if (aFenced) throw new PrimarySyncBlocked("fenced"); };
	const toB: PrimarySyncPeer = { accept: (i) => bJournal.accept(i) };
	let failAt: string | null = null;
	const aRaw = new OwnSyncStore(join(a.store, "files.sqlite"));
	await recoverPrimarySync(aRaw, aJournal, toB, ctx, assertA);
	const aHost = await primarySyncStorage(aRaw, aJournal, toB, { assertPrimary: assertA }).open();
	const s = await FilesService.open({
		dataDir: a.dataDir, stateDir: a.stateDir, blobDir: a.blobDir, saveTxnLeaseMs: 300,
		openStore: () => storeOnHost(aHost, join(a.store, "files.sqlite")),
		faultHook: (p) => { if (p === failAt) { failAt = null; throw new Error("the reply was lost"); } },
	});
	let promoted: FilesService | undefined;
	try {
		await s.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "lea" });
		await s.provisionActor("acme", { actorKind: "user", actorId: "lea" }, "user", "bob", "bob", { issuer: "i", subject: "bob" });
		const lea = (await s.login("acme", "user", { issuer: "i", subject: "lea" })).handle;
		const bob = (await s.login("acme", "user", { issuer: "i", subject: "bob" })).handle;
		const ids = await s.issueOperationIds(lea, 5);
		await s.createWorkspace(lea, "team", { kind: "user", id: "lea" }, ids[4]);
		await s.write(lea, "team", "plan.md", Buffer.from("v1"), 0, ids[0]);
		await s.grant(lea, "team", ".", "viewer", { kind: "user", id: "bob" }, ids[1]);
		assert.equal((await s.read(bob, "team", "plan.md")).bytes.toString(), "v1");
		// the revocation commits: acknowledged by the standby before it is answered
		assert.deepEqual(await s.revoke(lea, "team", ".", "viewer", { kind: "user", id: "bob" }, ids[2]), { status: "revoked" });
		await assert.rejects(s.read(bob, "team", "plan.md"), code("notFound"));
		// a save commits, and its reply is lost
		failAt = "commit:after";
		await assert.rejects(s.write(lea, "team", "plan.md", Buffer.from("v2"), 1, ids[3]), code("unavailable"));

		// the primary dies and is fenced; its store refuses every further commit
		aFenced = true;
		await assert.rejects(s.store.space(tenantAlias("acme")).write({ type: "Probe", fields: {} }, null, FOREVER), "the fenced primary commits nothing");
		aHost.abandon();
		await s.close().catch(() => {});
		// what the specification has replicated beside the Space store (section 6.7), carried over here by a copy
		for (const k of ["stateDir", "blobDir"] as const) { cpSync(a[k], b[k], { recursive: true }); chmodSync(b[k], 0o700); }
		mkdirSync(b.dataDir, { recursive: true, mode: 0o700 });
		cpSync(join(a.dataDir, STATE_MARKER), join(b.dataDir, STATE_MARKER));

		// the standby: the accepted history materialized, then promoted under epoch 2 without a standby of its own
		const bRaw = new OwnSyncStore(join(b.store, "files.sqlite"));
		await materializeSyncHistory(bRaw, bJournal, ctx);
		await applyConfigTransition(bRaw, bJournal, { ...CONFIG, primaryEpoch: 2, replicaConfigVersion: 2, primaryReplica: "b", standbyReplica: null, durability: "single" }, { reason: "promote-b-after-fenced-a", peer: null, ctx, assert: async () => {} });
		const bHost = await primarySyncStorage(bRaw, bJournal, null, { assertPrimary: async () => {} }).open();
		promoted = await FilesService.open({ dataDir: b.dataDir, stateDir: b.stateDir, blobDir: b.blobDir, saveTxnLeaseMs: 300, openStore: () => storeOnHost(bHost, join(b.store, "files.sqlite")) });
		const p = promoted;
		const retry = async <R>(f: () => Promise<R>): Promise<R> => {
			for (let i = 0; ; i++) {
				try { return await f(); } catch (e) { if ((e as { code?: string }).code !== "unavailable" || i > 200) throw e; await new Promise((r) => setTimeout(r, 25)); }
			}
		};
		// the revocation holds after the handover
		await assert.rejects(retry(() => p.read(bob, "team", "plan.md")), code("notFound"));
		// the lost save had committed on the primary and reached the standby before that
		assert.equal((await retry(() => p.read(lea, "team", "plan.md"))).version, 2, "the acknowledged commit is on the promoted standby");
		// its retry answers from the receipt, and nothing is applied twice
		assert.deepEqual(await retry(() => p.write(lea, "team", "plan.md", Buffer.from("v2"), 1, ids[3])), { version: 2 });
		const now = await p.read(lea, "team", "plan.md");
		assert.deepEqual([now.version, now.bytes.toString()], [2, "v2"]);
		assert.equal(await p.store.space(tenantAlias("acme")).count({ type: T.receipt, fields: { operationId: ids[3] } }), 1);
		// the revocation's retry answers from its receipt too
		assert.deepEqual(await p.revoke(lea, "team", ".", "viewer", { kind: "user", id: "bob" }, ids[2]), { status: "revoked" });
	} finally {
		await promoted?.close();
		aJournal.close(); bJournal.close();
		rmSync(root, { recursive: true, force: true });
	}
});
