// Replica control for primary/sync Spaces (docs/federation-plan-v3.md 5.3, 5.3.1, 5.5; plan 3.3-3.6).
// Fencing adapters prove that a host is stopped and restart-locked; boot states live in the independent recovery
// register. Promotion, degradeToSingle and setStandby are journaled by transition ID, change the replica
// configuration as an entry of the sync chain and then align the external boot permits; until local and external
// state match, `assertSyncPrimary` keeps writes blocked. A simulator adapter is refused unless a test allows it.
import type { Storage } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { canonicalJson } from "./canonical.ts";
import { RegisterConflict, type RecoveryRegister } from "./recovery-register.ts";
import type { HostBootState, SpaceBootPermit } from "./boot.ts";
import type { Json } from "./core.ts";
import { PrimarySyncBlocked, applyConfigTransition, durabilityOf, materializeSyncHistory, recoverSealedWithoutStandby, type PrimaryIntent, type PrimarySyncAck, type PrimarySyncConfig, type PrimarySyncJournal } from "./primary-sync.ts";

export type FenceProof = { hostId: string; kind: string; observedAt: number; evidence: Json; restartLocked: boolean };
/** v3 5.5. Boot states are not part of the adapter: they stay in the independent recovery register. */
export interface FencingAdapter {
	readonly kind: "power" | "hypervisor" | "cloud" | "container" | "simulator";
	fence(hostId: string, reason: string): Promise<FenceProof>;
	verify(proof: FenceProof): Promise<boolean>;
	release(hostId: string, mode: "quarantine"): Promise<void>;
}
export class ReplicaTransitionBlocked extends Error {}

/** Simulator only: a claim, not evidence. Promotion and degradeToSingle refuse it unless `allowSimulator` is set. */
export class SimulatorFencing implements FencingAdapter {
	readonly kind = "simulator" as const;
	private fenced = new Set<string>();
	async fence(hostId: string, reason: string): Promise<FenceProof> { this.fenced.add(hostId); return { hostId, kind: this.kind, observedAt: Date.now(), evidence: { reason }, restartLocked: true }; }
	async verify(proof: FenceProof): Promise<boolean> { return proof.kind === this.kind && this.fenced.has(proof.hostId) && proof.restartLocked; }
	async release(hostId: string): Promise<void> { this.fenced.delete(hostId); }
}
/** Placeholder for a provider adapter whose API access is not provisioned yet (F1/Gate 2). */
export function unconfiguredFencing(kind: "power" | "hypervisor" | "cloud" | "container", provider: string): FencingAdapter {
	const fail = async (): Promise<never> => { throw new ReplicaTransitionBlocked(`${provider} fencing is not configured; promotion stays blocked`); };
	return { kind, fence: fail, verify: fail, release: fail };
}

