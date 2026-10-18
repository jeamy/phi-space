import {ProfileTransitions} from './profile-transition-doc.ts';
// Durable membership transitions; remote calls run outside Control commits.
import {validateProfileOnlyChange} from './profile-policy.ts';
import type {Context} from '@earendil-works/chord';
import {defineDocFamily} from '@earendil-works/pi-durable';

import type {Algorithm, Signer} from './auth.ts';
import {canonicalJson,digestJson} from './canonical.ts';
import type {SpaceHost} from './client.ts';
import * as core from './core.ts';
import type {Json} from './core.ts';
import {
    applyFederationPolicyIn,
    FederationRouting,
    type SignedFederationPolicy,
    verifyFederationPolicy
} from './federation-policy.ts';
import {verifyDetached} from './grants.ts';
import {assertMemberWrite, permitRoutedWrite} from './member-admission.ts';
import {
    type FederationMember,
    type FederationPolicy,
    type FederationRule,
    hrw,
    MigrationRequired,
    normalizeFederatedEntry,
    RoutingConflict,
    ruleFor
} from './routing-semantics.ts';
import {snapshotSpace, spaceDoc} from './spaces.ts';

const copy = core.plain;
const hash = (v: unknown) => digestJson(v as Json);
const policyPushId = (id: string, version: number) => 'policy.' + hash([ id, version ]).slice(0, 48);
export type MembershipInstruction = {
    id: string; authorityId : string; memberId : string; spaceId : string;
    action : 'prepareAdd' | 'activate' | 'drain' | 'freeze' | 'detach' | 'policy' | 'rejectAdd' | 'profileFreeze' | 'profileInstall' | 'profileResume';
    policy?: FederationPolicy;
    previousPolicy?:FederationPolicy;
    expectedAdmissionVersion?: number
};
export type MembershipProof = {
    id: string; authorityId : string; memberId : string; spaceId : string;
    action : MembershipInstruction['action'];
    admissionVersion : number;
    revision : number;
    entryTypes : string[];
    stock : core.EntryDraft[];
    empty : boolean;
    state : string
};
export type SignedMembership < T >= {
    value: T;
    issuer: string;
    algorithm: Algorithm;
    signature: string
};
const bytes = (kind: string, v: unknown) =>
    Buffer.from('phi-spaces/membership-' + kind + '/v1\n' + canonicalJson(v as Json));
