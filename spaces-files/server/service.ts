// The filesystem service's store and admission (docs/zanzibar-agent-filesystem-plan.en.md, sections 2 and 6.1): one
// process opens phi-spaces' own SQLite store, which holds an exclusive owner lock beside the file (a second process is
// refused, a crash releases it), runs the reaper and gives each tenant a private named Space reached only through its
// queue. Nothing here serves a Space to anyone: the tenant Spaces are never exposed.
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { openOwnMemoryHost, type OwnStoreHost } from "phi-spaces/store/host";
import { openSqliteHost } from "phi-spaces/store/sqlite";
import { createSpace, listSpaces, PhiSpaces, startService } from "phi-spaces";
import { DEFAULT_LIMITS, FOREVER, UniqueConflict } from "phi-spaces/core";
import { assertLimitsFit, assertRowFits, DEFAULT_FS_LIMITS, encodedBytes, type FsLimits } from "./limits.ts";
import { checkQuotas, sumContentBytes, type Demand } from "./quotas.ts";
import { Admission, Unavailable, type AdmissionOptions } from "./admission.ts";
import { DeploymentState, type DeploymentOptions } from "./deployment.ts";
import { BlobStore } from "./blobs.ts";
import { issueOperationIds, verifyOperationId, type VerifiedOpId } from "./opids.ts";
import { lookupReceipt, receiptRow, reserveReceipt, type Outcome } from "./receipts.ts";
import { checkContents, parsePath, pathString } from "./paths.ts";
import { contentDigest, requestDigest } from "./digest.ts";
import { atLeast, checkGrant, checkLastOwner, checkMembership, childNamed, resolve, spaceData, subjectRow, type NodeRow, type RelRow, type Subject } from "./policy.ts";
import type { BlobRef } from "./blobs.ts";
import { assertSeparateDirs, prepareDataDir } from "./dirs.ts";
import * as schema from "./schema.ts";
import { InconsistentState } from "./schema.ts";

export { prepareDataDir } from "./dirs.ts";

/** The store file inside the data directory. */
export const STORE_FILE = "files.sqlite";

/** A tenant ID: 1 to 62 of a-z 0-9 _ - starting with a letter or digit, so that its Space alias `t-<id>` is valid. */
const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,61}$/;

export class InvalidTenant extends Error {
	readonly code = "invalidInput";
	constructor(id: unknown) { super(`invalid tenant ID ${JSON.stringify(id)}`); this.name = "InvalidTenant"; }
}

/** The tenant Space exists but its initialization has not committed: no session and no regular operation (section 2). */
export class TenantProvisioning extends Unavailable {
	constructor(tenantId: string) { super(`tenant ${tenantId} is not initialized`); this.name = "TenantProvisioning"; }
}

export { InconsistentState } from "./schema.ts";

/** The first administrator of a new tenant, as the host operator supplies it: a user with its verified identity. */
export type FirstAdmin = { actorId: string; homeName: string; issuer: string; subject: string };
export type CreateTenantResult =
	| { status: "created"; tenantId: string; actorId: string; homeNodeId: string }
	| { status: "alreadyExists"; tenantId: string };

export type Actor = { actorKind: schema.ActorKind; actorId: string; homeNodeId: string };
/** What an operation learns about its caller once the session and the actor have been checked. */
export type Session = Actor & { tenantId: string; expiresAt: number };

export function tenantAlias(tenantId: string): string {
	if (typeof tenantId !== "string" || !TENANT_ID.test(tenantId)) throw new InvalidTenant(tenantId);
	return `t-${tenantId}`;
}

export type FilesServiceOptions = AdmissionOptions & {
	/** The data directory; `null` keeps everything in memory (tests). */
	dataDir: string | null;
	/** The deployment-state directory (section 6.6), never inside the data directory or around it; `null`: in memory. */
	stateDir: string | null;
	/** The blob directory (section 3, *Contents*), apart from both; `null`: in memory. */
	blobDir: string | null;
	now?: () => number;
	state?: Omit<DeploymentOptions, "dir">;
	/** The filesystem's limits (section 3); checked against the tenant Spaces' limits on open. */
	limits?: Partial<FsLimits>;
	/** The lease of a save's transaction: after a crash, its reservation lapses this long after it began (default 10 s). */
	saveTxnLeaseMs?: number;
	/** Tests only: called at the named points of a save (section 6.3), to inject a failure or a crash there. */
	faultHook?: (point: FaultPoint) => void | Promise<void>;
};

/** Where a save can be interrupted: before the blob write, between it and the commit, around the commit call (its
 *  outcome then is unknown), and after the commit before the old blob's deletion. */
export type FaultPoint = "beforeBlob" | "afterBlob" | "commit:before" | "commit:after" | "afterCommit";

/** What `#admitRows` checks a mutation's budgets for. */
type AdmitSpec = { id: VerifiedOpId | null; operation: string; targets: string[]; rows: ReturnType<typeof schema.meta>[]; demand?: Demand; replaced?: ReturnType<typeof schema.meta>[]; pool?: "ordinary" | "security" };

/** A directory entry as `list` returns it. */
export type ListEntry = { name: string; kind: "dir" | "file" };

/** A mutation whose commit outcome is unknown, until `resolveOutcomes` aborts its transaction (section 6.1); a save also
 *  names the blobs the content row then decides between. */
type Unresolved = { tenantId: string; txn: string; save: { nodeId: string; newBlobId: string; oldBlobId: string | null } | null };

export class FilesService {
	readonly admission: Admission;
	readonly host: OwnStoreHost;
	readonly storePath: string | null;
	readonly state: DeploymentState;
	readonly blobs: BlobStore;
	readonly limits: FsLimits;
	readonly #stopService: () => Promise<void>;
	readonly #now: () => number;
	/** Tenants whose FsMeta this process has seen committed; FsMeta is never removed while the store is open. */
	readonly #ready = new Set<string>();
	/** The highest FsAudit seq per tenant, read once when the tenant is first written after opening (section 3). */
	readonly #seq = new Map<string, number>();
	/** The content bytes per tenant (the sum of the content rows' size), summed once and then kept by the writer. */
	readonly #contentBytes = new Map<string, number>();
	readonly #unresolved: Unresolved[] = [];
	/** Tenants checked, once per process, for transaction state left by an earlier process (section 6.1). */
	readonly #settled = new Set<string>();
	readonly #saveLeaseMs: number;
	readonly #fault: (point: FaultPoint) => void | Promise<void>;
	#closed = false;

	private constructor(host: OwnStoreHost, state: DeploymentState, blobs: BlobStore, stopService: () => Promise<void>, storePath: string | null, o: FilesServiceOptions) {
		this.host = host;
		this.state = state;
		this.blobs = blobs;
		this.storePath = storePath;
		this.#stopService = stopService;
		this.admission = new Admission(o);
		this.#now = o.now ?? Date.now;
		this.limits = { ...DEFAULT_FS_LIMITS, ...o.limits };
		this.#fault = o.faultHook ?? (() => {});
		this.#saveLeaseMs = o.saveTxnLeaseMs ?? 10_000;
	}