type Boot = HostBootState & { transitionId?: string };
const permitEq = (a: unknown, b: unknown) => canonicalJson(a as Json) === canonicalJson(b as Json);
async function casBoot(register: RecoveryRegister, hostId: string, change: (b: Boot | null) => Boot | null): Promise<Boot> {
	for (let attempt = 0; attempt < 8; attempt++) {
		const current = await register.get<Boot & Json>(`boot:${hostId}`);
		const next = change(current ? structuredClone(current.value) : null);
		if (next === null) return current!.value;
		if (current && permitEq(current.value, next)) return next;
		try { return (await register.compareAndSet(`boot:${hostId}`, current?.version ?? null, next as Boot & Json)).value; }
		catch (e) { if (!(e instanceof RegisterConflict) || attempt === 7) throw e; } // concurrent change: read again
	}
	throw new ReplicaTransitionBlocked("boot state kept changing");
}
/** fence: host `fenced`, every Space permit `revoked` (values kept for audit). Idempotent per transition. */
export function fenceHostBoot(register: RecoveryRegister, hostId: string, transitionId: string): Promise<Boot> {
	return casBoot(register, hostId, b => {
		if (!b) throw new ReplicaTransitionBlocked(`no boot state for ${hostId}`);
		const spaces = Object.fromEntries(Object.entries(b.spaces).map(([id, p]) => [id, { ...p, state: "revoked" as const }]));
		return { ...b, state: "fenced", spaces, transitionId };
	});
}
/** release: only into quarantine; revoked permits stay revoked. The restart lock is lifted after the boot CAS. */
export async function releaseHostToQuarantine(register: RecoveryRegister, hostId: string, transitionId: string, adapter?: FencingAdapter): Promise<Boot> {
	const boot = await casBoot(register, hostId, b => {
		if (!b || !["fenced", "quarantine"].includes(b.state)) throw new ReplicaTransitionBlocked(`${hostId} is not fenced; release only leads into quarantine`);
		return { ...b, state: "quarantine", transitionId };
	});
	await adapter?.release(hostId, "quarantine");
	return boot;
}
function setPermit(register: RecoveryRegister, hostId: string, spaceId: string, permit: SpaceBootPermit, o: { hostState?: "active"; requireHost?: Array<HostBootState["state"]> } = {}): Promise<Boot> {
	return casBoot(register, hostId, b => {
		if (!b) throw new ReplicaTransitionBlocked(`no boot state for ${hostId}`);
		if (o.requireHost && !o.requireHost.includes(b.state)) throw new ReplicaTransitionBlocked(`${hostId} is ${b.state}`);
		return { ...b, state: o.hostState ?? b.state, spaces: { ...b.spaces, [spaceId]: permit }, transitionId: permit.transitionId };
	});
}
const permitFor = (c: PrimarySyncConfig, role: "primary" | "standby", dataIncarnation: string, transitionId: string): SpaceBootPermit =>
	({ state: "active", authorityId: c.authorityId, dataIncarnation, role, primaryEpoch: c.primaryEpoch, replicaConfigVersion: c.replicaConfigVersion, durability: durabilityOf(c), transitionId });

async function assertPermit(register: RecoveryRegister, hostId: string, c: PrimarySyncConfig, role: "primary" | "standby") {
	const b = (await register.get<Boot & Json>(`boot:${hostId}`))?.value, p = b?.spaces[c.spaceId];
	if ((role === "primary" ? c.primaryReplica : c.standbyReplica) !== hostId) throw new PrimarySyncBlocked(`${hostId} is not the ${role} of this configuration`);
	if (!b || b.state !== "active" || !p || p.state !== "active" || p.role !== role || p.authorityId !== c.authorityId || p.primaryEpoch !== c.primaryEpoch || p.replicaConfigVersion !== c.replicaConfigVersion || p.durability !== durabilityOf(c)) throw new PrimarySyncBlocked(`${role === "primary" ? "external" : "standby"} boot permit does not match the ${role === "primary" ? "local replica" : "expected"} configuration`);
}
/** assertPrimary for primarySyncStorage: host active and an active primary permit matching the journal configuration exactly. */
export function assertSyncPrimary(register: RecoveryRegister, hostId: string, journal: PrimarySyncJournal): () => Promise<void> {
	return () => assertPermit(register, hostId, journal.config, "primary");
}
/** assertStandby for PrimarySyncJournal: host active and an active standby permit for exactly this configuration. */
export function assertSyncStandby(register: RecoveryRegister, hostId: string): (c: PrimarySyncConfig, version: 1 | 2 | 3) => Promise<void> {
	return async (c, version) => {
		// Only the setStandby configuration entry naming this host is confirmed while it is still in quarantine (5.3.1 step 7).
		if (version === 2 && c.standbyReplica === hostId && (await register.get<Boot & Json>(`boot:${hostId}`))?.value.state === "quarantine") return;
		await assertPermit(register, hostId, c, "standby");
	};
}
export function assertQuarantine(register: RecoveryRegister, hostId: string): () => Promise<void> {
	return async () => { if ((await register.get<Boot & Json>(`boot:${hostId}`))?.value.state !== "quarantine") throw new PrimarySyncBlocked(`${hostId} is not in quarantine`); };
}

