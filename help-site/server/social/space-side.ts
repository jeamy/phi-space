// The swarm Space's own side: what the process that holds the store does beyond serving it. That is
// `server/space-host.ts` in TypeScript or `phi-space-server --profile help` in Rust (rust/phi-space-server/src/profiles.rs).
// It opens the Space by its alias and sets the limits and the completion profile. It writes the HostInfo entry the
// test-system bar shows and purges the oldest posts above the cap. All of this is host code. The swarm (swarm.ts) is
// only a client of the Space, the same over a socket as in-process.
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { Context } from "phi-spaces/context";
import { core, createSpace, FOREVER, openOwnMemoryHost, openSqliteHost, PhiSpaces, spaceDoc, startService, type CompletionProfile, type Meter, type SpaceHost } from "phi-spaces";
import { hostFacts, purgeOldest, SWARM_CLAIM_RESULT_MS, type RetentionConfig } from "./retention.ts";

export const SWARM_ALIAS = "social-swarm";

export const SWARM_COMPLETION_PROFILES: CompletionProfile[] = [
	{
		taskType: "SwarmTask",
		resultTypes: ["Post", "Like"],
		equalFields: ["taskId"],
		maxResultCount: 1,
		maxResultBytes: 64 * 1024,
		maxLeaseMs: 60_000,
	} as CompletionProfile,
];

/**
 * The swarm writes several calls a second, each with a request claim whose result is kept for `claimResultMs`. At the
 * default of 24 hours that fills maxClaimBytes within hours, and new requests are refused. A repeat of a call comes
 * within seconds, so a few minutes of kept results is all the idempotence the swarm needs. A claim's hash is kept until
 * its generation stops admitting request ids (default 1 hour). If results were kept only minutes while the generation
 * stayed for that hour, thousands of expired claims would linger, and the sweep of every commit would read them again.
 * One owner (the swarm process) holds the worker's batch transaction, the user posts' transactions and the waiting
 * reads at once, so the per-owner counts are lifted as in the other projects.
 */
export const SWARM_LIMITS: Partial<core.Limits> = {
	claimResultMs: SWARM_CLAIM_RESULT_MS,
	generationAdmitMs: SWARM_CLAIM_RESULT_MS,
	maxTxnsPerOwner: 1000,
	maxWaitersPerOwner: 1000,
	maxRegsPerOwner: 1000,
};

/** Opens (or creates) the swarm Space, sets its limits and completion profile and replaces its HostInfo entry. */
export async function prepareSwarmSpace(host: SpaceHost, ctx: Context, cap: number | null): Promise<string> {
	const info = await host.commit((tx) => createSpace(tx, SWARM_ALIAS, Date.now()), ctx);
	await host.commit(async (tx) => {
		const now = Date.now(), s = await spaceDoc(tx, info.spaceId, now);
		core.setLimits(s, SWARM_LIMITS, now);
		// A persisted Space keeps its profiles from the first start; transactions left open by a previous run block the
		// change until they lapse, and the profiles are the same anyway.
		if (Object.keys(s.txns).length === 0) core.setCompletionProfiles(s, SWARM_COMPLETION_PROFILES, now);
		while (core.probe(s, now, { type: "HostInfo" }, null, true).status === "found");
		core.write(s, now, { type: "HostInfo", fields: { ...hostFacts(), cap } }, null, FOREVER);
	}, ctx);
	return info.spaceId;
}

/** How often the purge looks (`SWARM_RETENTION_MS`, default 10 s). */
export const retentionEvery = (raw = process.env.SWARM_RETENTION_MS): number => { const n = Number(raw); return Number.isFinite(n) && n >= 10 ? n : 10_000; };

/** The retention purge every 10 s: above the cap the oldest posts go (retention.ts), and the PurgeNotice tells the swarm. */
export function startRetention(host: SpaceHost, ctx: Context, spaceId: string, cfg: RetentionConfig, everyMs = retentionEvery(), log = console.log): { stop: () => Promise<void> } {
	const space = new PhiSpaces(host, ctx, Date.now, undefined, undefined, { space: spaceId });
	let running: Promise<void> | null = null, stopped = false;
	const tick = async () => {
		try {
			if (await space.count() <= cfg.cap) return;
			const r = await purgeOldest({ host, spaceId, ctx }, cfg);
			if (r) log(`[swarm] retention: purged ${r.removed} entries (${r.posts} posts), ${r.entries} left, cap ${r.cap}`);
		} catch (e) {
			if (!stopped) console.warn("[swarm] retention purge failed:", (e as Error).message);
		}
	};
	const timer = setInterval(() => { if (!running && !stopped) running = tick().finally(() => { running = null; }); }, everyMs);
	return { stop: async () => { stopped = true; clearInterval(timer); await running; } };
}

export interface SwarmSide {
	host: SpaceHost;
	spaceId: string;
	/** The swarm's client of the Space, in-process. */
	space: PhiSpaces;
	close: () => Promise<void>;
}

/**
 * The swarm Space in this process: its own host (a store file of its own, or memory), prepared and purged as the space
 * process would. Used when no `SWARM_SPACE` names a separate process (dev, tests, the TypeScript way back).
 */
export async function openSwarmSide(ctx: Context, o: { file?: string | null; retention: RetentionConfig | null; meter?: Meter; startService?: boolean; retentionMs?: number }): Promise<SwarmSide> {
	const host = o.file
		? await (async () => { await mkdir(dirname(o.file!), { recursive: true }); return await openSqliteHost(o.file!); })()
		: openOwnMemoryHost();
	const stopService = o.startService === false ? null : await startService(host, ctx, { watchDebounceMs: 400 });
	const spaceId = await prepareSwarmSpace(host, ctx, o.retention?.cap ?? null);
	const retention = o.retention ? startRetention(host, ctx, spaceId, o.retention, o.retentionMs) : null;
	const space = new PhiSpaces(host, ctx, Date.now, o.meter, undefined, { space: spaceId });
	return {
		host, spaceId, space,
		close: async () => { await retention?.stop(); await stopService?.(); await host.close(ctx); },
	};
}
