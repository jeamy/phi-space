// RPC claims and request generations (federation-plan-v3.md 6.2, AP 1.5). Pure functions over the space state,
// used inside the commit that performs the operation, so effect, claim and result are one atomic write.
//
// A request is identified by (principal, spaceId, generation, requestId). Only its domain arguments (method,
// template/entry, lease, timeout, txn, target request) are hashed; the renewable frame (authority, epoch, grants,
// transport) is not part of the hash, so a retry with a renewed frame hits the same claim. Arguments are stored as a
// hash only; the result is stored in full until its retention ends, then only the hash remains.
import { createHmac, randomBytes } from "node:crypto";
import { canonicalJson, digestJson } from "./canonical.ts";
import { LimitError, assertAdminIdle, maintenanceStep, claimBytes, limitsOf, touch, type Json, type SpaceState } from "./core.ts";
import { jsonBytes } from "./json.ts";

const bytesOf = jsonBytes;

export type Principal = { peerId: string; agentId?: string };
/** Who asks, in which generation, under which id. `requestId` is chosen by the caller and kept across retries. */
export type RequestRef = { principal: Principal; generation: string; requestId: string };
export type ClaimState = "pending" | "done" | "cancelled";
export type ClaimRec = {
	policyVersion?: number;
	routerEpoch?: number;
	controlPrimaryEpoch?: number;
	transportPeerId?: string;
	orphanedAfterRestore?: { recoveryId: string; authorityId: string };
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
	reservedResultBytes?: number;
	error?: { code: "TransactionError" | "PermissionDenied" | "CompletionViolation" | "NotCommitted"; message: string };
	/** Negative claim (v3 6.2): decided after a promotion, the request never took effect and never will. */
	notCommitted?: { proofHash: string; requestEpoch: number; primaryEpoch: number };
};
export type GenerationRec = { primaryEpoch?: number; principal: Principal; incarnation: string | null; issuedAt: number; admitUntil: number; spaceId?: string | null; authorityId?: string };
export type RpcState = { generations: Record<string, GenerationRec>; claims: Record<string, ClaimRec>; bytes?: number; reservedBytes?: number; signingKey?: string; authorityId?: string; sweepCursor?: string;
	/** The earliest time a sweep can find a claim or generation to drop: before it, sweeping looks at nothing. Every
	 *  change that can make something due earlier lowers it; absent, the next sweep scans everything. */
	sweepAt?: number };
export type ClaimView = { state: ClaimState; deadline: number; result?: Json; resultExpired?: true; method: string; error?: ClaimRec["error"]; restoredHistory?: true; unknownOutcome?: true; orphanedAfterRestore?: ClaimRec["orphanedAfterRestore"] };

/**
 * The request was never committed and never will be (v3 6.2): decided by the primary after a promotion, with a
 * durable negative claim. Only now may the client start a new request.
 */
export class NotCommitted extends Error {}
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
export const argHash = (method: string, args: Json): string => digestJson({ method, args });
export const keyOf = (s: Readonly<SpaceState>, r: RequestRef): string => canonicalJson([r.principal as unknown as Json, s.spaceId ?? null, r.generation, r.requestId]);