type Phase = "started" | "locallyCommitted" | "completed" | "abandoned";
type Record_ = { kind: string; phase: Phase; hash: string; config?: PrimarySyncConfig; catchingUp?: boolean };
/** A replicated Space has one data incarnation shared by its replicas; transitions keep it unchanged. */
async function assertSharedIncarnation(register: RecoveryRegister, hostId: string, spaceId: string, dataIncarnation: string) {
	const p = (await register.get<Boot & Json>(`boot:${hostId}`))?.value.spaces[spaceId];
	if (!p || p.dataIncarnation !== dataIncarnation) throw new ReplicaTransitionBlocked("the data incarnation of a replicated Space is shared by its replicas and stays unchanged");
}
async function checkProof(adapter: FencingAdapter, proof: FenceProof, hostId: string, allowSimulator: boolean) {
	if (adapter.kind === "simulator" && !allowSimulator) throw new ReplicaTransitionBlocked("a simulator fencing claim is no evidence for promotion or degradeToSingle");
	if (!proof || proof.hostId !== hostId || proof.kind !== adapter.kind || proof.restartLocked !== true || !(await adapter.verify(proof))) throw new ReplicaTransitionBlocked(`no verified fencing proof for ${hostId}`);
}
function begin(journal: PrimarySyncJournal, id: string, kind: string, args: Json): Record_ {
	const hash = canonicalJson(args), rec = journal.beginTransition(id, { kind, phase: "started", hash } as Json) as unknown as Record_;
	if (rec.kind !== kind || rec.hash !== hash) throw new ReplicaTransitionBlocked("transition ID was used for another transition");
	if (rec.phase === "abandoned") throw new ReplicaTransitionBlocked("transition was abandoned; use a new ID");
	return rec;
}
type Common = { storage: Storage; journal: PrimarySyncJournal; register: RecoveryRegister; installed?: RecoveryRegister; hostId: string; dataIncarnation: string; ctx: Context; now?: () => number; allowSimulator?: boolean };
/**
 * Continues a configuration entry of this transition that was sealed before a crash: applies it once (after `accept`
 * re-delivered it where a standby takes part). Returns its configuration, or null when no such entry exists.
 */
async function resumeSealed(o: Common, id: string, assert: () => Promise<void>, accept?: (i: PrimaryIntent) => Promise<PrimarySyncAck>): Promise<PrimarySyncConfig | null> {
	const head = o.journal.head().revision, i = head ? o.journal.intent(head) : null;
	if (!i || i.version !== 2 || i.reason !== id) return null;
	if (o.journal.appliedRevision !== head) {
		if (accept) { const ack = await accept(i); if (ack.revision !== i.revision || ack.hash !== i.hash) throw new ReplicaTransitionBlocked("standby ACK does not match the replica transition"); }
		await recoverSealedWithoutStandby(o.storage, o.journal, o.ctx, assert);
	}
	return i.config;
}
async function alignPermit(o: Common, c: PrimarySyncConfig, role: "primary" | "standby", id: string, host?: { hostState?: "active"; requireHost?: Array<HostBootState["state"]> }, hostId = o.hostId) {
	const permit = permitFor(c, role, o.dataIncarnation, id);
	await setPermit(o.register, hostId, c.spaceId, permit, host);
	if (o.installed && hostId === o.hostId) {
		const key = `installed:${hostId}:${c.spaceId}`, cur = await o.installed.get(key);
		if (!cur || !permitEq(cur.value, permit)) await o.installed.compareAndSet(key, cur?.version ?? null, permit as unknown as Json);
	}
}

/**
 * 5.3.1 on the primary: the standby is lost. With a verified fencing proof of the standby host the at most one sealed
 * candidate is completed locally (recoveredCommitted), the configuration becomes single with epoch and version + 1,
 * and the primary's external permit follows. Repeating the same recovery ID continues the same transition.
 */
