// RPC claims and request generations (federation-plan-v3.md 6.2, AP 1.5). Pure functions over the space state,
// used inside the commit that performs the operation, so effect, claim and result are one atomic write.
//
// A request is identified by (principal, spaceId, generation, requestId). Only its domain arguments (method,
// template/entry, lease, timeout, txn, target request) are hashed; the renewable frame (authority, epoch, grants,
// transport) is not part of the hash, so a retry with a renewed frame hits the same claim. Arguments are stored as a
// hash only; the result is stored in full until its retention ends, then only the hash remains.
import { createHash, randomBytes } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import { LimitError, claimBytes, limitsOf, type Json, type SpaceState } from "./core.ts";

const encoder = new TextEncoder();
const bytesOf = (v: unknown): number => encoder.encode(JSON.stringify(v) ?? "").length;

export type Principal = { peerId: string; agentId?: string };
/** Who asks, in which generation, under which id. `requestId` is chosen by the caller and kept across retries. */
export type RequestRef = { principal: Principal; generation: string; requestId: string };
export type ClaimState = "pending" | "done" | "cancelled";
export type ClaimRec = {
	method: string;
	argHash: string;
	deadline: number; // fixed once, at the first accepted call
	state: ClaimState;
	result?: Json; // present while retained (done) or null (cancelled)
	resultExpired?: true; // the outcome was decided, its content is gone
	decidedAt?: number;
	generation: string;
	requestId: string;
	principal: Principal;
};
export type GenerationRec = { principal: Principal; incarnation: string | null; issuedAt: number; admitUntil: number };
export type RpcState = { generations: Record<string, GenerationRec>; claims: Record<string, ClaimRec>; bytes?: number }; // bytes: running tally of claims and generations (AP 0.2)
export type ClaimView = { state: ClaimState; deadline: number; result?: Json; resultExpired?: true; method: string };

/** Same request id, different method or arguments. */
export class RequestConflict extends Error {}
/** Unknown request id in a generation that no longer admits new ids (or a generation this space does not know). */
export class RequestExpired extends Error {}
/** The request was decided, but its stored result has passed its retention. Nothing is executed again. */
export class ResultExpired extends Error {}
/** The generation belongs to an earlier incarnation of this space (a restore happened). */
export class IncarnationChanged extends Error {}
/** The request was cancelled before it was decided. */
export class OperationCancelled extends Error {}

const rpc = (s: SpaceState): RpcState => {
	const x = s as SpaceState & { rpc?: RpcState };
	if (!x.rpc) x.rpc = { generations: {}, claims: {}, bytes: 0 };
	else if (x.rpc.bytes === undefined) x.rpc.bytes = bytesOf(x.rpc.claims) + bytesOf(x.rpc.generations); // state from before the tally
	return x.rpc;
};
const samePrincipal = (a: Principal, b: Principal) => canonicalJson(a) === canonicalJson(b);
const checkPrincipal = (p: Principal) => {
	if (!p || typeof p.peerId !== "string" || p.peerId === "" || (p.agentId !== undefined && typeof p.agentId !== "string")) throw new TypeError("principal needs a peerId");
};

/** Canonical hash of a request's domain arguments. */
export const argHash = (method: string, args: Json): string => createHash("sha256").update(canonicalJson({ method, args })).digest("hex");
const keyOf = (s: SpaceState, r: RequestRef): string => canonicalJson([r.principal as unknown as Json, s.spaceId ?? null, r.generation, r.requestId]);

/** A new generation for `principal`: it admits new request ids until `admitUntil`. */
export function issueGeneration(s: SpaceState, now: number, principal: Principal): { generation: string; admitUntil: number } {
	checkPrincipal(principal);
	const generation = `g${randomBytes(8).toString("hex")}`;
	const admitUntil = now + limitsOf(s).generationAdmitMs;
	const rec: GenerationRec = { principal: { ...principal }, incarnation: s.incarnation ?? null, issuedAt: now, admitUntil };
	const st = rpc(s);
	st.generations[generation] = rec;
	st.bytes! += bytesOf(rec) + bytesOf(generation) + 2;
	return { generation, admitUntil };
}

export type Admission =
	| { kind: "fresh" | "pending"; key: string; deadline: number }
	| { kind: "done"; key: string; result: Json }
	| { kind: "cancelled"; key: string };

/**
 * Admit a mutating request inside its commit. A known claim is answered from storage (or continued while pending)
 * even after its generation stopped admitting new ids; an unknown id is only accepted while its generation admits.
 * `deadline` is used for a fresh claim only; a known claim keeps the one it was given first.
 */
