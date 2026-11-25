// The blob store and the content keys (docs/zanzibar-agent-filesystem-plan.en.md, section 3, *Contents*; section 6.6):
// sealed blobs round-trip any bytes, are bound to their tenant, node, version and ID, fail as `inconsistentState` when
// missing, damaged or moved, survive a content-key rotation and a restore rotation of the signing keys, and the sweep
// removes only orphans, never while deletion is held.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, type BlobOwner, type BlobRef } from "../server/blobs.ts";
import { CONTENT_KEYS_FILE, DeploymentState, StateUnavailable } from "../server/deployment.ts";
import { FOREVER } from "phi-spaces/core";
import { content, InconsistentState, T } from "../server/schema.ts";
import { FilesService, tenantAlias } from "../server/service.ts";
import { PhiSpaces } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";

const scratch = () => mkdtempSync(join(tmpdir(), "spaces-files-blobs-"));
const owner = (o: Partial<BlobOwner> = {}): BlobOwner => ({ tenantId: "acme", nodeId: "n".repeat(22), version: 1, ...o });
const blobPath = (dir: string, tenantId: string, blobId: string) => join(dir, tenantId, blobId.slice(0, 2), blobId);

for (const medium of ["memory", "directory"] as const) {
	test(`blobs (${medium}): any bytes round-trip, sealed, bound to their owner`, async () => {
		const root = scratch();
		const state = await DeploymentState.open({ dir: null });
		const dir = medium === "memory" ? null : join(root, "blobs");
		try {
			const blobs = await BlobStore.open(dir, state);
			const samples = [new Uint8Array(0), Buffer.from("brief\n"), Buffer.from([0, 255, 0xd8, 0x00, 0xfe]), Buffer.alloc(1 << 20, 7)];
			const refs: BlobRef[] = [];
			for (const [i, b] of samples.entries()) {
				const ref = await blobs.put(owner({ version: i + 1 }), b);
				assert.equal(ref.size, b.length);
				assert.equal(ref.keyGeneration, 1);
				assert.match(ref.blobId, /^[A-Za-z0-9_-]{22}$/);
				assert.deepEqual(await blobs.get(owner({ version: i + 1 }), ref), Buffer.from(b));
				refs.push(ref);
			}
			assert.equal(new Set(refs.map((r) => r.blobId)).size, refs.length, "a fresh ID per blob");
			const same = await blobs.put(owner(), Buffer.from("brief\n"));
			assert.notEqual(same.blobId, refs[1].blobId, "equal contents do not share or reveal a blob");

			// bound to tenant, node, version, size and generation
			const ref = refs[1];
			for (const [what, o, r] of [
				["another version", owner({ version: 3 }), ref],
				["another node", owner({ nodeId: "m".repeat(22), version: 2 }), ref],
				["another size", owner({ version: 2 }), { ...ref, size: ref.size + 1 }],
				["another generation", owner({ version: 2 }), { ...ref, keyGeneration: 2 }],
			] as const) await assert.rejects(blobs.get(o, r), InconsistentState, what);
			await assert.rejects(blobs.get(owner({ tenantId: "other", version: 2 }), ref), InconsistentState, "another tenant's area has no such blob");
			await assert.rejects(blobs.get(owner(), { blobId: "x".repeat(22), size: 0, keyGeneration: 1 }), /missing/);
			await assert.rejects(blobs.get(owner(), { blobId: "../../etc/passwd", size: 0, keyGeneration: 1 }), /malformed/);

			if (dir !== null) {
				const file = blobPath(dir, "acme", ref.blobId);
				assert.equal(statSync(file).mode & 0o777, 0o600);
				assert.equal(statSync(join(dir, "acme")).mode & 0o777, 0o700);
				const big = readFileSync(blobPath(dir, "acme", refs[3].blobId));
				assert.equal(big.indexOf(Buffer.alloc(64, 7)), -1, "no plaintext in the file");
				// a blob copied under another ID, into another tenant, truncated or with one bit flipped does not open
				const moved = refs[2];
				const target = blobPath(dir, "acme", moved.blobId);
				copyFileSync(file, target);
				await assert.rejects(blobs.get(owner({ version: 3 }), { ...moved, size: ref.size }), /authenticate/);
				mkdirSync(join(dir, "other", ref.blobId.slice(0, 2)), { recursive: true });
				copyFileSync(file, blobPath(dir, "other", ref.blobId));
				await assert.rejects(blobs.get(owner({ tenantId: "other", version: 2 }), ref), /authenticate/);
				const flipped = readFileSync(file); flipped[flipped.length - 20] ^= 1; writeFileSync(file, flipped);
				await assert.rejects(blobs.get(owner({ version: 2 }), ref), /authenticate/);
				truncateSync(file, 10);
				await assert.rejects(blobs.get(owner({ version: 2 }), ref), /length or format/);
			}
		} finally { state.close(); rmSync(root, { recursive: true, force: true }); }
	});

	test(`blobs (${medium}): the sweep removes orphans and leftovers only, never while deletion is held`, async () => {
		const root = scratch();
		const state = await DeploymentState.open({ dir: null });
		const dir = medium === "memory" ? null : join(root, "blobs");
		try {
			const blobs = await BlobStore.open(dir, state);
			const kept = await blobs.put(owner(), Buffer.from("kept"));
			const orphans = [await blobs.put(owner({ version: 2 }), Buffer.from("a")), await blobs.put(owner({ version: 3 }), Buffer.from("b"))];
			const other = await blobs.put(owner({ tenantId: "other" }), Buffer.from("other tenant"));
			if (dir !== null) {
				// a save that died between writing its temporary file and the rename, and a file that is not ours
				const shard = join(dir, "acme", kept.blobId.slice(0, 2));
				writeFileSync(join(shard, "t".repeat(22) + ".tmp"), "half");
				writeFileSync(join(shard, kept.blobId.slice(0, 2) + "t".repeat(20) + ".tmp"), "half");
				writeFileSync(join(shard, "README"), "not a blob");
			}
			const release = blobs.holdDeletion();
			assert.equal(await blobs.sweep("acme", new Set([kept.blobId])), 0, "held: nothing removed");
			assert.equal(await blobs.delete("acme", orphans[0].blobId), false);
			release(); release();
			assert.equal(await blobs.sweep("acme", new Set([kept.blobId]), 1), 1, "bounded batch");
			assert.equal(await blobs.sweep("acme", new Set([kept.blobId])), dir === null ? 1 : 3, "also a leftover in another blob's shard");
			assert.equal(await blobs.sweep("acme", new Set([kept.blobId])), 0);
			for (const o of orphans) assert.equal(await blobs.exists("acme", o.blobId), false);
			assert.deepEqual(await blobs.get(owner(), kept), Buffer.from("kept"));
			assert.deepEqual(await blobs.get(owner({ tenantId: "other" }), other), Buffer.from("other tenant"), "the sweep stays in its tenant");
			if (dir !== null) {
				const left = readdirSync(join(dir, "acme", kept.blobId.slice(0, 2)));
				assert.ok(left.includes(kept.blobId) && left.includes("README"), "the kept blob and the foreign file stay");
				assert.ok(!left.some((n) => n.endsWith(".tmp")), "the leftover temporary file is gone");
			}
			assert.equal(await blobs.delete("acme", kept.blobId), true);
			assert.equal(await blobs.exists("acme", kept.blobId), false);
		} finally { state.close(); rmSync(root, { recursive: true, force: true }); }
	});
}

