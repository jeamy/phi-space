import {ProfileTransitions} from './profile-transition-doc.ts';
// Authoritative policy persistence and supervisor signature; pure routing is separate.
import type {Context} from './context.ts';
import {defineDocFamily, type Tx} from '@earendil-works/pi-durable';

import type {Algorithm, Signer} from './auth.ts';
import {canonicalJson} from './canonical.ts';
import type {SpaceHost} from './client.ts';
import type {Json} from './core.ts';
import {touch} from './core.ts';
import {verifyDetached} from './grants.ts';
import {
    type FederationPolicy,
    RoutingConflict,
    type RoutingState,
    validateFederationPolicy
} from './routing-semantics.ts';
import {spaceDoc} from './spaces.ts';
import {ControlReplicaMarker} from './delegation.ts';
import { jsonCopy } from './json.ts';

export * from './routing-semantics.ts';
export const FederationRouting = defineDocFamily<RoutingState, null>({
    kind : 'phi-spaces.federation-routing',
    version : 1,
    scope : 'session',
    family : true,
    initial : () => ({policy : null, members : {}})
});
const copy = jsonCopy;
export type SignedFederationPolicy = {
    policy: FederationPolicy; issuer : string; algorithm : Algorithm; signature : string
};
const policyBytes = (p: FederationPolicy) =>
    Buffer.from('phi-spaces/federation-policy/v1\n' + canonicalJson(p as unknown as Json));
export class FederationPolicyAuthority {
    private o: {
        host: SpaceHost; ctx : Context; controlSpaceId : string; authorityId : string;
        peerId : string;
        signer : Signer;
        assertAuthority : () => Promise<void>
    };
    constructor(o: FederationPolicyAuthority['o']) { this.o = o; }
    async state(): Promise<RoutingState> {
        await this.o.assertAuthority();
        return copy(
            await this.o.host.snapshot(FederationRouting, this.o.controlSpaceId, this.o.ctx) ??
            {policy : null, members : {}});
    }
    async applyIn(tx: Tx, p: FederationPolicy, expectedVersion: number): Promise<FederationPolicy> {
        return applyFederationPolicyIn(tx, this.o.controlSpaceId, this.o.authorityId, p,
                                       expectedVersion);
    }

    async install(p: FederationPolicy, expectedVersion: number,
                  authorize: () => Promise<void>): Promise<SignedFederationPolicy> {
        await authorize();
        await this.o.assertAuthority();
        await this.o.host.commit(async tx => {
            await authorize();
            await this.o.assertAuthority();
            await this.applyIn(tx, p, expectedVersion);
        }, this.o.ctx);
        return this.signed();
    }
    async signed(): Promise<SignedFederationPolicy> {
        const {policy} = await this.state();
        if (!policy)
            throw new RoutingConflict('no federation policy installed');
        return {
            policy,
            issuer : this.o.peerId,
            algorithm : this.o.signer.algorithm,
            signature :
                Buffer.from(await this.o.signer.sign(policyBytes(policy))).toString('base64')
        };
    }
}
export function verifyFederationPolicy(
    t: SignedFederationPolicy,
    pin: {authorityId: string; peerId : string; algorithm : Algorithm; publicKey : string},
    minimum = 1): FederationPolicy {
    if (t.issuer !== pin.peerId || t.algorithm !== pin.algorithm ||
        t.policy.authorityId !== pin.authorityId || t.policy.policyVersion < minimum ||
        !verifyDetached(pin.algorithm, pin.publicKey, policyBytes(t.policy), t.signature))
        throw new RoutingConflict('policy signature/authority/version mismatch');
    return copy(t.policy);
}

export async function applyFederationPolicyIn(tx: Tx, controlSpaceId: string, authorityId: string,
                                              p: FederationPolicy, expectedVersion: number,
                                              allowedRemoval: ReadonlySet < string >=
                                                  new Set()): Promise<FederationPolicy> {
    const profiles=await tx.doc(ProfileTransitions,controlSpaceId,null);
    if(Object.values(profiles.operations).some(op=>op.phase!=='completed'))throw new RoutingConflict('profile transition blocks ordinary policy changes');
    const d = await tx.doc(FederationRouting, controlSpaceId, null);
    if ((d.policy?.policyVersion ?? 0) !== expectedVersion || p.authorityId !== authorityId)
        throw new RoutingConflict("stale policy command");
    validateFederationPolicy(p, d.members, d.policy, allowedRemoval);
    d.policy = copy(p);
    const control = await spaceDoc(tx, controlSpaceId, Date.now());
    control.authorityCounters ??= {routerEpoch : 0, policyVersion : 0};
    control.authorityCounters.policyVersion = p.policyVersion;
    touch(control, Date.now());
    return copy(p);
}

/**
 * v3 5.3.1 step 6, control special case: the replica transition of a primary/sync control store is a journal entry,
 * not a store commit, so its policy step follows in the first commit after it, before the host serves anything
 * (grants, router leases, Root). It records the transition in `ControlReplicaMarker` and raises `policyVersion` of
 * an installed routing policy in the same commit. Idempotent per transition ID; a crash in between is finished on the
 * next start.
 */
export async function alignControlReplicaIn(tx: Tx, controlSpaceId: string, authorityId: string,
                                            t: {transitionId: string; primaryEpoch: number; replicaConfigVersion: number; primaryReplica: string},
                                            before: {primaryEpoch: number; primaryReplica: string}): Promise<{aligned: boolean; policyVersion: number | null}> {
    const m = await tx.doc(ControlReplicaMarker, controlSpaceId, null);
    const d = await tx.doc(FederationRouting, controlSpaceId, null);
    if (m.transitionId === t.transitionId) return {aligned : false, policyVersion : d.policy?.policyVersion ?? null};
    // The epoch any outstanding lease can carry: the one of the last alignment (or of the configuration before).
    const fromEpoch = m.transitionId ? m.primaryEpoch : before.primaryEpoch,
          fromPrimary = m.transitionId ? m.primaryReplica : before.primaryReplica;
    let policyVersion: number | null = null;
    if (d.policy) {
        const p = copy(d.policy);
        p.policyVersion++;
        policyVersion = (await applyFederationPolicyIn(tx, controlSpaceId, authorityId, p, d.policy.policyVersion)).policyVersion;
    }
    Object.assign(m, {transitionId : t.transitionId, primaryEpoch : t.primaryEpoch, replicaConfigVersion : t.replicaConfigVersion,
                      fromEpoch, primaryReplica : t.primaryReplica, samePrimary : fromPrimary === t.primaryReplica});
    return {aligned : true, policyVersion};
}
/** Checked before a control transition commits: afterwards nothing may keep its policy step from completing. */
export async function controlAlignmentBlocker(host: SpaceHost, ctx: Context, controlSpaceId: string): Promise<string | null> {
    const profiles = await host.snapshot(ProfileTransitions, controlSpaceId, ctx);
    return Object.values(profiles?.operations ?? {}).some(op => op.phase !== 'completed') ? 'an open profile transition blocks the policy step of a control transition' : null;
}
