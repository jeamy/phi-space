// Layer B of the identity (federation-plan-v3.md 4.3, AP 1b.3): an app key per principal, proven per connection.
//
// The gate (layer A) knows which NetBird peer is on the other end. For privileged roles that is not enough: the client must
// also prove it holds a key that the control space lists for that peer. The proof is a challenge:
//   host -> client  { gateHostId, observedPeerId, connNonce (32 bytes), protocol, issuedAt }
//   client -> host  signature over the canonical encoding of exactly that object
// The client checks that `gateHostId` is the host it meant to talk to and `observedPeerId` is its own peer id before it
// signs, so a malicious peer that relays a challenge to a victim gets a refusal (the victim sees a foreign peer id). The nonce
// is used once and valid for 30 s. WireGuard binds the traffic of the connection to the peer afterwards, so requests are not
// signed individually (open question F4).
//
// Effective roles are the INTERSECTION of the roles of the groups (layer A) and the roles of the key: neither can add what
// the other did not grant. Without a proof only the A-only roles remain (not the privileged ones).
//
// Keys: Ed25519 (raw 32-byte public key) or ECDSA P-256 with SHA-256 (SPKI DER public key, DER signatures: what the Android
// keystore produces; Gate 6). Public keys are base64.
import { createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import type { Connection, Reply } from "./service.ts";
import type { Json } from "./core.ts";

export const AUTH_PROTOCOL = 1;
export const CHALLENGE_TTL_MS = 30_000;
export type Algorithm = "ed25519" | "ecdsa-p256";

/** An entry of the control space: one key of one peer. Written by the supervisor, never by the client. */
export type PeerKeyRec = {
	peerId: string; // the NetBird peer this key may be used from
	keyId: string;
	principal: string; // who holds it (for the audit trail)
	algorithm: Algorithm;
	publicKey: string; // base64
	roles: string[]; // what this key may be: intersected with the roles of the groups
	state: "active" | "revoked";
};
export interface KeyDirectory {
	/** The key if it exists (any state), else null. */
	find(peerId: string, keyId: string): Promise<PeerKeyRec | null>;
}
/** Keys in memory: tests and tools. */
export class MemoryKeyDirectory implements KeyDirectory {
	private keys = new Map<string, PeerKeyRec>();
	add(rec: PeerKeyRec): void { this.keys.set(`${rec.peerId}\n${rec.keyId}`, { ...rec, roles: [...rec.roles] }); }
	revoke(peerId: string, keyId: string): void { const k = this.keys.get(`${peerId}\n${keyId}`); if (k) k.state = "revoked"; }
	async find(peerId: string, keyId: string): Promise<PeerKeyRec | null> { const k = this.keys.get(`${peerId}\n${keyId}`); return k ? { ...k, roles: [...k.roles] } : null; }
}

// ---- cryptography

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const publicKeyObject = (algorithm: Algorithm, publicKey: string): KeyObject => {
	const raw = Buffer.from(publicKey, "base64");
	if (algorithm === "ed25519") {
		if (raw.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
		return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
	}
	return createPublicKey({ key: raw, format: "der", type: "spki" });
};
const DOMAIN = "pi-spaces/auth/v1\n";
/** What is signed: a domain tag plus the canonical encoding of the challenge. */
export const signedBytes = (challenge: Challenge): Buffer => Buffer.from(DOMAIN + canonicalJson(challenge as unknown as Json), "utf8");

export function verifySignature(rec: Pick<PeerKeyRec, "algorithm" | "publicKey">, challenge: Challenge, signature: string): boolean {
	try {
		const key = publicKeyObject(rec.algorithm, rec.publicKey);
		const sig = Buffer.from(signature, "base64");
		return rec.algorithm === "ed25519" ? cryptoVerify(null, signedBytes(challenge), key, sig) : cryptoVerify("sha256", signedBytes(challenge), key, sig);
	} catch { return false; }
}

/** What a client holds: a key id and a way to sign (the private key may live in a keystore). */
export type Signer = { keyId: string; algorithm: Algorithm; /** base64 public key: needed to enroll it */ publicKey?: string; sign(data: Uint8Array): Promise<Uint8Array> | Uint8Array };
/** A fresh key pair in this process (tests, desktop tools). The public half goes to the control space. */
export function generateKey(algorithm: Algorithm, keyId: string): { signer: Signer; publicKey: string } {
	if (algorithm === "ed25519") {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		const raw = publicKey.export({ format: "der", type: "spki" }).subarray(ED25519_SPKI_PREFIX.length);
		const pub = Buffer.from(raw).toString("base64");
		return { publicKey: pub, signer: { keyId, algorithm, publicKey: pub, sign: (d) => cryptoSign(null, Buffer.from(d), privateKey) } };
	}
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const pub = Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64");
	return { publicKey: pub, signer: { keyId, algorithm, publicKey: pub, sign: (d) => cryptoSign("sha256", Buffer.from(d), privateKey) } };
}

// ---- the challenge

export type Challenge = { gateHostId: string; observedPeerId: string; connNonce: string; protocol: number; issuedAt: number };

/** Per-connection state the gate owns and the proving service reads and writes (Connection.state). */
export type AuthState = {
	challenge?: { value: Challenge; used: boolean };
	proof?: { keyId: string; principal: string; roles: string[]; at: number };
	failures?: number;
};

export type ProvingOptions = {
	/** The id this host gives itself; clients check it against the host they meant to reach. */
	gateHostId: string;
	keys: KeyDirectory;
	now?: () => number;
	/** Wrong proofs allowed per connection before it is closed by the caller (default 5). */
	maxFailures?: number;
	/** Roles that need a proof: without one they are withheld. */
	privilegedRoles?: readonly string[];
};
export const DEFAULT_PRIVILEGED = ["admin", "router", "replicator", "supervisor", "host"] as const;

const reply = (r: Reply): Reply => r;
const bad = (code: "BadRequest" | "PermissionDenied" | "Unauthenticated", message: string): Reply => reply({ ok: false, error: { code, message } });
const stateOf = (conn: Connection): AuthState => ((conn.state ??= {}) as AuthState);

/**
 * Wraps a service with the two methods of the proof, `challenge` and `prove`, and tells a client that is missing a proof
 * (`ProofRequired`) instead of a plain refusal when roles were withheld because there is no proof.
 */
export class ProvingService {
	private inner: { handle(call: unknown, conn: Connection, ...rest: never[]): Promise<Reply>; handleText(text: string, conn: Connection, maxFrameBytes?: number): Promise<string> };
	private o: Required<Pick<ProvingOptions, "maxFailures">> & ProvingOptions;

	constructor(inner: ProvingService["inner"], o: ProvingOptions) {
		this.inner = inner;
		this.o = { maxFailures: 5, ...o };
	}

	async handleText(text: string, conn: Connection, maxFrameBytes?: number): Promise<string> {
		let call: unknown;
		try { call = JSON.parse(text); } catch { return this.inner.handleText(text, conn, maxFrameBytes); }
		const method = (call as { method?: unknown } | null)?.method;
		if (method === "challenge" || method === "prove") return JSON.stringify(await this.proof(call as { method: string; args?: Json }, conn));
		return this.annotate(await this.inner.handleText(text, conn, maxFrameBytes), conn);
	}
	async handle(call: unknown, conn: Connection): Promise<Reply> {
		const method = (call as { method?: unknown } | null)?.method;
		if (method === "challenge" || method === "prove") return this.proof(call as { method: string; args?: Json }, conn);
		const r = await this.inner.handle(call, conn);
		return JSON.parse(this.annotate(JSON.stringify(r), conn));
	}

	/** A refusal because roles are withheld is ProofRequired: the client can fix it by proving. */
	private annotate(text: string, conn: Connection): string {
		const st = stateOf(conn);
		if (st.proof) return text;
		const A = (conn.credentials as { roles?: string[] } | undefined)?.roles ?? [];
		const privileged = this.o.privilegedRoles ?? DEFAULT_PRIVILEGED;
		if (!A.some((r) => privileged.includes(r))) return text;
		try {
			const r = JSON.parse(text) as Reply;
			if (!r.ok && r.error.code === "PermissionDenied") return JSON.stringify({ ok: false, error: { ...r.error, code: "ProofRequired", message: "a proof of your app key is required for this: call challenge, then prove" } });
		} catch { /* not JSON: leave it */ }
		return text;
	}

	private async proof(call: { method: string; args?: Json }, conn: Connection): Promise<Reply> {
		const now = (this.o.now ?? Date.now)();
		const st = stateOf(conn);
		const peerId = conn.peerId;
		if (!peerId) return bad("Unauthenticated", "the connection has no known peer");
		const args = (call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {}) as Record<string, Json>;
		if (call.method === "challenge") {
			if (args.protocol !== AUTH_PROTOCOL) return bad("BadRequest", `this host speaks auth protocol ${AUTH_PROTOCOL}`);
			const value: Challenge = { gateHostId: this.o.gateHostId, observedPeerId: peerId, connNonce: randomBytes(32).toString("hex"), protocol: AUTH_PROTOCOL, issuedAt: now };
			st.challenge = { value, used: false };
			return { ok: true, result: { ...value, expiresAt: now + CHALLENGE_TTL_MS } };
		}
		// prove
		const fail = (message: string): Reply => {
			st.failures = (st.failures ?? 0) + 1;
			if (st.challenge) st.challenge.used = true; // a challenge is good for one attempt
			return bad("PermissionDenied", message);
		};
		if ((st.failures ?? 0) >= this.o.maxFailures) return bad("PermissionDenied", "too many wrong proofs on this connection");
		const ch = st.challenge;
		if (!ch || ch.used) return fail("no open challenge: call challenge first");
		if (typeof args.keyId !== "string" || typeof args.signature !== "string" || args.challenge === undefined) return fail("prove needs keyId, signature and the challenge");
		if (canonicalJson(args.challenge as Json) !== canonicalJson(ch.value as unknown as Json)) return fail("this is not the challenge issued on this connection");
		if (now - ch.value.issuedAt > CHALLENGE_TTL_MS || now < ch.value.issuedAt) return fail("the challenge has expired");
		const key = await this.o.keys.find(peerId, args.keyId);
		if (!key || key.peerId !== peerId) return fail("unknown key for this peer");
		if (key.state !== "active") return fail("the key is revoked");
		if (!verifySignature(key, ch.value, args.signature)) return fail("the signature does not match");
		ch.used = true;
		st.proof = { keyId: key.keyId, principal: key.principal, roles: [...key.roles], at: now };
		return { ok: true, result: { keyId: key.keyId, principal: key.principal, roles: key.roles } };
	}
}
