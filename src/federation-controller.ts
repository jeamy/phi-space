import {ProfileTransitionController} from './profile-transition.ts';
import {AsyncLocalStorage} from 'node:async_hooks';
import {MemberStatusDirectory} from "./capability-directory.ts";
// Complete server-side Phase-2 composition; guards and original grants stay external inputs.
import type {Context} from '@earendil-works/chord';

import type {Algorithm, Signer} from './auth.ts';
import {canonicalJson} from './canonical.ts';
import type {Principal} from './claims.ts';
import type {SpaceHost} from './client.ts';
import type {SignedRouterLease} from './delegation.ts';
import {partitionRouterId, validateJournalPartitions} from './federation-journals.ts';
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
    probeStatus?: (memberId:string,target:Readonly<import("./router.ts").TargetBinding>)=>Promise<{revision:number;free:number|null;lag:number|null}>;
    journalPartitions?: number;
    now?: () => number
}) {
    const inCommit=new AsyncLocalStorage<boolean>();
    // Lease renewal may commit to the same Control host. Never invoke it inside a journal commit.
    const host=new Proxy(o.host,{get(target,property){
        if(property==='commit')return (fn:any,ctx:Context)=>target.commit(tx=>inCommit.run(true,()=>fn(tx)),ctx);
        const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
    }});
    let cachedLease:SignedRouterLease|undefined;
    const lease=async()=>{const t=await o.lease();cachedLease=structuredClone(t);return t;};
    const now = o.now ?? Date.now, guard = async () => {
        await o.assertAuthority();
        const t=inCommit.getStore()?cachedLease:await lease();
        if(!t)throw new Error('RouterLease was not validated before journal commit');
        const l=t.lease;
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
        host,
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
        lease,
        grant : o.grant,
        now
    });
    const router = new RouterController({
        host,
        ctx : o.ctx,
        routerId : o.id,
        authorityId : o.authorityId,
        target : rpc,
        assertAuthority : guard,
        now
    });
    const partitions=o.journalPartitions??1;
    validateJournalPartitions(partitions);
    const partitionRouters=partitions===1?[router]:Array.from({length:partitions},(_,n)=>new RouterController({
        host,ctx:o.ctx,routerId:partitionRouterId(o.id,n),authorityId:o.authorityId,
        target:rpc,assertAuthority:guard,now
    }));
    const space = new FederatedSpace({
        host,
        ctx : o.ctx,
        id : o.id,
        router,
        journalPartitions:partitions,
        partitionRouters,
        state : () => policy.state(),
        io : rpc,
        assertAuthority : guard,
        now,
        controlSpaceId : o.controlSpaceId
    });
    await space.initializeJournals();
    await RouterController.recoverMany([router,...partitionRouters]);
    const refs = {controlSpaceId : o.controlSpaceId, routerId : o.id, federationId : o.id};
    const membershipTransport:MembershipTransport = {
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
        };
    const membership = new MembershipController({
        host,
        ctx : o.ctx,
        controlSpaceId : o.controlSpaceId,
        authorityId : o.authorityId,
        peerId : o.controlPeerId,
        signer : o.controlSigner,
        assertAuthority : guard,
        authorize : o.authorizeAdmin,
        hasReferences : async id => host.commit(
            async tx => {
                const m = (await policy.state()).members[id];
                return !!m && memberReferencesIn(tx, refs, id, m.target.spaceId);
            },
            o.ctx),
        hasReferencesIn : (tx, id, sid) => memberReferencesIn(tx, refs, id, sid),
        transport: membershipTransport
    });
    const directory=o.probeStatus?new MemberStatusDirectory({host,ctx:o.ctx,controlSpaceId:o.controlSpaceId,assertAuthority:guard,now,probe:o.probeStatus}):undefined;
    const profiles=new ProfileTransitionController({host,ctx:o.ctx,controlSpaceId:o.controlSpaceId,authorityId:o.authorityId,federationId:o.id,journalPartitions:partitions,peerId:o.controlPeerId,signer:o.controlSigner,transport:membershipTransport,assertAuthority:guard,authorize:o.authorizeAdmin});
    return {space, profiles, router, partitionRouters: Object.freeze(partitionRouters), rpc, membership, policy, directory};
}
