// The filesystem service's store and admission (docs/zanzibar-agent-filesystem-plan.en.md, sections 2 and 6.1): one
// process opens phi-spaces' own SQLite store, which holds an exclusive owner lock beside the file (a second process is
// refused, a crash releases it), runs the reaper and gives each tenant a private named Space reached only through its
// queue. Nothing here serves a Space to anyone: the tenant Spaces are never exposed.
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { openOwnMemoryHost, type OwnStoreHost } from "phi-spaces/store/host";
import { openSqliteHost } from "phi-spaces/store/sqlite";
import { createSpace, listSpaces, PhiSpaces, startService } from "phi-spaces";
import { Admission, type AdmissionOptions } from "./admission.ts";
import { DeploymentState, type DeploymentOptions } from "./deployment.ts";
import { assertSeparateDirs, prepareDataDir } from "./dirs.ts";

export { prepareDataDir } from "./dirs.ts";

/** The store file inside the data directory. */
export const STORE_FILE = "files.sqlite";

/** A tenant ID: 1 to 62 of a-z 0-9 _ - starting with a letter or digit, so that its Space alias `t-<id>` is valid. */
const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,61}$/;

export class InvalidTenant extends Error {
	readonly code = "invalidInput";
	constructor(id: unknown) { super(`invalid tenant ID ${JSON.stringify(id)}`); this.name = "InvalidTenant"; }
}

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
		let host: OwnStoreHost | undefined, storePath: string | null = null;
		try {
			if (o.dataDir === null) host = openOwnMemoryHost();
			else {
				await prepareDataDir(o.dataDir);
				storePath = join(o.dataDir, STORE_FILE);
				host = await openSqliteHost(storePath);
			}
			// the reaper clears reservations of transactions abandoned by a crash (section 6.1)
			const stop = await startService(host, ctx, { now: o.now, watchDebounceMs: 50 });
			return new FilesService(host, state, stop, storePath, o);
		} catch (e) { await host?.close(ctx); state.close(); throw e; }
	}

	/** Runs `op` in the tenant's queue with that tenant's private Space. */
	inTenant<T>(tenantId: string, op: (space: PhiSpaces) => Promise<T>): Promise<T> {
		const alias = tenantAlias(tenantId);
		return this.admission.run(tenantId, () => op(new PhiSpaces(this.host, ctx, this.#now, undefined, undefined, { space: alias })));
	}

	/** Reserves the tenant's named Space (the first of the two commits of tenant initialization, section 2). Idempotent. */
	reserveTenantSpace(tenantId: string): Promise<{ spaceId: string; alias: string }> {
		const alias = tenantAlias(tenantId);
		return this.admission.run(tenantId, async () => {
			const info = await this.host.commit((tx) => createSpace(tx, alias, this.#now()), ctx);
			return { spaceId: info.spaceId, alias: info.alias };
		});
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
