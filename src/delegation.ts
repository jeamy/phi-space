// AP 2.2: supervisor-issued leases and double-signed, principal-bound delegation.
import type {Context} from "./context.ts";
import { diskMapOf, type StoreTx } from "./store/types.ts";
import { defineDocFamily } from "./store/documents.ts";
import {randomUUID} from "node:crypto";

import type {Algorithm, AuthState, KeyDirectory, Signer} from "./auth.ts";
import {canonicalJson} from "./canonical.ts";
import {argHash, keyOf, resolveAdmission, validateGeneration, type ClaimRec, type Principal, type RequestRef} from "./claims.ts";
import type {SpaceHost} from "./client.ts";
import * as core from "./core.ts";
import {GrantVerifier, type SignedGrant, verifyDetached} from "./grants.ts";
import {rpcDomain} from "./rpc-domain.ts";
import type {Call, Connection, DecisionAuthorization, Identity} from "./service.ts";
import {listSpaces, snapshotSpace, spaceDoc} from "./spaces.ts";

export type RouterLease = {
    id: string; routerPeerId : string; routerKeyId : string; routerEpoch : number;
    controlSpaceId : string;
    authorityId : string;
    controlPrimaryEpoch : number;
    issuedAt : number;
    expiresAt : number
};
export type SignedRouterLease = {
    lease: RouterLease; issuer : string; algorithm : Algorithm; signature : string
};
export type TargetRequest = {
    requestId: string; requestGeneration : string; method : string; argumentHash : string;
    policyVersion : number
};
export type Delegation = {
    issuer: string; routerLease : SignedRouterLease; principal : Principal; targetSpace : string;
    targetPrimaryEpoch : number;
    operation : string;
    requestId : string;
    requestGeneration : string;
    argumentHash : string;
    targetRequest?: TargetRequest; policyVersion : number; issuedAt : number; expiresAt : number;
    /** Only for replicated Members: the replica configuration version the router routed under. */
    targetReplicaConfigVersion?: number
};
export type SignedDelegation = {
    delegation: Delegation; keyId : string; algorithm : Algorithm; signature : string
};
export type EpochNotice = {
    authorityId: string; controlSpaceId : string; routerEpoch : number;
    controlPrimaryEpoch : number;
    policyVersion : number;
    issuedAt : number;
    expiresAt : number
};
export type SignedEpochNotice = {
    notice: EpochNotice; issuer : string; algorithm : Algorithm; signature : string
};
const bytes = (kind: string, v: unknown) =>
    Buffer.from("phi-spaces/" + kind + "/v1\n" + canonicalJson(v as core.Json));
const same = (a: unknown, b: unknown) =>
    canonicalJson(a as core.Json) === canonicalJson(b as core.Json);
const positive = (n: unknown) => Number.isSafeInteger(n) && Number(n) > 0;
export class DelegationDenied extends core.PermissionError {}
/** v3 5.3.1 step 5: the Member changed its replica configuration and the router has not adopted the notice yet. */
export { ReplicaConfigPending } from "./core.ts";
import { ReplicaConfigPending } from "./core.ts";
export const DelegationEpochs =
    defineDocFamily<{routerEpoch : number; controlPrimaryEpoch : number; policyVersion : number},
                    null>({
        kind : "phi-spaces.delegation-epochs",
        version : 1,
        scope : "session",
        family : true,
        initial : () => ({routerEpoch : 0, controlPrimaryEpoch : 0, policyVersion : 0})
    });
/**
 * v3 5.3.1 step 6: the last replica transition of a primary/sync control store, aligned in the control Space before
 * anything serves (`alignControlReplicaIn`). A transition that keeps the primary (degradeToSingle, setStandby) lets
 * the current router renew its lease from exactly the epoch before it; a primary change never does.
 */
