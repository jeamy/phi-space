// A primary/sync Space on a federation host (plan 3.2/3.5): its own dedicated store (one commit history per Space,
// docs/ap3-primary-sync.md), the signed replica listener, and on the primary a Harness over primarySyncStorage with
// the boot guard bound to the journal configuration. A standby serves no business calls. Transitions (promote,
// degradeToSingle, setStandby) run with the host's service for this Space stopped; on the next start the host
// follows the journal: as primary it serves the Space and offers the ReplicaConfigNotice of its last transition.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Harness, Storage } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { Signer } from "./auth.ts";
import type { RecoveryRegister } from "./recovery-register.ts";
import { installBootGuard } from "./boot.ts";
import { PrimarySyncJournal, primarySyncStorage, recoverPrimarySync, durabilityOf, type PrimarySyncConfig } from "./primary-sync.ts";
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
};
export type SyncSpace = {
	config: SyncSpaceConfig; journal: PrimarySyncJournal; role: () => "primary" | "standby" | "excluded";
	harness?: Harness; notice: () => Promise<SignedReplicaConfigNotice | null>; close: () => Promise<void>;
};

export async function openSyncSpace(o: {
	config: SyncSpaceConfig; hostId: string; authorityId: string; bindIp: string; signer: Signer;
	external: RecoveryRegister; installed: RecoveryRegister; ctx: Context;
	openStorage: (path: string) => Promise<Storage>; openHarness: (storage: Storage) => Promise<Harness>; now?: () => number;
	/** Quarantine: only the journal and the replica listener (catch-up for setStandby), never a served Harness. */
	listenOnly?: boolean;
}): Promise<SyncSpace> {
	const c = o.config, now = o.now ?? Date.now;
	if (c.genesis.spaceId !== c.spaceId || c.genesis.authorityId !== o.authorityId) throw new Error(`replica configuration of ${c.alias} names another Space or authority`);
	if (!Number.isSafeInteger(c.port) || c.port < 1 || c.port > 65535 || !c.peers.length) throw new Error(`replica listener of ${c.alias} is not provisioned`);
	mkdirSync(c.dir, { recursive: true, mode: 0o700 });
	const journal = new PrimarySyncJournal(join(c.dir, "journal.sqlite"), c.genesis, { self: o.hostId, assertStandby: assertSyncStandby(o.external, o.hostId) });
	const role = () => journal.config.primaryReplica === o.hostId ? "primary" as const : journal.config.standbyReplica === o.hostId ? "standby" as const : "excluded" as const;
	const ips = new Set(c.peers.map(p => p.ip)), transports: Array<ReturnType<typeof socketTransport>> = [];
	const listener = await serveSpace({ handleText: replicaSyncHandler({ journal: () => journal, signer: o.signer, self: o.hostId, remotes: c.peers, assertQuarantine: assertQuarantine(o.external, o.hostId), now }) },
		{ listen: { host: o.bindIp, port: c.port }, connection: s => ips.has(String(s.remoteAddress).replace(/^::ffff:/, "")) ? {} : null, maxConnections: 4, maxFrameBytes: 1 << 20 });
	let harness: Harness | undefined, stopGuard: (() => void) | undefined;
	try {
		if (!o.listenOnly && role() === "primary") {
			// The local installation follows the active external permit of this replica configuration (after every
			// transition the next open copies it); without an active permit the Space is not served.
			await installAdmittedPermit({ external: o.external, installed: o.installed, hostId: o.hostId, spaceId: c.spaceId, localDataIncarnation: c.incarnation });
			const standby = durabilityOf(journal.config) === "sync" ? c.peers.find(p => p.hostId === journal.config.standbyReplica) : undefined;
			if (durabilityOf(journal.config) === "sync" && !standby) throw new Error(`standby ${journal.config.standbyReplica} of ${c.alias} is not provisioned`);
			const peer = standby ? signedReplicaPeer({ transport: (transports.push(socketTransport({ host: standby.ip, port: c.port }, { localAddress: o.bindIp, connectTimeoutMs: 8000, maxFrameBytes: 1 << 20 })), transports.at(-1)!), signer: o.signer, self: o.hostId, remote: standby }) : null;
			const assert = assertSyncPrimary(o.external, o.hostId, journal), raw = await o.openStorage(join(c.dir, "harness.sqlite"));
			await recoverPrimarySync(raw, journal, peer, o.ctx, assert);
			harness = await o.openHarness(primarySyncStorage(raw, journal, peer, { assertPrimary: assert, now }));
			if (!(await listSpaces(harness, o.ctx)).some(i => i.spaceId === c.spaceId)) await harness.commit(tx => createSpace(tx, c.alias, now(), { spaceId: c.spaceId, incarnation: c.incarnation }), o.ctx);
			stopGuard = installBootGuard(harness, o.ctx, { hostId: o.hostId, authorityId: o.authorityId, external: o.external, installed: o.installed, replicaConfig: id => id === c.spaceId ? journal.config : null });
		}
	} catch (e) { for (const t of transports) t.close(); await listener.close(); journal.close(); throw e; }
	return {
		config: c, journal, role, harness,
		notice: async () => { if (role() !== "primary") return null; const n = latestReplicaConfigNotice(journal, c.incarnation); return n ? signReplicaConfigNotice(n, o.signer) : null; },
		close: async () => { stopGuard?.(); if (harness) await harness.close(o.ctx); for (const t of transports) t.close(); await listener.close(); journal.close(); },
	};
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