export function admit(s: SpaceState, now: number, r: RequestRef, method: string, args: Json, deadline: number): Admission {
	checkPrincipal(r.principal);
	if (typeof r.requestId !== "string" || r.requestId === "" || typeof r.generation !== "string") throw new TypeError("request needs a generation and a requestId");
	sweep(s, now);
	const st = rpc(s);
	const key = keyOf(s, r);
	const hash = argHash(method, args);
	const c = st.claims[key];
	if (c) {
		if (c.method !== method || c.argHash !== hash) throw new RequestConflict(`request ${r.requestId} was used for different arguments`);
		if (c.state === "pending") return { kind: "pending", key, deadline: c.deadline };
		if (c.resultExpired) throw new ResultExpired(`request ${r.requestId} was decided; its result is no longer kept`);
		return c.state === "cancelled" ? { kind: "cancelled", key } : { kind: "done", key, result: c.result ?? null };
	}
	const g = st.generations[r.generation];
	if (!g) throw new RequestExpired(`generation ${r.generation} is unknown or expired`);
	if (g.incarnation !== (s.incarnation ?? null)) throw new IncarnationChanged(`generation ${r.generation} belongs to an earlier incarnation of this space`);
	if (!samePrincipal(g.principal, r.principal)) throw new RequestExpired(`generation ${r.generation} was issued to another principal`);
	if (now > g.admitUntil) throw new RequestExpired(`generation ${r.generation} no longer admits new requests`);
	const lim = limitsOf(s);
	if (claimBytes(s) >= lim.maxClaimBytes) throw new LimitError(`request claims use ${claimBytes(s)} bytes; the limit is ${lim.maxClaimBytes}`);
	const rec: ClaimRec = { method, argHash: hash, deadline, state: "pending", generation: r.generation, requestId: r.requestId, principal: { ...r.principal } };
	st.claims[key] = rec;
	st.bytes! += bytesOf(rec) + bytesOf(key) + 2;
	return { kind: "fresh", key, deadline };
}

/** Record the outcome in the commit that decides it. */
export function decide(s: SpaceState, now: number, key: string, outcome: { state: "done"; result: Json } | { state: "cancelled" }): void {
	const c = rpc(s).claims[key];
	if (!c) throw new Error(`no claim ${key}`);
	if (c.state !== "pending") return;
	const st = rpc(s);
	const before = bytesOf(c);
	c.state = outcome.state;
	c.result = outcome.state === "done" ? outcome.result : null;
	c.decidedAt = now;
	st.bytes! += bytesOf(c) - before;
}

/**
 * Current state of a known request (poll). Unknown ids: RequestExpired, never a new operation. Works on a snapshot:
 * retention is judged by `now`, whether or not a commit has swept the claim yet.
 */
export function lookup(s: Readonly<SpaceState>, r: RequestRef, now: number): ClaimView {
	const c = (s as SpaceState & { rpc?: RpcState }).rpc?.claims[keyOf(s as SpaceState, r)];
	if (!c) throw new RequestExpired(`request ${r.requestId} is unknown`);
	const expired = c.resultExpired || (c.state !== "pending" && c.decidedAt !== undefined && c.decidedAt + limitsOf(s).claimResultMs <= now);
	return { state: c.state, deadline: c.deadline, method: c.method, ...(expired ? { resultExpired: true as const } : c.state === "pending" ? {} : { result: c.result ?? null }) };
}

/** Cancel a pending request. A decided one stays as it is; the returned view says which. */
export function cancelRequest(s: SpaceState, now: number, target: RequestRef): ClaimView {
	sweep(s, now);
	const key = keyOf(s, target);
	const c = rpc(s).claims[key];
	if (!c) throw new RequestExpired(`request ${target.requestId} is unknown`);
	if (c.state === "pending") decide(s, now, key, { state: "cancelled" });
	return lookup(s, target, now);
}

/**
 * Retention: a decided result is kept `claimResultMs` from its decision, then dropped (ResultExpired). The hash stays at
 * least until both that retention and its generation's admission are over; then claim and, once unused, generation go
 * (unknown ids of a gone generation are RequestExpired). Pending claims are never dropped.
 */
export function sweep(s: SpaceState, now: number): void {
	const st = (s as SpaceState & { rpc?: RpcState }).rpc;
	if (!st) return;
	const keep = limitsOf(s).claimResultMs;
	const used = new Set<string>();
	for (const [k, c] of Object.entries(st.claims)) {
		if (c.state !== "pending" && c.decidedAt !== undefined && c.decidedAt + keep <= now) {
			if (!c.resultExpired) { const before = bytesOf(c); delete c.result; c.resultExpired = true; st.bytes = (st.bytes ?? 0) + bytesOf(c) - before; }
			const g = st.generations[c.generation];
			if (!g || g.admitUntil < now) { st.bytes = (st.bytes ?? 0) - bytesOf(c) - bytesOf(k) - 2; delete st.claims[k]; continue; }
		}
		used.add(c.generation);
	}
	for (const [id, g] of Object.entries(st.generations)) if (g.admitUntil < now && !used.has(id)) { st.bytes = (st.bytes ?? 0) - bytesOf(g) - bytesOf(id) - 2; delete st.generations[id]; }
}
