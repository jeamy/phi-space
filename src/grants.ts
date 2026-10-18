// Short-lived control-primary grants. Verification never trusts roles, scope or authority from a client presentation.
import { randomBytes, verify } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import { type Signer, type KeyDirectory, type AuthState } from "./auth.ts";
import type { Principal } from "./claims.ts";
import { DEFAULT_POLICY, type Policy, type IdentityAdapter, type Connection, type Call, type Identity, type DecisionAuthorization } from "./service.ts";
import * as core from "./core.ts";

export type Grant = { id: string; authorityId: string; issuerHostId: string; principal: Principal; keyId?: string; scope: string[]; roles: string[]; issuedAt: number; expiresAt: number; purpose: "effect" | "resolution" };
export type SignedGrant = { grant: Grant; algorithm: Signer["algorithm"]; signature: string };
const bytes = (g: Grant) => Buffer.from("phi-spaces/grant/v1\n" + canonicalJson(g as unknown as core.Json));
const RESOLUTION = new Set(["hello", "pollOperation", "resolveOperation", "cancelOperation", "txn", "lease", "rotationStatus"]);
export class GrantDenied extends core.PermissionError {}

/** Only instantiate on the authoritative control host, with its durable/provisioned signing key. */
export class GrantAuthority {
	private o: { authorityId: string; hostId: string; signer: Signer; keys: KeyDirectory; identity: IdentityAdapter; now?: () => number; ttlMs?: number; allowAOnly?: () => Promise<boolean>; refreshIdentity: (conn: Connection) => Promise<Identity | null> };
	constructor(o: { authorityId: string; hostId: string; signer: Signer; keys: KeyDirectory; identity: IdentityAdapter; now?: () => number; ttlMs?: number; allowAOnly?: () => Promise<boolean>; refreshIdentity: (conn: Connection) => Promise<Identity | null> }) {
		this.o = o;
		if (!Number.isSafeInteger(o.ttlMs ?? 60000) || (o.ttlMs ?? 60000) < 1 || (o.ttlMs ?? 60000) > 60000) throw new core.IllegalArgumentError("grant TTL must be 1..60000 ms");
	}
	async issue(conn: Connection, purpose: Grant["purpose"] = "effect", agentId?: string): Promise<SignedGrant> {
		if (purpose !== "effect" && purpose !== "resolution") throw new GrantDenied("invalid grant purpose");
		const id = await this.o.refreshIdentity(conn);
		if (!id) throw new GrantDenied("no current overlay identity");
		const proof = (conn.state as AuthState | undefined)?.proof;
		let roles = [...id.roles], scope = ["*"];
		if (proof) {
			const key = await this.o.keys.find(id.principal.peerId, proof.keyId);
			if (!key || key.state !== "active") throw new GrantDenied("the app key is not active");
			roles = roles.filter(r => key.roles.includes(r)); scope = key.scope ?? [];
		} else {
			if (purpose === "resolution") throw new GrantDenied("resolution needs a still-active app key");
			if (this.o.allowAOnly && !(await this.o.allowAOnly())) { if (!roles.includes("unpaired")) throw new GrantDenied("A-only rights remain disabled after recovery"); roles = ["unpaired"]; scope = ["control"]; }
		}
		if (purpose === "effect" && !roles.length) throw new GrantDenied("no current effect rights");
		if(agentId!==undefined && (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agentId)||!proof||!roles.includes("host")))throw new GrantDenied("only a proven host may grant its own local agent namespace");
		const now = (this.o.now ?? Date.now)();
		const grant: Grant = { id: randomBytes(16).toString("hex"), authorityId: this.o.authorityId, issuerHostId: this.o.hostId, principal: agentId===undefined?id.principal:{peerId:id.principal.peerId,agentId}, ...(proof ? { keyId: proof.keyId } : {}), scope, roles, issuedAt: now, expiresAt: now + (this.o.ttlMs ?? 60000), purpose };
		return { grant, algorithm: this.o.signer.algorithm, signature: Buffer.from(await this.o.signer.sign(bytes(grant))).toString("base64") };
	}
}

