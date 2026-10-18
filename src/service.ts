import {RoutingConflict,MemberDrained,MigrationRequired} from "./routing-semantics.ts";
// The `space` service (federation-plan-v3.md 6.2, AP 1.8): the methods of a space as one transport-independent function
// from an authenticated call to a reply. No network here. A transport (in-process, unix socket, the gate on the overlay)
// authenticates the connection, hands over the identity it established and the decoded call, and writes the reply back.
// The identity never comes from the call itself: a call cannot name its principal.
//
// Placeholders until the federation stages: `authorityId` and `primaryEpoch` are checked against the configured values
// (a single host is its own authority, epoch 0). Overlay authentication and grants belong to phase 1b.
import { awaitWithContext } from "@earendil-works/chord/context";
import { ReplicationConflict } from "./entry-replication.ts";
import { ReplicationClockError } from "./replication-clock.ts";
import { CommitSealed, SyncBudgetExceeded } from "./commit-sealed.ts";
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import type { Context } from "@earendil-works/chord";
import * as core from "./core.ts";
import * as claims from "./claims.ts";
import {rpcDomain} from "./rpc-domain.ts";
import { PiSpaces, type SpaceHost } from "./client.ts";
import { listSpaces, snapshotSpace, spaceDoc, UnknownSpaceError, DEFAULT_ALIAS, Registry } from "./spaces.ts";
import type { Principal, RequestRef } from "./claims.ts";
import type { Json } from "./core.ts";
import { encodedBytes } from "./paging.ts";
import { principalId, MailboxEpochMismatch, InvalidAck } from "./mailbox.ts";

export const PROTOCOL_VERSION = 1;
export const METHODS = ["hello", "generation", "write", "read", "take", "pollOperation", "resolveOperation", "cancelOperation", "readAll", "count", "stats", "txn", "lease", "changes", "wait", "notify", "events", "ack"] as const;
export type Method = (typeof METHODS)[number];
const MUTATING: readonly Method[] = ["write", "read", "take", "cancelOperation", "txn", "lease", "wait", "notify", "ack"];

// ---- identity and rights

/** What a transport knows about a connection: it fills this in, the identity adapter decides what it means. */
export type Connection = { peerId?: string; overlayIp?: string; credentials?: Json; /** Owned by the transport/gate, one object per connection; the proof of layer B keeps its state here (auth.ts). */ state?: Record<string, unknown> };
export type Identity = { principal: Principal; roles: string[] };
export interface IdentityAdapter { authenticate(conn: Connection): Identity | null | Promise<Identity | null> }
/** Test adapter: a fixed table from peer id to identity. */
export class StaticIdentity implements IdentityAdapter {
	table: Record<string, Identity>;
	constructor(table: Record<string, Identity>) { this.table = table; }
	authenticate(conn: Connection): Identity | null { return (conn.peerId !== undefined ? this.table[conn.peerId] : undefined) ?? null; }
}
/** A role allows a set of methods, optionally only for entries of some types (a grant on a supertype covers its subtypes). */
export type RolePolicy = { methods: readonly Method[] | "*"; types?: readonly string[] };
export type Policy = { roles: Record<string, RolePolicy> };
export const DEFAULT_POLICY: Policy = {
	roles: {
		admin: { methods: "*" },
		host: { methods: ["hello","generation","write","read","take","pollOperation", "resolveOperation","cancelOperation","readAll","count","stats","txn","lease","changes","wait","notify","events","ack"] },
		member: { methods: ["hello", "generation", "write", "read", "take", "pollOperation", "resolveOperation", "cancelOperation", "readAll", "count", "stats", "txn", "lease", "changes", "wait", "notify", "events", "ack"] },
		resolution: { methods: ["hello", "pollOperation", "resolveOperation", "cancelOperation", "txn", "lease"] },
		observer: { methods: ["hello", "generation", "read", "pollOperation", "resolveOperation", "cancelOperation", "readAll", "count", "stats", "changes", "notify", "events", "ack"] }, // own read and notify results, never a write
		unpaired: { methods: ["hello", "generation"] }, // a device in the enrollment group: nothing but its own pairing (enroll.ts handles `enroll` and `enrollStatus` before the service)
	},
};

// ---- envelope

export type Call = {
	method: Method;
	/** Stable space id or alias; omitted: the default space. */
	space?: string;
	request?: { generation: string; requestId: string };
	/** The renewable frame; checked on every call, never part of the argument hash. */
	frame?: { authorityId?: string; primaryEpoch?: number; grant?: Json; delegation?: Json; claimReceipt?: boolean };
	args?: Record<string, Json>;
};
export type ErrorCode =
	| "RoutingConflict" | "MemberDrained" | "MigrationRequired" | "BadRequest" | "Unauthenticated" | "PermissionDenied" | "UnknownSpace" | "UnsupportedMethod" | "UnsupportedProtocol"
	| "AuthorityMismatch" | "StaleEpoch" | "RequestConflict" | "RequestExpired" | "ResultExpired" | "IncarnationChanged" | "OperationCancelled"
	| "ResourceExhausted" | "ResponseBudgetTooSmall" | "SnapshotExpired" | "RevisionAhead" | "TransactionError" | "ProofRequired" | "CompletionViolation" | "MergeTypeNotExclusive" | "CommitSealed" | "NotCommitted" | "MailboxEpochMismatch" | "InvalidAck" | "NotFound" | "Internal";