export async function degradeToSingle(o: Common & { recoveryId: string; expectedPrimaryEpoch: number; expectedReplicaConfigVersion: number; adapter: FencingAdapter; proof: FenceProof }) {
	const rec = begin(o.journal, o.recoveryId, "degradeToSingle", { e: o.expectedPrimaryEpoch, v: o.expectedReplicaConfigVersion, standby: o.proof?.hostId ?? null });
	if (rec.phase === "started") {
		const resumed = await resumeSealed(o, o.recoveryId, () => checkProof(o.adapter, o.proof, o.proof.hostId, !!o.allowSimulator));
		if (resumed) { rec.phase = "locallyCommitted"; rec.config = resumed; o.journal.saveTransition(o.recoveryId, rec as unknown as Json); }
	}
	if (rec.phase === "started") {
		const c = o.journal.config;
		if (c.primaryReplica !== o.hostId || durabilityOf(c) !== "sync" || c.primaryEpoch !== o.expectedPrimaryEpoch || c.replicaConfigVersion !== o.expectedReplicaConfigVersion) throw new ReplicaTransitionBlocked("replica configuration differs from the expected versions");
		await checkProof(o.adapter, o.proof, c.standbyReplica!, !!o.allowSimulator);
		await assertSharedIncarnation(o.register, o.hostId, c.spaceId, o.dataIncarnation);
		const fenced = async () => { await checkProof(o.adapter, o.proof, c.standbyReplica!, !!o.allowSimulator); };
		await fenceHostBoot(o.register, c.standbyReplica!, o.recoveryId);
		await recoverSealedWithoutStandby(o.storage, o.journal, o.ctx, fenced);
		const next: PrimarySyncConfig = { ...c, standbyReplica: null, durability: "single", primaryEpoch: c.primaryEpoch + 1, replicaConfigVersion: c.replicaConfigVersion + 1 };
		await applyConfigTransition(o.storage, o.journal, next, { reason: o.recoveryId, ctx: o.ctx, assert: fenced, now: o.now });
		rec.phase = "locallyCommitted"; rec.config = next; o.journal.saveTransition(o.recoveryId, rec as unknown as Json);
	}
	if (rec.phase === "locallyCommitted") {
		await alignPermit(o, rec.config!, "primary", o.recoveryId, { requireHost: ["active"] });
		rec.phase = "completed"; o.journal.saveTransition(o.recoveryId, rec as unknown as Json);
	}
	return { recoveryId: o.recoveryId, config: o.journal.config, recoveredCommitted: o.journal.recoveredCommitted };
}

/**
 * 5.3 on the fixed standby: with a verified fencing proof of the old primary and a matching standby permit, the
 * accepted history is materialized and this host becomes primary with a new epoch. The old primary stays the
 * standby of the new configuration, so sync writes remain blocked until degradeToSingle (same proof) or setStandby.
 */
export async function promote(o: Common & { recoveryId: string; expectedPrimaryEpoch: number; expectedReplicaConfigVersion: number; adapter: FencingAdapter; proof: FenceProof }) {
	const rec = begin(o.journal, o.recoveryId, "promote", { e: o.expectedPrimaryEpoch, v: o.expectedReplicaConfigVersion, old: o.proof?.hostId ?? null });
	if (rec.phase === "started") {
		const resumed = await resumeSealed(o, o.recoveryId, () => checkProof(o.adapter, o.proof, o.proof.hostId, !!o.allowSimulator));
		if (resumed) { rec.phase = "locallyCommitted"; rec.config = resumed; o.journal.saveTransition(o.recoveryId, rec as unknown as Json); }
	}
	if (rec.phase === "started") {
		const c = o.journal.config;
		if (c.standbyReplica !== o.hostId || durabilityOf(c) !== "sync" || c.primaryEpoch !== o.expectedPrimaryEpoch || c.replicaConfigVersion !== o.expectedReplicaConfigVersion) throw new ReplicaTransitionBlocked("only the fixed synchronous standby of the expected configuration is promoted");
		await checkProof(o.adapter, o.proof, c.primaryReplica, !!o.allowSimulator);
		// No quarantine exception here: a released standby with stale history has no standby permit.
		await assertPermit(o.register, o.hostId, c, "standby");
		await assertSharedIncarnation(o.register, o.hostId, c.spaceId, o.dataIncarnation);
		await fenceHostBoot(o.register, c.primaryReplica, o.recoveryId);
		await materializeSyncHistory(o.storage, o.journal, o.ctx);
		const next: PrimarySyncConfig = { ...c, primaryReplica: o.hostId, standbyReplica: c.primaryReplica, primaryEpoch: c.primaryEpoch + 1, replicaConfigVersion: c.replicaConfigVersion + 1 };
		await applyConfigTransition(o.storage, o.journal, next, { reason: o.recoveryId, ctx: o.ctx, assert: () => checkProof(o.adapter, o.proof, c.primaryReplica, !!o.allowSimulator), now: o.now });
		rec.phase = "locallyCommitted"; rec.config = next; o.journal.saveTransition(o.recoveryId, rec as unknown as Json);
	}
	if (rec.phase === "locallyCommitted") {
		await alignPermit(o, rec.config!, "primary", o.recoveryId, { requireHost: ["active"] });
		rec.phase = "completed"; o.journal.saveTransition(o.recoveryId, rec as unknown as Json);
	}
	return { recoveryId: o.recoveryId, config: o.journal.config };
}

