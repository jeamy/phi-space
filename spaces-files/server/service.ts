// The filesystem service's store and admission (docs/zanzibar-agent-filesystem-plan.en.md, sections 2 and 6.1): one
// process opens phi-spaces' own SQLite store, which holds an exclusive owner lock beside the file (a second process is
// refused, a crash releases it), runs the reaper and gives each tenant a private named Space reached only through its
// queue. Nothing here serves a Space to anyone: the tenant Spaces are never exposed.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { openOwnMemoryHost, type OwnStoreHost } from "phi-spaces/store/host";
import { openSqliteHost } from "phi-spaces/store/sqlite";
import { createSpace, listSpaces, PhiSpaces, startService } from "phi-spaces";
import type { EntryDraft } from "phi-spaces/core";
import { DEFAULT_LIMITS, FOREVER, UniqueConflict } from "phi-spaces/core";
import { Metrics } from "./metrics.ts";
import { assertLimitsFit, assertRowFits, DEFAULT_FS_LIMITS, encodedBytes, type FsLimits } from "./limits.ts";
import { checkQuotas, sumContentBytes, type Demand } from "./quotas.ts";
import { Admission, Unavailable, type AdmissionOptions } from "./admission.ts";
import { DeploymentState, type DeploymentOptions } from "./deployment.ts";
import { BlobStore } from "./blobs.ts";
import { issueOperationIds, verifyOperationId, type VerifiedOpId } from "./opids.ts";
import { lookupReceipt, PRUNE_BATCH, pruneReceipts, receiptRow, reserveReceipt, type Outcome } from "./receipts.ts";
import { checkContents, parsePath, pathString } from "./paths.ts";
import { contentDigest, requestDigest } from "./digest.ts";
import { atLeast, hiddenChildren, isRestricted, RESTRICTED, checkGrant, checkLastAdmin, checkLastOwner, checkMembership, checkTenantAdmin, childNamed, listGroups, membersOf, resolve, spaceData, subjectRow, type NodeRow, type RelRow, type Subject } from "./policy.ts";
import type { BlobRef } from "./blobs.ts";
import { assertSeparateDirs, prepareDataDir } from "./dirs.ts";
import * as schema from "./schema.ts";
import { InconsistentState } from "./schema.ts";

export { prepareDataDir } from "./dirs.ts";

/** The store file inside the data directory. */
export const STORE_FILE = "files.sqlite";
/** Beside the data: the deployment state's ID and the highest sequence number it reached (section 6.6). */
export const STATE_MARKER = "state-marker.json";

/** The deployment state is missing, older than the data has seen, or another deployment's: the service refuses to
 *  start until the operator restores it from its own backup (`restore-state`, section 6.6). */
export class StateLost extends Error {
	constructor(message: string) { super(message); this.name = "StateLost"; }
}

type Marker = { stateId: string; seq: number };
function readMarker(path: string): Marker | null {
	if (!existsSync(path)) return null;
	const m = JSON.parse(readFileSync(path, "utf8")) as Marker;
	if (typeof m.stateId !== "string" || !Number.isSafeInteger(m.seq)) throw new StateLost(`${path} is malformed`);
	return m;
}
function writeMarker(path: string, m: Marker): void {
	const tmp = `${path}.tmp`;
	const fd = openSync(tmp, "w", 0o600);
	try { writeSync(fd, JSON.stringify(m)); fsyncSync(fd); } finally { closeSync(fd); }
	renameSync(tmp, path);
}

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
	/** `restore-state` only: the deployment state was just installed from its backup and is older than the data's
	 *  marker; it is opened anyway and brought forward (`#bringStateForward`). */
	stateRestore?: boolean;
	/** Tests only: called at the named points of a save (section 6.3), to inject a failure or a crash there. */
	faultHook?: (point: FaultPoint) => void | Promise<void>;
};

/** Where a save can be interrupted: before the blob write, between it and the commit, around the commit call (its
 *  outcome then is unknown), and after the commit before the old blob's deletion. */
export type FaultPoint = "beforeBlob" | "afterBlob" | "commit:before" | "commit:after" | "afterCommit";

/** What a session-bound operation is, for the admission mode (order of checks, step 3). */
type OpClass = "file" | "admin" | "maintenance" | "issue";

/** What `#admitRows` checks a mutation's budgets for. */
type AdmitSpec = { id: VerifiedOpId | null; operation: string; targets: string[]; rows: ReturnType<typeof schema.meta>[]; demand?: Demand; replaced?: ReturnType<typeof schema.meta>[]; pool?: "ordinary" | "security" };