export type ClaimReceipt={protocol:'pi-spaces-claim-receipt-v1';hostId:string;binding:Awaited<ReturnType<PiSpaces['resolveOperationRecord']>>['binding'];resolution:claims.AdmissionResolution};
export type Reply = { ok: true; result: Json; claimReceipt?:ClaimReceipt } | { ok: false; error: { code: ErrorCode; message: string; requiredBytes?: number } };

export type DecisionAuthorization = { principal?: Principal; transportPeerId?: string; renewalWaiterId?: string | null; allowClosedWaiter?:boolean; routerEpoch?: number; controlPrimaryEpoch?: number; policyVersion?: number; knownRequest?: boolean; checkTx?: (tx: import("@earendil-works/pi-durable").Tx) => Promise<void>; validUntil: number; roles: string[]; canExecutePending(method: string, template: core.Template): boolean; check(): void };
/** lww/set types of a Space served by its entry replication controller (docs/ap3-replikation.md, step 1). */
export type MergeAdapter = { controller: import("./entry-replication.ts").EntryReplicationController; rules: readonly import("./entry-replication.ts").EntryReplicationRule[] };
/** v3 7.2: merge types know no exclusive allocation (take, transactions, waits, lease changes). */
export class MergeTypeNotExclusive extends core.IllegalArgumentError {}
export type SpaceServiceOptions = {
	/**
	 * primary/sync: a commit of this Space was sealed but not confirmed (docs/ap3-primary-sync.md). From then on every
	 * call is answered with `CommitSealed` until the host resolved the candidate and serves the Space anew.
	 */
	onSealed?: () => void;
	/** primary/sync: the unresolved sealed candidate of this Space, if any (also one sealed by the reaper). */
	sealedCandidate?: () => { revision: number; hash: string } | null;
	/**
	 * v3 6.2: evidence that every writer of epochs after `requestEpoch` is fenced and this primary holds their complete
	 * history (primary-sync promotionEvidence); null when it cannot be shown. Without it an unknown older request stays
	 * IncarnationChanged (needsReview), never NotCommitted.
	 */
	promotionProof?: (space: string | undefined, requestEpoch: number) => Promise<{ hash: string } | null>;
	authorize?: (call: Call, id: Identity, conn: Connection) => Promise<DecisionAuthorization>;
	host: SpaceHost;
	ctx: Context;
	identity: IdentityAdapter;
	policy?: Policy;
	now?: () => number;
	authorityId?: string;
	primaryEpoch?: number;
	/** Resolve the current persisted epoch for the addressed space. */
	epochForSpace?: (space: string | undefined) => Promise<number>;
	/** Merge types (lww/set) of a Space, served by its entry replication controller instead of the core. */
	merge?: (space: string | undefined) => MergeAdapter | undefined;
	hostId?: string;
	maxPollMs?: number; // longest wait of a poll (spec: 25 s)
	maxPendingPerPrincipal?: number;
	maxPendingPerPeer?: number;
	maxCallsPerWindow?: number;
	rateWindowMs?: number;
};

class Bad extends Error {}
class Denied extends Error {}
const fail = (code: ErrorCode, message: string, extra: { requiredBytes?: number } = {}): Reply => ({ ok: false, error: { code, message, ...extra } });

const isObj = (v: unknown): v is Record<string, Json> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, what: string): string => { if (typeof v !== "string" || v === "") throw new Bad(`${what} must be a non-empty string`); return v; };
const int = (v: unknown, what: string, min = 0): number => { if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw new Bad(`${what} must be an integer >= ${min}`); return v; };
const optInt = (v: unknown, what: string, min = 0): number | undefined => (v === undefined || v === null ? undefined : int(v, what, min));
const template = (v: unknown): core.Template => {
	if (v === undefined || v === null) return null;
	if (!isObj(v)) throw new Bad("template must be an object or null");
	if (v.type !== undefined && v.type !== null && typeof v.type !== "string") throw new Bad("template.type must be a string");
	if (v.fields !== undefined && !isObj(v.fields)) throw new Bad("template.fields must be an object");
	if (v.id !== undefined && v.id !== null && typeof v.id !== "string") throw new Bad("template.id must be a string");
	return v as core.Template;
};
/** Time: a lease or timeout in ms, or the string "forever". */
const duration = (v: unknown, what: string, dflt: number): number => {
	if (v === undefined || v === null) return dflt;
	if (v === "forever") return core.FOREVER;
	return int(v, what, 0);
};

/** The core.Principal key a principal acts under (owner of what it creates). */
export const principalKey = (p: Principal): string => (p.agentId ? `${p.peerId}/${p.agentId}` : p.peerId);

