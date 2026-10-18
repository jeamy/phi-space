// RemoteSpace (federation-plan-v3.md 6.3, AP 1.9): the SpaceLike contract over an abstract transport, speaking the
// `space` service (service.ts). It keeps the request identity and the arguments of a call until the call is decided,
// repeats lost transport attempts with the SAME identity (the host stores the outcome, so a retry never acts twice) and
// polls the same operation for blocking calls. A transport failure is never an outcome: after the attempts are used up the
// caller gets `OutcomeUnknown {request}` and can poll, retry or cancel that very request. The client's own patience
// (`maxClientWaitMs`) only ends the waiting: the operation keeps running on the host to its own deadline.
import * as core from "./core.ts";
import * as claims from "./claims.ts";
import { PROTOCOL_VERSION, MergeTypeNotExclusive, type Call, type ErrorCode, type Reply } from "./service.ts";
import { AUTH_PROTOCOL, signedBytes, type Challenge, type Signer } from "./auth.ts";
import type { EntryDraft, Json, Lease, Template } from "./core.ts";
import type { ClaimView, RequestRef } from "./claims.ts";
import type { OpOptions, Req, SpaceLike, Taken } from "./client.ts";
import { MailboxEpochMismatch, InvalidAck, type MailboxPage } from "./mailbox.ts";
import { performance } from "node:perf_hooks";

/** One round trip: the encoded call out, the encoded reply back. It may fail or hang; the caller decides what that means. */
export interface Transport { request(text: string): Promise<string> }

// The server keeps one open challenge per connection. Separate clients sharing a transport
// must complete challenge/sign/prove in order; no successful proof or principal is cached here.
const proofQueues = new WeakMap<Transport, Promise<void>>();
function orderedProof<T>(transport: Transport, run: () => Promise<T>): Promise<T> {
 const previous = proofQueues.get(transport) ?? Promise.resolve();
 const result = previous.then(run);
 const tail = result.then(() => {}, () => {});
 proofQueues.set(transport, tail);
 void tail.then(() => { if (proofQueues.get(transport) === tail) proofQueues.delete(transport); });
 return result;
}

/** Hands calls straight to a service in the same process. */
export function inProcessTransport(service: { handleText(text: string, conn: import("./service.ts").Connection, maxFrameBytes?: number): Promise<string> }, conn: import("./service.ts").Connection): Transport {
	return { request: (text) => service.handleText(text, conn) };
}

/** A reply that says no. `code` is the protocol code; the known ones also have their own error classes below. */
export class RemoteError extends Error {
	code: ErrorCode;
	requiredBytes?: number;
	constructor(code: ErrorCode, message: string, requiredBytes?: number) { super(message); this.code = code; this.requiredBytes = requiredBytes; }
}
/** The waiting ended without an outcome (transport kept failing, or `maxClientWaitMs` passed). The call may still have happened or still happen. */
export class OutcomeUnknown extends Error {
	request: { generation: string; requestId: string };
	constructor(request: { generation: string; requestId: string }, why: string) { super(`outcome unknown for request ${request.requestId}: ${why}`); this.request = request; }
}
/**
 * The host sealed a primary/sync commit but has not confirmed it yet (`CommitSealed`): the request may be in that
 * candidate. Keep polling or retrying exactly this request; never start a new ID for it, never treat it as failed.
 */
export class CommitSealedPending extends OutcomeUnknown {}
export class UnsupportedOperation extends Error {}

export type RemoteOptions = {
	/** Obtain a fresh control-primary grant. Client-selected roles are never accepted. */
	grantProvider?: (call: Call) => Promise<Json>;
	/** Renewable signed router delegation; original principal grant is supplied separately. */
	delegationProvider?: (call: Call, grant?: Json) => Promise<Json>;
	/** Stable space id or alias; omitted: the default space. */
	space?: string;
	/** Transport attempts per call (default 5), pause before the n-th retry: min(backoffMs * 2^n, maxBackoffMs) plus jitter. */
	attempts?: number;
	backoffMs?: number;
	maxBackoffMs?: number;
	/** One transport round trip may take this long (default 35 s: a poll of 25 s plus margin). */
	callTimeoutMs?: number;
	/** The caller stops waiting for a blocking call after this long: OutcomeUnknown. No default (waits of FOREVER are legitimate). */
	maxClientWaitMs?: number;
	/** Layer B: the app key of this client; needs `expectedGateHostId` and `ownPeerId`. */
	signer?: Signer;
	/** The host id this client means to reach (checked against every challenge) and the NetBird peer id of this client. */
	expectedGateHostId?: string;
	ownPeerId?: string;
	/** The part of a generation's admission time that must remain to start a call under it (default 5 s). */
	generationMarginMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
	/** Request ids (default: random). */
	newRequestId?: () => string;
	/** What to expect from the server when it is hello'd, for example `features`. */
	frameFraction?: number;
};

