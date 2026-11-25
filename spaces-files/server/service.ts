// The filesystem service's store and admission (docs/zanzibar-agent-filesystem-plan.en.md, sections 2 and 6.1): one
// process opens phi-spaces' own SQLite store, which holds an exclusive owner lock beside the file (a second process is
// refused, a crash releases it), runs the reaper and gives each tenant a private named Space reached only through its
// queue. Nothing here serves a Space to anyone: the tenant Spaces are never exposed.
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { openOwnMemoryHost, type OwnStoreHost } from "phi-spaces/store/host";
import { openSqliteHost } from "phi-spaces/store/sqlite";
import { createSpace, listSpaces, PhiSpaces, startService } from "phi-spaces";
import { FOREVER, UniqueConflict } from "phi-spaces/core";
import { Admission, Unavailable, type AdmissionOptions } from "./admission.ts";
import { DeploymentState, type DeploymentOptions } from "./deployment.ts";
import { assertSeparateDirs, prepareDataDir } from "./dirs.ts";
import * as schema from "./schema.ts";

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

/** A durable schema invariant does not hold: an unknown version, or rows where a fresh initialization expects none. */
export class InconsistentState extends Error {
	readonly code = "inconsistentState";
	constructor(message: string) { super(message); this.name = "InconsistentState"; }
}

/** The first administrator of a new tenant, as the host operator supplies it: a user with its verified identity. */
export type FirstAdmin = { actorId: string; homeName: string; issuer: string; subject: string };
export type CreateTenantResult =
	| { status: "created"; tenantId: string; actorId: string; homeNodeId: string }
	| { status: "alreadyExists"; tenantId: string };

export function tenantAlias(tenantId: string): string {
	if (typeof tenantId !== "string" || !TENANT_ID.test(tenantId)) throw new InvalidTenant(tenantId);
	return `t-${tenantId}`;
}

export type FilesServiceOptions = AdmissionOptions & {
	/** The data directory; `null` keeps everything in memory (tests). */
	dataDir: string | null;
	/** The deployment-state directory (section 6.6), never inside the data directory or around it; `null`: in memory. */
	stateDir: string | null;
	now?: () => number;
	state?: Omit<DeploymentOptions, "dir">;
};

export class FilesService {
	readonly admission: Admission;
	readonly host: OwnStoreHost;
	readonly storePath: string | null;
	readonly state: DeploymentState;
	readonly #stopService: () => Promise<void>;
	readonly #now: () => number;
	/** Tenants whose FsMeta this process has seen committed; FsMeta is never removed while the store is open. */
	readonly #ready = new Set<string>();
	#closed = false;

	private constructor(host: OwnStoreHost, state: DeploymentState, stopService: () => Promise<void>, storePath: string | null, o: FilesServiceOptions) {
		this.host = host;
		this.state = state;
		this.storePath = storePath;
		this.#stopService = stopService;
		this.admission = new Admission(o);
		this.#now = o.now ?? Date.now;
	}

	static async open(o: FilesServiceOptions): Promise<FilesService> {
		if (o.dataDir !== null && o.stateDir !== null) assertSeparateDirs(o.dataDir, o.stateDir);
		// the deployment state first: it decides about sessions and keys before any tenant is served
		const state = await DeploymentState.open({ clock: o.now, ...o.state, dir: o.stateDir });
		let host: OwnStoreHost | undefined, storePath: string | null = null, service: FilesService;
		try {
			if (o.dataDir === null) host = openOwnMemoryHost();
			else {
				await prepareDataDir(o.dataDir);
				storePath = join(o.dataDir, STORE_FILE);
				host = await openSqliteHost(storePath);
			}
			// the reaper clears reservations of transactions abandoned by a crash (section 6.1)
			const stop = await startService(host, ctx, { now: o.now, watchDebounceMs: 50 });
			service = new FilesService(host, state, stop, storePath, o);
		} catch (e) { await host?.close(ctx); state.close(); throw e; }
		// the login index is a lookup aid derived from the FsActor rows: rebuilt on every start (section 6.6)
		try { await service.rebuildLoginIndex(); } catch (e) { await service.close(); throw e; }
		return service;
	}

	/** Runs `op` in the tenant's queue with that tenant's private Space, once its initialization has committed (section 2). */
	inTenant<T>(tenantId: string, op: (space: PhiSpaces) => Promise<T>): Promise<T> {
		return this.#inSpace(tenantId, async (space) => {
			if (!this.#ready.has(tenantId)) {
				if (!(await this.#checkMeta(tenantId, space))) throw new TenantProvisioning(tenantId);
				this.#ready.add(tenantId);
			}
			return op(space);
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
		const homeName = schema.canonicalName(admin.homeName);
		const identity = { issuer: schema.identityPart(admin.issuer, "issuer"), subject: schema.identityPart(admin.subject, "subject") };
		await this.reserveTenantSpace(tenantId);
		const r = await this.#inSpace(tenantId, async (space): Promise<CreateTenantResult> => {
			if (await this.#checkMeta(tenantId, space)) return { status: "alreadyExists", tenantId };
			// a Space in provisioning holds nothing yet: the batch below would refuse leftovers by their keys anyway
			if ((await space.count(null)) !== 0) throw new InconsistentState(`tenant ${tenantId}: rows in a Space without FsMeta`);
			const homeNodeId = schema.newNodeId();
			const ops = [
				schema.meta(tenantId),
				schema.actor("user", id, homeNodeId, identity),
				schema.node(homeNodeId, schema.WORKSPACES, homeName, "dir"),
				schema.relation("tenant", tenantId, "admin", "user", id),
				schema.relation("node", homeNodeId, "owner", "user", id),
				schema.audit(1, this.state.now(), { kind: "operator", id: "" }, "createTenant", [homeNodeId], "", "ok"),
			].map((entry) => ({ op: "write" as const, entry, lease: FOREVER, unique: schema.KEY[entry.type as keyof typeof schema.KEY] }));
			try { await space.batch(ops); }
			catch (e) { if (e instanceof UniqueConflict) throw new InconsistentState(`tenant ${tenantId}: ${e.message}`); throw e; }
			this.#ready.add(tenantId);
			return { status: "created", tenantId, actorId: id, homeNodeId };
		});
		if (r.status === "created") this.state.addLogin(identity.issuer, identity.subject, tenantId);
		return r;
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