/** A setStandby target: an empty quarantined replica that replays the chain and then confirms the new configuration. */
export interface StandbyTarget { readonly hostId: string; head(): Promise<PrimarySyncAck>; catchUp(intent: PrimaryIntent): Promise<PrimarySyncAck>; accept(intent: PrimaryIntent): Promise<PrimarySyncAck> }
/**
 * 5.3.1 step 7 on a single primary: the quarantined target replays the complete history from revision 1, confirms
 * the new sync configuration, then both external permits follow and the target leaves quarantine. A target whose
 * history does not start empty (e.g. an old primary with a forked candidate) is refused; snapshot bootstrap is open.
 */
export async function setStandby(o: Common & { transitionId: string; target: StandbyTarget; targetDataIncarnation: string }) {
	const rec = begin(o.journal, o.transitionId, "setStandby", { target: o.target.hostId });
	if (rec.phase === "started") {
		const resumed = await resumeSealed(o, o.transitionId, async () => {
			const h = o.journal.intent(o.journal.head().revision)!;
			await assertPermit(o.register, o.hostId, o.journal.configAt(h.revision - 1), "primary");
		}, i => o.target.accept(i));
		if (resumed) { rec.phase = "locallyCommitted"; rec.config = resumed; o.journal.saveTransition(o.transitionId, rec as unknown as Json); }
	}
	if (rec.phase === "started") {
		const c = o.journal.config;
		if (c.primaryReplica !== o.hostId || durabilityOf(c) !== "single") throw new ReplicaTransitionBlocked("setStandby starts from a single primary");
		if (o.targetDataIncarnation !== o.dataIncarnation) throw new ReplicaTransitionBlocked("the standby carries the shared data incarnation of the Space");
		await assertSharedIncarnation(o.register, o.hostId, c.spaceId, o.dataIncarnation);
		if ((await o.register.get<Boot & Json>(`boot:${o.target.hostId}`))?.value.state !== "quarantine") throw new ReplicaTransitionBlocked("the target must be in quarantine");
		if (o.journal.head().revision !== o.journal.appliedRevision) throw new ReplicaTransitionBlocked("resolve the sealed candidate first");
		await assertSyncPrimary(o.register, o.hostId, o.journal)();
		// Empty target only; a retry of the same transition may continue its own interrupted catch-up prefix.
		const th = await o.target.head();
		if (th.revision !== 0 && !(rec.catchingUp && o.journal.intent(th.revision)?.hash === th.hash)) throw new ReplicaTransitionBlocked("setStandby needs an empty target; a used replica is reinstalled first");
		rec.catchingUp = true; o.journal.saveTransition(o.transitionId, rec as unknown as Json);
		for (let r = 1; r <= o.journal.head().revision; r++) {
			const i = o.journal.intent(r)!, ack = await o.target.catchUp(i);
			if (ack.revision !== i.revision || ack.hash !== i.hash) throw new ReplicaTransitionBlocked("target history differs; only an empty target is supported");
		}
		const next: PrimarySyncConfig = { ...c, standbyReplica: o.target.hostId, durability: "sync", replicaConfigVersion: c.replicaConfigVersion + 1 };
		await applyConfigTransition(o.storage, o.journal, next, { reason: o.transitionId, peer: o.target, ctx: o.ctx, assert: () => assertPermit(o.register, o.hostId, c, "primary"), now: o.now });
		rec.phase = "locallyCommitted"; rec.config = next; o.journal.saveTransition(o.transitionId, rec as unknown as Json);
	}
	if (rec.phase === "locallyCommitted") {
		// Both replicas follow; the target leaves quarantine only now and only while this primary is still active.
		if ((await o.register.get<Boot & Json>(`boot:${o.hostId}`))?.value.state !== "active") throw new ReplicaTransitionBlocked(`${o.hostId} is no longer active`);
		await alignPermit({ ...o, dataIncarnation: o.targetDataIncarnation }, rec.config!, "standby", o.transitionId, { hostState: "active", requireHost: ["quarantine", "active"] }, o.target.hostId);
		await alignPermit(o, rec.config!, "primary", o.transitionId, { requireHost: ["active"] });
		rec.phase = "completed"; o.journal.saveTransition(o.transitionId, rec as unknown as Json);
	}
	return { transitionId: o.transitionId, config: o.journal.config };
}