	static async open(o: FilesServiceOptions): Promise<FilesService> {
		const blobDir = o.blobDir;
		assertSeparateDirs({ data: o.dataDir, "deployment-state": o.stateDir, blob: blobDir });
		// the tenant Spaces run with the default Space limits
		assertLimitsFit({ ...DEFAULT_FS_LIMITS, ...o.limits }, DEFAULT_LIMITS);
		// the deployment state first: it decides about sessions and keys before any tenant is served
		const state = await DeploymentState.open({ clock: o.now, ...o.state, dir: o.stateDir });
		let host: OwnStoreHost | undefined, storePath: string | null = null, service: FilesService;
		try {
			const blobs = await BlobStore.open(blobDir, state);
			if (o.dataDir === null) host = openOwnMemoryHost();
			else {
				await prepareDataDir(o.dataDir);
				storePath = join(o.dataDir, STORE_FILE);
				host = await openSqliteHost(storePath);
			}
			// the reaper clears reservations of transactions abandoned by a crash (section 6.1)
			const stop = await startService(host, ctx, { now: o.now, watchDebounceMs: 50 });
			service = new FilesService(host, state, blobs, stop, storePath, o);
		} catch (e) { await host?.close(ctx); state.close(); throw e; }
		// the login index is a lookup aid derived from the FsActor rows: rebuilt on every start (section 6.6)
		try { await service.rebuildLoginIndex(); } catch (e) { await service.close(); throw e; }
		// a tenant closed for a pending security action stays closed across restarts (section 6.6); the index above is
		// only a lookup aid and is rebuilt for it too
		for (const c of state.closedTenants()) service.admission.suspend(c.tenantId, c.reason);
		return service;
	}

