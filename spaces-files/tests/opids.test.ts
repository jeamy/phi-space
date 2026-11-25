// Operation IDs and receipts (docs/zanzibar-agent-filesystem-plan.en.md, sections 3, 5 and 6.2): signed per actor and
// tenant, rejected outside the retry window from the exact expiry instant on, also after a restart with a clock that
// went back; rapid rotations invalidate nothing early, a restore rotation everything; receipts answer a matching
// retry, refuse another digest, are bounded per pool and pruned only once expired.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "phi-spaces";
import { FOREVER } from "phi-spaces/core";
import { DeploymentState } from "../server/deployment.ts";
import { DEFAULT_FS_LIMITS } from "../server/limits.ts";
import { issueOperationIds, OperationIdRejected, verifyOperationId, type OpIdActor } from "../server/opids.ts";
import { lookupReceipt, pruneReceipts, receiptRow, RequestMismatch, reserveReceipt } from "../server/receipts.ts";
import { CapacityExceeded, InvalidInput, T, Unauthenticated } from "../server/schema.ts";
import { FilesService } from "../server/service.ts";

const MIN = 60_000;
const CFG = { retryWindowMs: 60 * MIN, clockSkewMs: 2 * MIN, maxOperationIdsPerCall: 8 };
const LEA: OpIdActor = { tenantId: "acme", actorKind: "user", actorId: "lea" };
const clock = (t = 10_000_000) => { const c = { t, now: () => c.t }; return c; };

test("operation IDs: signed for one actor of one tenant, any change refused", async () => {
	const c = clock();
	const s = await DeploymentState.open({ dir: null, clock: c.now });
	try {
		const ids = issueOperationIds(s, LEA, 3, CFG);
		assert.equal(new Set(ids).size, 3);
		for (const id of ids) {
			const v = verifyOperationId(s, LEA, id, CFG);
			assert.deepEqual(v, { operationId: id, issuedAt: c.t, generation: 1, expiry: c.t + CFG.retryWindowMs });
		}
		for (const count of [0, 9, 1.5, "2", null]) assert.throws(() => issueOperationIds(s, LEA, count, CFG), InvalidInput, String(count));
		const id = ids[0];
		for (const other of [{ ...LEA, actorId: "max" }, { ...LEA, tenantId: "globex" }, { ...LEA, actorKind: "agent" as const }])
			assert.throws(() => verifyOperationId(s, other, id, CFG), /another actor or tenant/);
		const [, payload, mac] = id.split(".");
		const forged = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
		forged.a = "max";
		const forgedId = `o1.${Buffer.from(canonicalJson(forged as never)).toString("base64url")}.${mac}`;
		assert.throws(() => verifyOperationId(s, { ...LEA, actorId: "max" }, forgedId, CFG), /bad signature/);
		for (const bad of ["", "o1.", "o1.x", `o1.${payload}`, `o2.${payload}.${mac}`, `o1.${payload}.${mac}x`, `o1.${payload}.${mac}.x`, "o1." + "a".repeat(600), 7, null])
			assert.throws(() => verifyOperationId(s, LEA, bad, CFG), OperationIdRejected, String(bad));
	} finally { s.close(); }
});

