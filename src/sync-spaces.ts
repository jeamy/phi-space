// A primary/sync Space on a federation host (plan 3.2/3.5): its own dedicated store (one commit history per Space,
// docs/abnahme/ap3-primary-sync.md), the signed replica listener, and on the primary a host over primarySyncStorage with
// the boot guard bound to the journal configuration. A standby serves no business calls. Transitions (promote,
// degradeToSingle, setStandby) run with the host's service for this Space stopped; on the next start the host
// follows the journal: as primary it serves the Space and offers the ReplicaConfigNotice of its last transition.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ClosableStoreHost } from "./store/types.ts";
import type { LegacyStorage } from "./store/legacy.ts";
import { isSyncStore, type SyncStore } from "./store/sync-store.ts";
import type { Context } from "./context.ts";
import type { Signer } from "./auth.ts";
import type { RecoveryRegister } from "./recovery-register.ts";
import { installBootGuard } from "./boot.ts";
import { PrimarySyncJournal, PrimarySyncBlocked, primarySyncStorage, recoverPrimarySync, durabilityOf, type PrimarySyncConfig } from "./primary-sync.ts";
import { assertQuarantine, assertSyncPrimary, assertSyncStandby, installAdmittedPermit } from "./replica-control.ts";
import { replicaSyncHandler, signedReplicaPeer, type ReplicaPin } from "./replica-transport.ts";
import { latestReplicaConfigNotice, signReplicaConfigNotice, type SignedReplicaConfigNotice } from "./replica-notice.ts";
import { serveSpace, socketTransport } from "./socket.ts";
import { createSpace, listSpaces } from "./spaces.ts";

export type SyncSpaceConfig = {
	alias: string; spaceId: string; incarnation: string; dir: string; genesis: PrimarySyncConfig;
	/** replica listener port on the overlay address of every replica */
	port: number;
	peers: Array<ReplicaPin & { ip: string }>;
	/** Logical Member installed by signed Control membership commands; its state lives in the replicated Space. */
	membership?: { memberId: string };
	/** Journal bounds (defaults 256 KiB per commit, 64 MiB history); every replica of the Space uses the same. */
	journal?: { maxIntentBytes?: number; maxHistoryBytes?: number };
};
export type SyncSpace = {
	config: SyncSpaceConfig; journal: PrimarySyncJournal; role: () => "primary" | "standby" | "excluded";
	/** The served host of a primary; absent on a standby and while a sealed candidate is unresolved. */
	readonly harness?: ClosableStoreHost; notice: () => Promise<SignedReplicaConfigNotice | null>; close: () => Promise<void>;
	/** Primary: stops serving after a sealed, unconfirmed commit (its host refuses all work until reopened). */
	unserve: () => Promise<void>;
	/**
	 * Primary: one attempt to resolve the sealed candidate with the standby and serve again (docs/abnahme/ap3-primary-sync.md).
	 * "served", "pending" (try again later: standby or register unreachable) or "excluded" (this host lost its active
	 * primary permit, e.g. fenced by a promotion: stop trying; the candidate is never applied here).
	 */
	resolve: () => Promise<{ state: "served" | "pending" | "excluded"; error?: string }>;
	/**
	 * The unresolved sealed candidate: the served store was poisoned by an unconfirmed commit, or (no host) the
	 * journal holds a candidate beyond the applied revision. Not the short window of a commit in flight.
	 */
	sealed: () => { revision: number; hash: string } | null;
	/** Called once whenever the served store gets poisoned (also by the reaper). */
	onSealed: (listener: () => void) => void;
};
/**
 * How long the primary waits for the standby's answer to one intent. Beyond it the commit counts as not confirmed
 * (CommitSealed) and the resolver takes over, instead of every write hanging for the life of a cut connection.
 */
const STANDBY_ANSWER_MS = 15_000;
/** How long a poisoned host may take to close before it is abandoned. */
const CLOSE_BOUND_MS = 5000;

