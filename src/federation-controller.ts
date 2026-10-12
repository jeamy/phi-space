import {MemberStatusDirectory} from "./capability-directory.ts";
// Complete server-side Phase-2 composition; guards and original grants stay external inputs.
import type {Context} from '@earendil-works/chord';

import type {Algorithm, Signer} from './auth.ts';
import {canonicalJson} from './canonical.ts';
import type {Principal} from './claims.ts';
import type {SpaceHost} from './client.ts';
import type {SignedRouterLease} from './delegation.ts';
import {FederatedSpace} from './federated-space.ts';
import {FederationPolicyAuthority} from './federation-policy.ts';
import {memberReferencesIn} from './federation-references.ts';
import {FederationRpc} from './federation-rpc.ts';
import type {SignedGrant} from './grants.ts';
import {verifyDetached} from './grants.ts';
import {MembershipController, type MembershipTransport} from './membership.ts';
import type {Transport} from './remote.ts';
import {RemoteSpace} from './remote.ts';
import {RouterController} from './router.ts';
import {snapshotSpace} from "./spaces.ts";

export async function createFederationController(o: {
    host: SpaceHost; ctx : Context; controlSpaceId : string; authorityId : string; id : string;
    routerPeerId : string;
    routerSigner : Signer;
    controlPeerId : string;
    controlSigner : Signer;
    controlPublicKey : string;
    transport : (memberId: string) => Transport;
    memberPin : MembershipTransport['pin'];
    lease : () => Promise<SignedRouterLease>;
    grant : (principal: Principal) => Promise<SignedGrant>;
    assertAuthority : () => Promise<void>;
    authorizeAdmin : () => Promise<void>;
    probeStatus?: (memberId:string,target:Readonly<import("./router.ts").TargetBinding>)=>Promise<{revision:number;free:number;lag:number|null}>;
    now?: () => number
}) {
    const now = o.now ?? Date.now, guard = async () => {
        await o.assertAuthority();
        const t = await o.lease(), l = t.lease;
        if (t.issuer !== o.controlPeerId || t.algorithm !== o.controlSigner.algorithm ||
            !verifyDetached(t.algorithm, o.controlPublicKey,
                            Buffer.from('pi-spaces/router-lease/v1\n' + canonicalJson(l as any)),
                            t.signature) ||
            l.authorityId !== o.authorityId || l.controlSpaceId !== o.controlSpaceId ||
            l.routerPeerId !== o.routerPeerId || l.routerKeyId !== o.routerSigner.keyId ||
            now() >= l.expiresAt - 2000)
            throw new Error('RouterLease does not authorize journal owner');
        const control = await snapshotSpace(o.host, o.controlSpaceId, o.ctx);
        if (!control || control.authorityCounters?.routerEpoch !== l.routerEpoch ||
            (control.primaryEpoch ?? 1) !== l.controlPrimaryEpoch)
            throw new Error('RouterLease was superseded by Control');
    };
    const policy = new FederationPolicyAuthority({
        host : o.host,
        ctx : o.ctx,
        controlSpaceId : o.controlSpaceId,
        authorityId : o.authorityId,
        peerId : o.controlPeerId,
        signer : o.controlSigner,
        assertAuthority : o.assertAuthority
    });
    const rpc = new FederationRpc({
        state : () => policy.state(),
        transport : o.transport,
        signer : o.routerSigner,
        peerId : o.routerPeerId,
        lease : o.lease,
        grant : o.grant,
        now
    });
    const router = new RouterController({
        host : o.host,
        ctx : o.ctx,
        routerId : o.id,
        authorityId : o.authorityId,
        target : rpc,
        assertAuthority : guard,
        now
    });
    await router.recover();
    const space = new FederatedSpace({
        host : o.host,
        ctx : o.ctx,
        id : o.id,
        router,
        state : () => policy.state(),
        io : rpc,
        assertAuthority : guard,
        now,
        controlSpaceId : o.controlSpaceId
    });
    const refs = {controlSpaceId : o.controlSpaceId, routerId : o.id, federationId : o.id};
    const membership = new MembershipController({
        host : o.host,
        ctx : o.ctx,
        controlSpaceId : o.controlSpaceId,
        authorityId : o.authorityId,
        peerId : o.controlPeerId,
        signer : o.controlSigner,
        assertAuthority : guard,
        authorize : o.authorizeAdmin,
        hasReferences : async id => o.host.commit(
            async tx => {
                const m = (await policy.state()).members[id];
                return !!m && memberReferencesIn(tx, refs, id, m.target.spaceId);
            },
            o.ctx),
        hasReferencesIn : (tx, id, sid) => memberReferencesIn(tx, refs, id, sid),
        transport : {
            pin : o.memberPin,
            apply : async (m, q) => {
                const r = new RemoteSpace(o.transport(m.id), {
                    space : m.target.spaceId,
                    signer : o.routerSigner,
                    ownPeerId : o.routerPeerId,
                    expectedGateHostId : m.target.hostId,
                    now,
                    attempts : 1
                });
                await r.authenticate();
                return r.requestMembership(q);
            }
        }
    });
    const directory=o.probeStatus?new MemberStatusDirectory({host:o.host,ctx:o.ctx,controlSpaceId:o.controlSpaceId,assertAuthority:guard,now,probe:o.probeStatus}):undefined;
    return {space, router, rpc, membership, policy, directory};
}