	/**
	 * Runs `op` in the tenant's queue with that tenant's private Space, once its initialization has committed (section 2).
	 * An `inconsistentState` suspends the tenant until operator repair (section 4); the other tenants keep running.
	 */
	inTenant<T>(tenantId: string, op: (space: PhiSpaces) => Promise<T>): Promise<T> {
		return this.#inSpace(tenantId, async (space) => {
			try {
				if (!this.#ready.has(tenantId)) {
					if (!(await this.#checkMeta(tenantId, space))) throw new TenantProvisioning(tenantId);
					this.#ready.add(tenantId);
				}
				if (!this.#settled.has(tenantId)) {
					// a save of an earlier process may still hold a content row: until its lease lapses and the reaper
					// returns the row, a read would miss it. The tenant starts closed and resolves that first.
					const st = await space.stats();
					if (st.txns > 0 || st.locked > 0 || st.uncommitted > 0) throw new Unavailable(`tenant ${tenantId} waits for transactions of an earlier process to lapse`, this.#saveLeaseMs);
					this.#settled.add(tenantId);
				}
				return await op(space);
			} catch (e) {
				if (e instanceof InconsistentState) {
					// the diagnostic names IDs and kinds only (the error messages are written so), never names or contents
					console.error(`[files] tenant ${tenantId} suspended: ${e.message}`);
					this.admission.suspend(tenantId, "inconsistentState");
				}
				throw e;
			}
		});
	}

	/** The queue without the provisioning gate: only for provisioning and startup. */
	#inSpace<T>(tenantId: string, op: (space: PhiSpaces) => Promise<T>): Promise<T> {
		const alias = tenantAlias(tenantId);
		return this.admission.run(tenantId, () => op(new PhiSpaces(this.host, ctx, this.#now, undefined, undefined, { space: alias })));
	}

	/** Whether the tenant's FsMeta has committed; refuses a version this service does not know. */
	async #checkMeta(tenantId: string, space: PhiSpaces): Promise<boolean> {
		const m = await space.readIfExists({ type: schema.T.meta }, 0);
		if (m === null) return false;
		const f = m.fields;
		if (f.tenantId !== tenantId || f.schemaVersion !== schema.SCHEMA_VERSION || f.formatVersion !== schema.FORMAT_VERSION)
			throw new InconsistentState(`tenant ${tenantId}: unknown FsMeta ${JSON.stringify(f)}`);
		return true;
	}

	/** Reserves the tenant's named Space (the first of the two commits of tenant initialization, section 2). Idempotent. */
	reserveTenantSpace(tenantId: string): Promise<{ spaceId: string; alias: string }> {
		const alias = tenantAlias(tenantId);
		return this.admission.run(tenantId, async () => {
			const info = await this.host.commit((tx) => createSpace(tx, alias, this.#now()), ctx);
			return { spaceId: info.spaceId, alias: info.alias };
		});
	}

	/**
	 * Creates a tenant, or resumes its initialization (a host-operator operation, section 2): the named Space is reserved
	 * in one commit, then FsMeta, the first administrator's FsActor and home root, its `tenant#admin` relation, the
	 * home's direct owner relation and the first FsAudit row commit together in a second one. Until then the tenant
	 * admits nothing. Once FsMeta has committed, a repeat answers `alreadyExists` and changes nothing. The login-index
	 * entry follows the commit; startup rebuilds the index should the process die in between (section 6.6).
	 */
	async createTenant(tenantId: string, admin: FirstAdmin): Promise<CreateTenantResult> {
		tenantAlias(tenantId);
		const id = schema.actorId(admin.actorId);
		const homeName = schema.canonicalName(admin.homeName, this.limits.maxNameBytes);
		const identity = { issuer: schema.identityPart(admin.issuer, "issuer"), subject: schema.identityPart(admin.subject, "subject") };
		await this.reserveTenantSpace(tenantId);
		const r = await this.#inSpace(tenantId, async (space): Promise<CreateTenantResult> => {
			if (await this.#checkMeta(tenantId, space)) return { status: "alreadyExists", tenantId };
			// a Space in provisioning holds nothing yet: the batch below would refuse leftovers by their keys anyway
			if ((await space.count(null)) !== 0) throw new InconsistentState(`tenant ${tenantId}: rows in a Space without FsMeta`);
			const homeNodeId = schema.newNodeId();
			await this.#writeAll(tenantId, space, [
				schema.meta(tenantId),
				schema.actor("user", id, homeNodeId, identity),
				schema.node(homeNodeId, schema.WORKSPACES, homeName, "dir"),
				schema.relation("tenant", tenantId, "admin", "user", id),
				schema.relation("node", homeNodeId, "owner", "user", id),
				schema.audit(1, this.state.now(), { kind: "operator", id: "" }, "createTenant", [homeNodeId], "", "ok"),
			]);
			this.#ready.add(tenantId);
			this.#seq.set(tenantId, 1);
			return { status: "created", tenantId, actorId: id, homeNodeId };
		});
		if (r.status === "created") this.state.addLogin(identity.issuer, identity.subject, tenantId);
		return r;
	}

	/**
	 * Registers an actor (an admin operation, section 5): the enabled FsActor, its private home root and the home's first
	 * direct owner relation commit in one transaction together with the audit row, then a user's tenant goes into the
	 * login index. `by` is the calling administrator, which must be an enabled user holding `tenant#admin`. An existing
	 * (kind, actorId) (tombstones included: IDs are never reused), home name or identity pair gives `alreadyExists` and
	 * creates nothing. Operation IDs and receipts arrive with phase 3.
	 */
	async registerActor(tenantId: string, by: { actorKind: schema.ActorKind; actorId: string }, kind: schema.ActorKind, actorId: string, homeName: string, identity: schema.UserIdentity | schema.AgentIdentity): Promise<{ actorId: string; homeNodeId: string }> {
		const ident = schema.identityOf(kind, identity);
		const id = schema.actorId(actorId);
		const name = schema.canonicalName(homeName, this.limits.maxNameBytes);
		const r = await this.inTenant(tenantId, async (space) => {
			const caller = await this.#enabledActor(space, by.actorKind, by.actorId);
			if (caller.fields.actorKind !== "user" || !(await this.#has(space, schema.relation("tenant", tenantId, "admin", "user", by.actorId))))
				throw new schema.PermissionDenied("registerActor needs tenant#admin");
			if (await space.readIfExists({ type: schema.T.actor, fields: { actorKind: kind, actorId: id } }, 0)) throw new schema.AlreadyExists(`actor ${kind}:${id} exists`);
			if (await space.readIfExists({ type: schema.T.node, fields: { parentId: schema.WORKSPACES, name } }, 0)) throw new schema.AlreadyExists("a workspace of that name exists");
			if (await space.readIfExists(schema.identityTemplate(kind, ident), 0)) throw new schema.AlreadyExists("that identity is bound to another actor");
			const homeNodeId = await this.#freshNodeId(space);
			const seq = (await this.#lastSeq(tenantId, space)) + 1;
			const rows = [
				schema.actor(kind, id, homeNodeId, ident),
				schema.node(homeNodeId, schema.WORKSPACES, name, "dir"),
				schema.relation("node", homeNodeId, "owner", kind, id),
			];
			// the audit row draws on the reserve (section 3, budgets); the rows it records count against the tenant's bytes
			await checkQuotas(space, this.limits, { actors: 1, workspaces: 1, nodes: 1, relations: 1, storedBytes: rows.reduce((n, r) => n + encodedBytes(r.fields), 0) }, 0);
			await this.#writeAll(tenantId, space, [...rows,
				schema.audit(seq, this.state.now(), { kind: by.actorKind, id: by.actorId }, "registerActor", [homeNodeId], "", "ok"),
			]);
			this.#seq.set(tenantId, seq);
			return { actorId: id, homeNodeId };
		});
		if (kind === "user") this.state.addLogin((ident as schema.UserIdentity).issuer, (ident as schema.UserIdentity).subject, tenantId);
		return r;
	}

	/** The enabled actor bound to a verified identity in a tenant, or `unauthenticated` (unknown, disabled, deleted). */
	findActor(tenantId: string, kind: schema.ActorKind, identity: schema.UserIdentity | schema.AgentIdentity): Promise<Actor> {
		const ident = schema.identityOf(kind, identity);
		return this.inTenant(tenantId, async (space) => {
			const a = await space.readIfExists(schema.identityTemplate(kind, ident), 0);
			if (a === null || a.fields.state !== "enabled") throw new schema.Unauthenticated();
			return { actorKind: kind, actorId: a.fields.actorId as string, homeNodeId: a.fields.homeNodeId as string };
		});
	}

	/**
	 * Opens a session for a verified identity (section 2): the identity must resolve to an enabled actor of an initialized
	 * tenant, checked inside that tenant's queue; the handle and its binding go into the deployment state. The caller (an
	 * adapter) has verified the identity: an OIDC login for users, the enrolled host peer's frame for agents. A tenant in
	 * provisioning gives `unavailable`, an unknown or disabled actor `unauthenticated`.
	 */
	async login(tenantId: string, kind: schema.ActorKind, identity: schema.UserIdentity | schema.AgentIdentity): Promise<{ handle: string; expiresAt: number; actor: Actor }> {
		const actor = await this.findActor(tenantId, kind, identity);
		const { handle, expiresAt } = this.state.createSession({ tenantId, actorKind: actor.actorKind, actorId: actor.actorId });
		return { handle, expiresAt, actor };
	}

	/**
	 * Runs `op` for the session behind `handle`, in the order of checks of section 5: the handle is authenticated against
	 * the deployment state outside every queue (missing, expired, logged out or from an old epoch -> `unauthenticated`;
	 * only this step selects the tenant), then the request enters the tenant's queue (full or suspended ->
	 * `unavailable`), and inside it the actor's current FsActor state is checked (unknown, disabled or deleted ->
	 * `unauthenticated`). A request without a valid handle never reaches a tenant queue.
	 */
	async withSession<T>(handle: unknown, op: (session: Session, space: PhiSpaces) => Promise<T>): Promise<T> {
		const view = typeof handle === "string" ? this.state.lookupSession(handle) : null;
		if (view === null) throw new schema.Unauthenticated();
		return this.inTenant(view.tenantId, async (space) => {
			const a = await this.#enabledActor(space, view.actorKind, view.actorId);
			return op({ tenantId: view.tenantId, actorKind: view.actorKind, actorId: view.actorId, homeNodeId: a.fields.homeNodeId as string, expiresAt: view.expiresAt }, space);
		});
	}

	/**
	 * Signs `count` operation IDs for the session's actor (section 5, `issueOperationIds`): a valid session suffices, and
	 * the call writes nothing but the time floor. A count outside 1..maxOperationIdsPerCall is `invalidInput`.
	 */
	issueOperationIds(handle: unknown, count: unknown): Promise<string[]> {
		return this.withSession(handle, async (s) => issueOperationIds(this.state, s, count, this.limits));
	}

	// ---------------------------------------------------------------- file operations (section 5)

	/** The workspaces whose root the session's actor can view, in name order; bounded like `list`. */
	workspaces(handle: unknown): Promise<string[]> {
		return this.withSession(handle, async (s, space) => {
			const roots = await space.readAll({ type: schema.T.node, fields: { parentId: schema.WORKSPACES } }, { limit: this.limits.maxWorkspaces + 1 });
			if (roots.length > this.limits.maxWorkspaces) throw new schema.CapacityExceeded(`more than ${this.limits.maxWorkspaces} workspaces`);
			const d = spaceData(space), out: string[] = [];
			for (const r of roots) {
				try { await resolve(d, s, r.fields.name as string, [], { limits: this.limits }); out.push(r.fields.name as string); }
				catch (e) { if (!(e instanceof schema.NotFound)) throw e; }
			}
			return out.sort(byName);
		});
	}

	/** The immediate children of a visible directory, in name order (viewer on it). No partial listing. */
	list(handle: unknown, workspace: unknown, path: unknown): Promise<ListEntry[]> {
		return this.withSession(handle, async (s, space) => {
			const ws = schema.canonicalName(workspace, this.limits.maxNameBytes);
			const segs = parsePath(path, "list", this.limits);
			const r = await resolve(spaceData(space), s, ws, segs, { limits: this.limits });
			if (r.node.kind !== "dir") throw new schema.InvalidInput("list needs a directory");
			const kids = await space.readAll({ type: schema.T.node, fields: { parentId: r.node.nodeId } }, { limit: this.limits.maxDirEntries + 1 });
			if (kids.length > this.limits.maxDirEntries) throw new schema.CapacityExceeded(`a directory holds more than ${this.limits.maxDirEntries} entries`);
			return kids.map((k) => ({ name: k.fields.name as string, kind: k.fields.kind as "dir" | "file" })).sort((a, b) => byName(a.name, b.name));
		});
	}

	/** A file's bytes and version, from the same ordered operation (viewer on the file). The whole blob is read and
	 *  authenticated inside the queue slot, so no later save can delete it under the reader (section 6.1). */
	read(handle: unknown, workspace: unknown, path: unknown): Promise<{ bytes: Buffer; version: number }> {
		return this.withSession(handle, async (s, space) => {
			const ws = schema.canonicalName(workspace, this.limits.maxNameBytes);
			const segs = parsePath(path, "read", this.limits);
			const r = await resolve(spaceData(space), s, ws, segs, { limits: this.limits });
			if (r.node.kind !== "file") throw new schema.InvalidInput("read needs a file");
			const row = await this.#contentRow(s.tenantId, space, r.node);
			return { bytes: await this.blobs.get({ tenantId: s.tenantId, nodeId: r.node.nodeId, version: row.version }, row.ref), version: row.version };
		});
	}

	/**
	 * Creates exactly one directory (editor on the parent; creation branch of section 5). An existing child of either kind
	 * is `alreadyExists`; no parent is created implicitly. A retry with the same operation ID answers from its receipt.
	 */
	mkdir(handle: unknown, workspace: unknown, path: unknown, operationId: unknown): Promise<{ status: "created" }> {
		return this.withSession(handle, async (s, space) => {
			const ws = schema.canonicalName(workspace, this.limits.maxNameBytes);
			const segs = parsePath(path, "mkdir", this.limits);
			const id = verifyOperationId(this.state, s, operationId, this.limits);
			const parent = await this.#creationParent(s, space, ws, segs);
			const digest = requestDigest("mkdir", { workspace: ws, path: pathString(segs) });
			if (await lookupReceipt(space, s, id.operationId, digest)) return { status: "created" as const };
			const name = segs[segs.length - 1];
			if (await childNamed(spaceData(space), parent.nodeId, name)) throw new schema.AlreadyExists("a child of that name exists");
			const nodeId = await this.#freshNodeId(space);
			const rows = [schema.node(nodeId, parent.nodeId, name, "dir"), receiptRow(s, id, digest, {})];
			await this.#admitRows(s, space, { id, operation: "mkdir", targets: [nodeId], rows, demand: { nodes: 1, dirEntries: { parentId: parent.nodeId, n: 1 } } });
			await this.#commitMutation(s, space, id, "mkdir", [nodeId], rows, null);
			return { status: "created" as const };
		});
	}

	/**
	 * Saves a file (section 6.3). `expectedVersion` 0 creates it (editor on the parent; an existing file answers
	 * `versionConflict` with its version, a directory `alreadyExists`); a positive one replaces that version of an
	 * existing file (editor on it; a stale version is `versionConflict` with the current one). The receipt is checked
	 * before the version, so a retry after a lost reply recovers the committed version instead of a conflict. Every
	 * check runs before the blob is written; the old blob is deleted only after the commit.
	 */
	write(handle: unknown, workspace: unknown, path: unknown, bytes: unknown, expectedVersion: unknown, operationId: unknown): Promise<{ version: number }> {
		return this.withSession(handle, async (s, space) => {
			const ws = schema.canonicalName(workspace, this.limits.maxNameBytes);
			const segs = parsePath(path, "write", this.limits);
			const data = checkContents(bytes, this.limits);
			if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0) throw new schema.InvalidInput("expectedVersion must be a non-negative integer");
			const expected = expectedVersion as number;
			const id = verifyOperationId(this.state, s, operationId, this.limits);
			const digest = requestDigest("write", { workspace: ws, path: pathString(segs), contents: contentDigest(data), expectedVersion: expected });
			const d = spaceData(space);
			const replay = (o: Outcome) => ({ version: o.version as number });

			if (expected === 0) {
				const parent = await this.#creationParent(s, space, ws, segs);
				const done = await lookupReceipt(space, s, id.operationId, digest);
				if (done) return replay(done);
				const name = segs[segs.length - 1];
				const existing = await childNamed(d, parent.nodeId, name);
				if (existing?.kind === "dir") throw new schema.AlreadyExists("a directory of that name exists");
				// editor on the parent is inherited by the file: the caller may learn its version
				if (existing) throw new schema.VersionConflict((await this.#contentRow(s.tenantId, space, existing)).version);
				const nodeId = await this.#freshNodeId(space);
				const fresh = (ref: BlobRef) => [schema.node(nodeId, parent.nodeId, name, "file"), schema.content(nodeId, 1, ref), receiptRow(s, id, digest, { version: 1 })];
				await this.#admitRows(s, space, { id, operation: "write", targets: [nodeId], rows: fresh(this.#sizing(data.length)), demand: { nodes: 1, dirEntries: { parentId: parent.nodeId, n: 1 }, contentBytes: data.length } });
				await this.#fault("beforeBlob");
				const ref = await this.blobs.put({ tenantId: s.tenantId, nodeId, version: 1 }, data);
				await this.#commitMutation(s, space, id, "write", [nodeId], fresh(ref), { nodeId, newBlobId: ref.blobId, oldBlobId: null, contentDelta: data.length });
				return { version: 1 };
			}

			const r = await resolve(d, s, ws, segs, { limits: this.limits });
			if (r.node.kind !== "file") throw new schema.InvalidInput("write with a positive version needs a file");
			if (!atLeast(r.role, "editor")) throw new schema.PermissionDenied("write needs editor on the file");
			const done = await lookupReceipt(space, s, id.operationId, digest);
			if (done) return replay(done);
			const cur = await this.#contentRow(s.tenantId, space, r.node);
			if (cur.version !== expected) throw new schema.VersionConflict(cur.version);
			const version = expected + 1, nodeId = r.node.nodeId;
			const rows = (ref: BlobRef) => [schema.content(nodeId, version, ref), receiptRow(s, id, digest, { version })];
			await this.#admitRows(s, space, { id, operation: "write", targets: [nodeId], rows: rows(this.#sizing(data.length)), demand: { contentBytes: data.length - cur.ref.size }, replaced: [schema.content(nodeId, expected, cur.ref)] });
			await this.#fault("beforeBlob");
			const ref = await this.blobs.put({ tenantId: s.tenantId, nodeId, version }, data);
			await this.#commitMutation(s, space, id, "write", [nodeId], rows(ref), { nodeId, newBlobId: ref.blobId, oldBlobId: cur.ref.blobId, contentDelta: data.length - cur.ref.size, replace: { version: expected, blobId: cur.ref.blobId } });
			return { version };
		});
	}

	// ---------------------------------------------------------------- grants and memberships (sections 4 and 5)

	/** Lists the direct relation tuples on a target, in a deterministic order (owner on it). Bounded, no partial list. */
	listGrants(handle: unknown, workspace: unknown, path: unknown): Promise<Array<{ relation: string; subject: Subject }>> {
		return this.withSession(handle, async (s, space) => {
			const ws = schema.canonicalName(workspace, this.limits.maxNameBytes);
			const segs = parsePath(path, "listGrants", this.limits);
			const r = await resolve(spaceData(space), s, ws, segs, { limits: this.limits });
			if (!atLeast(r.role, "owner")) throw new schema.PermissionDenied("listGrants needs owner on the target");
			const rels = await space.readAll({ type: schema.T.relation, fields: { objectKind: "node", objectId: r.node.nodeId } }, { limit: this.limits.maxGrantsPerTarget + 1 });
			if (rels.length > this.limits.maxGrantsPerTarget) throw new schema.CapacityExceeded(`more than ${this.limits.maxGrantsPerTarget} grants on one target`);
			return rels.map((e) => e.fields as unknown as RelRow).map((x) => ({ relation: x.relation, subject: subjectOf(x) }))
				.sort((a, b) => byName(a.relation, b.relation) || byName(a.subject.kind, b.subject.kind) || byName(a.subject.id, b.subject.id));
		});
	}

	/**
	 * Adds (`grant`) or removes (`revoke`) one direct tuple on a target (owner on it, section 5). A grant is validated
	 * (shape, no redundant viewer below the root, an existing non-deleted subject); an identical existing grant, like a
	 * revoke of an absent tuple, succeeds idempotently with a receipt and audit row. A revoke preserves the final owner
	 * and draws on the security reserve: if even that is full, the tenant closes until the operator completes it.
	 */
	grant(handle: unknown, workspace: unknown, path: unknown, relation: unknown, subject: unknown, operationId: unknown): Promise<{ status: "granted" | "unchanged" }> {
		return this.#putGrant("grant", handle, workspace, path, relation, subject, operationId) as Promise<{ status: "granted" | "unchanged" }>;
	}
	revoke(handle: unknown, workspace: unknown, path: unknown, relation: unknown, subject: unknown, operationId: unknown): Promise<{ status: "revoked" | "unchanged" }> {
		return this.#putGrant("revoke", handle, workspace, path, relation, subject, operationId) as Promise<{ status: "revoked" | "unchanged" }>;
	}

	#putGrant(op: "grant" | "revoke", handle: unknown, workspace: unknown, path: unknown, relation: unknown, subject: unknown, operationId: unknown): Promise<{ status: string }> {
		return this.withSession(handle, async (s, space) => {
			const ws = schema.canonicalName(workspace, this.limits.maxNameBytes);
			const segs = parsePath(path, op, this.limits);
			if (relation !== "owner" && relation !== "editor" && relation !== "viewer") throw new schema.InvalidInput(`unknown relation ${JSON.stringify(relation)}`);
			const subj = parseSubject(subject, this.limits.maxNameBytes);
			const id = verifyOperationId(this.state, s, operationId, this.limits);
			const d = spaceData(space);
			const r = await resolve(d, s, ws, segs, { limits: this.limits });
			if (!atLeast(r.role, "owner")) throw new schema.PermissionDenied(`${op} needs owner on the target`);
			const digest = requestDigest(op, { workspace: ws, path: pathString(segs), relation, subject: subjectRow(subj) });
			const done = await lookupReceipt(space, s, id.operationId, digest);
			if (done) return { status: done.status as string };
			const target = r.node.nodeId;
			const tuple: RelRow = op === "grant" ? await checkGrant(d, r.node, relation, subj) : { objectKind: "node", objectId: target, relation, ...subjectRow(subj) };
			const present = await this.#has(space, schema.relation("node", target, tuple.relation, tuple.subjectKind, tuple.subjectId, tuple.subjectRelation));
			if (op === "grant") {
				const status = present ? "unchanged" : "granted";
				const rows = [...(present ? [] : [schema.relation("node", target, tuple.relation, tuple.subjectKind, tuple.subjectId, tuple.subjectRelation)]), receiptRow(s, id, digest, { status })];
				await this.#admitRows(s, space, { id, operation: op, targets: [target], rows, demand: present ? {} : { relations: 1, grantsOn: { nodeId: target, n: 1 }, groups: tuple.subjectKind === "group" ? [tuple.subjectId] : [] } });
				await this.#commitMutation(s, space, id, op, [target], rows, null);
				return { status };
			}
			if (!present) {
				const rows = [receiptRow(s, id, digest, { status: "unchanged" })];
				await this.#admitRows(s, space, { id, operation: op, targets: [target], rows });
				await this.#commitMutation(s, space, id, op, [target], rows, null);
				return { status: "unchanged" };
			}
			if (r.node.parentId === schema.WORKSPACES) await checkLastOwner(d, target, { remove: [tuple] }, { limits: this.limits });
			const rows = [receiptRow(s, id, digest, { status: "revoked" })];
			await this.#securityAdmit(s, space, { id, operation: op, targets: [target], rows }, { operation: op, target, relation: tuple.relation, subject: subjectRow(subj) });
			await this.#commitMutation(s, space, id, op, [target], rows, null, [{ type: schema.T.relation, fields: { ...tuple } }]);
			return { status: "revoked" };
		});
	}

	/**
	 * Adds or removes one group membership (an admin operation: an enabled `tenant#admin` user, section 5). Both are
	 * idempotent; adding validates the subject (an existing non-deleted user or agent, no nested groups). Removing a
	 * present membership is a security action on the security reserve. A caller without `tenant#admin` is refused with
	 * `permissionDenied`, and the refusal is audited in a transaction of its own (section 3).
	 */
	addMember(handle: unknown, group: unknown, subject: unknown, operationId: unknown): Promise<{ status: "added" | "unchanged" }> {
		return this.#putMember("addMember", handle, group, subject, operationId) as Promise<{ status: "added" | "unchanged" }>;
	}
	removeMember(handle: unknown, group: unknown, subject: unknown, operationId: unknown): Promise<{ status: "removed" | "unchanged" }> {
		return this.#putMember("removeMember", handle, group, subject, operationId) as Promise<{ status: "removed" | "unchanged" }>;
	}

	#putMember(op: "addMember" | "removeMember", handle: unknown, group: unknown, subject: unknown, operationId: unknown): Promise<{ status: string }> {
		return this.withSession(handle, async (s, space) => {
			const g = schema.groupId(group, this.limits.maxNameBytes);
			const subj = parseSubject(subject, this.limits.maxNameBytes);
			if (subj.kind === "group") throw new schema.InvalidInput("groups have no nested groups in the pilot");
			const id = verifyOperationId(this.state, s, operationId, this.limits);
			await this.#requireAdmin(s, space, op, id);
			const d = spaceData(space);
			const digest = requestDigest(op, { group: g, subject: subjectRow(subj) });
			const done = await lookupReceipt(space, s, id.operationId, digest);
			if (done) return { status: done.status as string };
			const tuple: RelRow = op === "addMember" ? await checkMembership(d, g, subj) : { objectKind: "group", objectId: g, relation: "member", ...subjectRow(subj) };
			const row = schema.relation("group", g, "member", tuple.subjectKind, tuple.subjectId);
			const present = await this.#has(space, row);
			if (op === "addMember") {
				const status = present ? "unchanged" : "added";
				const rows = [...(present ? [] : [row]), receiptRow(s, id, digest, { status })];
				await this.#admitRows(s, space, { id, operation: op, targets: [], rows, demand: present ? {} : { relations: 1, groups: [g] } });
				await this.#commitMutation(s, space, id, op, [], rows, null);
				return { status };
			}
			const status = present ? "removed" : "unchanged";
			const rows = [receiptRow(s, id, digest, { status })];
			if (present) await this.#securityAdmit(s, space, { id, operation: op, targets: [], rows }, { operation: op, group: g, subject: subjectRow(subj) });
			else await this.#admitRows(s, space, { id, operation: op, targets: [], rows });
			await this.#commitMutation(s, space, id, op, [], rows, null, present ? [{ type: schema.T.relation, fields: { ...tuple } }] : []);
			return { status };
		});
	}

	/**
	 * Creates an additional workspace root with its first enabled direct user or agent owner in one transaction (an admin
	 * operation, section 5). An existing workspace name is `alreadyExists`; an unknown, deleted or disabled owner, or a
	 * group, is `invalidInput`. The administrator gains no file rights by it.
	 */
	createWorkspace(handle: unknown, name: unknown, owner: unknown, operationId: unknown): Promise<{ nodeId: string }> {
		return this.withSession(handle, async (s, space) => {
			const ws = schema.canonicalName(name, this.limits.maxNameBytes);
			const o = parseSubject(owner, this.limits.maxNameBytes);
			if (o.kind === "group") throw new schema.InvalidInput("the first owner of a workspace is a user or an agent");
			const id = verifyOperationId(this.state, s, operationId, this.limits);
			await this.#requireAdmin(s, space, "createWorkspace", id);
			const digest = requestDigest("createWorkspace", { workspace: ws, owner: subjectRow(o) });
			const done = await lookupReceipt(space, s, id.operationId, digest);
			if (done) return { nodeId: done.nodeId as string };
			const a = await spaceData(space).actor(o.kind, o.id);
			if (a?.state !== "enabled") throw new schema.InvalidInput("the owner must be an enabled actor");
			if (await childNamed(spaceData(space), schema.WORKSPACES, ws)) throw new schema.AlreadyExists("a workspace of that name exists");
			const nodeId = await this.#freshNodeId(space);
			const rows = [schema.node(nodeId, schema.WORKSPACES, ws, "dir"), schema.relation("node", nodeId, "owner", o.kind, o.id), receiptRow(s, id, digest, { nodeId })];
			await this.#admitRows(s, space, { id, operation: "createWorkspace", targets: [nodeId], rows, demand: { workspaces: 1, nodes: 1, relations: 1 } });
			await this.#commitMutation(s, space, id, "createWorkspace", [nodeId], rows, null);
			return { nodeId };
		});
	}

	/** The budgets of a security action; one that does not fit even the security reserve closes the tenant. */
	async #securityAdmit(s: Session, space: PhiSpaces, m: AdmitSpec, action: Record<string, unknown>): Promise<void> {
		try { await this.#admitRows(s, space, { ...m, pool: "security" }); }
		catch (e) {
			if (e instanceof schema.CapacityExceeded) this.#closeForSecurity(s.tenantId, { ...action, actorKind: s.actorKind, actorId: s.actorId }, e);
			throw e;
		}
	}

	/**
	 * An admin operation needs an enabled user with `tenant#admin`. A refusal after authentication writes its audit row
	 * in a transaction of its own, with no receipt and no other change (section 3), then answers `permissionDenied`.
	 */
	async #requireAdmin(s: Session, space: PhiSpaces, operation: string, id: VerifiedOpId | null): Promise<void> {
		if (s.actorKind === "user" && (await this.#has(space, schema.relation("tenant", s.tenantId, "admin", "user", s.actorId)))) return;
		await this.#admitRows(s, space, { id: null, operation, targets: [], rows: [] });
		const seq = (await this.#lastSeq(s.tenantId, space)) + 1;
		await this.#writeAll(s.tenantId, space, [schema.audit(seq, this.state.now(), { kind: s.actorKind, id: s.actorId }, operation, [], id?.operationId ?? "", "denied")]);
		this.#seq.set(s.tenantId, seq);
		throw new schema.PermissionDenied(`${operation} needs tenant#admin`);
	}

	/** The parent of a node to create: visible (else `notFound`), a directory (else `invalidInput`), editor (else
	 *  `permissionDenied`); section 5, creation branch. */
	async #creationParent(s: Session, space: PhiSpaces, ws: string, segs: string[]): Promise<NodeRow> {
		const p = await resolve(spaceData(space), s, ws, segs.slice(0, -1), { limits: this.limits });
		if (p.node.kind !== "dir") throw new schema.InvalidInput("the parent is not a directory");
		if (!atLeast(p.role, "editor")) throw new schema.PermissionDenied("creating needs editor on the parent");
		return p.node;
	}

	/** A blob reference of the size the real one will have, to measure rows before the blob is written. */
	#sizing(size: number): BlobRef { return { blobId: "x".repeat(22), size, keyGeneration: this.state.currentContentKey().generation }; }

	async #contentRow(tenantId: string, space: PhiSpaces, n: NodeRow): Promise<{ version: number; ref: BlobRef }> {
		const rows = await space.readAll({ type: schema.T.content, fields: { nodeId: n.nodeId } }, { limit: 2 });
		if (rows.length !== 1) throw new InconsistentState(`tenant ${tenantId}: file ${n.nodeId} has ${rows.length} content rows`);
		const f = rows[0].fields;
		return { version: f.version as number, ref: { blobId: f.blobId as string, size: f.size as number, keyGeneration: f.keyGeneration as number } };
	}

	/**
	 * The budgets of a mutation before anything is written (section 3, budgets): its quotas, a receipt slot of its pool,
	 * and its stored bytes. The rows an ordinary mutation adds must fit `maxTenantBytes`; together with its audit row
	 * everything must fit the tenant's rows plus the audit reserve, less the security reserve, which only security
	 * actions may use. A refusal is `capacityExceeded` and leaves admission open.
	 */
	async #admitRows(s: Session, space: PhiSpaces, m: AdmitSpec): Promise<void> {
		const pool = m.pool ?? "ordinary";
		for (const e of m.rows) assertRowFits(e.fields, DEFAULT_LIMITS);
		const stored = m.rows.reduce((n, r) => n + encodedBytes(r.fields), 0) - (m.replaced ?? []).reduce((n, r) => n + encodedBytes(r.fields), 0);
		const audit = schema.audit(Number.MAX_SAFE_INTEGER, this.state.now(), { kind: s.actorKind, id: s.actorId }, m.operation, m.targets, m.id?.operationId ?? "", "denied");
		await checkQuotas(space, this.limits, { ...m.demand, storedBytes: pool === "ordinary" ? stored : undefined }, await this.#tenantContentBytes(s.tenantId, space));
		const used = (await space.stats()).bytes?.entries ?? 0;
		const bound = this.limits.maxTenantBytes + this.limits.auditReserveBytes - (pool === "ordinary" ? this.limits.securityReserveBytes : 0);
		const need = used + Math.max(0, stored) + encodedBytes(audit.fields);
		if (need > bound) throw new schema.CapacityExceeded(`stored bytes with the audit row: ${need} exceeds ${bound} (${pool} pool)`);
		if (m.id !== null) await reserveReceipt(space, this.state, this.limits, pool);
	}

	/**
	 * A security action that does not fit even its reserve (section 3, budgets): the tenant is closed durably with the
	 * pending action, stays closed across restarts and answers `unavailable` until the operator's repair path reopens it.
	 */
	#closeForSecurity(tenantId: string, action: Record<string, unknown>, cause: Error): never {
		this.state.closeTenant(tenantId, "securityReserve", action);
		this.admission.suspend(tenantId, "securityReserve");
		console.error(`[files] tenant ${tenantId} closed: a security action does not fit its reserve (${cause.message})`);
		throw new Unavailable(`tenant ${tenantId} is closed until the operator completes a pending security action`);
	}

