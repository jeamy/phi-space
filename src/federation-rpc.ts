// Production wire adapter: app-key proof, original grants and per-call signed delegation.
import {canonicalJson} from './canonical.ts';
import type {Signer} from './auth.ts';
import {argHash, NotCommitted, RequestConflict, RequestExpired, ResultExpired, IncarnationChanged, type ClaimView, type Principal} from './claims.ts';
import {PermissionError, ReplicaConfigPending, StalePolicyVersion, TransactionError, CompletionViolation, type Json, type Template} from './core.ts';
import {
    delegationForCall,
    signDelegation,
    type SignedRouterLease,
    type TargetRequest
} from './delegation.ts';
import type {FederationIO} from './federated-space.ts';
import type {SignedGrant} from './grants.ts';
import {RemoteError, RemoteSpace, type Transport} from './remote.ts';
import type {
    RouterOperation, RouterReceipt, RouterStep, RouterStepSpec, RouterTarget, TargetBinding} from
    './router.ts';
import type {RoutingState} from './routing-semantics.ts';
import {rpcDomain} from './rpc-domain.ts';
import type {Call} from './service.ts';

export class FederationRpc implements RouterTarget, FederationIO {
    readonly protocol = 'phi-spaces-rpc-v1' as const;
    private o: {
        state: () => Promise<RoutingState>; transport : (member: string) => Transport;
        signer : Signer;
        peerId : string;
        lease : () => Promise<SignedRouterLease>;
        grant : (principal: Principal) => Promise<SignedGrant>;
        now?: () => number
    };
    constructor(o: FederationRpc['o']) { this.o = o; }
    private async member(target: TargetBinding) { return (await this.bound(target, false)).id; }
    /**
     * The Member of a step's target binding. With `successor`, a replicated Member whose installed target moved on by
     * an adopted transition (degrade: same host, higher epoch; promotion: another host) also answers for the binding:
     * same Space, authority and data incarnation, installed epoch at least the bound one (v3 5.3.1, decided
     * 2026-10-18). Such a Member only resolves the bound request; it never receives its effect.
     */
    private async bound(target: TargetBinding, successor: boolean): Promise<{id: string; successor: boolean}> {
        const state = await this.o.state(),
              m = Object.values(state.members)
                      .find(m => m.target.spaceId === target.spaceId &&
                                 m.target.hostId === target.hostId);
        if (m && canonicalJson(m.target as unknown as Json) === canonicalJson(target as unknown as Json)) return {id: m.id, successor: false};
        const next = successor ? Object.values(state.members).find(m => m.replication && m.target.spaceId === target.spaceId &&
            m.target.authorityId === target.authorityId && m.target.dataIncarnation === target.dataIncarnation && m.target.primaryEpoch >= target.primaryEpoch) : undefined;
        if (!next) throw new Error('target binding no longer installed');
        return {id: next.id, successor: true};
    }
    private reference(s: Readonly<RouterStepSpec>&{requestId?: string}): TargetRequest {
        const d = rpcDomain({method : s.method, args : s.args as any}, s.principal);
        if (!s.requestId || !s.policyVersion)
            throw new Error('origin claim needs persisted request/policy');
        return {
            requestId : s.requestId,
            requestGeneration : s.generation,
            method : d.method,
            argumentHash : argHash(d.method, d.args),
            policyVersion : s.policyVersion
        };
    }
    private async remote(id: string, p: Principal, policyVersion?: number, ref?: TargetRequest, boundEpoch?: number) {
        const state = await this.o.state(), m = state.members[id];
        if (!m || !state.policy)
            throw new Error('Member or policy unavailable');
        const r = new RemoteSpace(this.o.transport(id), {
            space : m.target.spaceId,
            signer : this.o.signer,
            expectedGateHostId : m.target.hostId,
            ownPeerId : this.o.peerId,
            attempts : 1,
            now : this.o.now,
            grantProvider : async () => await this.o.grant(p) as any,
            delegationProvider : async (call, g) =>
                await signDelegation(
                    this.o.signer, delegationForCall({
                        call,
                        principal : p,
                        lease : await this.o.lease(),
                        policyVersion :
                            ref?.policyVersion ?? policyVersion ?? state.policy!.policyVersion,
                        spaceId : m.target.spaceId,
                        primaryEpoch : boundEpoch ?? m.target.primaryEpoch,
                        grant : g as unknown as SignedGrant,
                        targetRequest : [
                            'pollOperation', 'resolveOperation', 'cancelOperation', 'events', 'txn', 'lease'
                        ].includes(call.method)
                                            ? ref
                                            : undefined,
                        now : (this.o.now ?? Date.now)(),
                        replicaConfigVersion : m.replication?.replicaConfigVersion
                    })) as any
        });
        await r.authenticate();
        return r;
    }
    async step(id: string, p: Principal, method: RouterOperation, args: Json,
               policyVersion?: number, origin?: Readonly<RouterStep>): Promise<RouterStepSpec> {
        const state = await this.o.state(), m = state.members[id];
        if (!m)
            throw new Error('Member missing');
        const version=policyVersion??state.policy!.policyVersion,ref=origin&&!['take','read','write'].includes(method)?this.reference(origin):undefined;
        const a=args as any,b=origin?.args as any,txn=origin?.result as any;
        // A generation is an admission namespace, not an authentication. Each invoke still freshly proves its key,
        // obtains its grant/delegation and the Member checks this namespace and its deadline again at admission.
        const reuse=origin?.state==='done'&&origin.policyVersion===version&&origin.method==='txn'&&b?.action==='begin'&&txn?.id&&
            ((['take','read','write'].includes(method)&&a?.txn===txn.id)||(method==='txn'&&['commit','abort'].includes(a?.action)&&a.id===txn.id))&&
            canonicalJson(origin.target as any)===canonicalJson(m.target as any)&&canonicalJson(origin.principal as any)===canonicalJson(p as any)&&
            Number.isSafeInteger(origin.generationAdmitUntil)&&origin.generationAdmitUntil!>(this.o.now??Date.now)()+2000;
        const g=reuse?{generation:origin!.generation,admitUntil:origin!.generationAdmitUntil!}:await (await this.remote(id,p)).requestGeneration();
        return {
            target : m.target,
            principal : p,
            generation : g.generation,
            ...(Number.isSafeInteger(g.admitUntil)?{generationAdmitUntil:g.admitUntil}:{}),
            method,
            args,
            policyVersion : version,
            ...(ref ? {targetRequest : ref} : {})
        };
    }
    private receipt(s: Readonly<RouterStep>, outcome: RouterReceipt['outcome'], result?: Json,
                    evidence?: string): RouterReceipt {
        return {
            target : s.target,
            principal : s.principal,
            method : s.method,
            generation : s.generation,
            requestId : s.requestId,
            argHash : s.argHash,
            outcome,
            ...(result === undefined ? {} : {result}),
            ...(evidence ? {evidence} : {})
        };
    }
    async invoke(s: Readonly<RouterStep>) {
        // A successor of the binding only resolves: the request may have reached the earlier primary.
        if ((await this.bound(s.target, true)).successor) return this.resolve(s);
        const id = await this.member(s.target),
              r = await this.remote(id, s.principal, s.policyVersion, s.targetRequest);
        let answer:Awaited<ReturnType<RemoteSpace['requestBoundWithClaim']>>;
        try { answer=await r.requestBoundWithClaim({
            method : s.method,
            args : s.args as any,
            request : {generation : s.generation, requestId : s.requestId},
            frame : {authorityId : s.target.authorityId, primaryEpoch : s.target.primaryEpoch}
        }); }catch(e){
            // v3 6.2: decided after a promotion with a durable negative claim; the step had no effect.
            if(e instanceof NotCommitted)return this.receipt(s,'failed',undefined,'NotCommitted');
            // v3 5.3.1 step 5: refused before admission until the router adopts the replica configuration; retried later.
            if(e instanceof ReplicaConfigPending)return this.receipt(s,'notAdmitted',undefined,'ReplicaConfigPending');
            if(e instanceof StalePolicyVersion)return this.receipt(s,'notAdmitted',undefined,'StalePolicyVersion');
            if(e instanceof RequestConflict||e instanceof RequestExpired||e instanceof ResultExpired||e instanceof IncarnationChanged||e instanceof PermissionError||e instanceof TransactionError||e instanceof CompletionViolation)return this.receipt(s,'needsReview',undefined,e.constructor.name);
            throw e;
        }
        const witness=answer.claimReceipt;
        if(witness){
            const ref=this.reference(s),b=witness.binding;
            if(witness.protocol!=='phi-spaces-claim-receipt-v1'||witness.hostId!==s.target.hostId||!b||!b.principal||typeof b.principal!=='object'||typeof b.principal.peerId!=='string'||b.spaceId!==s.target.spaceId||b.authorityId!==s.target.authorityId||b.dataIncarnation!==s.target.dataIncarnation||b.primaryEpoch!==s.target.primaryEpoch||canonicalJson(b.principal as any)!==canonicalJson(s.principal as any)||b.generation!==s.generation||b.requestId!==s.requestId||b.method!==ref.method||b.argumentHash!==ref.argumentHash)
                return this.receipt(s,'needsReview',undefined,'inline claim binding mismatch');
            if(witness.resolution?.state==='notAdmitted')return this.receipt(s,'needsReview',undefined,'effect replied without retained admission');
            return this.checkedResolution(s,witness.resolution);
        }
        return this.resolve(s);
    }
    private checkedResolution(s:Readonly<RouterStep>,v:import('./claims.ts').AdmissionResolution):RouterReceipt{
        const ref=this.reference(s);
        if(!v||typeof v!=='object')return this.receipt(s,'needsReview',undefined,'invalid resolution response');
        if(v.state==='notAdmitted'){
            if(v.spaceId!==s.target.spaceId||v.authorityId!==s.target.authorityId||v.incarnation!==s.target.dataIncarnation||v.primaryEpoch!==s.target.primaryEpoch||v.generation!==s.generation||v.requestId!==s.requestId||v.method!==ref.method||v.argumentHash!==ref.argumentHash)return this.receipt(s,'needsReview',undefined,'invalid current-epoch admission proof');
            return this.receipt(s,'notAdmitted');
        }
        if(!['pending','done','cancelled'].includes(v.state)||v.method!==ref.method)return this.receipt(s,'needsReview',undefined,'invalid retained claim response');
        if(v.resultExpired||v.unknownOutcome||v.restoredHistory)return this.receipt(s,'needsReview',undefined,'retained outcome unavailable');
        return this.receipt(s,v.error?'failed':v.state==='done'?'done':v.state==='cancelled'?'cancelled':'pending',v.result,v.error?.code);
    }
    /**
     * A step refused before admission (ReplicaConfigPending, StalePolicyVersion) gets the current target, a new
     * generation and the current policy version, but only when every policy version since its own came from an adopted
     * replica notice (which changes nothing but the replica configuration). 'wait': nothing to change yet; 'refuse':
     * the refusal stands.
     */
    async reprepare(s: Readonly<RouterStep>): Promise<RouterStepSpec | 'wait' | 'refuse'> {
        const state = await this.o.state(), current = state.policy?.policyVersion;
        if (!current || !s.policyVersion || s.targetRequest || !['take', 'read', 'write'].includes(s.method)) return 'refuse';
        let b: {id: string; successor: boolean};
        try { b = await this.bound(s.target, true); } catch { return 'refuse'; }
        if (s.policyVersion === current && !b.successor) return s.evidence === 'ReplicaConfigPending' ? 'wait' : 'refuse';
        const notices = new Set(state.noticePolicyVersions ?? []);
        for (let v = s.policyVersion + 1; v <= current; v++) if (!notices.has(v)) return 'refuse';
        return this.step(b.id, s.principal, s.method, s.args, current);
    }
    async resolve(s: Readonly<RouterStep>) {
        // At a successor the delegation keeps the bound epoch: the Member decides the earlier request (v3 6.2).
        const {id, successor} = await this.bound(s.target, true),
              r = await this.remote(id, s.principal, s.policyVersion, this.reference(s), successor ? s.target.primaryEpoch : undefined);
        try {
            const ref=this.reference(s);
            let v:import('./claims.ts').AdmissionResolution;
            try{v=await r.resolveOperation({generation:s.generation,requestId:s.requestId},ref.method,ref.argumentHash,s.target.primaryEpoch);}catch(e){if(e instanceof RemoteError&&e.code==='UnsupportedMethod')v=await r.pollOperation({generation:s.generation,requestId:s.requestId});else throw e;}
            return this.checkedResolution(s,v);
        } catch (e) {
            if (e instanceof NotCommitted) return this.receipt(s, 'failed', undefined, 'NotCommitted');
            // The resolution itself waits for the adoption: the outcome stays unknown, nothing is decided.
            if (e instanceof ReplicaConfigPending) throw e;
            if (e instanceof RequestConflict || e instanceof RequestExpired || e instanceof ResultExpired ||
                e instanceof IncarnationChanged || e instanceof PermissionError || e instanceof TransactionError || e instanceof CompletionViolation)
                return this.receipt(s, 'needsReview', undefined, e.constructor.name);
            if (e instanceof RemoteError && [
                    'RequestConflict', 'RequestExpired', 'ResultExpired', 'IncarnationChanged', 'PermissionDenied', 'TransactionError', 'CompletionViolation'
                ].includes(e.code))
                return this.receipt(s, 'needsReview', undefined, e.code);
            throw e;
        }
    }
    async snapshot(id: string, p: Principal, template: Template, txn?: string) {
        const r = await this.remote(id, p);
        let page = await r.readPage(template, {txn}), entries = [...page.items ];
        const revision = page.rev;
        while (page.next) {
            page = await r.readPage(template, {txn, token : page.token, after : page.next});
            entries.push(...page.items);
        }
        return {entries, revision};
    }
    async events(id: string, p: Principal, registration: Readonly<RouterStepSpec>) {
        const ref = this.reference(registration as RouterStep),
              r = await this.remote(id, p, registration.policyVersion, ref);
        const page = await r.events();
        return {epoch : page.mailboxEpoch, events : page.events, gap : !!page.gap};
    }
    async ack(id: string, p: Principal, epoch: string, seq: number) {
        const r = await this.remote(id, p);
        await r.ack(epoch, seq);
    }
    async txnActive(id: string, p: Principal, txn: string,
                    registration?: Readonly<RouterStepSpec>) {
        const r = await this.remote(id, p, registration?.policyVersion,
                                    registration ? this.reference(registration as RouterStep)
                                                 : undefined);
        return (await r.requestBound({method : 'txn', args : {action : 'status', id : txn}}) as any)
                   .state === 'active';
    }
}