export class SpaceService {
	private o: Required<Pick<SpaceServiceOptions, "maxPollMs" | "maxPendingPerPrincipal" | "maxPendingPerPeer" | "maxCallsPerWindow" | "rateWindowMs" | "authorityId" | "primaryEpoch">> & SpaceServiceOptions;
	private policy: Policy;
	private now: () => number;
	private rates = new Map<string, { at: number; calls: number }>();
	private sealed: { revision: number; hash: string } | null = null;
	private noteSealed(c: { revision: number; hash: string }): Reply { if (!this.sealed) { this.sealed = { revision: c.revision, hash: c.hash }; this.o.onSealed?.(); } return sealedReply(this.sealed); }

	constructor(o: SpaceServiceOptions) {
		this.o = { maxPollMs: 25_000, maxPendingPerPrincipal: 32, maxPendingPerPeer: 128, maxCallsPerWindow: 1024, rateWindowMs: 1000, authorityId: "local", primaryEpoch: 0, ...o };
		this.o.maxPollMs = Math.min(this.o.maxPollMs, 25000);
		for (const value of [this.o.maxPendingPerPrincipal, this.o.maxPendingPerPeer, this.o.maxCallsPerWindow, this.o.rateWindowMs]) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("service limits must be positive integers");
		this.policy = o.policy ?? DEFAULT_POLICY;
		this.now = o.now ?? Date.now;
	}

	/** Decode, check the frame size, dispatch, encode. The size limit is the frame budget of the space (4.2). */
	async handleText(text: string, conn: Connection, maxFrameBytes = core.DEFAULT_LIMITS.maxFrameBytes): Promise<string> {
		if (new TextEncoder().encode(text).length > maxFrameBytes) return JSON.stringify(fail("ResourceExhausted", `a call may take at most ${maxFrameBytes} bytes`));
		let call: unknown;
		try { call = JSON.parse(text); } catch { return JSON.stringify(fail("BadRequest", "the call is not JSON")); }
		const reply = await this.handle(call, conn, maxFrameBytes, Buffer.byteLength(text));
		const textReply = JSON.stringify(reply);
		if (encodedBytes(reply) > maxFrameBytes) return JSON.stringify(fail("ResourceExhausted", "the transport frame cannot carry this response"));
		return textReply;
	}

	async handle(call: unknown, conn: Connection, transportFrameBytes = core.DEFAULT_LIMITS.maxFrameBytes, rawBytes?: number): Promise<Reply> {
		let responseFrame = transportFrameBytes;
		try {
			if (!isObj(call) || typeof call.method !== "string") throw new Bad("a call is an object with a method");
			if (!(METHODS as readonly string[]).includes(call.method)) return fail("UnsupportedMethod", `unknown method ${call.method}`);
			const method = call.method as Method;
			if (call.args !== undefined && !isObj(call.args)) throw new Bad("args must be an object");
			const args = (call.args ?? {}) as Record<string, Json>;
			const authenticated = await this.o.identity.authenticate(conn);
			if (!authenticated) return fail("Unauthenticated", "the connection has no known identity");
			const candidate = this.sealed ?? this.o.sealedCandidate?.() ?? null;
			if (candidate) return this.noteSealed(candidate);
			const id = { ...authenticated, roles: [...authenticated.roles] };
			this.rate(id.principal.peerId);
			const authorization = await this.o.authorize?.(call as unknown as Call, id, conn);
			if (authorization) { id.roles = authorization.roles; if(authorization.principal)id.principal=authorization.principal; }
			const grant = this.allowed(id, method);
			const frame = call.frame;
			if (frame !== undefined) {
				if (!isObj(frame)) throw new Bad("frame must be an object");
				if (frame.authorityId !== undefined && frame.authorityId !== this.o.authorityId) return fail("AuthorityMismatch", `this host is authority ${this.o.authorityId}`);
				const epoch = await this.o.epochForSpace?.(call.space as string | undefined) ?? this.o.primaryEpoch;
				// resolveOperation judges an earlier epoch itself (v3 6.2: NotCommitted only with promotion evidence).
				if (frame.primaryEpoch !== undefined && frame.primaryEpoch !== epoch && !((authorization?.knownRequest || method === "resolveOperation") && typeof frame.primaryEpoch==="number" && Number.isSafeInteger(frame.primaryEpoch) && frame.primaryEpoch<epoch)) return fail("StaleEpoch", `the primary epoch is ${epoch}`);
			}
			let request: RequestRef | undefined;
			if (MUTATING.includes(method) && !(method === "txn" && call.args?.action === "status")) {
				const r = call.request;
				if (!isObj(r)) throw new Bad(`${method} needs a request {generation, requestId}`);
				request = { principal: id.principal, generation: str(r.generation, "request.generation"), requestId: str(r.requestId, "request.requestId") };
			}
			const space = call.space === undefined ? undefined : str(call.space, "space");
			const client = new PiSpaces(this.o.host, this.o.ctx, this.now, undefined, principalId(id.principal), { space: space === DEFAULT_ALIAS ? undefined : space, authorityId: this.o.authorityId, maxPending: this.o.maxPendingPerPrincipal, maxPendingPeer: this.o.maxPendingPerPeer, consumer: id.principal, authorization });
			const frameBytes = Math.min(transportFrameBytes, (await client.configuration()).limits.maxFrameBytes);
			responseFrame = frameBytes;
			if ((rawBytes ?? encodedBytes(call)) > frameBytes) throw new core.ResourceExhausted("the request exceeds the space frame limit");
			const includeClaim=isObj(frame)&&frame.claimReceipt===true;
            if(isObj(frame)&&frame.claimReceipt!==undefined&&typeof frame.claimReceipt!=='boolean')throw new Bad('claimReceipt must be boolean');
            if(includeClaim){if(!request)throw new Bad('claim receipt requires an original effect request');this.allowed(id,'resolveOperation');}
            const result = await this.dispatch(method, args, { id, request, client, space, grant, frameBytes });
            const reply: Reply = { ok: true, result };
            if(includeClaim&&request){
                // This is the full retained-claim check, not an acknowledgement inferred from result.
                // Unavailable witnesses use the legacy separate resolution path at the Router.
                try{
                    const domain=rpcDomain(call as unknown as Call,id.principal),epoch=await this.o.epochForSpace?.(space)??this.o.primaryEpoch;
                    const record=await client.resolveOperationRecord(request,domain.method,claims.argHash(domain.method,domain.args),epoch);
                    const resolutionGrant=this.allowed(id,'resolveOperation');
                    if('result' in record.resolution&&isObj(record.resolution.result)&&Array.isArray(record.resolution.result.types))this.checkTypes(resolutionGrant,record.resolution.result.types as string[],'this retained result');
                    const hostId=this.o.hostId??(await this.o.host.snapshot(Registry,this.o.ctx))?.hostId;
                    if(hostId)reply.claimReceipt={protocol:'pi-spaces-claim-receipt-v1',hostId,...record};
                }catch{/* Effect may already be committed. Leave the witness absent; never fabricate completion. */}
            }
			if (encodedBytes(reply) > frameBytes) throw new core.ResourceExhausted("the configured frame cannot carry the result; use a compatible transport frame");
			return reply;
		} catch (e) {
			if (e instanceof core.ResponseBudgetTooSmall && e.requiredBytes > responseFrame - 21) return fail("ResourceExhausted", "the configured frame cannot hold the next whole element");
			return this.error(e);
		}
	}
	private rate(peer: string): void {
		const now = this.now();
		for (const [key, value] of this.rates) if (value.at + this.o.rateWindowMs <= now) this.rates.delete(key);
		let r = this.rates.get(peer);
		if (!r) { if (this.rates.size >= 10000) throw new core.ResourceExhausted("the rate table is full"); r = { at: now, calls: 0 }; this.rates.set(peer, r); }
		if (++r.calls > this.o.maxCallsPerWindow) throw new core.ResourceExhausted("the peer exceeded its call rate");
	}