test("content keys: rotation keeps old blobs readable, a restore rotation never retires them, they persist", async () => {
	const root = scratch();
	const stateDir = join(root, "state"), blobDir = join(root, "blobs");
	try {
		let state = await DeploymentState.open({ dir: stateDir });
		let blobs = await BlobStore.open(blobDir, state);
		const first = await blobs.put(owner(), Buffer.from("v1"));
		assert.equal(state.rotateContentKey(), 2);
		assert.equal(state.currentContentKey().generation, 1, "a new generation seals nothing before a state backup holds it");
		state.markBackedUp(state.seq());
		const second = await blobs.put(owner({ version: 2 }), Buffer.from("v2"));
		assert.equal(second.keyGeneration, 2);
		// a restore retires every signing generation, never a content key
		state.rotateKeyRetiringAll();
		assert.deepEqual(await blobs.get(owner(), first), Buffer.from("v1"));
		assert.equal(statSync(join(stateDir, CONTENT_KEYS_FILE)).mode & 0o777, 0o600);
		state.close();

		state = await DeploymentState.open({ dir: stateDir });
		blobs = await BlobStore.open(blobDir, state);
		assert.equal(state.currentContentKey().generation, 2);
		assert.deepEqual(await blobs.get(owner(), first), Buffer.from("v1"));
		assert.deepEqual(await blobs.get(owner({ version: 2 }), second), Buffer.from("v2"));
		state.close();

		// a fresh deployment state has other keys: the blobs stay sealed (a copied blob directory alone is unreadable)
		const foreign = await DeploymentState.open({ dir: join(root, "state-2") });
		try { await assert.rejects((await BlobStore.open(blobDir, foreign)).get(owner(), first), /authenticate/); }
		finally { foreign.close(); }

		chmodSync(join(stateDir, CONTENT_KEYS_FILE), 0o644);
		await assert.rejects(DeploymentState.open({ dir: stateDir }), StateUnavailable);
		writeFileSync(join(stateDir, CONTENT_KEYS_FILE), "{}", { mode: 0o600 });
		chmodSync(join(stateDir, CONTENT_KEYS_FILE), 0o600);
		await assert.rejects(DeploymentState.open({ dir: stateDir }), /lacks the key material of generation 1, 2/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("the service opens its blob directory apart from the data and state directories", async () => {
	const root = scratch();
	try {
		await assert.rejects(FilesService.open({ dataDir: join(root, "data"), stateDir: join(root, "state"), blobDir: join(root, "data", "blobs") }), /blob directory .* must not overlap/);
		await assert.rejects(FilesService.open({ dataDir: join(root, "data"), stateDir: join(root, "state"), blobDir: join(root, "state") }), /must not overlap/);
		const s = await FilesService.open({ dataDir: join(root, "data"), stateDir: join(root, "state"), blobDir: join(root, "blobs") });
		try {
			assert.equal(s.blobs.dir, join(root, "blobs"));
			assert.equal(statSync(join(root, "blobs")).mode & 0o777, 0o700);
		} finally { await s.close(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("the sweep waits while a save's take of the old content row is unresolved, also across a crash", async () => {
	const root = scratch();
	const dirs = { dataDir: join(root, "data"), stateDir: join(root, "state"), blobDir: join(root, "blobs") };
	const NODE = "f".repeat(22);
	try {
		let s = await FilesService.open(dirs);
		await s.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "s" });
		const old = await s.blobs.put(owner({ nodeId: NODE }), Buffer.from("version 1"));
		const orphan = await s.blobs.put(owner({ nodeId: NODE, version: 2 }), Buffer.from("never committed"));
		await s.inTenant("acme", (sp) => sp.write(content(NODE, 1, old), null, FOREVER));
		// a save has taken the old row inside its transaction and has not committed when the process dies
		const txn = await s.inTenant("acme", async (sp) => {
			const t = await sp.createTransaction(3600_000);
			assert.ok(await sp.take({ type: T.content, fields: { nodeId: NODE } }, 0, { txn: t.id }));
			assert.equal((await sp.readAll({ type: T.content })).length, 0, "the taken row is invisible to a read");
			return t.id;
		});
		assert.equal(await s.sweepBlobs("acme"), null, "an open reservation stops the sweep");
		await s.close();

		s = await FilesService.open(dirs);
		try {
			// the tenant starts closed while a transaction of the earlier process is open (section 6.1)
			await assert.rejects(s.sweepBlobs("acme"), (e: Error & { code?: string }) => e.code === "unavailable", "after the restart, before the reservation resolves");
			assert.equal(await s.blobs.exists("acme", old.blobId), true);
			// the save is abandoned: its take comes back, and only now may the sweep run
			await new PhiSpaces(s.host, ctx, Date.now, undefined, undefined, { space: tenantAlias("acme") }).abort(txn);
			assert.equal(await s.sweepBlobs("acme"), 1);
			assert.equal(await s.blobs.exists("acme", orphan.blobId), false);
			const row = await s.inTenant("acme", (sp) => sp.readIfExists({ type: T.content, fields: { nodeId: NODE } }, 0));
			assert.deepEqual(await s.blobs.get(owner({ nodeId: NODE }), { blobId: row!.fields.blobId as string, size: row!.fields.size as number, keyGeneration: row!.fields.keyGeneration as number }), Buffer.from("version 1"));
		} finally { await s.close(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});
