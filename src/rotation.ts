// App-key rotation: a persisted, one-use challenge and proofs of both keys; privileges are copied, never supplied by clients.
import { randomBytes } from "node:crypto";
import type { Context } from "./context.ts";
import type { SpaceHost } from "./client.ts";
import { PhiSpaces } from "./client.ts";
import type { Algorithm } from "./auth.ts";
import { keyFingerprint, CONTROL_SPACE } from "./enroll.ts";
import { spaceDoc } from "./spaces.ts";
import { canonicalJson } from "./canonical.ts";
import { verifyDetached } from "./grants.ts";
import * as core from "./core.ts";

export type RotationChallenge = { nonce: string; peerId: string; oldKeyId: string; newKeyId: string; newAlgorithm: Algorithm; newPublicKey: string; issuedAt: number; expiresAt: number };
export const rotationBytes = (c: RotationChallenge) => Buffer.from("phi-spaces/rotate/v1\n" + canonicalJson(c as unknown as core.Json));
export async function createRotationChallenge(host: SpaceHost, ctx: Context, peerId: string, oldKeyId: string, algorithm: Algorithm, publicKey: string, now = Date.now(), check: () => void = () => {}): Promise<RotationChallenge> {
	if (!["ed25519", "ecdsa-p256"].includes(algorithm) || Buffer.byteLength(publicKey) > 1024) throw new core.IllegalArgumentError("invalid replacement key");
	return host.commit(async tx => {
		const s = await spaceDoc(tx, CONTROL_SPACE, now);
		check();
		const old = core.list(s, now, { type: "PeerKey", fields: { peerId, keyId: oldKeyId, state: "active" } })[0];
		if (!old) throw new core.PermissionError("rotation needs an active old key");
		if (core.count(s, now, { type: "Rotation", fields: { peerId } }) >= 3) throw new core.ResourceExhausted("too many open rotation challenges");
		const challenge: RotationChallenge = { nonce: randomBytes(32).toString("hex"), peerId, oldKeyId, newKeyId: keyFingerprint(publicKey), newAlgorithm: algorithm, newPublicKey: publicKey, issuedAt: now, expiresAt: now + 30000 };
		if (challenge.newKeyId === oldKeyId) throw new core.IllegalArgumentError("replacement key must differ");
		core.write(s, now, { type: "Rotation", fields: { ...challenge, state: "open" } }, null, 30000);
		return challenge;
	}, ctx);
}
export function rotateKeyIn(s: core.SpaceState, now: number, o: { challenge: RotationChallenge; oldSignature: string; newSignature: string }, requestedBy: string): { oldKeyId: string; newKeyId: string; peerId: string } {
	const c = o.challenge;
	if (!c || requestedBy !== c.peerId || c.issuedAt > now || now >= c.expiresAt) throw new core.PermissionError("rotation challenge owner or expiry mismatch");
	const pending = core.list(s, now, { type: "Rotation", fields: { nonce: c.nonce, state: "open" } })[0];
	if (!pending || canonicalJson(Object.fromEntries(Object.entries(pending.fields).filter(([k]) => k !== "state")) as core.Json) !== canonicalJson(c as unknown as core.Json)) throw new core.PermissionError("unknown, used or changed rotation challenge");
	const old = core.list(s, now, { type: "PeerKey", fields: { peerId: c.peerId, keyId: c.oldKeyId, state: "active" } })[0];
	if (!old || !verifyDetached(old.fields.algorithm as Algorithm, old.fields.publicKey as string, rotationBytes(c), o.oldSignature) || !verifyDetached(c.newAlgorithm, c.newPublicKey, rotationBytes(c), o.newSignature)) throw new core.PermissionError("rotation requires valid signatures from both keys");
	if (core.count(s, now, { type: "PeerKey", fields: { peerId: c.peerId, keyId: c.newKeyId } })) throw new core.PermissionError("replacement key already exists");
	const cost = Buffer.byteLength(JSON.stringify(old.fields)) * 2 + Buffer.byteLength(JSON.stringify(c)) + 1024;
	if (cost > core.limitsOf(s).maxCommitBytes) throw new core.ResourceExhausted("rotation exceeds the atomic commit budget");
	// Both were listed as visible in this commit; a take that still misses would leave the old key active beside the new one.
	if (core.probe(s, now, { id: pending.id }, null, true).status !== "found" || core.probe(s, now, { id: old.id }, null, true).status !== "found") throw new core.PermissionError("rotation entries could not be consumed");
	core.write(s, now, { type: "PeerKey", fields: { ...old.fields, state: "revoked" } }, null, core.FOREVER);
	core.write(s, now, { type: "PeerKey", fields: { ...old.fields, keyId: c.newKeyId, algorithm: c.newAlgorithm, publicKey: c.newPublicKey, state: "active" } }, null, core.FOREVER);
	return { peerId: c.peerId, oldKeyId: c.oldKeyId, newKeyId: c.newKeyId };
}