	// ---- rights

	/** The union of what the principal's roles allow for this method; throws Denied when none does. */
	private allowed(id: Identity, method: Method): { types: ReadonlySet<string> | "*" } {
		let types: Set<string> | "*" = new Set();
		let any = false;
		for (const name of id.roles) {
			const r = this.policy.roles[name];
			if (!r || !(r.methods === "*" || r.methods.includes(method))) continue;
			any = true;
			if (r.types === undefined) types = "*"; else if (types !== "*") for (const t of r.types) types.add(t);
		}
		if (!any) throw new Denied(`${method} is not allowed for your roles`);
		return { types };
	}
	private checkTypes(grant: { types: ReadonlySet<string> | "*" }, types: readonly string[] | undefined, what: string): void {
		if (grant.types === "*") return;
		if (!types || types.length === 0 || !types.some((t) => (grant.types as ReadonlySet<string>).has(t))) throw new Denied(`${what} is outside the types your roles allow`);
	}

	// ---- methods

	private async dispatch(method: Method, a: Record<string, Json>, c: { id: Identity; request?: RequestRef; client: PiSpaces; space?: string; grant: { types: ReadonlySet<string> | "*" }; frameBytes: number }): Promise<Json> {
		const { client, request, grant } = c;
		const merged = await this.mergeCall(method, a, c);
		if (merged !== undefined) return merged;
		switch (method) {
			case "hello": return this.hello(a, c);
			case "generation": {
				const g = await client.issueGeneration(c.id.principal,{primaryEpoch:await this.o.epochForSpace?.(c.space)??this.o.primaryEpoch});
				return { generation: g.generation, admitUntil: g.admitUntil };
			}
			case "write": {
				if (!isObj(a.entry)) throw new Bad("entry is required");
				const type = str(a.entry.type, "entry.type");
				const types = a.entry.types === undefined ? undefined : (Array.isArray(a.entry.types) && a.entry.types.every((t) => typeof t === "string") ? (a.entry.types as string[]) : (() => { throw new Bad("entry.types must be strings"); })());
				if (!isObj(a.entry.fields)) throw new Bad("entry.fields must be an object");
				this.checkTypes(grant, [type, ...(types ?? [])], `type ${type}`);
				const lease = await client.write({ type, ...(types ? { types } : {}), fields: a.entry.fields }, (a.txn as string | null | undefined) ?? null, duration(a.leaseMs, "leaseMs", core.ANY), { request });
				return lease as unknown as Json;
			}
			case "read":
			case "take": return this.readTake(method, a, c);
			case "pollOperation": return this.poll(a, c);
   case "resolveOperation": {
    const target=this.target(a.targetRequest,c.id),method=str(a.method,'method'),hash=str(a.argumentHash,'argumentHash'),epoch=int(a.primaryEpoch,'primaryEpoch');
    const current=await this.o.epochForSpace?.(c.space)??this.o.primaryEpoch;
    if(epoch>current)throw new claims.IncarnationChanged('resolution epoch is ahead of Member');
    let view:claims.AdmissionResolution|undefined,miss:unknown;
    try{view=await client.resolveOperation(target,method,hash,epoch);}catch(e){if(!(e instanceof claims.IncarnationChanged))throw e;miss=e;}
    if(view?.state==='notAdmitted'&&epoch!==current)miss=new claims.IncarnationChanged('missing request requires current Member epoch');
    if(miss){
     // An unknown request of an earlier epoch: NotCommitted with a durable negative claim, only with promotion evidence.
     if(epoch>=current||!this.o.promotionProof)throw miss;
     const proof=await this.o.promotionProof(c.space,epoch);if(!proof)throw miss;
     view=await client.resolveNotCommitted(target,method,hash,epoch,current,proof.hash);
    }
    if(!view)throw miss;
    if('result' in view&&view.result&&isObj(view.result)&&Array.isArray(view.result.types))this.checkTypes(grant,view.result.types as string[],'this retained result');
    return view as unknown as Json;
   }
			case "cancelOperation": {
				const t = this.target(a.targetRequest, c.id);
				return (await client.cancelOperation(t, { request })) as unknown as Json;
			}
			case "readAll": {
				const t = template(a.template);
				if (grant.types !== "*") this.checkTypes(grant, t?.type ? [t.type] : undefined, "this template");
				const p = await client.readPage(t, { maxBytes: Math.min(a.maxBytes === undefined ? c.frameBytes : int(a.maxBytes, "maxBytes", 1), c.frameBytes - 21), ...(a.token === undefined ? {} : { token: str(a.token, "token") }), after: (a.cursor as string | null | undefined) ?? null, txn: (a.txn as string | null | undefined) ?? null });
				return p as unknown as Json;
			}
			case "count": {
				const t = template(a.template);
				if (grant.types !== "*") this.checkTypes(grant, t?.type ? [t.type] : undefined, "this template");
				return await client.countWithRevision(t, (a.txn as string | null | undefined) ?? null);
			}
			case "stats": {
				if (grant.types !== "*") throw new Denied("aggregate stats need a role without type restrictions");
				return await client.statsWithRevision() as unknown as Json;
			}
			case "txn": {
				const action = str(a.action, "action");
				if (action === "begin") return (await client.createTransaction(duration(a.leaseMs, "leaseMs", core.ANY), { request })) as unknown as Json;
				const id = str(a.id, "id");
				if(action==="status")return await client.transactionState(id) as unknown as Json;
				if (action === "commit") { await client.commit(id, { request }); return { state: "committed" }; }
				if (action === "abort") { await client.abort(id, { request }); return { state: "aborted" }; }
				throw new Bad("action must be begin, commit or abort");
			}
			case "lease": {
				const action = str(a.action, "action");
				const id = str(a.id, "id");
				if (action === "renew") return { expires: await client.renew(id, duration(a.ms, "ms", core.ANY), { request }) };
				if (action === "cancel") { await client.cancel(id, { request }); return { state: "cancelled" }; }
				throw new Bad("action must be renew or cancel");
			}
			case "changes": return this.changes(a, c);
			case "notify": {
				const t = template(a.template); this.checkTypes(grant, t?.type ? [t.type] : undefined, "this subscription");
				this.checkConsumer(a.consumer, c.id);
				return await client.notify(t, { target: principalId(c.id.principal), lease: duration(a.leaseMs, "leaseMs", core.ANY), txn: (a.txn as string | null | undefined) ?? null, handback: a.handback ?? null, request }) as unknown as Json;
			}
			case "wait": {
				const t = template(a.template); this.checkTypes(grant, t?.type ? [t.type] : undefined, "this wait");
				this.checkConsumer(a.consumer, c.id);
				if (a.take !== undefined && typeof a.take !== "boolean") throw new Bad("take must be boolean");
				const operationGrant = this.allowed(c.id, a.take === false ? "read" : "take"); this.checkTypes(operationGrant, t?.type ? [t.type] : undefined, "this wait operation");
				const id = await client.wait(t, { target: principalId(c.id.principal), timeout: duration(a.timeoutMs, "timeoutMs", core.NO_WAIT), ...(a.deadline===undefined?{}:{deadline:int(a.deadline,"deadline",0)}), take: a.take !== false, txnLeaseMs: duration(a.txnLeaseMs, "txnLeaseMs", core.ANY), handback: a.handback ?? null, request });
				return { id };
			}
			case "events": {
				this.checkConsumer(a.consumer, c.id);
				const end = this.now() + Math.min(optInt(a.waitMs, "waitMs") ?? 0, this.o.maxPollMs);
				for (;;) {
					const p = await client.events(c.id.principal, { ...(a.mailboxEpoch === undefined ? {} : { mailboxEpoch: str(a.mailboxEpoch, "mailboxEpoch") }), after: optInt(a.after, "after"), maxBytes: Math.min(a.maxBytes === undefined ? c.frameBytes : int(a.maxBytes, "maxBytes", 1), c.frameBytes - 21) }, p => { for (const item of p.events) if (item.event.entry) this.checkTypes(grant, item.event.entry.types, "this mailbox event"); });
					if (p.events.length || p.gap || this.now() >= end) return p as unknown as Json;
					await awaitWithContext(new Promise<void>(r => setTimeout(r, Math.min(50, Math.max(1, end - this.now())))), this.o.ctx);
				}
			}
			case "ack": this.checkConsumer(a.consumer, c.id); return await client.ack(c.id.principal, str(a.mailboxEpoch, "mailboxEpoch"), int(a.upTo, "upTo"), { request }) as unknown as Json;
			default: throw new Bad(`${method} is not implemented`);
		}
	}
	private checkConsumer(v: unknown, id: Identity): void {
		if (v !== undefined && (!isObj(v) || principalId(v as unknown as Principal) !== principalId(id.principal))) throw new Denied("a consumer must be your authenticated principal");
	}