/** A directory entry as `list` returns it. */
export type ListEntry = { name: string; kind: "dir" | "file"; restricted?: true };

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
	/** Process-wide counters: queue wait and run time, adapter calls, evaluator work (server/metrics.ts). */
	readonly metrics = new Metrics();
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
		this.admission = new Admission({ ...o, observe: (w, r) => { this.metrics.queueWait.add(w); this.metrics.queueRun.add(r); } });
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
		// the deployment state first: it decides about sessions and keys before any tenant is served. Data that exists
		// without its state would get fresh content keys and lose every file: refused (section 6.6, loss)
		const markerPath = o.dataDir === null || o.stateDir === null ? null : join(o.dataDir, STATE_MARKER);
		if (markerPath !== null && (existsSync(join(o.dataDir!, STORE_FILE)) || existsSync(markerPath)) && !DeploymentState.existsIn(o.stateDir!))
			throw new StateLost(`the data in ${o.dataDir} has no deployment state in ${o.stateDir}: restore the state from its backup (operator restore-state)`);
		const marker = markerPath === null ? null : readMarker(markerPath);
		const mirror = (stateId: string, seq: number) => { if (markerPath !== null && existsSync(o.dataDir!)) writeMarker(markerPath, { stateId, seq }); };
		const state = await DeploymentState.open({ clock: o.now, ...o.state, dir: o.stateDir, onSeq: mirror });
		try {
			if (marker !== null && marker.stateId !== state.stateId()) throw new StateLost(`the deployment state in ${o.stateDir} belongs to another deployment than the data in ${o.dataDir}`);
			if (marker !== null && state.seq() < marker.seq && !o.stateRestore) throw new StateLost(`the deployment state in ${o.stateDir} is older than the data has seen (sequence ${state.seq()} < ${marker.seq}): restore it from its newest backup (operator restore-state)`);
		} catch (e) { state.close(); throw e; }
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
		try {
			if (o.stateRestore) await service.#bringStateForward(marker?.seq ?? 0);
			if (markerPath !== null && (marker === null || state.seq() > marker.seq)) writeMarker(markerPath, { stateId: state.stateId(), seq: state.seq() });
			// the login index is a lookup aid derived from the FsActor rows: rebuilt on every start (section 6.6)
			await service.rebuildLoginIndex();
		} catch (e) { await service.close(); throw e; }
		// a mode transition that a crash interrupted completes before anything is served (section 6.1)
		if (state.pendingMode() !== null) state.completeModeTransition();
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
	 * Registers an actor on behalf of the administrator `by`, without a session or an operation ID: the host-level form
	 * for provisioning and test fixtures. The admin adapter uses `registerActor`, which carries both. The enabled
	 * FsActor, its private home root and the home's first direct owner relation commit in one transaction together with
	 * the audit row, then a user's tenant goes into the login index. An existing (kind, actorId) (tombstones included:
	 * IDs are never reused), home name or identity pair gives `alreadyExists` and creates nothing.
	 */
	async provisionActor(tenantId: string, by: { actorKind: schema.ActorKind; actorId: string }, kind: schema.ActorKind, actorId: string, homeName: string, identity: schema.UserIdentity | schema.AgentIdentity): Promise<{ actorId: string; homeNodeId: string }> {
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
	withSession<T>(handle: unknown, op: (session: Session, space: PhiSpaces) => Promise<T>): Promise<T> {
		return this.#session("file", handle, op);
	}

	/**
	 * The session checks of `withSession`, then the admission mode (order of checks, step 3): in normal mode the
	 * maintenance metadata operations are `unavailable`; in maintenance mode only an enabled tenant administrator's admin
	 * operations, the maintenance metadata operations and `issueOperationIds` continue, everything else is `unavailable`.
	 */
	async #session<T>(cls: OpClass, handle: unknown, op: (session: Session, space: PhiSpaces) => Promise<T>): Promise<T> {
		const found = typeof handle === "string" ? this.state.lookupSession(handle) : null;
		// a recoverer's session opens the recovery interface alone: no file, version or ordinary session access
		if (found === null || found.actorKind === "recoverer") throw new schema.Unauthenticated();
		const view = { ...found, actorKind: found.actorKind };
		return this.inTenant(view.tenantId, async (space) => {
			const a = await this.#enabledActor(space, view.actorKind, view.actorId);
			const mode = this.state.mode();
			if (mode === "normal" && cls === "maintenance") throw new Unavailable("maintenance operations are offered in maintenance mode only");
			if (mode === "maintenance") {
				if (cls === "file") throw new Unavailable("the service is in maintenance mode");
				if (view.actorKind !== "user" || !(await this.#has(space, schema.relation("tenant", view.tenantId, "admin", "user", view.actorId))))
					throw new Unavailable("the service is in maintenance mode");
				// during a restore an administrator row from the backup proves nothing: only the identity the operator
				// approved as this tenant's reconciler for the restore's epoch continues (section 6.5, step 3)
				if (this.state.restoreEpoch() !== null) {
					const r = this.state.reconciler(view.tenantId);
					if (r === null || r.issuer !== a.fields.issuer || r.subject !== a.fields.subject) throw new Unavailable("the service is restoring; only the approved reconciler continues");
				}
			}
			return op({ tenantId: view.tenantId, actorKind: view.actorKind, actorId: view.actorId, homeNodeId: a.fields.homeNodeId as string, expiresAt: view.expiresAt }, space);
		});
	}

	/**
	 * Switches the admission mode (a host-operator step, section 6.1): the intent is persisted, the gate closes (queued
	 * operations are refused, started ones drain to their outcome), the destination mode is persisted, then the gate
	 * opens again. Refused while a commit outcome is unknown.
	 */
	async setMode(to: "normal" | "maintenance"): Promise<void> {
		if (this.#unresolved.length) throw new Unavailable("a commit outcome is unknown: resolve it first");
		// leaving a restore's maintenance needs every tenant reconciled in its epoch (section 6.5, step 5)
		const epoch = this.state.restoreEpoch();
		if (to === "normal" && epoch !== null) {
			const open = (await this.tenants()).filter((t) => !this.state.isReconciled(t, epoch));
			if (open.length) throw new Unavailable(`the restore of epoch ${epoch} waits for the reconciliation of ${open.join(", ")}`);
		}
		this.state.beginModeTransition(to);
		await this.admission.close();
		if (this.#unresolved.length) throw new Unavailable("a commit outcome became unknown while draining: resolve it first");
		this.state.completeModeTransition();
		if (to === "normal" && epoch !== null) { this.state.operatorAudit("restoreComplete", { epoch }); this.state.endRestore(); }
		this.admission.reopen();
	}

	mode(): "normal" | "maintenance" { return this.state.mode(); }

	// ---------------------------------------------------------------- maintenance metadata operations (section 5)

	/** Node names and kinds below a path, in maintenance mode only, without visibility and without contents or versions;
	 *  an absent path is `notFound`. */
	maintenanceList(handle: unknown, workspace: unknown, path: unknown): Promise<ListEntry[]> {
		return this.#session("maintenance", handle, async (s, space) => {
			const node = await this.#maintenanceTarget(s, space, "maintenanceList", workspace, path);
			if (node.kind !== "dir") throw new schema.InvalidInput("maintenanceList needs a directory");
			const kids = await space.readAll({ type: schema.T.node, fields: { parentId: node.nodeId } }, { limit: this.limits.maxDirEntries + 1 });
			if (kids.length > this.limits.maxDirEntries) throw new schema.CapacityExceeded(`a directory holds more than ${this.limits.maxDirEntries} entries`);
			return kids.map((k) => ({ name: k.fields.name as string, kind: k.fields.kind as "dir" | "file" })).sort((a, b) => byName(a.name, b.name));
		});
	}

	maintenanceListGrants(handle: unknown, workspace: unknown, path: unknown): Promise<Array<{ relation: string; subject: Subject }>> {
		return this.#session("maintenance", handle, async (s, space) => {
			const node = await this.#maintenanceTarget(s, space, "maintenanceListGrants", workspace, path);
			return this.#grantsOn(space, node.nodeId);
		});
	}

	/**
	 * Adds or removes one direct tuple by tenant-administrator authority, in maintenance mode only (section 5): ordinary
	 * subject, relation and redundant-viewer validation, `lastOwner` kept, idempotent both ways, receipt and audit row.
	 * It gives no file-content access.
	 */
	maintenancePutGrant(handle: unknown, workspace: unknown, path: unknown, action: unknown, relation: unknown, subject: unknown, operationId: unknown): Promise<{ status: string }> {
		return this.#session("maintenance", handle, async (s, space) => {
			if (action !== "grant" && action !== "revoke") throw new schema.InvalidInput("action is grant or revoke");
			if (relation !== "owner" && relation !== "editor" && relation !== "viewer") throw new schema.InvalidInput(`unknown relation ${JSON.stringify(relation)}`);
			const subj = parseSubject(subject, this.limits.maxNameBytes);
			const ws = schema.canonicalName(workspace, this.limits.maxNameBytes);
			const segs = parsePath(path, "maintenancePutGrant", this.limits);
			const id = verifyOperationId(this.state, s, operationId, this.limits);
			const node = await this.#maintenanceTarget(s, space, "maintenancePutGrant", ws, path, id);
			const digest = requestDigest("maintenancePutGrant", { workspace: ws, path: pathString(segs), action, relation, subject: subjectRow(subj) });
			return this.#applyGrant(s, space, id, digest, "maintenancePutGrant", action, node, relation, subj);
		});
	}

	/** The target of a maintenance metadata operation: the caller is an administrator (an audited refusal otherwise), the
	 *  path is walked by names alone, absence is `notFound`. */
	async #maintenanceTarget(s: Session, space: PhiSpaces, op: string, workspace: unknown, path: unknown, id: VerifiedOpId | null = null): Promise<NodeRow> {
		const ws = schema.canonicalName(workspace, this.limits.maxNameBytes);
		const segs = parsePath(path, op, this.limits);
		await this.#requireAdmin(s, space, op, id);
		const d = spaceData(space);
		let node = await childNamed(d, schema.WORKSPACES, ws);
		if (node === null) throw new schema.NotFound();
		for (const seg of segs) {
			if (node.kind !== "dir") throw new schema.InvalidInput("a path goes through a file");
			node = await childNamed(d, node.nodeId, seg);
			if (node === null) throw new schema.NotFound();
		}
		return node;
	}

	// ---------------------------------------------------------------- the recovery interface (section 6.5, step 2)

	/**
	 * Signs in a recoverer: an identity the adapter verified (an OIDC login on the recovery path) that the host operator
	 * put on this tenant's recovery roster, outside the restorable data. Only while a restore is open; the session's
	 * actor is the recoverer ID of this identity, tenant and restore epoch, and it reaches the recovery operations alone.
	 * Neither an actor row nor an admin grant from the backup is needed or consulted.
	 */
	async recoveryLogin(tenantId: string, identity: schema.UserIdentity): Promise<{ handle: string; expiresAt: number }> {
		const epoch = this.state.restoreEpoch();
		if (epoch === null) throw new Unavailable("no restore is open");
		const ident = schema.identityOf("user", identity) as schema.UserIdentity;
		if (!this.state.onRoster(tenantId, ident.issuer, ident.subject)) throw new schema.Unauthenticated();
		if (!(await this.tenants()).includes(tenantId)) throw new schema.Unauthenticated();
		const actorId = this.state.recovererId(tenantId, ident.issuer, ident.subject);
		const r = this.state.createSession({ tenantId, actorKind: "recoverer", actorId });
		this.state.operatorAudit("recoveryLogin", { tenantId, issuer: ident.issuer, subject: ident.subject, epoch });
		return r;
	}

	/** Runs a recovery operation: the session is a recoverer's of the open restore, still on the roster, in its tenant's
	 *  queue. Anything else is `unauthenticated`. */
	async #recovery<T>(handle: unknown, op: (s: Session, space: PhiSpaces, who: { issuer: string; subject: string; epoch: number }) => Promise<T>): Promise<T> {
		const view = typeof handle === "string" ? this.state.lookupSession(handle) : null;
		if (view === null || view.actorKind !== "recoverer") throw new schema.Unauthenticated();
		const who = this.state.recovererOf(view.actorId);
		const epoch = this.state.restoreEpoch();
		if (who === null || epoch === null || who.epoch !== epoch || who.tenantId !== view.tenantId || !this.state.onRoster(who.tenantId, who.issuer, who.subject))
			throw new schema.Unauthenticated();
		const s = { tenantId: view.tenantId, actorKind: "recoverer", actorId: view.actorId, homeNodeId: "", expiresAt: view.expiresAt } as unknown as Session;
		return this.inTenant(view.tenantId, (space) => op(s, space, who));
	}

	/** Who a recoverer's session belongs to (read-only, no queue): the tenant, identity and restore epoch. */
	recoverySessionInfo(handle: unknown): { tenantId: string; issuer: string; subject: string; epoch: number; expiresAt: number } {
		const view = typeof handle === "string" ? this.state.lookupSession(handle) : null;
		const who = view?.actorKind === "recoverer" ? this.state.recovererOf(view.actorId) : null;
		if (view === null || who === null || who.epoch !== this.state.restoreEpoch()) throw new schema.Unauthenticated();
		return { tenantId: view.tenantId, issuer: who.issuer, subject: who.subject, epoch: who.epoch, expiresAt: view.expiresAt };
	}

	/** The external audit of a recovery mutation: the identity and restore epoch behind it (section 6.5, step 2). */
	#recoveryAudit(s: Session, who: { issuer: string; subject: string; epoch: number }, operation: string, id: VerifiedOpId, outcome: Record<string, unknown>, replayed: boolean): void {
		this.state.operatorAudit(`recovery.${operation}`, { tenantId: s.tenantId, issuer: who.issuer, subject: who.subject, epoch: who.epoch, operationId: id.operationId, ...outcome, replayed });
	}

	/** Recovery operation IDs: signed with the current generation, bound to the recoverer, its tenant and restore epoch. */
	async recoveryIssueOperationIds(handle: unknown, count: unknown): Promise<string[]> {
		return this.#recovery(handle, async (s) => issueOperationIds(this.state, s, count, this.limits));
	}

	/** The tenant's actors and administrators, for the recoverer to compare with current evidence; metadata only. */
	async recoveryInspect(handle: unknown): Promise<{ actors: Array<{ kind: schema.ActorKind; id: string; state: string; issuer?: string; subject?: string }>; admins: string[] }> {
		return this.#recovery(handle, async (s, space) => {
			const rows = await space.readAll({ type: schema.T.actor }, { limit: this.limits.maxActors + 1 });
			if (rows.length > this.limits.maxActors) throw new schema.CapacityExceeded(`more than ${this.limits.maxActors} actors`);
			const admins = await space.readAll({ type: schema.T.relation, fields: { objectKind: "tenant", objectId: s.tenantId, relation: "admin" } }, { limit: this.limits.maxActors + 1 });
			return {
				actors: rows.map((r) => ({ kind: r.fields.actorKind as schema.ActorKind, id: r.fields.actorId as string, state: r.fields.state as string,
					...(r.fields.actorKind === "user" ? { issuer: r.fields.issuer as string, subject: r.fields.subject as string } : {}) }))
					.sort((a, b) => byName(a.kind, b.kind) || byName(a.id, b.id)),
				admins: admins.map((r) => r.fields.subjectId as string).sort(byName),
			};
		});
	}

	/**
	 * Establishes today's administrator B (section 6.5, step 3): an identity absent from the backup is provisioned with
	 * the registration invariants (actor, home, the home's owner relation) and `tenant#admin`; an identity bound to an
	 * actor of the given ID is enabled and granted where needed. An identity bound to another actor, or an actor ID or
	 * home name taken by another, is `alreadyExists`: those conflicts are resolved under operator review. Receipt and
	 * audit row commit with the change, so a repeated step is answered by its receipt.
	 */
	async recoveryProvisionAdmin(handle: unknown, actorId: unknown, homeName: unknown, identity: unknown, operationId: unknown): Promise<{ status: "provisioned" | "granted" | "enabled" | "unchanged"; actorId: string }> {
		const op = "recoveryProvisionAdmin";
		const ident = schema.identityOf("user", identity) as schema.UserIdentity;
		const aid = schema.actorId(actorId);
		const name = schema.canonicalName(homeName, this.limits.maxNameBytes);
		return this.#recovery(handle, async (s, space, who) => {
			const id = verifyOperationId(this.state, s, operationId, this.limits);
			const digest = requestDigest(op, { actorId: aid, homeName: name, identity: ident as Record<string, string> });
			const done = await lookupReceipt(space, s, id.operationId, digest);
			if (done) { this.#recoveryAudit(s, who, op, id, { status: done.status }, true); return { status: done.status as "unchanged", actorId: aid }; }
			const admin = schema.relation("tenant", s.tenantId, "admin", "user", aid);
			const hasAdmin = await this.#has(space, admin);
			const bound = await space.readIfExists(schema.identityTemplate("user", ident), 0);
			let status: "provisioned" | "granted" | "enabled" | "unchanged";
			const rows: Array<ReturnType<typeof schema.meta>> = [];
			const takes: Array<{ type: string; fields: Record<string, string> }> = [];
			const replaced: EntryDraft[] = [];
			const demand: Record<string, number> = {};
			let targets: string[] = [];
			if (bound !== null) {
				if (bound.fields.actorId !== aid) throw new schema.AlreadyExists("that identity is bound to another actor: resolve it under operator review");
				if (bound.fields.state === "deleted") throw new schema.InvalidInput("that actor is deleted: resolve it under operator review");
				if (bound.fields.state === "disabled") {
					rows.push({ type: schema.T.actor, fields: { ...bound.fields, state: "enabled" } });
					takes.push({ type: schema.T.actor, fields: { actorKind: "user", actorId: aid } });
					replaced.push({ type: schema.T.actor, fields: bound.fields });
				}
				if (!hasAdmin) { rows.push(admin); demand.relations = 1; }
				status = bound.fields.state === "disabled" ? "enabled" : hasAdmin ? "unchanged" : "granted";
			} else {
				if (await space.readIfExists({ type: schema.T.actor, fields: { actorKind: "user", actorId: aid } }, 0)) throw new schema.AlreadyExists(`actor user:${aid} exists with another identity: resolve it under operator review`);
				if (await childNamed(spaceData(space), schema.WORKSPACES, name)) throw new schema.AlreadyExists("a workspace of that name exists: resolve it under operator review");
				const homeNodeId = await this.#freshNodeId(space);
				rows.push(schema.actor("user", aid, homeNodeId, ident), schema.node(homeNodeId, schema.WORKSPACES, name, "dir"), schema.relation("node", homeNodeId, "owner", "user", aid));
				if (!hasAdmin) rows.push(admin);
				Object.assign(demand, { actors: 1, workspaces: 1, nodes: 1, relations: hasAdmin ? 1 : 2 });
				targets = [homeNodeId];
				status = "provisioned";
			}
			rows.push(receiptRow(s, id, digest, { status }));
			await this.#admitRows(s, space, { id, operation: op, targets, rows, demand, replaced });
			await this.#commitMutation(s, space, id, op, targets, rows, null, takes);
			if (status === "provisioned") this.state.addLogin(ident.issuer, ident.subject, s.tenantId);
			this.#recoveryAudit(s, who, op, id, { status, actorId: aid }, false);
			return { status, actorId: aid };
		});
	}

	/** Removes the obsolete administrator A's `tenant#admin` (section 6.5, step 3), keeping the last enabled
	 *  administrator: establish B first. Idempotent; a security action; receipt and audit row with the change. */
	async recoveryRevokeAdmin(handle: unknown, user: unknown, operationId: unknown): Promise<{ status: "revoked" | "unchanged" }> {
		const op = "recoveryRevokeAdmin";
		const uid = schema.actorId(user, "user ID");
		return this.#recovery(handle, async (s, space, who) => {
			const id = verifyOperationId(this.state, s, operationId, this.limits);
			const digest = requestDigest(op, { user: uid });
			const done = await lookupReceipt(space, s, id.operationId, digest);
			if (done) { this.#recoveryAudit(s, who, op, id, { status: done.status }, true); return { status: done.status as "revoked" }; }
			const row = schema.relation("tenant", s.tenantId, "admin", "user", uid);
			const present = await this.#has(space, row);
			const status = present ? "revoked" : "unchanged";
			const rows = [receiptRow(s, id, digest, { status })];
			let takes: Array<{ type: string; fields: Record<string, string> }> = [];
			if (present) {
				const d = spaceData(space);
				const tuple = await checkTenantAdmin(d, s.tenantId, uid);
				await checkLastAdmin(d, s.tenantId, { remove: [tuple] }, { limits: this.limits });
				await this.#securityAdmit(s, space, { id, operation: op, targets: [], rows }, { operation: op, user: uid });
				takes = [{ type: schema.T.relation, fields: { ...tuple } }];
			} else await this.#admitRows(s, space, { id, operation: op, targets: [], rows });
			await this.#commitMutation(s, space, id, op, [], rows, null, takes);
			this.#recoveryAudit(s, who, op, id, { status, user: uid }, false);
			return { status };
		});
	}

	// ---------------------------------------------------------------- upkeep (sections 3 and 6.1)

	/**
	 * Removes, in one bounded batch, the tenant's audit rows older than the retention age, lowest seq first (section 6.2).
	 * No row younger than `maxAuditAgeMs` is ever removed, and the newest row always stays, so the seq never restarts
	 * after a reopen. The time floor is persisted before the removal. Returns how many it removed.
	 */
	pruneAudit(tenantId: string, limit = 256): Promise<number> {
		return this.inTenant(tenantId, async (space) => {
			const now = this.state.now();
			const rows = (await space.readAll({ type: schema.T.audit })).sort((a, b) => (a.fields.seq as number) - (b.fields.seq as number));
			const old = rows.slice(0, -1).filter((r) => (r.fields.time as number) < now - this.limits.maxAuditAgeMs).slice(0, limit);
			if (old.length === 0) return 0;
			this.state.commitFloor(now);
			await space.batch(old.map((r) => ({ op: "take" as const, template: { type: schema.T.audit, fields: { seq: r.fields.seq as number } } })));
			return old.length;
		});
	}

	/** The upkeep of one tenant in its queue: expired receipts, old audit rows, orphan blobs (bounded batches each). */
	async maintainTenant(tenantId: string): Promise<{ receipts: number; audit: number; blobs: number | null }> {
		const receipts = await this.inTenant(tenantId, (space) => pruneReceipts(space, this.state, PRUNE_BATCH));
		const audit = await this.pruneAudit(tenantId);
		const blobs = await this.sweepBlobs(tenantId);
		return { receipts, audit, blobs };
	}

	/** The store file's size, the part of it free for reuse (what `compact` returns), and its WAL; null in memory. */
	storeSizes(): { fileBytes: number; freeBytes: number; walBytes: number } | null {
		if (this.storePath === null || !existsSync(this.storePath)) return null;
		const db = new DatabaseSync(this.storePath, { readOnly: true });
		try {
			const one = (pragma: string) => Object.values(db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>)[0];
			const pageSize = one("page_size");
			const wal = `${this.storePath}-wal`;
			return { fileBytes: one("page_count") * pageSize, freeBytes: one("freelist_count") * pageSize, walBytes: existsSync(wal) ? statSync(wal).size : 0 };
		} finally { db.close(); }
	}

	/**
	 * Health for the operator (phase 5): `ok`, `maintenance` (the mode, or an open restore), or `degraded` (a closed
	 * tenant, an unknown commit outcome, closed admission in normal mode); with the restore's step, the deployment
	 * state's backup lag (a key or epoch change not yet in a state backup) and the store's live and free sizes. Names
	 * tenants only where one is closed; no actor, path or content.
	 */
	async health(): Promise<Record<string, unknown>> {
		const journal = this.state.restoreJournal();
		const closed = this.state.closedTenants();
		const mode = this.state.mode();
		const degraded = closed.length > 0 || this.#unresolved.length > 0 || (mode === "normal" && !this.admission.open);
		return {
			status: degraded ? "degraded" : mode === "maintenance" || journal !== null ? "maintenance" : "ok",
			mode, admissionOpen: this.admission.open,
			restore: journal === null ? null : { step: journal.step, epoch: this.state.restoreEpoch() },
			tenants: (await this.tenants()).length,
			closedTenants: closed.map((c) => ({ tenantId: c.tenantId, reason: c.reason })),
			unresolvedOutcomes: this.#unresolved.length,
			state: { epoch: this.state.epoch(), seq: this.state.seq(), backedUpSeq: this.state.backedUpSeq(), stateBackupDue: this.state.seq() > this.state.backedUpSeq() },
			store: this.storeSizes(),
		};
	}

	/** Gives the store's free pages back (`OwnStoreHost.compact`, section 6.1), with admission drained around it. */
	async compact(): Promise<{ freedPages: number; converted: boolean; error?: string } | null> {
		if (this.#unresolved.length) throw new Unavailable("a commit outcome is unknown: resolve it first");
		await this.admission.close();
		try { return await this.host.compact(); }
		finally { this.admission.reopen(); }
	}

	/** What the browser shows for a session: its tenant, actor and whether it is an enabled tenant administrator.
	 *  Reads only and audits nothing, so a page may ask on every load. Offered in maintenance mode like
	 *  `issueOperationIds`. */
	sessionInfo(handle: unknown): Promise<{ tenantId: string; actor: { kind: schema.ActorKind; id: string }; admin: boolean; expiresAt: number }> {
		return this.#session("issue", handle, async (s, space) => ({ tenantId: s.tenantId, actor: { kind: s.actorKind, id: s.actorId }, admin: await this.#isAdmin(s, space), expiresAt: s.expiresAt }));
	}

	/**
	 * Signs `count` operation IDs for the session's actor (section 5, `issueOperationIds`): a valid session suffices, and
	 * the call writes nothing but the time floor. A count outside 1..maxOperationIdsPerCall is `invalidInput`.
	 */
	issueOperationIds(handle: unknown, count: unknown): Promise<string[]> {
		return this.#session("issue", handle, async (s) => issueOperationIds(this.state, s, count, this.limits));
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
			const d = spaceData(space);
			const r = await resolve(d, s, ws, segs, { limits: this.limits });
			if (r.node.kind !== "dir") throw new schema.InvalidInput("list needs a directory");
			const kids = await space.readAll({ type: schema.T.node, fields: { parentId: r.node.nodeId } }, { limit: this.limits.maxDirEntries + 1 });
			if (kids.length > this.limits.maxDirEntries) throw new schema.CapacityExceeded(`a directory holds more than ${this.limits.maxDirEntries} entries`);
			const restricted = await this.#restrictedChildren(space, r.node.nodeId);
			const hidden = await hiddenChildren(d, s, r, restricted, { limits: this.limits });
			return kids.filter((k) => !hidden.has(k.fields.nodeId as string))
				.map((k): ListEntry => ({ name: k.fields.name as string, kind: k.fields.kind as "dir" | "file", ...(restricted.includes(k.fields.nodeId as string) ? { restricted: true as const } : {}) }))
				.sort((a, b) => byName(a.name, b.name));
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
				// a restricted child out of the caller's reach: the name is taken, and nothing more is said (not its kind)
				if (existing && await isRestricted(d, existing.nodeId)) {
					const parentR = await resolve(d, s, ws, segs.slice(0, -1), { limits: this.limits });
					if ((await hiddenChildren(d, s, parentR, [existing.nodeId], { limits: this.limits })).size) throw new schema.AlreadyExists("a child of that name exists");
				}
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

	/**
	 * Moves (and so renames) a file or directory, within its workspace or into another of the tenant (section 5, move and
	 * delete): owner on the node, editor on its parent and on the destination's parent. The node keeps its ID, so its
	 * versions, blobs, grants and restriction stay with it; what it inherits changes with its new place at once. A
	 * workspace root does not move; a destination inside the moved directory is `invalidInput`; a taken destination
	 * name `alreadyExists`; a subtree that would lie deeper than `maxPathDepth` is `capacityExceeded` (a larger subtree
	 * than `maxMoveDirs` directories, whose depth is not measured, likewise).
	 */
	move(handle: unknown, workspace: unknown, path: unknown, toWorkspace: unknown, toPath: unknown, operationId: unknown): Promise<{ status: "moved" | "unchanged" }> {
		return this.withSession(handle, async (s, space) => {
			const ws = schema.canonicalName(workspace, this.limits.maxNameBytes);
			const segs = parsePath(path, "move", this.limits);
			const toWs = schema.canonicalName(toWorkspace, this.limits.maxNameBytes);
			const toSegs = parsePath(toPath, "move", this.limits);
			if (segs.length === 0 || toSegs.length === 0) throw new schema.InvalidInput("a workspace root is not moved, and nothing moves into a root's place");
			const id = verifyOperationId(this.state, s, operationId, this.limits);
			const d = spaceData(space);
			// both parents first: they stay where they are, so a retry after a lost reply is authorized like the call
			if (!atLeast((await resolve(d, s, ws, segs.slice(0, -1), { limits: this.limits })).role, "editor")) throw new schema.PermissionDenied("move needs editor on the parent");
			const dest = await this.#creationParent(s, space, toWs, toSegs);
			const digest = requestDigest("move", { workspace: ws, path: pathString(segs), toWorkspace: toWs, toPath: pathString(toSegs) });
			const done = await lookupReceipt(space, s, id.operationId, digest);
			if (done) return { status: done.status as "moved" | "unchanged" };
			const r = await resolve(d, s, ws, segs, { limits: this.limits });
			if (!atLeast(r.role, "owner")) throw new schema.PermissionDenied("move needs owner on the node");
			const node = r.node, name = toSegs[toSegs.length - 1];
			const noop = async () => {
				const rows = [receiptRow(s, id, digest, { status: "unchanged" })];
				await this.#admitRows(s, space, { id, operation: "move", targets: [node.nodeId], rows });
				await this.#commitMutation(s, space, id, "move", [node.nodeId], rows, null);
				return { status: "unchanged" as const };
			};
			if (dest.nodeId === node.parentId && name === node.name) return noop();
			// the destination's ancestors must not include the node (a directory moved into itself)
			for (let at: NodeRow | null = dest, n = 0; at !== null && at.parentId !== schema.WORKSPACES; at = await d.node(at.parentId), n++) {
				if (at.nodeId === node.nodeId || n > this.limits.maxPathDepth) throw new schema.InvalidInput("a directory cannot move into itself");
			}
			if (dest.nodeId === node.nodeId) throw new schema.InvalidInput("a directory cannot move into itself");
			if (await childNamed(d, dest.nodeId, name)) throw new schema.AlreadyExists("a child of that name exists");
			if (toSegs.length > segs.length && node.kind === "dir") {
				const below = await this.#subtreeHeight(space, node.nodeId);
				if (toSegs.length + below > this.limits.maxPathDepth) throw new schema.CapacityExceeded(`the moved subtree would lie deeper than ${this.limits.maxPathDepth} levels`);
			}
			const moved = schema.node(node.nodeId, dest.nodeId, name, node.kind);
			const takes: Array<{ type: string; fields: Record<string, string> }> = [{ type: schema.T.node, fields: { nodeId: node.nodeId, parentId: node.parentId, name: node.name } }];
			const rows = [moved];
			if (await isRestricted(d, node.nodeId)) {
				// the marker names the parent, so that a directory's restricted children are one lookup: it moves too
				takes.push({ type: schema.T.relation, fields: { objectKind: "node", objectId: node.nodeId, relation: RESTRICTED, subjectKind: "node", subjectId: node.parentId, subjectRelation: schema.DIRECT } });
				rows.push(schema.relation("node", node.nodeId, RESTRICTED, "node", dest.nodeId));
			}
			rows.push(receiptRow(s, id, digest, { status: "moved" }));
			await this.#admitRows(s, space, { id, operation: "move", targets: [node.nodeId], rows, demand: dest.nodeId === node.parentId ? {} : { dirEntries: { parentId: dest.nodeId, n: 1 } }, replaced: takes.map((t) => ({ type: t.type, fields: { ...t.fields, kind: node.kind } })) });
			await this.#commitMutation(s, space, id, "move", [node.nodeId], rows, null, takes);
			return { status: "moved" as const };
		});
	}

	/** Levels below a directory (0 for an empty one), walking at most `maxMoveDirs` directories. */
	async #subtreeHeight(space: PhiSpaces, dirId: string): Promise<number> {
		let level = [dirId], height = 0, walked = 0;
		for (;;) {
			const next: string[] = [];
			let any = false;
			for (const id of level) {
				if (++walked > this.limits.maxMoveDirs) throw new schema.CapacityExceeded(`the subtree holds more than ${this.limits.maxMoveDirs} directories: move it in parts`);
				const kids = await space.readAll({ type: schema.T.node, fields: { parentId: id } }, { limit: this.limits.maxDirEntries + 1 });
				if (kids.length > 0) any = true;
				for (const k of kids) if (k.fields.kind === "dir") next.push(k.fields.nodeId as string);
			}
			if (!any) return height;
			height++;
			if (next.length === 0) return height;
			level = next;
		}
	}

	/**
	 * Removes a file or an empty directory (section 5, move and delete): editor on the node and on its parent; with
	 * `expectedVersion` (a file's), a newer version is `versionConflict`. The node's content row, grants and restriction
	 * go in the same transaction and the blob is deleted after the commit (a crash leaves an orphan for the sweep). A
	 * directory with children is `invalidInput`, hidden children included. The path "." removes a workspace: owner on its
	 * root, which must be empty and be no live actor's home.
	 */
	remove(handle: unknown, workspace: unknown, path: unknown, expectedVersion: unknown, operationId: unknown): Promise<{ status: "removed" }> {
		return this.withSession(handle, async (s, space) => {
			const ws = schema.canonicalName(workspace, this.limits.maxNameBytes);
			const segs = parsePath(path, "remove", this.limits);
			if (expectedVersion !== undefined && expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1)) throw new schema.InvalidInput("expectedVersion must be a positive integer");
			const expected = (expectedVersion ?? null) as number | null;
			const id = verifyOperationId(this.state, s, operationId, this.limits);
			const d = spaceData(space);
			const digest = requestDigest("remove", { workspace: ws, path: pathString(segs), expectedVersion: expected });
			const root = segs.length === 0;
			// the parent first (it stays), so a retry after a lost reply is authorized like the call and answers from its
			// receipt; a removed workspace has no parent left, and its remover's own receipt answers the retry
			if (!root && !atLeast((await resolve(d, s, ws, segs.slice(0, -1), { limits: this.limits })).role, "editor")) throw new schema.PermissionDenied("remove needs editor on the parent");
			const done = await lookupReceipt(space, s, id.operationId, digest);
			if (done) return { status: "removed" as const };
			const r = await resolve(d, s, ws, segs, { limits: this.limits });
			if (root ? !atLeast(r.role, "owner") : !atLeast(r.role, "editor")) throw new schema.PermissionDenied(root ? "removing a workspace needs owner on its root" : "remove needs editor on the node");
			const node = r.node;
			if (node.kind === "dir" && await space.readIfExists({ type: schema.T.node, fields: { parentId: node.nodeId } }, 0)) throw new schema.InvalidInput("the directory is not empty");
			if (root && await space.readIfExists({ type: schema.T.actor, fields: { homeNodeId: node.nodeId, state: "enabled" } }, 0) || root && await space.readIfExists({ type: schema.T.actor, fields: { homeNodeId: node.nodeId, state: "disabled" } }, 0))
				throw new schema.InvalidInput("a workspace that is an actor's home is removed with the actor");
			const takes: Array<{ type: string; fields: Record<string, string> }> = [{ type: schema.T.node, fields: { nodeId: node.nodeId, parentId: node.parentId, name: node.name } }];
			const replaced: EntryDraft[] = [schema.node(node.nodeId, node.parentId, node.name, node.kind)];
			let drop: { blobId: string; size: number } | undefined;
			if (node.kind === "file") {
				const cur = await this.#contentRow(s.tenantId, space, node);
				if (expected !== null && cur.version !== expected) throw new schema.VersionConflict(cur.version);
				takes.push({ type: schema.T.content, fields: { nodeId: node.nodeId, blobId: cur.ref.blobId } });
				replaced.push(schema.content(node.nodeId, cur.version, cur.ref));
				drop = { blobId: cur.ref.blobId, size: cur.ref.size };
			} else if (expected !== null) throw new schema.InvalidInput("expectedVersion is a file's");
			const rels = await space.readAll({ type: schema.T.relation, fields: { objectKind: "node", objectId: node.nodeId } }, { limit: this.limits.maxGrantsPerTarget + 2 });
			if (rels.length > this.limits.maxGrantsPerTarget + 1) throw new schema.CapacityExceeded(`more than ${this.limits.maxGrantsPerTarget} grants on one target`);
			for (const e of rels) { takes.push({ type: schema.T.relation, fields: { ...(e.fields as Record<string, string>) } }); replaced.push({ type: schema.T.relation, fields: e.fields }); }
			const rows = [receiptRow(s, id, digest, { status: "removed" })];
			await this.#admitRows(s, space, { id, operation: "remove", targets: [node.nodeId], rows, replaced });
			await this.#commitMutation(s, space, id, "remove", [node.nodeId], rows, null, takes, drop);
			return { status: "removed" as const };
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
			return this.#grantsOn(space, r.node.nodeId);
		});
	}

	/** The restricted children of a directory: their markers name it as subject (one lookup, bounded). */
	async #restrictedChildren(space: PhiSpaces, dirId: string): Promise<string[]> {
		const rows = await space.readAll({ type: schema.T.relation, fields: { objectKind: "node", relation: RESTRICTED, subjectKind: "node", subjectId: dirId } }, { limit: this.limits.maxDirEntries + 1 });
		if (rows.length > this.limits.maxDirEntries) throw new schema.CapacityExceeded(`a directory holds more than ${this.limits.maxDirEntries} entries`);
		return rows.map((e) => e.fields.objectId as string);
	}

	async #grantsOn(space: PhiSpaces, nodeId: string): Promise<Array<{ relation: string; subject: Subject }>> {
		const rels = await space.readAll({ type: schema.T.relation, fields: { objectKind: "node", objectId: nodeId } }, { limit: this.limits.maxGrantsPerTarget + 1 });
		if (rels.length > this.limits.maxGrantsPerTarget) throw new schema.CapacityExceeded(`more than ${this.limits.maxGrantsPerTarget} grants on one target`);
		return rels.map((e) => e.fields as unknown as RelRow).filter((x) => x.relation !== RESTRICTED).map((x) => ({ relation: x.relation, subject: subjectOf(x) }))
			.sort((a, b) => byName(a.relation, b.relation) || byName(a.subject.kind, b.subject.kind) || byName(a.subject.id, b.subject.id));
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
			return this.#applyGrant(s, space, id, digest, op, op, r.node, relation, subj);
		});
	}

	/** One grant or revocation after its authorization: receipt, validation, idempotence, final owner, budgets, commit. */
	async #applyGrant(s: Session, space: PhiSpaces, id: VerifiedOpId, digest: string, op: string, action: "grant" | "revoke", node: NodeRow, relation: string, subj: Subject): Promise<{ status: string }> {
		{
			const d = spaceData(space);
			const done = await lookupReceipt(space, s, id.operationId, digest);
			if (done) return { status: done.status as string };
			const target = node.nodeId;
			const tuple: RelRow = action === "grant" ? await checkGrant(d, node, relation, subj) : { objectKind: "node", objectId: target, relation, ...subjectRow(subj) };
			const present = await this.#has(space, schema.relation("node", target, tuple.relation, tuple.subjectKind, tuple.subjectId, tuple.subjectRelation));
			if (action === "grant") {
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
			if (node.parentId === schema.WORKSPACES) await checkLastOwner(d, target, { remove: [tuple] }, { limits: this.limits });
			const rows = [receiptRow(s, id, digest, { status: "revoked" })];
			await this.#securityAdmit(s, space, { id, operation: op, targets: [target], rows }, { operation: op, target, relation: tuple.relation, subject: subjectRow(subj) });
			await this.#commitMutation(s, space, id, op, [target], rows, null, [{ type: schema.T.relation, fields: { ...tuple } }]);
			return { status: "revoked" };
		}
	}

	/**
	 * Restricts a node below its workspace root (section 4, restricted children; owner on it): inheritance stops there
	 * except for owner, so the node and everything below it leave the view of every viewer and editor of the directories
	 * above who holds no grant on it, at once. `unrestrict` lifts it (owner on it). Both are idempotent with a receipt;
	 * a workspace root is a boundary already (`invalidInput`).
	 */
	restrict(handle: unknown, workspace: unknown, path: unknown, operationId: unknown): Promise<{ status: "restricted" | "unchanged" }> {
		return this.#putRestriction("restrict", handle, workspace, path, operationId) as Promise<{ status: "restricted" | "unchanged" }>;
	}
	unrestrict(handle: unknown, workspace: unknown, path: unknown, operationId: unknown): Promise<{ status: "unrestricted" | "unchanged" }> {
		return this.#putRestriction("unrestrict", handle, workspace, path, operationId) as Promise<{ status: "unrestricted" | "unchanged" }>;
	}

	#putRestriction(op: "restrict" | "unrestrict", handle: unknown, workspace: unknown, path: unknown, operationId: unknown): Promise<{ status: string }> {
		return this.withSession(handle, async (s, space) => {
			const ws = schema.canonicalName(workspace, this.limits.maxNameBytes);
			const segs = parsePath(path, op, this.limits);
			const id = verifyOperationId(this.state, s, operationId, this.limits);
			const d = spaceData(space);
			const r = await resolve(d, s, ws, segs, { limits: this.limits });
			if (!atLeast(r.role, "owner")) throw new schema.PermissionDenied(`${op} needs owner on the target`);
			if (r.parent === null) throw new schema.InvalidInput("a workspace root is not restricted: it is a boundary already");
			const digest = requestDigest(op, { workspace: ws, path: pathString(segs) });
			const done = await lookupReceipt(space, s, id.operationId, digest);
			if (done) return { status: done.status as string };
			const marker = schema.relation("node", r.node.nodeId, RESTRICTED, "node", r.parent.nodeId);
			const present = await isRestricted(d, r.node.nodeId);
			const target = r.node.nodeId;
			if (op === "restrict" && !present) {
				const rows = [marker, receiptRow(s, id, digest, { status: "restricted" })];
				await this.#admitRows(s, space, { id, operation: op, targets: [target], rows, demand: { relations: 1, grantsOn: { nodeId: target, n: 1 } } });
				await this.#commitMutation(s, space, id, op, [target], rows, null);
				return { status: "restricted" };
			}
			if (op === "unrestrict" && present) {
				const rows = [receiptRow(s, id, digest, { status: "unrestricted" })];
				await this.#admitRows(s, space, { id, operation: op, targets: [target], rows });
				await this.#commitMutation(s, space, id, op, [target], rows, null, [{ type: schema.T.relation, fields: { ...(marker.fields as Record<string, string>) } }]);
				return { status: "unrestricted" };
			}
			const rows = [receiptRow(s, id, digest, { status: "unchanged" })];
			await this.#admitRows(s, space, { id, operation: op, targets: [target], rows });
			await this.#commitMutation(s, space, id, op, [target], rows, null);
			return { status: "unchanged" };
		});
	}

	/**
	 * Adds or removes one group membership (an admin operation: an enabled `tenant#admin` user, section 5). Both are
	 * idempotent; adding validates the subject (an existing non-deleted user or agent, or another group without a cycle
	 * and within the nesting depth). Removing a
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
		return this.#session("admin", handle, async (s, space) => {
			const g = schema.groupId(group, this.limits.maxNameBytes);
			const subj = parseSubject(subject, this.limits.maxNameBytes);
			const id = verifyOperationId(this.state, s, operationId, this.limits);
			await this.#requireAdmin(s, space, op, id);
			const d = spaceData(space);
			const digest = requestDigest(op, { group: g, subject: subjectRow(subj) });
			const done = await lookupReceipt(space, s, id.operationId, digest);
			if (done) return { status: done.status as string };
			const tuple: RelRow = op === "addMember" ? await checkMembership(d, g, subj, { limits: this.limits }) : { objectKind: "group", objectId: g, relation: "member", ...subjectRow(subj) };
			const row = schema.relation("group", g, "member", tuple.subjectKind, tuple.subjectId, tuple.subjectRelation);
			const present = await this.#has(space, row);
			if (op === "addMember") {
				const status = present ? "unchanged" : "added";
				const rows = [...(present ? [] : [row]), receiptRow(s, id, digest, { status })];
				await this.#admitRows(s, space, { id, operation: op, targets: [], rows, demand: present ? {} : { relations: 1, groups: subj.kind === "group" ? [g, subj.id] : [g] } });
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
		return this.#session("admin", handle, async (s, space) => {
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

	// ---------------------------------------------------------------- admin operations (sections 3 and 5)

	/**
	 * Registers an actor (an admin operation, section 5): like `provisionActor`, with the caller's session and an
	 * operation ID, its receipt and audit row in the same transaction.
	 */
	async registerActor(handle: unknown, kind: unknown, actorId: unknown, homeName: unknown, identity: unknown, operationId: unknown): Promise<{ actorId: string; homeNodeId: string }> {
		if (kind !== "user" && kind !== "agent") throw new schema.InvalidInput(`unknown actor kind ${JSON.stringify(kind)}`);
		const ident = schema.identityOf(kind, identity);
		const aid = schema.actorId(actorId);
		const name = schema.canonicalName(homeName, this.limits.maxNameBytes);
		let tenant = "";
		const r = await this.#session("admin", handle, async (s, space) => {
			tenant = s.tenantId;
			const id = verifyOperationId(this.state, s, operationId, this.limits);
			await this.#requireAdmin(s, space, "registerActor", id);
			const digest = requestDigest("registerActor", { kind, actorId: aid, homeName: name, identity: ident as Record<string, string> });
			const done = await lookupReceipt(space, s, id.operationId, digest);
			if (done) return { actorId: aid, homeNodeId: done.homeNodeId as string };
			if (await space.readIfExists({ type: schema.T.actor, fields: { actorKind: kind, actorId: aid } }, 0)) throw new schema.AlreadyExists(`actor ${kind}:${aid} exists`);
			if (await childNamed(spaceData(space), schema.WORKSPACES, name)) throw new schema.AlreadyExists("a workspace of that name exists");
			if (await space.readIfExists(schema.identityTemplate(kind, ident), 0)) throw new schema.AlreadyExists("that identity is bound to another actor");
			const homeNodeId = await this.#freshNodeId(space);
			const rows = [schema.actor(kind, aid, homeNodeId, ident), schema.node(homeNodeId, schema.WORKSPACES, name, "dir"), schema.relation("node", homeNodeId, "owner", kind, aid), receiptRow(s, id, digest, { homeNodeId })];
			await this.#admitRows(s, space, { id, operation: "registerActor", targets: [homeNodeId], rows, demand: { actors: 1, workspaces: 1, nodes: 1, relations: 1 } });
			await this.#commitMutation(s, space, id, "registerActor", [homeNodeId], rows, null);
			return { actorId: aid, homeNodeId };
		});
		if (kind === "user") this.state.addLogin((ident as schema.UserIdentity).issuer, (ident as schema.UserIdentity).subject, tenant);
		return r;
	}

	/**
	 * Disables an actor (section 3, actor lifecycle): its relations stay but become inert. It refuses with `lastOwner`
	 * while the actor is the last enabled direct owner of a workspace root, unless `replacementOwners` names, per such
	 * workspace, an enabled direct user or agent other than the actor, granted owner in the same transaction; and with
	 * `lastAdmin` while it is the last enabled administrator. Disabling a disabled actor with no replacements is a
	 * successful no-op; with replacements it is `invalidInput`, as is an unknown or deleted actor. A security action.
	 */
	disableActor(handle: unknown, actor: unknown, replacementOwners: unknown, operationId: unknown): Promise<{ status: "disabled" | "unchanged" }> {
		return this.#lifecycle("disableActor", handle, actor, replacementOwners, operationId) as Promise<{ status: "disabled" | "unchanged" }>;
	}

	/** Deletes an actor: its relations are removed and the row stays as a tombstone, in one transaction (section 3). The
	 *  owner and admin rules are those of `disableActor`; relations beyond one transaction's budget are `capacityExceeded`
	 *  and change nothing: disable the actor first and revoke them in batches. */
	deleteActor(handle: unknown, actor: unknown, replacementOwners: unknown, operationId: unknown): Promise<{ status: "deleted" }> {
		return this.#lifecycle("deleteActor", handle, actor, replacementOwners, operationId) as Promise<{ status: "deleted" }>;
	}

	/** Enables a disabled actor; an enabled one is a successful no-op, an unknown or deleted one `invalidInput`. */
	enableActor(handle: unknown, actor: unknown, operationId: unknown): Promise<{ status: "enabled" | "unchanged" }> {
		return this.#lifecycle("enableActor", handle, actor, undefined, operationId) as Promise<{ status: "enabled" | "unchanged" }>;
	}

	#lifecycle(op: "disableActor" | "deleteActor" | "enableActor", handle: unknown, actor: unknown, replacementOwners: unknown, operationId: unknown): Promise<{ status: string }> {
		return this.#session("admin", handle, async (s, space) => {
			const target = parseSubject(actor, this.limits.maxNameBytes);
			if (target.kind === "group") throw new schema.InvalidInput("an actor is a user or an agent");
			const replacements = parseReplacements(replacementOwners, this.limits.maxNameBytes);
			if (op === "enableActor" && replacements.length) throw new schema.InvalidInput("enableActor takes no replacement owners");
			const id = verifyOperationId(this.state, s, operationId, this.limits);
			await this.#requireAdmin(s, space, op, id);
			const d = spaceData(space);
			const digest = requestDigest(op, { actor: subjectRow(target), replacementOwners: replacements.map((r) => ({ workspace: r.workspace, owner: subjectRow(r.owner) })) });
			const done = await lookupReceipt(space, s, id.operationId, digest);
			if (done) return { status: done.status as string };
			const row = await space.readIfExists({ type: schema.T.actor, fields: { actorKind: target.kind, actorId: target.id } }, 0);
			if (row === null || row.fields.state === "deleted") throw new schema.InvalidInput("unknown or deleted actor");
			const state = row.fields.state as string;
			const key = { actorKind: target.kind, actorId: target.id };
			const successor = (next: string) => ({ type: schema.T.actor, fields: { ...row.fields, state: next } });
			const noop = async (status: string) => {
				const rows = [receiptRow(s, id, digest, { status })];
				await this.#admitRows(s, space, { id, operation: op, targets: [], rows });
				await this.#commitMutation(s, space, id, op, [], rows, null);
				return { status };
			};

			if (op === "enableActor") {
				if (state === "enabled") return noop("unchanged");
				const rows = [successor("enabled"), receiptRow(s, id, digest, { status: "enabled" })];
				await this.#admitRows(s, space, { id, operation: op, targets: [], rows, replaced: [{ type: schema.T.actor, fields: row.fields }] });
				await this.#commitMutation(s, space, id, op, [], rows, null, [{ type: schema.T.actor, fields: key }]);
				return { status: "enabled" };
			}
			if (op === "disableActor" && state === "disabled") {
				if (replacements.length) throw new schema.InvalidInput("the actor is already disabled: no replacement owners");
				return noop("unchanged");
			}

			// the workspace roots it owns directly, each needing an enabled direct owner after the change
			const own = await space.readAll({ type: schema.T.relation, fields: { objectKind: "node", relation: "owner", subjectKind: target.kind, subjectId: target.id, subjectRelation: schema.DIRECT } }, { limit: this.limits.maxWorkspaces + 1 });
			const roots: NodeRow[] = [];
			for (const r of own) { const n = await d.node(r.fields.objectId as string); if (n?.parentId === schema.WORKSPACES) roots.push(n); }
			const add: RelRow[] = [];
			for (const rep of replacements) {
				const root = await childNamed(d, schema.WORKSPACES, rep.workspace);
				if (root === null || !roots.some((x) => x.nodeId === root.nodeId)) throw new schema.InvalidInput("a replacement names a workspace the actor does not own");
				if (rep.owner.kind === target.kind && rep.owner.id === target.id) throw new schema.InvalidInput("a replacement owner must be another actor");
				const a = await d.actor(rep.owner.kind, rep.owner.id);
				if (a?.state !== "enabled") throw new schema.InvalidInput("a replacement owner must be enabled");
				add.push({ objectKind: "node", objectId: root.nodeId, relation: "owner", ...subjectRow(rep.owner) });
			}
			const ref = { actorKind: target.kind, actorId: target.id };
			const removing = op === "deleteActor"
				? (await space.readAll({ type: schema.T.relation, fields: { subjectKind: target.kind, subjectId: target.id, subjectRelation: schema.DIRECT } }, { limit: this.limits.maxDeleteRelations + 1 })).map((e) => e.fields as unknown as RelRow)
				: [];
			if (removing.length > this.limits.maxDeleteRelations) throw new schema.CapacityExceeded(`the actor holds more than ${this.limits.maxDeleteRelations} relations: disable it and revoke them in batches first`);
			for (const root of roots) await checkLastOwner(d, root.nodeId, { disable: [ref], remove: removing, add }, { limits: this.limits });
			if (target.kind === "user") await checkLastAdmin(d, s.tenantId, { disable: [ref], remove: removing }, { limits: this.limits });
			const next = op === "deleteActor" ? "deleted" : "disabled";
			const newRels = [];
			for (const r of add) { const rel = schema.relation("node", r.objectId, "owner", r.subjectKind, r.subjectId); if (!(await this.#has(space, rel))) newRels.push(rel); }
			const rows = [successor(next), ...newRels, receiptRow(s, id, digest, { status: next })];
			const takes = [{ type: schema.T.actor, fields: key }, ...removing.map((r) => ({ type: schema.T.relation, fields: { ...r } }))];
			// the whole state transition must fit one transaction, or nothing changes (section 3, actor lifecycle)
			const commit = rows.reduce((n, r) => n + encodedBytes(r.fields) + 256, 0) + takes.reduce((n, t) => n + encodedBytes(t.fields) + 256, 0) + 4096;
			if (commit > DEFAULT_LIMITS.maxCommitBytes || takes.length + rows.length > this.limits.maxDeleteRelations + 64)
				throw new schema.CapacityExceeded("the state transition does not fit one transaction: disable first, then revoke in batches");
			const spec: AdmitSpec = { id, operation: op, targets: roots.map((r) => r.nodeId), rows, demand: newRels.length ? { relations: newRels.length } : {}, replaced: [{ type: schema.T.actor, fields: row.fields }] };
			if (op === "disableActor") await this.#securityAdmit(s, space, spec, { operation: op, actor: subjectRow(target) });
			else await this.#admitRows(s, space, spec);
			await this.#commitMutation(s, space, id, op, spec.targets, rows, null, takes);
			return { status: next };
		});
	}

	/** Grants or revokes `tenant#admin` for an existing non-deleted user (idempotent both). A revoke keeps the last
	 *  enabled administrator and is a security action. */
	grantTenantAdmin(handle: unknown, user: unknown, operationId: unknown): Promise<{ status: "granted" | "unchanged" }> {
		return this.#tenantAdmin("grantTenantAdmin", handle, user, operationId) as Promise<{ status: "granted" | "unchanged" }>;
	}
	revokeTenantAdmin(handle: unknown, user: unknown, operationId: unknown): Promise<{ status: "revoked" | "unchanged" }> {
		return this.#tenantAdmin("revokeTenantAdmin", handle, user, operationId) as Promise<{ status: "revoked" | "unchanged" }>;
	}

	#tenantAdmin(op: "grantTenantAdmin" | "revokeTenantAdmin", handle: unknown, user: unknown, operationId: unknown): Promise<{ status: string }> {
		return this.#session("admin", handle, async (s, space) => {
			const uid = schema.actorId(user, "user ID");
			const id = verifyOperationId(this.state, s, operationId, this.limits);
			await this.#requireAdmin(s, space, op, id);
			const d = spaceData(space);
			const digest = requestDigest(op, { user: uid });
			const done = await lookupReceipt(space, s, id.operationId, digest);
			if (done) return { status: done.status as string };
			const tuple = await checkTenantAdmin(d, s.tenantId, uid);
			const row = schema.relation("tenant", s.tenantId, "admin", "user", uid);
			const present = await this.#has(space, row);
			if (op === "grantTenantAdmin") {
				const status = present ? "unchanged" : "granted";
				const rows = [...(present ? [] : [row]), receiptRow(s, id, digest, { status })];
				await this.#admitRows(s, space, { id, operation: op, targets: [], rows, demand: present ? {} : { relations: 1 } });
				await this.#commitMutation(s, space, id, op, [], rows, null);
				return { status };
			}
			const status = present ? "revoked" : "unchanged";
			const rows = [receiptRow(s, id, digest, { status })];
			if (present) {
				await checkLastAdmin(d, s.tenantId, { remove: [tuple] }, { limits: this.limits });
				await this.#securityAdmit(s, space, { id, operation: op, targets: [], rows }, { operation: op, user: uid });
			} else await this.#admitRows(s, space, { id, operation: op, targets: [], rows });
			await this.#commitMutation(s, space, id, op, [], rows, null, present ? [{ type: schema.T.relation, fields: { ...tuple } }] : []);
			return { status };
		});
	}

	/** Admin inspection (section 5), in deterministic order and bounded like `list`; no file rights needed or given. */
	listWorkspaces(handle: unknown): Promise<Array<{ name: string; nodeId: string }>> {
		return this.#adminRead(handle, "listWorkspaces", async (space) => {
			const roots = await space.readAll({ type: schema.T.node, fields: { parentId: schema.WORKSPACES } }, { limit: this.limits.maxWorkspaces + 1 });
			if (roots.length > this.limits.maxWorkspaces) throw new schema.CapacityExceeded(`more than ${this.limits.maxWorkspaces} workspaces`);
			return roots.map((r) => ({ name: r.fields.name as string, nodeId: r.fields.nodeId as string })).sort((a, b) => byName(a.name, b.name));
		});
	}
	listActors(handle: unknown): Promise<Array<{ kind: schema.ActorKind; id: string; state: string; homeNodeId: string }>> {
		return this.#adminRead(handle, "listActors", async (space) => {
			const rows = await space.readAll({ type: schema.T.actor }, { limit: this.limits.maxActors + 1 });
			if (rows.length > this.limits.maxActors) throw new schema.CapacityExceeded(`more than ${this.limits.maxActors} actors`);
			return rows.map((r) => ({ kind: r.fields.actorKind as schema.ActorKind, id: r.fields.actorId as string, state: r.fields.state as string, homeNodeId: r.fields.homeNodeId as string }))
				.sort((a, b) => byName(a.kind, b.kind) || byName(a.id, b.id));
		});
	}
	listGroups(handle: unknown): Promise<string[]> {
		return this.#adminRead(handle, "listGroups", (space) => listGroups(space, { limits: this.limits }));
	}
	listGroupMembers(handle: unknown, group: unknown): Promise<Subject[]> {
		return this.#adminRead(handle, "listGroupMembers", (space) => membersOf(spaceData(space), schema.groupId(group, this.limits.maxNameBytes), { limits: this.limits }));
	}

	#adminRead<T>(handle: unknown, op: string, read: (space: PhiSpaces) => Promise<T>): Promise<T> {
		return this.#session("admin", handle, async (s, space) => { await this.#requireAdmin(s, space, op, null); return read(space); });
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
	#isAdmin(s: Session, space: PhiSpaces): Promise<boolean> {
		return s.actorKind === "user" ? this.#has(space, schema.relation("tenant", s.tenantId, "admin", "user", s.actorId)) : Promise.resolve(false);
	}

	async #requireAdmin(s: Session, space: PhiSpaces, operation: string, id: VerifiedOpId | null): Promise<void> {
		if (await this.#isAdmin(s, space)) return;
		// refusals of one actor and operation within the window share one row: its count and last time grow, the
		// audit does not (a caller asking again and again cannot fill it)
		const now = this.state.now();
		const recent = (await space.readAll({ type: schema.T.audit, fields: { outcome: "denied", actorKind: s.actorKind, actorId: s.actorId, operation } }))
			.filter((r) => (r.fields.time as number) >= now - this.limits.deniedAuditWindowMs)
			.sort((a, b) => (b.fields.seq as number) - (a.fields.seq as number))[0];
		if (recent) {
			const fields = { ...recent.fields, count: ((recent.fields.count as number | undefined) ?? 1) + 1, lastTime: now };
			assertRowFits(fields, DEFAULT_LIMITS);
			await space.batch([
				{ op: "take", template: { type: schema.T.audit, fields: { seq: recent.fields.seq as number } } },
				{ op: "write", entry: { type: schema.T.audit, fields }, lease: FOREVER },
			]);
		} else {
			await this.#admitRows(s, space, { id: null, operation, targets: [], rows: [] });
			const seq = (await this.#lastSeq(s.tenantId, space)) + 1;
			const row = schema.audit(seq, now, { kind: s.actorKind, id: s.actorId }, operation, [], id?.operationId ?? "", "denied");
			await this.#writeAll(s.tenantId, space, [{ ...row, fields: { ...row.fields, count: 1, lastTime: now } }]);
			this.#seq.set(s.tenantId, seq);
		}
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

	/**
	 * After the deployment state came back from its backup (section 6.6, loss): the time floor rises to the newest time
	 * any tenant recorded (audit rows, receipts), the session epoch advances (every session ends), a new signing
	 * generation retires all earlier ones (every operation ID ends; content keys stay), the sequence number goes beyond
	 * the data's mirror, and the service waits in maintenance mode for the reconciliation of every tenant.
	 */
	async #bringStateForward(markerSeq: number): Promise<void> {
		let newest = 0;
		for (const t of await this.tenants()) await this.#inSpace(t, async (space) => {
			for (const r of await space.readAll({ type: schema.T.audit })) newest = Math.max(newest, Number(r.fields.time) || 0, Number(r.fields.lastTime) || 0);
			for (const r of await space.readAll({ type: schema.T.receipt })) newest = Math.max(newest, (Number(r.fields.expiry) || 0) - this.limits.retryWindowMs);
		});
		this.state.commitFloor(newest);
		this.state.acceptClock();
		this.state.advanceEpoch();
		this.state.rotateKeyRetiringAll();
		this.state.raiseSeq(markerSeq + 1);
		this.state.beginModeTransition("maintenance");
		this.state.completeModeTransition();
		// the state's loss opens a restore like a data restore: every tenant is reconciled before normal admission
		this.state.journalRestore("checked", { archive: "deployment state", epoch: this.state.epoch(), tenants: [] });
	}

	/**
	 * After a restore (section 6.5): every content row of every tenant must name a blob that exists, sealed with a
	 * content-key generation the deployment state holds. A tenant that fails is closed durably as `inconsistentState`
	 * (it stays closed across restarts until the operator repairs it); the others are untouched.
	 */
	async checkRestoredBlobs(): Promise<Array<{ tenantId: string; contents: number; missing: number }>> {
		const out: Array<{ tenantId: string; contents: number; missing: number }> = [];
		for (const t of await this.tenants()) {
			let contents = 0, missing = 0;
			await this.#inSpace(t, async (space) => {
				for (const r of await space.readAll({ type: schema.T.content })) {
					contents++;
					const ok = this.state.contentKeyFor(r.fields.keyGeneration as number) !== undefined && (await this.blobs.exists(t, r.fields.blobId as string));
					if (!ok) missing++;
				}
			});
			if (missing > 0) {
				console.error(`[files] tenant ${t} suspended after a restore: ${missing} of ${contents} contents lack their blob or key`);
				this.state.closeTenant(t, "inconsistentState", { restoredBlobsMissing: missing });
				this.admission.suspend(t, "inconsistentState");
			}
			out.push({ tenantId: t, contents, missing });
		}
		return out;
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
		takes: Array<{ type: string; fields: Record<string, string> }> = [], drop?: { blobId: string; size: number }): Promise<void> {
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
				// a successor of a row taken above is written without a uniqueness check: the check would find the
				// reserved row it replaces (section 3, leases and uniqueness)
				const replacing = (save?.replace && e.type === schema.T.content) || takes.some((t) => t.type === e.type && Object.entries(t.fields).every(([k, v]) => e.fields[k] === v));
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
		if (drop) {
			// a removed file: its bytes leave the quota, its blob goes after the commit (or to the sweep)
			const n = this.#contentBytes.get(s.tenantId);
			if (n !== undefined) this.#contentBytes.set(s.tenantId, n - drop.size);
			await this.#fault("afterCommit");
			await this.blobs.delete(s.tenantId, drop.blobId).catch(() => false);
		}
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

/** Replacement owners as a caller names them: `[{workspace, owner: {kind: "user" | "agent", id}}]`, at most one per
 *  workspace, sorted by workspace name for the digest. */
function parseReplacements(v: unknown, maxNameBytes: number): Array<{ workspace: string; owner: Subject }> {
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v) || v.length > 64) throw new schema.InvalidInput("replacementOwners is a list of at most 64 {workspace, owner}");
	const out = v.map((x) => {
		const o = (x ?? {}) as { workspace?: unknown; owner?: unknown };
		const owner = parseSubject(o.owner, maxNameBytes);
		if (owner.kind === "group") throw new schema.InvalidInput("a replacement owner is a user or an agent, never a group");
		return { workspace: schema.canonicalName(o.workspace, maxNameBytes), owner };
	}).sort((a, b) => byName(a.workspace, b.workspace));
	if (new Set(out.map((r) => r.workspace)).size !== out.length) throw new schema.InvalidInput("one replacement owner per workspace");
	return out;
}