export async function signMembership<T>(kind: 'instruction'|'proof', value: T, issuer: string,
                                        signer: Signer): Promise<SignedMembership<T>> {
    return {
        value : copy(value),
        issuer,
        algorithm : signer.algorithm,
        signature : Buffer.from(await signer.sign(bytes(kind, value))).toString('base64')
    };
}
export function verifyMembership<T>(
    kind: 'instruction'|'proof', t: SignedMembership<T>,
    pin: {issuer: string; algorithm : Algorithm; publicKey : string}): T {
    if (!t || t.issuer !== pin.issuer || t.algorithm !== pin.algorithm ||
        !verifyDetached(pin.algorithm, pin.publicKey, bytes(kind, t.value), t.signature))
        throw new RoutingConflict('invalid membership signature');
    return copy(t.value);
}
const MemberTransitions = defineDocFamily<{
    admissionVersion?: number; steps : Record<string,
                                              {
                                                  hash: string;
                                                  proof: MembershipProof
                                              }>
},
                                          null>({
    kind : 'phi-spaces.member-transitions',
    version : 1,
    scope : 'session',
    family : true,
    initial : () => ({steps : {}})
});
/** Only pinned Control instructions may change admission; an uncertain transition stays frozen. */
export class MemberLifecycle {
    private o: {
        host: SpaceHost; ctx : Context; memberId : string; spaceId : string; authorityId : string;
        peerId : string;
        signer : Signer;
        controlPin : {issuer : string; algorithm : Algorithm; publicKey : string};
        assertAuthority : () => Promise<void>;
        now?: () => number
    };
    constructor(o: MemberLifecycle['o']) { this.o = o; }
    async installPolicy(token: SignedFederationPolicy): Promise<void> {
        const p = verifyFederationPolicy(token, {
            authorityId : this.o.authorityId,
            peerId : this.o.controlPin.issuer,
            algorithm : this.o.controlPin.algorithm,
            publicKey : this.o.controlPin.publicKey
        });
        await this.o.assertAuthority();
        // An identical signed policy needs no mutation. Use the normal guarded snapshot
        // and recheck authority before returning; changes still use the guarded commit.
        const installed = (await snapshotSpace(this.o.host, this.o.spaceId, this.o.ctx))?.membership;
        if (installed && ['active', 'draining'].includes(installed.state) &&
            p.policyVersion === installed.policy?.policyVersion && hash(p) === hash(installed.policy)) {
            await this.o.assertAuthority();
            return;
        }
        await this.o.host.commit(async tx => {
            await this.o.assertAuthority();
            const s = await spaceDoc(tx, this.o.spaceId, (this.o.now ?? Date.now)()),
                  a = s.membership;
            if (!a || !['active', 'draining'].includes(a.state))
                return;
            if (p.policyVersion < (a.policy?.policyVersion ?? 0))
                throw new RoutingConflict('installed policy cannot regress');
            if (p.policyVersion === (a.policy?.policyVersion ?? 0)) {
                if (hash(p) !== hash(a.policy))
                    throw new RoutingConflict('policy changed within version');
                return;
            }
            if(a.policy)assertOrdinaryProfiles(a.policy,p);
            a.policy = copy(p);
            core.assertGatedProfilesKept(s, p.completionProfiles);
            s.completionProfiles = copy(p.completionProfiles);
            core.touch(s, (this.o.now ?? Date.now)());
        }, this.o.ctx);
    }
    async apply(t: SignedMembership<MembershipInstruction>):
        Promise<SignedMembership<MembershipProof>> {
        const q = verifyMembership('instruction', t, this.o.controlPin);
        if (q.authorityId !== this.o.authorityId || q.memberId !== this.o.memberId ||
            q.spaceId !== this.o.spaceId || !q.id || q.id.length > 128)
            throw new RoutingConflict('membership instruction binding mismatch');
        const key = hash([ q.id, q.action ]);
        await this.o.assertAuthority();
        const proof = await this.o.host.commit(async tx => {
            await this.o.assertAuthority();
            const d = await tx.doc(MemberTransitions, this.o.spaceId, null);
            if (d.steps[key]) {
                if (d.steps[key]!.hash !== hash(q))
                    throw new RoutingConflict('transition ID changed instruction');
                return copy(d.steps[key]!.proof);
            }
            if (Object.keys(d.steps).length >= 128)
                throw new RoutingConflict('transition history full');
            const now = (this.o.now ?? Date.now)(), s = await spaceDoc(tx, this.o.spaceId, now);
            core.assertAdminIdle(s);
            core.settle(s, now);
            const a = s.membership;
            if (q.expectedAdmissionVersion !== undefined &&
                (a?.admissionVersion ?? 0) !== q.expectedAdmissionVersion)
                throw new RoutingConflict('admission version mismatch');
            if (q.action === 'prepareAdd') {
                if (a && a.state !== 'detached')
                    throw new RoutingConflict('Member is already managed or frozen');
                if (Object.keys(s.txns).length || s.waiters.length ||
                    Object.values(s.rpc?.claims ?? {}).some(c => c.state === 'pending') ||
                    (s.jobs ?? []).length)
                    throw new RoutingConflict('local work must settle before adding');
                s.membership = {
                    memberId : q.memberId,
                    authorityId : q.authorityId,
                    policy : null,
                    state : 'adding',
                    admissionVersion :
                        Math.max(d.admissionVersion ?? 0, a?.admissionVersion ?? 0) + 1,
                    transitionId : q.id
                };
            } else if (q.action === 'rejectAdd') {
                if (!a || a.state !== 'adding' || a.transitionId !== q.id)
                    throw new RoutingConflict('only matching uncommitted add may be rejected');
                delete s.membership;
            } else if (q.action === 'activate') {
                if (!a || a.state !== 'adding' || a.transitionId !== q.id || !q.policy ||
                    q.policy.authorityId !== q.authorityId)
                    throw new RoutingConflict('activation needs matching frozen add');
                a.policy = copy(q.policy);
                permitRoutedWrite(s, true);
                for (const e of s.entries.filter(e=>!["Capability","MemberStatus"].includes(e.type))) {
                    const normalized = normalizeFederatedEntry(q.policy, e);
                    assertMemberWrite({...s, membership : {...a, state : 'active'}}, normalized,
                                      e.writtenUnder, now);
                }
                core.assertGatedProfilesKept(s, q.policy.completionProfiles);
                s.completionProfiles = copy(q.policy.completionProfiles);
                a.state = 'active';
                a.admissionVersion++;
            } else if (q.action === 'profileFreeze') {
                if(!a||a.state!=='active'||!a.policy||!q.policy)throw new RoutingConflict('profile freeze requires active policy');
                const base=q.previousPolicy??a.policy;
                if(base.authorityId!==a.authorityId||base.policyVersion<a.policy.policyVersion||base.policyVersion===a.policy.policyVersion&&hash(base)!==hash(a.policy))throw new RoutingConflict('profile predecessor disagrees with installed policy');
                assertOrdinaryProfiles(a.policy,base);
                const affected=validateProfileOnlyChange(base,q.policy);
                if(Object.keys(s.txns).length||s.waiters.length||s.regs.length||(s.jobs??[]).length||(s.releaseQueue??[]).length||Object.values(s.rpc?.claims??{}).some(c=>c.state==='pending')||s.entries.some(e=>affected.some(type=>e.types.includes(type))))throw new RoutingConflict('profile transition requires no affected Tasks or open work');
                a.policy=copy(base);a.state='profileFrozen';a.profileTransition={id:q.id,hash:hash(q.policy)};a.admissionVersion++;
            } else if (q.action === 'profileInstall') {
                if(!a||a.state!=='profileFrozen'||!a.policy||!q.policy||a.profileTransition?.id!==q.id||a.profileTransition.hash!==hash(q.policy))throw new RoutingConflict('profile install requires matching frozen transition');
                validateProfileOnlyChange(a.policy,q.policy);a.policy=copy(q.policy);core.assertGatedProfilesKept(s,q.policy.completionProfiles);s.completionProfiles=copy(q.policy.completionProfiles);a.admissionVersion++;
            } else if (q.action === 'profileResume') {
                if(!a||a.state!=='profileFrozen'||!q.policy||a.profileTransition?.id!==q.id||hash(a.policy)!==hash(q.policy)||a.profileTransition.hash!==hash(q.policy))throw new RoutingConflict('profile resume requires installed transition');
                a.state='active';delete a.profileTransition;a.admissionVersion++;
            } else if (q.action === 'policy') {
                if (!a || !['active', 'draining'].includes(a.state) || !q.policy ||
                    q.policy.authorityId !== a.authorityId ||
                    q.policy.policyVersion < (a.policy?.policyVersion ?? 0))
                    throw new RoutingConflict('invalid installed policy transition');
                if (q.policy.policyVersion === (a.policy?.policyVersion ?? 0) &&
                    hash(q.policy) !== hash(a.policy))
                    throw new RoutingConflict('policy version changed content');
                if(a.policy)assertOrdinaryProfiles(a.policy,q.policy);
                a.policy = copy(q.policy);
                core.assertGatedProfilesKept(s, q.policy.completionProfiles);
                s.completionProfiles = copy(q.policy.completionProfiles);
            } else if (q.action === 'drain') {
                if (!a || a.state !== 'active')
                    throw new RoutingConflict('drain requires active Member');
                a.state = 'draining';
                a.admissionVersion++;
                a.transitionId = q.id;
                a.drainAt = now;
                a.cutRevision = s.stream?.rev ?? 0;
                for (const t of Object.values(s.txns)) {
                    t.completion ??= {
                        admissionVersion : a.admissionVersion - 1,
                        until : Math.min(t.expires, now + 60000),
                        remainingBytes : 65536,
                        remainingCount : 8,
                        preBoundary : true
                    };
                    t.completion.until = Math.min(t.expires, now + 60000);
                    t.completion.preBoundary = true;
                    t.expires = Math.min(t.expires, t.completion.until);
                }
            } else if (q.action === 'freeze') {
                if (!a || a.state !== 'draining')
                    throw new RoutingConflict('freeze requires drained Member');
                for(const e of [...s.entries]) if(e.type==="Capability") core.probe(s,now,{id:e.id,type:e.type},null,true);
                if (s.entries.length || Object.keys(s.txns).length || s.waiters.length ||
                    Object.values(s.rpc?.claims ?? {}).some(c => c.state === 'pending') ||
                    (s.jobs ?? []).length || (s.releaseQueue ?? []).length)
                    throw new RoutingConflict('Member still has physical entries or open work');
                core.closeRegistrationsForRemoval(s, now);
                core.settle(s, now);
                if ((s.jobs ?? []).length)
                    throw new RoutingConflict('closing registrations has pending delivery work');
                a.state = 'removing';
                a.admissionVersion++;
                a.transitionId = q.id;
            } else if (q.action === 'detach') {
                if (!a || a.state !== 'removing' || a.transitionId !== q.id)
                    throw new RoutingConflict('detach requires matching removal');
                if (s.entries.length || Object.keys(s.txns).length || s.waiters.length ||
                    s.regs.length || (s.jobs ?? []).length ||
                    Object.values(s.rpc?.claims ?? {}).some(c => c.state === 'pending'))
                    throw new RoutingConflict('EmptyProof no longer holds');
                a.state = 'detached';
                a.admissionVersion++;
            } else
                throw new RoutingConflict('unknown membership action');
            d.admissionVersion =
                Math.max(d.admissionVersion ?? 0,
                         s.membership?.admissionVersion ?? ((a?.admissionVersion ?? 0) + 1));
            core.touch(s, now);
            const proof: MembershipProof = {
                id : q.id,
                authorityId : q.authorityId,
                memberId : q.memberId,
                spaceId : q.spaceId,
                action : q.action,
                admissionVersion : d.admissionVersion,
                revision : s.stream?.rev ?? 0,
                entryTypes : [...new Set(s.entries.filter(e=>!["Capability","MemberStatus"].includes(e.type)).flatMap(e => e.types)) ].sort(),
                stock :
                    q.action === 'prepareAdd'
                        ? s.entries.filter(e=>!["Capability","MemberStatus"].includes(e.type)).map(
                              e =>
                                  ({type : e.type, types : [...e.types ], fields : copy(e.fields)}))
                        : [],
                empty : !s.entries.length && !Object.keys(s.txns).length && !s.waiters.length &&
                            !s.regs.length && !(s.jobs ?? []).length &&
                            !Object.values(s.rpc?.claims ?? {}).some(c => c.state === 'pending'),
                state : s.membership?.state ?? "local"
            };
            if (Buffer.byteLength(JSON.stringify(proof.stock)) > 65536)
                throw new RoutingConflict("stock proof exceeds inspection budget");
            d.steps[key] = {hash : hash(q), proof};
            return copy(proof);
        }, this.o.ctx);
        await this.o.assertAuthority();
        return signMembership('proof', proof, this.o.peerId, this.o.signer);
    }
}
type MembershipOperation = {
    hash: string; kind : 'add' | 'drain' | 'remove'; member : FederationMember;
    phase : 'accepted' | 'prepared' | 'committed' | 'completed' | 'failed';
    error?: string;
    policy?: FederationPolicy;
    proof?: MembershipProof;
    newDefault?: string
};
export const MembershipJournal =
    defineDocFamily<{operations : Record<string, MembershipOperation>}, null>({
        kind : 'phi-spaces.membership-journal',
        version : 1,
        scope : 'session',
        family : true,
        initial : () => ({operations : {}})
    });