export type Hello = { principal: string; roles: string[]; hostId?: string; spaceId: string; alias: string; incarnation: string; streamId: string; authorityId: string; primaryEpoch: number; limits: { maxFrameBytes: number; maxPollMs: number } & Record<string, number>; features: string[]; capabilities: { snapshotPagination: boolean; mailboxes: boolean; completionProfiles: boolean; transactions: boolean; blockingTake: boolean; mode: "single" } };

const CODE_ERRORS: Partial<Record<ErrorCode, (m: string, r?: number) => Error>> = {
	RequestConflict: (m) => new claims.RequestConflict(m),
	RequestExpired: (m) => new claims.RequestExpired(m),
	NotCommitted: (m) => new claims.NotCommitted(m),
	ResultExpired: (m) => new claims.ResultExpired(m),
	IncarnationChanged: (m) => new claims.IncarnationChanged(m),
	OperationCancelled: (m) => new claims.OperationCancelled(m),
	ResourceExhausted: (m) => new core.ResourceExhausted(m),
	ResponseBudgetTooSmall: (_m, r) => new core.ResponseBudgetTooSmall(r ?? 0),
	SnapshotExpired: (m) => new core.SnapshotExpired(m),
	RevisionAhead: (m) => new core.RevisionAhead(m),
	PermissionDenied: (m) => new core.PermissionError(m),
	ReplicaConfigPending: (m) => new core.ReplicaConfigPending(m),
	StalePolicyVersion: (m) => new core.StalePolicyVersion(m),
	TransactionError: (m) => new core.TransactionError(m),
	CompletionViolation: (m) => new core.CompletionViolation(m),
	MergeTypeNotExclusive: (m) => new MergeTypeNotExclusive(m),
	MailboxEpochMismatch: (m) => new MailboxEpochMismatch(m),
	InvalidAck: (m) => new InvalidAck(m),
	BadRequest: (m) => new core.IllegalArgumentError(m),
};
const toError = (e: { code: ErrorCode; message: string; requiredBytes?: number }): Error => CODE_ERRORS[e.code]?.(e.message, e.requiredBytes) ?? new RemoteError(e.code, e.message, e.requiredBytes);

export class TransportFailure extends Error {}

export class RemoteSpace implements SpaceLike {
	private t: Transport;
	private o: Required<Omit<RemoteOptions, "space" | "maxClientWaitMs" | "frameFraction" | "signer" | "expectedGateHostId" | "ownPeerId" | "grantProvider" | "delegationProvider">> & Pick<RemoteOptions, "space" | "maxClientWaitMs" | "signer" | "expectedGateHostId" | "ownPeerId" | "grantProvider" | "delegationProvider">;
	private proving?: Promise<unknown>;
	private enrollRequest?: { generation: string; requestId: string };
	/** What the link cost so far: transport attempts repeated with the same identity, and calls given up as OutcomeUnknown. */
	readonly counters = { retries: 0, unknown: 0 };
	private hello?: Promise<Hello>;
	private frameLimit = core.DEFAULT_LIMITS.maxFrameBytes; // until the host has announced its own
	private gen?: { generation: string; admitUntil: number };
	private genPending?: Promise<{ generation: string; admitUntil: number }>;