	private async hello(a: Record<string, Json>, c: { id: Identity; space?: string; client: PiSpaces; frameBytes: number }): Promise<Json> {
		if (a.protocol !== PROTOCOL_VERSION) throw new UnsupportedProtocol(`this host speaks protocol ${PROTOCOL_VERSION}`);
		const infos = await listSpaces(this.o.host, this.o.ctx);
		let info = infos.find((i) => i.alias === (c.space ?? DEFAULT_ALIAS) || i.spaceId === c.space);
		if (!info && (c.space === undefined || c.space === DEFAULT_ALIAS)) { // an untouched session registers its default space on first use
			await this.o.host.commit(async (tx) => { await spaceDoc(tx, undefined, this.now()); }, this.o.ctx);
			info = (await listSpaces(this.o.host, this.o.ctx)).find((i) => i.alias === DEFAULT_ALIAS);
		}
		if (!info) throw new UnknownSpaceError(`unknown space: ${c.space}`);
		const s = await snapshotSpace(this.o.host, info.spaceId, this.o.ctx);
		const lim = core.limitsOf(s ?? core.initialState());
		return {
			protocol: PROTOCOL_VERSION,
			hostId: this.o.hostId ?? (await this.o.host.snapshot(Registry, this.o.ctx))!.hostId,
			spaceId: info.spaceId, alias: info.alias, incarnation: info.incarnation, streamId: core.streamIdOf(s ?? core.initialState()), rev: core.revision(s ?? core.initialState()),
			authorityId: this.o.authorityId, primaryEpoch: await this.o.epochForSpace?.(info.spaceId) ?? this.o.primaryEpoch, role: "single",
			principal: principalKey(c.id.principal), roles: c.id.roles,
			features: [...METHODS],
			limits: { maxFrameBytes: Math.min(lim.maxFrameBytes, c.frameBytes), maxCommitBytes: lim.maxCommitBytes, maxEventBytes: lim.maxEventBytes, maxEntryBytes: lim.maxEntryBytes, maxPollMs: this.o.maxPollMs, maxPendingPerPrincipal: this.o.maxPendingPerPrincipal, maxPendingPerPeer: this.o.maxPendingPerPeer },
			capabilities: { snapshotPagination: true, mailboxes: true, completionProfiles: true, transactions: true, blockingTake: true, mode: "single" },
		} as Json;
	}

