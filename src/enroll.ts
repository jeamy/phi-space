// Pairing (federation-plan-v3.md 4.5, AP 1b.4): how a device gets its app key into the control space.
//
//   1. the device joins the overlay; an admin puts its peer into the enrollment group (role "unpaired" at the gate)
//   2. the admin client makes a token LOCALLY (256 bits) and sends only its SHA-256 hash: `createEnroll` -> an `Enroll`
//      entry {tokenHash, role, scope, allowedPeerId, expiresAt, attempts}; the plain token is in no command, result,
//      entry, claim, log or journal. It travels in the QR code to the device.
//   3. the device connects (layer A), asks for a challenge, signs it with its NEW key and calls `enroll`
//      {token, algorithm, publicKey, signature}. The handler holds the token only in memory, hashes it at once and checks in
//      the order of 4.5: unknown token -> wrong peer (no counter!) -> expiry and attempts -> signature and key format
//      (only this last failure counts against the token).
//   4. on success the token is consumed, the `PeerKey` created and the result stored as an RPC claim in ONE commit. The
//      claim keeps the hash of {tokenHash, publicKey}, so a retry with a new connection proof (other challenge, other
//      signature) hits the same claim and is answered from it, even though the token is spent by then.
//
// Rate limits: at most 3 failed attempts of the bound peer per token (then it is invalid) and one attempt per peer and
// minute. The unpaired peer may do nothing else: `hello`, `generation` and its own `enrollStatus` (policy of the role
// "unpaired", enforced by the wrapper below).
//
// Bootstrap: the first admin is paired with a one-time token created by the locally provisioned supervisor
// (`bootstrapEnroll`). Consuming it closes that power for good; a lost token is replaced (the old hash becomes invalid) while it
// is still open. After that only `createEnroll` of an admin exists (hosts and members, never admins).
import { createHash, randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { Session } from "@earendil-works/pi-durable";
import * as core from "./core.ts";
import * as claims from "./claims.ts";
import { canonicalJson } from "./canonical.ts";
import { createSpace, listSpaces, spaceDoc, snapshotSpace } from "./spaces.ts";
import { verifySignature, type Algorithm, type AuthState, type Challenge, type KeyDirectory, type PeerKeyRec, CHALLENGE_TTL_MS } from "./auth.ts";
import type { Connection, Reply } from "./service.ts";
import type { Json } from "./core.ts";

export const CONTROL_SPACE = "control";
export const ENROLL_TTL_MS = 5 * 60_000;
export const MAX_FAILED_ATTEMPTS = 3;
export const ATTEMPT_INTERVAL_MS = 60_000;
export const UNPAIRED_ROLE = "unpaired";
/** Roles an admin's `createEnroll` may hand out; the admin role only comes through the bootstrap token. */
export const ENROLLABLE_ROLES = ["host", "member", "observer"] as const;

export type EnrollRec = {
	tokenHash: string;
	role: string;
	scope: string[];
	allowedPeerId: string;
	expiresAt: number;
	attempts: number;
	bootstrap: boolean;
	state: "open" | "consumed" | "invalid";
};
type Host = Pick<Session, "commit" | "snapshot">;

export class BootstrapClosed extends Error {}
export class EnrollError extends Error {}

// ---- the admin's side: tokens

/** A fresh 256-bit token, to be made on the admin's device and shown once (QR code, manual entry). */
export const newEnrollToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");
/** What the QR code carries: endpoint, control space and the token. The token is secret; never log this. */
export const enrollQr = (o: { endpoint: string; controlSpaceId: string; token: string }): string => JSON.stringify({ v: 1, endpoint: o.endpoint, space: o.controlSpaceId, token: o.token });
/** The fingerprint of a public key: the id of its PeerKey. */
export const keyFingerprint = (publicKey: string): string => createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex").slice(0, 32);

async function control(host: Host, ctx: Context, now: number): Promise<{ spaceId: string; alias: string }> {
	const known = (await listSpaces(host, ctx)).find((i) => i.alias === CONTROL_SPACE);
	if (known) return known;
	return host.commit((tx) => createSpace(tx, CONTROL_SPACE, now), ctx);
}
const fieldsOf = (e: { fields: core.Fields }): Record<string, Json> => e.fields as Record<string, Json>;
const asEnroll = (e: { fields: core.Fields }): EnrollRec => fieldsOf(e) as unknown as EnrollRec;

function putEnroll(s: core.SpaceState, now: number, rec: EnrollRec): void {
	core.write(s, now, { type: "Enroll", fields: rec as unknown as core.Fields }, null, core.FOREVER);
}
function takeEnroll(s: core.SpaceState, now: number, tokenHash: string): EnrollRec | undefined {
	const p = core.probe(s, now, { type: "Enroll", fields: { tokenHash } }, null, true);
	return p.status === "found" ? asEnroll(p.entry) : undefined;
}
const findEnroll = (s: Readonly<core.SpaceState>, now: number, tokenHash: string): EnrollRec | undefined => { const l = core.list(s, now, { type: "Enroll", fields: { tokenHash } }); return l[0] ? asEnroll(l[0]) : undefined; };

export type CreateEnrollOptions = { tokenHash: string; role: string; allowedPeerId: string; scope?: string[]; ttlMs?: number; now?: () => number };
const checkHash = (h: string) => { if (!/^[0-9a-f]{64}$/.test(h)) throw new core.IllegalArgumentError("tokenHash must be the SHA-256 of the token in hex"); };

/**
 * The supervisor's processing of `createEnroll` (the command comes from a paired admin; the plain token never does). Idempotent:
 * the same hash twice changes nothing. Hosts and members only: an admin token exists only through `bootstrapEnroll`.
 */
export async function createEnroll(host: Host, ctx: Context, o: CreateEnrollOptions): Promise<EnrollRec> {
	validateCreateEnroll(o);
	return writeEnroll(host, ctx, { ...o, bootstrap: false });
}
/** The checks of `createEnroll`, before anything is written. */
export function validateCreateEnroll(o: { tokenHash: string; role: string; allowedPeerId: string }): void {
	checkHash(o.tokenHash);
	if (!(ENROLLABLE_ROLES as readonly string[]).includes(o.role)) throw new core.IllegalArgumentError(`createEnroll hands out ${ENROLLABLE_ROLES.join(", ")}; an admin is paired through the bootstrap token`);
	if (!o.allowedPeerId) throw new core.IllegalArgumentError("a token is bound to the peer id of the device (from the management API)");
}
/** `createEnroll` inside a commit on the control space (the supervisor's command processing); idempotent per hash. */
export function createEnrollIn(s: core.SpaceState, now: number, o: CreateEnrollOptions): EnrollRec {
	validateCreateEnroll(o);
	const have = findEnroll(s, now, o.tokenHash);
	if (have) return core.plain(have);
	const rec: EnrollRec = { tokenHash: o.tokenHash, role: o.role, scope: o.scope ?? [], allowedPeerId: o.allowedPeerId, expiresAt: now + Math.min(o.ttlMs ?? ENROLL_TTL_MS, ENROLL_TTL_MS), attempts: 0, bootstrap: false, state: "open" };
	putEnroll(s, now, rec);
	return rec;
}
/** Revoke every active key of a peer inside a commit; returns how many. */
export function revokePeerKeysIn(s: core.SpaceState, now: number, peerId: string): number {
	let n = 0;
	for (const e of core.list(s, now, { type: "PeerKey", fields: { peerId } })) {
		const f = e.fields as Record<string, Json>;
		if (f.state !== "active") continue;
		const p = core.probe(s, now, { id: e.id }, null, true);
		if (p.status !== "found") continue;
		core.write(s, now, { type: "PeerKey", fields: { ...core.plain(p.entry.fields), state: "revoked" } as core.Fields }, null, core.FOREVER);
		n++;
	}
	return n;
}
/** An admin key of this peer is active (the supervisor checks it when it processes a command). */
export function hasAdminKey(s: Readonly<core.SpaceState>, now: number, peerId: string): boolean {
	return core.list(s, now, { type: "PeerKey", fields: { peerId } }).some((e) => { const f = e.fields as Record<string, Json>; return f.state === "active" && (f.roles as string[]).includes("admin"); });
}
async function writeEnroll(host: Host, ctx: Context, o: CreateEnrollOptions & { bootstrap: boolean }): Promise<EnrollRec> {
	const now = (o.now ?? Date.now)();
	const info = await control(host, ctx, now);
	return host.commit(async (tx) => {
		const s = await spaceDoc(tx, info.spaceId, now);
		const have = findEnroll(s, now, o.tokenHash);
		if (have) return core.plain(have);
		const rec: EnrollRec = { tokenHash: o.tokenHash, role: o.role, scope: o.scope ?? [], allowedPeerId: o.allowedPeerId, expiresAt: now + Math.min(o.ttlMs ?? ENROLL_TTL_MS, ENROLL_TTL_MS), attempts: 0, bootstrap: o.bootstrap, state: "open" };
		putEnroll(s, now, rec);
		return rec;
	}, ctx);
}

/**
 * The one token for the first admin, made by the locally provisioned supervisor, bound to the peer id of the admin's device. While
 * it is unused a new call replaces it (the old hash is invalid); after its consumption this never works again.
 */
export async function bootstrapEnroll(host: Host, ctx: Context, o: { tokenHash: string; allowedPeerId: string; ttlMs?: number; now?: () => number }): Promise<EnrollRec> {
	checkHash(o.tokenHash);
	if (!o.allowedPeerId) throw new core.IllegalArgumentError("the bootstrap token is bound to the peer id of the first admin's device");
	const now = (o.now ?? Date.now)();
	const info = await control(host, ctx, now);
	return host.commit(async (tx) => {
		const s = await spaceDoc(tx, info.spaceId, now);
		const marker = core.list(s, now, { type: "Bootstrap" })[0];
		if (marker && fieldsOf(marker).state === "closed") throw new BootstrapClosed("the first admin is paired already: this host cannot bootstrap again");
		if (!marker) core.write(s, now, { type: "Bootstrap", fields: { state: "open" } }, null, core.FOREVER);
		for (const e of core.list(s, now, { type: "Enroll", fields: { bootstrap: true, state: "open" } })) { // a lost token is replaced
			const old = takeEnroll(s, now, fieldsOf(e).tokenHash as string);
			if (old) putEnroll(s, now, { ...old, state: "invalid" });
		}
		const have = findEnroll(s, now, o.tokenHash);
		if (have) return core.plain(have);
		const rec: EnrollRec = { tokenHash: o.tokenHash, role: "admin", scope: ["*"], allowedPeerId: o.allowedPeerId, expiresAt: now + Math.min(o.ttlMs ?? ENROLL_TTL_MS, ENROLL_TTL_MS), attempts: 0, bootstrap: true, state: "open" };
		putEnroll(s, now, rec);
		return rec;
	}, ctx);
}

// ---- keys in the control space

/** `PeerKey` entries of the control space as the key directory of the gate (layer B). */
export class SpaceKeyDirectory implements KeyDirectory {
	private host: Host; private ctx: Context; private now: () => number;
	constructor(host: Host, ctx: Context, now: () => number = Date.now) { this.host = host; this.ctx = ctx; this.now = now; }
	async find(peerId: string, keyId: string): Promise<PeerKeyRec | null> {
		const info = (await listSpaces(this.host, this.ctx)).find((i) => i.alias === CONTROL_SPACE);
		const s = info ? await snapshotSpace(this.host, info.spaceId, this.ctx) : undefined;
		if (!s) return null;
		const e = core.list(s, this.now(), { type: "PeerKey", fields: { peerId, keyId } })[0];
		return e ? ({ ...fieldsOf(e), roles: [...(fieldsOf(e).roles as string[])] } as unknown as PeerKeyRec) : null;
	}
}
/** Revoke a key (the supervisor's `revokePeer`/`rotateKey` will call this); the gate closes its connections at the next check. */
export async function revokePeerKey(host: Host, ctx: Context, peerId: string, keyId: string, now: () => number = Date.now): Promise<boolean> {
	const t = now();
	const info = await control(host, ctx, t);
	return host.commit(async (tx) => {
		const s = await spaceDoc(tx, info.spaceId, t);
		const p = core.probe(s, t, { type: "PeerKey", fields: { peerId, keyId } }, null, true);
		if (p.status !== "found") return false;
		core.write(s, t, { type: "PeerKey", fields: { ...core.plain(p.entry.fields), state: "revoked" } as core.Fields }, null, core.FOREVER);
		return true;
	}, ctx);
}

// ---- the unpaired peer's side of the wire

export type EnrollOutcome = { ok: true; keyId: string; role: string; peerId: string; scope: string[] } | { ok: false; reason: "unknown-token" | "wrong-peer" | "expired" | "too-many-attempts" | "bad-signature" | "bad-key" | "rate-limited" | "bad-challenge" };

export type EnrollmentOptions = {
	host: Host;
	ctx: Context;
	now?: () => number;
	/** For audit: what happened, never the token. */
	onEvent?: (e: { peerId: string; outcome: string; keyId?: string }) => void;
};

const refuse = (message = "enrollment refused"): Reply => ({ ok: false, error: { code: "PermissionDenied", message } });

/**
 * Wraps the service chain with `enroll` and `enrollStatus`, for peers whose roles contain "unpaired" and nobody else. It sits in
 * front of the layer-B wrapper (the unpaired peer has no key yet) and behind the gate. Failure answers are the same
 * for every reason: a refused peer learns nothing about tokens.
 */
export class EnrollmentService {
	private inner: { handle(call: unknown, conn: Connection, ...rest: never[]): Promise<Reply>; handleText(text: string, conn: Connection, maxFrameBytes?: number): Promise<string> };
	private o: EnrollmentOptions;
	private lastAttempt = new Map<string, number>();

	constructor(inner: EnrollmentService["inner"], o: EnrollmentOptions) { this.inner = inner; this.o = o; }

	async handleText(text: string, conn: Connection, maxFrameBytes?: number): Promise<string> {
		let call: unknown;
		try { call = JSON.parse(text); } catch { return this.inner.handleText(text, conn, maxFrameBytes); }
		const m = (call as { method?: unknown } | null)?.method;
		if (m === "enroll" || m === "enrollStatus") return JSON.stringify(await this.handle(call, conn));
		return this.inner.handleText(text, conn, maxFrameBytes);
	}
	async handle(call: unknown, conn: Connection): Promise<Reply> {
		const m = (call as { method?: unknown } | null)?.method;
		if (m !== "enroll" && m !== "enrollStatus") return this.inner.handle(call, conn);
		const roles = (conn.credentials as { roles?: string[] } | undefined)?.roles ?? [];
		if (!conn.peerId || !roles.includes(UNPAIRED_ROLE)) return refuse("only an unpaired peer may enroll");
		try { return m === "enroll" ? await this.enroll(call as { args?: Record<string, Json>; request?: Record<string, Json> }, conn) : await this.status(call as { request?: Record<string, Json>; args?: Record<string, Json> }, conn); }
		catch (e) { return refuse(e instanceof EnrollError ? e.message : "enrollment refused"); }
	}

	private event(peerId: string, outcome: string, keyId?: string) { try { this.o.onEvent?.({ peerId, outcome, ...(keyId ? { keyId } : {}) }); } catch { /* audit must not break the handler */ } }

	private async enroll(call: { args?: Record<string, Json>; request?: Record<string, Json> }, conn: Connection): Promise<Reply> {
		const now = (this.o.now ?? Date.now)();
		const peerId = conn.peerId!;
		const a = call.args ?? {};
		const r = call.request;
		if (typeof a.token !== "string" || typeof a.publicKey !== "string" || typeof a.signature !== "string" || typeof a.algorithm !== "string" || !r || typeof r.generation !== "string" || typeof r.requestId !== "string") throw new EnrollError("enrollment refused");
		const tokenHash = hashToken(a.token); // the plain token lives in this function only
		const algorithm = a.algorithm as Algorithm;
		if (algorithm !== "ed25519" && algorithm !== "ecdsa-p256") throw new EnrollError("enrollment refused");
		const ref: claims.RequestRef = { principal: { peerId }, generation: r.generation, requestId: r.requestId };
		const challenge = this.consumeChallenge(conn, a.challenge, now);
		const info = await control(this.o.host, this.o.ctx, now);
		const outcome = await this.o.host.commit(async (tx): Promise<EnrollOutcome | { replay: Json }> => {
			const s = await spaceDoc(tx, info.spaceId, now);
			// our own earlier answer first: a retry with a fresh proof must not trip over the spent token
			let exists = false;
			try { claims.lookup(s, ref, now); exists = true; } catch { exists = false; }
			if (exists) { // same identity: the stored answer, or a conflict when it was used for other arguments
				const ad = claims.admit(s, now, ref, "enroll", { tokenHash, publicKey: a.publicKey as string }, core.FOREVER);
				if (ad.kind === "done") return { replay: core.plain(ad.result) };
				throw new EnrollError("enrollment refused");
			}
			// one attempt per peer and minute: any new attempt counts, whatever its outcome (answers from a claim above do not)
			const last = this.lastAttempt.get(peerId);
			if (last !== undefined && now - last < ATTEMPT_INTERVAL_MS) return { ok: false, reason: "rate-limited" };
			this.lastAttempt.set(peerId, now);
			for (const [k, t] of this.lastAttempt) if (now - t >= ATTEMPT_INTERVAL_MS) this.lastAttempt.delete(k);
			// 1. a token with this hash exists (otherwise: refused, counted only against the peer limit above)
			const taken = takeEnroll(s, now, tokenHash);
			if (!taken) return { ok: false, reason: "unknown-token" };
			const restore = (rec: EnrollRec) => putEnroll(s, now, rec);
			if (taken.state !== "open") { restore(taken); return { ok: false, reason: "too-many-attempts" }; }
			// 2. the peer the token is bound to: another peer neither learns more nor burns the token
			if (taken.allowedPeerId !== peerId) { restore(taken); return { ok: false, reason: "wrong-peer" }; }
			// 3. expiry and attempts
			if (now >= taken.expiresAt) { restore({ ...taken, state: "invalid" }); return { ok: false, reason: "expired" }; }
			if (taken.attempts >= MAX_FAILED_ATTEMPTS) { restore({ ...taken, state: "invalid" }); return { ok: false, reason: "too-many-attempts" }; }
			// 4. the signature with the NEW key, over this connection's challenge, and the key format: only this counts as an attempt
			const failed = (reason: "bad-signature" | "bad-key" | "bad-challenge"): EnrollOutcome => {
				const attempts = taken.attempts + 1;
				restore({ ...taken, attempts, state: attempts >= MAX_FAILED_ATTEMPTS ? "invalid" : "open" });
				return { ok: false, reason };
			};
			if (!challenge) return failed("bad-challenge");
			if (!validKey(algorithm, a.publicKey as string)) return failed("bad-key");
			if (!verifySignature({ algorithm, publicKey: a.publicKey as string }, challenge, a.signature as string)) return failed("bad-signature");
			// success: consume the token, create the key, store the answer, all in this commit
			const keyId = keyFingerprint(a.publicKey as string);
			restore({ ...taken, state: "consumed" });
			core.write(s, now, { type: "PeerKey", fields: { peerId, keyId, principal: `enrolled:${peerId}`, algorithm, publicKey: a.publicKey as string, roles: [taken.role], state: "active" } }, null, core.FOREVER);
			if (taken.bootstrap) { // the bootstrap power ends with its first use
				core.probe(s, now, { type: "Bootstrap" }, null, true);
				core.write(s, now, { type: "Bootstrap", fields: { state: "closed" } }, null, core.FOREVER);
			}
			const result = { keyId, role: taken.role, peerId, scope: taken.scope };
			const ad = claims.admit(s, now, ref, "enroll", { tokenHash, publicKey: a.publicKey as string }, core.FOREVER);
			if (ad.kind === "fresh" || ad.kind === "pending") claims.decide(s, now, ad.key, { state: "done", result });
			return { ok: true, keyId, role: taken.role, peerId, scope: taken.scope };
		}, this.o.ctx);
		if ("replay" in outcome) { this.event(peerId, "replayed"); return { ok: true, result: outcome.replay }; }
		if (!outcome.ok) { this.event(peerId, outcome.reason); return outcome.reason === "rate-limited" ? { ok: false, error: { code: "ResourceExhausted", message: "one enrollment attempt per minute" } } : refuse(); }
		this.event(peerId, "enrolled", outcome.keyId);
		return { ok: true, result: { keyId: outcome.keyId, role: outcome.role, peerId: outcome.peerId, scope: outcome.scope } };
	}

	/** The challenge of this connection (issued by the layer-B service) as the new key must have signed it; used once. */
	private consumeChallenge(conn: Connection, claimed: Json | undefined, now: number): Challenge | undefined {
		const st = (conn.state ??= {}) as AuthState;
		const ch = st.challenge;
		if (!ch || ch.used || claimed === undefined) return undefined;
		ch.used = true;
		if (canonicalJson(claimed) !== canonicalJson(ch.value as unknown as Json)) return undefined;
		if (now - ch.value.issuedAt > CHALLENGE_TTL_MS || now < ch.value.issuedAt) return undefined;
		return ch.value;
	}

	/** The peer's own enrollment result, by its request identity. */
	private async status(call: { request?: Record<string, Json>; args?: Record<string, Json> }, conn: Connection): Promise<Reply> {
		const r = call.args?.targetRequest as Record<string, Json> | undefined;
		if (!r || typeof r.generation !== "string" || typeof r.requestId !== "string") throw new EnrollError("enrollment refused");
		const now = (this.o.now ?? Date.now)();
		const info = (await listSpaces(this.o.host, this.o.ctx)).find((i) => i.alias === CONTROL_SPACE);
		const s = info ? await snapshotSpace(this.o.host, info.spaceId, this.o.ctx) : undefined;
		if (!s) return { ok: true, result: { state: "unknown" } };
		try {
			const v = claims.lookup(s, { principal: { peerId: conn.peerId! }, generation: r.generation, requestId: r.requestId }, now);
			return { ok: true, result: { state: v.state, ...(v.state === "done" ? { result: (v.result ?? {}) as Json } : {}) } };
		} catch { return { ok: true, result: { state: "unknown" } }; }
	}
}

function validKey(algorithm: Algorithm, publicKey: string): boolean {
	try {
		const raw = Buffer.from(publicKey, "base64");
		if (raw.length === 0 || raw.toString("base64") !== publicKey) return false;
		if (algorithm === "ed25519") return raw.length === 32;
		return raw.length > 60 && raw.length < 200;
	} catch { return false; }
}
