// ReplicaConfigNotice (docs/federation-plan-v3.md 5.3.1 step 5): after promote, degradeToSingle or setStandby the
// primary of a replicated Space offers a signed notice of its new replica configuration; the router adopts it in a
// separate control commit that changes only that Member's replication and target binding and raises policyVersion.
// The signature only identifies the sender. The authority is the independent register: the router adopts a notice
// only if the named primary is active there with exactly this permit, which only a fenced transition can produce.
import type { Context } from "@earendil-works/chord";
import { canonicalJson } from "./canonical.ts";
import type { Algorithm, Signer } from "./auth.ts";
import type { SpaceHost } from "./client.ts";
import { verifyDetached } from "./grants.ts";
import type { Json } from "./core.ts";
import * as core from "./core.ts";
import { touch } from "./core.ts";
import type { RecoveryRegister } from "./recovery-register.ts";
import type { HostBootState } from "./boot.ts";
import { durabilityOf, PrimarySyncBlocked, type PrimarySyncJournal } from "./primary-sync.ts";
import { FederationRouting, RoutingConflict } from "./federation-policy.ts";
import { ProfileTransitions } from "./profile-transition-doc.ts";
import { snapshotSpace, spaceDoc } from "./spaces.ts";

export type ReplicaConfigNotice = {
	authorityId: string; spaceId: string; recoveryId: string; primaryReplica: string; standbyReplica: string | null;
	primaryEpoch: number; replicaConfigVersion: number; durability: "single" | "sync"; dataIncarnation: string;
};
export type SignedReplicaConfigNotice = { notice: ReplicaConfigNotice; issuer: string; algorithm: Algorithm; signature: string };
const bytes = (n: ReplicaConfigNotice) => Buffer.from("pi-spaces/replica-config-notice/v1\n" + canonicalJson(n as unknown as Json));

/**
 * The notice of a completed transition, derived from its configuration entry in the chain: a crash between completing
 * the transition and fetching the notice loses nothing, and repeating it yields the same body.
 */
export function replicaConfigNotice(journal: PrimarySyncJournal, transitionId: string, dataIncarnation: string): ReplicaConfigNotice {
	const rec = journal.transition<{ phase: string } & Json>(transitionId);
	if (rec?.phase !== "completed") throw new PrimarySyncBlocked("only a completed transition has a replica configuration notice");
	for (let r = journal.head().revision; r >= 1; r--) {
		const i = journal.intent(r)!;
		if (i.version === 2 && i.reason === transitionId) {
			const c = i.config;
			return { authorityId: c.authorityId, spaceId: c.spaceId, recoveryId: transitionId, primaryReplica: c.primaryReplica, standbyReplica: c.standbyReplica ?? null, primaryEpoch: c.primaryEpoch, replicaConfigVersion: c.replicaConfigVersion, durability: durabilityOf(c), dataIncarnation };
		}
	}
	throw new PrimarySyncBlocked("the transition has no configuration entry in this chain");
}
export async function signReplicaConfigNotice(notice: ReplicaConfigNotice, signer: Signer): Promise<SignedReplicaConfigNotice> {
	return { notice, issuer: notice.primaryReplica, algorithm: signer.algorithm, signature: Buffer.from(await signer.sign(bytes(notice))).toString("base64") };
}

const sameNotice = (n: ReplicaConfigNotice, r: { recoveryId?: string; primaryReplica: string; standbyReplica?: string; replicaConfigVersion: number; durability: string }, t: { hostId: string; primaryEpoch: number; dataIncarnation: string }) =>
	r.recoveryId === n.recoveryId && r.primaryReplica === n.primaryReplica && (r.standbyReplica ?? null) === n.standbyReplica && r.durability === n.durability && t.hostId === n.primaryReplica && t.primaryEpoch === n.primaryEpoch && t.dataIncarnation === n.dataIncarnation;