	/** The operator reopens a tenant closed for its security reserve once the pending action has durably succeeded
	 *  (or after a repair that makes room for it). */
	reopenClosedTenant(tenantId: string): void {
		this.state.reopenTenant(tenantId);
		this.admission.resume(tenantId);
	}

	async #tenantContentBytes(tenantId: string, space: PhiSpaces): Promise<number> {
		let n = this.#contentBytes.get(tenantId);
		if (n === undefined) { n = await sumContentBytes(space); this.#contentBytes.set(tenantId, n); }
		return n;
	}

	/**
	 * Commits a mutation's rows with its audit row in one transaction (section 6.3, steps 6 and 7). A content
	 * replacement first takes the old row under the transaction and verifies it, then writes the successor without a
	 * uniqueness check; every new row names its creation key. A failure before the commit call aborts and deletes the new
	 * blob. A commit whose outcome is unknown closes admission for every tenant and keeps both blobs until
	 * `resolveOutcomes`. After a durable commit the old blob is deleted.
	 */
	async #commitMutation(s: Session, space: PhiSpaces, id: VerifiedOpId, operation: string, targets: string[], rows: ReturnType<typeof schema.meta>[],
		save: { nodeId: string; newBlobId: string; oldBlobId: string | null; contentDelta: number; replace?: { version: number; blobId: string } } | null,
		takes: Array<{ type: string; fields: Record<string, string> }> = []): Promise<void> {
		const seq = (await this.#lastSeq(s.tenantId, space)) + 1;
		const all = [...rows, schema.audit(seq, this.state.now(), { kind: s.actorKind, id: s.actorId }, operation, targets, id.operationId, "ok")];
		let txn: string | null = null;
		try {
			if (save) await this.#fault("afterBlob");
			for (const e of all) assertRowFits(e.fields, DEFAULT_LIMITS);
			txn = (await space.createTransaction(this.#saveLeaseMs)).id;
			if (save?.replace) {
				const old = await space.take({ type: schema.T.content, fields: { nodeId: save.nodeId } }, 0, { txn });
				if (old === null || old.fields.version !== save.replace.version || old.fields.blobId !== save.replace.blobId)
					throw new InconsistentState(`tenant ${s.tenantId}: the content row of ${save.nodeId} changed under the queue`);
			}
			// rows a removal takes: each must still be there, inside the queue nothing else removes them
			for (const t of takes)
				if ((await space.take(t, 0, { txn })) === null) throw new InconsistentState(`tenant ${s.tenantId}: a ${t.type} row vanished under the queue`);
			for (const e of all) {
				const replacing = save?.replace && e.type === schema.T.content;
				await space.write(e, txn, FOREVER, replacing ? {} : { unique: schema.KEY[e.type as keyof typeof schema.KEY] });
			}
		} catch (e) {
			if (txn !== null) await space.abort(txn).catch(() => {});
			if (save) await this.blobs.delete(s.tenantId, save.newBlobId).catch(() => {});
			if (e instanceof UniqueConflict) throw new InconsistentState(`tenant ${s.tenantId}: ${e.message}`);
			throw e;
		}
		try {
			await this.#fault("commit:before");
			await space.commit(txn);
			await this.#fault("commit:after");
		} catch (e) {
			// the commit may or may not have happened: stop every tenant until it is resolved (section 6.1)
			this.#unresolved.push({ tenantId: s.tenantId, txn, save: save && { nodeId: save.nodeId, newBlobId: save.newBlobId, oldBlobId: save.oldBlobId } });
			this.#seq.delete(s.tenantId);
			this.#contentBytes.delete(s.tenantId);
			void this.admission.close();
			console.error(`[files] the outcome of a commit of tenant ${s.tenantId} is unknown; admission is closed until it is resolved (${(e as Error).message})`);
			throw new Unavailable("the outcome of a commit is unknown; retry later");
		}
		this.#seq.set(s.tenantId, seq);
		if (save) {
			const n = this.#contentBytes.get(s.tenantId);
			if (n !== undefined) this.#contentBytes.set(s.tenantId, n + save.contentDelta);
			await this.#fault("afterCommit");
			// a deletion held by a backup, or one that fails, leaves an orphan for the sweep
			if (save.oldBlobId !== null) await this.blobs.delete(s.tenantId, save.oldBlobId).catch(() => false);
		}
	}

	/**
	 * Resolves the saves whose commit outcome is unknown, then opens admission again (a host-operator step, section
	 * 6.1): every started operation is drained first; each open transaction is aborted (a committed one is gone), and
	 * the content row then decides which blob survives. Returns how many it resolved.
	 */
	async resolveOutcomes(): Promise<number> {
		await this.admission.close();
		const n = this.#unresolved.length;
		for (const u of this.#unresolved.splice(0)) {
			const space = new PhiSpaces(this.host, ctx, this.#now, undefined, undefined, { space: tenantAlias(u.tenantId) });
			// an open transaction holds its uncommitted rows and their creation keys: a retry would collide with them
			await space.abort(u.txn).catch(() => {});
			if (u.save === null) continue;
			const row = await space.readIfExists({ type: schema.T.content, fields: { nodeId: u.save.nodeId } }, 0);
			if (row?.fields.blobId === u.save.newBlobId) { if (u.save.oldBlobId !== null) await this.blobs.delete(u.tenantId, u.save.oldBlobId); }
			else await this.blobs.delete(u.tenantId, u.save.newBlobId);
		}
		this.admission.reopen();
		return n;
	}

	/** Ends a session (logout); an unknown handle is no error. */
	logout(handle: string): void { this.state.endSession(handle); }

	async #enabledActor(space: PhiSpaces, kind: string, id: string) {
		const a = await space.readIfExists({ type: schema.T.actor, fields: { actorKind: kind, actorId: id } }, 0);
		if (a === null || a.fields.state !== "enabled") throw new schema.Unauthenticated();
		return a;
	}

	async #has(space: PhiSpaces, rel: ReturnType<typeof schema.relation>): Promise<boolean> {
		return (await space.readIfExists({ type: rel.type, fields: rel.fields }, 0)) !== null;
	}

	/** A node ID no node of the tenant carries yet, checked inside the queue (section 3). */
	async #freshNodeId(space: PhiSpaces): Promise<string> {
		for (;;) {
			const id = schema.newNodeId();
			if ((await space.readIfExists({ type: schema.T.node, fields: { nodeId: id } }, 0)) === null) return id;
		}
	}

	async #lastSeq(tenantId: string, space: PhiSpaces): Promise<number> {
		let seq = this.#seq.get(tenantId);
		if (seq === undefined) {
			seq = 0;
			for (const a of await space.readAll({ type: schema.T.audit })) seq = Math.max(seq, a.fields.seq as number);
			this.#seq.set(tenantId, seq);
		}
		return seq;
	}

	/** Writes new rows in one commit, each with its type's creation key; a key collision is a corrupt state. */
	async #writeAll(tenantId: string, space: PhiSpaces, entries: ReturnType<typeof schema.meta>[]): Promise<void> {
		for (const e of entries) assertRowFits(e.fields, DEFAULT_LIMITS);
		const ops = entries.map((entry) => ({ op: "write" as const, entry, lease: FOREVER, unique: schema.KEY[entry.type as keyof typeof schema.KEY] }));
		try { await space.batch(ops); }
		catch (e) { if (e instanceof UniqueConflict) throw new InconsistentState(`tenant ${tenantId}: ${e.message}`); throw e; }
	}

	/**
	 * Deletes, in one bounded batch, the tenant's blobs that no content row names (section 6.3): orphans of saves that
	 * died between the blob write and the commit, or after the commit before the old blob's deletion. It runs in the
	 * tenant queue, where no save of the tenant is in flight, and only while the tenant Space holds no open or
	 * reserved transaction state: a content row taken by a save that has not resolved yet (a crashed process before the
	 * reaper, an unknown outcome) is invisible to a read, and its blob must survive the transaction's abort. Returns the
	 * number removed, or `null` when it did not run.
	 */
	sweepBlobs(tenantId: string, limit = 1000): Promise<number | null> {
		return this.inTenant(tenantId, async (space) => {
			const st = await space.stats();
			if (st.txns > 0 || st.locked > 0 || st.uncommitted > 0) return null;
			const referenced = new Set<string>();
			for (const e of await space.readAll({ type: schema.T.content })) referenced.add(e.fields.blobId as string);
			// the state may have changed while we read; only an unchanged one is safe to act on
			const again = await space.stats();
			if (again.txns > 0 || again.locked > 0 || again.uncommitted > 0) return null;
			return this.blobs.sweep(tenantId, referenced, limit);
		});
	}

	/** Whether a tenant is absent, reserved but still in provisioning, or initialized. */
	async tenantState(tenantId: string): Promise<"absent" | "provisioning" | "ready"> {
		if (!(await this.tenants()).includes(tenantId)) return "absent";
		return (await this.#inSpace(tenantId, (space) => this.#checkMeta(tenantId, space))) ? "ready" : "provisioning";
	}

	/** Rebuilds the login index from the user FsActor rows of every initialized tenant (section 6.6). */
	async rebuildLoginIndex(): Promise<number> {
		const logins: Array<{ issuer: string; subject: string; tenantId: string }> = [];
		for (const tenantId of await this.tenants()) {
			await this.#inSpace(tenantId, async (space) => {
				if (!(await this.#checkMeta(tenantId, space))) return;
				for (const a of await space.readAll({ type: schema.T.actor, fields: { actorKind: "user" } }))
					logins.push({ issuer: a.fields.issuer as string, subject: a.fields.subject as string, tenantId });
			});
		}
		this.state.replaceLogins(logins);
		return logins.length;
	}

	/** The tenant IDs whose Space is reserved. */
	async tenants(): Promise<string[]> {
		return (await listSpaces(this.host, ctx)).map((s) => s.alias).filter((a) => a.startsWith("t-")).map((a) => a.slice(2)).sort();
	}

	/** Closes admission, waits for every started operation, then stops the reaper and closes the store. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.admission.close();
		await this.#stopService();
		await this.host.close(ctx);
		this.state.close();
	}
}

/** The deterministic order of names in listings: by UTF-16 code units of the canonical (NFC) form. */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A subject as a caller names it: `{kind: "user" | "agent", id}` or `{kind: "group", id}` (its members). */
function parseSubject(v: unknown, maxNameBytes: number): Subject {
	const o = (v ?? {}) as { kind?: unknown; id?: unknown };
	if (o.kind === "user" || o.kind === "agent") return { kind: o.kind, id: schema.actorId(o.id, "subject ID") };
	if (o.kind === "group") return { kind: "group", id: schema.groupId(o.id, maxNameBytes), relation: "member" };
	throw new schema.InvalidInput("a subject is {kind: user | agent | group, id}");
}

const subjectOf = (r: RelRow): Subject => r.subjectKind === "group" ? { kind: "group", id: r.subjectId, relation: "member" } : { kind: r.subjectKind as schema.ActorKind, id: r.subjectId };
