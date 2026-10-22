import {RootErasures} from './root-erasure-doc.ts';
import {ResultExpired} from './claims.ts';
import type {Context} from './context.ts';
import {defineDocFamily} from '@earendil-works/pi-durable';
// Composite operations bind their complete routing plan before sending any effect.

import {canonicalJson,digestJson} from './canonical.ts';
import type {Principal} from './claims.ts';
import type {SpaceHost, Taken} from './client.ts';
import type {EntryDraft, Json, SpaceEvent, Template} from './core.ts';
import {ReplicaConfigPending} from './core.ts';
import {FederationRouting} from "./federation-policy.ts";
import {FederationJournalLayout, operationPartition, parentJournalKey, validateJournalPartitions} from './federation-journals.ts';
import {TransportFailure} from './remote.ts';
import {MergeTypeNotExclusive} from './service.ts';
import {ProfileTransitions} from './profile-transition-doc.ts';
import {MembershipJournal} from "./membership.ts";
import {RouterController, type RouterOperation, type RouterStepSpec} from './router.ts';
import {
    normalizeFederatedEntry,
    RoutingConflict,
    type RoutingState,
    searchMembers,
    writeMember,
    isMergeType
} from './routing-semantics.ts';

export class FederationUnavailable extends Error {}
export class FederationPending extends Error {
    requestId: string;
    constructor(id: string) {
        super('bound child outcome is unresolved');
        this.requestId = id;
    }
}
export interface FederationIO {
    step(member: string, principal: Principal, method: RouterOperation, args: Json,
         policyVersion?: number,
         origin?: Readonly<import("./router.ts").RouterStep>): Promise<RouterStepSpec>;
    snapshot(member: string, principal: Principal, template: Template,
             txn?: string): Promise<{entries : Taken[]; revision : number}>;
    events(member: string, principal: Principal, registration: Readonly<RouterStepSpec>): Promise<
        {epoch : string; events : Array<{seq : number; event : SpaceEvent}>; gap?: boolean}>;
    ack(member: string, principal: Principal, epoch: string, seq: number): Promise<void>;
    txnActive(member: string, principal: Principal, txn: string,
              registration?: Readonly<RouterStepSpec>): Promise<boolean>;
}
export type FederationOperation = {
    id: string; hash : string; principal : Principal; policyVersion : number; members : string[];
    kind : 'write' | 'read' | 'take' | 'race' | 'txn';
    args : Json;
    targets?: import("./router.ts").TargetBinding[];
    phase : 'admitting' | 'ready' | 'done' | 'needsReview';
    children : Record<string, string>;
    registrations : Record<string, string>;
    cursor : number;
    deadline?: number;
    winner?: {member : string; txn : string; entry : Taken};
    candidates : Record<string,
                        {
                            member: string;
                            txn?: string;
                            entry?: Taken;
                            event: SpaceEvent
                        }>;
    result?: Json;
    erased?:{commandId:string;originalHash:string;subjectHash:string};
    userTxn?: {member : string; id : string; originId?:string};
    budgetWithParent?:true
};
type Operation = FederationOperation;
export const FederationOperations =
    defineDocFamily<{operations : Record<string, Operation>; reservedBytes : number}, null>({
        kind : 'phi-spaces.federation-operations',
        version : 1,
        scope : 'session',
        family : true,
        initial : () => ({operations : {}, reservedBytes : 0})
    });