/** A new generation for `principal`: it admits new request ids until `admitUntil`. */
export function issueGeneration(s: SpaceState, now: number, principal: Principal, options: { key?: string; authorityId?: string; primaryEpoch?: number } = {}): { generation: string; admitUntil: number } {
	assertAdminIdle(s);
	checkPrincipal(principal);
	sweep(s, now);
	const st = rpc(s);
	st.signingKey ??= options.key ?? randomBytes(32).toString("hex");
	st.authorityId = options.authorityId ?? st.authorityId ?? "local";
	const nonce = `g${randomBytes(16).toString("hex")}`;
	const admitUntil = now + limitsOf(s).generationAdmitMs;
	const rec: GenerationRec = { primaryEpoch: options.primaryEpoch ?? s.primaryEpoch ?? 1, principal: { ...principal }, incarnation: s.incarnation ?? null, issuedAt: now, admitUntil, spaceId: s.spaceId ?? null, authorityId: st.authorityId };
	const generation = `${nonce}.${createHmac("sha256", st.signingKey).update(canonicalJson({ nonce, ...rec } as unknown as Json)).digest("hex")}`;
	const added = bytesOf(rec) + bytesOf(generation) + 2;
	if (claimBytes(s) + added > limitsOf(s).maxClaimBytes) throw new LimitError("the generation exceeds maxClaimBytes");
	st.generations[generation] = rec;
	dueAt(st, admitUntil + 1);
	touch(s, now);
	st.bytes! += added;
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
export function admit(s: SpaceState, now: number, r: RequestRef, method: string, args: Json, deadline: number, resultBytes = 1024): Admission {
	assertAdminIdle(s);
	checkPrincipal(r.principal);
	if (typeof r.requestId !== "string" || r.requestId === "" || typeof r.generation !== "string") throw new TypeError("request needs a generation and a requestId");
	sweep(s, now);
	const st = rpc(s);
	const key = keyOf(s, r);
	const hash = argHash(method, args);
	const c = st.claims[key];
	if (s.restoredClaims?.[key]) throw new IncarnationChanged("request belongs to historical restored data; replay is forbidden");
	if (c) {
		if (c.method !== method || c.argHash !== hash) throw new RequestConflict(`request ${r.requestId} was used for different arguments`);
		if (c.notCommitted) throw new NotCommitted(`request ${r.requestId} was not committed (decided after promotion to epoch ${c.notCommitted.primaryEpoch})`);
		if (c.state === "pending") return { kind: "pending", key, deadline: c.deadline };
		if (c.resultExpired || (c.decidedAt !== undefined && c.decidedAt + limitsOf(s).claimResultMs <= now)) throw new ResultExpired(`request ${r.requestId} was decided; its result is no longer kept`);
		return c.state === "cancelled" ? { kind: "cancelled", key } : { kind: "done", key, result: c.result ?? null };
	}
	validateGeneration(s, now, r);
	const lim = limitsOf(s);
	const rec: ClaimRec = { method, argHash: hash, deadline, state: "pending", generation: r.generation, requestId: r.requestId, principal: { ...r.principal }, reservedResultBytes: resultBytes };
	const added = bytesOf(rec) + bytesOf(key) + 2;
	if (claimBytes(s) + added + resultBytes > lim.maxClaimBytes) throw new LimitError("the request and its reserved result exceed maxClaimBytes");
	st.claims[key] = rec;
	touch(s, now);
	st.bytes! += added;
	st.reservedBytes = (st.reservedBytes ?? 0) + resultBytes;
	return { kind: "fresh", key, deadline };
}

/** Record the outcome in the commit that decides it. */
export function decide(s: SpaceState, now: number, key: string, outcome: { state: "done"; result: Json; error?: ClaimRec["error"] } | { state: "cancelled" }): void {
	const c = rpc(s).claims[key];
	if (!c) throw new Error(`no claim ${key}`);
	if (c.state !== "pending") return;
	const st = rpc(s);
	const before = bytesOf(c);
	const resultBytes = bytesOf(outcome.state === "done" ? outcome.result : null);
	if (c.reservedResultBytes !== undefined && resultBytes > c.reservedResultBytes) throw new LimitError("the result exceeds its admission reservation");
	st.reservedBytes = Math.max(0, (st.reservedBytes ?? 0) - (c.reservedResultBytes ?? 0));
	delete c.reservedResultBytes;
	c.state = outcome.state;
	c.result = outcome.state === "done" ? outcome.result : null;
	c.decidedAt = now;
	dueAt(st, now + limitsOf(s).claimResultMs);
	if (outcome.state === "done" && outcome.error) c.error = outcome.error;
	st.bytes! += bytesOf(c) - before;
	touch(s, now);
}

/**
 * Current state of a known request (poll). Unknown ids: RequestExpired, never a new operation. Works on a snapshot:
 * retention is judged by `now`, whether or not a commit has swept the claim yet.
 */
export function lookup(s: Readonly<SpaceState>, r: RequestRef, now: number): ClaimView {
	const key = keyOf(s, r);
	const historical = s.restoredClaims?.[key];
	const c = (s as SpaceState & { rpc?: RpcState }).rpc?.claims[key] ?? historical;
	if (!c) throw new RequestExpired(`request ${r.requestId} is unknown`);
	const expired = c.resultExpired || (c.state !== "pending" && c.decidedAt !== undefined && c.decidedAt + limitsOf(s).claimResultMs <= now);
	return { state: c.state, deadline: c.deadline, method: c.method, ...(c.orphanedAfterRestore ? { orphanedAfterRestore: c.orphanedAfterRestore } : {}), ...(historical ? { restoredHistory: true as const, ...(c.state === "pending" ? { unknownOutcome: true as const } : {}) } : {}), ...(c.error ? { error: c.error } : {}), ...(expired ? { resultExpired: true as const } : c.state === "pending" ? {} : { result: c.result ?? null }) };
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
export function sweep(s: SpaceState, now: number, maxRecords = 256): void {
	const st = (s as SpaceState & { rpc?: RpcState }).rpc;
	if (!st) return;
	// nothing can be due yet: every operation settles the space, so a full scan here would cost O(claims) each time
	if (st.sweepAt !== undefined && now < st.sweepAt) return;
	const keep = limitsOf(s).claimResultMs;
	// Select only expired records. Advancing a scan cursor over live claims would write on every watch tick.
	// Filter first: only the (usually few) expired keys need the deterministic order. The same pass finds when the
	// next claim that stays becomes due (its result expires, or its generation stops admitting).
	let next = Number.MAX_SAFE_INTEGER;
	const eligible = Object.keys(st.claims).filter(k => {
		const c = st.claims[k]!, g = st.generations[c.generation];
		if (c.state === "pending" || c.decidedAt === undefined) return false;
		const due = c.resultExpired ? (g ? g.admitUntil + 1 : now) : c.decidedAt + keep;
		if (due > now) { next = Math.min(next, due); return false; }
		return c.decidedAt + keep <= now && (!c.resultExpired || !g || g.admitUntil < now);
	}).sort();
	let changed = false, complete = eligible.length <= maxRecords;
	for (const k of eligible.slice(0, maxRecords)) {
		if (!maintenanceStep(s, 128, now, `claim:${k}`)) { complete = false; break; }
		const c = st.claims[k]!;
		if (!c.resultExpired) { const before = bytesOf(c); delete c.result; c.resultExpired = true; st.bytes = (st.bytes ?? 0) + bytesOf(c) - before; }
		const g = st.generations[c.generation];
		if (!g || g.admitUntil < now) { st.bytes = (st.bytes ?? 0) - bytesOf(c) - bytesOf(k) - 2; delete st.claims[k]; }
		changed = true;
	}
	delete st.sweepCursor; // a field of earlier versions; no cursor is kept
	const used = new Set(Object.values(st.claims).map(c => c.generation));
	let removed = 0;
	let stopped = false;
	for (const [id, g] of Object.entries(st.generations)) {
		if (g.admitUntil >= now || used.has(id)) { next = Math.min(next, g.admitUntil + 1); continue; }
		if (stopped || removed >= maxRecords || !maintenanceStep(s, 128, now, `generation:${id}`)) { stopped = true; complete = false; continue; }
		st.bytes = (st.bytes ?? 0) - bytesOf(g) - bytesOf(id) - 2; delete st.generations[id]; removed++; changed = true;
	}
	// a claim kept after its result expired stays due with its generation (counted above); a cut-short sweep scans again
	if (complete) st.sweepAt = Math.max(now + 1, next); else delete st.sweepAt;
	if (changed) touch(s, now);
}

/** Something becomes due for sweeping at `at`: the next sweep must not skip it. */
const dueAt = (st: RpcState, at: number) => { if (st.sweepAt !== undefined && at < st.sweepAt) st.sweepAt = at; };

/** Bounded authenticated metadata is counted in the same admission/decision commit. */
export function setMetadata(s:SpaceState,key:string,meta:{policyVersion?:number;transportPeerId?:string;routerEpoch?:number;controlPrimaryEpoch?:number}):void {
 const st=rpc(s),c=st.claims[key];if(!c)throw new RequestExpired("metadata requires known claim");const before=bytesOf(c);
 for(const [k,v] of Object.entries(meta))if(v!==undefined)(c as any)[k]=v;
 const delta=bytesOf(c)-before;if(claimBytes(s)+delta>limitsOf(s).maxClaimBytes)throw new LimitError("authenticated claim metadata exceeds budget");st.bytes!+=delta;
}

/** Validates an extant admission generation without admitting or changing a request. */
export function validateGeneration(s: Readonly<SpaceState>, now: number, r: RequestRef): GenerationRec {
 checkPrincipal(r.principal);
 const st=s.rpc;
 if(!st)throw new RequestExpired('generation is unknown');
	if (s.invalidGenerations?.[r.generation]) throw new IncarnationChanged("generation belongs to restored data");
	const g = st.generations[r.generation];
	if (!g) throw new RequestExpired(`generation ${r.generation} is unknown or expired`);
	if (g.incarnation !== (s.incarnation ?? null)) throw new IncarnationChanged(`generation ${r.generation} belongs to an earlier incarnation of this space`);
	if (g.spaceId !== (s.spaceId ?? null) || g.authorityId !== st.authorityId || !st.signingKey || r.generation !== `${r.generation.split(".")[0]}.${createHmac("sha256", st.signingKey).update(canonicalJson({ nonce: r.generation.split(".")[0], ...g } as unknown as Json)).digest("hex")}`) throw new RequestExpired("the generation signature or binding is invalid");
	if (!samePrincipal(g.principal, r.principal)) throw new RequestExpired(`generation ${r.generation} was issued to another principal`);
	if (now > g.admitUntil) throw new RequestExpired(`generation ${r.generation} no longer admits new requests`);
 return g;
}
export type AdmissionResolution = ClaimView | {state:'notAdmitted';spaceId:string|null;authorityId:string;incarnation:string|null;primaryEpoch:number;generation:string;requestId:string;method:string;argumentHash:string};
/** A current-epoch miss permits only retrying the identical request, never a new ID or NotCommitted. */
export function resolveAdmission(s: Readonly<SpaceState>, now:number, r:RequestRef, method:string, argumentHash:string, primaryEpoch:number):AdmissionResolution {
 assertAdminIdle(s as SpaceState);
 if(!r.requestId||!method||!/^[a-f0-9]{64}$/.test(argumentHash)||!Number.isSafeInteger(primaryEpoch)||primaryEpoch<0)throw new TypeError('invalid admission resolution binding');
 const key=keyOf(s,r),known=s.rpc?.claims[key]??s.restoredClaims?.[key];
 if(known){if(known.method!==method||known.argHash!==argumentHash)throw new RequestConflict('resolution changed original method/arguments');return lookup(s,r,now);}
 const generation=validateGeneration(s,now,r);
 if(generation.primaryEpoch!==primaryEpoch || s.primaryEpoch!==undefined&&s.primaryEpoch!==primaryEpoch)throw new IncarnationChanged('missing request cannot be resolved across epochs or legacy generations');
 if(s.restore || s.authorityTransition || s.membership?.state==='recoveryBlocked')throw new IncarnationChanged('missing request requires uninterrupted current history');
 return {state:'notAdmitted',spaceId:s.spaceId??null,authorityId:s.rpc!.authorityId!,incarnation:s.incarnation??null,primaryEpoch,generation:r.generation,requestId:r.requestId,method,argumentHash};
}

/**
 * v3 6.2, unknown ID after promotion: persists a terminal negative claim for the original key, method and argument
 * hash, in the same commit domain as admission (a late original call meets it and has no effect). Only for a request of
 * an older epoch in a retained, still admitting generation of this incarnation and authority, with uninterrupted
 * history; `proofHash` binds the promotion evidence the caller checked (every earlier writer fenced). A known claim is
 * answered as it is.
 */
export function decideNotCommitted(s: SpaceState, now: number, r: RequestRef, method: string, argumentHash: string, requestEpoch: number, primaryEpoch: number, proofHash: string): ClaimView {
	assertAdminIdle(s);
	if (!r.requestId || !method || !/^[a-f0-9]{64}$/.test(argumentHash) || !/^[a-f0-9]{64}$/.test(proofHash) || !Number.isSafeInteger(requestEpoch) || !Number.isSafeInteger(primaryEpoch) || requestEpoch < 1) throw new TypeError("invalid negative claim binding");
	sweep(s, now);
	const st = rpc(s), key = keyOf(s, r), known = st.claims[key] ?? s.restoredClaims?.[key];
	if (known) { if (known.method !== method || known.argHash !== argumentHash) throw new RequestConflict("resolution changed original method/arguments"); return lookup(s, r, now); }
	const g = validateGeneration(s, now, r);
	if (requestEpoch >= primaryEpoch || (g.primaryEpoch ?? 1) > requestEpoch) throw new IncarnationChanged("NotCommitted needs a request of an earlier primary epoch than this one");
	if (s.restore || s.authorityTransition || s.membership?.state === "recoveryBlocked") throw new IncarnationChanged("missing request requires uninterrupted current history");
	const rec: ClaimRec = { method, argHash: argumentHash, deadline: now, state: "done", result: null, decidedAt: now, generation: r.generation, requestId: r.requestId, principal: { ...r.principal },
		error: { code: "NotCommitted", message: `request ${r.requestId} was not committed before the promotion to epoch ${primaryEpoch}` }, notCommitted: { proofHash, requestEpoch, primaryEpoch } };
	const added = bytesOf(rec) + bytesOf(key) + 2;
	if (claimBytes(s) + added > limitsOf(s).maxClaimBytes) throw new LimitError("the negative claim exceeds maxClaimBytes");
	st.claims[key] = rec; dueAt(st, now + limitsOf(s).claimResultMs); touch(s, now); st.bytes! += added;
	return lookup(s, r, now);
}