export async function openSyncSpace(o: {
	config: SyncSpaceConfig; hostId: string; authorityId: string; bindIp: string; signer: Signer;
	external: RecoveryRegister; installed: RecoveryRegister; ctx: Context;
	/** The Space's store and its host: pi-durable's storage (the daemon's choice until U5 moves those deployments) or
	 *  the own store (OWN_SYNC_FACTORIES, the default when the daemon supplies none). */
	openStorage: (path: string) => Promise<LegacyStorage | SyncStore>; openHarness: (storage: any) => Promise<ClosableStoreHost>; now?: () => number;
	/** Quarantine: only the journal and the replica listener (catch-up for setStandby), never a served host. */
	listenOnly?: boolean;
}): Promise<SyncSpace> {
	const c = o.config, now = o.now ?? Date.now;
	if (c.genesis.spaceId !== c.spaceId || c.genesis.authorityId !== o.authorityId) throw new Error(`replica configuration of ${c.alias} names another Space or authority`);
	if (!Number.isSafeInteger(c.port) || c.port < 1 || c.port > 65535 || !c.peers.length) throw new Error(`replica listener of ${c.alias} is not provisioned`);
	mkdirSync(c.dir, { recursive: true, mode: 0o700 });
	const journal = new PrimarySyncJournal(join(c.dir, "journal.sqlite"), c.genesis, { ...c.journal, self: o.hostId, assertStandby: assertSyncStandby(o.external, o.hostId) });
	const role = () => journal.config.primaryReplica === o.hostId ? "primary" as const : journal.config.standbyReplica === o.hostId ? "standby" as const : "excluded" as const;
	const ips = new Set(c.peers.map(p => p.ip)), transports: Array<ReturnType<typeof socketTransport>> = [];
	const listener = await serveSpace({ handleText: replicaSyncHandler({ journal: () => journal, signer: o.signer, self: o.hostId, remotes: c.peers, assertQuarantine: assertQuarantine(o.external, o.hostId, c.spaceId), now }) },
		{ listen: { host: o.bindIp, port: c.port }, connection: s => ips.has(String(s.remoteAddress).replace(/^::ffff:/, "")) ? {} : null, maxConnections: 4, maxFrameBytes: 1 << 20 });
	let harness: ClosableStoreHost | undefined, stopGuard: (() => void) | undefined, poisoned: { revision: number; hash: string } | null = null, sealedListener: (() => void) | undefined;
	const assert = assertSyncPrimary(o.external, o.hostId, journal), harnessPath = join(c.dir, "harness.sqlite");
	let peer: ReturnType<typeof signedReplicaPeer> | null | undefined;
	const peerFor = () => {
		if (peer !== undefined) return peer;
		const standby = durabilityOf(journal.config) === "sync" ? c.peers.find(p => p.hostId === journal.config.standbyReplica) : undefined;
		if (durabilityOf(journal.config) === "sync" && !standby) throw new Error(`standby ${journal.config.standbyReplica} of ${c.alias} is not provisioned`);
		return peer = standby ? signedReplicaPeer({ transport: (transports.push(socketTransport({ host: standby.ip, port: c.port }, { localAddress: o.bindIp, connectTimeoutMs: 8000, requestTimeoutMs: STANDBY_ANSWER_MS, maxFrameBytes: 1 << 20 })), transports.at(-1)!), signer: o.signer, self: o.hostId, remote: standby }) : null;
	};
	// Open, resolve the at most one sealed candidate with the standby, then serve. The same path at start and after a
	// sealed commit at runtime.
	const serve = async () => {
		// The local installation follows the active external permit of this replica configuration (after every
		// transition the next open copies it); without an active permit the Space is not served.
		await installAdmittedPermit({ external: o.external, installed: o.installed, hostId: o.hostId, spaceId: c.spaceId, localDataIncarnation: c.incarnation });
		await closing;
		const p = peerFor(), raw = await o.openStorage(harnessPath);
		let h: ClosableStoreHost | undefined;
		try {
			await recoverPrimarySync(raw, journal, p, o.ctx, assert);
			const po = { assertPrimary: assert, now, onPoisoned: (s: { revision: number; hash: string }) => { if (!poisoned) { poisoned = s; queueMicrotask(() => sealedListener?.()); } } };
			h = await o.openHarness(isSyncStore(raw) ? primarySyncStorage(raw, journal, p, po) : primarySyncStorage(raw, journal, p, po));
			if (!(await listSpaces(h, o.ctx)).some(i => i.spaceId === c.spaceId)) await h.commit(tx => createSpace(tx, c.alias, now(), { spaceId: c.spaceId, incarnation: c.incarnation }), o.ctx);
		} catch (e) { if (h) await bounded(h.close(o.ctx)); else await bounded(raw.close(o.ctx)); throw e; }
		stopGuard = installBootGuard(h, o.ctx, { hostId: o.hostId, authorityId: o.authorityId, external: o.external, installed: o.installed, replicaConfig: id => id === c.spaceId ? journal.config : null });
		poisoned = null; harness = h;
	};
	// A host being closed (by the sealed resolver, say) still holds its store: closing and serving again wait for it.
	let closing: Promise<void> = Promise.resolve();
	const unserve = async () => { const h = harness; harness = undefined; stopGuard?.(); stopGuard = undefined; if (h) closing = closing.then(() => bounded(h.close(o.ctx))); await closing; };
	try {
		if (!o.listenOnly && role() === "primary") {
			try { await serve(); }
			catch (e) {
				// A sealed candidate the standby cannot confirm now stays unresolved; resolve() tries again.
				// An emptied replica (its history set aside) starts from the genesis, which may name it primary; without
				// an active permit it is not served but keeps its listener for setStandby's catch-up.
				// Anything else (no permit, another configuration) keeps the Space unserved as before.
				if (journal.head().revision === 0) console.error(`primary/sync Space ${c.alias} is an empty replica and waits for setStandby:`, e instanceof Error ? e.message : String(e));
				else if (journal.head().revision === journal.appliedRevision || e instanceof PrimarySyncBlocked) throw e;
				else console.error(`primary/sync Space ${c.alias} has an unresolved sealed candidate:`, e instanceof Error ? e.message : String(e));
			}
		}
	} catch (e) { for (const t of transports) t.close(); await listener.close(); journal.close(); throw e; }
	return {
		config: c, journal, role, get harness() { return harness; }, unserve,
		sealed: () => { if (harness) return poisoned; if (role() !== "primary") return null; const h = journal.head(); return h.revision !== journal.appliedRevision ? { revision: h.revision, hash: h.hash } : null; },
		onSealed: listener => { sealedListener = listener; },
		resolve: async () => {
			if (harness) return { state: "served" };
			if (o.listenOnly || role() !== "primary") return { state: "excluded", error: "this host is not the primary of the journal configuration" };
			try { await assert(); } catch (e) { return { state: e instanceof PrimarySyncBlocked ? "excluded" : "pending", error: e instanceof Error ? e.message : String(e) }; }
			// recoverPrimarySync checks the permit again before it applies anything.
			try { await serve(); return { state: "served" }; } catch (e) { return { state: "pending", error: e instanceof Error ? e.message : String(e) }; }
		},
		notice: async () => { if (role() !== "primary") return null; const n = latestReplicaConfigNotice(journal, c.incarnation); return n ? signReplicaConfigNotice(n, o.signer) : null; },
		close: async () => { await unserve(); for (const t of transports) t.close(); await listener.close(); journal.close(); },
	};
}