	private target(v: unknown, id: Identity): RequestRef {
		if (!isObj(v)) throw new Bad("targetRequest is required");
		return { principal: id.principal, generation: str(v.generation, "targetRequest.generation"), requestId: str(v.requestId, "targetRequest.requestId") };
	}

	/** read/take: `done` with the entry or null, or `pending` while the operation keeps running on the host. */
	/**
	 * Calls on a merge type of this Space go to its entry replication controller; everything else returns undefined.
	 * Reads see the converging view and are marked `replicated` (they may be stale); exclusive operations are refused.
	 */
	private async mergeCall(method: Method, a: Record<string, Json>, c: { id: Identity; request?: RequestRef; space?: string; grant: { types: ReadonlySet<string> | "*" } }): Promise<Json | undefined> {
		const merge = this.o.merge?.(c.space);
		if (!merge) return undefined;
		const rule = (type: unknown) => typeof type === "string" ? merge.rules.find(r => r.type === type) : undefined;
		const refuse = (what: string) => { throw new MergeTypeNotExclusive(`${what} is not available for merge types (lww/set)`); };
		const { entryChangeId } = await import("./entry-replication.ts");
		const view = (v: import("./entry-replication.ts").ReplicatedEntryView) => ({ id: v.id, type: v.type, types: [v.type], fields: v.fields as Json, owner: v.owner as unknown as Json, expires: v.expiresAt ?? core.FOREVER, replicated: true });
		const matches = (t: core.Template, v: import("./entry-replication.ts").ReplicatedEntryView) => !t || (!t.type || t.type === v.type) && Object.entries(t.fields ?? {}).every(([k, x]) => JSON.stringify(x) === JSON.stringify((v.fields as Record<string, unknown>)[k]));
		if (method === "write") {
			if (!isObj(a.entry) || !rule(a.entry.type)) return undefined;
			const r = rule(a.entry.type)!, type = r.type;
			if (!isObj(a.entry.fields)) throw new Bad("entry.fields must be an object");
			if (a.entry.types !== undefined) throw new Bad("a merge type takes no supertypes");
			if (a.txn !== undefined && a.txn !== null) refuse("a transaction");
			this.checkTypes(c.grant, [type], `type ${type}`);
			if (!c.request) throw new Bad("a merge write needs a request ID");
			const ms = duration(a.leaseMs, "leaseMs", core.ANY), expiresAt = ms === core.ANY || ms >= core.FOREVER ? null : this.now() + ms;
			// A request is identified by principal, generation and request ID (claims); the controller gets that identity.
			const changeRequest = createHash("sha256").update(canonicalJson([c.id.principal, c.request.generation, c.request.requestId] as unknown as Json)).digest("hex");
			const change = await merge.controller.mutate(changeRequest, { kind: r.variant === "lww" ? "put" : "add", type, fields: a.entry.fields as Record<string, Json>, owner: { ...c.id.principal }, expiresAt } as never);
			return { id: entryChangeId(change), expires: expiresAt ?? core.FOREVER, replicated: true };
		}
		if (method === "read" || method === "take" || method === "readAll" || method === "count" || method === "wait") {
			const t = template(a.template);
			if (!rule(t?.type)) return undefined;
			if (method === "take" || method === "wait") refuse(method);
			if (a.txn !== undefined && a.txn !== null) refuse("a transaction");
			this.checkTypes(c.grant, [t!.type!], "this template");
			const found = (await merge.controller.read()).filter(v => matches(t, v));
			if (method === "read") return { state: "done", entry: found[0] ? view(found[0]) : null, replicated: true };
			if (method === "count") return { value: found.length, rev: 0, streamId: "merge:" + merge.controller.documentKey, replicated: true };
			return { items: found.slice(0, 100).map(view), next: null, rev: 0, streamId: "merge:" + merge.controller.documentKey, replicated: true };
		}
		if (method === "lease" && typeof a.id === "string" && a.id.startsWith("[")) refuse("a lease change");
		return undefined;
	}

