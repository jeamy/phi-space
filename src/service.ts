// The `space` service (federation-plan-v3.md 6.2, AP 1.8): the methods of a space as one transport-independent function
// from an authenticated call to a reply. No network here. A transport (in-process, unix socket, the gate on the overlay)
// authenticates the connection, hands over the identity it established and the decoded call, and writes the reply back.
// The identity never comes from the call itself: a call cannot name its principal.
//
// Placeholders until the federation stages: `authorityId` and `primaryEpoch` are checked against the configured values
// (a single host is its own authority, epoch 0); `wait`, `notify`, `events` and `ack` need mailboxes (AP 1.6).
import { awaitWithContext } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import * as core from "./core.ts";
import * as claims from "./claims.ts";
import { PiSpaces, type SpaceHost } from "./client.ts";
import { listSpaces, snapshotSpace, spaceDoc, UnknownSpaceError, DEFAULT_ALIAS } from "./spaces.ts";
import type { Principal, RequestRef } from "./claims.ts";
import type { Json } from "./core.ts";

export const PROTOCOL_VERSION = 1;
export const METHODS = ["hello", "generation", "write", "read", "take", "pollOperation", "cancelOperation", "readAll", "count", "stats", "txn", "lease", "changes", "wait", "notify", "events", "ack"] as const;
export type Method = (typeof METHODS)[number];
/** Needs mailboxes (AP 1.6): answered with UnsupportedMethod for now. */
const PENDING_FEATURES: readonly Method[] = ["wait", "notify", "events", "ack"];
const MUTATING: readonly Method[] = ["write", "read", "take", "cancelOperation", "txn", "lease"]; // carry a request identity

// ---- identity and rights

/** What a transport knows about a connection: it fills this in, the identity adapter decides what it means. */
export type Connection = { peerId?: string; overlayIp?: string; credentials?: Json };
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
		member: { methods: ["hello", "generation", "write", "read", "take", "pollOperation", "cancelOperation", "readAll", "count", "stats", "txn", "lease", "changes", "wait", "notify", "events", "ack"] },
		observer: { methods: ["hello", "generation", "read", "pollOperation", "cancelOperation", "readAll", "count", "stats", "changes", "notify", "events", "ack"] }, // own read and notify results, never a write
	},
};

// ---- envelope

export type Call = {
	method: Method;
	/** Stable space id or alias; omitted: the default space. */
	space?: string;
	request?: { generation: string; requestId: string };
	/** The renewable frame; checked on every call, never part of the argument hash. */
	frame?: { authorityId?: string; primaryEpoch?: number };
	args?: Record<string, Json>;
};
export type ErrorCode =
	| "BadRequest" | "Unauthenticated" | "PermissionDenied" | "UnknownSpace" | "UnsupportedMethod" | "UnsupportedProtocol"
	| "AuthorityMismatch" | "StaleEpoch" | "RequestConflict" | "RequestExpired" | "ResultExpired" | "IncarnationChanged" | "OperationCancelled"
	| "ResourceExhausted" | "ResponseBudgetTooSmall" | "SnapshotExpired" | "RevisionAhead" | "TransactionError" | "NotFound" | "Internal";
export type Reply = { ok: true; result: Json } | { ok: false; error: { code: ErrorCode; message: string; requiredBytes?: number } };