async function bounded(p: Promise<unknown>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([p.catch(() => {}), new Promise<void>(r => { timer = setTimeout(r, CLOSE_BOUND_MS); timer.unref?.(); })]);
	clearTimeout(timer);
}

/**
 * Opens every configured primary/sync Space on its own: a Space that cannot open (unreachable standby for its sealed
 * candidate, missing permit) stays unserved and blocked, and does not take the host and its other Spaces down.
 */
export async function openSyncSpaces(configs: readonly SyncSpaceConfig[], open: (c: SyncSpaceConfig) => Promise<SyncSpace>): Promise<{ opened: SyncSpace[]; failed: Array<{ alias: string; error: string }> }> {
	const opened: SyncSpace[] = [], failed: Array<{ alias: string; error: string }> = [];
	for (const c of configs) {
		try { opened.push(await open(c)); } catch (e) { failed.push({ alias: c.alias, error: e instanceof Error ? e.message : String(e) }); }
	}
	return { opened, failed };
}

export type SealedSyncSpace = { spaceId: string; alias: string; sealed: { revision: number; hash: string } };
/** The unresolved sealed candidate of a primary/sync Space, or null (see SyncSpace.sealed). */
export const sealedCandidateOf = (sp: SyncSpace): { revision: number; hash: string } | null => sp.sealed();
/**
 * Resolves sealed, unconfirmed commits while the host runs (docs/abnahme/ap3-primary-sync.md): the Space is set unresolved
 * (answered with CommitSealed), its host closed, and `resolve()` retried with backoff until the standby confirms
 * or rejects the candidate; then the Space is served anew. A host that lost its primary permit stops trying.
 */
export function sealedResolver<E>(o: { set: (next: E | SealedSyncSpace) => Promise<void>; serve: (sp: SyncSpace) => E; retryMs?: number; maxRetryMs?: number; log?: (message: string) => void }) {
	const log = o.log ?? (m => console.error(m)), active = new Map<string, Promise<void>>();
	let stopped = false;
	const wakers = new Set<() => void>();
	const resolve = (sp: SyncSpace): Promise<void> => {
		const key = sp.config.spaceId, running = active.get(key);
		if (running || stopped) return running ?? Promise.resolve();
		const run = (async () => {
			try {
				await o.set({ spaceId: key, alias: sp.config.alias, sealed: sealedCandidateOf(sp) ?? sp.journal.head() }); await sp.unserve();
				for (let wait = o.retryMs ?? 1000; !stopped; wait = Math.min(o.maxRetryMs ?? 30_000, wait * 2)) {
					const r = await sp.resolve();
					if (r.state === "served") { await o.set(o.serve(sp)); log(`primary/sync Space ${sp.config.alias}: sealed candidate resolved, served again`); return; }
					if (r.state === "excluded") { log(`primary/sync Space ${sp.config.alias} stays unresolved; this host is no longer its primary: ${r.error}`); return; }
					log(`primary/sync Space ${sp.config.alias}: sealed candidate still unresolved: ${r.error}`);
					await new Promise<void>(res => { const done = () => { clearTimeout(t); wakers.delete(done); res(); }, t = setTimeout(done, wait); t.unref?.(); wakers.add(done); });
				}
			} catch (e) { log(`primary/sync Space ${sp.config.alias}: resolving the sealed candidate failed: ${e instanceof Error ? e.message : String(e)}`); }
			finally { active.delete(key); }
		})();
		active.set(key, run); return run;
	};
	return {
		resolve,
		/** Resolves whenever a served store gets poisoned, also by the reaper without any call noticing. */
		attach: (spaces: readonly SyncSpace[]) => { for (const sp of spaces) sp.onSealed(() => void resolve(sp)); },
		stop: async () => { stopped = true; for (const wake of [...wakers]) wake(); await Promise.all([...active.values()]); },
	};
}