export const ControlReplicaMarker =
    defineDocFamily<{transitionId : string | null; primaryEpoch : number; replicaConfigVersion : number;
                     fromEpoch : number; primaryReplica : string | null; samePrimary : boolean},
                    null>({
        kind : "phi-spaces.control-replica-marker",
        version : 1,
        scope : "session",
        family : true,
        initial : () => ({transitionId : null, primaryEpoch : 0, replicaConfigVersion : 0, fromEpoch : 0,
                          primaryReplica : null, samePrimary : false})
    });
/** Maximum clock uncertainty between control and router hosts for a router change. */
export const ROUTER_CHANGE_SKEW_MS = 5_000;
const epochKey = (authority: string, space: string) => canonicalJson([ authority, space ]);
async function fencePending(tx: StoreTx, space: string, now: number,
                            e: {routerEpoch: number; controlPrimaryEpoch : number}) {
    const s = await spaceDoc(tx, space, now);
    // waiters of requests carry their claim's key; the search by result is for states from before that (claims on the
    // disk are newer), and only when such a waiter is there
    let all: ClaimRec[] | undefined;
    const claims = { find: (f: (c: ClaimRec) => boolean) => diskMapOf(s.rpc?.claims) ? undefined : (all ??= Object.values(s.rpc?.claims ?? {})).find(f) };
    for (const w of s.waiters) {
        const c = w.claimKey ? s.rpc?.claims[w.claimKey]
                             : claims.find(c => c.method === "wait" && c.result === w.id);
        if (c?.routerEpoch !== undefined &&
            (c.routerEpoch < e.routerEpoch ||
             (c.controlPrimaryEpoch ?? 0) < e.controlPrimaryEpoch) &&
            ((w.authorizedUntil ?? core.FOREVER) > now)) {
            w.authorizedUntil = now;
            core.touch(s, now);
        }
    }
}
/** The boot-guarded authoritative control host commits the lease before signing it. */
export class RouterLeaseAuthority {
    private o: {
        host: SpaceHost; ctx : Context; controlSpaceId : string; authorityId : string;
        peerId : string;
        signer : Signer;
        keys : KeyDirectory;
        assertAuthority : () => Promise<void>;
        now?: () => number;
        /** Control on primary/sync: the control primary epoch comes from its journal, not the Space document. */
        controlEpoch?: () => number
    };
    constructor(o: RouterLeaseAuthority["o"]) { this.o = o; }
    async issue(routerPeerId: string, routerKeyId: string,
                renew?: {id: string; routerEpoch : number; token?:SignedRouterLease}): Promise<SignedRouterLease> {
        await this.o.assertAuthority();
        const key = await this.o.keys.find(routerPeerId, routerKeyId);
        if (!key || key.state !== "active" || !key.roles.includes("router"))
            throw new DelegationDenied("lease requires an active router key");
        const lease = await this.o.host.commit(async tx => {
            await this.o.assertAuthority();
            const now = (this.o.now ?? Date.now)(),
                  s = await spaceDoc(tx, this.o.controlSpaceId, now);
            s.authorityCounters ??= {routerEpoch : 0, policyVersion : 1};
            const live = core.list(s, now, {type : "RouterLease"})[0];
            let epoch = s.authorityCounters.routerEpoch;
            if (renew) {
                const current=this.o.controlEpoch?.()??s.primaryEpoch??1;
                // A lease from the epoch before an aligned same-primary transition renews; anything else must match.
                const epochOk=async(e:unknown)=>{if(e===current)return true;const m=await tx.doc(ControlReplicaMarker,this.o.controlSpaceId,null);return !!m.transitionId&&m.samePrimary&&m.primaryEpoch===current&&m.fromEpoch===e;};
                const retained=renew.token, l=retained?.lease;
                const signedRetained=!!retained&&!!l&&!!this.o.signer.publicKey&&retained.issuer===this.o.peerId&&retained.algorithm===this.o.signer.algorithm&&verifyDetached(retained.algorithm,this.o.signer.publicKey,bytes("router-lease",l),retained.signature)&&l.id===renew.id&&l.routerPeerId===routerPeerId&&l.routerKeyId===routerKeyId&&l.routerEpoch===renew.routerEpoch&&l.authorityId===this.o.authorityId&&l.controlSpaceId===this.o.controlSpaceId&&await epochOk(l.controlPrimaryEpoch);
                if (renew.routerEpoch!==epoch||!(signedRetained||live&&live.fields.id===renew.id&&live.fields.routerPeerId===routerPeerId&&live.fields.routerKeyId===routerKeyId&&live.fields.routerEpoch===renew.routerEpoch&&await epochOk(live.fields.controlPrimaryEpoch)))
                    throw new DelegationDenied("lease renewal no longer owns current epoch");
            } else {
                // A different router (v3 5.2) starts only after the previous lease expired plus the clock uncertainty;
                // the same router restarting with a higher epoch fences its own older frames.
                if (live && (live.fields.routerPeerId !== routerPeerId || live.fields.routerKeyId !== routerKeyId) && now < Number(live.fields.expiresAt) + ROUTER_CHANGE_SKEW_MS)
                    throw new DelegationDenied(`previous router lease is live until ${new Date(Number(live.fields.expiresAt) + ROUTER_CHANGE_SKEW_MS).toISOString()}`);
                if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch >= Number.MAX_SAFE_INTEGER)
                    throw new DelegationDenied("router epoch overflow/corruption");
                epoch++;
                s.authorityCounters.routerEpoch = epoch;
            }
            const result: RouterLease = {
                id : renew?.id ?? randomUUID(),
                routerPeerId,
                routerKeyId,
                routerEpoch : epoch,
                controlSpaceId : this.o.controlSpaceId,
                authorityId : this.o.authorityId,
                controlPrimaryEpoch : this.o.controlEpoch?.() ?? s.primaryEpoch ?? 1,
                issuedAt : now,
                expiresAt : now + 60000
            };
            if (live)
                core.probe(s, now, {id : live.id}, null, true);
            core.write(s, now, {type : "RouterLease", fields : result as unknown as core.Fields},
                       null, 60000);
            return result;
        }, this.o.ctx);
        await this.o.assertAuthority();
        return {
            lease,
            issuer : this.o.peerId,
            algorithm : this.o.signer.algorithm,
            signature : Buffer.from(await this.o.signer.sign(bytes("router-lease", lease)))
                            .toString("base64")
        };
    }
    async notice(policyVersion: number): Promise<SignedEpochNotice> {
        await this.o.assertAuthority();
        const s = await snapshotSpace(this.o.host, this.o.controlSpaceId, this.o.ctx);
        if (!s || !s.authorityCounters || !positive(policyVersion) ||
            policyVersion !== s.authorityCounters.policyVersion)
            throw new DelegationDenied("no authoritative epoch state");
        const now = (this.o.now ?? Date.now)(), notice: EpochNotice = {
            authorityId : this.o.authorityId,
            controlSpaceId : this.o.controlSpaceId,
            routerEpoch : s.authorityCounters.routerEpoch,
            controlPrimaryEpoch : this.o.controlEpoch?.() ?? s.primaryEpoch ?? 1,
            policyVersion,
            issuedAt : now,
            expiresAt : now + 60000
        };
        return {
            notice,
            issuer : this.o.peerId,
            algorithm : this.o.signer.algorithm,
            signature : Buffer.from(await this.o.signer.sign(bytes("epoch-notice", notice)))
                            .toString("base64")
        };
    }
}
export async function signDelegation(signer: Signer, d: Delegation): Promise<SignedDelegation> {
    return {
        delegation : d,
        keyId : signer.keyId,
        algorithm : signer.algorithm,
        signature : Buffer.from(await signer.sign(bytes("delegation", d))).toString("base64")
    };
}
export function delegationForCall(o: {
    call: Call; principal : Principal; lease : SignedRouterLease; policyVersion : number;
    spaceId : string;
    primaryEpoch : number;
    grant : SignedGrant;
    targetRequest?: TargetRequest;
    now?: number;
    replicaConfigVersion?: number
}): Delegation {
    const now = o.now ?? Date.now(), domain = rpcDomain(o.call, o.principal),
          request = o.call.request ?? {requestId : randomUUID(), generation : "non-mutating"};
    return {
        issuer : o.lease.lease.routerPeerId,
        routerLease : o.lease,
        principal : o.principal,
        targetSpace : o.spaceId,
        targetPrimaryEpoch : o.primaryEpoch,
        operation : o.call.method,
        requestId : request.requestId,
        requestGeneration : request.generation,
        argumentHash : argHash(domain.method, domain.args),
        ...(o.targetRequest ? {targetRequest : o.targetRequest} : {}),
        policyVersion : o.policyVersion,
        ...(o.replicaConfigVersion !== undefined ? {targetReplicaConfigVersion : o.replicaConfigVersion} : {}),
        issuedAt : now,
        expiresAt : Math.min(now + 60000, o.lease.lease.expiresAt, o.grant.grant.expiresAt)
    };
}
type VerifierOptions = {
    host: SpaceHost; ctx : Context; authorityId : string; controlSpaceId : string;
    supervisorPeerId : string;
    supervisorKey : {algorithm : Algorithm; publicKey : string};
    keys : KeyDirectory;
    grants : GrantVerifier;
    policy : () => Promise<{authorityId : string; policyVersion : number}>;
    now?: () => number;
    uncertaintyMs?: number;
    /** Replica configuration of a primary/sync Space (its journal); null for other Spaces. */
    replicaConfig?: (spaceId: string) => {replicaConfigVersion : number; primaryEpoch?: number} | null
};
export class DelegationVerifier {
    private o: VerifierOptions;
    constructor(o: VerifierOptions) {
        if (!Number.isFinite(o.uncertaintyMs ?? 2000) || (o.uncertaintyMs ?? 2000) < 0 ||
            (o.uncertaintyMs ?? 2000) > 5000)
            throw new DelegationDenied("invalid clock uncertainty");
        this.o = o;
    }
    private now() { return (this.o.now ?? Date.now)(); }
    private lifetime(v: {issuedAt: number; expiresAt : number}) {
        const margin = this.o.uncertaintyMs ?? 2000;
        if (!Number.isSafeInteger(v.issuedAt) || !Number.isSafeInteger(v.expiresAt) ||
            v.expiresAt <= v.issuedAt || v.expiresAt - v.issuedAt > 60000 ||
            v.issuedAt > this.now() + margin || this.now() + margin >= v.expiresAt)
            throw new DelegationDenied("delegation or lease expired");
    }
    private supervisor(kind: string, v: unknown,
                       t: {issuer: string; algorithm : Algorithm; signature : string}) {
        if (t.issuer !== this.o.supervisorPeerId ||
            t.algorithm !== this.o.supervisorKey.algorithm ||
            !verifyDetached(t.algorithm, this.o.supervisorKey.publicKey, bytes(kind, v),
                            t.signature))
            throw new DelegationDenied("invalid supervisor signature");
    }
    async epochNotice(t: SignedEpochNotice, spaceId: string) {
        this.supervisor("epoch-notice", t.notice, t);
        this.lifetime(t.notice);
        if (t.notice.authorityId !== this.o.authorityId ||
            t.notice.controlSpaceId !== this.o.controlSpaceId || !positive(t.notice.routerEpoch) ||
            !positive(t.notice.controlPrimaryEpoch) || !positive(t.notice.policyVersion))
            throw new DelegationDenied("epoch notice binding mismatch");
        const info = (await listSpaces(this.o.host, this.o.ctx))
                         .find(i => i.spaceId === spaceId || i.alias === spaceId);
        if (!info)
            throw new DelegationDenied("unknown epoch-notice space");
        spaceId = info.spaceId;
        await this.o.host.commit(async tx => {
            const e = await tx.doc(DelegationEpochs, epochKey(this.o.authorityId, spaceId), null);
            e.routerEpoch = Math.max(e.routerEpoch, t.notice.routerEpoch);
            e.controlPrimaryEpoch = Math.max(e.controlPrimaryEpoch, t.notice.controlPrimaryEpoch);
            e.policyVersion = Math.max(e.policyVersion, t.notice.policyVersion);
            await fencePending(tx, spaceId, this.now(), e);
        }, this.o.ctx);
    }
    async check(call: Call, transport: Identity, conn: Connection): Promise<DecisionAuthorization> {
        const t = call.frame?.delegation as unknown as SignedDelegation, d = t?.delegation,
              l = d?.routerLease?.lease, proof = (conn.state as AuthState | undefined)?.proof;
        if (!d || !l || !proof || conn.peerId !== transport.principal.peerId ||
            d.issuer !== conn.peerId || d.issuer !== l.routerPeerId || proof.keyId !== t.keyId ||
            l.routerKeyId !== t.keyId)
            throw new DelegationDenied("delegation requires its proven router connection");
        const router = await this.o.keys.find(conn.peerId, t.keyId);
        if (!router || router.state !== "active" || !router.roles.includes("router") ||
            router.algorithm !== t.algorithm ||
            !verifyDetached(t.algorithm, router.publicKey, bytes("delegation", d), t.signature))
            throw new DelegationDenied("invalid router signature/key");
        this.supervisor("router-lease", l, d.routerLease);
        this.lifetime(l);
        this.lifetime(d);
        if (l.authorityId !== this.o.authorityId || l.controlSpaceId !== this.o.controlSpaceId ||
            !positive(l.routerEpoch) || !positive(l.controlPrimaryEpoch) ||
            d.expiresAt > l.expiresAt)
            throw new DelegationDenied("lease authority/epochs mismatch");
        const info =
            (await listSpaces(this.o.host, this.o.ctx))
                .find(i => i.spaceId === call.space || i.alias === (call.space ?? "default"));
        if (!info || d.targetSpace !== info.spaceId)
            throw new DelegationDenied("delegation audience mismatch");
        const s = (await snapshotSpace(this.o.host, info.spaceId, this.o.ctx))!;
        if (d.operation !== call.method || !d.principal?.peerId || !positive(d.policyVersion))
            throw new DelegationDenied("delegation operation/principal mismatch");
        const domain = rpcDomain(call, d.principal);
        if (d.argumentHash !== argHash(domain.method, domain.args) ||
            call.request && (call.request.requestId !== d.requestId ||
                             call.request.generation !== d.requestGeneration))
            throw new DelegationDenied("delegation request/hash mismatch");
        const ref: RequestRef = {
            principal : d.principal,
            generation : d.requestGeneration,
            requestId : d.requestId
        },
                   known = s.rpc?.claims[keyOf(s, ref)] ?? s.restoredClaims?.[keyOf(s, ref)];
        let reference = known, missingResolution = false;
        if (d.targetRequest) {
            const r = {
                principal : d.principal,
                generation : d.targetRequest.requestGeneration,
                requestId : d.targetRequest.requestId
            };
            reference = s.rpc?.claims[keyOf(s, r)] ?? s.restoredClaims?.[keyOf(s, r)];
            missingResolution=call.method==='resolveOperation'&&!reference;
            if(missingResolution){
                if(d.policyVersion!==d.targetRequest.policyVersion||call.args?.method!==d.targetRequest.method||call.args?.argumentHash!==d.targetRequest.argumentHash||call.args?.primaryEpoch!==d.targetPrimaryEpoch)throw new DelegationDenied('missing resolution binding differs');
                // The same epoch is checked here; an earlier one is decided by the service (NotCommitted needs evidence).
                const current=this.o.replicaConfig?.(info.spaceId)?.primaryEpoch??s.primaryEpoch??1;
                if(d.targetPrimaryEpoch===current)resolveAdmission(s,this.now(),r,d.targetRequest.method,d.targetRequest.argumentHash,d.targetPrimaryEpoch!);else validateGeneration(s,this.now(),r);
            }
            if (!missingResolution && (!reference || reference.method !== d.targetRequest.method ||
                reference.argHash !== d.targetRequest.argumentHash ||
                (reference.policyVersion ?? 1) !== d.targetRequest.policyVersion ||
                d.policyVersion !== d.targetRequest.policyVersion))
                throw new DelegationDenied("targetRequest does not name own bound claim");
            if (call.method === "pollOperation" || call.method === "resolveOperation" || call.method === "cancelOperation") {
                const a = call.args?.targetRequest as any;
                if(call.method==='resolveOperation'&&(call.args?.method!==d.targetRequest.method||call.args?.argumentHash!==d.targetRequest.argumentHash||call.args?.primaryEpoch!==d.targetPrimaryEpoch))throw new DelegationDenied('wire resolution binding differs');
                if (!a || a.generation !== r.generation || a.requestId !== r.requestId)
                    throw new DelegationDenied("wire targetRequest differs");
            } else if (call.method === "txn" || call.method === "lease") {
                const result = reference!.result as any;
                const ownWaitLease = call.method === "lease" && reference!.method === "wait" &&
                                     call.args?.id === result;
                const ownWaitTxn =
                    reference!.method === "wait" &&
                    (s.txns[String(call.args?.id)]?.originRequestKey === keyOf(s, r) || !!known);
                if (!ownWaitLease && !ownWaitTxn &&
                    (!result || call.args?.id !== (result.txn?.id ?? result.txn ?? result.id)))
                    throw new DelegationDenied("txn follow-up is not bound to target result");
            } else if (call.method === "events") {
                if (reference!.method !== "wait" || typeof reference!.result !== "string")
                    throw new DelegationDenied("events renewal must name own waiter registration");
            } else
                throw new DelegationDenied("targetRequest forbidden for this follow-up");
        } else if ([ "pollOperation", "resolveOperation", "cancelOperation" ].includes(call.method) ||
                   (call.method === "txn" && call.args?.action !== "begin" ||
                    call.method === "lease"))
            throw new DelegationDenied("follow-up requires targetRequest");
        // A replicated Space takes its epoch from the replica configuration (journal); its document keeps the epoch
        // it was created with, transitions only change the configuration.
        const replica = this.o.replicaConfig?.(info.spaceId);
        const epoch = replica?.primaryEpoch ?? s.primaryEpoch ?? 1;
        // A router behind an adopted transition (older epoch, other configuration version) waits for the adoption: new
        // work is pending, not denied (v3 5.3.1 step 5).
        if (replica && !reference && !missingResolution && positive(d.targetPrimaryEpoch) && d.targetPrimaryEpoch <= epoch &&
            d.targetReplicaConfigVersion !== replica.replicaConfigVersion)
            throw new ReplicaConfigPending(`replica configuration ${replica.replicaConfigVersion} is not adopted by the router yet`);
        if (!positive(d.targetPrimaryEpoch) ||
            call.frame?.primaryEpoch !== undefined &&
                call.frame.primaryEpoch !== d.targetPrimaryEpoch ||
            d.targetPrimaryEpoch > epoch || d.targetPrimaryEpoch < epoch && !reference && !missingResolution)
            throw new DelegationDenied("target epoch does not match new or known request");
        // New work on a replicated Space needs the router to route under the local replica configuration; follow-ups
        // of operations admitted before the change continue under their original binding.
        if (replica && !reference && d.targetReplicaConfigVersion !== replica.replicaConfigVersion)
            throw new ReplicaConfigPending(`replica configuration ${replica.replicaConfigVersion} is not adopted by the router yet`);
        const policy = await this.o.policy();
        if (policy.authorityId !== this.o.authorityId || !positive(policy.policyVersion))
            throw new DelegationDenied("new operation must use current installed policy");
        // Resolving a missing request decides only its outcome (notAdmitted or NotCommitted, no effect): like other
        // follow-ups it runs under the request's own policy version, bound by targetRequest above.
        if (!reference && !missingResolution && d.policyVersion !== policy.policyVersion)
            throw new core.StalePolicyVersion("new operation must use current installed policy");
        if (known && (known.policyVersion ?? 1) !== d.policyVersion)
            throw new DelegationDenied("retry changed original policy");
        const grant = call.frame?.grant as unknown as SignedGrant, g = grant?.grant;
        if (!g?.keyId || !same(g.principal, d.principal) || d.expiresAt > g.expiresAt)
            throw new DelegationDenied("delegation must carry original principal grant");
        const original = await this.o.keys.find(d.principal.peerId, g.keyId);
        if (!original || original.state !== "active")
            throw new DelegationDenied("original principal key revoked");
        const auth = this.o.grants.check(call.frame?.grant,
                                         {principal : d.principal, roles : original.roles},
                                         {...call, space : info.alias});
        const until = Math.min(auth.validUntil, d.expiresAt - (this.o.uncertaintyMs ?? 2000),
                               l.expiresAt - (this.o.uncertaintyMs ?? 2000));
        const key = epochKey(this.o.authorityId, info.spaceId);
        await this.o.host.commit(async tx => {
            const e = await tx.doc(DelegationEpochs, key, null);
            if (l.routerEpoch < e.routerEpoch || l.controlPrimaryEpoch < e.controlPrimaryEpoch ||
                !reference && !missingResolution && d.policyVersion < e.policyVersion)
                throw new DelegationDenied("delegation superseded by higher epoch/policy");
            e.routerEpoch = Math.max(e.routerEpoch, l.routerEpoch);
            e.controlPrimaryEpoch = Math.max(e.controlPrimaryEpoch, l.controlPrimaryEpoch);
            e.policyVersion = Math.max(e.policyVersion, policy.policyVersion);
            await fencePending(tx, info.spaceId, this.now(), e);
        }, this.o.ctx);
        return {
            ...auth,
            principal : d.principal,
            transportPeerId : conn.peerId,
            allowClosedWaiter : call.method === "lease" && call.args?.action === "cancel" &&
                                    reference?.method === "wait",
            renewalWaiterId :
                call.method === "events" && d.targetRequest ? reference!.result as string : null,
            routerEpoch : l.routerEpoch,
            controlPrimaryEpoch : l.controlPrimaryEpoch,
            policyVersion : d.policyVersion,
            knownRequest : !!reference,
            validUntil : until,
            check : () => {
                auth.check();
                if (this.now() >= until)
                    throw new DelegationDenied("delegation expired before decision");
            },
            checkTx : async (tx: StoreTx) => {
                const e = await tx.doc(DelegationEpochs, key, null);
                if (e.routerEpoch > l.routerEpoch ||
                    e.controlPrimaryEpoch > l.controlPrimaryEpoch ||
                    !reference && !missingResolution && e.policyVersion > d.policyVersion)
                    throw new DelegationDenied("epoch changed before commit");
            }
        };
    }
}

/** One process owns this provider. Restart obtains a new epoch; failed renewals never reuse an expired lease. */
export function renewableRouterLease(remote:{requestRouterLease(renew?:{id:string;routerEpoch:number}):Promise<SignedRouterLease>},now:()=>number=Date.now):()=>Promise<SignedRouterLease>{
 let cached:SignedRouterLease|undefined,pending:Promise<SignedRouterLease>|undefined;
 return async()=>{if(cached&&now()<cached.lease.issuedAt+20000&&now()<cached.lease.expiresAt-2000)return core.plain(cached);pending??=remote.requestRouterLease(cached?{id:cached.lease.id,routerEpoch:cached.lease.routerEpoch}:undefined).then(t=>{cached=t;return t;}).finally(()=>{pending=undefined;});return core.plain(await pending);};
}
