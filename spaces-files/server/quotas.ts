// Live-data quotas (docs/zanzibar-agent-filesystem-plan.en.md, section 3, budgets): before a mutation the service
// checks what it would add against the tenant's limits. Ordinary quota failures are `capacityExceeded` and leave
// admission open. Counts come from the tenant Space; the content bytes are the sum of the content rows' `size`, summed
// once per tenant and then kept by the single writer (like the audit seq).
import type { PhiSpaces } from "phi-spaces";
import type { FsLimits } from "./limits.ts";
import { listGroups } from "./policy.ts";
import { CapacityExceeded, T, WORKSPACES } from "./schema.ts";

/** What a mutation adds. `contentBytes` may be negative (a shorter save). */
export type Demand = {
	actors?: number;
	workspaces?: number;
	nodes?: number;
	relations?: number;
	/** Group IDs the mutation names; only those not yet in the tenant count. */
	groups?: string[];
	contentBytes?: number;
	/** New children of one directory. */
	dirEntries?: { parentId: string; n: number };
	/** New direct grants on one node. */
	grantsOn?: { nodeId: string; n: number };
	/** Stored bytes the rows add (their encoded fields, minus what replaced rows free). */
	storedBytes?: number;
};

/** The bytes of a tenant's current file versions, for the first check after opening. */
export async function sumContentBytes(space: PhiSpaces): Promise<number> {
	let n = 0;
	for (const e of await space.readAll({ type: T.content })) n += e.fields.size as number;
	return n;
}

export async function checkQuotas(space: PhiSpaces, limits: FsLimits, d: Demand, contentBytesNow: number): Promise<void> {
	const over = (what: string, have: number, add: number, limit: number) => {
		if (add > 0 && have + add > limit) throw new CapacityExceeded(`${what}: ${have} + ${add} exceeds ${limit}`);
	};
	if (d.actors) over("actors", await space.count({ type: T.actor }), d.actors, limits.maxActors);
	if (d.workspaces) over("workspaces", await space.count({ type: T.node, fields: { parentId: WORKSPACES } }), d.workspaces, limits.maxWorkspaces);
	if (d.nodes) over("nodes", await space.count({ type: T.node }), d.nodes, limits.maxNodes);
	if (d.relations) over("relations", await space.count({ type: T.relation }), d.relations, limits.maxRelations);
	if (d.dirEntries) over("directory entries", await space.count({ type: T.node, fields: { parentId: d.dirEntries.parentId } }), d.dirEntries.n, limits.maxDirEntries);
	if (d.grantsOn) over("grants on one target", await space.count({ type: T.relation, fields: { objectKind: "node", objectId: d.grantsOn.nodeId } }), d.grantsOn.n, limits.maxGrantsPerTarget);
	if (d.groups?.length) {
		const have = await listGroups(space, { limits });
		over("groups", have.length, new Set(d.groups.filter((g) => !have.includes(g))).size, limits.maxGroups);
	}
	if (d.contentBytes) over("content bytes", contentBytesNow, d.contentBytes, limits.maxContentBytes);
	if (d.storedBytes) over("stored bytes", (await space.stats()).bytes?.entries ?? 0, d.storedBytes, limits.maxTenantBytes);
}