export class GrantVerifier {
	private o: { authorityId: string; issuerHostId: string; publicKey: string; algorithm: Signer["algorithm"]; now?: () => number; uncertaintyMs?: number; policy?: Policy };
	constructor(o: { authorityId: string; issuerHostId: string; publicKey: string; algorithm: Signer["algorithm"]; now?: () => number; uncertaintyMs?: number; policy?: Policy }) {
		this.o = o;
		if ((o.uncertaintyMs ?? 2000) < 0) throw new core.IllegalArgumentError("invalid clock uncertainty");
	}
	check(token: unknown, id: Identity, call: Call, conn?: Connection): DecisionAuthorization {
		const t = token as SignedGrant | undefined, g = t?.grant;
		if (!g || t!.algorithm !== this.o.algorithm || typeof t!.signature !== "string") throw new GrantDenied("a signed control grant is required");
		if (!verifyDetached(this.o.algorithm, this.o.publicKey, bytes(g), t!.signature)) throw new GrantDenied("invalid grant signature");
		const now = (this.o.now ?? Date.now)(), margin = this.o.uncertaintyMs ?? 2000;
		if (g.authorityId !== this.o.authorityId || g.issuerHostId !== this.o.issuerHostId) throw new GrantDenied("grant authority or issuer mismatch");
		if (canonicalJson(g.principal as unknown as core.Json) !== canonicalJson(id.principal as unknown as core.Json)) throw new GrantDenied("grant belongs to another principal");
		if (conn && g.keyId !== (conn.state as AuthState | undefined)?.proof?.keyId) throw new GrantDenied("grant belongs to another app key");
		if (!Number.isSafeInteger(g.issuedAt) || !Number.isSafeInteger(g.expiresAt) || g.expiresAt <= g.issuedAt || g.expiresAt - g.issuedAt > 60000 || g.issuedAt > now + margin || now + margin >= g.expiresAt) throw new GrantDenied("grant expired or has invalid timestamps");
		if (!Array.isArray(g.roles) || !g.roles.every(r => typeof r === "string") || !Array.isArray(g.scope) || !g.scope.every(s => typeof s === "string")) throw new GrantDenied("invalid grant roles or scope");
		const space = call.space ?? "default";
		// Own-key housekeeping does not grant access to control-space data. The rotation wrapper enforces ownership.
		const ownKeyOperation = !!conn && !!g.keyId && ["rotationChallenge", "rotationGeneration", "rotateKey", "rotationStatus"].includes(String(call.method));
		if (!ownKeyOperation && !g.scope.includes("*") && !g.scope.includes(space)) throw new GrantDenied("space outside grant scope");
		if (g.purpose === "resolution" && (!RESOLUTION.has(call.method) || (call.method === "txn" && call.args?.action !== "abort") || (call.method === "lease" && call.args?.action !== "cancel"))) throw new GrantDenied("resolution grants cannot create effects");
		if (g.purpose !== "effect" && g.purpose !== "resolution") throw new GrantDenied("invalid grant purpose");
		return { validUntil: g.expiresAt - margin, roles: g.purpose === "resolution" ? ["resolution"] : id.roles.filter(r => g.roles.includes(r)), canExecutePending: (method, template) => g.purpose === "effect" && id.roles.filter(r => g.roles.includes(r)).some(role => {
			const r = (this.o.policy ?? DEFAULT_POLICY).roles[role], m = (method.startsWith("take") ? "take" : method.startsWith("read") ? "read" : method) as Call["method"];
			return r && (r.methods === "*" || r.methods.includes(m)) && (!r.types || (!!template?.type && r.types.includes(template.type)));
		}), check: () => { if ((this.o.now ?? Date.now)() + margin >= g.expiresAt) throw new GrantDenied("grant expired before commit"); } };
	}
}
// Detached signatures share the same accepted key formats as app proofs.
import { createPublicKey } from "node:crypto";
export function verifyDetached(algorithm: Signer["algorithm"], publicKey: string, message: Uint8Array, signature: string): boolean {
	try { const raw = Buffer.from(publicKey, "base64"), key = createPublicKey({ key: algorithm === "ed25519" ? Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]) : raw, format: "der", type: "spki" }); return verify(algorithm === "ed25519" ? null : "sha256", message, key, Buffer.from(signature, "base64")); } catch { return false; }
}
