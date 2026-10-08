// RemoteSpace (federation-plan-v3.md 6.3, AP 1.9): the SpaceLike contract over an abstract transport, speaking the
// `space` service (service.ts). It keeps the request identity and the arguments of a call until the call is decided,
// repeats lost transport attempts with the SAME identity (the host stores the outcome, so a retry never acts twice) and
// polls the same operation for blocking calls. A transport failure is never an outcome: after the attempts are used up the
// caller gets `OutcomeUnknown {request}` and can poll, retry or cancel that very request. The client's own patience
// (`maxClientWaitMs`) only ends the waiting: the operation keeps running on the host to its own deadline.
import * as core from "./core.ts";
import * as claims from "./claims.ts";
import { PROTOCOL_VERSION, type Call, type ErrorCode, type Reply } from "./service.ts";
import type { EntryDraft, Json, Lease, Template } from "./core.ts";
import type { ClaimView, RequestRef } from "./claims.ts";
import type { OpOptions, Req, SpaceLike, Taken } from "./client.ts";

/** One round trip: the encoded call out, the encoded reply back. It may fail or hang; the caller decides what that means. */
export interface Transport { request(text: string): Promise<string> }

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
export class UnsupportedOperation extends Error {}

export type RemoteOptions = {
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

type Hello = { spaceId: string; alias: string; incarnation: string; streamId: string; authorityId: string; primaryEpoch: number; limits: { maxFrameBytes: number; maxPollMs: number } & Record<string, number>; features: string[] };

const CODE_ERRORS: Partial<Record<ErrorCode, (m: string, r?: number) => Error>> = {
	RequestConflict: (m) => new claims.RequestConflict(m),
	RequestExpired: (m) => new claims.RequestExpired(m),
	ResultExpired: (m) => new claims.ResultExpired(m),
	IncarnationChanged: (m) => new claims.IncarnationChanged(m),
	OperationCancelled: (m) => new claims.OperationCancelled(m),
	ResourceExhausted: (m) => new core.ResourceExhausted(m),
	ResponseBudgetTooSmall: (_m, r) => new core.ResponseBudgetTooSmall(r ?? 0),
	SnapshotExpired: (m) => new core.SnapshotExpired(m),
	RevisionAhead: (m) => new core.RevisionAhead(m),
	PermissionDenied: (m) => new core.PermissionError(m),
	TransactionError: (m) => new core.TransactionError(m),
	BadRequest: (m) => new core.IllegalArgumentError(m),
};
const toError = (e: { code: ErrorCode; message: string; requiredBytes?: number }): Error => CODE_ERRORS[e.code]?.(e.message, e.requiredBytes) ?? new RemoteError(e.code, e.message, e.requiredBytes);

class TransportFailure extends Error {}

export class RemoteSpace implements SpaceLike {
	private t: Transport;
	private o: Required<Omit<RemoteOptions, "space" | "maxClientWaitMs" | "frameFraction">> & Pick<RemoteOptions, "space" | "maxClientWaitMs">;
	private hello?: Promise<Hello>;
	private frameLimit = core.DEFAULT_LIMITS.maxFrameBytes; // until the host has announced its own
	private gen?: { generation: string; admitUntil: number };
	private genPending?: Promise<{ generation: string; admitUntil: number }>;

	constructor(transport: Transport, o: RemoteOptions = {}) {
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

	private async roundTrip(call: Call): Promise<Reply> {
		const text = JSON.stringify(call);
		const limit = this.frameLimit; // not read from `hello`: the retries of `hello` itself must not wait for it
		if (new TextEncoder().encode(text).length > limit) throw new core.ResourceExhausted(`a call may take at most ${limit} bytes`);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const raw = await Promise.race([
				this.t.request(text),
				new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new TransportFailure("the call timed out")), this.o.callTimeoutMs); }),
			]);
			try { return JSON.parse(raw) as Reply; } catch { throw new TransportFailure("the reply is not JSON"); }
		} catch (e) {
			throw e instanceof TransportFailure || e instanceof core.ResourceExhausted ? e : new TransportFailure(e instanceof Error ? e.message : String(e));
		} finally { clearTimeout(timer); }
	}

	/**
	 * Send `call`; a transport failure repeats the very same call (same request identity, same arguments). `ok:false` replies
	 * are answers, never retried: they throw. Returns the result. `onExhausted` turns "attempts used up" into the caller's error.
	 */
	private async send(call: Call, onExhausted?: () => Error): Promise<Json> {
		let last: unknown;
		for (let n = 0; n < this.o.attempts; n++) {
			if (n > 0) await this.o.sleep(Math.min(this.o.backoffMs * 2 ** (n - 1), this.o.maxBackoffMs) * (1 + this.o.random()));
			try {
				const r = await this.roundTrip({ ...call, ...(this.o.space === undefined ? {} : { space: this.o.space }) });
				if (!r.ok) throw toError(r.error);
				return r.result;
			} catch (e) {
				if (!(e instanceof TransportFailure)) throw e;
				last = e;
			}
		}
		throw onExhausted ? onExhausted() : (last as Error);
	}
	private rawCall(method: Call["method"], args: Record<string, Json> = {}): Promise<Json> { return this.send({ method, args }); }

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
		const request = await this.identity(o);
		return this.send({ method, request, args }, () => new OutcomeUnknown(request, "the transport kept failing"));
	}

	// ---- SpaceLike

	async write(entry: EntryDraft, txn: string | null = null, lease: number = core.ANY, o: Req = {}): Promise<Lease> {
		return (await this.mutate("write", { entry: entry as unknown as Json, txn, leaseMs: leaseArg(lease) }, o)) as unknown as Lease;
	}
	read(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.blocking("read", tmpl, timeout, o, false); }
	readIfExists(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.blocking("read", tmpl, timeout, o, true); }
	take(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.blocking("take", tmpl, timeout, o, false); }
	takeIfExists(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.blocking("take", tmpl, timeout, o, true); }

	private async blocking(method: "read" | "take", tmpl: Template, timeout: number, o: OpOptions, ifExists: boolean): Promise<Taken | null> {
		if (o.once) throw new core.IllegalArgumentError("`once` is a local hook: a remote call keeps its outcome under its request identity instead");
		const request = await this.identity(o);
		const started = this.o.now();
		const timeoutMs = o.deadline !== undefined ? Math.max(0, o.deadline - started) : timeout;
		const args = { template: tmpl as unknown as Json, timeoutMs: leaseArg(timeoutMs), txn: o.txn ?? null, ifExists, waitMs: this.pollMs() };
		const unknown = (why: string) => () => new OutcomeUnknown(request, why);
		let r = (await this.send({ method, request, args }, unknown("the transport kept failing"))) as { state: string; entry?: Taken | null };
		for (;;) {
			if (r.state === "done") return (r.entry ?? null) as Taken | null;
			if (this.o.maxClientWaitMs !== undefined && this.o.now() - started >= this.o.maxClientWaitMs) throw new OutcomeUnknown(request, "the client stopped waiting; the operation continues on the host");
			const view = (await this.send({ method: "pollOperation", args: { targetRequest: request as unknown as Json, waitMs: this.pollMs() } }, unknown("the transport kept failing while polling"))) as unknown as ClaimView;
			if (view.state === "cancelled") throw new claims.OperationCancelled(`request ${request.requestId} was cancelled`);
			if (view.state === "done") return ((view.result ?? null) as unknown as Taken | null);
			r = { state: "pending" };
		}
	}
	private pollMs(): number {
		const left = this.o.maxClientWaitMs;
		return left === undefined ? 25_000 : Math.min(25_000, Math.max(1, left));
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

	notify(): Promise<never> { return Promise.reject(new UnsupportedOperation("notify needs mailboxes (AP 1.6)")); }
	wait(): Promise<never> { return Promise.reject(new UnsupportedOperation("wait needs mailboxes (AP 1.6)")); }

	async readPage(tmpl: Template = null, o: { maxBytes?: number; after?: string | null; txn?: string | null } = {}): Promise<core.Page> {
		await this.info();
		const args = { template: tmpl as unknown as Json, ...(o.maxBytes === undefined ? {} : { maxBytes: o.maxBytes }), cursor: o.after ?? null, txn: o.txn ?? null };
		return (await this.send({ method: "readAll", args })) as unknown as core.Page;
	}
	/** Like the local `readAll`: the first `limit` entries (default and maximum 1000), fetched page by page. */
	async readAll(tmpl: Template = null, o: { limit?: number; txn?: string | null } = {}): Promise<Taken[]> {
		const limit = o.limit ?? core.MAX_LIST;
		if (!Number.isInteger(limit) || limit < 1) throw new core.IllegalArgumentError("limit must be a positive integer");
		const out: Taken[] = [];
		let after: string | null = null;
		do {
			const p: core.Page = await this.readPage(tmpl, { after, txn: o.txn ?? null });
			out.push(...p.items);
			after = p.next;
		} while (after !== null && out.length < Math.min(limit, core.MAX_LIST));
		return out.slice(0, Math.min(limit, core.MAX_LIST));
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