test("operation IDs: the exact expiry instant, a clock moved back and a restart, an ID from the future", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spaces-files-opids-"));
	try {
		const c = clock();
		let s = await DeploymentState.open({ dir, clock: c.now });
		const [id] = issueOperationIds(s, LEA, 1, CFG);
		const issued = c.t;
		assert.ok(s.timeFloor() >= issued, "issuance persists the floor");
		c.t = issued + CFG.retryWindowMs - 1;
		verifyOperationId(s, LEA, id, CFG);
		c.t = issued + CFG.retryWindowMs;
		assert.throws(() => verifyOperationId(s, LEA, id, CFG), /expired/, "rejected at the expiry instant");
		assert.ok(s.timeFloor() >= issued + CFG.retryWindowMs, "the expiry decision persisted the floor");
		s.close();
		// restart with the clock far back: the floor keeps the ID expired
		c.t = issued;
		s = await DeploymentState.open({ dir, clock: c.now });
		assert.throws(() => verifyOperationId(s, LEA, id, CFG), /expired/, "the consumed ID stays expired");
		// an ID whose issue time lies beyond the skew (signed with the real key: only a broken clock produces one)
		const key = s.currentKey()!;
		const p = canonicalJson({ t: "acme", k: "user", a: "lea", i: s.now() + CFG.clockSkewMs + 1, g: key.generation, n: "x" });
		const future = `o1.${Buffer.from(p).toString("base64url")}.${createHmac("sha256", key.secret).update("phi-spaces-files operation ID v1\0").update(p).digest().toString("base64url")}`;
		assert.throws(() => verifyOperationId(s, LEA, future, CFG), /future/);
		s.close();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("operation IDs: rapid rotations, a restart during them, and a restore rotation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spaces-files-opids-"));
	try {
		const c = clock();
		let s = await DeploymentState.open({ dir, clock: c.now });
		const [g1] = issueOperationIds(s, LEA, 1, CFG);
		c.t += MIN;
		s.rotateKey(CFG.retryWindowMs);
		const [g2] = issueOperationIds(s, LEA, 1, CFG);
		c.t += MIN;
		s.rotateKey(CFG.retryWindowMs);
		const [g3] = issueOperationIds(s, LEA, 1, CFG);
		// two rotations within one window: the first ID still verifies
		for (const id of [g1, g2, g3]) verifyOperationId(s, LEA, id, CFG);
		s.close();
		s = await DeploymentState.open({ dir, clock: c.now });
		for (const id of [g1, g2, g3]) verifyOperationId(s, LEA, id, CFG);
		s.rotateKeyRetiringAll();
		for (const id of [g1, g2, g3]) assert.throws(() => verifyOperationId(s, LEA, id, CFG), /unknown or retired/);
		verifyOperationId(s, LEA, issueOperationIds(s, LEA, 1, CFG)[0], CFG);
		s.close();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("receipts: a matching retry answers, another digest is requestMismatch, pools and pruning", async () => {
	const c = clock();
	const svc = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null, now: c.now });
	try {
		await svc.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "s" });
		const st = svc.state;
		await svc.inTenant("acme", async (sp) => {
			const [id] = issueOperationIds(st, LEA, 1, CFG);
			const v = verifyOperationId(st, LEA, id, CFG);
			assert.equal(await lookupReceipt(sp, LEA, id, "d1"), null, "an unused ID");
			await sp.write(receiptRow(LEA, v, "d1", { version: 4 }), null, FOREVER);
			assert.deepEqual(await lookupReceipt(sp, LEA, id, "d1"), { version: 4 });
			await assert.rejects(lookupReceipt(sp, LEA, id, "d2"), RequestMismatch);
			assert.equal(await lookupReceipt(sp, { ...LEA, actorId: "max" }, id, "d1"), null, "receipts are per actor");

			// the ordinary pool is full with live receipts: nothing is evicted, a security action still has room
			const L = { maxReceipts: 3, securityReceiptReserve: 1 };
			for (const oid of issueOperationIds(st, LEA, 2, CFG)) await sp.write(receiptRow(LEA, verifyOperationId(st, LEA, oid, CFG), "d", {}), null, FOREVER);
			await assert.rejects(reserveReceipt(sp, st, L, "ordinary"), CapacityExceeded);
			assert.equal(await sp.count({ type: T.receipt }), 3, "no live receipt removed");
			await reserveReceipt(sp, st, L, "security");
			await sp.write(receiptRow(LEA, verifyOperationId(st, LEA, issueOperationIds(st, LEA, 1, CFG)[0], CFG), "d", {}), null, FOREVER);
			await assert.rejects(reserveReceipt(sp, st, L, "security"), CapacityExceeded, "the reserve is bounded too");

			// one window later the earlier receipts are expired: the bound prunes them first
			c.t += CFG.retryWindowMs;
			const floor = st.timeFloor();
			await reserveReceipt(sp, st, L, "ordinary");
			assert.equal(await sp.count({ type: T.receipt }), 0);
			assert.ok(st.timeFloor() >= c.t && st.timeFloor() > floor, "the floor is persisted before the removal");
			assert.equal(await pruneReceipts(sp, st, 10), 0);
		});
	} finally { await svc.close(); }
});

test("issueOperationIds needs a valid session and a count in range", async () => {
	const svc = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null });
	try {
		await svc.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "s" });
		const { handle } = await svc.login("acme", "user", { issuer: "i", subject: "s" });
		const ids = await svc.issueOperationIds(handle, 2);
		assert.equal(ids.length, 2);
		verifyOperationId(svc.state, LEA, ids[0], svc.limits);
		await assert.rejects(svc.issueOperationIds("nope", 1), Unauthenticated);
		for (const n of [0, DEFAULT_FS_LIMITS.maxOperationIdsPerCall + 1]) await assert.rejects(svc.issueOperationIds(handle, n), InvalidInput);
	} finally { await svc.close(); }
});