export type SpaceServiceOptions = {
	host: SpaceHost;
	ctx: Context;
	identity: IdentityAdapter;
	policy?: Policy;
	now?: () => number;
	authorityId?: string;
	primaryEpoch?: number;
	hostId?: string;
	maxPollMs?: number; // longest wait of a poll (spec: 25 s)
	maxPendingPerPrincipal?: number;
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
	private o: Required<Pick<SpaceServiceOptions, "maxPollMs" | "maxPendingPerPrincipal" | "authorityId" | "primaryEpoch">> & SpaceServiceOptions;
	private policy: Policy;
	private now: () => number;
	private inflight = new Map<string, Promise<unknown>>();

	constructor(o: SpaceServiceOptions) {
		this.o = { maxPollMs: 25_000, maxPendingPerPrincipal: 32, authorityId: "local", primaryEpoch: 0, ...o };
		this.policy = o.policy ?? DEFAULT_POLICY;
		this.now = o.now ?? Date.now;
	}

	/** Decode, check the frame size, dispatch, encode. The size limit is the frame budget of the space (4.2). */
	async handleText(text: string, conn: Connection, maxFrameBytes = core.DEFAULT_LIMITS.maxFrameBytes): Promise<string> {
		if (new TextEncoder().encode(text).length > maxFrameBytes) return JSON.stringify(fail("ResourceExhausted", `a call may take at most ${maxFrameBytes} bytes`));
		let call: unknown;
		try { call = JSON.parse(text); } catch { return JSON.stringify(fail("BadRequest", "the call is not JSON")); }
		const reply = await this.handle(call, conn);
		return JSON.stringify(reply);
	}

	async handle(call: unknown, conn: Connection): Promise<Reply> {
		try {
			if (!isObj(call) || typeof call.method !== "string") throw new Bad("a call is an object with a method");
			if (!(METHODS as readonly string[]).includes(call.method)) return fail("UnsupportedMethod", `unknown method ${call.method}`);
			const method = call.method as Method;
			if (call.args !== undefined && !isObj(call.args)) throw new Bad("args must be an object");
			const args = (call.args ?? {}) as Record<string, Json>;
			const id = await this.o.identity.authenticate(conn);
			if (!id) return fail("Unauthenticated", "the connection has no known identity");
			const grant = this.allowed(id, method);
			const frame = call.frame;
			if (frame !== undefined) {
				if (!isObj(frame)) throw new Bad("frame must be an object");
				if (frame.authorityId !== undefined && frame.authorityId !== this.o.authorityId) return fail("AuthorityMismatch", `this host is authority ${this.o.authorityId}`);
				if (frame.primaryEpoch !== undefined && frame.primaryEpoch !== this.o.primaryEpoch) return fail("StaleEpoch", `the primary epoch is ${this.o.primaryEpoch}`);
			}
			if (PENDING_FEATURES.includes(method)) return fail("UnsupportedMethod", `${method} needs mailboxes, which this host does not have yet`);
			let request: RequestRef | undefined;
			if (MUTATING.includes(method)) {
				const r = call.request;
				if (!isObj(r)) throw new Bad(`${method} needs a request {generation, requestId}`);
				request = { principal: id.principal, generation: str(r.generation, "request.generation"), requestId: str(r.requestId, "request.requestId") };
			}
			const space = call.space === undefined ? undefined : str(call.space, "space");
			const client = new PiSpaces(this.o.host, this.o.ctx, this.now, undefined, principalKey(id.principal), { space: space === DEFAULT_ALIAS ? undefined : space });
			return { ok: true, result: await this.dispatch(method, args, { id, request, client, space, grant }) };
		} catch (e) {
			return this.error(e);
		}
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

	private async dispatch(method: Method, a: Record<string, Json>, c: { id: Identity; request?: RequestRef; client: PiSpaces; space?: string; grant: { types: ReadonlySet<string> | "*" } }): Promise<Json> {
		const { client, request, grant } = c;
		switch (method) {
			case "hello": return this.hello(a, c);
			case "generation": {
				const g = await client.issueGeneration(c.id.principal);
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
			case "cancelOperation": {
				const t = this.target(a.targetRequest, c.id);
				return (await client.cancelOperation(t, { request })) as unknown as Json;
			}
			case "readAll": {
				const t = template(a.template);
				if (grant.types !== "*") this.checkTypes(grant, t?.type ? [t.type] : undefined, "this template");
				const p = await client.readPage(t, { ...(a.maxBytes === undefined ? {} : { maxBytes: int(a.maxBytes, "maxBytes", 1) }), after: (a.cursor as string | null | undefined) ?? null, txn: (a.txn as string | null | undefined) ?? null });
				return p as unknown as Json;
			}
			case "count": {
				const t = template(a.template);
				if (grant.types !== "*") this.checkTypes(grant, t?.type ? [t.type] : undefined, "this template");
				const { rev, streamId } = await client.revision();
				return { value: await client.count(t, (a.txn as string | null | undefined) ?? null), rev, streamId };
			}
			case "stats": {
				const { rev, streamId } = await client.revision();
				return { stats: (await client.stats()) as unknown as Json, rev, streamId };
			}
			case "txn": {
				const action = str(a.action, "action");
				if (action === "begin") return (await client.createTransaction(duration(a.leaseMs, "leaseMs", core.ANY), { request })) as unknown as Json;
				const id = str(a.id, "id");
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
			default: throw new Bad(`${method} is not implemented`);
		}
	}

	private async hello(a: Record<string, Json>, c: { id: Identity; space?: string; client: PiSpaces }): Promise<Json> {
		if (a.protocol !== PROTOCOL_VERSION) throw new UnsupportedProtocol(`this host speaks protocol ${PROTOCOL_VERSION}`);
		const infos = await listSpaces(this.o.host, this.o.ctx);
		let info = infos.find((i) => i.alias === (c.space ?? DEFAULT_ALIAS) || i.spaceId === c.space);
		if (!info && c.space === undefined) { // an untouched session registers its default space on first use
			await this.o.host.commit(async (tx) => { await spaceDoc(tx, undefined, this.now()); }, this.o.ctx);
			info = (await listSpaces(this.o.host, this.o.ctx)).find((i) => i.alias === DEFAULT_ALIAS);
		}
		if (!info) throw new UnknownSpaceError(`unknown space: ${c.space}`);
		const s = await snapshotSpace(this.o.host, info.spaceId, this.o.ctx);
		const lim = core.limitsOf(s ?? core.initialState());
		return {
			protocol: PROTOCOL_VERSION,
			...(this.o.hostId ? { hostId: this.o.hostId } : {}),
			spaceId: info.spaceId, alias: info.alias, incarnation: info.incarnation, streamId: core.streamIdOf(s ?? core.initialState()), rev: core.revision(s ?? core.initialState()),
			authorityId: this.o.authorityId, primaryEpoch: this.o.primaryEpoch, role: "single",
			principal: principalKey(c.id.principal), roles: c.id.roles,
			features: METHODS.filter((m) => !PENDING_FEATURES.includes(m)),
			limits: { maxFrameBytes: lim.maxFrameBytes, maxCommitBytes: lim.maxCommitBytes, maxEventBytes: lim.maxEventBytes, maxEntryBytes: lim.maxEntryBytes, maxPollMs: this.o.maxPollMs },
		} as Json;
	}

	private target(v: unknown, id: Identity): RequestRef {
		if (!isObj(v)) throw new Bad("targetRequest is required");
		return { principal: id.principal, generation: str(v.generation, "targetRequest.generation"), requestId: str(v.requestId, "targetRequest.requestId") };
	}

	/** read/take: `done` with the entry or null, or `pending` while the operation keeps running on the host. */
	private async readTake(method: "read" | "take", a: Record<string, Json>, c: { id: Identity; request?: RequestRef; client: PiSpaces; grant: { types: ReadonlySet<string> | "*" } }): Promise<Json> {
		const { client, request, grant } = c;
		const t = template(a.template);
		if (grant.types !== "*") this.checkTypes(grant, t?.type ? [t.type] : undefined, "this template");
		const timeout = duration(a.timeoutMs, "timeoutMs", core.NO_WAIT);
		const waitMs = Math.min(optInt(a.waitMs, "waitMs", 0) ?? this.o.maxPollMs, this.o.maxPollMs);
		const txn = (a.txn as string | null | undefined) ?? null;
		const key = `${principalKey(c.id.principal)}|${request!.generation}|${request!.requestId}`;
		let run = this.inflight.get(key) as Promise<{ entry: Json | null }> | undefined;
		if (!run) {
			await this.checkPending(client, c.id);
			const opts = { txn, request };
			const op = a.ifExists === true ? (method === "read" ? client.readIfExists(t, timeout, opts) : client.takeIfExists(t, timeout, opts)) : (method === "read" ? client.read(t, timeout, opts) : client.take(t, timeout, opts));
			run = op.then((entry) => ({ entry: entry as unknown as Json | null }));
			this.inflight.set(key, run);
			const done = () => { if (this.inflight.get(key) === run) this.inflight.delete(key); };
			run.then(done, done); // the call may have returned `pending` long ago: nobody else observes a late failure
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let first: { entry: Json | null } | "pending";
		try { first = await Promise.race([run, new Promise<"pending">((res) => { timer = setTimeout(() => res("pending"), waitMs); })]); }
		finally { clearTimeout(timer); } // also when the operation failed: a poll timer must not outlive the call
		if (first === "pending") {
			const view = await client.pollOperation(request!).catch(() => undefined);
			return { state: "pending", ...(view ? { deadline: view.deadline } : {}) };
		}
		return { state: "done", entry: first.entry };
	}

	private async checkPending(client: PiSpaces, id: Identity): Promise<void> {
		const s = await (client as unknown as { snap(): Promise<Readonly<core.SpaceState> | undefined> }).snap();
		let n = 0;
		for (const cl of Object.values(s?.rpc?.claims ?? {})) if (cl.state === "pending" && cl.principal.peerId === id.principal.peerId && cl.principal.agentId === id.principal.agentId) n++;
		if (n >= this.o.maxPendingPerPrincipal) throw new core.ResourceExhausted(`you already have ${n} pending operations`);
	}

	/** The state of an own request; waits up to `waitMs` (at most maxPollMs) for it to leave `pending`. Never extends a deadline. */
	private async poll(a: Record<string, Json>, c: { id: Identity; client: PiSpaces }): Promise<Json> {
		const t = this.target(a.targetRequest, c.id);
		const waitMs = Math.min(optInt(a.waitMs, "waitMs", 0) ?? 0, this.o.maxPollMs);
		const end = this.now() + waitMs;
		for (;;) {
			const v = await c.client.pollOperation(t);
			if (v.state !== "pending" || this.now() >= end) return v as unknown as Json;
			await awaitWithContext(new Promise<void>((res) => setTimeout(res, Math.min(50, Math.max(1, end - this.now())))), this.o.ctx);
		}
	}

	/** Commit batches after a revision; `resync` tells the client to read pages again (history dropped or another stream). */
	private async changes(a: Record<string, Json>, c: { client: PiSpaces; grant: { types: ReadonlySet<string> | "*" } }): Promise<Json> {
		if (c.grant.types !== "*") throw new Denied("the change stream carries every type; it needs a role without type limits");
		const after = int(a.afterRev, "afterRev", 0);
		const waitMs = Math.min(optInt(a.waitMs, "waitMs", 0) ?? 0, this.o.maxPollMs);
		const maxBytes = a.maxBytes === undefined ? undefined : int(a.maxBytes, "maxBytes", 1);
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
		if (e instanceof Bad) return fail("BadRequest", e.message);
		if (e instanceof Denied || e instanceof core.PermissionError) return fail("PermissionDenied", (e as Error).message);
		if (e instanceof UnsupportedProtocol) return fail("UnsupportedProtocol", e.message);
		if (e instanceof UnknownSpaceError) return fail("UnknownSpace", e.message);
		if (e instanceof claims.RequestConflict) return fail("RequestConflict", e.message);
		if (e instanceof claims.RequestExpired) return fail("RequestExpired", e.message);
		if (e instanceof claims.ResultExpired) return fail("ResultExpired", e.message);
		if (e instanceof claims.IncarnationChanged) return fail("IncarnationChanged", e.message);
		if (e instanceof claims.OperationCancelled) return fail("OperationCancelled", e.message);
		if (e instanceof core.ResponseBudgetTooSmall) return fail("ResponseBudgetTooSmall", e.message, { requiredBytes: e.requiredBytes });
		if (e instanceof core.LimitError) return fail("ResourceExhausted", e.message); // includes ResourceExhausted itself
		if (e instanceof core.SnapshotExpired) return fail("SnapshotExpired", e.message);
		if (e instanceof core.RevisionAhead) return fail("RevisionAhead", e.message);
		if (e instanceof core.TransactionError || e instanceof core.UnknownLeaseError) return fail("TransactionError", (e as Error).message);
		if (e instanceof core.IllegalArgumentError || e instanceof TypeError) return fail("BadRequest", (e as Error).message);
		return fail("Internal", e instanceof Error ? e.message : String(e));
	}
}
class UnsupportedProtocol extends Error {}
