import {ProfileTransitions} from './profile-transition-doc.ts';
// Authoritative policy persistence and supervisor signature; pure routing is separate.
import type {Context} from '@earendil-works/chord';
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

export * from './routing-semantics.ts';
export const FederationRouting = defineDocFamily<RoutingState, null>({
    kind : 'pi-spaces.federation-routing',
    version : 1,
    scope : 'session',
    family : true,
    initial : () => ({policy : null, members : {}})
});
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
export type SignedFederationPolicy = {
    policy: FederationPolicy; issuer : string; algorithm : Algorithm; signature : string
};
const policyBytes = (p: FederationPolicy) =>
    Buffer.from('pi-spaces/federation-policy/v1\n' + canonicalJson(p as unknown as Json));
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