import type { Connection, IdentityAdapter, Reply, Call } from "./service.ts";
import type { KeyDirectory, AuthState } from "./auth.ts";
import type { GrantVerifier } from "./grants.ts";
import * as claims from "./claims.ts";
import { principalId } from "./mailbox.ts";
export class RotationService {
	private inner: { handle(c: unknown, conn: Connection): Promise<Reply>; handleText(t: string, conn: Connection, max?: number): Promise<string> };
	private o: { host: SpaceHost; ctx: Context; keys: KeyDirectory; identity: IdentityAdapter; verifier: GrantVerifier; now?: () => number };
	constructor(inner: { handle(c: unknown, conn: Connection): Promise<Reply>; handleText(t: string, conn: Connection, max?: number): Promise<string> }, o: { host: SpaceHost; ctx: Context; keys: KeyDirectory; identity: IdentityAdapter; verifier: GrantVerifier; now?: () => number }) { this.inner = inner; this.o = o; }
	async handleText(t: string, conn: Connection, max = 256 * 1024): Promise<string> {
		if (Buffer.byteLength(t) > max) return JSON.stringify({ ok: false, error: { code: "ResourceExhausted", message: "rotation frame too large" } });
		let c: any; try { c = JSON.parse(t); } catch { return this.inner.handleText(t, conn, max); }
		return ["rotationChallenge", "rotationGeneration", "rotateKey", "rotationStatus"].includes(c?.method) ? JSON.stringify(await this.handle(c, conn)) : this.inner.handleText(t, conn, max);
	}
	async handle(c: unknown, conn: Connection): Promise<Reply> {
		const call = c as any;
		if (!["rotationChallenge", "rotationGeneration", "rotateKey", "rotationStatus"].includes(call?.method)) return this.inner.handle(c, conn);
		try {
			const id = await this.o.identity.authenticate(conn), proof = (conn.state as AuthState | undefined)?.proof;
			if (!id || !proof) throw new core.PermissionError("rotation requires a proven app key");
			const key = await this.o.keys.find(id.principal.peerId, proof.keyId);
			if (!key || key.state !== "active") throw new core.PermissionError("the app key is no longer active");
			const authorization = this.o.verifier.check(call.frame?.grant, id, { ...call, space: CONTROL_SPACE } as Call, conn); authorization.check();
			const a = call.args ?? {}, now = (this.o.now ?? Date.now)();
			if (call.method === "rotationGeneration") return { ok: true, result: await new PhiSpaces(this.o.host, this.o.ctx, this.o.now, undefined, undefined, { space: CONTROL_SPACE, authorization }).issueGeneration(id.principal) };
			if (call.method === "rotationChallenge") return { ok: true, result: await createRotationChallenge(this.o.host, this.o.ctx, id.principal.peerId, proof.keyId, a.algorithm, a.publicKey, now, authorization.check) as unknown as core.Json };
			if (call.method === "rotationStatus") {
				const state = await this.o.host.snapshot((await import("./spaces.ts")).Registry, this.o.ctx);
				const controlId = state?.aliases[CONTROL_SPACE];
				const s = controlId ? await (await import("./spaces.ts")).snapshotSpace(this.o.host, controlId, this.o.ctx) : undefined;
				const entry = s ? core.list(s, now, { type: "Result", fields: { commandId: a.commandId, requestedBy: id.principal.peerId } })[0] : undefined;
				return { ok: true, result: entry ? entry.fields : { state: "pending" } };
			}
			if (!a.challenge || a.challenge.peerId !== id.principal.peerId || a.challenge.oldKeyId !== proof.keyId) throw new core.PermissionError("rotation challenge belongs to another key");
			const r = call.request;
			if (!r?.generation || !r.requestId) throw new core.IllegalArgumentError("rotateKey requires a request identity");
			const result = await this.o.host.commit(async tx => {
				const s = await spaceDoc(tx, CONTROL_SPACE, now); authorization.check();
				const args = { challenge: a.challenge, oldSignature: a.oldSignature, newSignature: a.newSignature } as core.Json;
				const admitted = claims.admit(s, now, { principal: id.principal, ...r }, "rotateKey", args, core.FOREVER);
				if (admitted.kind === "done") return admitted.result;
				if (admitted.kind === "cancelled") throw new claims.OperationCancelled("rotation was cancelled");
				// Verify against a detached preview before creating a command; invalid requests cannot queue privileged work.
				const preview = core.previewOf(s); core.beginCommit(preview);
				rotateKeyIn(preview, now, args as unknown as { challenge: RotationChallenge; oldSignature: string; newSignature: string }, id.principal.peerId);
				const commandId = `rotate:${id.principal.peerId}:${a.challenge.nonce}`;
				core.write(s, now, { type: "Command", fields: { commandId, kind: "rotateKey", args } }, null, 60000, principalId(id.principal));
				const out = { state: "accepted", commandId }; claims.decide(s, now, admitted.key, { state: "done", result: out }); return out;
			}, this.o.ctx);
			return { ok: true, result };
		} catch (e) { return { ok: false, error: { code: e instanceof core.ResourceExhausted ? "ResourceExhausted" : "PermissionDenied", message: e instanceof Error ? e.message : String(e) } }; }
	}
}