	private async readTake(method: "read" | "take", a: Record<string, Json>, c: { id: Identity; request?: RequestRef; client: PiSpaces; grant: { types: ReadonlySet<string> | "*" }; frameBytes: number }): Promise<Json> {
		const { client, request, grant } = c;
		const t = template(a.template);
		if (grant.types !== "*") this.checkTypes(grant, t?.type ? [t.type] : undefined, "this template");
		const timeout = duration(a.timeoutMs, "timeoutMs", core.NO_WAIT);
		const waitMs = Math.min(optInt(a.waitMs, "waitMs", 0) ?? this.o.maxPollMs, this.o.maxPollMs);
		let view = await client.beginOperation(t, timeout, { txn: (a.txn as string | null | undefined) ?? null, request: request!, resultBudget: c.frameBytes - 64, ...(a.deadline === undefined ? {} : { deadline: int(a.deadline, "deadline") }) }, method === "take", a.ifExists === true);
		if (view.state === "pending" && waitMs > 0) view = await this.poll({ targetRequest: { generation: request!.generation, requestId: request!.requestId }, waitMs }, c) as unknown as claims.ClaimView;
		if (view.resultExpired) throw new claims.ResultExpired("the stored result has expired");
		if (view.error) throw view.error.code === "CompletionViolation" ? new core.CompletionViolation(view.error.message) : new core.TransactionError(view.error.message);
		if (view.state === "cancelled") throw new claims.OperationCancelled("the operation was cancelled");
		return view.state === "done" ? { state: "done", entry: view.result ?? null } : { state: "pending", deadline: view.deadline };
	}

	/** The state of an own request; waits up to `waitMs` (at most maxPollMs) for it to leave `pending`. Never extends a deadline. */
	private async poll(a: Record<string, Json>, c: { id: Identity; client: PiSpaces }): Promise<Json> {
		const t = this.target(a.targetRequest, c.id);
		const waitMs = Math.min(optInt(a.waitMs, "waitMs", 0) ?? 0, this.o.maxPollMs);
		const end = this.now() + waitMs;
		for (;;) {
			const v = await c.client.pollOperation(t);
			if (v.result && isObj(v.result) && Array.isArray(v.result.types)) this.checkTypes(this.allowed(c.id, "pollOperation"), v.result.types as string[], "this retained result");
			if (v.state !== "pending" || v.restoredHistory || this.now() >= end) return v as unknown as Json;
			await awaitWithContext(new Promise<void>((res) => setTimeout(res, Math.min(50, Math.max(1, end - this.now())))), this.o.ctx);
		}
	}

