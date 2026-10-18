// Signed authority transitions and outside-snapshot installation. A missing register or missing fencing proof blocks recovery.
import { randomUUID } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import type { Json } from "./core.ts";
import type { Signer } from "./auth.ts";
import { verifyDetached } from "./grants.ts";
import type { RecoveryRegister } from "./recovery-register.ts";
import { RegisterConflict } from "./recovery-register.ts";

export type AuthorityTransition = { recoveryId: string; expectedAuthorityId: string; newAuthorityId: string; controlSpaceId: string; targetHostId: string; supervisorKey: string };
export type SignedAuthorityTransition = { transition: AuthorityTransition; algorithm: Signer["algorithm"]; signature: string };
export type AuthorityRecord = { authorityId: string; hostId: string; supervisorKey: string; state: "active" | "transitioning"; lineage: Record<string, AuthorityTransition> };
const signed = (t: AuthorityTransition) => Buffer.from("phi-spaces/recovery-authority/v1\n" + canonicalJson(t as unknown as Json));
export class RecoveryBlocked extends Error {}
/** This service belongs on the independent recovery-admin system. All admins use the same CAS register. */
export class RecoveryCoordinator {
	private register: RecoveryRegister; private signer: Signer;
	constructor(register: RecoveryRegister, signer: Signer) { this.register = register; this.signer = signer; }
	async reserve(o: Omit<AuthorityTransition, "newAuthorityId">, verifyFence: (hostId: string) => Promise<{ restartLocked: boolean; hostId: string }>): Promise<SignedAuthorityTransition> {
		const key = `authority:${o.controlSpaceId}`;
		const current = await this.register.get<AuthorityRecord & Record<string, Json>>(key);
		if (!current) throw new RecoveryBlocked("authority register has not been provisioned");
		const known = current.value.lineage[o.expectedAuthorityId];
		let transition: AuthorityTransition;
		if (known) {
			if (Object.keys(o).some(k => (known as any)[k] !== (o as any)[k])) throw new RegisterConflict("another successor decision already exists for this authority");
			transition = known;
		} else {
			if (current.value.authorityId !== o.expectedAuthorityId || current.value.state !== "active") throw new RegisterConflict("expected authority is not active");
			const proof = await verifyFence(current.value.hostId);
			if (!proof.restartLocked || proof.hostId !== current.value.hostId) throw new RecoveryBlocked("independently verified fencing with restart lock is required");
			transition = { ...o, newAuthorityId: `a-${randomUUID()}` };
			await this.register.compareAndSet(key, current.version, { authorityId: transition.newAuthorityId, hostId: transition.targetHostId, supervisorKey: transition.supervisorKey, state: "transitioning", lineage: { ...current.value.lineage, [o.expectedAuthorityId]: transition } } as unknown as AuthorityRecord & Record<string, Json>);
		}
		return { transition, algorithm: this.signer.algorithm, signature: Buffer.from(await this.signer.sign(signed(transition))).toString("base64") };
	}
}
/** The member's installation store is outside space snapshots. The recovery public key is provisioned locally. */
export async function installAuthorityTransition(local: RecoveryRegister, external: RecoveryRegister, proof: SignedAuthorityTransition, pinned: { algorithm: Signer["algorithm"]; publicKey: string }): Promise<AuthorityTransition> {
	const t = await verifyAuthorityTransition(external, proof, pinned);
	const key = `installed-authority:${t.controlSpaceId}`, prior = await local.get<{ authorityId: string; recoveryId?: string }>(key);
	if (prior?.value.authorityId === t.newAuthorityId && prior.value.recoveryId === t.recoveryId) return t;
	if (!prior || prior.value.authorityId !== t.expectedAuthorityId) throw new RegisterConflict("member authority changed or was not provisioned");
	await local.compareAndSet(key, prior.version, { authorityId: t.newAuthorityId, recoveryId: t.recoveryId, supervisorKey: t.supervisorKey, targetHostId: t.targetHostId });
	return t;
}
export async function verifyAuthorityTransition(external: RecoveryRegister, proof: SignedAuthorityTransition, pinned: { algorithm: Signer["algorithm"]; publicKey: string }): Promise<AuthorityTransition> {
	const t = proof?.transition;
	if (!t || ![t.recoveryId,t.expectedAuthorityId,t.newAuthorityId,t.controlSpaceId,t.targetHostId,t.supervisorKey].every(v => typeof v === "string" && v.length > 0 && v.length <= 1024) || t.expectedAuthorityId === t.newAuthorityId) throw new RecoveryBlocked("invalid authority transition identity");
	if (proof.algorithm !== pinned.algorithm || !verifyDetached(pinned.algorithm, pinned.publicKey, signed(t), proof.signature)) throw new RecoveryBlocked("invalid recovery signature");
	const authority = await external.get<AuthorityRecord & Record<string, Json>>(`authority:${t.controlSpaceId}`);
	if (!authority || canonicalJson(authority.value.lineage[t.expectedAuthorityId] as unknown as Json) !== canonicalJson(t as unknown as Json)) throw new RecoveryBlocked("transition is not the unique external successor decision");
	if (authority.value.authorityId !== t.newAuthorityId) throw new RecoveryBlocked("transition is no longer the current external successor");
	return t;
}