/**
 * 3.6 re-admission after a fence: fenceHostBoot revokes every Space permit of the host, but a transition re-admits only
 * the Space it is about. The other Spaces come back one by one: the operator/supervisor side reactivates a revoked
 * permit with unchanged authority, role and data incarnation (never the fenced host itself, which only reads its boot
 * record), and the host then installs exactly that external permit locally after checking its own data incarnation.
 */
export function readmitSpace(register: RecoveryRegister, hostId: string, spaceId: string, o: { transitionId: string; expectedDataIncarnation: string }): Promise<Boot> {
	return casBoot(register, hostId, b => {
		const p = b?.spaces[spaceId];
		if (!b || b.state !== "active") throw new ReplicaTransitionBlocked(`${hostId} is not active; re-admit Spaces only after the host left quarantine`);
		if (!p) throw new ReplicaTransitionBlocked(`${hostId} has no permit for ${spaceId}`);
		if (["primary", "standby"].includes(p.role)) throw new ReplicaTransitionBlocked("replicated Spaces return only through promote, degradeToSingle or setStandby");
		if (p.state === "active" && p.dataIncarnation === o.expectedDataIncarnation) return null;
		if (p.state !== "revoked" || p.dataIncarnation !== o.expectedDataIncarnation) throw new ReplicaTransitionBlocked(`permit of ${spaceId} is not a revoked permit of incarnation ${o.expectedDataIncarnation}`);
		return { ...b, spaces: { ...b.spaces, [spaceId]: { ...p, state: "active", transitionId: o.transitionId } }, transitionId: o.transitionId };
	});
}
/** Host side: copies the active external permit of one Space into the local installation if its incarnation matches. */
export async function installAdmittedPermit(o: { external: RecoveryRegister; installed: RecoveryRegister; hostId: string; spaceId: string; localDataIncarnation: string }): Promise<SpaceBootPermit> {
	const b = (await o.external.get<Boot & Json>(`boot:${o.hostId}`))?.value, p = b?.spaces[o.spaceId];
	if (!b || b.state !== "active" || !p || p.state !== "active") throw new ReplicaTransitionBlocked(`no active external permit for ${o.spaceId}`);
	if (p.dataIncarnation !== o.localDataIncarnation) throw new ReplicaTransitionBlocked("external permit names another data incarnation than the local Space");
	const key = `installed:${o.hostId}:${o.spaceId}`, cur = await o.installed.get(key);
	if (!cur || !permitEq(cur.value, p)) await o.installed.compareAndSet(key, cur?.version ?? null, p as unknown as Json);
	return p;
}