	constructor(transport: Transport, o: RemoteOptions = {}) {
		if (o.signer && (!o.expectedGateHostId || !o.ownPeerId)) throw new core.IllegalArgumentError("a signer needs expectedGateHostId and ownPeerId: without them a challenge relayed by another peer could not be recognised");
		this.t = transport;
		this.o = {
			attempts: 5, backoffMs: 100, maxBackoffMs: 2_000, callTimeoutMs: 35_000, generationMarginMs: 5_000,
			now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random,
			newRequestId: () => `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
			...o,
		};
	}

	/** The server's answer to `hello`: identity of the space, limits, features. Asked once. */
	info(): Promise<Hello> {
		return (this.hello ??= this.rawCall("hello", { protocol: PROTOCOL_VERSION }).then((r) => { const h = r as unknown as Hello; this.frameLimit = h.limits.maxFrameBytes; return h; }, (e) => { this.hello = undefined; throw e; }));
	}

	// ---- transport with identity-preserving retries

	private async roundTrip(call: Call, end?: number): Promise<Reply> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const raw = await Promise.race([
				(async () => {
					const grant = this.o.grantProvider && !["challenge", "prove", "enroll", "enrollStatus", "grant"].includes(call.method) ? await this.o.grantProvider(call) : undefined;
					const delegation=this.o.delegationProvider && !["challenge","prove","enroll","enrollStatus","grant","keyLookup","routerLease","epochNotice","routingPolicy","membershipInstruction","runGateInstruction","spaceLifecycleInstruction","workerAssignments","capabilityHeartbeat","replicaNotice","entryDescribe","entryChanges"].includes(call.method) ? await this.o.delegationProvider(call,grant) : undefined;
					const text = JSON.stringify(grant||delegation ? { ...call, frame: { ...call.frame, ...(grant?{grant}:{}), ...(delegation?{delegation}: {}) } } : call);
					const limit = this.frameLimit; // not read from `hello`: the retries of `hello` itself must not wait for it
					if (new TextEncoder().encode(text).length > limit) throw new core.ResourceExhausted(`a call may take at most ${limit} bytes`);
					return this.t.request(text);
				})(),
				new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new TransportFailure("the call timed out")), Math.max(1, Math.min(this.o.callTimeoutMs, end === undefined ? Infinity : end - performance.now()))); }),
			]);
			try {
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean" || (parsed.ok && !Object.hasOwn(parsed, "result")) || (!parsed.ok && (!parsed.error || typeof parsed.error.code !== "string"))) throw new Error("invalid reply envelope");
				return parsed as Reply;
			} catch { throw new TransportFailure("the reply is not a protocol reply"); }
		} catch (e) {
			throw e instanceof TransportFailure || e instanceof core.ResourceExhausted ? e : new TransportFailure(e instanceof Error ? e.message : String(e));
		} finally { clearTimeout(timer); }
	}

	/**
	 * Send `call`; a transport failure repeats the very same call (same request identity, same arguments). `ok:false` replies
	 * are answers, never retried: they throw. Returns the result. `onExhausted` turns "attempts used up" into the caller's error.
	 */
	private async send(call: Call, onExhausted?: () => Error, end?: number, mapReply?: (reply:Extract<Reply,{ok:true}>)=>Json): Promise<Json> {
		call = core.plain(call as unknown as Json) as unknown as Call;
		let last: unknown;
		let reproved = false;
		for (let n = 0; n < this.o.attempts; n++) {
			if (end !== undefined && performance.now() >= end) break;
			if (n > 0) this.counters.retries++;
			if (n > 0) await this.o.sleep(Math.min(Math.min(this.o.backoffMs * 2 ** (n - 1), this.o.maxBackoffMs) * (1 + this.o.random()), end === undefined ? Infinity : Math.max(0, end - performance.now())));
			if (end !== undefined && performance.now() >= end) break;
			try {
				const r = await this.roundTrip({ ...call, ...(this.o.space === undefined ? {} : { space: this.o.space }) }, end);
				if (!r.ok) {
					const target = call.request ?? (call.args?.targetRequest as { generation: string; requestId: string } | undefined);
					if (r.error.code === "CommitSealed" && target && typeof target === "object") throw new CommitSealedPending({ generation: target.generation, requestId: target.requestId }, r.error.message);
					throw toError(r.error);
				}
				return mapReply?mapReply(r):r.result;
			} catch (e) {
				// the host withheld a privileged role because this connection has not proven its app key: prove once, repeat the call
				if (e instanceof RemoteError && e.code === "ProofRequired" && this.o.signer && !reproved) { reproved = true; await this.authenticate(); n--; continue; }
				if (!(e instanceof TransportFailure)) throw e;
				last = e;
			}
		}
		if (onExhausted) this.counters.unknown++;
		throw onExhausted ? onExhausted() : (last as Error);
	}
	private rawCall(method: Call["method"], args: Record<string, Json> = {}): Promise<Json> { return this.send({ method, args }); }

	/** Router adapter entry point: preserves externally journaled request identity. */
	async requestBound(call:Call):Promise<Json>{return this.send(call);}
 async requestBoundWithClaim(call:Call):Promise<{result:Json;claimReceipt:import('./service.ts').ClaimReceipt|null}>{
  return await this.send({...call,frame:{...call.frame,claimReceipt:true}},undefined,undefined,r=>({result:r.result,claimReceipt:r.claimReceipt??null}) as unknown as Json) as unknown as {result:Json;claimReceipt:import('./service.ts').ClaimReceipt|null};
 }
 async resolveOperation(target:{generation:string;requestId:string},method:string,argumentHash:string,primaryEpoch:number):Promise<claims.AdmissionResolution>{return await this.send({method:'resolveOperation',args:{targetRequest:target,method,argumentHash,primaryEpoch}}) as unknown as claims.AdmissionResolution;}
	async requestGeneration():Promise<{generation:string;admitUntil:number}>{return await this.rawCall("generation") as any;}
	/** Leaves this primary's signed ReplicaConfigNotice in the control Space (the control host checks the proven host). */
	/** The entry stream of a merge replica (lww/set step 2); only pinned peers of the same replication are answered. */
	async entryDescribe():Promise<import("./entry-replication-stream.ts").EntryStreamDescription>{return await this.send({method:"entryDescribe" as any,args:{}}) as any;}
	async entryChanges(after:number,maxBytes:number):Promise<import("./entry-replication-stream.ts").EntryStreamPage>{return await this.send({method:"entryChanges" as any,args:{after,maxBytes}}) as any;}
	/** The supervisor's signed EpochNotice for this Space (v3 5.2); the Member raises its epoch high-water marks. */
	async sendEpochNotice(signedNotice:import("./delegation.ts").SignedEpochNotice):Promise<{installed:boolean}>{return await this.send({method:"epochNotice" as any,args:{signedNotice:signedNotice as any}}) as any;}
	async publishReplicaNotice(notice:import("./replica-notice.ts").SignedReplicaConfigNotice):Promise<{stored:boolean}>{return await this.send({method:"replicaNotice" as any,args:{notice:notice as any}}) as any;}
	async publishCapability(report:import("./capability-directory.ts").CapabilityReport):Promise<import("./core.ts").Lease>{return await this.send({method:"capabilityHeartbeat" as any,args:{report:report as any}}) as any;}
	/** The signed worker assignments of this (proven) host; the control host derives the host from the connection. */
	async workerAssignments():Promise<import("./workers.ts").SignedWorkers>{return await this.send({method:"workerAssignments" as any,args:{}}) as any;}
	async requestSpaceLifecycle(instruction:import("./space-lifecycle.ts").SignedLifecycle<import("./space-lifecycle.ts").SpaceLifecycleInstruction>):Promise<import("./space-lifecycle.ts").SignedLifecycle<import("./space-lifecycle.ts").SpaceLifecycleResult>>{return await this.send({method:"spaceLifecycleInstruction" as any,args:{instruction:instruction as any}}) as any;}
	async requestRunGate(instruction:import("./run-member.ts").SignedRun<import("./run-member.ts").RunGateInstruction>):Promise<import("./run-member.ts").SignedRun<import("./core.ts").RunGateAck>>{return await this.send({method:"runGateInstruction" as any,args:{instruction:instruction as any}}) as any;}
	async requestMembership(instruction:import("./membership.ts").SignedMembership<import("./membership.ts").MembershipInstruction>):Promise<import("./membership.ts").SignedMembership<import("./membership.ts").MembershipProof>>{return await this.send({method:"membershipInstruction" as any,args:{instruction:instruction as any}}) as any;}

	/** Ask the authoritative control runtime; replicas and data members do not implement this method. */
	async requestGrant(purpose: "effect" | "resolution" = "effect", agentId?:string): Promise<Json> {
		return this.send({ method: "grant" as Call["method"], args: { purpose,...(agentId===undefined?{}:{agentId}) } });
	}
	async requestRouterLease(renew?:{id:string;routerEpoch:number}):Promise<import("./delegation.ts").SignedRouterLease>{return await this.send({method:"routerLease" as Call["method"],args:renew?{renew}: {}}) as unknown as import("./delegation.ts").SignedRouterLease;}
	async requestRoutingPolicy():Promise<import("./federation-policy.ts").SignedFederationPolicy>{return await this.send({method:"routingPolicy" as Call["method"]}) as unknown as import("./federation-policy.ts").SignedFederationPolicy;}

	async lookupPeerKey(peerId: string, keyId: string): Promise<import("./auth.ts").PeerKeyRec | null> {
		return await this.send({ method: "keyLookup" as Call["method"], args: { peerId, keyId } }) as unknown as import("./auth.ts").PeerKeyRec | null;
	}
	async rotationChallenge(algorithm: Signer["algorithm"], publicKey: string): Promise<import("./rotation.ts").RotationChallenge> {
		return await this.send({ method: "rotationChallenge" as Call["method"], args: { algorithm, publicKey } }) as unknown as import("./rotation.ts").RotationChallenge;
	}
	async rotateKey(challenge: import("./rotation.ts").RotationChallenge, replacement: Signer, prepared?: { request?: { generation: string; requestId: string }; beforeSend?: (request: { generation: string; requestId: string }) => Promise<void> }): Promise<{ state: string; commandId: string }> {
		if (!this.o.signer) throw new UnsupportedOperation("rotation needs the old signer");
		const bytes = (await import("./rotation.ts")).rotationBytes(challenge);
		const args = { challenge: challenge as unknown as Json, oldSignature: Buffer.from(await this.o.signer.sign(bytes)).toString("base64"), newSignature: Buffer.from(await replacement.sign(bytes)).toString("base64") };
		const request = prepared?.request ?? { generation: ((await this.send({ method: "rotationGeneration" as Call["method"] })) as { generation: string }).generation, requestId: this.o.newRequestId() };
		await prepared?.beforeSend?.(request);
		return await this.send({ method: "rotateKey" as Call["method"], args, request }, () => new OutcomeUnknown(request, "the rotation answer was lost")) as unknown as { state: string; commandId: string };
	}
	async rotationStatus(commandId: string): Promise<Json> { return this.send({ method: "rotationStatus" as Call["method"], args: { commandId } }); }

	/**
	 * Layer B (4.3): prove the app key on this connection. The host's challenge must name the host this client means to reach
	 * and this client's own peer id before anything is signed, so a challenge that another peer relays is not answered.
	 * Done automatically when the host answers ProofRequired; call it yourself to prove up front.
	 */
	authenticate(): Promise<{ keyId: string; principal: string; roles: string[] }> {
		const signer = this.o.signer;
		if (!signer) return Promise.reject(new UnsupportedOperation("this RemoteSpace has no signer"));
		this.proving ??= orderedProof(this.t, async () => {
			const ch = (await this.send({ method: "challenge" as Call["method"], args: { protocol: AUTH_PROTOCOL } })) as unknown as Challenge & { expiresAt?: number };
			if (ch.gateHostId !== this.o.expectedGateHostId) throw new RemoteError("AuthorityMismatch", `the challenge comes from host ${ch.gateHostId}, not from ${this.o.expectedGateHostId}`);
			if (ch.observedPeerId !== this.o.ownPeerId) throw new RemoteError("AuthorityMismatch", `the host saw peer ${ch.observedPeerId} on this connection, not ${this.o.ownPeerId}: a challenge for another peer is not signed`);
			const { expiresAt: _expires, ...challenge } = ch;
			const signature = Buffer.from(await signer.sign(signedBytes(challenge))).toString("base64");
			return this.send({ method: "prove" as Call["method"], args: { keyId: signer.keyId, signature, challenge: challenge as unknown as Json } });
		}).finally(() => { this.proving = undefined; });
		return this.proving as Promise<{ keyId: string; principal: string; roles: string[] }>;
	}

	/**
	 * Pair this device (4.5): prove possession of the NEW key by signing the host's challenge and hand over the one-time token.
	 * Use a RemoteSpace on the control space (`space: "control"`) whose `signer` holds the new key. The request identity of
	 * the first attempt is kept: a retry after a lost answer is answered from the stored claim, also when the token is spent
	 * by then. Returns the id and role of the new key; afterwards `authenticate()` proves it as usual.
	 */
	async enroll(token: string, prepared?: { request?: { generation: string; requestId: string }; beforeSend?: (request: { generation: string; requestId: string }) => Promise<void> }): Promise<{ keyId: string; role: string; peerId: string; scope?: string[] }> {
		const signer = this.o.signer;
		if (!signer?.publicKey) throw new UnsupportedOperation("enroll needs a signer with its public key");
		if (!prepared?.request) await this.info();
		this.enrollRequest ??= prepared?.request ?? { generation: await this.generation(), requestId: this.o.newRequestId() };
		await prepared?.beforeSend?.(this.enrollRequest);
		const ch = (await this.send({ method: "challenge" as Call["method"], args: { protocol: AUTH_PROTOCOL } })) as unknown as Challenge & { expiresAt?: number };
		if (ch.gateHostId !== this.o.expectedGateHostId) throw new RemoteError("AuthorityMismatch", `the challenge comes from host ${ch.gateHostId}, not from ${this.o.expectedGateHostId}`);
		if (ch.observedPeerId !== this.o.ownPeerId) throw new RemoteError("AuthorityMismatch", `the host saw peer ${ch.observedPeerId} on this connection, not ${this.o.ownPeerId}`);
		const { expiresAt: _expires, ...challenge } = ch;
		const signature = Buffer.from(await signer.sign(signedBytes(challenge))).toString("base64");
		const request = this.enrollRequest;
		return (await this.send({ method: "enroll" as Call["method"], request, args: { token, algorithm: signer.algorithm, publicKey: signer.publicKey, signature, challenge: challenge as unknown as Json } } as Call, () => new OutcomeUnknown(request, "the transport kept failing"))) as { keyId: string; role: string; peerId: string; scope?: string[] };
	}
	/** The state of this device's own enrollment request (after OutcomeUnknown, for instance). */
	async enrollStatus(request?: { generation: string; requestId: string }): Promise<{ state: string; result?: Json }> {
		const target = request ?? this.enrollRequest;
		if (!target) throw new UnsupportedOperation("no enrollment was started");
		return (await this.send({ method: "enrollStatus" as Call["method"], args: { targetRequest: target as unknown as Json } })) as { state: string; result?: Json };
	}

	// ---- request identity

	/** A generation to start new requests under; renewed shortly before its admission ends. Known requests need none. */
	private async generation(): Promise<string> {
		if (this.gen && this.gen.admitUntil - this.o.now() > this.o.generationMarginMs) return this.gen.generation;
		this.genPending ??= this.rawCall("generation").then((r) => { const g = r as unknown as { generation: string; admitUntil: number }; this.gen = g; return g; }).finally(() => { this.genPending = undefined; });
		return (await this.genPending).generation;
	}
	private async identity(o: Req | undefined): Promise<{ generation: string; requestId: string }> {
		await this.info();
		if (o?.request) return { generation: o.request.generation, requestId: o.request.requestId }; // a durable caller keeps its own
		return { generation: await this.generation(), requestId: this.o.newRequestId() };
	}
	private async mutate(method: Call["method"], args: Record<string, Json>, o: Req | undefined): Promise<Json> {
		args = core.plain(args);
		const request = await this.identity(o);
		return this.send({ method, request, args }, () => new OutcomeUnknown(request, "the transport kept failing"));
	}

	// ---- SpaceLike

	async write(entry: EntryDraft, txn: string | null = null, lease: number = core.ANY, o: Req = {}): Promise<Lease> {
		if (o.unique && !(await this.info()).features.includes("write.unique")) throw new UnsupportedOperation("server does not support atomic unique writes");
		return (await this.mutate("write", { entry: entry as unknown as Json, txn, leaseMs: leaseArg(lease), ...(o.unique ? { unique: o.unique } : {}) }, o)) as unknown as Lease;
	}
	read(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.blocking("read", tmpl, timeout, o, false); }
	readIfExists(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.blocking("read", tmpl, timeout, o, true); }
	take(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.blocking("take", tmpl, timeout, o, false); }
	takeIfExists(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.blocking("take", tmpl, timeout, o, true); }

	private async blocking(method: "read" | "take", tmpl: Template, timeout: number, o: OpOptions, ifExists: boolean): Promise<Taken | null> {
		if (o.once) throw new core.IllegalArgumentError("`once` is a local hook: a remote call keeps its outcome under its request identity instead");
		const request = await this.identity(o);
		const started = performance.now();
		const end = this.o.maxClientWaitMs === undefined ? undefined : started + this.o.maxClientWaitMs;
		const args = { template: tmpl as unknown as Json, timeoutMs: leaseArg(timeout), ...(o.deadline === undefined ? {} : { deadline: o.deadline }), txn: o.txn ?? null, ifExists, waitMs: this.pollMs(end) };
		const unknown = (why: string) => () => new OutcomeUnknown(request, why);
		// A sealed, unconfirmed commit of the Space: the request may not even be admitted yet. Wait a little, then send the
		// very same call again (same request identity, so it meets its claim if there is one).
		const sealedWait = async (e: unknown) => { if (!(e instanceof CommitSealedPending) || end !== undefined && performance.now() >= end) throw e; await this.o.sleep(Math.min(1000, end === undefined ? 1000 : Math.max(1, end - performance.now()))); return { state: "sealed" }; };
		const call = () => this.send({ method, request, args }, unknown("the client stopped waiting; resolve the same request"), end).catch(sealedWait) as Promise<{ state: string; entry?: Taken | null }>;
		let r = await call();
		for (;;) {
			if (r.state === "done") return (r.entry ?? null) as Taken | null;
			if (r.state === "sealed") { r = await call(); continue; }
			if (this.o.maxClientWaitMs !== undefined && performance.now() - started >= this.o.maxClientWaitMs) throw new OutcomeUnknown(request, "the client stopped waiting; the operation continues on the host");
			let view: ClaimView;
			try { view = (await this.send({ method: "pollOperation", args: { targetRequest: request as unknown as Json, waitMs: this.pollMs(end) } }, unknown("the client stopped waiting while polling"), end)) as unknown as ClaimView; }
			catch (e) { r = await sealedWait(e) as { state: string }; continue; }
			if (view.resultExpired) throw new claims.ResultExpired("the operation's retained result expired");
			if (view.unknownOutcome) throw new OutcomeUnknown(request, "restored history cannot establish the original outcome");
			if (view.error) throw toError(view.error);
			if (view.state === "cancelled") throw new claims.OperationCancelled(`request ${request.requestId} was cancelled`);
			if (view.state === "done") return ((view.result ?? null) as unknown as Taken | null);
			r = { state: "pending" };
		}
	}
	private pollMs(end?: number): number {
		const left = end === undefined ? undefined : end - performance.now();
		return left === undefined ? 25_000 : Math.min(25_000, Math.max(1, Math.floor(left)));
	}

	/** The state of a request of this client, e.g. after `OutcomeUnknown`. */
	async pollOperation(request: { generation: string; requestId: string }, waitMs = 0): Promise<ClaimView> {
		await this.info();
		return (await this.send({ method: "pollOperation", args: { targetRequest: request as unknown as Json, waitMs } })) as unknown as ClaimView;
	}
	/** Cancel a pending request (a decided one stays as it is; the answer says which). */
	async cancelOperation(request: { generation: string; requestId: string }, o: Req = {}): Promise<ClaimView> {
		return (await this.mutate("cancelOperation", { targetRequest: request as unknown as Json }, o)) as unknown as ClaimView;
	}

	async notify(tmpl: Template, o: { target: core.Target; txn?: string | null; lease?: number; handback?: Json } & Req): Promise<{ eventId: string; lease: Lease }> {
		await this.checkOwnTarget(o.target);
		return await this.mutate("notify", { template: tmpl as unknown as Json, txn: o.txn ?? null, leaseMs: leaseArg(o.lease ?? core.ANY), handback: o.handback ?? null }, o) as unknown as { eventId: string; lease: Lease };
	}
	async wait(tmpl: Template, o: { take?: boolean; target: core.Target; timeout: number; txnLeaseMs?: number; handback?: Json } & Req): Promise<string> {
		await this.checkOwnTarget(o.target);
		const r = await this.mutate("wait", { template: tmpl as unknown as Json, take: o.take ?? true, timeoutMs: leaseArg(o.timeout), txnLeaseMs: leaseArg(o.txnLeaseMs ?? core.ANY), handback: o.handback ?? null }, o) as { id: string };
		return r.id;
	}
	private async checkOwnTarget(target: core.Target): Promise<void> {
		if (target !== "self" && target !== (await this.info()).principal) throw new core.IllegalArgumentError("remote events target the own principal mailbox; use target: self");
	}

	async events(o: { mailboxEpoch?: string; after?: number; maxBytes?: number; waitMs?: number } = {}): Promise<MailboxPage> {
		await this.info(); return await this.send({ method: "events", args: core.plain(o) as Record<string, Json> }) as unknown as MailboxPage;
	}
	async ack(mailboxEpoch: string, upTo: number, o: Req = {}): Promise<{ mailboxEpoch: string; acked: number }> {
		return await this.mutate("ack", { mailboxEpoch, upTo }, o) as unknown as { mailboxEpoch: string; acked: number };
	}

	async readPage(tmpl: Template = null, o: { maxBytes?: number; after?: string | null; token?: string; txn?: string | null } = {}): Promise<core.Page> {
		await this.info();
		const args = { template: tmpl as unknown as Json, ...(o.maxBytes === undefined ? {} : { maxBytes: o.maxBytes }), ...(o.token === undefined ? {} : { token: o.token }), cursor: o.after ?? null, txn: o.txn ?? null };
		return (await this.send({ method: "readAll", args })) as unknown as core.Page;
	}
	/** Like the local `readAll`: all entries, or the first `limit` when supplied, fetched page by page. */
	async readAll(tmpl: Template = null, o: { limit?: number; txn?: string | null } = {}): Promise<Taken[]> {
		const limit = o.limit ?? Number.MAX_SAFE_INTEGER;
		if (!Number.isInteger(limit) || limit < 1) throw new core.IllegalArgumentError("limit must be a positive integer");
		const out: Taken[] = [];
		let after: string | null = null;
		do {
			const p: core.Page = await this.readPage(tmpl, { after, txn: o.txn ?? null });
			out.push(...p.items);
			after = p.next;
		} while (after !== null && out.length < limit);
		return out.slice(0, limit);
	}
	async changes(afterRev: number, o: { maxBytes?: number; waitMs?: number; streamId?: string } = {}): Promise<core.Changes & { resync?: boolean }> {
		await this.info();
		const r = (await this.send({ method: "changes", args: { afterRev, ...(o.maxBytes === undefined ? {} : { maxBytes: o.maxBytes }), ...(o.waitMs === undefined ? {} : { waitMs: o.waitMs }), ...(o.streamId === undefined ? {} : { streamId: o.streamId }) } })) as unknown as core.Changes & { resync?: boolean; reason?: string };
		if (r.resync) throw new core.SnapshotExpired(r.reason ?? "read the pages again");
		return r;
	}
	async count(tmpl: Template = null, txn: string | null = null): Promise<number> {
		await this.info();
		return ((await this.send({ method: "count", args: { template: tmpl as unknown as Json, txn } })) as { value: number }).value;
	}
	async stats(): Promise<core.SpaceStats> {
		await this.info();
		return ((await this.send({ method: "stats" })) as unknown as { stats: core.SpaceStats }).stats;
	}
	async createTransaction(lease: number = core.ANY, o: Req = {}): Promise<Lease> { return (await this.mutate("txn", { action: "begin", leaseMs: leaseArg(lease) }, o)) as unknown as Lease; }
	async commit(txn: string, o: Req = {}): Promise<void> { await this.mutate("txn", { action: "commit", id: txn }, o); }
	async abort(txn: string, o: Req = {}): Promise<void> { await this.mutate("txn", { action: "abort", id: txn }, o); }
	async renew(leaseId: string, ms: number, o: Req = {}): Promise<number> { return ((await this.mutate("lease", { action: "renew", id: leaseId, ms: leaseArg(ms) }, o)) as { expires: number }).expires; }
	async cancel(leaseId: string, o: Req = {}): Promise<void> { await this.mutate("lease", { action: "cancel", id: leaseId }, o); }
}

/** core durations: ANY (-1) means "the space picks", FOREVER travels as the string "forever". */
function leaseArg(ms: number): Json {
	if (ms === core.FOREVER) return "forever";
	if (ms === core.ANY) return null;
	return ms;
}