const copy = <T>(v: T): T => structuredClone(v);
const hash = (v: unknown) => digestJson(v as Json);
const child = (id: string, label: string) => 'f-' + hash([ id, label ]);
export type FederationRequest = {
    id: string; principal : Principal;
    txn?: {member : string; id : string; originId?: string}
};
/** Server-side API. The authority guard must fence owners of both journals. */
export class FederatedSpace {
    private o: {
        host: SpaceHost; ctx : Context; id : string; router : RouterController;
        state : () => Promise<RoutingState>;
        io : FederationIO;
        assertAuthority : () => Promise<void>;
        now?: () => number;
        journalPartitions?: number;
        partitionRouters?: readonly RouterController[];
        controlSpaceId?: string
    };
    private tail: Promise < unknown >= Promise.resolve();
    private partitions: number;
    private routers: readonly RouterController[];
    constructor(o: FederatedSpace['o']) {
        this.o = o; this.partitions = o.journalPartitions ?? 1;
        validateJournalPartitions(this.partitions);
        this.routers = [...(o.partitionRouters ?? [o.router])];
        if(this.routers.length !== this.partitions || new Set(this.routers.map(r=>r.journalId)).size !== this.partitions || this.partitions>1 && this.routers.some(r=>r.journalId===o.router.journalId))
            throw new TypeError('distinct fixed partition routers required');
    }
    private router(id:string):RouterController {return this.routers[operationPartition(id,this.partitions)]!;}
    private async layoutIn(tx:import('@earendil-works/pi-durable').Tx) {
        const layout=await tx.doc(FederationJournalLayout,this.o.id,null),ids=this.routers.map(r=>r.journalId);
        if(layout.partitions===null) {
            // An existing legacy journal cannot silently become invisible in another topology.
            const legacy=await tx.doc(FederationOperations,this.o.id,null);
            if(this.partitions>1 && Object.keys(legacy.operations).length)
                throw new RoutingConflict('legacy history requires explicit journal migration');
            layout.partitions=this.partitions; layout.routerIds=ids;
        } else if(layout.partitions!==this.partitions || hash(layout.routerIds)!==hash(ids))
            throw new RoutingConflict('persisted journal topology differs; explicit migration required');
    }
    async initializeJournals():Promise<void> {
        await this.o.assertAuthority();
        await this.o.host.commit(async tx=>{await this.layoutIn(tx);await this.o.assertAuthority();},this.o.ctx);
    }
    private async ensureLayout(allowReconciliation=false) {
        const layout=await this.o.host.snapshot(FederationJournalLayout,this.o.id,this.o.ctx);
        if(!layout || layout.partitions===null) return this.initializeJournals();
        if(layout.reconciliation && !allowReconciliation) throw new FederationUnavailable('journal restore reconciliation is incomplete');
        if(layout.partitions!==this.partitions || hash(layout.routerIds)!==hash(this.routers.map(r=>r.journalId)))
            throw new RoutingConflict('persisted journal topology differs; explicit migration required');
    }
    private serial<T>(fn: () => Promise<T>): Promise<T> {
        const r = this.tail.then(fn);
        this.tail = r.catch(() => {});
        return r;
    }
    private async change<T>(id: string | number, f: (d: {operations: Record<string, Operation>; reservedBytes : number},
                                tx: import("@earendil-works/pi-durable").Tx) => T | Promise<T>, allowReconciliation=false):
        Promise<T> {
        await this.o.assertAuthority();
        return this.o.host.commit(async tx => {
            await this.o.assertAuthority();
            await this.layoutIn(tx);
            if((await tx.doc(FederationJournalLayout,this.o.id,null)).reconciliation && !allowReconciliation) throw new FederationUnavailable('journal restore reconciliation is incomplete');
            const partition=typeof id==='number'?id:operationPartition(id,this.partitions);
            const d = await tx.doc(FederationOperations, parentJournalKey(this.o.id,this.partitions,partition), null);
            this.verifyParentJournal(d,partition);
            const r = await f(d, tx);
            this.verifyParentJournal(d,partition);
            if (Buffer.byteLength(JSON.stringify(d)) > d.reservedBytes + 4096)
                throw new RoutingConflict('composite journal exceeded reserved bytes');
            await this.o.assertAuthority();
            return r;
        }, this.o.ctx);
    }
    private verifyParentJournal(d:{operations:Record<string,Operation>;reservedBytes:number},partition:number) {
        const entries=Object.entries(d.operations);
        if(entries.length>16 || d.reservedBytes!==entries.length*128*1024 || entries.some(([id,op])=>op.id!==id || operationPartition(id,this.partitions)!==partition || Buffer.byteLength(JSON.stringify(op))>128*1024))
            throw new RoutingConflict('incomplete or corrupt parent journal reconstruction');
    }
    /** Reconcile parents too, including completed and not-yet-sent children. No replay. */
    async reconcileDataRestore(o: {hostId:string;spaceId:string;oldIncarnation:string;recoveryId:string}): Promise<string[]> {
        return this.serial(async () => {
            for(const [key,value] of Object.entries(o))if(!['hostId','spaceId','oldIncarnation','recoveryId'].includes(key)||typeof value!=='string'||!value||value.length>256)
                throw new RoutingConflict('invalid restore journal binding');
            if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(o.recoveryId)||['constructor','prototype','__proto__'].includes(o.recoveryId))throw new RoutingConflict('invalid recovery ID');
            await this.ensureLayout(true);
            await this.o.host.commit(async tx=>{
                await this.o.assertAuthority();await this.layoutIn(tx);
                const layout=await tx.doc(FederationJournalLayout,this.o.id,null);
                if(layout.reconciliation && hash(layout.reconciliation)!==hash(o))
                    throw new RoutingConflict('another journal restore reconciliation is incomplete');
                layout.reconciliation=copy(o);await this.o.assertAuthority();
            },this.o.ctx);
            const children = new Set<string>();
            for(const router of new Set([this.o.router,...this.routers]))
                for(const id of await router.reconcileDataRestore(o)) children.add(id);
            const st = await this.o.state();
            const affectedMembers = new Set(Object.values(st.members).filter(m =>
                m.target.hostId === o.hostId && m.target.spaceId === o.spaceId &&
                m.target.dataIncarnation === o.oldIncarnation).map(m => m.id));
            const affected:string[] = [];
            // One bounded parent document per commit; partial reconciliation is retryable.
            for(let partition=0;partition<this.partitions;partition++)
                affected.push(...await this.change(partition,d => {
                    const ids:string[]=[];
                    for (const op of Object.values(d.operations)) {
                        if (!op.targets?.some(t => t.hostId === o.hostId && t.spaceId === o.spaceId && t.dataIncarnation === o.oldIncarnation) && !op.members.some(m => affectedMembers.has(m)) &&
                            !Object.values(op.children).some(c => children.has(c))) continue;
                        op.phase = 'needsReview'; ids.push(op.id);
                    }
                    return ids;
                },true));
            await this.o.host.commit(async tx=>{
                await this.o.assertAuthority();await this.layoutIn(tx);
                const layout=await tx.doc(FederationJournalLayout,this.o.id,null);
                if(hash(layout.reconciliation)!==hash(o))throw new RoutingConflict('restore reconciliation changed');
                delete layout.reconciliation;await this.o.assertAuthority();
            },this.o.ctx);
            return affected;
        });
    }
    private async get(id: string) {
        await this.o.assertAuthority();
        await this.ensureLayout();
        const partition=operationPartition(id,this.partitions),d=await this.o.host.snapshot(FederationOperations,parentJournalKey(this.o.id,this.partitions,partition),this.o.ctx);
        if(d)this.verifyParentJournal(d,partition);
        return copy(d?.operations[id]);
    }
    private async assertNoErasure(){const d=await this.o.host.snapshot(RootErasures,this.o.id,this.o.ctx);if(Object.values(d?.operations??{}).some(op=>op.phase!=='completed'))throw new FederationUnavailable('Root principal erasure is pending');}
    private async prepare(kind: Operation['kind'], args: Json,
                          q: FederationRequest): Promise<Operation> {
        await this.assertNoErasure();
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(q.id) ||
            [ 'constructor', 'prototype', '__proto__' ].includes(q.id))
            throw new RoutingConflict('invalid operation ID');
        const h = hash([ kind, args, q.principal, q.txn ?? null ]);
        let op = await this.get(q.id);
        if (op) {
            if (op.hash !== h)
                throw new RoutingConflict('operation ID changed arguments');
            return op;
        }
        const st = await this.o.state(), p = st.policy;
        if (!p)
            throw new RoutingConflict('no installed policy');
        // v3 7.2: merge types (lww/set) know no exclusive allocation; refused before any Member is called.
        const mergeType = (kind === 'write' ? (args as any).entry?.type : (args as any).template?.type) as string | undefined;
        if (isMergeType(p, mergeType) && (kind === 'take' || kind === 'race' || q.txn))
            throw new MergeTypeNotExclusive(`${q.txn ? 'a transaction' : kind} is not available for merge types (lww/set)`);
        let ids =
            kind === 'txn' ? [ (args as any).member ]
            : kind === 'write'
                ? [ writeMember(p, st.members, (args as any).entry, (this.o.now ?? Date.now)()) ]
                : searchMembers(p, (args as any).template);
        if (q.txn) {
            const origin = q.txn.originId ? await this.get(q.txn.originId) : undefined;
            if (!origin || origin.kind !== "txn" || origin.phase !== "done" ||
                origin.members[0] !== q.txn.member || (origin.result as any)?.id !== q.txn.id ||
                hash(origin.principal) !== hash(q.principal))
                throw new RoutingConflict("transaction has no original principal/Member binding");
            if (ids.some(id => id !== q.txn!.member))
                throw new RoutingConflict('transaction is bound to another Member');
            ids = [ q.txn.member ];
        }
        if (!ids.length || ids.length > 8)
            throw new RoutingConflict('composite target set exceeds bounded fanout');
        op = {
            id : q.id,
            hash : h,
            principal : copy(q.principal),
            policyVersion : p.policyVersion,
            members : ids,
            targets: ids.map(id => copy(st.members[id]!.target)),
            kind,
            args : copy(args),
            phase : 'admitting',
            ...((args as any).timeoutMs > 0
                    ? {deadline : (this.o.now ?? Date.now)() + (args as any).timeoutMs}
                    : {}),
            children : {},
            registrations : {},
            cursor : 0,
            candidates : {},
            ...(q.txn ? {userTxn : copy(q.txn)} : {}),
            ...(ids.length===1&&kind!=='race'?{budgetWithParent:true as const}:{})
        };
        await this.change(q.id, async (d, tx) => {
            if (this.o.controlSpaceId) {
                const profiles=await tx.doc(ProfileTransitions,this.o.controlSpaceId,null);if(Object.values(profiles.operations).some(op=>op.phase!=='completed'&&op.members.some(m=>ids.includes(m.id))))throw new RoutingConflict('profile transition blocks new Root admission');
                const current = await tx.doc(FederationRouting, this.o.controlSpaceId, null),
                      jobs = await tx.doc(MembershipJournal, this.o.controlSpaceId, null);
                if (current.policy?.policyVersion !== op!.policyVersion ||
                    ids.some(id => !current.members[id] ||
                                   !["active", "draining"].includes(current.members[id]!.state)) ||
                    Object.values(jobs.operations)
                        .some(job => !["completed", "failed"].includes(job.phase) &&
                                     ids.includes(job.member.id)))
                    throw new RoutingConflict("routing/membership changed before admission");
            }
            if (Object.keys(d.operations).length >= 16)
                throw new RoutingConflict('composite operation history full');
            if (d.operations[q.id])
                throw new RoutingConflict('concurrent admission');
            if(op!.budgetWithParent)await this.router(op!.id).reserveFutureIn(tx,child(op!.id,'budget'),1,64*1024);
            d.operations[q.id] = op!;
            d.reservedBytes += 128 * 1024;
        });
        return op;
    }
    private async transactionOriginStep(originId:string,member:string){
        const origin=await this.get(originId);if(!origin||origin.kind!=='txn'||origin.phase!=='done'||origin.members[0]!==member)throw new RoutingConflict('transaction origin changed');
        const command=await this.router(originId).get(origin.children[member]!);if(!command||command.state!=='completed'||!command.steps[0])throw new RoutingConflict('transaction origin claim unavailable');return command.steps[0];
    }
    private async save(op: Operation) {
        if (Buffer.byteLength(JSON.stringify(op)) > 128 * 1024)
            throw new RoutingConflict('operation result/event budget exceeded');
        await this.change(op.id,d => {if(d.operations[op.id]?.hash!==op.hash)throw new RoutingConflict('missing or conflicting parent history');d.operations[op.id] = copy(op);});
    }
    private async storeParentIn(tx:import('@earendil-works/pi-durable').Tx,op:Operation){
        if(Buffer.byteLength(JSON.stringify(op))>128*1024)throw new RoutingConflict('operation result/event budget exceeded');
        await this.layoutIn(tx);const layout=await tx.doc(FederationJournalLayout,this.o.id,null);if(layout.reconciliation)throw new RoutingConflict('restore reconciliation blocks Parent completion');
        const partition=operationPartition(op.id,this.partitions),d=await tx.doc(FederationOperations,parentJournalKey(this.o.id,this.partitions,partition),null);if(d.operations[op.id]?.hash!==op.hash)throw new RoutingConflict('missing or conflicting parent history');d.operations[op.id]=copy(op);
    }
    private async admit(op: Operation) {
        if (op.phase !== 'admitting')
            return op;
        if(!op.budgetWithParent)await this.router(op.id).reserveFuture(
            child(op.id, 'budget'), op.members.length * (op.kind === 'race' ? 4 : 1), 64 * 1024);
        for (const member of op.members) {
            const label = 'initial:' + member, id = child(op.id, label);
            let method: RouterOperation = op.kind === 'race' ? 'wait' : op.kind;
            const a: any = copy(op.args);
            if (op.deadline !== undefined)
                a.deadline = op.deadline;
            if (op.kind === 'race') {
                a.take = (op.args as any).take !== false;
                a.handback = {federationOperation : op.id};
            }
            if (op.userTxn)
                a.txn = op.userTxn.id;
            const prior = await this.router(op.id).get(id);
            if (prior) {
                op.children[member] = id;
                await this.save(op);
                continue;
            }
            let spec: RouterStepSpec;
            try {
                spec = await this.o.io.step(member, op.principal, method, a, op.policyVersion,
                                                  (op.kind === "txn" && a.originId || op.userTxn?.originId)
                                                      ? await this.transactionOriginStep(op.kind==='txn'?a.originId:op.userTxn!.originId!,member)
                                                      : undefined);
            } catch (e) {
                // No effect has been dispatched; keep the persisted routing plan and reservation.
                // The same while the Member waits for the router to adopt its replica configuration (v3 5.3.1 step 5).
                if (e instanceof TransportFailure || e instanceof ReplicaConfigPending) throw new FederationPending(op.id);
                throw e;
            }
            const expected = (await this.o.state()).members[member]?.target;
            if (!expected || hash(spec.target) !== hash(expected) ||
                hash(spec.principal) !== hash(op.principal)||spec.method!==method||hash(spec.args)!==hash(a)||spec.policyVersion!==undefined&&spec.policyVersion!==op.policyVersion)
                throw new RoutingConflict('target/principal adapter binding mismatch');
            let attached=false;
            await this.router(op.id).submit({id, area : 'federation', steps : [ spec ]},child(op.id, 'budget'),
                op.members.length===1&&op.kind!=='race'?async(command,tx,context)=>{
                    const next={...copy(op),children:{...op.children,[member]:id},phase:'ready' as const};
                    if(Buffer.byteLength(JSON.stringify(next))>context.roomBytes)return;
                    if(command.id!==id||command.steps.length!==1)throw new RoutingConflict('Child admission changed binding');
                    await this.storeParentIn(tx,next);Object.assign(op,next);attached=true;
                }:undefined);
            if(!attached){op.children[member] = id;await this.save(op);}
        }
        if((op as Operation).phase!=='ready'){op.phase = 'ready';await this.save(op);}
        return op;
    }
    private async finish(op: Operation, result: Json) {
        op.phase = 'done';
        op.result = result;
        await this.save(op);
        await this.router(op.id).releaseFuture(child(op.id, 'budget'));
        return copy(result);
    }
    private async decide(op: Operation) {
        if(op.erased)throw new ResultExpired('Root operation content was erased');
        if (op.phase === 'done') {
            // A crash after the Parent commit can precede releasing unused child reservations.
            await this.router(op.id).releaseFuture(child(op.id, 'budget'));
            return copy(op.result!);
        }
        if (op.phase === 'needsReview')
            throw new FederationUnavailable('operation needs explicit review');
        op = await this.admit(op);
        for (; op.cursor < op.members.length; op.cursor++) {
            const m=op.members[op.cursor]!;let finalized=false;
            const c=await this.router(op.id).advance(op.children[m]!,op.members.length===1?async(command,tx,context)=>{
                if(command.id!==op.children[m]||command.steps.length!==1||command.steps[0]!.state!=='done')throw new RoutingConflict('Child completion changed binding');
                const next={...copy(op),phase:'done' as const,result:copy(command.steps[0]!.result??null)};
                if(Buffer.byteLength(JSON.stringify(next))>context.roomBytes)return;
                await this.storeParentIn(tx,next);context.releaseFuture(child(op.id,'budget'));Object.assign(op,next);finalized=true;
            }:undefined);
            if(finalized)return copy(op.result!);
            if (c.state === 'needsReview' || c.state === 'failed') {
                op.phase = 'needsReview';
                await this.save(op);
                throw new FederationUnavailable('definitive child failure or review requires explicit review');
            }
            if (c.state !== 'completed') {
                if (op.kind === 'read')
                    continue;
                throw new FederationPending(op.id);
            }
            const r: any = c.steps[0]!.result;
            if (op.kind === 'write' || op.kind === 'txn')
                return this.finish(op, r);
            if (r !== null && r !== undefined)
                return this.finish(op, r);
            await this.save({...op, cursor : op.cursor + 1});
        }
        if (op.kind === "read" &&
            (await Promise.all(op.members.map(m => this.router(op.id).get(op.children[m]!))))
                .some(c => c?.state !== "completed")) {
            op.cursor = 0;
            await this.save(op);
            throw new FederationUnavailable("some required read outcomes unavailable");
        }
        return this.finish(op, null);
    }
    async write(entry: EntryDraft, q: FederationRequest, leaseMs?: number) {
        return this.serial(async () => {
            const old = await this.get(q.id);if(old?.erased)throw new ResultExpired('Root operation content was erased');
            let e = entry;
            if (!old) {
                const p = (await this.o.state()).policy;
                if (!p)
                    throw new RoutingConflict('no policy');
                e = normalizeFederatedEntry(p, entry);
            } else {
                const previous = (old.args as any).entry;
                if (entry.types?.some(t => t !== entry.type && !previous.types.includes(t)))
                    throw new RoutingConflict("undeclared retry supertype");
                e = {...copy(entry), types : previous.types};
            }
            return this.decide(await this.prepare(
                'write', {entry : e, ...(leaseMs === undefined ? {} : {leaseMs})}, q));
        });
    }
    async createTransaction(member: string, leaseMs: number, q: FederationRequest) {
        return this.serial(async () => {
            if (q.txn || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 60000)
                throw new RoutingConflict('transaction requires finite bounded lease');
            const result: any = await this.decide(
                await this.prepare('txn', {member, action : 'begin', leaseMs}, q));
            return {...result, member, originId : q.id};
        });
    }
    async finishTransaction(originId: string, action: 'commit'|'abort', q: FederationRequest) {
        return this.serial(async () => {
            const origin = await this.get(originId);
            if (!origin || origin.kind !== 'txn' || origin.phase !== 'done' ||
                hash(origin.principal) !== hash(q.principal))
                throw new RoutingConflict('transaction is not bound to this principal');
            const lease = origin.result as any;
            if (!lease?.id)
                throw new RoutingConflict('transaction result unavailable');
            return this.decide(await this.prepare(
                'txn', {member : origin.members[0]!, action, id : lease.id, originId}, q));
        });
    }

    async read(template: Template, q: FederationRequest) {
        return this.serial(
            async () => this.decide(await this.prepare('read', {template, timeoutMs : 0}, q)));
    }
    async take(template: Template, q: FederationRequest) {
        return this.serial(
            async () => this.decide(await this.prepare('take', {template, timeoutMs : 0}, q)));
    }
    async readAll(template: Template, principal: Principal, o: {
        allowPartial?: boolean;
        waitForCompleteMs?: number;
        txn?: {member : string; id : string}
    } = {}) {
        await this.o.assertAuthority();await this.assertNoErasure();await this.ensureLayout();
        const st = await this.o.state();
        if (!st.policy)
            throw new RoutingConflict('no policy');
        const ids = searchMembers(st.policy, template);
        if (o.txn && ids.some(id => id !== o.txn!.member))
            throw new RoutingConflict('transaction crosses Members');
        if (o.allowPartial && o.waitForCompleteMs !== undefined)
            throw new RoutingConflict('choose partial or wait-for-complete');
        const duration = o.waitForCompleteMs ?? 0;
        if (!Number.isSafeInteger(duration) || duration < 0 || duration > 60000)
            throw new RoutingConflict('invalid complete-wait bound');
        const end = Date.now() + duration;
        for (;;) {
            await this.o.assertAuthority();
            const entries: Taken[] = [], revisions: Record < string, number >= {},
                           missing: string[] = [];
            for (const id of ids) {
                try {
                    const s = await this.o.io.snapshot(id, principal, template, o.txn?.id);
                    entries.push(...s.entries);
                    revisions[id] = s.revision;
                } catch {
                    missing.push(id);
                }
            }
            if (!missing.length || o.allowPartial)
                return {
                    entries,
                    complete : !missing.length,
                    missingMembers : missing,
                    revisions,
                    consistentSnapshot : false as const
                };
            if (Date.now() >= end)
                throw new FederationUnavailable('required Member snapshots unavailable: ' +
                                                missing.join(','));
            await new Promise(r => setTimeout(r, Math.min(50, end - Date.now())));
        }
    }
    async count(template: Template, principal: Principal,
                o: Parameters<FederatedSpace['readAll']>[ 2 ] = {}) {
        const r = await this.readAll(template, principal, o);
        const {entries,...rest}=r;return{...rest,count:entries.length};
    }
    async takeWaiting(template: Template, timeoutMs: number, txnLeaseMs: number,
                      q: FederationRequest) {
        return this.serial(async () => {
            if (q.txn)
                return this.decide(await this.prepare('take', {template, timeoutMs}, q));
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000 ||
                !Number.isSafeInteger(txnLeaseMs) || txnLeaseMs < 1 || txnLeaseMs > 60000)
                throw new RoutingConflict('race requires finite bounded leases');
            const op = await this.prepare('race', {template, timeoutMs, txnLeaseMs}, q);
            return this.progressRace(op);
        });
    }
    async readWaiting(template:Template,timeoutMs:number,q:FederationRequest){return this.serial(async()=>{if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)throw new RoutingConflict('read waiting requires bounded timeout');if(q.txn)return this.decide(await this.prepare('read',{template,timeoutMs},q));return this.progressRace(await this.prepare('race',{template,timeoutMs,txnLeaseMs:1,take:false},q));});}
    private async effect(op: Operation, m: string, label: string, method: RouterOperation,
                         args: Json) {
        const id = child(op.id, label);
        let c = await this.router(op.id).get(id);
        if (!c) {
            const step = await this.o.io.step(m, op.principal, method, args, op.policyVersion,
                                              (await this.router(op.id).get(op.children[m]!))!.steps[0]);
            await this.router(op.id).submit({id, area : 'federation', steps : [ step ]},
                                       child(op.id, 'budget'));
        }
        c = await this.router(op.id).advance(id);
        if (c.state === 'failed' &&
            (label.startsWith('cancel:') &&
                 [ 'UnknownLeaseError', 'TransactionError' ].includes(c.steps[0]!.evidence!) ||
             label.startsWith('abort:') && c.steps[0]!.evidence === 'TransactionError'))
            return null;
        if (c.state === 'failed' || c.state === 'needsReview') {
            op.phase = 'needsReview';
            await this.save(op);
            throw new FederationUnavailable('definitive child failure needs review');
        }
        if (c.state !== 'completed')
            throw new FederationPending(op.id);
        return c.steps[0]!.result;
    }
    private async collectRaceEvents(op: Operation) {
        for (const m of op.members) {
            const c = (await this.router(op.id).get(op.children[m]!))!,
                  page = await this.o.io.events(m, op.principal, c.steps[0]!);
            if (page.gap) {
                op.phase = 'needsReview';
                await this.save(op);
                throw new FederationUnavailable('race mailbox gap needs review');
            }
            for (const item of page.events) {
                const e = item.event, key = hash([ m, page.epoch, item.seq ]);
                if (!op.candidates[key]) {
                    const candidate = {
                        member : m,
                        event : copy(e),
                        ...(e.txn ? {txn : e.txn} : {}),
                        ...(e.entry ? {entry : e.entry} : {})
                    };
                    const ownerId = (e.handback as any)?.federationOperation;
                    if (typeof ownerId === 'string' && ownerId !== op.id) {
                        await this.change(ownerId,d => {
                            const owner = d.operations[ownerId];
                            if (!owner || hash(owner.principal) !== hash(op.principal) ||
                                !owner.members.includes(m))
                                throw new RoutingConflict(
                                    'mailbox event has no bound operation owner');
                            owner.candidates[key] = copy(candidate);
                            if (Buffer.byteLength(JSON.stringify(owner)) > 128 * 1024)
                                throw new RoutingConflict('mailbox owner budget exceeded');
                        });
                    } else if (e.eventId === op.registrations[m]) {
                        op.candidates[key] = candidate;
                        await this.save(op);
                    } else
                        throw new FederationUnavailable(
                            'unrelated mailbox event requires its owning dispatcher');
                }
                await this.o.io.ack(m, op.principal, page.epoch, item.seq);
            }
        }
    }
    private async progressRace(op: Operation): Promise<Json> {
        if(op.erased)throw new ResultExpired('Root operation content was erased');
        if (op.phase === 'done') {
            // A crash after the Parent commit can precede releasing unused child reservations.
            await this.router(op.id).releaseFuture(child(op.id, 'budget'));
            return copy(op.result!);
        }
        if (op.phase === 'needsReview')
            throw new FederationUnavailable('operation needs explicit review');
        op = await this.admit(op);
        for (const m of op.members) {
            const c = await this.router(op.id).advance(op.children[m]!);
            if (c.state === 'failed' || c.state === 'needsReview') {
                op.phase = 'needsReview';
                await this.save(op);
                throw new FederationUnavailable('definitive child failure or review requires explicit review');
            }
            if (c.state !== 'completed') {
                if (op.kind === 'read')
                    continue;
                throw new FederationPending(op.id);
            }
            const r: any = c.steps[0]!.result;
            op.registrations[m] = typeof r === 'string' ? r : r.id;
            await this.save(op);
        }
        await this.collectRaceEvents(op);
        if (!op.winner) {
            for (const candidate of Object.values(op.candidates)) {
                if (candidate.event.eventId === op.registrations[candidate.member] &&
                    candidate.entry && ((op.args as any).take === false || candidate.txn &&
                    await this.o.io.txnActive(
                        candidate.member, op.principal, candidate.txn,
                        (await this.router(op.id).get(op.children[candidate.member]!))!.steps[0]))) {
                    op.winner = {
                        member : candidate.member,
                        txn : candidate.txn ?? "",
                        entry : candidate.entry
                    };
                    await this.save(op);
                    break;
                }
            }
        }
        if (op.winner?.txn) {
            const w = op.winner;
            await this.effect(op, w.member, 'winner-commit', 'txn',
                              {action : 'commit', id : w.txn});
        }
        const timedOut = op.members.every(
            m => Object.values(op.candidates)
                     .some(c => c.member === m && c.event.eventId === op.registrations[m] &&
                                c.event.kind === 'timeout'));
        if (!op.winner && !timedOut)
            throw new FederationPending(op.id);
        for (const m of op.members) {
            const id = op.registrations[m];
            await this.effect(op, m, 'cancel:' + m, 'lease', {action : 'cancel', id});
        }
        await this.collectRaceEvents(op);
        for (const m of op.members) {
            for (const c of Object.values(op.candidates))
                if (c.member === m && c.event.eventId === op.registrations[m] && c.txn &&
                    c.txn !== op.winner?.txn)
                    await this.effect(op, m, 'abort:' + m, 'txn', {action : 'abort', id : c.txn});
        }
        if (op.winner)
            return this.finish(op, op.winner.entry as unknown as Json);
        if (timedOut)
            return this.finish(op, null);
        throw new FederationPending(op.id);
    }
    async resume(id: string) {
        return this.serial(async () => {
            await this.assertNoErasure();const op = await this.get(id);
            if (!op)
                throw new RoutingConflict('unknown federation operation');
            return op.kind === 'race' ? this.progressRace(op) : this.decide(op);
        });
    }
}