async function permitFor(register: RecoveryRegister, n: ReplicaConfigNotice) {
	const rec = await register.get<HostBootState & Json>(`boot:${n.primaryReplica}`), b = rec?.value, p = b?.spaces[n.spaceId];
	if (!b || b.state !== "active" || b.hostId !== n.primaryReplica || !p || p.state !== "active" || p.role !== "primary" || p.authorityId !== n.authorityId || p.primaryEpoch !== n.primaryEpoch || p.replicaConfigVersion !== n.replicaConfigVersion || p.durability !== n.durability || p.dataIncarnation !== n.dataIncarnation)
		throw new RoutingConflict("the register does not admit the notice's primary with this configuration");
	return rec!.version;
}

/**
 * Router side: adopts a notice idempotently. A higher version replaces the Member's replication and target binding
 * and raises policyVersion; the same version with the same recovery ID and content is a no-op; anything older or
 * conflicting is refused, so an old policy never resets a newer local configuration.
 */
export async function adoptReplicaConfigNotice(host: SpaceHost, ctx: Context, o: { controlSpaceId: string; authorityId: string; register: RecoveryRegister; issuerKey: (hostId: string) => Promise<{ algorithm: Algorithm; publicKey: string } | null> }, t: SignedReplicaConfigNotice): Promise<{ adopted: boolean; memberId: string; policyVersion: number }> {
	const n = t?.notice;
	if (!n || typeof n !== "object" || n.authorityId !== o.authorityId || !Number.isSafeInteger(n.replicaConfigVersion) || n.replicaConfigVersion < 1 || !Number.isSafeInteger(n.primaryEpoch) || n.primaryEpoch < 1 || !["single", "sync"].includes(n.durability) || (n.durability === "single") !== (n.standbyReplica === null) || typeof n.recoveryId !== "string" || typeof n.dataIncarnation !== "string")
		throw new RoutingConflict("invalid replica configuration notice");
	const key = await o.issuerKey(t.issuer);
	if (t.issuer !== n.primaryReplica || !key || key.algorithm !== t.algorithm || !verifyDetached(t.algorithm, key.publicKey, bytes(n), t.signature)) throw new RoutingConflict("notice is not signed by its primary");
	const registerVersion = await permitFor(o.register, n);
	return host.commit(async tx => {
		const profiles = await tx.doc(ProfileTransitions, o.controlSpaceId, null);
		if (Object.values(profiles.operations).some(op => op.phase !== "completed")) throw new RoutingConflict("profile transition blocks replica configuration adoption");
		const d = await tx.doc(FederationRouting, o.controlSpaceId, null);
		if (!d.policy || d.policy.authorityId !== o.authorityId) throw new RoutingConflict("no federation policy installed");
		const members = Object.values(d.members).filter(m => m.target.spaceId === n.spaceId && m.target.authorityId === n.authorityId);
		if (members.length !== 1) throw new RoutingConflict("the notice names no single Member Space");
		const m = members[0]!, r = m.replication;
		if (!r) throw new RoutingConflict("the Member is not replicated");
		if (r.replicaConfigVersion > n.replicaConfigVersion) throw new RoutingConflict("stale replica configuration notice");
		if (r.replicaConfigVersion === n.replicaConfigVersion) {
			if (!sameNotice(n, r, m.target)) throw new RoutingConflict("conflicting notice for an adopted replica configuration version");
			return { adopted: false, memberId: m.id, policyVersion: d.policy.policyVersion };
		}
		// The admitting permit must not have changed since it was read.
		if ((await o.register.get(`boot:${n.primaryReplica}`))?.version !== registerVersion) throw new RoutingConflict("boot permit changed during adoption");
		m.replication = { primaryReplica: n.primaryReplica, replicaConfigVersion: n.replicaConfigVersion, durability: n.durability, ...(n.standbyReplica ? { standbyReplica: n.standbyReplica } : {}), ...(r.backupReplica ? { backupReplica: r.backupReplica } : {}), recoveryId: n.recoveryId };
		m.target = { ...m.target, hostId: n.primaryReplica, primaryEpoch: n.primaryEpoch, dataIncarnation: n.dataIncarnation };
		d.policy = { ...d.policy, policyVersion: d.policy.policyVersion + 1 };
		const control = await spaceDoc(tx, o.controlSpaceId, Date.now());
		control.authorityCounters ??= { routerEpoch: 0, policyVersion: 0 };
		control.authorityCounters.policyVersion = d.policy.policyVersion;
		touch(control, Date.now());
		return { adopted: true, memberId: m.id, policyVersion: d.policy.policyVersion };
	}, ctx);
}