	/** Commit batches after a revision; `resync` tells the client to read pages again (history dropped or another stream). */
	private async changes(a: Record<string, Json>, c: { client: PiSpaces; grant: { types: ReadonlySet<string> | "*" }; frameBytes: number }): Promise<Json> {
		if (c.grant.types !== "*") throw new Denied("the change stream carries every type; it needs a role without type limits");
		const after = int(a.afterRev, "afterRev", 0);
		const waitMs = Math.min(optInt(a.waitMs, "waitMs", 0) ?? 0, this.o.maxPollMs);
		const maxBytes = Math.min(a.maxBytes === undefined ? c.frameBytes : int(a.maxBytes, "maxBytes", 1), c.frameBytes - 21);
		const end = this.now() + waitMs;
		for (;;) {
			let r: core.Changes;
			try { r = await c.client.changes(after, maxBytes === undefined ? {} : { maxBytes }); }
			catch (e) {
				if (e instanceof core.SnapshotExpired || e instanceof core.RevisionAhead) return { resync: true, reason: e instanceof core.SnapshotExpired ? "history dropped" : "ahead of this stream" };
				throw e;
			}
			if (a.streamId !== undefined && a.streamId !== r.streamId) return { resync: true, reason: "another stream", streamId: r.streamId };
			if (r.batches.length > 0 || this.now() >= end) return r as unknown as Json;
			await awaitWithContext(new Promise<void>((res) => setTimeout(res, Math.min(50, Math.max(1, end - this.now())))), this.o.ctx);
		}
	}

	// ---- errors

	private error(e: unknown): Reply {
		const sealed = sealedIn(e) ?? (() => { try { return this.o.sealedCandidate?.() ?? null; } catch { return null; } })();
		if (sealed) return this.noteSealed(sealed);
		if(e instanceof RoutingConflict)return fail("RoutingConflict",e.message);if(e instanceof MemberDrained)return fail("MemberDrained",e.message);if(e instanceof MigrationRequired)return fail("MigrationRequired",e.message);
		if (e instanceof Bad) return fail("BadRequest", e.message);
		if (e instanceof Denied || e instanceof core.PermissionError) return fail("PermissionDenied", (e as Error).message);
		if (e instanceof UnsupportedProtocol) return fail("UnsupportedProtocol", e.message);
		if (e instanceof UnknownSpaceError) return fail("UnknownSpace", e.message);
		if (e instanceof claims.RequestConflict) return fail("RequestConflict", e.message);
		if (e instanceof claims.RequestExpired) return fail("RequestExpired", e.message);
		if (e instanceof claims.ResultExpired) return fail("ResultExpired", e.message);
		if (e instanceof claims.IncarnationChanged) return fail("IncarnationChanged", e.message);
		if (e instanceof claims.NotCommitted) return fail("NotCommitted", e.message);
		if (e instanceof claims.OperationCancelled) return fail("OperationCancelled", e.message);
		if (e instanceof core.ResponseBudgetTooSmall) return fail("ResponseBudgetTooSmall", e.message, { requiredBytes: e.requiredBytes });
		if (e instanceof core.LimitError) return fail("ResourceExhausted", e.message); // includes ResourceExhausted itself
		if (e instanceof SyncBudgetExceeded) return fail("ResourceExhausted", "primary/sync journal: " + e.message);
		if (e instanceof core.SnapshotExpired) return fail("SnapshotExpired", e.message);
		if (e instanceof core.RevisionAhead) return fail("RevisionAhead", e.message);
		if (e instanceof core.CompletionViolation) return fail("CompletionViolation", e.message);
		if (e instanceof MailboxEpochMismatch) return fail("MailboxEpochMismatch", e.message);
		if (e instanceof InvalidAck) return fail("InvalidAck", e.message);
		if (e instanceof core.TransactionError || e instanceof core.UnknownLeaseError) return fail("TransactionError", (e as Error).message);
		if (e instanceof MergeTypeNotExclusive) return fail("MergeTypeNotExclusive", e.message);
		if (e instanceof ReplicationConflict) return fail("BadRequest", e.message);
		if (e instanceof ReplicationClockError) return fail("ResourceExhausted", "replication clock: " + e.message);
		if (e instanceof core.IllegalArgumentError || e instanceof TypeError) return fail("BadRequest", (e as Error).message);
		return fail("Internal", e instanceof Error ? e.message : String(e));
	}
}
class UnsupportedProtocol extends Error {}
/** A sealed candidate, also when the storage layer wrapped it as a cause. */
function sealedIn(e: unknown): CommitSealed | null { for (let x = e, n = 0; x && n < 8; x = (x as { cause?: unknown }).cause, n++) if (x instanceof CommitSealed) return x; return null; }
/** The caller keeps resolving the same request: its outcome may be in the sealed candidate. Never a failure. */
export const sealedReply = (e: { revision: number; hash: string }): Reply => fail("CommitSealed", `a commit of this Space is sealed but not confirmed (revision ${e.revision}); the outcome is pending, poll or retry the same request`);