export interface MembershipTransport {
    apply(member: FederationMember, instruction: SignedMembership<MembershipInstruction>):
        Promise<SignedMembership<MembershipProof>>;
    pin(member: FederationMember):
        Promise<{issuer : string; algorithm : Algorithm; publicKey : string}>;
}
export class MembershipController {
    private o: {
        host: SpaceHost; ctx : Context; controlSpaceId : string; authorityId : string;
        peerId : string;
        signer : Signer;
        transport : MembershipTransport;
        assertAuthority : () => Promise<void>;
        authorize : () => Promise<void>;
        hasReferences : (memberId: string) => Promise<boolean>;
        hasReferencesIn : (tx: import("@earendil-works/pi-durable").Tx, memberId: string,
                           spaceId: string) => Promise<boolean>
    };
    constructor(o: MembershipController['o']) { this.o = o; }
    private async change<T>(f: (d: {operations:
                                        Record<string, MembershipOperation>}) => Promise<T>) {
        await this.o.assertAuthority();
        await this.o.authorize();
        return this.o.host.commit(async tx => {
            await this.o.assertAuthority();
            const profiles=await tx.doc(ProfileTransitions,this.o.controlSpaceId,null);
            if(Object.values(profiles.operations).some(op=>op.phase!=='completed'))throw new RoutingConflict('profile transition blocks membership changes');
            const d = await tx.doc(MembershipJournal, this.o.controlSpaceId, null);
            return f(d);
        }, this.o.ctx);
    }
    private async call(id: string, op: MembershipOperation, action: MembershipInstruction['action'],
                       policy?: FederationPolicy) {
        const q: MembershipInstruction = {
            id,
            authorityId : this.o.authorityId,
            memberId : op.member.id,
            spaceId : op.member.target.spaceId,
            action,
            ...(policy ? {policy} : {})
        };
        await this.o.assertAuthority();
        const signed = await signMembership('instruction', q, this.o.peerId, this.o.signer),
              reply = await this.o.transport.apply(op.member, signed),
              p = verifyMembership('proof', reply, await this.o.transport.pin(op.member));
        if (p.id !== id || p.authorityId !== q.authorityId || p.memberId !== q.memberId ||
            p.spaceId !== q.spaceId || p.action !== action)
            throw new RoutingConflict('Member proof binding mismatch');
        return p;
    }
    private async currentPolicy(op: MembershipOperation) {
        const current =
                  await this.o.host.snapshot(FederationRouting, this.o.controlSpaceId, this.o.ctx),
              latest = current?.policy;
        if (!latest || latest.authorityId !== this.o.authorityId ||
            latest.policyVersion < op.policy!.policyVersion)
            throw new RoutingConflict(
                'installed policy is older than the committed membership policy');
        return {current : current!, latest};
    }
    async execute(id: string, kind: MembershipOperation['kind'], member: FederationMember,
                  newDefault?: string) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ||
            [ 'constructor', 'prototype', '__proto__' ].includes(id))
            throw new RoutingConflict('invalid membership command ID');
        if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(member.id)||["constructor","prototype","__proto__"].includes(member.id)||member.target.authorityId!==this.o.authorityId)throw new RoutingConflict("invalid Member identity/authority");
        const h = hash([ kind, member, newDefault ?? null ]);
        let op = await this.change(async d => {
            const existing = d.operations[id];
            if (existing) {
                if (existing.hash !== h)
                    throw new RoutingConflict('command ID changed arguments');
                return copy(existing);
            }
            if (Object.values(d.operations).some(o => !['completed', 'failed'].includes(o.phase)))
                throw new RoutingConflict('unresolved membership transition');
            if (Object.keys(d.operations).length >= 64)
                throw new RoutingConflict('membership history full');
            const o: MembershipOperation = {
                hash : h,
                kind,
                member : copy(member),
                phase : 'accepted',
                ...(newDefault ? {newDefault} : {})
            };
            d.operations[id] = o;
            return copy(o);
        });
        if (op.phase === 'completed')
            return op;
        if (op.phase === 'failed') {
            if (op.kind === 'add' && op.error)
                await this.call(id, op, 'rejectAdd');
            return op;
        }
        const save = async () => this.change(async d => { d.operations[id] = copy(op); });
        let state =
            await this.o.host.snapshot(FederationRouting, this.o.controlSpaceId, this.o.ctx);
        if (!state)
            state = {policy : null, members : {}};
        if (kind === 'add') {
            if (op.phase === 'accepted') {
                if (state.members[member.id])
                    throw new RoutingConflict('Member ID already registered');
                op.proof = await this.call(id, op, 'prepareAdd');
                op.phase = 'prepared';
                await save();
            }
            if (op.phase === 'prepared') {
                const table = copy(state.members);
                table[member.id] = {...member, state : 'adding'};
                let validationError: unknown;
                try {
                    let policy = state.policy ? copy(state.policy) : {
                        authorityId : this.o.authorityId,
                        policyVersion : 0,
                        rules : [],
                        completionProfiles : [],
                        default : {mode : 'local' as const, member : member.id}
                    };
                    policy.policyVersion++;
                    for (const e of op.proof!.stock) {
                        if (!policy.rules.some(r => r.type === e.type))
                            policy.rules.push({
                                type : e.type,
                                supertypes : e.types?.filter(t => t !== e.type),
                                mode : 'local',
                                member : member.id
                            });
                        const normalized = normalizeFederatedEntry(policy, e),
                              r = ruleFor(policy, e.type);
                        let target: string|undefined;
                        if ('member' in r)
                            target = r.member;
                        else if (r.mode === 'expand' && r.by === 'type')
                            target = hrw(r.type, r.members);
                        else if (r.mode === 'expand' && typeof r.by === 'object') {
                            if (!Object.hasOwn(e.fields, r.by.field))
                                throw new RoutingConflict('stock lacks placement key');
                            target = hrw(e.fields[r.by.field]!, r.members);
                        } else if (!r.members.includes(member.id))
                            throw new RoutingConflict('stock not in selection search set');
                        if (target && target !== member.id)
                            throw new RoutingConflict('existing stock belongs to another Member');
                        if (hash([...(e.types ?? []) ].filter(t => t !== e.type).sort()) !==
                            hash(normalized.types))
                            throw new RoutingConflict(
                                'stock has incomplete declared type hierarchy');
                    }
                } catch (e) {
                    validationError = e;
                }
                if (validationError) {
                    op.phase = 'failed';
                    op.error = validationError instanceof Error ? validationError.message
                                                                : String(validationError);
                    await save();
                    await this.call(id, op, 'rejectAdd');
                    return copy(op);
                }
                const policy = state.policy ? copy(state.policy) : {
                    authorityId : this.o.authorityId,
                    policyVersion : 0,
                    rules : [],
                    completionProfiles : [],
                    default : {mode : 'local' as const, member : member.id}
                };
                policy.policyVersion++;
                for (const e of op.proof!.stock)
                    if (!policy.rules.some(r => r.type === e.type))
                        policy.rules.push({
                            type : e.type,
                            supertypes : e.types?.filter(t => t !== e.type),
                            mode : 'local',
                            member : member.id
                        });
                await this.o.host.commit(async tx => {
                    await this.o.assertAuthority();
                    const d = await tx.doc(FederationRouting, this.o.controlSpaceId, null);
                    if (d.members[member.id])
                        throw new RoutingConflict('member concurrently added');
                    d.members[member.id] = table[member.id]!;
                    await applyFederationPolicyIn(tx, this.o.controlSpaceId, this.o.authorityId,
                                                  policy, state!.policy?.policyVersion ?? 0);
                    const j = await tx.doc(MembershipJournal, this.o.controlSpaceId, null);
                    op.phase = 'committed';
                    op.policy = policy;
                    j.operations[id] = copy(op);
                }, this.o.ctx);
            }
            const {current, latest} = await this.currentPolicy(op),
                  pushId = policyPushId(id, latest.policyVersion);
            await this.call(id, op, 'activate', op.policy);
            for (const existing of Object.values(current.members))
                if (existing.id !== member.id && [ 'active', 'draining' ].includes(existing.state))
                    await this.call(pushId, {...op, member : existing}, 'policy', latest);
            if (latest.policyVersion > op.policy!.policyVersion)
                await this.call(pushId, op, 'policy', latest);
            await this.o.host.commit(async tx => {
                await this.o.assertAuthority();
                const d = await tx.doc(FederationRouting, this.o.controlSpaceId, null);
                d.members[member.id]!.state = 'active';
                op.phase = 'completed';
                (await tx.doc(MembershipJournal, this.o.controlSpaceId, null)).operations[id] =
                    copy(op);
            }, this.o.ctx);
        } else if (kind === 'drain') {
            await this.call(id, op, 'drain');
            await this.o.host.commit(async tx => {
                await this.o.assertAuthority();
                const d = await tx.doc(FederationRouting, this.o.controlSpaceId, null);
                if (!d.members[member.id])
                    throw new RoutingConflict('unregistered Member');
                d.members[member.id]!.state = 'draining';
                op.phase = 'completed';
                (await tx.doc(MembershipJournal, this.o.controlSpaceId, null)).operations[id] =
                    copy(op);
            }, this.o.ctx);
        } else {
            if (op.phase === 'accepted') {
                if (!state.members[member.id] || state.members[member.id]!.state !== 'draining')
                    throw new RoutingConflict('remove requires draining Member');
                if (state.policy?.rules.some(r => r.mode === 'expand' &&
                                                  (r.by === 'type' || typeof r.by === 'object') &&
                                                  r.members.includes(member.id)))
                    throw new MigrationRequired('HRW/fixed-type sets cannot shrink');
                if (await this.o.hasReferences(member.id))
                    throw new RoutingConflict('Root still references Member');
                op.proof = await this.call(id, op, 'freeze');
                if (!op.proof.empty || op.proof.state !== 'removing')
                    throw new RoutingConflict('no valid EmptyProof');
                op.phase = 'prepared';
                await save();
            }
            if (op.phase === 'prepared') {
                if (await this.o.hasReferences(member.id))
                    throw new RoutingConflict('Root references appeared before removal commit');
                const p = copy(state.policy!);
                p.policyVersion++;
                p.rules = p.rules.flatMap<FederationRule>(r => {
                    if ('member' in r)
                        return r.member === member.id ? [] : [ r ];
                    const remaining = r.members.filter(m => m !== member.id);
                    return remaining.length ? [ {...r, members : remaining} ] : [];
                });
                if (p.default.member === member.id) {
                    if (!newDefault || !state.members[newDefault] ||
                        state.members[newDefault]!.state !== 'active')
                        throw new RoutingConflict('removal needs registered active default');
                    p.default.member = newDefault;
                }
                await this.o.host.commit(async tx => {
                    await this.o.assertAuthority();
                    const d = await tx.doc(FederationRouting, this.o.controlSpaceId, null);
                    if (await this.o.hasReferencesIn(tx, member.id, member.target.spaceId))
                        throw new RoutingConflict("Root still references Member at removal commit");
                    await applyFederationPolicyIn(tx, this.o.controlSpaceId, this.o.authorityId, p,
                                                  state!.policy!.policyVersion,
                                                  new Set([ member.id ]));
                    d.members[member.id]!.state = 'detached';
                    op.phase = 'committed';
                    op.policy = p;
                    (await tx.doc(MembershipJournal, this.o.controlSpaceId, null)).operations[id] =
                        copy(op);
                }, this.o.ctx);
            }
            const {current, latest} = await this.currentPolicy(op),
                  pushId = policyPushId(id, latest.policyVersion);
            for (const existing of Object.values(current.members))
                if (existing.id !== member.id && [ 'active', 'draining' ].includes(existing.state))
                    await this.call(pushId, {...op, member : existing}, 'policy', latest);
            await this.call(id, op, 'detach');
            op.phase = 'completed';
            await save();
        }
        return copy(op);
    }
}

function assertOrdinaryProfiles(old:FederationPolicy,next:FederationPolicy){
 for(const p of old.completionProfiles)if(hash(p)!==hash(next.completionProfiles.find(n=>n.taskType===p.taskType)??null))throw new MigrationRequired('existing profile requires controlled transition');
 for(const p of next.completionProfiles)if(!old.completionProfiles.some(n=>n.taskType===p.taskType)&&old.rules.some(r=>r.type===p.taskType))throw new MigrationRequired('existing Task requires controlled transition');
}