/** The notice of the newest completed transition in this chain, or null; what a primary keeps offering. */
export function latestReplicaConfigNotice(journal: PrimarySyncJournal, dataIncarnation: string): ReplicaConfigNotice | null {
	for (let r = journal.head().revision; r >= 1; r--) {
		const i = journal.intent(r)!;
		if (i.version !== 2) continue;
		if (journal.transition<{ phase: string } & Json>(i.reason)?.phase !== "completed") return null;
		return replicaConfigNotice(journal, i.reason, dataIncarnation);
	}
	return null;
}

/**
 * The pickup point in the control Space: a proven host publishes only its own signed notice (at most one per Space
 * and host); the router adopts what it finds there. The board stores; the adoption decides (signature and register).
 */
export class ReplicaNoticeBoard {
	private o: { host: SpaceHost; ctx: Context; controlSpaceId: string; hostForPeer?: (peerId: string) => string | undefined; assertAuthority: () => Promise<void>; now?: () => number };
	constructor(o: ReplicaNoticeBoard["o"]) { this.o = o; }
	/** peerId/roles MUST come from the authenticated connection, never from the body. */
	async publish(t: SignedReplicaConfigNotice, identity: { peerId: string; roles: readonly string[]; check?: () => void | Promise<void> }) {
		const n = t?.notice;
		if (!n || typeof t.issuer !== "string" || t.issuer !== n.primaryReplica || typeof n.spaceId !== "string" || !n.spaceId || n.spaceId.length > 128 || typeof t.signature !== "string" || Buffer.byteLength(JSON.stringify(t)) > 4096)
			throw new RoutingConflict("invalid replica configuration notice");
		if (!identity.roles.includes("host") || (this.o.hostForPeer?.(identity.peerId) ?? identity.peerId) !== t.issuer) throw new RoutingConflict("only the proven primary host publishes its notice");
		await identity.check?.(); await this.o.assertAuthority();
		return this.o.host.commit(async tx => {
			await identity.check?.(); await this.o.assertAuthority();
			const now = (this.o.now ?? Date.now)(), s = await spaceDoc(tx, this.o.controlSpaceId, now), fields = { spaceId: n.spaceId, issuer: t.issuer };
			const old = core.list(s, now, { type: "ReplicaConfigNotice", fields });
			if (old.some(e => canonicalJson(e.fields.signed as Json) === canonicalJson(t as unknown as Json))) return { stored: false };
			for (const e of old) core.probe(s, now, { type: "ReplicaConfigNotice", id: e.id }, null, true);
			core.write(s, now, { type: "ReplicaConfigNotice", fields: { ...fields, version: n.replicaConfigVersion, signed: structuredClone(t) as unknown as Json } }, null, core.FOREVER);
			return { stored: true };
		}, this.o.ctx);
	}
	async published(): Promise<SignedReplicaConfigNotice[]> {
		const s = await snapshotSpace(this.o.host, this.o.controlSpaceId, this.o.ctx);
		return core.list(s ?? core.initialState(), (this.o.now ?? Date.now)(), { type: "ReplicaConfigNotice" }).sort((a, b) => Number(a.fields.version) - Number(b.fields.version)).map(e => structuredClone(e.fields.signed) as unknown as SignedReplicaConfigNotice);
	}
	/** Router side: adopts every published notice in version order; refusals are reported, not fatal. */
	async adoptAll(adopt: (t: SignedReplicaConfigNotice) => Promise<{ adopted: boolean }>): Promise<{ adopted: number; refused: string[] }> {
		let adopted = 0; const refused: string[] = [];
		for (const t of await this.published()) {
			try { if ((await adopt(t)).adopted) adopted++; } catch (e) { refused.push(`${t.notice?.spaceId}@${t.notice?.replicaConfigVersion}: ${e instanceof Error ? e.message : String(e)}`); }
		}
		return { adopted, refused };
	}
}
